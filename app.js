/* Melbourne Bus Reform — Sketch Router
 * Loads the static graph.json produced by preprocess.py and runs a
 * client-side Dijkstra between two user-clicked points. No backend.
 */

const WALK_SPEED_M_PER_MIN = 50;      // must match preprocess.py's constant
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
const RIDE_COLOR_EXIST_BUS = '#C1855D'; // must match EXIST_BUS_COLOR in preprocess.py

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
  { key: 'current', label: 'Current Network', srl: false, busReform: false },
  { key: 'busReform', label: 'Better Buses', srl: false, busReform: true },
  { key: 'srl', label: 'Suburban Rail Loop', srl: true, busReform: false },
  { key: 'both', label: 'Both Projects', srl: true, busReform: true },
];
let journeyCombo = 'both';      // which of JOURNEY_COMBOS is currently shown on the map/itinerary
let journeyResults = {};        // combo key -> findRoute() result (or null if no route for that combo)

let currentTab = 'journey';     // 'journey' | 'isochrone'
let isoLayer = null;            // layered walking-radius circles
let isoMarker = null;           // marker at the clicked isochrone origin
let isoOriginLatLng = null;     // clicked point the isochrone was computed from

// The isochrone tab reuses the same four SRL/Bus Reform combos as the
// journey tab (see JOURNEY_COMBOS), shown as the same tab UI instead of the
// old pair of checkboxes.
let isoCombo = 'both';          // which combo's isochrone is currently shown
let isoResults = {};            // combo key -> { locations, areaKm2 } (areaKm2 at the largest threshold)
let isoLoadingRest = false;     // true from when "Both" is shown until the other 3 combos finish computing

// Preview mode (?preview=1): used for embeds (blog posts, small linked-out
// screenshots, etc.) — the map is still pannable/zoomable, but clicking to
// (re)place a pin is disabled, and the full sidebar (title, reset/share,
// instructions, summary, itinerary) is replaced by a slim bar along the
// bottom of the screen showing just the up-to-four network combo tabs
// (Current / Bus Reform / SRL / Both), plus the travel-time legend on the
// Isochrone tab. See the body.preview-mode rules in style.css for the
// layout side of this, and onMapClick below for the click-disabling.
const isPreviewMode = new URLSearchParams(window.location.search).get('preview') === '1';
if (isPreviewMode) document.body.classList.add('preview-mode');

// The whole-network view (set once, on initial load) and whichever view
// the current preview link is supposed to open on — used to restore the
// view when the preview's Reset button is clicked (see reset-btn listener
// below). Both are { bounds, padding } or { center, zoom }.
let networkBounds = null;
let previewDefaultView = null;

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
  busReformEnabled = new URLSearchParams(window.location.search).get('busReform') !== '0';

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

// Rebuilds the routing edge index, skipping SRL edges when the line is
// toggled off, and skipping whichever bus network (reform vs existing) isn't
// currently selected. There are only ever 4 reachable (srl, busReform)
// combinations (see JOURNEY_COMBOS), and both tabs recompute all 4 of them
// on every single click — so each combination's adjacency list is filtered
// out of graph.edges once and cached, instead of re-scanning every edge in
// the graph every time the same combination comes up again.
const adjacencyCache = new Map();
function rebuildAdjacency() {
  const cacheKey = `${srlEnabled}|${busReformEnabled}`;
  const cached = adjacencyCache.get(cacheKey);
  if (cached) {
    baseAdj = cached;
    return;
  }

  const adj = new Map();
  for (const e of graph.edges) {
    if (!srlEnabled && e.route === 'RAIL:SRL') continue;
    if (e.route) {
      const corridor = routeCorridor(e.route);
      if (busReformEnabled && isExistingBusCorridor(corridor)) continue;
      if (!busReformEnabled && isReformBusCorridor(corridor)) continue;
    }
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from).push(e);
  }

  adjacencyCache.set(cacheKey, adj);
  baseAdj = adj;
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

  // Build a stop_id -> hub_in node index once instead of re-scanning every
  // node in the graph for every named stop (that was O(named stops x total
  // nodes) and gets very slow as the network grows).
  const hubInByStop = new Map();
  for (const n of Object.values(graph.nodes)) {
    if (n.type === 'hub_in') hubInByStop.set(n.stop_id, n);
  }

  for (const [stopId, name] of stopNames.entries()) {
    // any hub_in node for this stop gives us its coordinates
    const node = hubInByStop.get(stopId);
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

  networkBounds = computeGeojsonBounds(routesGeojson);
  map.fitBounds(networkBounds, { padding: [30, 30] });
  if (isPreviewMode) previewDefaultView = { bounds: networkBounds, padding: [30, 30] };
}

// Scans every coordinate in a LineString-only FeatureCollection directly,
// instead of constructing a full (unused, never-added-to-map) L.geoJSON
// layer just to read its bounds off it.
function computeGeojsonBounds(featureCollection) {
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const f of featureCollection.features) {
    for (const [lon, lat] of f.geometry.coordinates) {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
    }
  }
  return L.latLngBounds([minLat, minLon], [maxLat, maxLon]);
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

// candidates is every hub_in/hub_out node in the whole network (potentially
// many thousands of stops), and this runs several times per click — so this
// keeps a bounded top-k list (size k) in a single pass instead of cloning
// and sorting the entire candidate array, and tracks the single globally-
// closest candidate along the way so the far-off-network fallback below
// doesn't need a second full pass re-computing every distance again.
function nearestStops(lat, lon, candidates, k, maxM) {
  const top = []; // ascending by dist, length capped at k, only entries within maxM
  let best = null; // globally closest regardless of maxM, for the fallback

  for (const c of candidates) {
    const dist = haversineMeters(lat, lon, c.lat, c.lon);
    if (!best || dist < best.dist) best = { ...c, dist };
    if (dist > maxM) continue;

    if (top.length < k || dist < top[top.length - 1].dist) {
      let i = top.length;
      while (i > 0 && top[i - 1].dist > dist) i--;
      top.splice(i, 0, { ...c, dist });
      if (top.length > k) top.pop();
    }
  }

  if (top.length > 0) return top;
  // fallback: nothing within maxM, just take the single closest so the
  // tool never silently fails on a click far from any stop
  return best ? [best] : [];
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

// Hidden routing penalties — these edge types are weighted up when
// Dijkstra compares routes, so a path leaning on more walking or more
// waiting has to actually save real time elsewhere to be picked over an
// alternative. This only affects which route wins; once a route is
// chosen, everything shown to the user (leg times, itinerary, total-time
// badge) is based on real, unpenalized durations — see the totalMin
// recomputation below.
const WALK_PENALTY_MULTIPLIER = 1;
const INITIAL_WAIT_PENALTY_MULTIPLIER = 1;   // 'board' edges — waiting for the first vehicle
const CONNECTION_WAIT_PENALTY_MULTIPLIER = 1; // 'transfer' edges — waiting for a connecting vehicle

function edgeRoutingCost(e) {
  if (e.type === 'walk') return e.weight_min * WALK_PENALTY_MULTIPLIER;
  if (e.type === 'board') return e.weight_min * INITIAL_WAIT_PENALTY_MULTIPLIER;
  if (e.type === 'transfer') return e.weight_min * CONNECTION_WAIT_PENALTY_MULTIPLIER;
  return e.weight_min;
}

function runDijkstra(startId, endId, extraAdj) {
  // extraAdj only ever has entries for the injected origin/destination nodes
  // and the handful of stops within walking distance of them — so for the
  // overwhelming majority of nodes visited, avoid allocating a new array via
  // concat() and just hand back the base edge list directly.
  const getEdges = (nodeId) => {
    const extra = extraAdj.get(nodeId);
    const base = baseAdj.get(nodeId);
    if (!extra) return base || [];
    if (!base) return extra;
    return base.concat(extra);
  };

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
      const nd = cost + edgeRoutingCost(e);
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

  // dist.get(endId) is the penalized cost used to pick this path — real,
  // user-facing totalMin is the actual sum of each edge's true weight.
  const totalMin = edges.reduce((sum, e) => sum + e.weight_min, 0);
  return { totalMin, edges };
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

// Fixed left-to-right order for the isochrone tab's combo buttons. Unlike
// the journey tab (sorted fastest-first) the isochrone tab always shows
// "Both" first — since it's computed and rendered before the other three
// combos even exist (see beginIsoCompute) — followed by SRL, Bus Reform,
// then Current, regardless of which has the largest reachable area.
const ISO_COMBO_ORDER = ['both', 'srl', 'busReform', 'current'];

// Like runDijkstra, but explores every node within maxCost of startId
// instead of stopping at a single destination.
function runDijkstraOneToAll(startId, extraAdj, maxCost) {
  // Same reasoning as runDijkstra's getEdges: skip the concat() allocation
  // for nodes with no extra edges. This one matters even more, since a
  // one-to-all search visits every node within the time budget rather than
  // stopping at a single destination.
  const getEdges = (nodeId) => {
    const extra = extraAdj.get(nodeId);
    const base = baseAdj.get(nodeId);
    if (!extra) return base || [];
    if (!base) return extra;
    return base.concat(extra);
  };

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

// Estimates the reachable area (km²) covered by an isochrone's circles at a
// given threshold. The rendered isochrone is a pile of overlapping walking
// circles rather than a clean polygon, so an exact union area isn't cheap to
// compute — instead this rasterizes the circles' bounding box onto a flat
// grid (equirectangular projection, accurate enough at city scale) and
// counts how many cells fall inside at least one circle. Used only for the
// isochrone tab's combo comparison (+X% area), not for rendering.
const ISO_AREA_GRID = 140;
function estimateIsochroneAreaKm2(locations, thresholdMin) {
  const circles = [];
  for (const loc of locations) {
    if (loc.min > thresholdMin) continue;
    const radiusM = (thresholdMin - loc.min) * WALK_SPEED_M_PER_MIN;
    if (radiusM > 0) circles.push({ lat: loc.lat, lon: loc.lon, radiusM });
  }
  if (circles.length === 0) return 0;

  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const c of circles) {
    minLat = Math.min(minLat, c.lat); maxLat = Math.max(maxLat, c.lat);
    minLon = Math.min(minLon, c.lon); maxLon = Math.max(maxLon, c.lon);
  }
  const refLat = (minLat + maxLat) / 2;
  const mPerDegLat = 111320;
  const mPerDegLon = 111320 * Math.cos((refLat * Math.PI) / 180);

  // Project circle centers to a flat local meters grid — fine at this scale
  // and avoids a trig call (haversine) per grid cell per circle below.
  const pc = circles.map((c) => ({ x: c.lon * mPerDegLon, y: c.lat * mPerDegLat, r: c.radiusM, r2: c.radiusM * c.radiusM }));

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const c of pc) {
    minX = Math.min(minX, c.x - c.r); maxX = Math.max(maxX, c.x + c.r);
    minY = Math.min(minY, c.y - c.r); maxY = Math.max(maxY, c.y + c.r);
  }

  const stepX = (maxX - minX) / ISO_AREA_GRID;
  const stepY = (maxY - minY) / ISO_AREA_GRID;
  if (stepX <= 0 || stepY <= 0) return 0;

  let filled = 0;
  for (let i = 0; i < ISO_AREA_GRID; i++) {
    const y = minY + (i + 0.5) * stepY;
    for (let j = 0; j < ISO_AREA_GRID; j++) {
      const x = minX + (j + 0.5) * stepX;
      for (let k = 0; k < pc.length; k++) {
        const dx = x - pc[k].x, dy = y - pc[k].y;
        if (dx * dx + dy * dy <= pc[k].r2) { filled++; break; }
      }
    }
  }

  return (filled * stepX * stepY) / 1e6; // m² -> km²
}

// Bounding box (as an L.latLngBounds) covering every circle that makes up
// the isochrone at a given threshold — i.e. the smallest view that still
// shows the whole reachable area at that threshold, no more. Used to zoom
// the map in appropriately when a URL loads straight into an isochrone
// (see loadFromURL) instead of leaving it at a generic fixed zoom level
// that might show far more (or less) than the actual coverage.
function isochroneBoundsAtThreshold(locations, thresholdMin) {
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  let any = false;
  for (const loc of locations) {
    if (loc.min > thresholdMin) continue;
    const radiusM = (thresholdMin - loc.min) * WALK_SPEED_M_PER_MIN;
    if (radiusM <= 0) continue;
    any = true;
    const dLat = radiusM / 111320;
    const dLon = radiusM / (111320 * Math.cos((loc.lat * Math.PI) / 180));
    minLat = Math.min(minLat, loc.lat - dLat);
    maxLat = Math.max(maxLat, loc.lat + dLat);
    minLon = Math.min(minLon, loc.lon - dLon);
    maxLon = Math.max(maxLon, loc.lon + dLon);
  }
  if (!any) return null;
  return L.latLngBounds([minLat, minLon], [maxLat, maxLon]);
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
  document.getElementById('iso-instructions').classList.add('hidden');
  document.getElementById('iso-place-search').value = coordLabel(e.latlng);
  beginIsoCompute(e.latlng, () => syncURL(false));
}

// ---------------------------------------------------------------------------
// Isochrone combo selector (Current / Bus Reform / SRL / Both)
// ---------------------------------------------------------------------------
// Same four SRL/Bus Reform combinations as the journey tab's selector,
// reused here instead of the old pair of checkboxes. Unlike the journey
// selector, nothing is ever hidden/deduped — all four tabs always show once
// a point has been clicked, per design: comparing "how much area do I gain"
// is the whole point, so a combo that ties another is still worth seeing.

// Computes computeIsochrone() for a single combo, temporarily swapping the
// global network state to do so (same pattern as computeAllJourneyCombos
// used to), and estimates its reachable area at the largest threshold.
// Stores the result straight into isoResults[key].
function computeIsoCombo(key, latlng) {
  const combo = JOURNEY_COMBOS.find((c) => c.key === key);
  if (!combo) return;

  const savedSrl = srlEnabled;
  const savedBusReform = busReformEnabled;

  srlEnabled = combo.srl;
  busReformEnabled = combo.busReform;
  rebuildAdjacency();

  const maxThreshold = ISO_THRESHOLDS_MIN[ISO_THRESHOLDS_MIN.length - 1];
  const locations = computeIsochrone(latlng);
  isoResults[key] = { locations, areaKm2: estimateIsochroneAreaKm2(locations, maxThreshold) };

  srlEnabled = savedSrl;
  busReformEnabled = savedBusReform;
  rebuildAdjacency();
}

// Computes and shows the isochrone for a clicked/loaded origin, in two
// stages so the person isn't staring at a blank map for as long as all four
// combos take to compute:
//   1. "Both" is computed and rendered on its own first — it's the default
//      combo, so this is the one thing that needs to be ready before
//      anything is shown at all.
//   2. The other three combos are then computed right after (deferred by a
//      setTimeout so the browser gets a chance to paint "Both" first rather
//      than the four Dijkstra runs blocking the main thread back-to-back).
//      Once all four are in, isoLoadingRest flips off and the combo
//      selector's %-area badges appear.
// onReady, if given, is called with 'both' right after the first stage
// renders and with 'all' once every combo is in — callers use this to sync
// the URL, and (for a URL-driven load) to switch to a non-"Both" combo that
// was requested but couldn't be selected until its data existed.
function beginIsoCompute(latlng, onReady) {
  isoOriginLatLng = latlng;
  isoResults = {};
  isoLoadingRest = true;
  isoCombo = 'both';

  computeIsoCombo('both', latlng);
  applyNetworkState(true, true);
  renderIsoComboSelector();
  renderIsochrone(latlng, isoResults.both.locations);
  if (onReady) onReady('both');

  setTimeout(() => {
    for (const key of ISO_COMBO_ORDER) {
      if (key === 'both') continue;
      computeIsoCombo(key, latlng);
    }
    isoLoadingRest = false;
    renderIsoComboSelector();
    if (onReady) onReady('all');
  }, 0);
}

// The rounded "+X%" extra area a combo covers vs. the smallest of the four
// (at the largest threshold) — null for the smallest itself (and any combo
// tied with it), which the button then renders blank rather than "+0%".
function isoComboExtraPercent(key) {
  const minArea = Math.min(...JOURNEY_COMBOS.map((c) => isoResults[c.key]?.areaKm2 ?? 0));
  const area = isoResults[key]?.areaKm2 ?? 0;
  if (minArea <= 0) return null;
  const pct = Math.round(((area - minArea) / minArea) * 100);
  return pct > 0 ? pct : null;
}

// Filters JOURNEY_COMBOS down to the ones worth showing on the isochrone
// tab: hide "SRL" and "Both" together if adding SRL alone changes nothing
// (Current's % improvement == SRL's) AND adding SRL on top of Bus Reform
// also changes nothing (Bus Reform's % improvement == Both's) — i.e. SRL is
// dead weight as an option either way it'd be applied. Mirrors
// visibleJourneyCombos()'s SRL-collapsing logic, but keyed off the % badge
// instead of travel time. Unlike the journey tab, ties elsewhere (e.g. Bus
// Reform tying Current on its own) are still shown — only this specific
// combined SRL-is-useless case hides tabs.
function visibleIsoCombos() {
  const pct = (key) => isoComboExtraPercent(key) ?? 0;
  const srlDeadWeight = pct('current') === pct('srl') && pct('busReform') === pct('both');
  return JOURNEY_COMBOS.filter((c) => !(srlDeadWeight && (c.key === 'srl' || c.key === 'both')));
}

// The combo with the largest 60-min reachable area — no longer used to pick
// the default selected tab (that's always "Both" now, see beginIsoCompute),
// but still used for the share-text headline stat, which wants whichever
// combo shows the biggest improvement rather than always "Both".
function bestIsoCombo() {
  const visible = visibleIsoCombos();
  let best = visible[0].key;
  for (const combo of visible) {
    if ((isoResults[combo.key]?.areaKm2 ?? 0) > (isoResults[best]?.areaKm2 ?? 0)) best = combo.key;
  }
  return best;
}

// Builds the button row. "Both" is always the default combo now (see
// beginIsoCompute), so there's no more "largest area wins" selection to
// make here.
//
// While the other three combos are still loading (isoLoadingRest), every
// tab is shown in the fixed ISO_COMBO_ORDER with its %-area badge left
// blank — that badge, and the dead-weight SRL/Both hiding in
// visibleIsoCombos(), both need every combo's area to be known first, so
// neither can be computed yet. Only "Both" is clickable at this point.
//
// Once loading finishes, the row switches to the same fixed order filtered
// down by visibleIsoCombos() (dead-weight SRL/Both dropped), each button
// now showing its real %-area badge.
function renderIsoComboSelector() {
  const container = document.getElementById('iso-combo-selector');
  const row = document.getElementById('iso-combo-buttons');
  if (!container || !row) return;

  if (!isoOriginLatLng || Object.keys(isoResults).length === 0) {
    container.classList.add('hidden');
    return;
  }

  row.innerHTML = '';

  if (isoLoadingRest) {
    for (const key of ISO_COMBO_ORDER) {
      const combo = JOURNEY_COMBOS.find((c) => c.key === key);
      const ready = !!isoResults[key];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'combo-btn' + (key === isoCombo ? ' active' : '') + (!ready ? ' unavailable' : '');
      btn.innerHTML =
        `<span class="combo-label">${combo.label}</span>` +
        `<span class="combo-time"></span>`;
      if (ready) btn.addEventListener('click', () => selectIsoCombo(key));
      row.appendChild(btn);
    }
    container.classList.remove('hidden');
    return;
  }

  const visibleKeys = new Set(visibleIsoCombos().map((c) => c.key));
  const sorted = ISO_COMBO_ORDER
    .filter((key) => visibleKeys.has(key))
    .map((key) => JOURNEY_COMBOS.find((c) => c.key === key));
  for (const combo of sorted) {
    const pct = isoComboExtraPercent(combo.key);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'combo-btn' + (combo.key === isoCombo ? ' active' : '');
    btn.innerHTML =
      `<span class="combo-label">${combo.label}</span>` +
      `<span class="combo-time">${pct !== null ? '+' + pct + '%' : ''}</span>`;
    btn.addEventListener('click', () => selectIsoCombo(combo.key));
    row.appendChild(btn);
  }
  container.classList.remove('hidden');
}

// Switches the isochrone tab to a given combo: updates the routing graph +
// map layers to match it, and redraws the isochrone from that combo's
// precomputed circles (no recomputation needed). If the requested combo has
// been collapsed out by visibleIsoCombos (SRL/Both dead-weight case), falls
// back the same way selectJourneyCombo() does.
//
// While the other three combos are still loading (isoLoadingRest), the
// dead-weight check is skipped entirely — it needs every combo's area to
// decide anything, and only "Both" is selectable at that point anyway (see
// renderIsoComboSelector).
function selectIsoCombo(key) {
  if (!isoLoadingRest) {
    const visible = visibleIsoCombos();
    if (!visible.some((c) => c.key === key)) {
      key = (visible.find((c) => isoResults[c.key]) || visible[0]).key;
    }
  }

  const combo = JOURNEY_COMBOS.find((c) => c.key === key);
  if (!combo || !isoResults[key]) return;

  isoCombo = key;
  applyNetworkState(combo.srl, combo.busReform);
  renderIsoComboSelector();
  renderIsochrone(isoOriginLatLng, isoResults[key].locations);
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
      // Consecutive walk edges (e.g. several OSM footpath segments in a
      // row) collapse into a single leg, the same way consecutive
      // same-route ride edges do below — otherwise the itinerary shows
      // back-to-back "Walk x min" / "Walk y min" items for what's really
      // one continuous walk. walk_through edges (zero-weight pass-through
      // nodes along the footpath) are skipped over rather than treated as
      // a break, since they're not a separate leg either.
      let sum = e.weight_min;
      let distM = edgeDistanceM(e);
      let j = i + 1;
      while (j < edges.length && (edges[j].type === 'walk' || edges[j].type === 'walk_through')) {
        sum += edges[j].weight_min;
        distM += edgeDistanceM(edges[j]);
        j++;
      }
      walkTotal += sum;
      distTotal += distM;
      legs.push({ type: 'walk', label: 'Walk', min: sum, distM });
      i = j; continue;
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

// Whether a computed route actually rides a bus (reform B1/B2 or an
// existing bus route) at any point — used so the "Better Buses" tab isn't
// hidden just because it ties Current on time if it's still routing the
// person via a bus (e.g. a bus that happens to be just as fast).
function journeyUsesBus(result) {
  if (!result) return false;
  return result.edges.some((e) => {
    if (e.type !== 'ride') return false;
    const corridor = routeCorridor(e.route);
    return isReformBusCorridor(corridor) || isExistingBusCorridor(corridor);
  });
}

// Filters JOURNEY_COMBOS down to the ones worth showing:
// - hide any combo with no route at all (nothing to show for that tab)
// - hide "Bus Reform" if it matches "Current" on time AND the Bus Reform
//   route doesn't actually involve a bus (if it still rides a bus despite
//   tying Current, it's still worth showing as a viable bus option)
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

  const hideBusReform = same(current, busReform) && !journeyUsesBus(journeyResults.busReform);
  const hideBoth = same(srl, both) || same(busReform, both);
  const hideSrl = same(current, srl);

  return JOURNEY_COMBOS.filter((c) => {
    if (!journeyResults[c.key]) return false;
    if (c.key === 'busReform' && hideBusReform) return false;
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
    document.getElementById('origin-search').value = coordLabel(originLatLng);
    document.getElementById('dest-search').value = coordLabel(destLatLng);
    const journeyBounds = L.latLngBounds([originLatLng, destLatLng]);
    map.fitBounds(journeyBounds, { padding: [80, 80] });
    if (isPreviewMode) previewDefaultView = { bounds: journeyBounds, padding: [80, 80] };

    computeAllJourneyCombos(originLatLng, destLatLng);
    const anyResult = JOURNEY_COMBOS.some((c) => journeyResults[c.key]);
    if (!anyResult) {
      document.getElementById('instructions').classList.remove('hidden');
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
    document.getElementById('instructions').classList.add('hidden');
    syncURL(false);
  } else {
    const p = parseLatLngParam(params.get('point'));
    if (!p || !graph) { syncURL(false); return; }

    const latlng = L.latLng(p.lat, p.lng);
    document.getElementById('iso-place-search').value = coordLabel(latlng);

    // The URL's srl/busReform params (if any) pick which combo to open
    // with; otherwise (and always in the meantime, since "Both" renders
    // before the other three combos are even computed — see
    // beginIsoCompute) default to "Both".
    const requestedSrl = params.get('srl') !== '0';
    const requestedBusReform = params.get('busReform') !== '0';
    const requestedCombo = JOURNEY_COMBOS.find((c) => c.srl === requestedSrl && c.busReform === requestedBusReform);

    beginIsoCompute(latlng, (stage) => {
      if (stage === 'all' && requestedCombo && requestedCombo.key !== 'both' && isoResults[requestedCombo.key]) {
        selectIsoCombo(requestedCombo.key);
      }
      syncURL(false);
    });

    // beginIsoCompute computes the "Both" combo synchronously before
    // returning (the other three combos are deferred), so isoResults.both
    // is already available here. Fit the view to its largest-threshold
    // coverage area so a linked-to isochrone opens zoomed in appropriately
    // — showing the whole 60-min area but not much beyond it — rather than
    // a generic fixed zoom level that might show far more or less.
    const maxThresholdMin = ISO_THRESHOLDS_MIN[ISO_THRESHOLDS_MIN.length - 1];
    const isoBounds = isoResults.both ? isochroneBoundsAtThreshold(isoResults.both.locations, maxThresholdMin) : null;
    if (isoBounds) {
      map.fitBounds(isoBounds, { padding: [20, 20] });
      if (isPreviewMode) previewDefaultView = { bounds: isoBounds, padding: [20, 20] };
    } else {
      const fallbackZoom = map.getZoom() || 14;
      map.setView(latlng, fallbackZoom);
      if (isPreviewMode) previewDefaultView = { center: latlng, zoom: fallbackZoom };
    }
    document.getElementById('iso-instructions').classList.add('hidden');
  }
}

window.addEventListener('popstate', loadFromURL);

// Below this width (covers phones and tablets) we prefer the OS share
// sheet over copying a link, since that's the native way to share text
// on those devices.
function isMobileOrTablet() {
  return window.innerWidth <= 1024;
}

// Builds the viral share text for the Journey tab. The headline number is
// the gap between the fastest and slowest of the four network combos
// (Current / Bus Reform / SRL / Both) that actually have a route. If the
// fastest combo is "Current" itself, there's no time saved to brag about,
// so a different message is used. Otherwise the message calls out just
// SRL, just Bus Reform, or both — whichever the fastest combo actually
// used.
function journeyShareText() {
  const withResults = JOURNEY_COMBOS
    .filter((c) => journeyResults[c.key])
    .map((c) => ({ ...c, time: comboDisplayMin(c.key) }));
  if (withResults.length === 0) return null;

  let fastest = withResults[0];
  let slowest = withResults[0];
  for (const c of withResults) {
    if (c.time < fastest.time) fastest = c;
    if (c.time > slowest.time) slowest = c;
  }

  if (fastest.key === 'current') {
    return 'I just checked out my commute when Melbourne has SRL and better buses 🤯mohanwadia.com/srl';
  }

  const x = slowest.time - fastest.time;
  let mention;
  if (fastest.key === 'srl') mention = 'SRL';
  else if (fastest.key === 'busReform') mention = 'better buses';
  else mention = 'SRL and better buses'; // 'both'

  const savings = x <= 4 ? 'time' : `${x} minutes`;
  return `I'll save ${savings} on my commute when Melbourne has ${mention}🤯www.mohanwadia.com/srl`;
}

// Isochrone tab share text. Three cases:
// - map reset (no point clicked yet, or nothing computed): fixed fallback line.
// - SRL is dead weight for this point (visibleIsoCombos collapsed SRL/Both
//   out — only Current/Bus Reform show): "better buses" only, no SRL mention.
// - otherwise: "SRL and better buses", with the best combo's %-further-area
//   badge as the headline number.
function isochroneShareText() {
  const noPoint = !isoOriginLatLng || Object.keys(isoResults).length === 0;
  if (noPoint) {
    return "I'll be able to travel so much faster when Melbourne has SRL and better buses 🤯mohanwadia.com/srl";
  }

  const best = bestIsoCombo();
  const pct = isoComboExtraPercent(best) ?? 0;
  if (pct <= 0) {
    return "I'll be able to travel so much faster when Melbourne has SRL and better buses 🤯mohanwadia.com/srl";
  }

  const benefitsFromSrl = visibleIsoCombos().some((c) => c.key === 'srl' || c.key === 'both');
  const mention = benefitsFromSrl ? 'SRL and better buses' : 'better buses';
  return `I'll be able to travel ${pct}% further when Melbourne has ${mention} 🤯mohanwadia.com/srl`;
}

// Generic share text used when the Journey tab has no pins placed yet.
// The Isochrone tab has its own reset-state line (see isochroneShareText).
function genericShareText() {
  return "Check out how much time you'll save once Melbourne has SRL and better buses 🤯 mohanwadia.com/srl";
}

function shareOrCopyLink() {
  const shareBtn = document.getElementById('share-btn');
  const hasJourney = currentTab === 'journey' && originLatLng && destLatLng;

  let text;
  if (currentTab === 'isochrone') text = isochroneShareText();
  else if (hasJourney) text = journeyShareText() || genericShareText();
  else text = genericShareText();

  if (isMobileOrTablet() && navigator.share && text) {
    navigator.share({ text }).catch(() => {});
    return;
  }

  navigator.clipboard.writeText(window.location.href).then(() => {
    if (!shareBtn) return;
    const original = shareBtn.textContent;
    shareBtn.textContent = 'Link copied!';
    setTimeout(() => { shareBtn.textContent = original; }, 1500);
  }).catch(() => {
    window.prompt('Copy this link:', window.location.href);
  });
}

// ---------------------------------------------------------------------------
// Place search (origin/destination boxes on Journey, single box on
// Isochrone) — free-text geocoding via OpenStreetMap's Nominatim, biased
// (not restricted) to the greater Melbourne area so typing "Flinders
// Street" surfaces the right result first without excluding anywhere else
// the person might type.
// ---------------------------------------------------------------------------

const MELBOURNE_VIEWBOX = '144.4,-37.5,145.6,-38.3'; // left,top,right,bottom
const MELBOURNE_CENTER = { lat: -37.8136, lon: 144.9631 };
const MAX_RESULT_DISTANCE_KM = 300; // results further than this from Melbourne are almost certainly a wrong match, not a place someone's actually asking about

function debounce(fn, delayMs) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delayMs);
  };
}

async function geocodePlace(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}` +
    `&viewbox=${MELBOURNE_VIEWBOX}&bounded=0&limit=6`;
  const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
  if (!res.ok) throw new Error('geocode request failed');
  const results = await res.json();
  // Nominatim's viewbox only biases ranking, it doesn't exclude far-away
  // matches — a query with no good local match can still return something
  // on the other side of the world. Drop anything unreasonably far from
  // Melbourne rather than show it as a suggestion.
  return results.filter((r) => {
    const distKm = haversineMeters(MELBOURNE_CENTER.lat, MELBOURNE_CENTER.lon, parseFloat(r.lat), parseFloat(r.lon)) / 1000;
    return distKm <= MAX_RESULT_DISTANCE_KM;
  });
}

// Wires up a text input + its dropdown container to search-as-you-type,
// calling onSelect(latlng, label) once the person picks a suggestion.
function setupPlaceSearch(inputId, suggId, onSelect) {
  const input = document.getElementById(inputId);
  const dropdown = document.getElementById(suggId);
  let requestToken = 0;

  function hideDropdown() {
    dropdown.classList.add('hidden');
    dropdown.innerHTML = '';
  }

  function renderResults(results) {
    dropdown.innerHTML = '';
    if (results.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'suggestion-empty';
      empty.textContent = 'No matches found';
      dropdown.appendChild(empty);
      dropdown.classList.remove('hidden');
      return;
    }
    for (const r of results) {
      const item = document.createElement('div');
      item.className = 'suggestion-item';
      item.textContent = r.display_name;
      // mousedown (not click) fires before the input's blur handler, so the
      // dropdown doesn't get hidden out from under the click.
      item.addEventListener('mousedown', (evt) => {
        evt.preventDefault();
        input.value = r.display_name;
        hideDropdown();
        onSelect(L.latLng(parseFloat(r.lat), parseFloat(r.lon)), r.display_name);
      });
      dropdown.appendChild(item);
    }
    dropdown.classList.remove('hidden');
  }

  const runSearch = debounce(async (query) => {
    if (query.trim().length < 3) { hideDropdown(); return; }
    const token = ++requestToken;
    try {
      const results = await geocodePlace(query);
      if (token !== requestToken) return; // a newer keystroke superseded this request
      renderResults(results);
    } catch (err) {
      if (token !== requestToken) return;
      hideDropdown();
    }
  }, 350);

  input.addEventListener('input', () => runSearch(input.value));
  input.addEventListener('focus', () => { if (input.value.trim().length >= 3) runSearch(input.value); });
  input.addEventListener('blur', () => { setTimeout(hideDropdown, 100); });

  // Clicking into a box that already has a value while it's out of focus
  // should select all the text, not drop the cursor mid-string — mirrors
  // how browsers handle the URL bar. Prevent the mousedown's default
  // focus+caret-placement and do it manually with select() instead; once
  // the input is already focused, clicks behave normally again.
  input.addEventListener('mousedown', (evt) => {
    if (document.activeElement !== input && input.value) {
      evt.preventDefault();
      input.focus();
      input.select();
    }
  });
}

function initPlaceSearch() {
  setupPlaceSearch('origin-search', 'origin-suggestions', (latlng) => {
    if (!graph) return;
    placeJourneyOrigin(latlng);
    map.setView(latlng, Math.max(map.getZoom(), 14));
    document.getElementById('instructions').classList.remove('hidden');
  });

  setupPlaceSearch('dest-search', 'dest-suggestions', (latlng) => {
    if (!graph) return;
    placeJourneyDestination(latlng);
    if (originLatLng) {
      map.fitBounds(L.latLngBounds([originLatLng, latlng]), { padding: [80, 80] });
    } else {
      map.setView(latlng, Math.max(map.getZoom(), 14));
    }
  });

  setupPlaceSearch('iso-place-search', 'iso-suggestions', (latlng) => {
    if (!graph) return;
    document.getElementById('iso-instructions').classList.add('hidden');
    beginIsoCompute(latlng, () => syncURL(false));
    map.setView(latlng, Math.max(map.getZoom(), 14));
  });
}

initPlaceSearch();

function onMapClick(e) {
  if (!graph) return;
  if (isPreviewMode) return; // preview embeds are look-but-don't-touch: pan/zoom still work via Leaflet's own handlers, only click-to-place is disabled
  if (currentTab === 'isochrone') {
    onIsochroneClick(e);
  } else {
    onJourneyClick(e);
  }
}

function onJourneyClick(e) {
  if (!graph) return;

  if (!originLatLng) {
    placeJourneyOrigin(e.latlng, { viaClick: true });
    return;
  }

  // Origin is already set (whether this is the 2nd click or a later one) —
  // every subsequent click just moves the destination and re-routes,
  // instead of getting ignored once both points exist.
  placeJourneyDestination(e.latlng, { viaClick: true });
}

// Formats a latlng as plain coordinates for the search boxes, used to give
// the person feedback on where they clicked without pretending it's a
// place name.
function coordLabel(latlng) {
  return `${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}`;
}

// Sets/moves the origin pin — shared by map clicks and the origin search
// box. Doesn't attempt to route on its own; if a destination is already
// set (e.g. the person changes their mind on origin after both are
// placed), it re-routes too. When placed via a map click (rather than a
// search selection), the coordinates are echoed into the search box and
// the "now click destination" guidance is skipped — the pin itself is
// the feedback.
function placeJourneyOrigin(latlng, { viaClick = false } = {}) {
  if (!graph) return;
  originLatLng = latlng;
  if (originMarker) map.removeLayer(originMarker);
  originMarker = L.circleMarker(latlng, { radius: 7, color: '#1a1d1f', weight: 2, fillColor: '#1a1d1f', fillOpacity: 1 }).addTo(map);

  if (viaClick) document.getElementById('origin-search').value = coordLabel(latlng);

  if (destLatLng) {
    runJourneyCompute();
  } else if (viaClick) {
    document.getElementById('instructions').classList.add('hidden');
  } else {
    document.getElementById('instruction-text').innerHTML = 'Now click to set your <strong>destination</strong>, or search above.';
  }
}

// Sets/moves the destination pin and (re-)computes the route — shared by
// map clicks and the destination search box. See placeJourneyOrigin for
// the viaClick behavior.
function placeJourneyDestination(latlng, { viaClick = false } = {}) {
  if (!graph) return;
  destLatLng = latlng;
  if (destMarker) map.removeLayer(destMarker);
  destMarker = L.marker(latlng, { icon: destPinIcon() }).addTo(map);

  if (viaClick) document.getElementById('dest-search').value = coordLabel(latlng);

  if (!originLatLng) {
    if (!viaClick) {
      document.getElementById('instruction-text').innerHTML = 'Now click to set your <strong>origin</strong>, or search above.';
    } else {
      document.getElementById('instructions').classList.add('hidden');
    }
    return;
  }
  runJourneyCompute();
}

// Computes all four network combos for the current origin/dest pair and
// updates the panel — the shared tail end of both placeJourneyOrigin (when
// dest is already set) and placeJourneyDestination.
function runJourneyCompute() {
  computeAllJourneyCombos(originLatLng, destLatLng);
  const anyResult = JOURNEY_COMBOS.some((c) => journeyResults[c.key]);
  if (!anyResult) {
    document.getElementById('instructions').classList.remove('hidden');
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
  document.getElementById('instructions').classList.add('hidden');
}

// In preview mode, clicking to place pins is disabled entirely (see
// onMapClick), so there's never anything to clear — instead "Reset" just
// restores whatever view (pan/zoom) the preview opened on, undoing any
// panning/zooming the viewer has done since.
function resetPreviewView() {
  if (previewDefaultView && previewDefaultView.bounds) {
    map.fitBounds(previewDefaultView.bounds, { padding: previewDefaultView.padding || [30, 30] });
  } else if (previewDefaultView && previewDefaultView.center) {
    map.setView(previewDefaultView.center, previewDefaultView.zoom);
  } else if (networkBounds) {
    map.fitBounds(networkBounds, { padding: [30, 30] });
  }
}

document.getElementById('reset-btn').addEventListener('click', () => {
  if (isPreviewMode) {
    resetPreviewView();
    return;
  }

  originLatLng = null;
  destLatLng = null;
  journeyResults = {};
  journeyCombo = 'both';
  if (originMarker) map.removeLayer(originMarker);
  if (destMarker) map.removeLayer(destMarker);
  if (pathLayer) map.removeLayer(pathLayer);
  originMarker = destMarker = pathLayer = null;
  document.getElementById('combo-selector').classList.add('hidden');
  document.getElementById('summary').classList.add('hidden');
  document.getElementById('itinerary').classList.add('hidden');
  document.getElementById('empty-state').classList.remove('hidden');
  document.getElementById('empty-state').innerHTML = '';
  document.getElementById('instructions').classList.remove('hidden');
  document.getElementById('instruction-text').innerHTML = 'Click the map to set your <strong>origin</strong>, or search above.';
  document.getElementById('origin-search').value = '';
  document.getElementById('dest-search').value = '';

  applyNetworkState(true, true); // back to the "Both" (SRL + Bus Reform) network for the next trip

  // Also reset the isochrone tab's point, since this is now the only
  // reset button (the isochrone tab's own reset button was removed).
  if (isoLayer) map.removeLayer(isoLayer);
  if (isoMarker) map.removeLayer(isoMarker);
  isoLayer = null;
  isoMarker = null;
  isoOriginLatLng = null;
  isoResults = {};
  isoCombo = 'both';
  isoLoadingRest = false;
  document.getElementById('iso-combo-selector').classList.add('hidden');
  document.getElementById('iso-instructions').classList.remove('hidden');
  document.getElementById('iso-instruction-text').innerHTML =
    'Click the map to see how far you can travel in <strong>20</strong>, <strong>40</strong>, and <strong>60</strong> minutes, or search above.';
  document.getElementById('iso-place-search').value = '';

  syncURL(false);
});

// Strips the ?preview=1 param from the current URL — used any time the
// preview UI hands the viewer off to the real, interactive experience
// (the Share button, and clicking the mohanwadia.com/srl title).
function nonPreviewURL() {
  const url = new URL(window.location.href);
  url.searchParams.delete('preview');
  return url.toString();
}

// Preview mode's Share button: shares/copies the exact current URL (minus
// ?preview=1, so whoever opens it gets the real interactive map) with no
// extra share text, unlike the normal Share button's viral copy.
function previewShare() {
  const url = nonPreviewURL();
  const shareBtn = document.getElementById('share-btn');

  if (isMobileOrTablet() && navigator.share) {
    navigator.share({ url }).catch(() => {});
    return;
  }

  navigator.clipboard.writeText(url).then(() => {
    if (!shareBtn) return;
    const original = shareBtn.textContent;
    shareBtn.textContent = 'Link copied!';
    setTimeout(() => { shareBtn.textContent = original; }, 1500);
  }).catch(() => {
    window.prompt('Copy this link:', url);
  });
}

document.getElementById('share-btn').addEventListener('click', () => {
  if (isPreviewMode) previewShare();
  else shareOrCopyLink();
});

// The "mohanwadia.com/srl" title: normally a home link — takes the person
// to the Journey tab, zoomed out, with no pins (i.e. a bare-params reload).
// In preview mode, instead of navigating away from the preview itself, it
// opens the *interactive* version of exactly what's being previewed (same
// pins/point/combo, just without ?preview=1) in a new tab.
document.getElementById('panel-title').addEventListener('click', () => {
  if (isPreviewMode) {
    window.open(nonPreviewURL(), '_blank');
    return;
  }
  const url = new URL(window.location.href);
  url.search = '';
  window.location.href = url.toString();
});

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

// options.fromURL: true when called from loadFromURL/popstate — in that
// case the URL already reflects the tab, so we must not push a new history
// entry (and shouldn't clobber pins that loadFromURL is about to restore).
function setTab(tab, options = {}) {
  const { fromURL = false } = options;
  currentTab = tab;

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

    // The journey tab's network state is driven by its own combo selector —
    // reapply whichever combo is selected there.
    const combo = JOURNEY_COMBOS.find((c) => c.key === journeyCombo) || JOURNEY_COMBOS[0];
    if (graph) applyNetworkState(combo.srl, combo.busReform);
  } else {
    if (originMarker) map.removeLayer(originMarker);
    if (destMarker) map.removeLayer(destMarker);
    if (pathLayer) map.removeLayer(pathLayer);
    if (isoLayer) isoLayer.addTo(map);
    if (isoMarker) isoMarker.addTo(map);

    // Same idea for the isochrone tab: reapply whichever combo is selected
    // in its own selector (now that the old checkboxes are gone).
    const combo = JOURNEY_COMBOS.find((c) => c.key === isoCombo) || JOURNEY_COMBOS[0];
    if (graph) applyNetworkState(combo.srl, combo.busReform);
  }

  if (!fromURL) syncURL(true);
}

document.getElementById('tab-journey').addEventListener('click', () => setTab('journey'));
document.getElementById('tab-isochrone').addEventListener('click', () => setTab('isochrone'));

// ---------------------------------------------------------------------------
// Network state
// ---------------------------------------------------------------------------
// Shared plumbing for both tabs' four-way combo selectors (Current / Bus
// Reform / SRL / Both), letting the person compare journeys/isochrones
// across SRL and Bus Reform combinations.

// Applies a given SRL/Bus Reform combination to the routing graph and to the
// map layers (route lines + stop markers). Used by both tabs' four-way combo
// selectors, so all network-state changes flow through one place.
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

// The isochrone tab's network state now flows through selectIsoCombo (see
// the isochrone combo selector section above) instead of SRL/Bus Reform
// checkboxes, mirroring how the journey tab's combo selector works.