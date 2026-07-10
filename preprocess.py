"""
Melbourne Bus + Train Reform - adds real train lines from GTFS on top of the
existing hand-drawn bus network, without altering bus route lines or moving
any train station. All routes (bus + train) are set to a uniform 10 minute
frequency.

Train route lines and station positions come straight from the supplied
GTFS files (routes.txt, shapes.txt, stops.txt) - nothing is resampled or
redrawn for rail; the *only* stops trains get are their real GTFS stations
(location_type=1), projected onto the real GTFS shape for that line.
"""

from shapely.geometry import LineString, MultiLineString, Point
from shapely.ops import linemerge

import csv
import json
import math
from dataclasses import dataclass, field
from itertools import combinations

from pyproj import Transformer
from shapely.geometry import LineString, Point
from shapely.ops import transform as shapely_transform

BUS_GEOJSON = f"data/routes.geojson"
GTFS_ROUTES = f"gtfs/2/google_transit/routes.txt"
GTFS_SHAPES = f"gtfs/2/google_transit/shapes.txt"
GTFS_STOPS = f"gtfs/2/google_transit/stops.txt"
SRL_GEOJSON = f"data/srl.geojson"

OUTPUT_GRAPH = f"data/graph.json"
OUTPUT_ROUTES_GEOJSON = f"data/routes.geojson"
OUTPUT_STOPS_DEBUG = f"data/routes_with_stops_debug.geojson"

BUS_SPEED_KMH = 25.0
TRAIN_SPEED_KMH = 40.0         # express-ish average incl. dwell; only affects ride time, not lines/stops
SRL_SPEED_KMH = 62.0           # Suburban Rail Loop: modern underground metro, wider stop spacing
                                # than the legacy network, so a higher average incl. dwell is reasonable
WALK_SPEED_M_PER_MIN = 80.0
STOP_SPACING_M = 400.0          # bus resampling only, unchanged from original
SNAP_TOLERANCE_M = 25.0         # geometric line-crossing cluster tolerance (bus<->bus, bus<->rail)
STATION_SNAP_TOLERANCE_M = 80.0 # how close a real GTFS station must be to a rail shape to "belong" to it
MIN_STOP_SEPARATION_M = 150.0
INTERCHANGE_PENALTY_MIN = 2.0
TRAIN_FREQUENCY = 10
B1_FREQUENCY = 5
B2_FREQUENCY = 10
SRL_FREQUENCY = 5

WGS84 = "EPSG:4326"
METRIC = "EPSG:28355"  # GDA94 / MGA zone 55 - accurate for Melbourne

to_metric = Transformer.from_crs(WGS84, METRIC, always_xy=True).transform
to_wgs84 = Transformer.from_crs(METRIC, WGS84, always_xy=True).transform


# ---------------------------------------------------------------------------
# Load bus routes (unchanged lines, from the existing hand-drawn geojson)
# ---------------------------------------------------------------------------

def load_bus_routes(path):
    data = json.load(open(path))
    routes = {}
    for f in data["features"]:
        props = f["properties"]
        route_id = props["route"]
        corridor = props["corridor"]
        geom = f["geometry"]
        if geom["type"] == "MultiLineString":
            merged = linemerge(MultiLineString(geom["coordinates"]))
            if merged.geom_type != "LineString":
                raise ValueError(
                    f"Route {route_id} MultiLineString parts don't connect end-to-end "
                    f"(got {merged.geom_type}) — check the geometry for gaps."
                )
            line_wgs = merged
        else:
            line_wgs = LineString(geom["coordinates"])
        line_m = shapely_transform(to_metric, line_wgs)
        routes[route_id] = {
            "route_id": route_id,
            "corridor": corridor,
            "mode": "bus",
            "frequency_min": B1_FREQUENCY if corridor == 'B1' else B2_FREQUENCY,
            "speed_kmh": BUS_SPEED_KMH,
            "line_m": line_m,
            "line_wgs_coords": list(line_wgs.coords),
        }
    return routes


# ---------------------------------------------------------------------------
# Load train routes from GTFS: one real shape per route, real stations only
# ---------------------------------------------------------------------------

def gtfs_route_code(route_id):
    # "aus:vic:vic-02-ALM:" -> "ALM"
    core = route_id.strip(":").split(":")[-1]  # "vic-02-ALM"
    return core.split("-")[-1]


def load_gtfs_train_routes(routes_txt, shapes_txt, stops_txt):
    # 1. which route codes count as real train lines (skip rail-replacement buses)
    train_routes = {}
    with open(routes_txt, encoding="utf-8-sig") as fh:
        for row in csv.DictReader(fh):
            if row["route_short_name"] == "Replacement Bus":
                continue
            code = gtfs_route_code(row["route_id"])
            train_routes[code] = {
                "route_id": row["route_id"],
                "short_name": row["route_short_name"] or row["route_long_name"],
            }

    # 2. group shape points by shape_id
    shape_pts = {}
    with open(shapes_txt, encoding="utf-8-sig") as fh:
        for row in csv.DictReader(fh):
            shape_pts.setdefault(row["shape_id"], []).append(
                (int(row["shape_pt_sequence"]), float(row["shape_pt_lat"]), float(row["shape_pt_lon"]))
            )

    def shape_code(shape_id):
        parts = shape_id.split("-")
        return parts[1] if len(parts) > 1 else None

    def haversine_len(coords_latlon):
        R = 6371000
        total = 0.0
        for (lat1, lon1), (lat2, lon2) in zip(coords_latlon, coords_latlon[1:]):
            p1, p2 = math.radians(lat1), math.radians(lat2)
            dphi = math.radians(lat2 - lat1)
            dlmb = math.radians(lon2 - lon1)
            a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
            total += 2 * R * math.asin(math.sqrt(a))
        return total

    # 3. pick the longest shape for each route code -> canonical real line
    shapes_by_code = {}
    for shape_id, pts in shape_pts.items():
        code = shape_code(shape_id)
        if code not in train_routes:
            continue
        pts.sort(key=lambda t: t[0])
        coords_latlon = [(lat, lon) for _, lat, lon in pts]
        length = haversine_len(coords_latlon)
        best = shapes_by_code.get(code)
        if best is None or length > best[0]:
            shapes_by_code[code] = (length, coords_latlon)

    # 4. load real stations (location_type == '1' -> a real station, not a platform)
    stations = []
    with open(stops_txt, encoding="utf-8-sig") as fh:
        for row in csv.DictReader(fh):
            if row["location_type"] != "1":
                continue
            stations.append({
                "stop_id": row["stop_id"],
                "name": row["stop_name"],
                "lat": float(row["stop_lat"]),
                "lon": float(row["stop_lon"]),
            })

    # 5. build route dicts with metric LineStrings
    routes = {}
    for code, (length_m, coords_latlon) in shapes_by_code.items():
        meta = train_routes[code]
        line_wgs = LineString([(lon, lat) for lat, lon in coords_latlon])
        line_m = shapely_transform(to_metric, line_wgs)
        route_id = f"RAIL:{code}"
        routes[route_id] = {
            "route_id": route_id,
            "corridor": "RAIL",
            "mode": "rail",
            "frequency_min": TRAIN_FREQUENCY,
            "speed_kmh": TRAIN_SPEED_KMH,
            "line_m": line_m,
            "line_wgs_coords": list(line_wgs.coords),
            "gtfs_code": code,
            "short_name": meta["short_name"],
        }

    # 6. snap real stations onto every rail line they actually sit on
    #    (a station near several lines -> naturally becomes a shared/interchange stop)
    station_pts_m = []
    for st in stations:
        x, y = to_metric(st["lon"], st["lat"])
        station_pts_m.append((st, Point(x, y)))

    real_stops_by_route = {rid: [] for rid in routes}
    for rid, route in routes.items():
        line = route["line_m"]
        for st, pt in station_pts_m:
            d = line.distance(pt)
            if d <= STATION_SNAP_TOLERANCE_M:
                dist_on_route = line.project(pt)
                real_stops_by_route[rid].append(
                    (dist_on_route, st["stop_id"], pt.x, pt.y, st["name"])
                )
        real_stops_by_route[rid].sort(key=lambda t: t[0])

    return routes, real_stops_by_route


# ---------------------------------------------------------------------------
# Load the Suburban Rail Loop (SRL) from its own hand-drawn geojson. It has
# no GTFS data yet, so unlike the legacy rail lines, its real stops are just
# the line's own vertices (the geometry was digitized stop-to-stop) - the
# *only* stops SRL gets, no resampling, exactly like real GTFS stations.
# ---------------------------------------------------------------------------

def load_srl_route(path):
    data = json.load(open(path))
    feats = data["features"]
    if len(feats) != 1:
        raise ValueError(f"Expected exactly one SRL feature in {path}, found {len(feats)}")
    f = feats[0]
    props = f["properties"]
    geom = f["geometry"]

    if geom["type"] == "MultiLineString":
        merged = linemerge(MultiLineString(geom["coordinates"]))
        if merged.geom_type != "LineString":
            raise ValueError(
                f"SRL MultiLineString parts don't connect end-to-end "
                f"(got {merged.geom_type}) — check the geometry for gaps."
            )
        line_wgs = merged
    else:
        line_wgs = LineString(geom["coordinates"])

    line_m = shapely_transform(to_metric, line_wgs)
    route_id = "RAIL:SRL"

    route = {
        "route_id": route_id,
        "corridor": props.get("corridor", "SRL"),
        "mode": "rail",
        "frequency_min": SRL_FREQUENCY,
        "speed_kmh": SRL_SPEED_KMH,
        "line_m": line_m,
        "line_wgs_coords": list(line_wgs.coords),
        "gtfs_code": "SRL",
        "short_name": props.get("route", "SRL"),
    }

    # every vertex of the hand-drawn line is a real stop, in line order
    real_stops = []
    for i, (lon, lat) in enumerate(line_wgs.coords):
        x, y = to_metric(lon, lat)
        pt = Point(x, y)
        dist_on_route = line_m.project(pt)
        stop_id = f"SRL_S{i}"
        name = f"SRL Station {i + 1}"
        real_stops.append((dist_on_route, stop_id, x, y, name))
    real_stops.sort(key=lambda t: t[0])

    return {route_id: route}, {route_id: real_stops}


# ---------------------------------------------------------------------------
# Interchange detection (geometric line crossings) - same approach as
# preprocess.py, run across bus+rail together so bus<->rail crossings and
# bus<->bus crossings both still work exactly as before.
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
    raw_points = []
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
        clusters.setdefault(uf.find(i), []).append(i)

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

    for ic in interchanges:
        ic["dist_on_route"] = {}
        px, py = ic["point"]
        p = Point(px, py)
        for r in ic["routes"]:
            ic["dist_on_route"][r] = routes[r]["line_m"].project(p)

    return interchanges


# ---------------------------------------------------------------------------
# Build stops: bus keeps the original resample-every-400m approach; rail
# uses ONLY its real GTFS stations (no resampling, no moving anything).
# Geometric interchanges (bus<->bus, bus<->rail) are merged into whichever
# real stop already sits within SNAP_TOLERANCE_M, so a bus line crossing at
# an actual station reuses that station rather than minting a duplicate.
# ---------------------------------------------------------------------------

@dataclass
class Stop:
    stop_id: str
    x: float
    y: float
    is_interchange: bool
    routes: set = field(default_factory=set)


def build_stops(routes, interchanges, real_stops_by_route):
    stops = {}
    route_stop_sequences = {}

    # 1. seed real train stations first (their ids/positions are ground truth)
    for rid, entries in real_stops_by_route.items():
        for dist, sid, x, y, name in entries:
            if sid not in stops:
                stops[sid] = Stop(sid, x, y, False, set())
            stops[sid].routes.add(rid)

    def nearest_existing_stop(x, y, tol):
        best, best_d = None, tol
        for sid, s in stops.items():
            d = math.hypot(s.x - x, s.y - y)
            if d <= best_d:
                best, best_d = sid, d
        return best

    # 2. resolve interchange clusters, reusing a nearby real stop if one exists
    ic_counter = 0
    for ic in interchanges:
        px, py = ic["point"]
        existing = nearest_existing_stop(px, py, SNAP_TOLERANCE_M)
        if existing:
            ic["stop_id"] = existing
            stops[existing].is_interchange = True
            stops[existing].routes |= ic["routes"]
        else:
            # No real station already sits here. Rail/SRL stations can't be
            # moved or invented, so drop any rail routes from this cluster -
            # only bus routes may get a brand-new node at this crossing.
            ic["routes"] = {r for r in ic["routes"] if routes[r].get("mode") != "rail"}
            if not ic["routes"]:
                ic["stop_id"] = None
                continue
            sid = f"IC{ic_counter}"
            ic_counter += 1
            ic["stop_id"] = sid
            stops[sid] = Stop(sid, px, py, True, set(ic["routes"]))

    for rid, entries in real_stops_by_route.items():
        if len(entries) > 1:
            pass
    for sid, s in stops.items():
        if len(s.routes) > 1:
            s.is_interchange = True

    # 3. per-route stop sequences
    for route_id, route in routes.items():
        line = route["line_m"]
        total = line.length
        is_rail = route.get("mode") == "rail"

        forced = []
        for ic in interchanges:
            if route_id in ic["routes"]:
                forced.append((ic["dist_on_route"][route_id], ic["stop_id"]))

        if is_rail:
            for dist, sid, x, y, name in real_stops_by_route.get(route_id, []):
                forced.append((dist, sid))
        forced = sorted(set(forced), key=lambda t: t[0])
        forced_dists = [f[0] for f in forced]

        if is_rail:
            kept_regular = []
        else:
            n_regular = max(1, round(total / STOP_SPACING_M))
            regular_dists = [i * total / n_regular for i in range(n_regular + 1)]
            kept_regular = [
                d for d in regular_dists
                if all(abs(d - fd) > MIN_STOP_SEPARATION_M for fd in forced_dists)
            ]

        placements = [(d, "regular", None) for d in kept_regular] + \
                     [(d, "forced", sid) for d, sid in forced]
        placements.sort(key=lambda t: t[0])

        seq = []
        for dist, kind, forced_sid in placements:
            if kind == "forced":
                sid = forced_sid
                stops[sid].routes.add(route_id)
            else:
                pt = line.interpolate(dist)
                sid = f"{route_id}__S{len(seq)}"
                stops[sid] = Stop(sid, pt.x, pt.y, False, {route_id})
            seq.append((sid, dist))

        route_stop_sequences[route_id] = seq

    return stops, route_stop_sequences


# ---------------------------------------------------------------------------
# Build graph (identical structure/semantics to preprocess.py's build_graph)
# ---------------------------------------------------------------------------

def build_graph(routes, stops, route_stop_sequences):
    nodes = {}
    edges = []

    def add_node(node_id, stop_id, kind, route_id=None):
        s = stops[stop_id]
        lon, lat = to_wgs84(s.x, s.y)
        nodes[node_id] = {"id": node_id, "stop_id": stop_id, "lat": lat, "lon": lon, "type": kind, "route": route_id}

    def hub_in_id(stop_id):
        return f"{stop_id}__HUB_IN"

    def hub_out_id(stop_id):
        return f"{stop_id}__HUB_OUT"

    def route_node_id(stop_id, route_id):
        return f"{stop_id}__{route_id}"

    for stop_id in stops:
        add_node(hub_in_id(stop_id), stop_id, "hub_in")
        add_node(hub_out_id(stop_id), stop_id, "hub_out")
        edges.append({"from": hub_in_id(stop_id), "to": hub_out_id(stop_id), "type": "walk_through", "weight_min": 0})

    for stop_id, stop in stops.items():
        hin, hout = hub_in_id(stop_id), hub_out_id(stop_id)
        served = sorted(stop.routes)
        for r in served:
            rnid = route_node_id(stop_id, r)
            add_node(rnid, stop_id, "route", route_id=r)
            freq = routes[r]["frequency_min"]
            edges.append({"from": hin, "to": rnid, "type": "board", "route": r, "weight_min": round(freq / 2, 3)})
            edges.append({"from": rnid, "to": hout, "type": "alight", "route": r, "weight_min": 0})

        for r_from in served:
            for r_to in served:
                if r_from == r_to:
                    continue
                freq_to = routes[r_to]["frequency_min"]
                edges.append({
                    "from": route_node_id(stop_id, r_from), "to": route_node_id(stop_id, r_to),
                    "type": "transfer", "route": r_to,
                    "weight_min": round(freq_to / 2 + INTERCHANGE_PENALTY_MIN, 3),
                })

    for route_id, seq in route_stop_sequences.items():
        speed_m_per_min = routes[route_id]["speed_kmh"] * 1000 / 60
        for (sid_a, dist_a), (sid_b, dist_b) in zip(seq, seq[1:]):
            ride_min = (dist_b - dist_a) / speed_m_per_min
            edges.append({"from": route_node_id(sid_a, route_id), "to": route_node_id(sid_b, route_id),
                           "type": "ride", "route": route_id, "weight_min": round(ride_min, 3)})
            edges.append({"from": route_node_id(sid_b, route_id), "to": route_node_id(sid_a, route_id),
                           "type": "ride", "route": route_id, "weight_min": round(ride_min, 3)})

    return nodes, edges


def add_walk_transfer_edges(nodes, edges, stops, max_walk_m=500):
    hub_stops = list(stops.items())
    added = 0
    for (sid_a, a), (sid_b, b) in combinations(hub_stops, 2):
        if a.routes & b.routes:
            continue
        d = math.hypot(a.x - b.x, a.y - b.y)
        if 0 < d <= max_walk_m:
            walk_min = d / WALK_SPEED_M_PER_MIN
            edges.append({"from": f"{sid_a}__HUB_OUT", "to": f"{sid_b}__HUB_IN", "type": "walk", "weight_min": round(walk_min, 3)})
            edges.append({"from": f"{sid_b}__HUB_OUT", "to": f"{sid_a}__HUB_IN", "type": "walk", "weight_min": round(walk_min, 3)})
            added += 2
    return added


def export_routes_geojson(routes, path):
    features = []
    for rid, r in routes.items():
        features.append({
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": [list(c) for c in r["line_wgs_coords"]]},
            "properties": {"route": rid, "corridor": r["corridor"], "mode": r["mode"],
                            "short_name": r.get("short_name", rid)},
        })
    json.dump({"type": "FeatureCollection", "features": features}, open(path, "w"), indent=1)


def export_debug_geojson(stops, path):
    features = []
    for sid, s in stops.items():
        lon, lat = to_wgs84(s.x, s.y)
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [lon, lat]},
            "properties": {"stop_id": sid, "is_interchange": s.is_interchange, "routes": sorted(s.routes)},
        })
    json.dump({"type": "FeatureCollection", "features": features}, open(path, "w"), indent=1)


def main():
    import os
    os.makedirs(f"data", exist_ok=True)

    bus_routes = load_bus_routes(BUS_GEOJSON)
    print(f"Loaded {len(bus_routes)} bus routes (lines unchanged)")

    train_routes, real_stops_by_route = load_gtfs_train_routes(GTFS_ROUTES, GTFS_SHAPES, GTFS_STOPS)
    print(f"Loaded {len(train_routes)} train routes from GTFS")
    total_stations = len(set(sid for entries in real_stops_by_route.values() for _, sid, *_ in entries))
    print(f"Matched {total_stations} distinct real stations across those lines")

    srl_routes, srl_real_stops = load_srl_route(SRL_GEOJSON)
    print(f"Loaded {len(srl_routes)} SRL route ({len(next(iter(srl_real_stops.values())))} stops)")
    train_routes.update(srl_routes)
    real_stops_by_route.update(srl_real_stops)

    routes = {**bus_routes, **train_routes}

    interchanges = find_interchanges(routes)
    print(f"Found {len(interchanges)} clustered geometric interchange points")

    stops, route_stop_sequences = build_stops(routes, interchanges, real_stops_by_route)
    n_ic = sum(1 for s in stops.values() if s.is_interchange)
    print(f"Total stops: {len(stops)} ({n_ic} interchange, {len(stops) - n_ic} regular)")

    nodes, edges = build_graph(routes, stops, route_stop_sequences)
    n_walk = add_walk_transfer_edges(nodes, edges, stops)
    print(f"Added {n_walk} walk-transfer edges")
    print(f"Graph: {len(nodes)} nodes, {len(edges)} edges")

    graph = {
        "meta": {
            "bus_speed_kmh": BUS_SPEED_KMH,
            "train_speed_kmh": TRAIN_SPEED_KMH,
            "srl_speed_kmh": SRL_SPEED_KMH,
            "walk_speed_m_per_min": WALK_SPEED_M_PER_MIN,
            "interchange_penalty_min": INTERCHANGE_PENALTY_MIN,
            "stop_spacing_m": STOP_SPACING_M,
            "train_frequency": TRAIN_FREQUENCY,
            "B1_frequency": B1_FREQUENCY,
            "B2_frequency": B2_FREQUENCY
        },
        "routes": {rid: {"frequency_min": r["frequency_min"], "corridor": r["corridor"], "mode": r["mode"]}
                   for rid, r in routes.items()},
        "nodes": nodes,
        "edges": edges,
    }
    json.dump(graph, open(OUTPUT_GRAPH, "w"))
    print(f"Wrote {OUTPUT_GRAPH}")

    export_routes_geojson(routes, OUTPUT_ROUTES_GEOJSON)
    print(f"Wrote {OUTPUT_ROUTES_GEOJSON}")

    export_debug_geojson(stops, OUTPUT_STOPS_DEBUG)
    print(f"Wrote {OUTPUT_STOPS_DEBUG}")


if __name__ == "__main__":
    main()