"""GTFS stops and their candidate OSM platforms.

Each GTFS stop (a stop_id = the platform of one direction, ideally) is related to:
- nearby OSM platforms (candidates), preferring those already carrying its stop_id;
- the other GTFS platforms of the same stop (the opposite stop): stops sharing a parent_station, or, for
  feeds without stations, stops whose stop_code only differs by a trailing letter (12A / 12B) and that are
  served by a common agency, or, without either, any stop very close by;
- its rivals: the opposite stops and the stops of the same name nearby, one of which may own an existing
  stop_position on the road this stop's routes use (see platforms.locate_stop).
"""

from __future__ import annotations

import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

import geopandas as gpd
import pandas as pd

from .config import settings
from .naming import name_key

METRIC_CRS = "EPSG:3857"  # fallback of to_metric for an empty frame


def osm_stops_cache():
    """Path of the cache of the OSM bus stops and platforms (GeoJSON sequence), extracted from the OSM
    extract with osmium, again whenever the extract is newer than the cache."""
    cache, pbf = Path(settings.stops_cache), Path(settings.pbf)
    if not cache.is_file() or (pbf.is_file() and pbf.stat().st_mtime > cache.stat().st_mtime):
        with tempfile.TemporaryDirectory() as tmp:
            filtered = Path(tmp, "stops.osm.pbf")
            subprocess.run(["osmium", "tags-filter", str(settings.pbf), "n/highway=bus_stop",
                            "nw/public_transport=platform", "-o", str(filtered), "--overwrite"], check=True)
            subprocess.run(["osmium", "export", str(filtered), "-f", "geojsonseq", "--add-unique-id=type_id",
                            "-o", str(cache), "--overwrite"], check=True)
    return cache


def to_metric(gdf):
    """GeoDataFrame in a local metric CRS (UTM zone of its centre): accurate distances anywhere."""
    return gdf.to_crs(gdf.estimate_utm_crs() if len(gdf) else METRIC_CRS)


def sibling_code(stop_code):
    """Code shared by the platforms of one stop: the stop_code without its trailing letter ("2702282A" ->
    "2702282"), None if the code does not have that form."""
    if len(stop_code) > 1 and stop_code[-1].isalpha() and not stop_code[:-1].isalpha():
        return stop_code[:-1]
    return None


@dataclass
class Stops:
    """GTFS stops (df indexed by stop_id, with lat / lon) and their neighbours, see match_stops."""
    df: pd.DataFrame
    # stop_id -> candidate OSM platforms [{"id": "n123"/"w456", "pos", "name", "holder", "far"}]: within
    # thresholds.platform_m, or within thresholds.holder_m if they already carry this stop_id (holder=True),
    # or within thresholds.platform_far_m / platform_same_name_m (same name) with far=True, to be checked
    # against the road (platforms.verified), when no GTFS stop of another name is clearly closer to them
    platforms: dict
    neighbours: dict  # stop_id -> other GTFS platforms of the same stop (opposite stop)
    holders: dict  # stop_id -> OSM platforms already carrying it (gtfs:stop_id*, settings.stop_ref_tags)
    rivals: dict = field(default_factory=dict)  # stop_id -> neighbours + same-name stops nearby

    def positions(self, stop_ids):
        return [(self.df.at[s, "lat"], self.df.at[s, "lon"]) for s in stop_ids]


def _holders(osm):
    prefixes = ("gtfs:stop_id", *settings.stop_ref_tags)
    holders = {}
    for col in [c for c in osm.columns if c.startswith(prefixes)]:
        for osm_id, value in osm[col].dropna().items():
            for stop_id in str(value).split(";"):
                holders.setdefault(stop_id.strip(), set()).add(osm.at[osm_id, "id"])
    return holders


def match_stops(stops, agencies=None, osm=None):
    """Stops of every GTFS stop (not only those of the selected routes). stops: Feed.stops; agencies:
    stop_id -> agency_ids serving it (Feed.stop_agencies), used to keep stop codes of different networks of
    an aggregated feed apart; osm: GeoDataFrame of the OSM stops (default: read from the cache)."""
    th = settings.thresholds
    if osm is None:
        osm = gpd.read_file(osm_stops_cache())
    holders = _holders(osm)
    # a stop_position (even tagged highway=bus_stop) is never a platform
    pt = osm["public_transport"] if "public_transport" in osm else pd.Series(None, index=osm.index)
    osm = osm[osm["id"].str[0].isin(["n", "w"]) & (pt != "stop_position")].copy()
    if "name" not in osm:
        osm["name"] = None

    stops = stops.set_index("stop_id")
    gdf = to_metric(gpd.GeoDataFrame({"stop_id": stops.index}, crs="EPSG:4326",
                                   geometry=gpd.points_from_xy(stops["lon"], stops["lat"])))
    osm = osm.to_crs(gdf.crs)
    osm["geometry"] = osm.geometry.centroid
    ll = osm.geometry.to_crs("EPSG:4326")
    osm = osm.assign(lat=ll.y, lon=ll.x)[["id", "name", "geometry", "lat", "lon"]]

    platforms = {s: [] for s in stops.index}
    if len(osm):
        reach = max(th.holder_m, th.platform_far_m, th.platform_same_name_m)
        pairs = gpd.sjoin(gdf, osm, predicate="dwithin", distance=reach)
        pairs["d"] = pairs.geometry.distance(osm.loc[pairs["index_right"], "geometry"].set_axis(pairs.index))
        pairs["key"] = stops.loc[pairs["stop_id"], "stop_name"].map(name_key).to_numpy()
        pairs["same"] = pairs["key"] == pairs["name"].map(lambda n: name_key(n) if isinstance(n, str) else None)
        # distance from each OSM platform to its nearest GTFS stop of another name than the pair's stop: the
        # nearest of all, or the second nearest name when the nearest has the pair's name
        by_name = pairs.groupby(["index_right", "key"], as_index=False)["d"].min().sort_values("d")
        first = by_name.groupby("index_right").nth(0).set_index("index_right")
        second = by_name.groupby("index_right").nth(1).set_index("index_right")["d"]
        first_key = pairs["index_right"].map(first["key"])
        pairs["other"] = pairs["index_right"].map(first["d"]).where(
            first_key != pairs["key"], pairs["index_right"].map(second)).fillna(float("inf"))
        for r in pairs.itertuples():
            holder = r.id in holders.get(r.stop_id, ())
            # beyond platform_m, the platform of another stop is likely: only if no stop of another name is
            # clearly closer to it (stops of the same name, both directions included, are left to the side
            # check of platforms.verified)
            far = not holder and r.d > th.platform_m
            alone = r.d <= r.other + th.duplicate_stop_m
            if holder or r.d <= th.platform_m or (
                    alone and r.d <= (th.platform_same_name_m if r.same else th.platform_far_m)):
                name = r.name if isinstance(r.name, str) else None
                platforms[r.stop_id].append({"id": r.id, "pos": (r.lat, r.lon), "name": name, "holder": holder,
                                             "far": far})

    parent = stops["parent_station"]
    code = stops["stop_code"].map(sibling_code)
    key = stops["stop_name"].map(name_key)
    agencies = agencies or {}
    neighbours = {s: [] for s in stops.index}
    rivals = {s: [] for s in stops.index}
    pairs = gpd.sjoin(gdf, gdf, predicate="dwithin", distance=th.sibling_m)
    pairs = pairs[pairs["stop_id_left"] != pairs["stop_id_right"]]
    for r in pairs.itertuples():
        a, b = r.stop_id_left, r.stop_id_right
        if parent[a]:
            sibling = parent[a] == parent[b]
        elif code[a]:
            shared = agencies.get(a, frozenset()) & agencies.get(b, frozenset())
            sibling = code[a] == code[b] and bool(shared or not agencies.get(a) or not agencies.get(b))
        else:
            sibling = r.geometry.distance(gdf.geometry.iloc[r.index_right]) <= th.opposite_stop_m
        if sibling:
            neighbours[a].append(b)
        if sibling or (key[a] and key[a] == key[b]):
            rivals[a].append(b)
    return Stops(stops, platforms, neighbours, holders, rivals)
