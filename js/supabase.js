// Supabase user layer: anonymous AC votes + venue tags.
// Loads the client lazily so the static P0 app has zero backend dependency.

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_ENABLED } from './config.js';

let client = null;
function db() {
  if (!SUPABASE_ENABLED) return null;
  if (!client) client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
  return client;
}

export const supabaseEnabled = SUPABASE_ENABLED;

// --- anonymous device id (limits duplicate votes per device) ------------------
export function getAnonId() {
  const KEY = 'cool_spots_anon_id';
  let id = localStorage.getItem(KEY);
  if (!id) {
    id =
      (crypto.randomUUID && crypto.randomUUID()) ||
      'anon-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem(KEY, id);
  }
  return id;
}

// Remember this device's own vote per venue so the UI can highlight it offline.
function localVoteKey(venueId) {
  return `cool_spots_vote:${venueId}`;
}
export function getLocalVote(venueId) {
  return localStorage.getItem(localVoteKey(venueId));
}
function setLocalVote(venueId, choice) {
  localStorage.setItem(localVoteKey(venueId), choice);
}

// --- reads (aggregated per venue) ---------------------------------------------
// Returns { votes: {cold,mild,none,unsure}, total, tags: {tag: count} } or null.
export async function fetchVenueAggregates(venueId) {
  const c = db();
  if (!c) return null;
  const [votesRes, tagsRes] = await Promise.all([
    c.from('ac_votes').select('choice').eq('venue_id', venueId),
    c.from('venue_tags').select('tag').eq('venue_id', venueId),
  ]);
  if (votesRes.error) throw votesRes.error;
  if (tagsRes.error) throw tagsRes.error;

  const votes = { cold: 0, mild: 0, none: 0, unsure: 0 };
  for (const row of votesRes.data || []) {
    if (row.choice in votes) votes[row.choice]++;
  }
  const tags = {};
  for (const row of tagsRes.data || []) {
    tags[row.tag] = (tags[row.tag] || 0) + 1;
  }
  const total = votesRes.data?.length || 0;
  return { votes, total, tags };
}

// All votes in one read, aggregated per venue — feeds the map/filter consensus.
// Returns { venue_id: { votes:{cold,mild,none,unsure}, total } }.
export async function fetchAllVoteAggregates() {
  const c = db();
  if (!c) return {};
  const { data, error } = await c.from('ac_votes').select('venue_id,choice');
  if (error) {
    console.warn('bulk votes read failed', error.message);
    return {};
  }
  const out = {};
  for (const row of data || []) {
    const a = (out[row.venue_id] ||= { votes: { cold: 0, mild: 0, none: 0, unsure: 0 }, total: 0 });
    if (row.choice in a.votes) {
      a.votes[row.choice]++;
      a.total++;
    }
  }
  return out;
}

// --- writes -------------------------------------------------------------------
// One vote per (venue_id, anon_id): upsert on conflict.
export async function castVote(venueId, choice) {
  setLocalVote(venueId, choice);
  const c = db();
  if (!c) return { offline: true };
  const { error } = await c
    .from('ac_votes')
    .upsert(
      { venue_id: venueId, choice, anon_id: getAnonId() },
      { onConflict: 'venue_id,anon_id' }
    );
  if (error) throw error;
  return { offline: false };
}

// P2: submit a venue suggestion to the moderation queue.
export async function submitSuggestion(payload) {
  const c = db();
  if (!c) return { offline: true };
  const { error } = await c.from('venue_suggestions').insert({
    name: payload.name,
    type: payload.type,
    address: payload.address || null,
    lat: payload.lat ?? null,
    lon: payload.lon ?? null,
    ac_hint: payload.ac_hint || null,
    note: payload.note || null,
    anon_id: getAnonId(),
  });
  if (error) throw error;
  return { offline: false };
}

// Approved venue suggestions — a live overlay on the static map.
// Only rows you've set status='approved' are readable (see RLS in schema.sql),
// so moderation = flipping status in the dashboard; no redeploy needed.
export async function fetchApprovedSuggestions() {
  const c = db();
  if (!c) return [];
  const { data, error } = await c
    .from('venue_suggestions')
    .select('id,name,type,address,lat,lon,ac_hint,note')
    .eq('status', 'approved');
  if (error) {
    console.warn('approved suggestions read failed', error.message);
    return [];
  }
  return data || [];
}

// P2: send app feedback / contact message.
export async function submitFeedback({ message, email }) {
  const c = db();
  if (!c) return { offline: true };
  const { error } = await c.from('app_feedback').insert({
    message,
    email: email || null,
    anon_id: getAnonId(),
  });
  if (error) throw error;
  return { offline: false };
}

export async function addTag(venueId, tag) {
  const c = db();
  if (!c) return { offline: true };
  const { error } = await c
    .from('venue_tags')
    .upsert(
      { venue_id: venueId, tag, anon_id: getAnonId() },
      { onConflict: 'venue_id,tag,anon_id', ignoreDuplicates: true }
    );
  if (error) throw error;
  return { offline: false };
}
