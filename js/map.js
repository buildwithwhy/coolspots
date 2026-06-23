// MapLibre map: OpenFreeMap tiles + clustered, AC-colour-coded venue markers.

import { MAP_STYLE, LONDON_CENTER, DEFAULT_ZOOM, AC_COLORS } from './config.js';

let map;
let userMarker = null;
let selectedMarker = null;

// venue dot sizes — bumped when a search is active so matches pop
const RADIUS = {
  normal: ['interpolate', ['linear'], ['zoom'], 11, 6, 15, 9, 18, 13],
  search: ['interpolate', ['linear'], ['zoom'], 10, 8, 14, 12, 18, 17],
};

// circle-color expression keyed on the feature's acStatus property
const statusColorExpr = [
  'match',
  ['get', 'acStatus'],
  'yes', AC_COLORS.yes,
  'likely', AC_COLORS.likely,
  'no', AC_COLORS.no,
  AC_COLORS.unknown, // default → unknown
];

export function initMap({ onVenueClick, onMoveEnd }) {
  map = new maplibregl.Map({
    container: 'map',
    style: MAP_STYLE,
    center: LONDON_CENTER,
    zoom: DEFAULT_ZOOM,
    attributionControl: { compact: true },
  });

  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

  map.on('load', () => {
    map.addSource('venues', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
      cluster: true,
      clusterRadius: 55,
      clusterMaxZoom: 14,
    });

    // clusters
    map.addLayer({
      id: 'clusters',
      type: 'circle',
      source: 'venues',
      filter: ['has', 'point_count'],
      paint: {
        'circle-color': '#0ea5e9',
        'circle-opacity': 0.85,
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2,
        'circle-radius': ['step', ['get', 'point_count'], 16, 25, 22, 100, 28, 500, 36],
      },
    });
    map.addLayer({
      id: 'cluster-count',
      type: 'symbol',
      source: 'venues',
      filter: ['has', 'point_count'],
      layout: {
        'text-field': ['get', 'point_count_abbreviated'],
        'text-font': ['Noto Sans Bold'],
        'text-size': 13,
      },
      paint: { 'text-color': '#ffffff' },
    });

    // individual venues
    map.addLayer({
      id: 'venue-points',
      type: 'circle',
      source: 'venues',
      filter: ['!', ['has', 'point_count']],
      paint: {
        'circle-color': statusColorExpr,
        'circle-radius': RADIUS.normal,
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2,
        'circle-opacity': 0.95,
      },
    });

    // interactions
    map.on('click', 'clusters', (e) => {
      const f = map.queryRenderedFeatures(e.point, { layers: ['clusters'] })[0];
      const clusterId = f.properties.cluster_id;
      map.getSource('venues').getClusterExpansionZoom(clusterId).then((zoom) => {
        map.easeTo({ center: f.geometry.coordinates, zoom });
      });
    });

    map.on('click', 'venue-points', (e) => {
      const id = e.features[0].properties.id;
      if (onVenueClick) onVenueClick(id, e.features[0].geometry.coordinates);
    });

    for (const layer of ['clusters', 'venue-points']) {
      map.on('mouseenter', layer, () => (map.getCanvas().style.cursor = 'pointer'));
      map.on('mouseleave', layer, () => (map.getCanvas().style.cursor = ''));
    }

    map.on('moveend', () => onMoveEnd && onMoveEnd());

    // signal ready
    map.fire('cool:ready');
  });

  return map;
}

export function onReady(cb) {
  if (map.isStyleLoaded() && map.getSource('venues')) cb();
  else map.once('cool:ready', cb);
}

export function setData(geojson) {
  const src = map.getSource('venues');
  if (src) src.setData(geojson);
}

// enlarge + ring the dots while a search is active so matches stand out
let searchActive = false;
export function setSearchActive(active) {
  if (active === searchActive || !map.getLayer('venue-points')) return;
  searchActive = active;
  map.setPaintProperty('venue-points', 'circle-radius', active ? RADIUS.search : RADIUS.normal);
  map.setPaintProperty('venue-points', 'circle-stroke-color', active ? '#0369a1' : '#ffffff');
  map.setPaintProperty('venue-points', 'circle-stroke-width', active ? 2.5 : 2);
}

// frame a set of venues (used to zoom to search results)
export function fitToVenues(venues) {
  if (!venues.length) return;
  if (venues.length === 1) {
    map.easeTo({ center: [venues[0].lon, venues[0].lat], zoom: 16, duration: 600 });
    return;
  }
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (const v of venues) {
    minLon = Math.min(minLon, v.lon); maxLon = Math.max(maxLon, v.lon);
    minLat = Math.min(minLat, v.lat); maxLat = Math.max(maxLat, v.lat);
  }
  map.fitBounds([[minLon, minLat], [maxLon, maxLat]], { padding: 70, maxZoom: 15, duration: 600 });
}

export function getMap() {
  return map;
}

export function getCenter() {
  const c = map.getCenter();
  return { lat: c.lat, lon: c.lng };
}

// venues whose coords fall in the current viewport
export function venuesInView(venues) {
  const b = map.getBounds();
  return venues.filter(
    (v) => v.lon >= b.getWest() && v.lon <= b.getEast() && v.lat >= b.getSouth() && v.lat <= b.getNorth()
  );
}

export function flyToVenue(v) {
  map.flyTo({ center: [v.lon, v.lat], zoom: Math.max(map.getZoom(), 16), speed: 1.2 });
  highlight(v);
}

function highlight(v) {
  if (selectedMarker) selectedMarker.remove();
  const el = document.createElement('div');
  el.className = 'selected-pin';
  selectedMarker = new maplibregl.Marker({ element: el, anchor: 'center' })
    .setLngLat([v.lon, v.lat])
    .addTo(map);
}

export function clearHighlight() {
  if (selectedMarker) {
    selectedMarker.remove();
    selectedMarker = null;
  }
}

export function setUserLocation(lat, lon, { fly = true } = {}) {
  if (userMarker) userMarker.remove();
  const el = document.createElement('div');
  el.className = 'user-pin';
  el.innerHTML = '<div class="user-pin__dot"></div><div class="user-pin__pulse"></div>';
  userMarker = new maplibregl.Marker({ element: el, anchor: 'center' })
    .setLngLat([lon, lat])
    .addTo(map);
  if (fly) map.flyTo({ center: [lon, lat], zoom: 15, speed: 1.2 });
}
