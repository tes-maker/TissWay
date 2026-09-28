"""Géométrie en projection locale (équirectangulaire autour d'un point), suffisante à l'échelle d'un
arrêt ou d'un carrefour.

Les positions sont des tuples (lat, lon) en degrés, les distances en mètres.
"""

import math


def xy(p, origin):
    return ((p[1] - origin[1]) * 111_320 * math.cos(math.radians(origin[0])), (p[0] - origin[0]) * 110_574)


def dist(a, b):
    return math.hypot(*xy(a, b))


def project(p, a, b):
    """(t, distance) de la projection de p sur le segment [a, b]."""
    (ax, ay), (bx, by) = xy(a, p), xy(b, p)
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, -(ax * dx + ay * dy) / (dx * dx + dy * dy))) if dx or dy else 0.0
    return t, math.hypot(ax + t * dx, ay + t * dy)


def latlon(o):
    """(lat, lon) d'un nœud OSM ou d'un arrêt GTFS."""
    return o["lat"], o["lon"]


def right_of(p, a, b):
    """p est-il à droite du segment orienté a -> b (sens de progression sur la voie) ?"""
    (ax, ay), (bx, by) = xy(a, p), xy(b, p)
    return ax * by - ay * bx < 0
