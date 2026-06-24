#!/usr/bin/env node
/**
 * moderate.mjs — tiny moderation view for the venue_suggestions queue.
 *
 * Runs LOCALLY only. Uses your Supabase SECRET key (server-side use — never
 * commit it, never ship it to the browser). Lists the queue and lets you
 * approve / reject / mark-added in one command.
 *
 *   export SUPABASE_SECRET=sb_secret_xxx        # from Supabase → Settings → API Keys
 *   node scripts/moderate.mjs                    # list pending (the review queue)
 *   node scripts/moderate.mjs --all             # list everything, grouped by status
 *   node scripts/moderate.mjs --status=approved  # list one status
 *   node scripts/moderate.mjs approve <id>       # set status=approved  (shows live on map)
 *   node scripts/moderate.mjs added   <id>       # set status=added     (curated into dataset)
 *   node scripts/moderate.mjs reject  <id>       # set status=rejected
 *   node scripts/moderate.mjs pending <id>       # send back to the queue
 *
 * <id> can be just the first few characters of the row id.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// --- config ------------------------------------------------------------------
async function resolveUrl() {
  if (process.env.SUPABASE_URL) return process.env.SUPABASE_URL.replace(/\/$/, '');
  try {
    const cfg = await readFile(join(ROOT, 'js', 'config.js'), 'utf8');
    const m = cfg.match(/SUPABASE_URL\s*=\s*runtime\.SUPABASE_URL\s*\|\|\s*['"]([^'"]+)['"]/);
    if (m && m[1].startsWith('http')) return m[1].replace(/\/$/, '');
  } catch {}
  return null;
}

const SECRET = process.env.SUPABASE_SECRET || process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_KEY;

function die(msg) {
  console.error('\n✗ ' + msg + '\n');
  process.exit(1);
}

const STATUSES = ['pending', 'approved', 'added', 'rejected'];
const ICON = { pending: '🕓', approved: '✅', added: '📌', rejected: '🚫' };

// --- REST helpers ------------------------------------------------------------
let URL_BASE;
function headers() {
  return { apikey: SECRET, Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' };
}
async function getRows() {
  const res = await fetch(`${URL_BASE}/rest/v1/venue_suggestions?select=*&order=created_at.desc`, { headers: headers() });
  if (!res.ok) die(`read failed (HTTP ${res.status}): ${await res.text()}`);
  return res.json();
}
async function patch(id, body) {
  const res = await fetch(`${URL_BASE}/rest/v1/venue_suggestions?id=eq.${id}`, {
    method: 'PATCH',
    headers: { ...headers(), Prefer: 'return=representation' },
    body: JSON.stringify(body),
  });
  if (!res.ok) die(`update failed (HTTP ${res.status}): ${await res.text()}`);
  return res.json();
}

// --- formatting --------------------------------------------------------------
function age(ts) {
  const days = (Date.now() - new Date(ts).getTime()) / 86400000;
  if (days < 1) return `${Math.round(days * 24)}h ago`;
  return `${Math.round(days)}d ago`;
}
function printRow(r) {
  const coords = r.lat != null && r.lon != null ? `${r.lat},${r.lon}` : 'no coords';
  const maps = r.lat != null && r.lon != null ? `https://www.openstreetmap.org/?mlat=${r.lat}&mlon=${r.lon}#map=18/${r.lat}/${r.lon}` : '';
  console.log(`  ${ICON[r.status] || '•'} ${r.id.slice(0, 8)}  ${r.name}`);
  console.log(`      ${r.type}${r.ac_hint ? ` · AC: ${r.ac_hint}` : ''} · ${r.address || 'no address'} · ${coords}`);
  if (r.note) console.log(`      note: ${r.note}`);
  if (maps) console.log(`      map:  ${maps}`);
  console.log(`      ${age(r.created_at)}${r.reviewed_at ? ` · reviewed ${age(r.reviewed_at)}` : ''}`);
}

// --- main --------------------------------------------------------------------
async function main() {
  URL_BASE = await resolveUrl();
  if (!URL_BASE) die('No Supabase URL. Set SUPABASE_URL, or ensure js/config.js has it.');
  if (!SECRET) {
    die(
      'No secret key. Get it from Supabase → Settings → API Keys (the sb_secret_… one), then:\n' +
        '  export SUPABASE_SECRET=sb_secret_xxx\n' +
        '  node scripts/moderate.mjs'
    );
  }

  const [cmd, idArg] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const flags = process.argv.slice(2).filter((a) => a.startsWith('--'));

  // actions
  if (['approve', 'added', 'reject', 'pending'].includes(cmd)) {
    if (!idArg) die(`Usage: node scripts/moderate.mjs ${cmd} <id>`);
    const rows = await getRows();
    const matches = rows.filter((r) => r.id.startsWith(idArg));
    if (!matches.length) die(`No suggestion id starts with "${idArg}".`);
    if (matches.length > 1) die(`"${idArg}" is ambiguous (${matches.length} matches). Use more characters.`);
    const target = matches[0];
    const status = cmd === 'pending' ? 'pending' : cmd;
    const [updated] = await patch(target.id, { status, reviewed_at: new Date().toISOString() });
    console.log(`\n${ICON[updated.status]} "${updated.name}" → ${updated.status}\n`);
    return;
  }

  // listing
  const rows = await getRows();
  const counts = STATUSES.reduce((a, s) => ((a[s] = rows.filter((r) => r.status === s).length), a), {});
  console.log(`\nQueue: ${STATUSES.map((s) => `${ICON[s]} ${counts[s]} ${s}`).join('   ')}\n`);

  const statusFlag = flags.find((f) => f.startsWith('--status='));
  let show;
  if (statusFlag) show = rows.filter((r) => r.status === statusFlag.split('=')[1]);
  else if (flags.includes('--all')) show = rows;
  else show = rows.filter((r) => r.status === 'pending');

  if (!show.length) {
    console.log('  (nothing to show)\n');
    return;
  }
  for (const r of show) {
    printRow(r);
    console.log('');
  }
  console.log('Act with:  node scripts/moderate.mjs approve|added|reject|pending <id>\n');
}

main().catch((e) => die(e.message));
