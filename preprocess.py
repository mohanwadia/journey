"""
Melbourne Bus Reform - Network Preprocessing
==============================================
Converts a hand-drawn route GeoJSON (LineStrings with `route` + `corridor`
properties) into a static graph.json that the browser can load directly
into a Dijkstra router. No server needed at runtime.

Pipeline:
  1. Load routes, reproject to a metric CRS for accurate distance math.
  2. Find every pairwise route crossing, cluster near-misses within
     SNAP_TOLERANCE_M into a single canonical interchange point.
  3. Resample each route into stops: one every STOP_SPACING_M, plus a
     forced stop at every interchange point.
  4. Build the graph:
       - Every stop gets a HUB node (walk-accessible) and one ride-node
         per route serving it (uniform model — even single-route stops
         get this, for implementation simplicity; it costs us a few
         hundred extra nodes, which is irrelevant at this scale).
       - "board" edges (HUB -> route node): wait = frequency / 2
       - "alight" edges (route node -> HUB): 0 cost (trip end / walk away)
       - "transfer" edges (route node -> different route's node at the
         same stop): wait = frequency/2 + INTERCHANGE_PENALTY_MIN
         This is what actually distinguishes "first boarding" (via HUB,
         no penalty) from "transferring mid-journey" (direct edge,
         penalty applies) without needing path-history in the router.
       - "ride" edges: consecutive stops on the same route.
  5. Also export stops.json (id -> lat/lon) for the frontend's
     nearest-stop lookup on click.

Assumptions (change the constants below if you want different ones):
  - Corridor B1 = 5 min frequency, B2 = 10 min frequency
  - Average bus speed = 25 km/h (includes dwell time / stop-starts)
  - Walking speed = 80 m/min (4.8 km/h), constant per earlier decision
  - Stop spacing = 400 m on straight sections
  - Interchange snap tolerance = 25 m (crossings closer than this are
    treated as the same physical intersection)
  - Interchange penalty = 2 min, added on top of wait time when
    transferring to a different route at the same stop
"""

import json
import math
from dataclasses import dataclass, field
from itertools import combinations

from pyproj import Transformer
from shapely.geometry import LineString, Point
from shapely.ops import transform as shapely_transform

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

INPUT_GEOJSON = "/home/claude/work/Routes_FeaturesToJSON1_clean.geojson"
OUTPUT_GRAPH = "/home/claude/work/data/graph.json"
OUTPUT_ROUTES_DEBUG = "/home/claude/work/routes_with_stops_debug.geojson"

FREQ_BY_CORRIDOR = {"B1": 5.0, "B2": 10.0}  # minutes
BUS_SPEED_KMH = 25.0
WALK_SPEED_M_PER_MIN = 80.0
STOP_SPACING_M = 400.0
SNAP_TOLERANCE_M = 25.0
MIN_STOP_SEPARATION_M = 150.0  # don't place a regular stop this close to an interchange
INTERCHANGE_PENALTY_MIN = 2.0

# Melbourne sits in UTM/MGA zone 55S. EPSG:28355 (GDA94 / MGA zone 55) is
# accurate to fractions of a metre here, unlike raw lat/lon degrees.
WGS84 = "EPSG:4326"
METRIC = "EPSG:28355"

to_metric = Transformer.from_crs(WGS84, METRIC, always_xy=True).transform
to_wgs84 = Transformer.from_crs(METRIC, WGS84, always_xy=True).transform


# ---------------------------------------------------------------------------
# Step 1: Load + reproject
# ---------------------------------------------------------------------------

def load_routes(path):
    data = json.load(open(path))
    routes = {}
    for f in data["features"]:
        props = f["properties"]
        route_id = props["route"]
        corridor = props["corridor"]
        line_wgs = LineString(f["geometry"]["coordinates"])
        line_m = shapely_transform(to_metric, line_wgs)
        routes[route_id] = {
            "route_id": route_id,
            "corridor": corridor,
            "frequency_min": FREQ_BY_CORRIDOR[corridor],
            "line_m": line_m,
        }
    return routes


# ---------------------------------------------------------------------------
# Step 2: Find + cluster interchange points
# ---------------------------------------------------------------------------

class UnionFind:
    def __init__(self, n):
        self.parent = list(range(n))

    def find(self, x):
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[ra] = rb


def find_interchanges(routes):
    """Return list of {point: (x,y), routes: set(route_id)} in metric CRS."""
    raw_points = []  # (x, y, route_a, route_b)

    for a, b in combinations(routes.keys(), 2):
        line_a, line_b = routes[a]["line_m"], routes[b]["line_m"]
        if not line_a.intersects(line_b):
            continue
        inter = line_a.intersection(line_b)
        pts = []
        if inter.geom_type == "Point":
            pts = [inter]
        elif inter.geom_type == "MultiPoint":
            pts = list(inter.geoms)
        elif inter.geom_type in ("LineString", "MultiLineString"):
            # overlapping segments (routes running along the same street) -
            # skip; not a point interchange, out of scope for this pass
            continue
        for p in pts:
            raw_points.append((p.x, p.y, a, b))

    n = len(raw_points)
    uf = UnionFind(n)
    for i, j in combinations(range(n), 2):
        xi, yi = raw_points[i][0], raw_points[i][1]
        xj, yj = raw_points[j][0], raw_points[j][1]
        if math.hypot(xi - xj, yi - yj) <= SNAP_TOLERANCE_M:
            uf.union(i, j)

    clusters = {}
    for i in range(n):
        root = uf.find(i)
        clusters.setdefault(root, []).append(i)

    interchanges = []
    for members in clusters.values():
        xs = [raw_points[i][0] for i in members]
        ys = [raw_points[i][1] for i in members]
        cx, cy = sum(xs) / len(xs), sum(ys) / len(ys)
        route_set = set()
        for i in members:
            route_set.add(raw_points[i][2])
            route_set.add(raw_points[i][3])
        interchanges.append({"point": (cx, cy), "routes": route_set})

    return interchanges


# ---------------------------------------------------------------------------
# Step 3: Resample each route into stops
# ---------------------------------------------------------------------------

@dataclass
class Stop:
    stop_id: str
    x: float
    y: float
    is_interchange: bool
    routes: set = field(default_factory=set)


def build_stops(routes, interchanges):
    """
    Returns:
      stops: dict stop_id -> Stop
      route_stop_sequences: dict route_id -> [(stop_id, dist_along_route_m), ...]
    """
    stops = {}
    interchange_counter = 0
    route_stop_sequences = {}

    # Pre-project each interchange onto every route it touches, so we know
    # where along each route's cumulative distance it forces a stop.
    # interchange -> {route_id: dist_along_that_route}
    for ic in interchanges:
        ic["stop_id"] = f"IC{interchange_counter}"
        interchange_counter += 1
        ic["dist_on_route"] = {}
        px, py = ic["point"]
        p = Point(px, py)
        for r in ic["routes"]:
            ic["dist_on_route"][r] = routes[r]["line_m"].project(p)

    for route_id, route in routes.items():
        line = route["line_m"]
        total = line.length

        # forced (interchange) distances along this route
        forced = []
        for ic in interchanges:
            if route_id in ic["routes"]:
                forced.append((ic["dist_on_route"][route_id], ic["stop_id"], ic["point"]))
        forced.sort(key=lambda t: t[0])

        # regular candidate distances at fixed spacing
        n_regular = max(1, round(total / STOP_SPACING_M))
        regular_dists = [i * total / n_regular for i in range(n_regular + 1)]

        # drop regular candidates too close to a forced interchange stop
        forced_dists = [f[0] for f in forced]
        kept_regular = [
            d for d in regular_dists
            if all(abs(d - fd) > MIN_STOP_SEPARATION_M for fd in forced_dists)
        ]

        # merge + sort all stop placements for this route
        placements = [(d, "regular", None) for d in kept_regular] + \
                     [(d, "interchange", sid) for d, sid, _ in forced]
        placements.sort(key=lambda t: t[0])

        seq = []
        for dist, kind, forced_sid in placements:
            if kind == "interchange":
                sid = forced_sid
                if sid not in stops:
                    pt = next(p for d2, s2, p in forced if s2 == sid)
                    stops[sid] = Stop(sid, pt[0], pt[1], True, set())
                stops[sid].routes.add(route_id)
            else:
                pt = line.interpolate(dist)
                sid = f"{route_id}__S{len(seq)}"
                stops[sid] = Stop(sid, pt.x, pt.y, False, {route_id})
            seq.append((sid, dist))

        route_stop_sequences[route_id] = seq

    return stops, route_stop_sequences


# ---------------------------------------------------------------------------
# Step 4: Build the graph
# ---------------------------------------------------------------------------

def build_graph(routes, stops, route_stop_sequences):
    nodes = {}
    edges = []

    def add_node(node_id, stop_id, kind, route_id=None):
        s = stops[stop_id]
        lon, lat = to_wgs84(s.x, s.y)
        nodes[node_id] = {
            "id": node_id,
            "stop_id": stop_id,
            "lat": lat,
            "lon": lon,
            "type": kind,
            "route": route_id,
        }

    # HUB is split into IN (walk arrives here, can board) and OUT (route
    # nodes alight here, can only walk away - never board directly). If a
    # single shared HUB allowed both board and alight, the router could
    # "transfer" for free via alight -> HUB -> board, skipping the
    # interchange penalty entirely. IN -> OUT is a free one-way link (walk
    # straight through without boarding); there is deliberately no OUT ->
    # IN edge, so a same-stop transfer can ONLY happen via the explicit
    # "transfer" edge below, which carries the penalty.
    def hub_in_id(stop_id):
        return f"{stop_id}__HUB_IN"

    def hub_out_id(stop_id):
        return f"{stop_id}__HUB_OUT"

    def route_node_id(stop_id, route_id):
        return f"{stop_id}__{route_id}"

    for stop_id in stops:
        add_node(hub_in_id(stop_id), stop_id, "hub_in")
        add_node(hub_out_id(stop_id), stop_id, "hub_out")
        edges.append({"from": hub_in_id(stop_id), "to": hub_out_id(stop_id),
                       "type": "walk_through", "weight_min": 0})

    # Per-route ride nodes + board/alight/transfer edges
    for stop_id, stop in stops.items():
        hin, hout = hub_in_id(stop_id), hub_out_id(stop_id)
        served = sorted(stop.routes)
        for r in served:
            rnid = route_node_id(stop_id, r)
            add_node(rnid, stop_id, "route", route_id=r)
            freq = routes[r]["frequency_min"]

            # board: HUB_IN -> route node, no transfer penalty (first boarding)
            edges.append({"from": hin, "to": rnid, "type": "board",
                           "route": r, "weight_min": round(freq / 2, 3)})

            # alight: route node -> HUB_OUT, free (trip end / walk elsewhere)
            edges.append({"from": rnid, "to": hout, "type": "alight",
                           "route": r, "weight_min": 0})

        # transfer edges: direct route-to-route at the same stop, penalty applies
        for r_from in served:
            for r_to in served:
                if r_from == r_to:
                    continue
                freq_to = routes[r_to]["frequency_min"]
                edges.append({
                    "from": route_node_id(stop_id, r_from),
                    "to": route_node_id(stop_id, r_to),
                    "type": "transfer",
                    "route": r_to,
                    "weight_min": round(freq_to / 2 + INTERCHANGE_PENALTY_MIN, 3),
                })

    # Ride edges: consecutive stops on the same route.
    # All hand-drawn routes represent real, bidirectional bus corridors —
    # the LineString direction only reflects how it happened to be
    # digitized, not a one-way service. So for every consecutive stop pair
    # we add BOTH the forward edge (as drawn) and a mirrored reverse edge
    # with the same travel time. Without this, the router could only ever
    # ride each route in the direction it was drawn, which silently makes
    # roughly half of all real trips unreachable or absurdly indirect.
    for route_id, seq in route_stop_sequences.items():
        speed_m_per_min = BUS_SPEED_KMH * 1000 / 60
        for (sid_a, dist_a), (sid_b, dist_b) in zip(seq, seq[1:]):
            ride_min = (dist_b - dist_a) / speed_m_per_min
            edges.append({
                "from": route_node_id(sid_a, route_id),
                "to": route_node_id(sid_b, route_id),
                "type": "ride",
                "route": route_id,
                "weight_min": round(ride_min, 3),
            })
            edges.append({
                "from": route_node_id(sid_b, route_id),
                "to": route_node_id(sid_a, route_id),
                "type": "ride",
                "route": route_id,
                "weight_min": round(ride_min, 3),
            })

    return nodes, edges


# ---------------------------------------------------------------------------
# Step 5: Walk-transfer edges between nearby HUBs on different streets
# ---------------------------------------------------------------------------

def add_walk_transfer_edges(nodes, edges, stops, max_walk_m=500):
    """
    Connect HUBs on *different, non-crossing* routes that happen to sit
    close together (e.g. two roughly-parallel routes one block apart).
    Skipped where the two stops already share a route (that's what ride
    edges are for) - this is purely for transfers that Step 2's geometric
    crossing-detection wouldn't have found. Kept to a tight 200m radius
    and route-disjoint pairs only, so it doesn't explode edge count.
    """
    hub_stops = [(sid, s) for sid, s in stops.items()]
    added = 0
    for (sid_a, a), (sid_b, b) in combinations(hub_stops, 2):
        if a.routes & b.routes:
            continue  # already connected via ride/transfer edges
        d = math.hypot(a.x - b.x, a.y - b.y)
        if 0 < d <= max_walk_m:
            walk_min = d / WALK_SPEED_M_PER_MIN
            # OUT(A) -> IN(B): "I've alighted at A, walk to B, then board"
            edges.append({"from": f"{sid_a}__HUB_OUT", "to": f"{sid_b}__HUB_IN",
                           "type": "walk", "weight_min": round(walk_min, 3)})
            edges.append({"from": f"{sid_b}__HUB_OUT", "to": f"{sid_a}__HUB_IN",
                           "type": "walk", "weight_min": round(walk_min, 3)})
            added += 2
    return added


# ---------------------------------------------------------------------------
# Debug export: resampled stops as GeoJSON points, for visual QA
# ---------------------------------------------------------------------------

def export_debug_geojson(stops, path):
    features = []
    for sid, s in stops.items():
        lon, lat = to_wgs84(s.x, s.y)
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [lon, lat]},
            "properties": {
                "stop_id": sid,
                "is_interchange": s.is_interchange,
                "routes": sorted(s.routes),
            },
        })
    json.dump({"type": "FeatureCollection", "features": features}, open(path, "w"), indent=1)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    routes = load_routes(INPUT_GEOJSON)
    print(f"Loaded {len(routes)} routes")

    interchanges = find_interchanges(routes)
    print(f"Found {len(interchanges)} clustered interchange points "
          f"(snap tolerance {SNAP_TOLERANCE_M}m)")

    stops, route_stop_sequences = build_stops(routes, interchanges)
    n_interchange = sum(1 for s in stops.values() if s.is_interchange)
    print(f"Generated {len(stops)} stops ({n_interchange} interchange, "
          f"{len(stops) - n_interchange} regular)")

    nodes, edges = build_graph(routes, stops, route_stop_sequences)
    n_walk = add_walk_transfer_edges(nodes, edges, stops)
    print(f"Added {n_walk} walk-transfer edges between nearby hubs")
    print(f"Graph: {len(nodes)} nodes, {len(edges)} edges")

    graph = {
        "meta": {
            "bus_speed_kmh": BUS_SPEED_KMH,
            "walk_speed_m_per_min": WALK_SPEED_M_PER_MIN,
            "interchange_penalty_min": INTERCHANGE_PENALTY_MIN,
            "stop_spacing_m": STOP_SPACING_M,
        },
        "routes": {rid: {"frequency_min": r["frequency_min"], "corridor": r["corridor"]}
                   for rid, r in routes.items()},
        "nodes": nodes,
        "edges": edges,
    }
    json.dump(graph, open(OUTPUT_GRAPH, "w"))
    print(f"Wrote {OUTPUT_GRAPH}")

    export_debug_geojson(stops, OUTPUT_ROUTES_DEBUG)
    print(f"Wrote {OUTPUT_ROUTES_DEBUG} (open in geojson.io to sanity-check stop placement)")


if __name__ == "__main__":
    main()
