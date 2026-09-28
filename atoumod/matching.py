"""Map-matching des tracés GTFS (shapes) sur le réseau OSM, avec le serveur Valhalla local."""

from itertools import groupby

import requests

from .config import MAX_TRACE_M, VALHALLA_URL


def valhalla_ready():
    """Le serveur Valhalla répond-il ?"""
    try:
        requests.get(f"{VALHALLA_URL}/status", timeout=5)
        return True
    except requests.RequestException:
        return False


def map_match(shape_pts):
    """Voies suivies par le tracé GTFS, dans l'ordre, découpé en morceaux de MAX_TRACE_M."""
    ways = []
    part = (shape_pts["shape_dist_traveled"].astype(float) // MAX_TRACE_M).to_numpy()
    starts = [0] + [i for i in range(1, len(part)) if part[i] != part[i - 1]] + [len(part)]
    for start, end in zip(starts, starts[1:]):
        chunk = shape_pts.iloc[start:end + 1]  # 1 point de recouvrement entre morceaux
        payload = {"shape": [{"lat": float(a), "lon": float(b)} for a, b in zip(chunk["shape_pt_lat"], chunk["shape_pt_lon"])],
                   "costing": "bus", "shape_match": "map_snap",
                   "filters": {"attributes": ["edge.way_id"], "action": "include"}}
        res = requests.post(f"{VALHALLA_URL}/trace_attributes", json=payload, timeout=120).json()
        if "error" in res:  # rayon de recherche élargi si le tracé GTFS est imprécis
            payload["trace_options"] = {"search_radius": 50, "gps_accuracy": 20}
            res = requests.post(f"{VALHALLA_URL}/trace_attributes", json=payload, timeout=120).json()
        if "error" in res:
            raise RuntimeError(res["error"])
        ways += [f"w{e['way_id']}" for e in res["edges"]]
    return [w for w, _ in groupby(ways)]
