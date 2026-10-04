"""Map-matching of the GTFS variants on the OSM road network, with a local Valhalla server.

A variant is matched from its GTFS shape when it has one. The shape is rejected, and the variant routed
through its stops instead, when it is missing, when Valhalla cannot follow it, or when too many stops lie
far from the matched path (straight-line or misplaced shapes, which some producers publish).
"""

from __future__ import annotations

import logging
from itertools import groupby

import numpy as np
import requests

from .config import settings
from .geo import decode_polyline, distances_to_polyline, path_length

log = logging.getLogger(__name__)

MAX_ROUTE_LOCATIONS = 20  # Valhalla's default limit for a bus route request


class MatchError(RuntimeError):
    """Valhalla could not match or route a variant."""


def valhalla_ready():
    """Does the Valhalla server answer?"""
    try:
        requests.get(f"{settings.valhalla.url}/status", timeout=5).raise_for_status()
        return True
    except requests.RequestException:
        return False


def _post(action, payload):
    try:
        res = requests.post(f"{settings.valhalla.url}/{action}", json=payload, timeout=120)
        data = res.json()
    except (requests.RequestException, ValueError) as e:
        raise MatchError(f"Valhalla {action}: {e}") from e
    if "error" in data or not res.ok:
        raise MatchError(f"Valhalla {action}: {data.get('error', res.status_code)}")
    return data


def _chunks(points):
    """Index ranges [start, end] of consecutive chunks of points short enough for Valhalla, overlapping by
    one point."""
    th = settings.thresholds
    length = path_length(points)
    starts = [0]
    for i in range(1, len(points)):
        if length[i] - length[starts[-1]] > th.trace_m or i - starts[-1] >= th.trace_points:
            starts.append(i - 1 if i - 1 > starts[-1] else i)
    return [(s, e) for s, e in zip(starts, starts[1:] + [len(points) - 1]) if e > s] or [(0, len(points) - 1)]


def map_match(points):
    """(way keys "w123" followed in order, matched path [(lat, lon)]) of a [(lat, lon)] trace."""
    ways, path = [], []
    for start, end in _chunks(points):
        payload = {"shape": [{"lat": a, "lon": b} for a, b in points[start:end + 1]], "costing": "bus",
                   "shape_match": "map_snap",
                   "filters": {"attributes": ["edge.way_id", "shape"], "action": "include"}}
        try:
            res = _post("trace_attributes", payload)
        except MatchError:  # imprecise shape: wider search radius
            payload["trace_options"] = {"search_radius": 50, "gps_accuracy": 20}
            res = _post("trace_attributes", payload)
        ways += [f"w{e['way_id']}" for e in res.get("edges", []) if "way_id" in e]
        path += decode_polyline(res.get("shape", ""))
    if not ways:
        raise MatchError("no way matched")
    return [w for w, _ in groupby(ways)], path


def route_through(stops):
    """[(lat, lon)] path of a bus driving through the stops [(lat, lon)] in order."""
    path = []
    step = MAX_ROUTE_LOCATIONS - 1
    for start in range(0, max(len(stops) - 1, 1), step):
        chunk = stops[start:start + step + 1]
        # "break" rather than "through": a stop drawn on the wrong side of the road then costs a U-turn,
        # not a detour around the block
        locations = [{"lat": a, "lon": b, "type": "break"} for a, b in chunk]
        res = _post("route", {"locations": locations, "costing": "bus"})
        for leg in res["trip"]["legs"]:
            path += decode_polyline(leg["shape"])
    return path


def far_share(stops, path):
    """Share of the stops further than thresholds.stop_position_m from the path."""
    if not stops:
        return 0.0
    return float(np.mean(distances_to_polyline(stops, path) > settings.thresholds.stop_position_m))


def match_variant(shape, stops):
    """(ways, source) of a variant: shape [(lat, lon)] or None, stops [(lat, lon)] in order. source is
    "shape" or "stops" (routed through the stops because the shape is missing, unusable or wrong).
    MatchError if neither works."""
    max_far = settings.thresholds.max_far_stops
    best, reason = None, "no shape"
    if shape and len(shape) > 1:
        try:
            ways, path = map_match(shape)
            share = far_share(stops, path)
            if share <= max_far:
                return ways, "shape"
            best, reason = (share, ways, "shape"), f"{share:.0%} of the stops far from the shape"
        except MatchError as e:
            reason = str(e)
    try:
        ways, path = map_match(route_through(stops))
        share = far_share(stops, path)
        if best is None or share < best[0]:
            best = (share, ways, "stops")
    except MatchError as e:
        if best is None:
            raise MatchError(f"{reason}; routing through the stops failed: {e}") from e
    if best[2] == "stops":
        log.info("    routed through the stops (%s)", reason)
    return best[1], best[2]
