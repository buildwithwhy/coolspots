// App wiring: data + map + UI panels + filters + user layer.

import {
  loadVenues,
  allVenues,
  addSuggestedVenues,
  filterVenues,
  toGeoJSON,
  getVenue,
  displayedStatus,
  effectiveStatusKey,
  setConsensus,
  setConsensusOne,
  consensusKeyFromAgg,
  haversineMeters,
  formatDistance,
} from './venues.js';
import * as MapView from './map.js';
import {
  supabaseEnabled,
  fetchVenueAggregates,
  castVote,
  addTag,
  getLocalVote,
  submitSuggestion,
  submitFeedback,
  fetchApprovedSuggestions,
  fetchAllVoteAggregates,
} from './supabase.js';
import { openLabel, prewarm as prewarmOpenHours } from './openhours.js';
import { AC_LABELS, AC_COLORS, TAG_OPTIONS, TYPE_LABELS } from './config.js';

const $ = (sel) => document.querySelector(sel);
const LIST_LIMIT = 80;
let closeAutocomplete = () => {}; // set by wireSearch, called on Escape
let deferredPrompt = null; // captured beforeinstallprompt event (Android/Chrome)
let correctingVenue = null; // venue being corrected (dedicated correction sheet)
let sharePrompted = false; // gentle post-vote share nudge, once per session

const state = {
  filters: { types: new Set(['pub', 'bar', 'cafe', 'restaurant', 'museum', 'public']), ac: 'all', hideChains: false, openNow: false, query: '' },
  userLocation: null,
  currentId: null,
  filtered: [],
  aggCache: new Map(),
  areas: [], // OSM gazetteer for area search (areas.json)
};

// ---------------------------------------------------------------------------
async function boot() {
  const status = $('#load-status');
  try {
    const { count, generated } = await loadVenues();
    status.textContent = `${count.toLocaleString()} venues`;
    $('#data-date').textContent = generated ? `OSM data · ${generated}` : '';
    setTimeout(() => $('#load-pill').classList.add('hide'), 2500); // declutter once loaded
    // load the area gazetteer for "search by area" (non-blocking, optional)
    fetch('data/areas.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (j?.areas) state.areas = j.areas; })
      .catch(() => {});
  } catch (err) {
    status.textContent = 'Failed to load venue data';
    console.error(err);
    return;
  }

  MapView.initMap({ onVenueClick: (id) => openDetail(id), onMoveEnd: updateList });
  MapView.onReady(() => {
    refresh();
    updateList();
    openFromHash(); // deep-link: #v=<venue-id>
  });

  wireControls();
  window.addEventListener('hashchange', openFromHash);
  prewarmOpenHours(allVenues()); // warm "open now" cache during idle
  if (supabaseEnabled) loadApprovedSuggestions(); // live moderated-suggestion overlay
  if (supabaseEnabled) loadVoteConsensus(); // votes recolour/refilter the map
  if (!supabaseEnabled) markUserLayerDisabled();

  // PWA: register service worker (enables install + offline)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('SW registration failed', err));
  }
  // capture Android/Chrome install prompt for our own button
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    maybeShowInstallBanner();
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    hideInstallBanner(true);
  });
  // iOS has no beforeinstallprompt — nudge after the map settles
  setTimeout(maybeShowInstallBanner, 4000);
}

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}
function isIOS() {
  const ua = navigator.userAgent || '';
  return /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
function isPhone() {
  return window.matchMedia('(max-width: 820px)').matches;
}

// Do the right install action for the platform: native prompt where available,
// otherwise the visual iOS step-by-step.
async function triggerInstall() {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    return;
  }
  if (isIOS()) $('#ios-install').hidden = false;
}

const INSTALL_DISMISS_KEY = 'cs_install_dismissed';
function maybeShowInstallBanner() {
  if (isStandalone() || localStorage.getItem(INSTALL_DISMISS_KEY) || !isPhone()) return;
  if (!deferredPrompt && !isIOS()) return; // only where install is actually possible
  $('#install-banner').hidden = false;
}
function hideInstallBanner(remember) {
  $('#install-banner').hidden = true;
  if (remember) localStorage.setItem(INSTALL_DISMISS_KEY, '1');
}

// --- live suggestion overlay ------------------------------------------------
function suggestionToVenue(s) {
  const acMap = {
    cold: { status: 'likely', confidence: 0.55 },
    mild: { status: 'likely', confidence: 0.5 },
    none: { status: 'no', confidence: 0.5 },
    unsure: { status: 'unknown', confidence: 0.3 },
  };
  const m = acMap[s.ac_hint] || { status: 'unknown', confidence: 0.3 };
  const type = ['pub', 'bar', 'cafe', 'restaurant', 'museum', 'public'].includes(s.type) ? s.type : 'restaurant';
  return {
    id: 'suggestion/' + s.id,
    name: s.name,
    type,
    lat: s.lat,
    lon: s.lon,
    address: s.address || null,
    postcode: null,
    website: null,
    opening_hours: null,
    cuisine: null,
    chain: false,
    ac: {
      status: m.status,
      source: 'suggested',
      confidence: m.confidence,
      evidence: 'Community-suggested' + (s.note ? ` — ${s.note}` : ''),
    },
  };
}

async function loadApprovedSuggestions() {
  try {
    const rows = await fetchApprovedSuggestions();
    if (!rows.length) return;
    const venues = rows.map(suggestionToVenue).filter((v) => v.lat != null && v.lon != null);
    const added = addSuggestedVenues(venues);
    if (added) MapView.onReady(refresh); // re-render once they're merged in
  } catch (e) {
    console.warn('suggestion overlay failed', e);
  }
}

// load all votes once → ≥3-vote consensus recolours & refilters venues on the map
async function loadVoteConsensus() {
  try {
    const aggs = await fetchAllVoteAggregates();
    const entries = [];
    for (const [id, agg] of Object.entries(aggs)) {
      const key = consensusKeyFromAgg(agg);
      if (key) entries.push([id, key]);
    }
    setConsensus(entries);
    MapView.onReady(refresh);
  } catch (e) {
    console.warn('vote consensus load failed', e);
  }
}

// shareable links: open the venue named in the URL hash (#v=node/123)
function openFromHash() {
  const m = location.hash.match(/^#v=(.+)$/);
  if (!m) return;
  const id = decodeURIComponent(m[1]);
  if (id !== state.currentId && getVenue(id)) openDetail(id);
}

// --- core refresh -----------------------------------------------------------
function refresh() {
  state.filtered = filterVenues(state.filters);
  MapView.setData(toGeoJSON(state.filtered));
  $('#result-count').textContent = `${state.filtered.length.toLocaleString()} shown`;

  // make search matches pop, and frame them when the result set is small
  const searching = !!state.filters.query;
  MapView.setSearchActive(searching);
  if (searching && state.filtered.length > 0 && state.filtered.length <= 80) {
    MapView.fitToVenues(state.filtered);
  }
  updateList();
}

function originPoint() {
  return state.userLocation || MapView.getCenter();
}

function updateList() {
  const ul = $('#list');
  const inView = MapView.venuesInView(state.filtered);
  const origin = originPoint();
  const withDist = inView
    .map((v) => ({ v, d: haversineMeters(origin, { lat: v.lat, lon: v.lon }) }))
    .sort((a, b) => a.d - b.d);

  $('#list-count').textContent = `${inView.length} in view`;
  ul.innerHTML = '';

  if (!withDist.length) {
    ul.innerHTML = '<li class="list-empty">No venues in view. Zoom or pan the map.</li>';
    return;
  }

  const frag = document.createDocumentFragment();
  for (const { v, d } of withDist.slice(0, LIST_LIMIT)) {
    const key = effectiveStatusKey(v);
    const dir = mapLinks(v)[0]; // device-default map app
    const li = document.createElement('li');
    li.className = 'list-item';
    li.dataset.id = v.id;
    li.innerHTML = `
      <span class="dot" style="background:${AC_COLORS[key]}"></span>
      <div class="list-item__body">
        <div class="list-item__name">${esc(v.name)}</div>
        <div class="list-item__meta">${typeLabel(v.type)} · ${AC_LABELS[key]}${
      v.postcode ? ' · ' + esc(v.postcode) : ''
    }</div>
      </div>
      <span class="list-item__dist">${formatDistance(d)}</span>
      <a class="list-item__dir" href="${dir.url}" target="_blank" rel="noopener"
         title="Directions (${dir.label})" aria-label="Directions to ${esc(v.name)}">↗</a>`;
    li.addEventListener('click', (e) => {
      if (e.target.closest('.list-item__dir')) return; // let the directions link through
      openDetail(v.id);
    });
    frag.appendChild(li);
  }
  ul.appendChild(frag);
  if (withDist.length > LIST_LIMIT) {
    const more = document.createElement('li');
    more.className = 'list-empty';
    more.textContent = `+${withDist.length - LIST_LIMIT} more — zoom in to narrow`;
    ul.appendChild(more);
  }
}

// --- detail panel -----------------------------------------------------------
async function openDetail(id) {
  const v = getVenue(id);
  if (!v) return;
  state.currentId = id;
  history.replaceState(null, '', `#v=${encodeURIComponent(id)}`);
  MapView.flyToVenue(v);

  const open = openLabel(v); // null when hours unknown/unparseable
  const osmU = osmUrl(v); // OSM page to verify/edit (null for non-OSM venues)

  const panel = $('#detail');
  panel.classList.add('open');
  document.body.classList.add('detail-open');

  const origin = originPoint();
  const dist = formatDistance(haversineMeters(origin, { lat: v.lat, lon: v.lon }));
  const baseKey = v.ac?.status || 'unknown';

  panel.querySelector('#detail-body').innerHTML = `
    <div class="detail-head">
      <div>
        <h2 id="detail-name">${esc(v.name)}</h2>
        <div class="detail-sub">${typeLabel(v.type)}${v.cuisine ? ' · ' + esc(v.cuisine.replace(/_/g, ' ')) : ''}${
    dist ? ' · ' + dist + ' away' : ''
  }</div>
      </div>
      <div class="detail-actions">
        <button id="detail-share" class="icon-btn" aria-label="Share" title="Share">↗</button>
        <button id="detail-close" class="icon-btn" aria-label="Close">✕</button>
      </div>
    </div>

    ${open ? `<div class="open-badge ${open.startsWith('Open') ? 'is-open' : 'is-closed'}" title="Estimated from listed opening hours, which may be outdated">${open.startsWith('Open') ? '🟢' : '🔴'} ${esc(open)}<span class="open-approx"> · approx</span></div>` : ''}

    <div id="consensus" class="consensus">
      <span class="badge" style="background:${AC_COLORS[baseKey]}">${AC_LABELS[baseKey]}</span>
      <span class="consensus-note">Listed status${
        v.ac?.evidence ? ' · ' + esc(v.ac.evidence) : ''
      }</span>
    </div>

    ${v.address || v.postcode ? `<div class="detail-row">📍 ${esc([v.address, v.postcode].filter(Boolean).join(', '))}</div>` : ''}
    ${
      v.opening_hours
        ? `<div class="detail-row">🕑 ${esc(v.opening_hours)}<div class="hours-note muted">Hours via OpenStreetMap — may be outdated.${osmU ? ` <a href="${osmU}" target="_blank" rel="noopener">edit on OSM</a>` : ''}</div></div>`
        : osmU
          ? `<div class="detail-row muted">🕑 No hours listed.<span class="hours-note muted"> <a href="${osmU}" target="_blank" rel="noopener">add on OSM</a></span></div>`
          : ''
    }
    ${v.website ? `<div class="detail-row">🔗 <a href="${esc(v.website)}" target="_blank" rel="noopener">Website</a></div>` : ''}
    <div class="detail-row directions-row">
      <span class="directions-label">↗ Directions</span>
      <div class="map-links">
        ${mapLinks(v)
          .map((l) => `<a class="map-link" target="_blank" rel="noopener" href="${l.url}">${l.label}</a>`)
          .join('')}
      </div>
    </div>

    <div class="detail-row correct-row">
      <button id="detail-correct" type="button" class="correct-link">✎ Suggest a correction</button>
    </div>

    <div class="vote-block">
      <h3>Is it actually cold?</h3>
      <div class="vote-grid" id="vote-grid">
        <button class="vote-btn" data-choice="cold">❄️ Cold</button>
        <button class="vote-btn" data-choice="mild">🌬️ Mild</button>
        <button class="vote-btn" data-choice="none">🔥 No AC</button>
        <button class="vote-btn" data-choice="unsure">🤷 Unsure</button>
      </div>
      <div id="vote-tally" class="vote-tally"></div>
    </div>

    <div class="tag-block">
      <h3>Tags</h3>
      <div id="tag-current" class="tag-current"></div>
      <div id="tag-add" class="tag-add"></div>
    </div>
  `;

  panel.querySelector('#detail-close').addEventListener('click', closeDetail);
  panel.querySelector('#detail-share').addEventListener('click', () => shareVenue(v));
  panel.querySelector('#detail-correct').addEventListener('click', () => suggestCorrection(v));
  wireVoteButtons(v);
  wireTagButtons(v);
  highlightLocalVote(v.id);

  // lazy-load aggregates (votes + tags)
  if (supabaseEnabled) {
    try {
      const agg = state.aggCache.get(id) || (await fetchVenueAggregates(id));
      state.aggCache.set(id, agg);
      renderConsensus(v, agg);
      renderTally(agg);
      renderTags(agg);
    } catch (err) {
      console.warn('aggregate fetch failed', err);
    }
  } else {
    $('#vote-tally').innerHTML = '<span class="muted">Voting needs Supabase configured — see README.</span>';
  }
}

function renderConsensus(v, agg) {
  const s = displayedStatus(v, agg);
  const el = $('#consensus');
  if (!el) return;
  const note =
    s.source === 'votes'
      ? `Community consensus · ${s.total} vote${s.total === 1 ? '' : 's'}`
      : `Listed status${v.ac?.evidence ? ' · ' + esc(v.ac.evidence) : ''}`;
  el.innerHTML = `<span class="badge" style="background:${s.color}">${s.label}</span><span class="consensus-note">${note}</span>`;
}

function renderTally(agg) {
  const el = $('#vote-tally');
  if (!el) return;
  if (!agg || !agg.total) {
    el.innerHTML = '<span class="muted">No votes yet — be the first.</span>';
    return;
  }
  const labels = { cold: '❄️ Cold', mild: '🌬️ Mild', none: '🔥 No AC', unsure: '🤷 Unsure' };
  el.innerHTML = Object.entries(agg.votes)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `<span class="tally-chip">${labels[k]} ${n}</span>`)
    .join('');
}

function renderTags(agg) {
  const el = $('#tag-current');
  if (!el) return;
  const tags = agg?.tags || {};
  const entries = Object.entries(tags).sort((a, b) => b[1] - a[1]);
  el.innerHTML = entries.length
    ? entries.map(([t, n]) => `<span class="tag-chip">${esc(t)} ${n > 1 ? '·' + n : ''}</span>`).join('')
    : '<span class="muted">No tags yet.</span>';
}

function wireVoteButtons(v) {
  $('#vote-grid')?.querySelectorAll('.vote-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const choice = btn.dataset.choice;
      $('#vote-grid').querySelectorAll('.vote-btn').forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
      // optimistic local tally bump
      const agg = state.aggCache.get(v.id) || { votes: { cold: 0, mild: 0, none: 0, unsure: 0 }, total: 0, tags: {} };
      const prev = getLocalVote(v.id);
      if (prev && prev !== choice && agg.votes[prev] > 0) {
        agg.votes[prev]--;
      } else if (!prev) {
        agg.total++;
      }
      if (!prev || prev !== choice) agg.votes[choice]++;
      state.aggCache.set(v.id, agg);
      renderTally(agg);
      renderConsensus(v, agg);
      // let the user's vote recolour the pin/list if it now hits consensus (≥3)
      setConsensusOne(v.id, consensusKeyFromAgg(agg));
      refresh();
      maybeShareNudge(); // gentle once-per-session share prompt
      try {
        await castVote(v.id, choice);
      } catch (err) {
        console.warn('vote failed', err);
        toast('Could not save vote');
      }
    });
  });
}

function wireTagButtons(v) {
  const add = $('#tag-add');
  if (!add) return;
  add.innerHTML = TAG_OPTIONS.map(
    (t) => `<button class="tag-option" data-tag="${t}">+ ${t}</button>`
  ).join('');
  add.querySelectorAll('.tag-option').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const tag = btn.dataset.tag;
      btn.disabled = true;
      const agg = state.aggCache.get(v.id) || { votes: {}, total: 0, tags: {} };
      agg.tags[tag] = (agg.tags[tag] || 0) + 1;
      state.aggCache.set(v.id, agg);
      renderTags(agg);
      try {
        await addTag(v.id, tag);
      } catch (err) {
        console.warn('tag failed', err);
        toast('Could not save tag');
      }
    });
  });
}

function highlightLocalVote(id) {
  const prev = getLocalVote(id);
  if (!prev) return;
  $('#vote-grid')?.querySelector(`[data-choice="${prev}"]`)?.classList.add('selected');
}

function closeDetail() {
  $('#detail').classList.remove('open');
  document.body.classList.remove('detail-open');
  MapView.clearHighlight();
  state.currentId = null;
  history.replaceState(null, '', location.pathname + location.search);
}

// "Suggest a correction" — its own focused sheet (not the About info sheet), so
// anyone (not just OSM editors) can report wrong hours/AC/closed-down etc.
function suggestCorrection(v) {
  correctingVenue = v;
  closeDetail();
  $('#correct-venue').textContent = v.name;
  $('#correct-form').reset();
  $('#correct-status').textContent = supabaseEnabled ? '' : 'Needs Supabase configured to send.';
  $('#correct-backdrop').hidden = false;
  $('#correct-form [name="message"]').focus();
}
function closeCorrection() {
  $('#correct-backdrop').hidden = true;
}
async function onCorrectSubmit(e) {
  e.preventDefault();
  const form = e.target;
  const btn = $('#correct-submit');
  const status = $('#correct-status');
  const data = Object.fromEntries(new FormData(form));
  const msg = (data.message || '').trim();
  if (!msg || !correctingVenue) return;
  btn.disabled = true;
  status.textContent = 'Sending…';
  try {
    const res = await submitFeedback({
      message: `Correction — ${correctingVenue.name} (${correctingVenue.id}): ${msg}`,
      email: (data.email || '').trim(),
    });
    if (res.offline) {
      status.textContent = 'Supabase not configured — not sent.';
    } else {
      form.reset();
      closeCorrection();
      toast('Thanks — correction sent!');
    }
  } catch (err) {
    console.warn('correction failed', err);
    status.textContent = 'Could not send — please try again.';
  } finally {
    btn.disabled = false;
  }
}

// gentle, once-per-session nudge to share the app, right after a vote (high intent)
function maybeShareNudge() {
  if (sharePrompted) return;
  const tally = $('#vote-tally');
  if (!tally) return;
  sharePrompted = true;
  const n = document.createElement('div');
  n.className = 'share-nudge';
  n.innerHTML = `🙌 Thanks! Know someone who'd find this handy? <button type="button" class="share-nudge__btn">Share Cool Spots ❄️</button>`;
  n.querySelector('.share-nudge__btn').addEventListener('click', shareApp);
  tally.after(n);
}

// Share the whole app (native share sheet on mobile, copy-link fallback).
async function shareApp() {
  const url = location.origin + '/';
  const data = {
    title: 'Cool Spots London ❄️',
    text: 'Find London pubs, cafés, bars & public spaces with air conditioning — beat the heat.',
    url,
  };
  try {
    if (navigator.share) await navigator.share(data);
    else {
      await navigator.clipboard.writeText(url);
      toast('Link copied — share it!');
    }
  } catch (err) {
    if (err?.name !== 'AbortError') {
      try { await navigator.clipboard.writeText(url); toast('Link copied'); }
      catch { toast('Could not share'); }
    }
  }
}

async function shareVenue(v) {
  const url = `${location.origin}${location.pathname}#v=${encodeURIComponent(v.id)}`;
  const data = { title: `${v.name} — Cool Spots London`, text: `${v.name} on Cool Spots London`, url };
  try {
    if (navigator.share) {
      await navigator.share(data);
    } else {
      await navigator.clipboard.writeText(url);
      toast('Link copied');
    }
  } catch (err) {
    if (err?.name !== 'AbortError') {
      try { await navigator.clipboard.writeText(url); toast('Link copied'); }
      catch { toast('Could not share'); }
    }
  }
}

// --- controls ---------------------------------------------------------------
function wireControls() {
  wireSearch();

  // type filters
  document.querySelectorAll('input[data-type]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const type = cb.dataset.type;
      if (cb.checked) state.filters.types.add(type);
      else state.filters.types.delete(type);
      refresh();
    });
  });

  // AC status filter
  document.querySelectorAll('input[name="ac"]').forEach((r) => {
    r.addEventListener('change', () => {
      if (r.checked) {
        state.filters.ac = r.value;
        refresh();
      }
    });
  });

  // hide chains
  $('#hide-chains').addEventListener('change', (e) => {
    state.filters.hideChains = e.target.checked;
    refresh();
  });

  // open now
  $('#open-now').addEventListener('change', (e) => {
    state.filters.openNow = e.target.checked;
    refresh();
  });

  // brand = back to start; ⓘ = about / contact
  $('#brand').addEventListener('click', goHome);
  $('#btn-about').addEventListener('click', openAbout);
  $('#about-close').addEventListener('click', closeAbout);
  $('#about-backdrop').addEventListener('click', (e) => {
    if (e.target.id === 'about-backdrop') closeAbout();
  });
  $('#about-share').addEventListener('click', () => {
    closeAbout();
    shareApp();
  });
  $('#about-suggest').addEventListener('click', () => {
    closeAbout();
    openSuggest();
  });
  $('#about-install').addEventListener('click', () => {
    closeAbout();
    triggerInstall();
  });
  // install banner + iOS instructions sheet
  $('#install-cta').addEventListener('click', () => {
    hideInstallBanner(true);
    triggerInstall();
  });
  $('#install-dismiss').addEventListener('click', () => hideInstallBanner(true));
  $('#ios-install-close').addEventListener('click', () => ($('#ios-install').hidden = true));
  $('#ios-install').addEventListener('click', (e) => {
    if (e.target.id === 'ios-install') $('#ios-install').hidden = true;
  });
  $('#feedback-form').addEventListener('submit', onFeedbackSubmit);

  // suggest-a-correction (per-venue) sheet
  $('#correct-close').addEventListener('click', closeCorrection);
  $('#correct-backdrop').addEventListener('click', (e) => {
    if (e.target.id === 'correct-backdrop') closeCorrection();
  });
  $('#correct-form').addEventListener('submit', onCorrectSubmit);

  // suggest a place (floating button)
  $('#fab-suggest').addEventListener('click', openSuggest);
  $('#suggest-close').addEventListener('click', closeSuggest);
  $('#suggest-backdrop').addEventListener('click', (e) => {
    if (e.target.id === 'suggest-backdrop') closeSuggest();
  });
  $('#suggest-form').addEventListener('submit', onSuggestSubmit);

  // close the filters panel on outside-click / Escape
  document.addEventListener('click', (e) => {
    const filters = $('#filters');
    if (
      filters.classList.contains('open') &&
      !filters.contains(e.target) &&
      !$('#btn-filters').contains(e.target)
    ) {
      filters.classList.remove('open');
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    closeAutocomplete();
    if (!$('#ios-install').hidden) $('#ios-install').hidden = true;
    else if (!$('#correct-backdrop').hidden) closeCorrection();
    else if (!$('#about-backdrop').hidden) closeAbout();
    else if (!$('#suggest-backdrop').hidden) closeSuggest();
    else if ($('#filters').classList.contains('open')) $('#filters').classList.remove('open');
    else if ($('#detail').classList.contains('open')) closeDetail();
  });

  // panel toggles
  $('#btn-filters').addEventListener('click', () => $('#filters').classList.toggle('open'));
  $('#btn-list').addEventListener('click', () => togglePanel('#list-panel'));
  $('#list-close').addEventListener('click', () => $('#list-panel').classList.remove('open'));

  // geolocation
  $('#btn-locate').addEventListener('click', locate);
}

// --- search + autocomplete --------------------------------------------------
function buildVenueMatches(q) {
  q = q.toLowerCase();
  const starts = [];
  const incl = [];
  for (const v of allVenues()) {
    const n = v.name.toLowerCase();
    const i = n.indexOf(q);
    if (i === 0) starts.push(v);
    else if (i > 0 && incl.length < 8) incl.push(v);
    if (starts.length >= 8) break;
  }
  return (starts.length >= 8 ? starts : starts.concat(incl)).slice(0, 6);
}

// area / neighbourhood matches (jump-to), from the OSM gazetteer in areas.json
function buildAreaMatches(q) {
  if (!state.areas.length) return [];
  q = q.toLowerCase();
  const starts = [];
  const incl = [];
  for (const a of state.areas) {
    const n = a.name.toLowerCase();
    const i = n.indexOf(q);
    if (i === 0) starts.push(a);
    else if (i > 0 && incl.length < 3) incl.push(a);
    if (starts.length >= 3) break;
  }
  return (starts.length >= 3 ? starts : starts.concat(incl)).slice(0, 3);
}

function wireSearch() {
  const input = $('#search');
  const box = $('#search-suggest');
  let debounce;
  let items = [];
  let active = -1;

  const close = () => {
    box.hidden = true;
    box.innerHTML = '';
    input.setAttribute('aria-expanded', 'false');
    active = -1;
  };
  closeAutocomplete = close;

  const choose = (item) => {
    if (!item) return;
    state.filters.query = '';
    if (item.type === 'area') {
      input.value = item.data.name;
      refresh(); // show all venues again, then fly to the area
      close();
      MapView.flyToArea(item.data);
    } else {
      input.value = item.data.name;
      refresh(); // clear search-narrowing so the picked venue isn't isolated
      close();
      openDetail(item.data.id);
    }
  };

  const paintActive = () =>
    box.querySelectorAll('.suggest-item').forEach((li, i) => li.classList.toggle('active', i === active));

  const render = (q) => {
    if (!q) return close();
    // areas first (jump-to), then venues
    const areas = buildAreaMatches(q).map((a) => ({ type: 'area', data: a }));
    const venues = buildVenueMatches(q).map((v) => ({ type: 'venue', data: v }));
    items = [...areas, ...venues];
    active = -1;
    if (!items.length) {
      box.innerHTML = '<li class="suggest-empty">No matches — tap ＋ to suggest a place.</li>';
    } else {
      box.innerHTML = items
        .map((it, i) => {
          if (it.type === 'area') {
            const a = it.data;
            return `<li class="suggest-item suggest-item--area" role="option" data-i="${i}">
              <span class="suggest-pin">📍</span>
              <div class="suggest-item__body">
                <div class="suggest-item__name">${esc(a.name)}</div>
                <div class="suggest-item__meta">${capitalize(a.kind)} · area</div>
              </div></li>`;
          }
          const v = it.data;
          const k = v.ac?.status || 'unknown';
          return `<li class="suggest-item" role="option" data-i="${i}">
            <span class="dot" style="background:${AC_COLORS[k]}"></span>
            <div class="suggest-item__body">
              <div class="suggest-item__name">${esc(v.name)}</div>
              <div class="suggest-item__meta">${typeLabel(v.type)} · ${AC_LABELS[k]}${v.postcode ? ' · ' + esc(v.postcode) : ''}</div>
            </div></li>`;
        })
        .join('');
      box.querySelectorAll('.suggest-item').forEach((li) =>
        li.addEventListener('mousedown', (e) => {
          e.preventDefault(); // fire before the input's blur
          choose(items[+li.dataset.i]);
        })
      );
    }
    box.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  };

  input.addEventListener('input', (e) => {
    const val = e.target.value;
    render(val.trim());
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      state.filters.query = val.trim();
      refresh();
    }, 180);
  });
  input.addEventListener('focus', () => {
    if (input.value.trim()) render(input.value.trim());
  });
  input.addEventListener('blur', () => setTimeout(close, 150));
  input.addEventListener('keydown', (e) => {
    if (box.hidden) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      active = Math.min(active + 1, items.length - 1);
      paintActive();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      active = Math.max(active - 1, 0);
      paintActive();
    } else if (e.key === 'Enter') {
      if (!items.length) return;
      e.preventDefault();
      choose(active >= 0 ? items[active] : items[0]);
    } else if (e.key === 'Escape') {
      close();
    }
  });
}

function togglePanel(sel) {
  $(sel).classList.toggle('open');
  if ($(sel).classList.contains('open')) updateList();
}

function locate() {
  const btn = $('#btn-locate');
  if (!navigator.geolocation) return toast('Geolocation not supported');
  btn.classList.add('loading');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      btn.classList.remove('loading');
      const { latitude, longitude } = pos.coords;
      state.userLocation = { lat: latitude, lon: longitude };
      MapView.setUserLocation(latitude, longitude);
      setTimeout(updateList, 400);
    },
    (err) => {
      btn.classList.remove('loading');
      toast(err.code === 1 ? 'Location permission denied' : 'Could not get location');
    },
    { enableHighAccuracy: true, timeout: 8000 }
  );
}

function markUserLayerDisabled() {
  const note = $('#supabase-note');
  if (note) note.hidden = false;
}

// --- back to start (logo) ---------------------------------------------------
function goHome() {
  // reset filter state + the controls that reflect it
  state.filters = { types: new Set(['pub', 'bar', 'cafe', 'restaurant', 'museum']), ac: 'all', hideChains: false, openNow: false, query: '' };
  $('#search').value = '';
  document.querySelectorAll('input[data-type]').forEach((cb) => (cb.checked = true));
  document.querySelector('input[name="ac"][value="all"]').checked = true;
  $('#hide-chains').checked = false;
  $('#open-now').checked = false;
  // close everything that might be open
  closeAutocomplete();
  $('#filters').classList.remove('open');
  $('#list-panel').classList.remove('open');
  closeDetail();
  closeAbout();
  closeSuggest();
  // recenter the map and re-render
  MapView.resetView();
  refresh();
}

// --- about / contact --------------------------------------------------------
function openAbout() {
  $('#feedback-status').textContent = supabaseEnabled ? '' : 'Note: needs Supabase configured to send.';
  updateInstallUI();
  $('#about-backdrop').hidden = false;
}

// Show the right "add to home screen" affordance for the device.
function updateInstallUI() {
  const block = $('#install-block');
  const btn = $('#about-install');
  const hint = $('#install-hint');
  if (isStandalone()) {
    block.hidden = true; // already installed
    return;
  }
  block.hidden = false;
  if (deferredPrompt) {
    btn.hidden = false;
    btn.textContent = '📲 Add to Home Screen';
    hint.hidden = true;
  } else if (isIOS()) {
    btn.hidden = false;
    btn.textContent = '📲 How to install';
    hint.hidden = true;
  } else {
    btn.hidden = true;
    hint.hidden = false;
    hint.textContent = 'In your browser menu, choose “Install app” / “Add to Home Screen”.';
  }
}
function closeAbout() {
  $('#about-backdrop').hidden = true;
}
async function onFeedbackSubmit(e) {
  e.preventDefault();
  const form = e.target;
  const btn = $('#feedback-submit');
  const status = $('#feedback-status');
  const data = Object.fromEntries(new FormData(form));
  const message = (data.message || '').trim();
  if (!message) return;

  btn.disabled = true;
  status.textContent = 'Sending…';
  try {
    const res = await submitFeedback({ message, email: (data.email || '').trim() });
    if (res.offline) {
      status.textContent = 'Supabase not configured — message not sent.';
    } else {
      form.reset();
      closeAbout();
      toast('Thanks for the feedback!');
    }
  } catch (err) {
    console.warn('feedback failed', err);
    status.textContent = 'Could not send — please try again.';
  } finally {
    btn.disabled = false;
  }
}

// --- suggest a place --------------------------------------------------------
function openSuggest() {
  $('#filters').classList.remove('open');
  const status = $('#suggest-status');
  status.textContent = supabaseEnabled
    ? ''
    : 'Note: needs Supabase configured to submit.';
  $('#suggest-backdrop').hidden = false;
}
function closeSuggest() {
  $('#suggest-backdrop').hidden = true;
}
async function onSuggestSubmit(e) {
  e.preventDefault();
  const form = e.target;
  const submitBtn = $('#suggest-submit');
  const status = $('#suggest-status');
  const data = Object.fromEntries(new FormData(form));

  const payload = {
    name: (data.name || '').trim(),
    type: data.type,
    address: (data.address || '').trim(),
    ac_hint: data.ac_hint || null,
    note: (data.note || '').trim(),
  };
  if (data.useloc) {
    const c = MapView.getCenter();
    payload.lat = c.lat;
    payload.lon = c.lon;
  }
  if (!payload.name) return;

  submitBtn.disabled = true;
  status.textContent = 'Submitting…';
  try {
    const res = await submitSuggestion(payload);
    if (res.offline) {
      status.textContent = 'Saved locally — Supabase not configured, so it was not sent.';
    } else {
      form.reset();
      closeSuggest();
      toast('Thanks! Suggestion sent for review.');
    }
  } catch (err) {
    console.warn('suggestion failed', err);
    status.textContent = 'Could not submit — please try again.';
  } finally {
    submitBtn.disabled = false;
  }
}

// --- directions: deep links to the user's map app (no API, no cost) ---------
function mapLinks(v) {
  const { lat, lon } = v;
  const name = encodeURIComponent(v.name);
  const apple = { label: 'Apple Maps', url: `https://maps.apple.com/?daddr=${lat},${lon}&q=${name}` };
  const google = { label: 'Google Maps', url: `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}` };
  const citymapper = { label: 'Citymapper', url: `https://citymapper.com/directions?endcoord=${lat},${lon}&endname=${name}` };
  const osm = { label: 'OpenStreetMap', url: `https://www.openstreetmap.org/directions?to=${lat}%2C${lon}` };

  const ua = navigator.userAgent || '';
  const isApple = /iPhone|iPad|iPod|Macintosh/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  // device default first, then the others (Citymapper always offered — it's London)
  return isApple ? [apple, google, citymapper, osm] : [google, apple, citymapper, osm];
}

// --- utils ------------------------------------------------------------------
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function capitalize(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
function typeLabel(t) {
  return TYPE_LABELS[t] || capitalize(t);
}
// OSM page for a venue (to verify/edit hours); null for user/suggestion venues
function osmUrl(v) {
  const m = String(v.id).match(/^(node|way|relation)\/(\d+)$/);
  return m ? `https://www.openstreetmap.org/${m[1]}/${m[2]}` : null;
}
let toastTimer;
function toast(msg) {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

boot();
