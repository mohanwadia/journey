/* Melbourne Bus Reform — Sketch Router
 * Loads the static graph.json produced by preprocess.py and runs a
 * client-side Dijkstra between two user-clicked points. No backend.
 */

const WALK_SPEED_M_PER_MIN = 80;      // must match preprocess.py's constant
const MAX_WALK_TO_STOP_M = 900;       // how far we'll look for a boarding/alighting stop
const NEAREST_STOP_CANDIDATES = 4;    // don't just take the closest stop — give the router options

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let graph = null;               // raw graph.json
let baseAdj = new Map();        // nodeId -> [edge, ...]
let hubInNodes = [];            // [{id, lat, lon}, ...]
let hubOutNodes = [];
let stopRoutes = new Map();     // stop_id -> Set(route_id)  (for itinerary labels)

let originLatLng = null;
let destLatLng = null;
let originMarker = null;
let destMarker = null;
let pathLayer = null;

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
]).then(([graphData, routesGeojson]) => {
  graph = graphData;
  buildAdjacency();
  buildStopIndex();
  renderRouteLines(routesGeojson);
  map.on('click', onMapClick);
  loadFromPermalink();
}).catch(err => {
  document.getElementById('instruction-text').textContent =
    'Could not load network data — check the console. If you opened this file directly, ' +
    'you need to run it through a local server (e.g. `python3 -m http.server`) since ' +
    'browsers block fetch() on file:// paths.';
  console.error(err);
});

function buildAdjacency() {
  for (const e of graph.edges) {
    if (!baseAdj.has(e.from)) baseAdj.set(e.from, []);
    baseAdj.get(e.from).push(e);
  }
  for (const [id, n] of Object.entries(graph.nodes)) {
    if (n.type === 'hub_in') hubInNodes.push({ id, lat: n.lat, lon: n.lon });
    if (n.type === 'hub_out') hubOutNodes.push({ id, lat: n.lat, lon: n.lon });
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

function renderRouteLines(routesGeojson) {
  const layer = L.geoJSON(routesGeojson, {
    interactive: false, // let clicks pass through to the map
    style: (feature) => {
      const isB1 = feature.properties.corridor === 'B1';
      return {
        color: isB1 ? '#2f6f4f' : '#c46a2c',
        weight: isB1 ? 3 : 2.2,
        opacity: isB1 ? 0.75 : 0.55,
      };
    },
  }).addTo(map);

  map.fitBounds(layer.getBounds(), { padding: [30, 30] });
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

  return runDijkstra(ORIGIN_ID, DEST_ID, extraAdj);
}

// ---------------------------------------------------------------------------
// Itinerary construction
// ---------------------------------------------------------------------------

function stopLabel(stopId) {
  const routes = stopRoutes.get(stopId);
  if (!routes || routes.size === 0) return 'this stop';
  if (routes.size === 1) return `the Route ${[...routes][0]} stop`;
  return `the ${[...routes].join(' / ')} interchange`;
}

function buildItinerary(edges) {
  const legs = [];
  let i = 0;
  let walkTotal = 0, waitTotal = 0, rideTotal = 0;

  while (i < edges.length) {
    const e = edges[i];

    if (e.type === 'walk_through' || e.weight_min === 0 && e.type === 'alight') {
      i++; continue;
    }

    if (e.type === 'walk') {
      walkTotal += e.weight_min;
      const destStopId = graph.nodes[e.to]?.stop_id;
      const label = e.to.startsWith('USER')
        ? 'Walk to your destination'
        : `Walk to ${stopLabel(destStopId)}`;
      legs.push({ type: 'walk', label, min: e.weight_min });
      i++; continue;
    }

    if (e.type === 'board') {
      waitTotal += e.weight_min;
      legs.push({ type: 'board', label: `Board Route ${e.route} (avg wait ${round1(e.weight_min)} min)`, min: e.weight_min });
      i++; continue;
    }

    if (e.type === 'transfer') {
      waitTotal += e.weight_min;
      legs.push({ type: 'transfer', label: `Transfer to Route ${e.route} (wait + interchange, ${round1(e.weight_min)} min)`, min: e.weight_min });
      i++; continue;
    }

    if (e.type === 'ride') {
      let sum = e.weight_min;
      const route = e.route;
      let j = i + 1;
      while (j < edges.length && edges[j].type === 'ride' && edges[j].route === route) {
        sum += edges[j].weight_min;
        j++;
      }
      rideTotal += sum;
      legs.push({ type: 'ride', label: `Ride Route ${route}`, min: sum });
      i = j; continue;
    }

    // alight (nonzero, shouldn't happen) or anything else: skip silently
    i++;
  }

  return { legs, walkTotal, waitTotal, rideTotal };
}

function round1(x) { return Math.round(x * 10) / 10; }

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderItinerary(result) {
  const { legs, walkTotal, waitTotal, rideTotal } = buildItinerary(result.edges);

  document.getElementById('empty-state').classList.add('hidden');
  document.getElementById('summary').classList.remove('hidden');
  document.getElementById('itinerary').classList.remove('hidden');

  document.getElementById('total-time').textContent = Math.round(result.totalMin);
  document.getElementById('bd-walk').textContent = round1(walkTotal);
  document.getElementById('bd-wait').textContent = round1(waitTotal);
  document.getElementById('bd-ride').textContent = round1(rideTotal);

  const list = document.getElementById('itinerary-list');
  list.innerHTML = '';
  for (const leg of legs) {
    const li = document.createElement('li');
    li.className = `type-${leg.type}`;
    li.innerHTML = `<span class="leg-label">${leg.label}</span><br/><span class="leg-time">${round1(leg.min)} min</span>`;
    list.appendChild(li);
  }
}

function renderPathOnMap(result) {
  if (pathLayer) map.removeLayer(pathLayer);
  const latlngs = [];
  const pushNode = (id) => {
    const n = graph.nodes[id];
    if (n) latlngs.push([n.lat, n.lon]);
  };
  latlngs.push([originLatLng.lat, originLatLng.lng]);
  for (const e of result.edges) {
    if (e.to === 'USER_DESTINATION') continue;
    pushNode(e.to);
  }
  latlngs.push([destLatLng.lat, destLatLng.lng]);

  pathLayer = L.polyline(latlngs, { color: '#1d4ed8', weight: 4, opacity: 0.85 }).addTo(map);
}

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Permalinks (?origin=lat,lng&dest=lat,lng)
// ---------------------------------------------------------------------------

function parseLatLngParam(str) {
  if (!str) return null;
  const parts = str.split(',').map(Number);
  if (parts.length !== 2 || parts.some(Number.isNaN)) return null;
  return { lat: parts[0], lng: parts[1] };
}

function loadFromPermalink() {
  const params = new URLSearchParams(window.location.search);
  const o = parseLatLngParam(params.get('origin'));
  const d = parseLatLngParam(params.get('dest'));
  if (!o || !d) return;

  originLatLng = L.latLng(o.lat, o.lng);
  destLatLng = L.latLng(d.lat, d.lng);
  originMarker = L.circleMarker(originLatLng, { radius: 7, color: '#2f6f4f', fillColor: '#2f6f4f', fillOpacity: 1 }).addTo(map);
  destMarker = L.circleMarker(destLatLng, { radius: 7, color: '#b3392c', fillColor: '#b3392c', fillOpacity: 1 }).addTo(map);
  map.fitBounds(L.latLngBounds([originLatLng, destLatLng]), { padding: [80, 80] });

  const result = findRoute(originLatLng, destLatLng);
  if (!result) {
    document.getElementById('instruction-text').textContent =
      'No route found between the linked points — try clicking closer to the network.';
    return;
  }
  renderItinerary(result);
  renderPathOnMap(result);
  updatePermalink();
  document.getElementById('instruction-text').innerHTML = 'Click <strong>Reset</strong> to plan another trip.';
}

function updatePermalink() {
  if (!originLatLng || !destLatLng) return;
  const url = new URL(window.location.href);
  url.search = '';
  url.searchParams.set('origin', `${originLatLng.lat.toFixed(6)},${originLatLng.lng.toFixed(6)}`);
  url.searchParams.set('dest', `${destLatLng.lat.toFixed(6)},${destLatLng.lng.toFixed(6)}`);
  window.history.replaceState({}, '', url);

  const shareBtn = document.getElementById('share-btn');
  if (shareBtn) shareBtn.classList.remove('hidden');
}

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

  if (!originLatLng) {
    originLatLng = e.latlng;
    if (originMarker) map.removeLayer(originMarker);
    originMarker = L.circleMarker(e.latlng, { radius: 7, color: '#2f6f4f', fillColor: '#2f6f4f', fillOpacity: 1 }).addTo(map);
    document.getElementById('instruction-text').innerHTML = 'Now click to set your <strong>destination</strong>.';
    return;
  }

  // Origin is already set (whether this is the 2nd click or a later one) —
  // every subsequent click just moves the destination and re-routes,
  // instead of getting ignored once both points exist.
  destLatLng = e.latlng;
  if (destMarker) map.removeLayer(destMarker);
  destMarker = L.circleMarker(e.latlng, { radius: 7, color: '#b3392c', fillColor: '#b3392c', fillOpacity: 1 }).addTo(map);

  const result = findRoute(originLatLng, destLatLng);
  if (!result) {
    document.getElementById('instruction-text').textContent =
      'No route found between those points — try clicking closer to the network.';
    return;
  }
  renderItinerary(result);
  renderPathOnMap(result);
  updatePermalink();
  document.getElementById('instruction-text').innerHTML = 'Click to move your <strong>destination</strong>, or Reset to change your origin.';
}

document.getElementById('reset-btn').addEventListener('click', () => {
  originLatLng = null;
  destLatLng = null;
  if (originMarker) map.removeLayer(originMarker);
  if (destMarker) map.removeLayer(destMarker);
  if (pathLayer) map.removeLayer(pathLayer);
  originMarker = destMarker = pathLayer = null;
  document.getElementById('summary').classList.add('hidden');
  document.getElementById('itinerary').classList.add('hidden');
  document.getElementById('empty-state').classList.remove('hidden');
  document.getElementById('instruction-text').innerHTML = 'Click the map to set your <strong>origin</strong>.';

  const shareBtn = document.getElementById('share-btn');
  if (shareBtn) shareBtn.classList.add('hidden');
  const url = new URL(window.location.href);
  url.search = '';
  window.history.replaceState({}, '', url);
});

document.getElementById('share-btn').addEventListener('click', copyShareLink);