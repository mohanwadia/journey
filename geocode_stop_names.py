"""
Stop naming via OpenStreetMap — RUN THIS LOCALLY, NOT IN A SANDBOX.

Generates human-readable stop names like:
  "Cootamundra Dr / Ferntree Gully Rd"

...by reverse-geocoding each stop against the real OSM road network. For
each stop, it finds (a) the road the route is running along (nearest named
way, assumed to be the corridor itself) and (b) the nearest *different*
named road (assumed to be the cross street), using the Overpass API.

Requires internet access to https://overpass-api.de — this will NOT work
inside a network-locked sandbox. Run it on your own machine.

Usage:
    pip install requests
    python3 geocode_stop_names.py
    # writes site/data/stop_names.json  ->  { stop_id: "Cross St / Main Rd" }

This is decoupled from graph.json on purpose: if you redraw routes and
rerun preprocess.py, stop_ids can shift, so re-run this script afterward
to regenerate names rather than baking them into the graph.
"""

import json
import time
import requests

DEBUG_GEOJSON = "data/routes.geojson"
OUTPUT_PATH = "data/stop_names.json"
OVERPASS_URL = "https://overpass-api.de/api/interpreter"
SEARCH_RADIUS_M = 40          # how far to look for nearby named roads
REQUEST_DELAY_SEC = 1.0       # be polite to the free public Overpass instance


def query_nearby_roads(lat, lon, radius_m=SEARCH_RADIUS_M):
    """Return a list of (name, distance_m) for named roads near a point."""
    query = f"""
    [out:json][timeout:25];
    way(around:{radius_m},{lat},{lon})["highway"]["name"];
    out tags center;
    """
    resp = requests.post(OVERPASS_URL, data={"data": query}, timeout=30)
    resp.raise_for_status()
    elements = resp.json().get("elements", [])
    roads = []
    for el in elements:
        name = el.get("tags", {}).get("name")
        center = el.get("center")
        if not name or not center:
            continue
        # crude distance proxy in metres (fine at this scale)
        d = ((center["lat"] - lat) ** 2 + (center["lon"] - lon) ** 2) ** 0.5 * 111000
        roads.append((name, d))
    roads.sort(key=lambda r: r[1])
    return roads


def name_for_stop(lat, lon):
    roads = query_nearby_roads(lat, lon)
    if not roads:
        return None
    corridor = roads[0][0]
    cross = next((name for name, _ in roads if name != corridor), None)
    if cross:
        return f"{cross} / {corridor}"
    return corridor  # fallback: only one named road found nearby


def main():
    stops = json.load(open(DEBUG_GEOJSON))["features"]
    print(f"Geocoding {len(stops)} stops via Overpass — this will take a while "
          f"(~{len(stops) * REQUEST_DELAY_SEC / 60:.1f} min at {REQUEST_DELAY_SEC}s/stop)...")

    names = {}
    for i, f in enumerate(stops):
        stop_id = f["properties"]["stop_id"]
        lon, lat = f["geometry"]["coordinates"]
        try:
            name = name_for_stop(lat, lon)
            if name:
                names[stop_id] = name
        except Exception as e:
            print(f"  [{stop_id}] failed: {e}")
        if i % 25 == 0:
            print(f"  {i}/{len(stops)}...")
        time.sleep(REQUEST_DELAY_SEC)

    json.dump(names, open(OUTPUT_PATH, "w"), indent=1)
    print(f"Wrote {len(names)} stop names to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
