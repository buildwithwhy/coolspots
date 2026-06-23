#!/usr/bin/env node
/**
 * build-venues.mjs — one-time (re-runnable) data pipeline.
 *
 * Pulls pubs / bars / cafés / restaurants from OpenStreetMap via Overpass,
 * transforms the raw tags into the trimmed `venues.json` schema described in
 * the build spec, seeds AC status from OSM's `air_conditioning` tag, layers a
 * small hand-curated AC list on top, and writes data/venues.json.
 *
 * Usage:
 *   node scripts/build-venues.mjs                # central London (default bbox)
 *   node scripts/build-venues.mjs --greater      # full Greater London bbox
 *   node scripts/build-venues.mjs --bbox=s,w,n,e # custom bounding box
 *
 * No API key. Overpass is free; this runs at build time only, never per user.
 */

import { writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// --- bounding boxes: south, west, north, east ---------------------------------
const BBOX = {
  // Greater London (from the spec)
  greater: [51.28, -0.52, 51.70, 0.33],
  // Tighter central / inner London — keeps the launch set focused & the JSON lean
  central: [51.46, -0.21, 51.55, 0.0],
};

const AMENITIES = ['pub', 'bar', 'cafe', 'restaurant'];

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

function parseArgs() {
  let bbox = BBOX.greater; // full Greater London is the shipped default
  for (const arg of process.argv.slice(2)) {
    if (arg === '--greater') bbox = BBOX.greater;
    else if (arg === '--central') bbox = BBOX.central;
    else if (arg.startsWith('--bbox=')) {
      const parts = arg.slice('--bbox='.length).split(',').map(Number);
      if (parts.length === 4 && parts.every((n) => !Number.isNaN(n))) bbox = parts;
      else throw new Error(`bad --bbox value: ${arg}`);
    }
  }
  return bbox;
}

function buildQuery([s, w, n, e]) {
  const lines = AMENITIES.map(
    (a) => `  nwr["amenity"="${a}"](${s},${w},${n},${e});`
  ).join('\n');
  return `[out:json][timeout:180];\n(\n${lines}\n);\nout center tags;`;
}

async function fetchOverpass(query) {
  // Reuse a cached raw response when present (lets you tweak curation without
  // re-hitting the rate-limited public Overpass endpoints). Pass --fresh to refetch.
  const cachePath = join(ROOT, 'data', '_overpass-raw.json');
  if (!process.argv.includes('--fresh')) {
    try {
      const cached = JSON.parse(await readFile(cachePath, 'utf8'));
      console.log(`→ using cached raw response (${cached.elements?.length ?? 0} elements). Pass --fresh to refetch.`);
      return cached;
    } catch {
      /* no cache yet — fetch below */
    }
  }
  let lastErr;
  for (const url of ENDPOINTS) {
    try {
      process.stdout.write(`→ querying ${new URL(url).host} ... `);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      console.log(`ok (${json.elements?.length ?? 0} elements)`);
      await writeFile(cachePath, JSON.stringify(json));
      return json;
    } catch (err) {
      console.log(`failed (${err.message})`);
      lastErr = err;
    }
  }
  throw new Error(`all Overpass endpoints failed: ${lastErr?.message}`);
}

// --- tag → schema transform ---------------------------------------------------
function normaliseType(amenity) {
  return AMENITIES.includes(amenity) ? amenity : 'restaurant';
}

// great-circle distance in metres
function haversineMeters(aLat, aLon, bLat, bLon) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const UK_POSTCODE = /\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i;

function assembleAddress(tags) {
  const num = tags['addr:housenumber'];
  const street = tags['addr:street'];
  if (num && street) return `${num} ${street}`;
  if (street) return street;
  return tags['addr:place'] || null;
}

function acFromTag(tags) {
  const v = (tags.air_conditioning || '').toLowerCase();
  if (v === 'yes') return { status: 'yes', source: 'osm', confidence: 0.9 };
  if (v === 'no') return { status: 'no', source: 'osm', confidence: 0.9 };
  return { status: 'unknown', source: 'unknown', confidence: 0.0 };
}

function transform(element) {
  const tags = element.tags || {};
  if (!tags.name) return null; // drop nameless entries

  const lat = element.lat ?? element.center?.lat;
  const lon = element.lon ?? element.center?.lon;
  if (lat == null || lon == null) return null;

  const ac = acFromTag(tags);

  return {
    id: `${element.type}/${element.id}`,
    name: tags.name,
    type: normaliseType(tags.amenity),
    lat: Number(lat.toFixed(6)),
    lon: Number(lon.toFixed(6)),
    address: assembleAddress(tags),
    postcode: tags['addr:postcode'] || null,
    website: tags.website || tags['contact:website'] || null,
    opening_hours: tags.opening_hours || null,
    cuisine: tags.cuisine || null,
    chain: Boolean(tags.brand || tags['brand:wikidata']),
    ac: {
      status: ac.status,
      source: ac.source,
      confidence: ac.confidence,
      evidence: ac.source === 'osm' ? 'OSM air_conditioning tag' : null,
    },
  };
}

// --- curated overlay ----------------------------------------------------------
// The curated list is the moat. Matched against fetched venues by case-insensitive
// name (optionally narrowed by postcode prefix). Edit data/curated-ac.json to grow it.
async function loadCurated() {
  try {
    const raw = await readFile(join(ROOT, 'data', 'curated-ac.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function applyCuration(venues, curated) {
  if (!curated.length) return 0;
  let applied = 0;
  for (const c of curated) {
    const needle = (c.name || '').toLowerCase().trim();
    if (!needle) continue;
    // "exact" (default) matches the whole name; "contains" catches chain venues
    // whose OSM name carries a location suffix, e.g. "Dishoom Covent Garden".
    const contains = c.match === 'contains';
    for (const v of venues) {
      if (v.ac.source === 'osm') continue; // don't override explicit OSM tags
      const name = v.name.toLowerCase().trim();
      const hit = contains ? name.includes(needle) : name === needle;
      if (!hit) continue;
      if (c.postcodePrefix && v.postcode && !v.postcode.startsWith(c.postcodePrefix)) continue;
      v.ac = {
        status: c.status || 'likely',
        source: 'curated',
        confidence: c.confidence ?? 0.9,
        evidence: c.evidence || 'Curated list',
      };
      applied++;
    }
  }
  return applied;
}

// --- external "confirmed AC" overlay (with coordinates) -----------------------
// Field-confirmed AC data from another project (data/ac-places-london.json).
// Each entry is matched to an existing OSM venue by proximity + fuzzy name; if
// no match is found nearby, it's added as a new venue (source: "user").
async function loadAcPlaces() {
  try {
    const raw = await readFile(join(ROOT, 'data', 'ac-places-london.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

const STOPWORDS = new Set(['the', 'at', 'on', 'of', 'and', '&', 'bar', 'cafe', 'café', 'restaurant', 'kitchen', 'tavern']);

function normaliseName(name, nb) {
  let s = name.toLowerCase();
  if (nb) s = s.replace(new RegExp(nb.toLowerCase(), 'g'), ''); // drop the neighbourhood suffix
  return s.replace(/['’.,&]/g, ' ').replace(/\s+/g, ' ').trim();
}

function nameTokens(name, nb) {
  return new Set(
    normaliseName(name, nb)
      .split(' ')
      .filter((t) => t && !STOPWORDS.has(t))
  );
}

function namesMatch(osmName, place) {
  const a = normaliseName(osmName);
  const b = normaliseName(place.name, place.nb);
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const ta = nameTokens(osmName);
  const tb = nameTokens(place.name, place.nb);
  if (!ta.size || !tb.size) return false;
  let shared = 0;
  for (const t of tb) if (ta.has(t)) shared++;
  const jaccard = shared / (ta.size + tb.size - shared);
  return jaccard >= 0.5;
}

function mapAcStatus(ac) {
  if (ac === 'confirmed') return { status: 'yes', confidence: 0.95 };
  if (ac === 'likely') return { status: 'likely', confidence: 0.7 };
  return { status: 'unknown', confidence: 0.3 };
}

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function mergeAcPlaces(venues, places) {
  // de-dup the source list (some rows repeat with slightly different coords)
  const uniq = new Map();
  for (const p of places) {
    const key = `${slug(p.name)}|${p.lat.toFixed(3)}|${p.lng.toFixed(3)}`;
    if (!uniq.has(key)) uniq.set(key, p);
  }

  let tagged = 0;
  let added = 0;
  const newVenues = [];

  for (const p of uniq.values()) {
    // nearest existing venue within 200 m that also matches by name
    let best = null;
    let bestDist = Infinity;
    for (const v of venues) {
      const d = haversineMeters(p.lat, p.lng, v.lat, v.lon);
      if (d > 200) continue;
      if (d < bestDist && namesMatch(v.name, p)) {
        best = v;
        bestDist = d;
      }
    }

    const { status, confidence } = mapAcStatus(p.ac);
    const evidence = `Field-confirmed AC (${p.ac}) — ${p.nb}`;

    if (best) {
      best.ac = { status, source: 'user', confidence, evidence };
      tagged++;
    } else {
      const pc = (p.address.match(UK_POSTCODE) || [])[1] || null;
      // the source address embeds the postcode (and "London") — strip them so the
      // UI doesn't render the postcode twice when address + postcode are joined.
      let addr = p.address || null;
      if (addr) {
        addr = addr
          .replace(UK_POSTCODE, '')
          .replace(/\bLondon\b/gi, '')
          .replace(/\s{2,}/g, ' ')
          .replace(/[,\s]+,/g, ',')
          .replace(/^[,\s]+|[,\s]+$/g, '')
          .trim() || null;
      }
      newVenues.push({
        id: `user/${slug(p.name)}-${slug(p.nb)}`,
        name: p.name,
        type: ['pub', 'bar', 'cafe', 'restaurant', 'museum'].includes(p.cat) ? p.cat : 'restaurant',
        lat: Number(p.lat.toFixed(6)),
        lon: Number(p.lng.toFixed(6)),
        address: addr,
        postcode: pc ? pc.toUpperCase().replace(/\s+/g, ' ') : null,
        website: null,
        opening_hours: null,
        cuisine: null,
        chain: false,
        ac: { status, source: 'user', confidence, evidence },
      });
      added++;
    }
  }

  venues.push(...newVenues);
  return { tagged, added };
}

// --- main ---------------------------------------------------------------------
async function main() {
  const bbox = parseArgs();
  console.log(`bounding box (s,w,n,e): ${bbox.join(', ')}`);

  const raw = await fetchOverpass(buildQuery(bbox));
  const elements = raw.elements || [];

  const seen = new Set();
  const venues = [];
  for (const el of elements) {
    const v = transform(el);
    if (!v || seen.has(v.id)) continue;
    seen.add(v.id);
    venues.push(v);
  }

  const curated = await loadCurated();
  const curatedApplied = applyCuration(venues, curated);

  const acPlaces = await loadAcPlaces();
  const merged = mergeAcPlaces(venues, acPlaces);

  venues.sort((a, b) => a.name.localeCompare(b.name));

  const tally = venues.reduce((acc, v) => {
    acc[v.ac.status] = (acc[v.ac.status] || 0) + 1;
    return acc;
  }, {});

  const out = {
    generated: new Date().toISOString().slice(0, 10),
    bbox,
    count: venues.length,
    venues,
  };

  const path = join(ROOT, 'data', 'venues.json');
  await writeFile(path, JSON.stringify(out, null, 0));
  console.log(`\n✓ wrote ${venues.length} venues → ${path}`);
  console.log(`  curated overlay applied to ${curatedApplied} venue(s)`);
  console.log(`  AC field data: tagged ${merged.tagged} existing, added ${merged.added} new venue(s)`);
  console.log(`  AC status tally:`, tally);
}

main().catch((err) => {
  console.error('\n✗ build failed:', err.message);
  process.exit(1);
});
