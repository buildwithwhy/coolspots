#!/usr/bin/env node
/**
 * build-areas.mjs — one-time gazetteer of London areas for "search by area".
 *
 * Pulls OSM place nodes (suburb / neighbourhood / town / …) across Greater
 * London and writes data/areas.json: { name, lat, lon, kind }. Lets the app
 * offer "jump to Farringdon / Shoreditch / Soho …" suggestions with no live
 * geocoding API — same zero-cost model as venues.json.
 *
 *   node scripts/build-areas.mjs            # cached raw if present
 *   node scripts/build-areas.mjs --fresh    # refetch from Overpass
 */

import { writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const BBOX = [51.28, -0.52, 51.7, 0.33]; // Greater London (s,w,n,e)
const KINDS = ['city', 'borough', 'town', 'suburb', 'neighbourhood', 'quarter', 'village', 'locality'];
const RANK = Object.fromEntries(KINDS.map((k, i) => [k, i])); // lower = more important

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

function buildQuery([s, w, n, e]) {
  return `[out:json][timeout:120];\n(\n  node["place"~"^(${KINDS.join('|')})$"]["name"](${s},${w},${n},${e});\n);\nout;`;
}

async function fetchOverpass(query) {
  const cachePath = join(ROOT, 'data', '_areas-raw.json');
  if (!process.argv.includes('--fresh')) {
    try {
      const cached = JSON.parse(await readFile(cachePath, 'utf8'));
      console.log(`→ using cached raw response (${cached.elements?.length ?? 0} elements). Pass --fresh to refetch.`);
      return cached;
    } catch {
      /* fetch below */
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

async function main() {
  const raw = await fetchOverpass(buildQuery(BBOX));
  const elements = raw.elements || [];

  // dedupe by name, keeping the most important place kind
  const byName = new Map();
  for (const el of elements) {
    const name = el.tags?.name;
    const kind = el.tags?.place;
    if (!name || el.lat == null || el.lon == null) continue;
    if (/[^\x00-\x7F]/.test(name) && !/[a-z]/i.test(name)) continue; // skip non-Latin-only names
    const key = name.toLowerCase().trim();
    const prev = byName.get(key);
    if (!prev || (RANK[kind] ?? 99) < (RANK[prev.kind] ?? 99)) {
      byName.set(key, {
        name,
        lat: Number(el.lat.toFixed(5)),
        lon: Number(el.lon.toFixed(5)),
        kind,
      });
    }
  }

  const areas = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  const out = { generated: new Date().toISOString().slice(0, 10), count: areas.length, areas };
  const path = join(ROOT, 'data', 'areas.json');
  await writeFile(path, JSON.stringify(out));
  console.log(`\n✓ wrote ${areas.length} areas → ${path}`);
  const tally = areas.reduce((a, x) => ((a[x.kind] = (a[x.kind] || 0) + 1), a), {});
  console.log('  kinds:', tally);
}

main().catch((err) => {
  console.error('\n✗ build failed:', err.message);
  process.exit(1);
});
