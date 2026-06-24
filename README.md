# Cool Spots London ❄️

A static web app that maps London pubs, bars, cafés, restaurants (and museums) with **air conditioning**. See venues on a map, find a cold spot near you, filter by type / AC status / **open now**, crowd-vote on whether a place is *actually* cold, **share a venue link**, and **suggest new places**.

Zero per-lookup API cost: all venue data is pre-computed into a static `venues.json`. The only live fetches are free OpenFreeMap tiles and the small Supabase vote/tag layer.

## Features
- **Map + clustering** of ~21k venues, AC-status colour coding + legend
- **Filters:** type, AC status (Cold / +Likely / all), open-now, hide-chains — all client-side
- **Search** by venue name / postcode **or area** (type "Farringdon", "Shoreditch" → jump there); **Find me** geolocation; distance-sorted viewport list
- **Detail panel:** AC consensus + vote tally, voting, tags, opening hours, website, and **directions** that deep-link to the user's own map app (Apple Maps / Google Maps / Citymapper / OpenStreetMap) — plain URLs, no map API, no cost
- **Open now** computed from OSM `opening_hours` (via opening_hours.js), with a live badge
- **Shareable links** — every venue has a `#v=<id>` deep link (Web Share / copy)
- **Suggest a place** — submits to a Supabase moderation queue; suggestions you **approve** in the dashboard appear **live** on the map (no redeploy) via an overlay merged on top of the static data
- **Installable (PWA)** — manifest + service worker make it addable to a phone home screen, with an "Add to Home Screen" prompt in the About sheet and offline-capable app shell. Regenerate icons with `npm run build:icons`.

## Stack
- **Map:** [MapLibre GL JS](https://maplibre.org/) (no key) — loaded from CDN
- **Tiles:** [OpenFreeMap](https://openfreemap.org/) `liberty` style (no key, no limits)
- **Venue data:** OpenStreetMap via Overpass, pulled once at build time → `data/venues.json`
- **User layer:** Supabase free tier (anonymous votes + tags) — optional
- **Build step:** none for the app. Plain ES modules + CDN. A Node script generates the data.

## Run locally
Any static server works (ES modules need `http://`, not `file://`):

```bash
npx serve .          # or: python3 -m http.server 8080
```

Open the printed URL. The app loads, renders the map, and works fully **without** Supabase (P0). Voting/tagging activate once Supabase is configured (P1).

## Project layout
```
index.html              app shell
css/styles.css          styles (mobile-first, cool/airy palette)
js/config.js            map + Supabase + colour/tag config
js/map.js               MapLibre setup, clustering, AC colour layers
js/venues.js            data load, filtering, consensus merge, geo helpers
js/supabase.js          anonymous votes/tags client (lazy-loaded)
js/app.js               UI wiring: search, filters, list, detail, voting
data/venues.json        generated venue dataset (the curated source of truth)
data/curated-ac.json    hand-curated AC overlay (the "moat")
scripts/build-venues.mjs Overpass → venues.json pipeline
supabase/schema.sql     tables + RLS policies for the user layer
```

## Regenerate venue data
```bash
node scripts/build-venues.mjs              # full Greater London (default), cached raw if present
node scripts/build-venues.mjs --fresh      # refetch from Overpass
node scripts/build-venues.mjs --central    # tighter central-London bbox (smaller file)
node scripts/build-venues.mjs --bbox=51.46,-0.21,51.55,0.0
```
The script builds AC status in three layers, each overriding the last:
1. **OSM** — seeds from the `air_conditioning` tag.
2. **`data/curated-ac.json`** — name-matched overlay for chains/known venues.
3. **`data/ac-places-london.json`** — field-confirmed AC list *with coordinates*. Each entry is matched to a nearby OSM venue by proximity + fuzzy name and tagged in place; if no match is found within 200 m, it's added as a new venue (`source: "user"`). Museums are supported here as a venue type.

Grow any of those files to expand the high-confidence "Cold"/"Likely" set.

**`data/venue-overrides.json`** is applied *last* (after dedupe), keyed by OSM id. Use it for corrections the overlays above can't express — rebrands/renames, chain/cuisine/website fixes — so manual edits survive a rebuild instead of being overwritten by OSM. Each entry is `{ "id": "node/123", "set": { ...fields } }`; an `ac` object is merged, other keys overwrite. (Example: Chai Ki → Din Tai Fung.)

### Area search gazetteer
`data/areas.json` powers "search by area" (jump to Farringdon, Shoreditch, …). Regenerate it from OSM place nodes:
```bash
node scripts/build-areas.mjs            # cached raw if present
node scripts/build-areas.mjs --fresh    # refetch from Overpass
```

## Enable the user layer (Supabase)
1. Create a free project at [supabase.com](https://supabase.com).
2. In the SQL editor, run [`supabase/schema.sql`](supabase/schema.sql).
3. Grab two values from the dashboard:
   - **Publishable key** — Project Settings → **API Keys** → `sb_publishable_...`
   - **Project URL** — Project Settings → **Data API** (or API) → `https://xxxx.supabase.co`
4. Add them. Either edit `js/config.js`, or inject at runtime before `app.js` loads:
   ```html
   <script>
     window.COOL_SPOTS_CONFIG = {
       SUPABASE_URL: 'https://xxxx.supabase.co',
       SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_...'
     };
   </script>
   ```

**Keys:** Supabase replaced the legacy `anon` / `service_role` JWTs with **publishable** (`sb_publishable_...`) and **secret** (`sb_secret_...`) keys. This is a static client app, so it uses the **publishable** key — public by design, with Row Level Security restricting it to inserting votes/tags and reading aggregates. **Never** put the **secret** key here: it grants elevated access and is blocked from running in browsers. (A legacy `anon` key still works via `SUPABASE_ANON_KEY` if you're on an older project.)

### How AC status is shown
- **≥ 3 votes:** community consensus from the modal vote, with the tally.
- **otherwise:** the curated/OSM status, labelled "Listed".

### Moderating suggestions (local CLI)
The `venue_suggestions` queue isn't publicly readable, and Supabase blocks the
secret key in browsers — so moderation is a small local CLI that uses your
**secret** key (server-side; never commit or deploy it):
```bash
export SUPABASE_SECRET=sb_secret_xxx     # Supabase → Settings → API Keys
npm run moderate                          # list the pending queue
npm run moderate -- --all                 # everything, grouped by status
node scripts/moderate.mjs approve <id>    # → live on the map (overlay)
node scripts/moderate.mjs added   <id>    # → curated into the dataset (kept as record)
node scripts/moderate.mjs reject  <id>    # → declined
```
Each entry prints name/type/AC-hint/address/note + a map link to eyeball the
location. `<id>` can be just the first few characters.

## Deploy
It's static — drop the folder on Cloudflare Pages, Vercel, Netlify, or GitHub Pages. No build command needed (output dir = repo root).

## Data & licensing
Venue data © OpenStreetMap contributors (ODbL). Map tiles by OpenFreeMap. No Google Maps/Places data is used or cached.
