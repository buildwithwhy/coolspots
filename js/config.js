// App configuration.
//
// Supabase powers the optional user layer (AC votes + tags). It uses the
// PUBLISHABLE key (sb_publishable_...) — the new browser-safe key that replaces
// the legacy "anon" key. It's public by design: Row Level Security on the tables
// restricts it to inserting votes/tags and reading aggregates only.
//
// ⚠️ Never put the SECRET key (sb_secret_..., replaces service_role) in here —
// it grants elevated access and is blocked from running in browsers anyway.
//
// To enable the user layer:
//   1. Create a free Supabase project.
//   2. Run the SQL in supabase/schema.sql.
//   3. Dashboard → Project Settings → API Keys → copy the Publishable key,
//      and Settings → Data API (or API) → copy the Project URL.
//   4. Paste both below, or set them at runtime via window.COOL_SPOTS_CONFIG
//      before this module loads.
//
// Until configured, the app runs fully as the static P0 product: map, markers,
// filters, search, geolocation, and curated AC status — no backend needed.

const runtime = (typeof window !== 'undefined' && window.COOL_SPOTS_CONFIG) || {};

export const SUPABASE_URL = runtime.SUPABASE_URL || 'https://fmdynyclaniwfoknapci.supabase.co';

// Accept the new publishable key, or a legacy anon key if you're on an older
// project — both are public, browser-safe, and behave the same under RLS.
export const SUPABASE_PUBLISHABLE_KEY =
  runtime.SUPABASE_PUBLISHABLE_KEY ||
  runtime.SUPABASE_ANON_KEY ||
  'sb_publishable_lgJRtchh9FU_swUd_8bxjA_youe90zc';

export const SUPABASE_ENABLED =
  SUPABASE_URL.startsWith('http') &&
  !SUPABASE_PUBLISHABLE_KEY.startsWith('YOUR_') &&
  SUPABASE_PUBLISHABLE_KEY.length > 20;

// MapLibre / OpenFreeMap
// Votes override the curated AC status once a venue reaches this many votes.
// Set to 1 while the app is small (surface every vote we have); raise to 3+ as
// it grows so a single vote can't flip a place on its own.
export const CONSENSUS_MIN_VOTES = 1;

export const MAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
export const LONDON_CENTER = [-0.1276, 51.5072]; // [lon, lat]
export const DEFAULT_ZOOM = 12;

// AC status → colour scale (doubles as the legend)
// Two different ideas, deliberately distinct colours:
//   yes/cold = confirmed cold; mild = confirmed-but-weak AC (an intensity);
//   likely = unconfirmed, "probably has AC" (a confidence). Mild ≠ Likely.
export const AC_COLORS = {
  yes: '#0284c7', // cool blue   — Cold / confirmed AC
  cold: '#0284c7',
  mild: '#38bdf8', // sky        — Mild AC (has AC, runs weak)
  likely: '#14b8a6', // teal     — Likely (probably has AC, unconfirmed)
  unknown: '#94a3b8', // slate    — Unknown
  no: '#f59e0b', // warm amber   — No AC
};

export const AC_LABELS = {
  yes: 'Cold',
  cold: 'Cold',
  likely: 'Likely AC',
  mild: 'Mild AC',
  unknown: 'Unknown',
  no: 'No AC',
};

// Venue categories (types) and their display labels.
export const TYPES = ['pub', 'bar', 'cafe', 'restaurant', 'museum', 'public'];
export const TYPE_LABELS = {
  pub: 'Pub',
  bar: 'Bar',
  cafe: 'Café',
  restaurant: 'Restaurant',
  museum: 'Museum',
  public: 'Public space',
};

// Controlled tag vocabulary (keeps user tags clean)
export const TAG_OPTIONS = [
  'quiet',
  'wifi',
  'outdoor-seating',
  'good-for-work',
  'spacious',
  'dog-friendly',
  'cheap',
  'fan-only',
];
