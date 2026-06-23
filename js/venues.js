// Venue data: load, filter, and the curated⇄vote consensus merge.

import { AC_COLORS, AC_LABELS } from './config.js';
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
export function getVenue(id) {
  return byId.get(id);
}

// --- displayed AC status: vote consensus overrides curated when ≥3 votes ------
// `agg` is the Supabase aggregate ({ votes, total }) or null.
export function displayedStatus(venue, agg) {
  if (agg && agg.total >= 3) {
    const entries = Object.entries(agg.votes);
    const [topChoice] = entries.sort((a, b) => b[1] - a[1])[0];
    const map = {
      cold: { key: 'yes', label: 'Cold', source: 'votes' },
      mild: { key: 'likely', label: 'Mild AC', source: 'votes' },
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

// status used for map colouring / filtering before any votes are loaded
export function baseStatusKey(venue) {
  return venue.ac?.status || 'unknown';
}

// --- filtering ----------------------------------------------------------------
// filters = { types:Set, ac:'cold'|'likely'|'all', hideChains:bool, query:string }
export function matchesFilters(v, f) {
  if (f.types && f.types.size && !f.types.has(v.type)) return false;
  if (f.hideChains && v.chain) return false;

  const status = baseStatusKey(v);
  if (f.ac === 'cold' && status !== 'yes') return false;
  if (f.ac === 'likely' && !(status === 'yes' || status === 'likely')) return false;

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
      properties: { id: v.id, name: v.name, type: v.type, acStatus: baseStatusKey(v) },
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
