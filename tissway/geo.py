"""Local geometry in an equirectangular projection around a point: accurate enough at the scale of a stop
or a junction.

Positions are (lat, lon) tuples in degrees, distances are in metres.
"""

from __future__ import annotations

import math

import numpy as np

M_PER_DEG_LAT = 110_574
M_PER_DEG_LON = 111_320  # at the equator


def xy(p, origin):
    """(x, y) of p in metres, relative to origin."""
    return ((p[1] - origin[1]) * M_PER_DEG_LON * math.cos(math.radians(origin[0])), (p[0] - origin[0]) * M_PER_DEG_LAT)


def dist(a, b):
    return math.hypot(*xy(a, b))


def project(p, a, b):
    """(t, distance) of the projection of p on the segment [a, b], t in [0, 1]."""
    (ax, ay), (bx, by) = xy(a, p), xy(b, p)
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, -(ax * dx + ay * dy) / (dx * dx + dy * dy))) if dx or dy else 0.0
    return t, math.hypot(ax + t * dx, ay + t * dy)


def interpolate(a, b, t):
    return a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])


def latlon(o):
    """(lat, lon) of an OSM node or a GTFS stop."""
    return o["lat"], o["lon"]


def line_distance(p, a, b):
    """Distance from p to the line through a and b (not clamped to the segment), in metres."""
    (ax, ay), (bx, by) = xy(a, p), xy(b, p)
    length = math.hypot(bx - ax, by - ay)
    return abs(ax * by - ay * bx) / length if length else math.hypot(ax, ay)


def right_of(p, a, b):
    """Is p on the right of the directed segment a -> b (direction of travel on the way)?"""
    (ax, ay), (bx, by) = xy(a, p), xy(b, p)
    return ax * by - ay * bx < 0


def path_length(points):
    """Cumulative length (metres) at each point of a [(lat, lon)] polyline."""
    pts = np.asarray(points, dtype=float).reshape(-1, 2)
    if len(pts) < 2:
        return np.zeros(len(pts))
    lat = np.radians(pts[:, 0])
    dy = np.diff(pts[:, 0]) * M_PER_DEG_LAT
    dx = np.diff(pts[:, 1]) * M_PER_DEG_LON * np.cos((lat[1:] + lat[:-1]) / 2)
    return np.concatenate([[0.0], np.cumsum(np.hypot(dx, dy))])


def distances_to_polyline(points, polyline):
    """Distance (metres) from each (lat, lon) of points to the nearest segment of polyline."""
    pts = np.asarray(points, dtype=float).reshape(-1, 2)
    line = np.asarray(polyline, dtype=float).reshape(-1, 2)
    if not len(pts):
        return np.zeros(0)
    if not len(line):
        return np.full(len(pts), np.inf)
    if len(line) == 1:
        line = np.vstack([line, line])
    k = M_PER_DEG_LON * np.cos(np.radians(pts[:, 0]))[:, None]  # (n, 1)
    ax = (line[None, :-1, 1] - pts[:, None, 1]) * k
    ay = (line[None, :-1, 0] - pts[:, None, 0]) * M_PER_DEG_LAT
    bx = (line[None, 1:, 1] - pts[:, None, 1]) * k
    by = (line[None, 1:, 0] - pts[:, None, 0]) * M_PER_DEG_LAT
    dx, dy = bx - ax, by - ay
    norm = dx * dx + dy * dy
    with np.errstate(invalid="ignore", divide="ignore"):
        t = np.where(norm > 0, np.clip(-(ax * dx + ay * dy) / norm, 0, 1), 0)
    return np.hypot(ax + t * dx, ay + t * dy).min(axis=1)


def decode_polyline(encoded, precision=6):
    """[(lat, lon)] of an encoded polyline (Valhalla uses precision 6)."""
    coords, index, lat, lon = [], 0, 0, 0
    factor = 10 ** precision
    while index < len(encoded):
        for axis in (0, 1):
            shift, result = 0, 0
            while True:
                b = ord(encoded[index]) - 63
                index += 1
                result |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            delta = ~(result >> 1) if result & 1 else result >> 1
            if axis == 0:
                lat += delta
            else:
                lon += delta
        coords.append((lat / factor, lon / factor))
    return coords
