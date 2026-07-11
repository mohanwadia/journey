/* Melbourne Bus Reform — Sketch Router
 * Loads the static graph.json produced by preprocess.py and runs a
 * client-side Dijkstra between two user-clicked points. No backend.
 */

const WALK_SPEED_M_PER_MIN = 80;      // must match preprocess.py's constant
const MAX_WALK_TO_STOP_M = 5000;       // how far we'll look for a boarding/alighting stop
const NEAREST_STOP_CANDIDATES = 4;    // don't just take the closest stop — give the router options

// Map styling
const NON_RIDE_LINE_COLOR = '#333434';
const NON_RIDE_LINE_WEIGHT = 5;
const RIDE_LINE_WEIGHT = 6;
const RIDE_COLOR_B1 = '#D92B26';
const RIDE_COLOR_B2 = '#F1B80E';
const RIDE_COLOR_RAIL = '#0072CE';
const RIDE_COLOR_DEFAULT = '#ff8200';
const RIDE_COLOR_SRL = '#008746';
const RIDE_COLOR_TRAM = '#91DE56';
const RIDE_COLOR_EXIST_BUS = '#ff8200'; // must match EXIST_BUS_COLOR in preprocess.py

// Muted/duller version of a bright hex color, used for the background route
// lines shown before the person has clicked anything - blends toward a
// neutral grey and drops saturation/opacity so the active-route colors pop
// by comparison once a trip is drawn.
function dullColor(hex, mixWithGrey = 0.55) {
  const grey = { r: 0x9a, g: 0x97, b: 0x8f }; // matches --muted-ish tone
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  const mix = (c, gc) => Math.round(c + (gc - c) * mixWithGrey);
  const rr = mix(r, grey.r), gg = mix(g, grey.g), bb = mix(b, grey.b);
  return `#${[rr, gg, bb].map(v => v.toString(16).padStart(2, '0')).join('')}`;
}
const BOARD_ALIGHT_RADIUS = RIDE_LINE_WEIGHT / 2;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let graph = null;               // raw graph.json
let baseAdj = new Map();        // nodeId -> [edge, ...]
let hubInNodes = [];            // [{id, lat, lon}, ...]
let hubOutNodes = [];
let stopRoutes = new Map();     // stop_id -> Set(route_id)  (for itinerary labels)
let stopNames = new Map();      // stop_id -> "Cross St / Main Rd"  (optional, from geocode_stop_names.py)
let stopMarkersLayer = null;    // small dots showing named stops, visible when zoomed in

let originLatLng = null;
let destLatLng = null;
let originMarker = null;
let destMarker = null;
let pathLayer = null;

let srlEnabled = true;          // whether Suburban Rail Loop edges/lines are usable & shown
let srlRouteLayer = null;       // the SRL line geometry (toggled on/off the map)
let srlStopMarkers = [];        // SRL station dot markers (added/removed from stopMarkersLayer)

let busReformEnabled = true;        // true = reform bus network (B1/B2) usable & shown;
                                     // false = existing metro bus network (EXIST_BUS) instead.
                                     // The two are mutually exclusive, unlike the SRL on/off toggle.
let reformBusLayer = null;          // hand-drawn reform bus route lines
let existingBusLayer = null;        // real GTFS existing bus route lines
let reformBusStopMarkers = [];      // stop dots that belong only to the reform network
let existingBusStopMarkers = [];    // stop dots that belong only to the existing network

// The four network combinations shown side-by-side on the Journey tab.
// Order matters: this is the display order requested — Current, Bus Reform, SRL, Both.
const JOURNEY_COMBOS = [
  { key: 'current', label: 'Current', srl: false, busReform: false },
  { key: 'busReform', label: 'Bus Reform', srl: false, busReform: true },
  { key: 'srl', label: 'SRL', srl: true, busReform: false },
  { key: 'both', label: 'Both', srl: true, busReform: true },
];
let journeyCombo = 'current';   // which of JOURNEY_COMBOS is currently shown on the map/itinerary
let journeyResults = {};        // combo key -> findRoute() result (or null if no route for that combo)

let currentTab = 'journey';     // 'journey' | 'isochrone'
let mobileDetailsOpen = false;  // mobile-only: true when the itinerary is showing in place of the map
let isoLayer = null;            // layered walking-radius circles
let isoMarker = null;           // marker at the clicked isochrone origin
let isoOriginLatLng = null;     // clicked point the isochrone was computed from

const map = L.map('map', { zoomControl: true });

L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
  subdomains: 'abcd',
  maxZoom: 20,
}).addTo(map);

// ---------------------------------------------------------------------------
// Load data
// ---------------------------------------------------------------------------

Promise.all([
  fetch('data/graph.json').then(r => r.json()),
  fetch('data/routes.geojson').then(r => r.json()),
  fetch('data/stop_names.json').then(r => r.ok ? r.json() : {}).catch(() => ({})),
]).then(([graphData, routesGeojson, stopNamesData]) => {
  graph = graphData;
  stopNames = new Map(Object.entries(stopNamesData));

  srlEnabled = new URLSearchParams(window.location.search).get('srl') !== '0';
  const srlToggle = document.getElementById('srl-toggle');
  if (srlToggle) srlToggle.checked = srlEnabled;

  busReformEnabled = new URLSearchParams(window.location.search).get('busReform') !== '0';
  const busReformToggle = document.getElementById('bus-reform-toggle');
  if (busReformToggle) busReformToggle.checked = busReformEnabled;

  buildAdjacency();
  buildStopIndex();
  renderRouteLines(routesGeojson);
  renderStopMarkers();
  map.on('click', onMapClick);
  loadFromURL();
}).catch(err => {
  document.getElementById('instruction-text').textContent =
    'Could not load network data — check the console. If you opened this file directly, ' +
    'you need to run it through a local server (e.g. `python3 -m http.server`) since ' +
    'browsers block fetch() on file:// paths.';
  console.error(err);
});

function buildAdjacency() {
  for (const [id, n] of Object.entries(graph.nodes)) {
    if (n.type === 'hub_in') hubInNodes.push({ id, lat: n.lat, lon: n.lon });
    if (n.type === 'hub_out') hubOutNodes.push({ id, lat: n.lat, lon: n.lon });
  }
  rebuildAdjacency();
}

function routeCorridor(routeId) {
  const meta = graph.routes && graph.routes[routeId];
  return meta ? meta.corridor : null;
}
function isReformBusCorridor(c) { return c === 'B1' || c === 'B2'; }
function isExistingBusCorridor(c) { return c === 'EXIST_BUS'; }

// Rebuilds the routing edge index from scratch, skipping SRL edges when the
// line is toggled off, and skipping whichever bus network (reform vs
// existing) isn't currently selected. Cheap enough to call on every toggle —
// the graph is small — and simpler than patching a live adjacency map in place.
function rebuildAdjacency() {
  baseAdj = new Map();
  for (const e of graph.edges) {
    if (!srlEnabled && e.route === 'RAIL:SRL') continue;
    if (e.route) {
      const corridor = routeCorridor(e.route);
      if (busReformEnabled && isExistingBusCorridor(corridor)) continue;
      if (!busReformEnabled && isReformBusCorridor(corridor)) continue;
    }
    if (!baseAdj.has(e.from)) baseAdj.set(e.from, []);
    baseAdj.get(e.from).push(e);
  }
}

function buildStopIndex() {
  for (const n of Object.values(graph.nodes)) {
    if (n.type === 'route') {
      if (!stopRoutes.has(n.stop_id)) stopRoutes.set(n.stop_id, new Set());
      stopRoutes.get(n.stop_id).add(n.route);
    }
  }
}

function renderStopMarkers() {
  stopMarkersLayer = L.layerGroup();
  srlStopMarkers = [];
  reformBusStopMarkers = [];
  existingBusStopMarkers = [];
  for (const [stopId, name] of stopNames.entries()) {
    // any hub_in node for this stop gives us its coordinates
    const node = Object.values(graph.nodes).find(n => n.stop_id === stopId && n.type === 'hub_in');
    if (!node) continue;
    const marker = L.circleMarker([node.lat, node.lon], {
      radius: 3, weight: 1, color: '#1a1d1f', fillColor: '#f7f6f3', fillOpacity: 1,
    }).bindPopup(name);

    // Classify by the corridor(s) actually serving this stop, so a stop only
    // gets hidden with a bus network if EVERY route through it belongs to
    // that network (an interchange with rail/tram should stay visible).
    const corridors = new Set();
    const routesHere = stopRoutes.get(stopId);
    if (routesHere) for (const r of routesHere) corridors.add(routeCorridor(r));
    const corridorList = [...corridors];
    const isReformBusOnly = corridorList.length > 0 && corridorList.every(isReformBusCorridor);
    const isExistingBusOnly = corridorList.length > 0 && corridorList.every(isExistingBusCorridor);

    if (stopId.startsWith('SRL_S') || corridors.has('SRL')) {
      srlStopMarkers.push(marker);
      if (srlEnabled) stopMarkersLayer.addLayer(marker);
    } else if (isReformBusOnly) {
      reformBusStopMarkers.push(marker);
      if (busReformEnabled) stopMarkersLayer.addLayer(marker);
    } else if (isExistingBusOnly) {
      existingBusStopMarkers.push(marker);
      if (!busReformEnabled) stopMarkersLayer.addLayer(marker);
    } else {
      stopMarkersLayer.addLayer(marker);
    }
  }

  const STOP_MARKER_MIN_ZOOM = 15;
  const updateVisibility = () => {
    if (map.getZoom() >= STOP_MARKER_MIN_ZOOM) {
      if (!map.hasLayer(stopMarkersLayer)) stopMarkersLayer.addTo(map);
    } else {
      if (map.hasLayer(stopMarkersLayer)) map.removeLayer(stopMarkersLayer);
    }
  };
  map.on('zoomend', updateVisibility);
  updateVisibility();
}

function routeLineStyle(feature) {
  const corridor = feature.properties.corridor;
  if (corridor === 'RAIL') {
    const base = feature.properties.color || RIDE_COLOR_RAIL;
    return { color: dullColor(base), weight: 5, opacity: 0.75 };
  }
  if (corridor === 'SRL') {
    const base = feature.properties.color || RIDE_COLOR_SRL;
    return { color: dullColor(base), weight: 5, opacity: 0.75 };
  }
  if (corridor === 'TRAM') {
    const base = feature.properties.color || RIDE_COLOR_TRAM;
    return { color: dullColor(base), weight: 3.5, opacity: 0.75 };
  }
  if (corridor === 'EXIST_BUS') {
    const base = feature.properties.color || RIDE_COLOR_EXIST_BUS;
    return { color: dullColor(base), weight: 2.5, opacity: 0.6 };
  }
  const isB1 = corridor === 'B1';
  return {
    color: dullColor(isB1 ? RIDE_COLOR_B1 : RIDE_COLOR_B2),
    weight: isB1 ? 3 : 2.2,
    opacity: isB1 ? 0.75 : 0.55,
  };
}

function renderRouteLines(routesGeojson) {
  const toggledCorridors = ['SRL', 'B1', 'B2', 'EXIST_BUS'];
  const srlFeatures = routesGeojson.features.filter((f) => f.properties.corridor === 'SRL');
  const reformBusFeatures = routesGeojson.features.filter((f) => isReformBusCorridor(f.properties.corridor));
  const existingBusFeatures = routesGeojson.features.filter((f) => isExistingBusCorridor(f.properties.corridor));
  const otherFeatures = routesGeojson.features.filter((f) => !toggledCorridors.includes(f.properties.corridor));

  L.geoJSON({ type: 'FeatureCollection', features: otherFeatures }, {
    interactive: false, // let clicks pass through to the map
    style: routeLineStyle,
  }).addTo(map);

  reformBusLayer = L.geoJSON({ type: 'FeatureCollection', features: reformBusFeatures }, {
    interactive: false,
    style: routeLineStyle,
  });
  existingBusLayer = L.geoJSON({ type: 'FeatureCollection', features: existingBusFeatures }, {
    interactive: false,
    style: routeLineStyle,
  });
  if (busReformEnabled) reformBusLayer.addTo(map); else existingBusLayer.addTo(map);

  srlRouteLayer = L.geoJSON({ type: 'FeatureCollection', features: srlFeatures }, {
    interactive: false,
    style: routeLineStyle,
  });
  if (srlEnabled) srlRouteLayer.addTo(map);

  const fullLayer = L.geoJSON(routesGeojson);
  map.fitBounds(fullLayer.getBounds(), { padding: [30, 30] });
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function nodeCoord(id) {
  if (id === 'USER_ORIGIN') return originLatLng ? { lat: originLatLng.lat, lon: originLatLng.lng } : null;
  if (id === 'USER_DESTINATION') return destLatLng ? { lat: destLatLng.lat, lon: destLatLng.lng } : null;
  const n = graph.nodes[id];
  return n ? { lat: n.lat, lon: n.lon } : null;
}

function edgeDistanceM(e) {
  const a = nodeCoord(e.from);
  const b = nodeCoord(e.to);
  if (!a || !b) return 0;
  return haversineMeters(a.lat, a.lon, b.lat, b.lon);
}

function nearestStops(lat, lon, candidates, k, maxM) {
  const scored = candidates
    .map((c) => ({ ...c, dist: haversineMeters(lat, lon, c.lat, c.lon) }))
    .filter((c) => c.dist <= maxM)
    .sort((a, b) => a.dist - b.dist);
  if (scored.length > 0) return scored.slice(0, k);
  // fallback: nothing within maxM, just take the single closest so the
  // tool never silently fails on a click far from any stop
  return candidates
    .map((c) => ({ ...c, dist: haversineMeters(lat, lon, c.lat, c.lon) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 1);
}

// ---------------------------------------------------------------------------
// Dijkstra with temporary origin/destination injection
// ---------------------------------------------------------------------------

class MinHeap {
  constructor() { this.items = []; }
  get size() { return this.items.length; }
  push(item) {
    this.items.push(item);
    let i = this.items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.items[p].cost <= this.items[i].cost) break;
      [this.items[p], this.items[i]] = [this.items[i], this.items[p]];
      i = p;
    }
  }
  pop() {
    const top = this.items[0];
    const last = this.items.pop();
    if (this.items.length > 0) {
      this.items[0] = last;
      let i = 0;
      while (true) {
        const l = 2 * i + 1, r = 2 * i + 2;
        let smallest = i;
        if (l < this.items.length && this.items[l].cost < this.items[smallest].cost) smallest = l;
        if (r < this.items.length && this.items[r].cost < this.items[smallest].cost) smallest = r;
        if (smallest === i) break;
        [this.items[i], this.items[smallest]] = [this.items[smallest], this.items[i]];
        i = smallest;
      }
    }
    return top;
  }
}

function runDijkstra(startId, endId, extraAdj) {
  const getEdges = (nodeId) => (baseAdj.get(nodeId) || []).concat(extraAdj.get(nodeId) || []);

  const dist = new Map([[startId, 0]]);
  const prev = new Map();
  const visited = new Set();
  const pq = new MinHeap();
  pq.push({ node: startId, cost: 0 });

  while (pq.size > 0) {
    const { node, cost } = pq.pop();
    if (visited.has(node)) continue;
    visited.add(node);
    if (node === endId) break;

    for (const e of getEdges(node)) {
      const nd = cost + e.weight_min;
      if (nd < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, nd);
        prev.set(e.to, { from: node, edge: e });
        pq.push({ node: e.to, cost: nd });
      }
    }
  }

  if (!dist.has(endId)) return null;

  const edges = [];
  let cur = endId;
  while (cur !== startId) {
    const step = prev.get(cur);
    edges.push(step.edge);
    cur = step.from;
  }
  edges.reverse();
  return { totalMin: dist.get(endId), edges };
}

function findRoute(origin, dest) {
  const ORIGIN_ID = 'USER_ORIGIN';
  const DEST_ID = 'USER_DESTINATION';

  const nearOrigin = nearestStops(origin.lat, origin.lng, hubInNodes, NEAREST_STOP_CANDIDATES, MAX_WALK_TO_STOP_M);
  const nearDest = nearestStops(dest.lat, dest.lng, hubOutNodes, NEAREST_STOP_CANDIDATES, MAX_WALK_TO_STOP_M);

  const extraAdj = new Map();
  const originEdges = nearOrigin.map((s) => ({
    from: ORIGIN_ID, to: s.id, type: 'walk',
    weight_min: s.dist / WALK_SPEED_M_PER_MIN,
  }));
  // pure-walk fallback, in case transit genuinely isn't faster than walking
  const directWalk = haversineMeters(origin.lat, origin.lng, dest.lat, dest.lng);
  originEdges.push({ from: ORIGIN_ID, to: DEST_ID, type: 'walk', weight_min: directWalk / WALK_SPEED_M_PER_MIN });
  extraAdj.set(ORIGIN_ID, originEdges);

  for (const s of nearDest) {
    const edge = { from: s.id, to: DEST_ID, type: 'walk', weight_min: s.dist / WALK_SPEED_M_PER_MIN };
    if (!extraAdj.has(s.id)) extraAdj.set(s.id, []);
    extraAdj.get(s.id).push(edge);
  }

  const result = runDijkstra(ORIGIN_ID, DEST_ID, extraAdj);
  if (result && isWalkingExcessive(result)) return null;
  return result;
}

// Treated the same as "no route found": either a single walking stage takes
// over an hour, or the walking legs across the whole journey add up to over
// an hour — even if the rest of the journey is on transit.
const WALK_STAGE_MAX_MIN = 60;
function isWalkingExcessive(result) {
  let totalWalkMin = 0;
  for (const e of result.edges) {
    if (e.type !== 'walk') continue;
    if (e.weight_min > WALK_STAGE_MAX_MIN) return true;
    totalWalkMin += e.weight_min;
  }
  return totalWalkMin > WALK_STAGE_MAX_MIN;
}

// ---------------------------------------------------------------------------
// Isochrones
// ---------------------------------------------------------------------------
// Approach: run a single-source Dijkstra from the clicked point out to every
// stop reachable within the largest threshold, then, at each threshold,
// treat every reachable stop as the center of a walking-distance circle
// (radius = however many minutes of walking budget are left after arriving
// there). Layering the circles from the largest threshold up to the
// smallest — all in one translucent colour — approximates a proper isochrone
// polygon without needing a geometry/union library.

const ISO_THRESHOLDS_MIN = [20, 40, 60];
const ISO_MAX_CANDIDATES = 6;
const ISO_MAX_WALK_TO_STOP_M = 5000;
const ISO_COLOR = '#1d4ed8';
const ISO_FILL_OPACITY = { 20: 0.4, 40: 0.24, 60: 0.14 };

// Like runDijkstra, but explores every node within maxCost of startId
// instead of stopping at a single destination.
function runDijkstraOneToAll(startId, extraAdj, maxCost) {
  const getEdges = (nodeId) => (baseAdj.get(nodeId) || []).concat(extraAdj.get(nodeId) || []);

  const dist = new Map([[startId, 0]]);
  const visited = new Set();
  const pq = new MinHeap();
  pq.push({ node: startId, cost: 0 });

  while (pq.size > 0) {
    const { node, cost } = pq.pop();
    if (visited.has(node)) continue;
    visited.add(node);
    if (cost > maxCost) continue;

    for (const e of getEdges(node)) {
      const nd = cost + e.weight_min;
      if (nd > maxCost) continue;
      if (nd < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, nd);
        pq.push({ node: e.to, cost: nd });
      }
    }
  }

  return dist;
}

// Returns a deduped list of { lat, lon, min } — one entry per physical stop
// location (several graph nodes can share a stop), keeping the fastest
// arrival time seen for that location. The clicked point itself is included
// at min: 0 so the pure-walking radius around it is drawn too.
function computeIsochrone(latlng) {
  const ORIGIN_ID = 'USER_ISO_ORIGIN';
  const near = nearestStops(latlng.lat, latlng.lng, hubInNodes, ISO_MAX_CANDIDATES, ISO_MAX_WALK_TO_STOP_M);

  const extraAdj = new Map();
  extraAdj.set(ORIGIN_ID, near.map((s) => ({
    from: ORIGIN_ID, to: s.id, type: 'walk',
    weight_min: s.dist / WALK_SPEED_M_PER_MIN,
  })));

  const maxMin = ISO_THRESHOLDS_MIN[ISO_THRESHOLDS_MIN.length - 1];
  const dist = runDijkstraOneToAll(ORIGIN_ID, extraAdj, maxMin);

  const byLoc = new Map(); // stop_id (or node id) -> { lat, lon, min }
  byLoc.set('origin', { lat: latlng.lat, lon: latlng.lng, min: 0 });

  dist.forEach((min, nodeId) => {
    if (nodeId === ORIGIN_ID) return;
    const n = graph.nodes[nodeId];
    if (!n) return;
    const key = n.stop_id || nodeId;
    const existing = byLoc.get(key);
    if (!existing || min < existing.min) {
      byLoc.set(key, { lat: n.lat, lon: n.lon, min });
    }
  });

  return Array.from(byLoc.values());
}

// Each threshold gets its own Leaflet pane + canvas renderer so overlapping
// circles within a single band are drawn fully solid (fillOpacity: 1) and
// simply merge into one flat shape instead of stacking alpha on top of
// itself. The per-threshold translucency (ISO_FILL_OPACITY) is then applied
// exactly once, as the CSS opacity of that pane's already-flattened raster.
// This stops dense clusters of 45-min circles from compositing into
// something darker than the 15-min band.
function getIsoPane(threshold) {
  const paneName = `iso-pane-${threshold}`;
  let pane = map.getPane(paneName);
  if (!pane) {
    pane = map.createPane(paneName);
    pane.style.opacity = ISO_FILL_OPACITY[threshold];
    pane.style.pointerEvents = 'none';
  }
  return paneName;
}

function renderIsochrone(latlng, locations) {
  if (isoLayer) map.removeLayer(isoLayer);
  isoLayer = L.layerGroup();

  // Draw the largest (lightest) threshold first so smaller, darker
  // thresholds' panes sit visually on top of it.
  const thresholdsLargestFirst = [...ISO_THRESHOLDS_MIN].sort((a, b) => b - a);
  let zIndex = 400; // below markers/popups, above tile layer
  for (const threshold of thresholdsLargestFirst) {
    const paneName = getIsoPane(threshold);
    map.getPane(paneName).style.zIndex = zIndex++;
    const canvasRenderer = L.canvas({ pane: paneName });
    for (const loc of locations) {
      if (loc.min > threshold) continue;
      const radiusM = (threshold - loc.min) * WALK_SPEED_M_PER_MIN;
      if (radiusM <= 0) continue;
      L.circle([loc.lat, loc.lon], {
        radius: radiusM,
        renderer: canvasRenderer,
        pane: paneName,
        stroke: false,
        fillColor: ISO_COLOR,
        fillOpacity: 1,
      }).addTo(isoLayer);
    }
  }

  isoLayer.addTo(map);

  if (isoMarker) map.removeLayer(isoMarker);
  isoMarker = L.circleMarker(latlng, {
    radius: 6, color: '#1a1d1f', weight: 2, fillColor: '#ffffff', fillOpacity: 1,
  }).addTo(map);
}

function onIsochroneClick(e) {
  if (!graph) return;
  const locations = computeIsochrone(e.latlng);
  isoOriginLatLng = e.latlng;
  renderIsochrone(e.latlng, locations);
  document.getElementById('iso-instruction-text').innerHTML =
    'Click elsewhere to see travel times from a different point.';
  syncURL(false);
}

// ---------------------------------------------------------------------------
// Itinerary construction
// ---------------------------------------------------------------------------

function stopLabel(stopId) {
  const realName = stopNames.get(stopId);
  if (realName) return realName;
  const routes = stopRoutes.get(stopId);
  if (!routes || routes.size === 0) return 'this stop';
  if (routes.size === 1) return `the Route ${[...routes][0]} stop`;
  return `the ${[...routes].join(' / ')} interchange`;
}

function buildItinerary(edges) {
  const legs = [];
  let i = 0;
  let walkTotal = 0, waitTotal = 0, rideTotal = 0;
  let distTotal = 0;

  while (i < edges.length) {
    const e = edges[i];

    if (e.type === 'walk_through' || e.weight_min === 0 && e.type === 'alight') {
      i++; continue;
    }

    if (e.type === 'walk') {
      walkTotal += e.weight_min;
      const distM = edgeDistanceM(e);
      distTotal += distM;
      legs.push({ type: 'walk', label: 'Walk', min: e.weight_min, distM });
      i++; continue;
    }

    if (e.type === 'board') {
      waitTotal += e.weight_min;
      legs.push({ type: 'board', label: 'Wait', min: e.weight_min });
      i++; continue;
    }

    if (e.type === 'transfer') {
      waitTotal += e.weight_min;
      legs.push({ type: 'transfer', label: 'Transfer', min: e.weight_min });
      i++; continue;
    }

    if (e.type === 'ride') {
      let sum = e.weight_min;
      let distM = edgeDistanceM(e);
      const route = e.route;
      let stopCount = 1; // this edge covers one stop-to-stop hop
      let j = i + 1;
      while (j < edges.length && edges[j].type === 'ride' && edges[j].route === route) {
        sum += edges[j].weight_min;
        distM += edgeDistanceM(edges[j]);
        stopCount++;
        j++;
      }
      rideTotal += sum;
      distTotal += distM;
      legs.push({
        type: 'ride',
        label: routeDisplayLabel(route),
        route,
        min: sum,
        stopCount,
        distM,
      });
      i = j; continue;
    }

    // alight (nonzero, shouldn't happen) or anything else: skip silently
    i++;
  }

  return { legs, walkTotal, waitTotal, rideTotal, distTotal };
}

function round1(x) { return Math.round(x * 10) / 10; }

const WALK_ICON_SVG = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
  <circle cx="13.5" cy="4" r="2"/>
  <path d="M14.7 8.1c-.4-.2-.9-.1-1.2.2l-2.1 2.3-2.8-.9c-.5-.1-1 .1-1.2.6l-1.8 4c-.2.5 0 1.1.5 1.3.5.2 1.1 0 1.3-.5l1.4-3.1 1.7.5-2.7 8.8c-.2.5.1 1.1.6 1.3.5.2 1.1-.1 1.3-.6l1.8-5.9 1.5 1.4-.9 4.3c-.1.5.2 1.1.8 1.2.5.1 1.1-.2 1.2-.8l1-4.9c.1-.4-.1-.8-.4-1.1l-2-1.8.9-3.5 1 1.6c.1.2.3.4.5.5l2.4 1.1c.5.2 1.1 0 1.3-.5.2-.5 0-1.1-.5-1.3l-2.2-1-1.9-3.3c-.1-.2-.3-.4-.5-.5z"/>
</svg>`;

// Merges the raw per-edge legs into itinerary display groups:
// - ride legs stay standalone (route name + stop/time detail)
// - a walk immediately followed by a wait (boarding) becomes one combined
//   "Walk / Wait" item with a walking-person icon
// - a transfer becomes a combined "Walk / Transfer" item, with the walk
//   portion fixed at 2 min (the interchange penalty already baked into
//   the transfer edge's weight)
function groupLegsForDisplay(legs) {
  const groups = [];
  let i = 0;
  while (i < legs.length) {
    const leg = legs[i];

    if (leg.type === 'ride') {
      groups.push({ kind: 'ride', leg });
      i++; continue;
    }

    if (leg.type === 'walk' && legs[i + 1] && legs[i + 1].type === 'board') {
      groups.push({
        kind: 'walk-combo',
        mainLabel: 'Walk', mainMin: leg.min,
        subLabel: 'Wait', subMin: legs[i + 1].min,
      });
      i += 2; continue;
    }

    if (leg.type === 'transfer') {
      groups.push({
        kind: 'walk-combo',
        mainLabel: 'Walk', mainMin: 2,
        subLabel: 'Wait', subMin: leg.min - 2,
      });
      i++; continue;
    }

    if (leg.type === 'walk') {
      groups.push({ kind: 'walk-combo', mainLabel: 'Walk', mainMin: leg.min, subLabel: null, subMin: null });
      i++; continue;
    }

    if (leg.type === 'board') {
      groups.push({ kind: 'walk-combo', mainLabel: 'Wait', mainMin: leg.min, subLabel: null, subMin: null });
      i++; continue;
    }

    i++;
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderItinerary(result) {
  const { legs } = buildItinerary(result.edges);

  document.getElementById('empty-state').classList.add('hidden');
  document.getElementById('summary').classList.remove('hidden');
  document.getElementById('itinerary').classList.remove('hidden');

  document.getElementById('total-time').textContent = Math.round(result.totalMin);

  // Horizontal bar: one segment per leg, width proportional to its share of total time.
  const timeBar = document.getElementById('time-bar');
  if (timeBar) {
    timeBar.innerHTML = '';
    const totalMin = legs.reduce((sum, leg) => sum + leg.min, 0) || 1;
    for (const leg of legs) {
      const seg = document.createElement('div');
      seg.className = `time-bar-seg ${leg.type === 'ride' ? 'is-ride' : 'is-other'}`;
      seg.style.width = `${(leg.min / totalMin) * 100}%`;
      if (leg.type === 'ride') {
        seg.style.background = routeColor(leg.route);
      }
      seg.title = ``;
      timeBar.appendChild(seg);
    }
  }

  const list = document.getElementById('itinerary-list');
  list.innerHTML = '';
  const groups = groupLegsForDisplay(legs);
  for (const group of groups) {
    const li = document.createElement('li');
    li.className = group.kind === 'ride' ? 'type-ride' : 'type-other';

    const marker = document.createElement('div');
    marker.className = 'leg-marker';
    if (group.kind === 'ride') {
      const markerShape = document.createElement('div');
      markerShape.className = 'marker-bar';
      markerShape.style.background = routeColor(group.leg.route);
      marker.appendChild(markerShape);
    } else {
      const iconWrap = document.createElement('div');
      iconWrap.className = 'marker-icon';
      iconWrap.innerHTML = WALK_ICON_SVG;
      marker.appendChild(iconWrap);
    }

    const content = document.createElement('div');
    content.className = 'leg-content';

    if (group.kind === 'ride') {
      const leg = group.leg;
      const stopLabelText = leg.stopCount === 1 ? '1 stop' : `${leg.stopCount} stops`;
      content.innerHTML =
        `<span class="leg-route-name">${leg.label}</span>` +
        `<span class="leg-sub">${Math.round(leg.min)} min</span>`;
    } else {
      content.innerHTML = `<span class="leg-main">${group.mainLabel} ${Math.round(group.mainMin)} min</span>` +
        (group.subLabel ? `<span class="leg-sub">${group.subLabel} ${Math.round(group.subMin)} min</span>` : '');
    }

    li.appendChild(marker);
    li.appendChild(content);
    list.appendChild(li);
  }
}

function destPinIcon() {
  return L.divIcon({
    className: 'dest-pin-icon',
    html: `<svg width="26" height="34" viewBox="0 0 26 34" xmlns="http://www.w3.org/2000/svg">
      <path d="M13 0C5.8 0 0 5.8 0 13c0 9.3 13 21 13 21s13-11.7 13-21C26 5.8 20.2 0 13 0z" fill="#b3392c" stroke="#1a1d1f" stroke-width="1.2"/>
      <circle cx="13" cy="13" r="4.5" fill="#ffffff"/>
    </svg>`,
    iconSize: [26, 34],
    iconAnchor: [13, 34],
  });
}

function routeDisplayLabel(routeName) {
  const meta = graph.routes && graph.routes[routeName];
  return (meta && meta.display_label) || routeName;
}

function routeColor(routeName) {
  const meta = graph.routes && graph.routes[routeName];
  const corridor = meta ? meta.corridor : null;
  if (corridor === 'B1') return RIDE_COLOR_B1;
  if (corridor === 'B2') return RIDE_COLOR_B2;
  if (corridor === 'EXIST_BUS') return (meta && meta.color) || RIDE_COLOR_EXIST_BUS;
  if (meta && meta.mode === 'rail') {
    if (routeName === 'RAIL:SRL' || corridor === 'SRL') {
      return (meta && meta.color) || RIDE_COLOR_SRL;
    }
    return (meta && meta.color) || RIDE_COLOR_RAIL;
  }
  if (meta && meta.mode === 'tram') {
    return (meta && meta.color) || RIDE_COLOR_TRAM;
  }
  return RIDE_COLOR_DEFAULT;
}

function edgeCoord(id) {
  if (id === 'USER_ORIGIN') return [originLatLng.lat, originLatLng.lng];
  if (id === 'USER_DESTINATION') return [destLatLng.lat, destLatLng.lng];
  const n = graph.nodes[id];
  return n ? [n.lat, n.lon] : null;
}

function renderPathOnMap(result) {
  if (pathLayer) map.removeLayer(pathLayer);
  pathLayer = L.layerGroup().addTo(map);

  const boardAlightPoints = [];
  let currentSegment = null; // { kind: 'ride'|'other', route, points: [[lat,lon], ...] }
  let prevCoord = [originLatLng.lat, originLatLng.lng];

  const flushSegment = () => {
    if (!currentSegment || currentSegment.points.length < 2) { currentSegment = null; return; }
    if (currentSegment.kind === 'ride') {
      L.polyline(currentSegment.points, {
        color: routeColor(currentSegment.route),
        weight: RIDE_LINE_WEIGHT,
        opacity: 1,
      }).addTo(pathLayer);
    } else {
      L.polyline(currentSegment.points, {
        color: NON_RIDE_LINE_COLOR,
        weight: NON_RIDE_LINE_WEIGHT,
        opacity: 0.9,
        dashArray: '2, 10',
        lineCap: 'round',
      }).addTo(pathLayer);
    }
    currentSegment = null;
  };

  for (const e of result.edges) {
    const toCoord = edgeCoord(e.to);
    if (!toCoord) continue;

    if (e.type === 'ride') {
      if (!currentSegment || currentSegment.kind !== 'ride' || currentSegment.route !== e.route) {
        flushSegment();
        boardAlightPoints.push(prevCoord); // getting on this route
        currentSegment = { kind: 'ride', route: e.route, points: [prevCoord] };
      }
      currentSegment.points.push(toCoord);
    } else if (e.type === 'walk') {
      if (!currentSegment || currentSegment.kind !== 'other') {
        flushSegment();
        currentSegment = { kind: 'other', points: [prevCoord] };
      }
      currentSegment.points.push(toCoord);
    } else {
      // board / transfer / alight: no physical movement (same stop) — these
      // mark a transition, so close off a ride segment if one was open.
      if (currentSegment && currentSegment.kind === 'ride') {
        boardAlightPoints.push(prevCoord); // getting off this route
        flushSegment();
      }
    }

    prevCoord = toCoord;
  }
  flushSegment();

  for (const pt of boardAlightPoints) {
    L.circleMarker(pt, {
      radius: BOARD_ALIGHT_RADIUS,
      color: '#1a1d1f',
      weight: 2,
      fillColor: '#ffffff',
      fillOpacity: 1,
    }).addTo(pathLayer);
  }
}

// ---------------------------------------------------------------------------
// Journey combo selector (Current / Bus Reform / SRL / Both)
// ---------------------------------------------------------------------------
// The journey tab no longer has its own checkboxes — instead it runs the
// route for all four SRL/Bus Reform combinations up front and lets the
// person flip between the results. Network state (routing graph + map
// layers) always reflects whichever combo is currently selected.

// Computes findRoute() for all four combos, temporarily swapping the global
// network state to do so. Leaves srlEnabled/busReformEnabled as they were
// before the call — callers apply the combo they actually want to show via
// selectJourneyCombo() right after.
function computeAllJourneyCombos(origin, dest) {
  const savedSrl = srlEnabled;
  const savedBusReform = busReformEnabled;

  journeyResults = {};
  for (const combo of JOURNEY_COMBOS) {
    srlEnabled = combo.srl;
    busReformEnabled = combo.busReform;
    rebuildAdjacency();
    journeyResults[combo.key] = findRoute(origin, dest);
  }

  srlEnabled = savedSrl;
  busReformEnabled = savedBusReform;
  rebuildAdjacency();
}

// Rounds a combo's total time the same way the button displays it, so
// "same time" comparisons match what the person actually sees. Returns
// null for combos with no route (never treated as equal to anything).
function comboDisplayMin(key) {
  const result = journeyResults[key];
  return result ? Math.round(result.totalMin) : null;
}

// Filters JOURNEY_COMBOS down to the ones worth showing:
// - hide any combo with no route at all (nothing to show for that tab)
// - hide "Both" if it matches "SRL" or "Bus Reform" (nothing new to show)
// - hide "SRL" (and therefore "Both") if "Current" == "SRL" AND
//   "Bus Reform" == "Both" — i.e. adding SRL alone changes nothing, and
//   adding SRL on top of Bus Reform also changes nothing, so SRL is dead
//   weight as an option.
function visibleJourneyCombos() {
  const same = (a, b) => a !== null && b !== null && a === b;

  const current = comboDisplayMin('current');
  const busReform = comboDisplayMin('busReform');
  const srl = comboDisplayMin('srl');
  const both = comboDisplayMin('both');

  const hideBoth = same(srl, both) || same(busReform, both);
  const hideSrl = same(current, srl);

  return JOURNEY_COMBOS.filter((c) => {
    if (!journeyResults[c.key]) return false;
    if (c.key === 'both' && hideBoth) return false;
    if (c.key === 'srl' && hideSrl) return false;
    return true;
  });
}

// Picks the quickest visible combo that actually has a route (falling back
// to the first visible combo if none do), used as the default selection.
function fastestJourneyCombo() {
  const withResults = visibleJourneyCombos().filter((c) => journeyResults[c.key]);
  if (withResults.length === 0) {
    return (visibleJourneyCombos()[0] || JOURNEY_COMBOS[0]).key;
  }
  withResults.sort((a, b) => comboDisplayMin(a.key) - comboDisplayMin(b.key));
  return withResults[0].key;
}

// Builds the four-button row showing each combo's total time, highlighting
// whichever is currently selected and dimming any with no route.
function renderComboSelector() {
  const container = document.getElementById('combo-selector');
  const row = document.getElementById('combo-buttons');
  if (!container || !row) return;

  row.innerHTML = '';
  const sorted = [...visibleJourneyCombos()].sort((a, b) => {
    const ta = comboDisplayMin(a.key);
    const tb = comboDisplayMin(b.key);
    if (ta === null && tb === null) return 0;
    if (ta === null) return 1;  // no route sorts last
    if (tb === null) return -1;
    return ta - tb;             // fastest first
  });
  if (sorted.length === 0) {
    container.classList.add('hidden');
    return;
  }
  for (const combo of sorted) {
    const result = journeyResults[combo.key];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'combo-btn' +
      (combo.key === journeyCombo ? ' active' : '') +
      (!result ? ' unavailable' : '');
    btn.innerHTML =
      `<span class="combo-label">${combo.label}</span>` +
      `<span class="combo-time">${result ? Math.round(result.totalMin) + ' min' : '—'}</span>`;
    btn.addEventListener('click', () => selectJourneyCombo(combo.key));
    row.appendChild(btn);
  }
  container.classList.remove('hidden');
}

// Switches the journey tab to show a given combo's itinerary/path, and
// updates the map's routing graph + layers to match it. If the requested
// combo has been deduped out (see visibleJourneyCombos), falls back to the
// equivalent combo that's still shown.
function selectJourneyCombo(key) {
  const visible = visibleJourneyCombos();
  if (!visible.some((c) => c.key === key)) {
    // "Both" collapses into whichever of SRL/Bus Reform it matched; "SRL"
    // collapses into "Current". Either way, fall back to the first visible
    // combo with a route, defaulting to "current".
    key = (visible.find((c) => journeyResults[c.key]) || visible[0] || JOURNEY_COMBOS[0]).key;
  }

  const combo = JOURNEY_COMBOS.find((c) => c.key === key);
  if (!combo) return;

  journeyCombo = key;
  applyNetworkState(combo.srl, combo.busReform);
  renderComboSelector();

  const result = journeyResults[key];
  if (!result) {
    if (pathLayer) map.removeLayer(pathLayer);
    pathLayer = null;
    document.getElementById('summary').classList.add('hidden');
    document.getElementById('itinerary').classList.add('hidden');
    document.getElementById('empty-state').classList.remove('hidden');
    document.getElementById('empty-state').innerHTML =
      `<p>No route found for the "${combo.label}" network — try one of the other options above.</p>`;
    return;
  }

  document.getElementById('empty-state').innerHTML = '';
  renderItinerary(result);
  renderPathOnMap(result);
}

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// URL routing
// ---------------------------------------------------------------------------
// ?mode=journey                                  -> journey tab, no pins
// ?mode=journey&origin=lat,lng&dest=lat,lng      -> journey tab, both pins placed
// ?mode=isochrone                                -> isochrone tab, no point
// ?mode=isochrone&point=lat,lng                  -> isochrone tab, point placed
//
// All query params, so this works on any static host with no server-side
// rewrite rules needed.

function parseLatLngParam(str) {
  if (!str) return null;
  const parts = str.split(',').map(Number);
  if (parts.length !== 2 || parts.some(Number.isNaN)) return null;
  return { lat: parts[0], lng: parts[1] };
}

// Builds the canonical URL for the current tab + pin state, without
// navigating anywhere.
function buildURL() {
  const url = new URL(window.location.href);
  url.search = '';
  url.searchParams.set('mode', currentTab === 'isochrone' ? 'isochrone' : 'journey');

  if (currentTab === 'journey') {
    // Only encode the network combo alongside an actual trip — with no
    // pins placed there's nothing to reopen, so the URL stays bare.
    if (originLatLng && destLatLng) {
      if (!srlEnabled) url.searchParams.set('srl', '0');
      if (!busReformEnabled) url.searchParams.set('busReform', '0');
      url.searchParams.set('origin', `${originLatLng.lat.toFixed(6)},${originLatLng.lng.toFixed(6)}`);
      url.searchParams.set('dest', `${destLatLng.lat.toFixed(6)},${destLatLng.lng.toFixed(6)}`);
    }
  } else if (currentTab === 'isochrone') {
    if (!srlEnabled) url.searchParams.set('srl', '0');
    if (!busReformEnabled) url.searchParams.set('busReform', '0');
    if (isoOriginLatLng) {
      url.searchParams.set('point', `${isoOriginLatLng.lat.toFixed(6)},${isoOriginLatLng.lng.toFixed(6)}`);
    }
  }

  return url;
}

// push: true when switching tabs (adds a back/forward history entry),
// false when just updating pin data on the tab already showing (replaces
// the current entry so every map click doesn't spam browser history).
function syncURL(push) {
  const url = buildURL();
  if (push) {
    window.history.pushState({}, '', url);
  } else {
    window.history.replaceState({}, '', url);
  }

  const shareBtn = document.getElementById('share-btn');
  if (shareBtn) shareBtn.classList.toggle('hidden', !(originLatLng && destLatLng));
}

// Reads the current URL (path + query) on load or on popstate and applies
// it to app state: which tab is active, and any pins/point to restore.
function loadFromURL() {
  const params = new URLSearchParams(window.location.search);
  const tab = params.get('mode') === 'isochrone' ? 'isochrone' : 'journey';
  setTab(tab, { fromURL: true });

  if (tab === 'journey') {
    const o = parseLatLngParam(params.get('origin'));
    const d = parseLatLngParam(params.get('dest'));
    if (!o || !d) { syncURL(false); return; }

    originLatLng = L.latLng(o.lat, o.lng);
    destLatLng = L.latLng(d.lat, d.lng);
    originMarker = L.circleMarker(originLatLng, { radius: 7, color: '#1a1d1f', weight: 2, fillColor: '#1a1d1f', fillOpacity: 1 }).addTo(map);
    destMarker = L.marker(destLatLng, { icon: destPinIcon() }).addTo(map);
    map.fitBounds(L.latLngBounds([originLatLng, destLatLng]), { padding: [80, 80] });

    computeAllJourneyCombos(originLatLng, destLatLng);
    const anyResult = JOURNEY_COMBOS.some((c) => journeyResults[c.key]);
    if (!anyResult) {
      document.getElementById('instruction-text').innerHTML =
        'Directions could not be found between the linked points — try clicking closer to the network.';
      document.getElementById('combo-selector').classList.add('hidden');
      document.getElementById('summary').classList.add('hidden');
      document.getElementById('itinerary').classList.add('hidden');
      document.getElementById('empty-state').classList.remove('hidden');
      document.getElementById('empty-state').innerHTML =
        '<p>Directions could not be found between those points.</p>';
      syncURL(false);
      return;
    }

    // The URL's srl/busReform params (if any) pick which combo to open with;
    // otherwise default to the fastest combo that actually has a route.
    const requestedSrl = params.get('srl') !== '0';
    const requestedBusReform = params.get('busReform') !== '0';
    const requestedCombo = JOURNEY_COMBOS.find((c) => c.srl === requestedSrl && c.busReform === requestedBusReform);
    const comboToSelect = (requestedCombo && journeyResults[requestedCombo.key])
      ? requestedCombo.key
      : fastestJourneyCombo();

    selectJourneyCombo(comboToSelect);
    document.getElementById('instruction-text').innerHTML = 'Click <strong>Reset</strong> to plan another trip.';
    syncURL(false);
  } else {
    const p = parseLatLngParam(params.get('point'));
    if (!p || !graph) { syncURL(false); return; }

    const latlng = L.latLng(p.lat, p.lng);
    const locations = computeIsochrone(latlng);
    isoOriginLatLng = latlng;
    renderIsochrone(latlng, locations);
    map.setView(latlng, map.getZoom() || 14);
    document.getElementById('iso-instruction-text').innerHTML =
      'Click elsewhere to see travel times from a different point.';
    syncURL(false);
  }
}

window.addEventListener('popstate', loadFromURL);

function copyShareLink() {
  navigator.clipboard.writeText(window.location.href).then(() => {
    const shareBtn = document.getElementById('share-btn');
    if (!shareBtn) return;
    const original = shareBtn.textContent;
    shareBtn.textContent = 'Link copied!';
    setTimeout(() => { shareBtn.textContent = original; }, 1500);
  }).catch(() => {
    window.prompt('Copy this link:', window.location.href);
  });
}

function onMapClick(e) {
  if (!graph) return;
  if (currentTab === 'isochrone') {
    onIsochroneClick(e);
  } else {
    onJourneyClick(e);
  }
}

function onJourneyClick(e) {
  if (!graph) return;

  if (!originLatLng) {
    originLatLng = e.latlng;
    if (originMarker) map.removeLayer(originMarker);
    originMarker = L.circleMarker(e.latlng, { radius: 7, color: '#1a1d1f', weight: 2, fillColor: '#1a1d1f', fillOpacity: 1 }).addTo(map);
    document.getElementById('instruction-text').innerHTML = 'Now click to set your <strong>destination</strong>.';
    return;
  }

  // Origin is already set (whether this is the 2nd click or a later one) —
  // every subsequent click just moves the destination and re-routes,
  // instead of getting ignored once both points exist.
  destLatLng = e.latlng;
  if (destMarker) map.removeLayer(destMarker);
  destMarker = L.marker(e.latlng, { icon: destPinIcon() }).addTo(map);

  computeAllJourneyCombos(originLatLng, destLatLng);
  const anyResult = JOURNEY_COMBOS.some((c) => journeyResults[c.key]);
  if (!anyResult) {
    document.getElementById('instruction-text').innerHTML =
      'Directions could not be found between those points — try clicking closer to the network.';
    document.getElementById('combo-selector').classList.add('hidden');
    document.getElementById('summary').classList.add('hidden');
    document.getElementById('itinerary').classList.add('hidden');
    document.getElementById('empty-state').classList.remove('hidden');
    document.getElementById('empty-state').innerHTML =
      '<p>Directions could not be found between those points.</p>';
    return;
  }

  // Always default to the fastest combo.
  selectJourneyCombo(fastestJourneyCombo());

  syncURL(false);
  document.getElementById('instruction-text').innerHTML = 'Click to move your <strong>destination</strong>, or Reset to change your origin.';
}

// ---------------------------------------------------------------------------
// Mobile "View Details" toggle — swaps the map out for the step-by-step
// itinerary on narrow screens (desktop layout is unaffected; the button
// itself is only visible below the mobile breakpoint, see style.css).
// ---------------------------------------------------------------------------
function setMobileDetailsOpen(open) {
  mobileDetailsOpen = open;
  document.getElementById('app').classList.toggle('details-open', open);
  const btn = document.getElementById('details-toggle-btn');
  if (btn) btn.textContent = open ? 'Hide Details ↑' : 'View Details ↓';
}

const detailsToggleBtn = document.getElementById('details-toggle-btn');
if (detailsToggleBtn) {
  detailsToggleBtn.addEventListener('click', () => setMobileDetailsOpen(!mobileDetailsOpen));
}

document.getElementById('reset-btn').addEventListener('click', () => {
  originLatLng = null;
  destLatLng = null;
  journeyResults = {};
  journeyCombo = 'current';
  if (originMarker) map.removeLayer(originMarker);
  if (destMarker) map.removeLayer(destMarker);
  if (pathLayer) map.removeLayer(pathLayer);
  originMarker = destMarker = pathLayer = null;
  document.getElementById('combo-selector').classList.add('hidden');
  document.getElementById('summary').classList.add('hidden');
  document.getElementById('itinerary').classList.add('hidden');
  document.getElementById('empty-state').classList.remove('hidden');
  document.getElementById('empty-state').innerHTML = '';
  document.getElementById('instruction-text').innerHTML = 'Click the map to set your <strong>origin</strong>.';
  setMobileDetailsOpen(false); // back to showing the map on mobile for the next trip

  applyNetworkState(false, false); // back to the "Current" network for the next trip
  syncURL(false);
});

document.getElementById('share-btn').addEventListener('click', copyShareLink);

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

// options.fromURL: true when called from loadFromURL/popstate — in that
// case the URL already reflects the tab, so we must not push a new history
// entry (and shouldn't clobber pins that loadFromURL is about to restore).
function setTab(tab, options = {}) {
  const { fromURL = false } = options;
  currentTab = tab;
  if (tab !== 'journey') setMobileDetailsOpen(false);

  document.getElementById('tab-journey').classList.toggle('active', tab === 'journey');
  document.getElementById('tab-journey').setAttribute('aria-selected', tab === 'journey');
  document.getElementById('tab-isochrone').classList.toggle('active', tab === 'isochrone');
  document.getElementById('tab-isochrone').setAttribute('aria-selected', tab === 'isochrone');

  document.getElementById('journey-panel').classList.toggle('hidden', tab !== 'journey');
  document.getElementById('isochrone-panel').classList.toggle('hidden', tab !== 'isochrone');

  if (tab === 'journey') {
    if (isoLayer) map.removeLayer(isoLayer);
    if (isoMarker) map.removeLayer(isoMarker);
    if (originMarker) originMarker.addTo(map);
    if (destMarker) destMarker.addTo(map);
    if (pathLayer) pathLayer.addTo(map);

    // The journey tab's network state is driven by the combo selector, not
    // the isochrone tab's checkboxes — reapply whichever combo is selected.
    const combo = JOURNEY_COMBOS.find((c) => c.key === journeyCombo) || JOURNEY_COMBOS[0];
    if (graph) applyNetworkState(combo.srl, combo.busReform);
  } else {
    if (originMarker) map.removeLayer(originMarker);
    if (destMarker) map.removeLayer(destMarker);
    if (pathLayer) map.removeLayer(pathLayer);
    if (isoLayer) isoLayer.addTo(map);
    if (isoMarker) isoMarker.addTo(map);

    // Restore whatever the isochrone checkboxes are set to.
    const srlToggle = document.getElementById('srl-toggle');
    const busReformToggle = document.getElementById('bus-reform-toggle');
    if (graph) {
      applyNetworkState(
        srlToggle ? srlToggle.checked : srlEnabled,
        busReformToggle ? busReformToggle.checked : busReformEnabled
      );
    }
  }

  if (!fromURL) syncURL(true);
}

document.getElementById('tab-journey').addEventListener('click', () => setTab('journey'));
document.getElementById('tab-isochrone').addEventListener('click', () => setTab('isochrone'));

document.getElementById('iso-reset-btn').addEventListener('click', () => {
  if (isoLayer) map.removeLayer(isoLayer);
  if (isoMarker) map.removeLayer(isoMarker);
  isoLayer = null;
  isoMarker = null;
  isoOriginLatLng = null;
  document.getElementById('iso-instruction-text').innerHTML =
    'Click the map to see how far you can travel in <strong>20</strong>, <strong>40</strong>, and <strong>60</strong> minutes.';
  syncURL(false);
});

// ---------------------------------------------------------------------------
// SRL toggle
// ---------------------------------------------------------------------------
// Lets the user exclude the Suburban Rail Loop from routing entirely, to
// compare journeys/isochrones with and without it. Affects both tabs.

// Applies a given SRL/Bus Reform combination to the routing graph and to the
// map layers (route lines + stop markers). Used both by the isochrone tab's
// checkboxes and by the journey tab's four-way combo selector, so all
// network-state changes flow through one place.
function applyNetworkState(srl, busReform) {
  srlEnabled = srl;
  busReformEnabled = busReform;
  rebuildAdjacency();

  if (srlRouteLayer) {
    if (srlEnabled) srlRouteLayer.addTo(map);
    else map.removeLayer(srlRouteLayer);
  }
  for (const m of srlStopMarkers) {
    if (srlEnabled) stopMarkersLayer.addLayer(m);
    else stopMarkersLayer.removeLayer(m);
  }

  if (reformBusLayer) {
    if (busReformEnabled) reformBusLayer.addTo(map); else map.removeLayer(reformBusLayer);
  }
  if (existingBusLayer) {
    if (busReformEnabled) map.removeLayer(existingBusLayer); else existingBusLayer.addTo(map);
  }
  for (const m of reformBusStopMarkers) {
    if (busReformEnabled) stopMarkersLayer.addLayer(m); else stopMarkersLayer.removeLayer(m);
  }
  for (const m of existingBusStopMarkers) {
    if (busReformEnabled) stopMarkersLayer.removeLayer(m); else stopMarkersLayer.addLayer(m);
  }
}

// Re-runs the isochrone after its SRL/Bus Reform checkboxes change. The
// journey tab has its own recompute path (computeAllJourneyCombos +
// selectJourneyCombo), triggered by map clicks rather than checkboxes.
function recomputeIsochroneView() {
  if (!isoOriginLatLng) return;
  const locations = computeIsochrone(isoOriginLatLng);
  renderIsochrone(isoOriginLatLng, locations);
}

function setSrlEnabled(enabled) {
  applyNetworkState(enabled, busReformEnabled);
  recomputeIsochroneView();
  syncURL(false);
}

const srlToggleEl = document.getElementById('srl-toggle');
if (srlToggleEl) {
  srlToggleEl.addEventListener('change', (e) => setSrlEnabled(e.target.checked));
}

// ---------------------------------------------------------------------------
// Bus Reform toggle
// ---------------------------------------------------------------------------
// Unlike the SRL toggle (a simple on/off), this switches between two
// mutually-exclusive bus networks: the hand-drawn reform network (B1/B2
// corridors, checked = on) and the existing real-world metro bus network
// (EXIST_BUS corridor, shown when unchecked).

function setBusReformEnabled(enabled) {
  applyNetworkState(srlEnabled, enabled);
  recomputeIsochroneView();
  syncURL(false);
}

const busReformToggleEl = document.getElementById('bus-reform-toggle');
if (busReformToggleEl) {
  busReformToggleEl.addEventListener('change', (e) => setBusReformEnabled(e.target.checked));
}