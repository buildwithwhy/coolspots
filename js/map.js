// MapLibre map: OpenFreeMap tiles + clustered, AC-colour-coded venue markers.

import { MAP_STYLE, LONDON_CENTER, DEFAULT_ZOOM, AC_COLORS } from './config.js';

let map;
let userMarker = null;
let selectedMarker = null;

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
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 5, 15, 8, 18, 11],
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 1.5,
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
