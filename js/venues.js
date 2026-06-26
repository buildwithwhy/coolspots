// Venue data: load, filter, and the curated⇄vote consensus merge.

import { AC_COLORS, AC_LABELS, CONSENSUS_MIN_VOTES } from './config.js';
import { isOpenNow } from './openhours.js';

let all = [];
const byId = new Map();

export async function loadVenues() {
  const res = await fetch('data/venues.json');
  if (!res.ok) throw new Error(`failed to load venues.json (HTTP ${res.status})`);
  const json = await res.json();
  all = json.venues || [];
  byId.clear();
  for (const v of all) byId.set(v.id, v);
  return { count: all.length, generated: json.generated };
}

export function allVenues() {
  return all;
}

// Merge live "approved suggestion" venues on top of the static set, skipping any
// that duplicate an existing venue (within ~120 m + similar name). Returns count added.
function similarName(a, b) {
  const n = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const na = n(a);
  const nb = n(b);
  return !!na && !!nb && (na === nb || (na.length >= 5 && (na.includes(nb) || nb.includes(na))));
}
export function addSuggestedVenues(list) {
  let added = 0;
  for (const v of list) {
    if (v.lat == null || v.lon == null || byId.has(v.id)) continue;
    const dup = all.some(
      (e) =>
        Math.abs(e.lat - v.lat) < 0.0015 &&
        Math.abs(e.lon - v.lon) < 0.0015 &&
        haversineMeters({ lat: e.lat, lon: e.lon }, { lat: v.lat, lon: v.lon }) <= 120 &&
        similarName(e.name, v.name)
    );
    if (dup) continue;
    all.push(v);
    byId.set(v.id, v);
    added++;
  }
  return added;
}
export function getVenue(id) {
  return byId.get(id);
}

// --- displayed AC status: vote consensus overrides curated when ≥3 votes ------
// `agg` is the Supabase aggregate ({ votes, total }) or null.
export function displayedStatus(venue, agg) {
  if (agg && agg.total >= CONSENSUS_MIN_VOTES) {
    const entries = Object.entries(agg.votes);
    const [topChoice] = entries.sort((a, b) => b[1] - a[1])[0];
    const map = {
      cold: { key: 'yes', label: 'Cold', source: 'votes' },
      mild: { key: 'mild', label: 'Mild AC', source: 'votes' },
      none: { key: 'no', label: 'No AC', source: 'votes' },
      unsure: { key: 'unknown', label: 'Unclear', source: 'votes' },
    };
    const r = map[topChoice] || map.unsure;
    return { ...r, total: agg.total, color: AC_COLORS[r.key] };
  }
  // Fall back to curated/OSM status, labelled "Listed".
  const key = venue.ac?.status || 'unknown';
  return {
    key,
    label: AC_LABELS[key] || 'Unknown',
    source: 'listed',
    total: agg?.total || 0,
    color: AC_COLORS[key] || AC_COLORS.unknown,
  };
}

// curated/OSM status, before any votes
export function baseStatusKey(venue) {
  return venue.ac?.status || 'unknown';
}

// --- vote consensus overlay (drives map colour + filtering) -------------------
// venue id → status key, only for venues with ≥3 votes. Votes override curated.
const consensus = new Map();
const CHOICE_TO_KEY = { cold: 'yes', mild: 'mild', none: 'no', unsure: 'unknown' };

// derive a status key from a vote aggregate ({ votes:{cold,mild,none,unsure}, total })
export function consensusKeyFromAgg(agg) {
  if (!agg || agg.total < CONSENSUS_MIN_VOTES) return null;
  const top = Object.entries(agg.votes).sort((a, b) => b[1] - a[1])[0][0];
  return CHOICE_TO_KEY[top] || null;
}
export function setConsensus(entries) {
  consensus.clear();
  for (const [id, key] of entries) if (key) consensus.set(id, key);
}
export function setConsensusOne(id, key) {
  if (key) consensus.set(id, key);
  else consensus.delete(id);
}
// what the map + filters use: consensus when ≥3 votes, else curated status
export function effectiveStatusKey(venue) {
  return consensus.get(venue.id) || baseStatusKey(venue);
}

// --- filtering ----------------------------------------------------------------
// filters = { types:Set, ac:'cold'|'likely'|'all', hideChains:bool, query:string }
export function matchesFilters(v, f) {
  if (f.types && f.types.size && !f.types.has(v.type)) return false;
  if (f.hideChains && v.chain) return false;

  const status = effectiveStatusKey(v);
  if (f.ac === 'cold' && status !== 'yes') return false;
  if (f.ac === 'likely' && !(status === 'yes' || status === 'mild' || status === 'likely')) return false;

  if (f.openNow && !isOpenNow(v)) return false;

  if (f.query) {
    const q = f.query.toLowerCase();
    const hay = `${v.name} ${v.postcode || ''} ${v.address || ''}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

export function filterVenues(f) {
  return all.filter((v) => matchesFilters(v, f));
}

// --- GeoJSON for the MapLibre source -----------------------------------------
export function toGeoJSON(venues) {
  return {
    type: 'FeatureCollection',
    features: venues.map((v) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [v.lon, v.lat] },
      properties: { id: v.id, name: v.name, type: v.type, acStatus: effectiveStatusKey(v) },
    })),
  };
}

// --- geo helpers --------------------------------------------------------------
export function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function formatDistance(m) {
  if (m == null) return '';
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}
