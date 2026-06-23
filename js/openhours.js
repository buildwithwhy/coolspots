// "Open now" — evaluates OSM `opening_hours` strings with the canonical
// opening_hours.js library. Parsing is cached per venue (the parse is the cost;
// state lookups are cheap), so toggling the "open now" filter stays fast.

import oh from 'https://cdn.jsdelivr.net/npm/opening_hours@3.8.0/+esm';

const cache = new Map(); // venue.id → parsed instance | null

// opening_hours.js can't evaluate public/school-holiday rules (PH/SH) without
// bundled GB holiday data and throws on them. They're common in OSM, so strip
// them — we keep the regular weekly hours, which is what "open now" needs.
function stripHolidays(s) {
  return s
    .split(';')
    .map((part) => {
      const hadHoliday = /\b(PH|SH)\b/.test(part);
      const cleaned = part
        .replace(/,?\s*\b(PH|SH)\b\s*,?/g, ' ') // drop PH/SH tokens + any adjacent comma
        .replace(/\s+/g, ' ')
        .trim();
      return { hadHoliday, cleaned };
    })
    // keep cleaned parts; drop only rules left orphaned (time-only) BY holiday removal
    // — a genuine time-only rule like "13:00-17:00" (daily) has no holiday and stays.
    .filter(({ hadHoliday, cleaned }) => cleaned && !(hadHoliday && /^\d/.test(cleaned)))
    .map(({ cleaned }) => cleaned)
    .join('; ')
    .trim();
}

function parse(v) {
  if (cache.has(v.id)) return cache.get(v.id);
  let inst = null;
  const raw = v.opening_hours ? stripHolidays(v.opening_hours) : '';
  if (raw) {
    try {
      // lat/lon let it resolve sunrise/sunset; no address ⇒ no holiday lookup
      inst = new oh(raw, { lat: v.lat, lon: v.lon });
    } catch {
      inst = null; // still unparseable → treated as "unknown hours"
    }
  }
  cache.set(v.id, inst);
  return inst;
}

// { known } is false when there are no hours or the string can't be parsed.
export function openState(v, date = new Date()) {
  const inst = parse(v);
  if (!inst) return { known: false, open: false, nextChange: null };
  try {
    return {
      known: true,
      open: inst.getState(date),
      nextChange: inst.getNextChange(date) || null,
    };
  } catch {
    return { known: false, open: false, nextChange: null };
  }
}

// Open-now state only changes at minute boundaries, so cache the boolean result
// per venue per minute — repeated filter passes within the same minute are then
// just Map lookups instead of re-running getState() across thousands of venues.
const resultCache = new Map(); // id → { minute, open }
const minuteBucket = (d) => Math.floor(d.getTime() / 60000);

export function isOpenNow(v, date = new Date()) {
  const bucket = minuteBucket(date);
  const cached = resultCache.get(v.id);
  if (cached && cached.minute === bucket) return cached.open;
  const s = openState(v, date);
  const open = s.known && s.open;
  resultCache.set(v.id, { minute: bucket, open });
  return open;
}

// Warm the parse + result caches during idle time so the first "Open now"
// toggle is instant. Chunked to avoid blocking the main thread.
export function prewarm(venues) {
  const list = venues.filter((v) => v.opening_hours);
  let i = 0;
  const schedule =
    window.requestIdleCallback || ((fn) => setTimeout(() => fn({ timeRemaining: () => 8 }), 1));
  const step = (deadline) => {
    while (i < list.length && deadline.timeRemaining() > 3) isOpenNow(list[i++]);
    if (i < list.length) schedule(step);
  };
  schedule(step);
}

// Short human label, e.g. "Open · closes 23:00" / "Closed · opens Mon 09:00".
export function openLabel(v) {
  const s = openState(v);
  if (!s.known) return null;
  const fmt = (d) =>
    d
      ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
      : '';
  const day = (d) =>
    d && d.toDateString() !== new Date().toDateString()
      ? d.toLocaleDateString('en-GB', { weekday: 'short' }) + ' '
      : '';
  if (s.open) {
    return s.nextChange ? `Open · closes ${day(s.nextChange)}${fmt(s.nextChange)}` : 'Open now';
  }
  return s.nextChange ? `Closed · opens ${day(s.nextChange)}${fmt(s.nextChange)}` : 'Closed now';
}
