"""Complete existing OSM platforms with the GTFS stops of one network, without creating relations: each
GTFS stop is paired with the nearest OSM platform (within max_m, one platform per stop at most), to be
reviewed in JOSM.

Tags set: gtfs:stop_id:<feed>, gtfs:stop_name:<feed>, route_ref (routes of the network added to the
existing values), and wheelchair / bus when missing. The existing name is left unchanged.
"""

from __future__ import annotations

import logging
from collections import ChainMap

import geopandas as gpd
import pandas as pd

from .config import settings
from .gtfs import Feed, ref_sort_key
from .naming import agency_networks, slug
from .osm import read_ways, write_osm
from .stops import read_osm_stops, to_metric

log = logging.getLogger(__name__)

WHEELCHAIR = {"1": "yes", "2": "no"}


def network_stops(feed, network):
    """GeoDataFrame (metric CRS) of the GTFS stops served by the network, with their route_ref set."""
    networks = agency_networks(feed.agency)
    agencies = {a for a, tags in networks.items() if tags["network"].lower() == network.lower()}
    if not agencies:
        raise ValueError(f"unknown network {network!r}; available: "
                         + ", ".join(sorted({t["network"] for t in networks.values()})))
    routes = feed.routes[feed.routes["agency_id"].isin(agencies) & feed.routes["mode"].isin(settings.modes)]
    trips = feed.trips[feed.trips["route_id"].isin(routes["route_id"])]
    trip_ref = trips.set_index("trip_id")["route_id"].map(routes.set_index("route_id")["route_short_name"])
    st = feed.stop_times(trips["trip_id"])
    refs = st.assign(ref=st["trip_id"].map(trip_ref)).groupby("stop_id")["ref"].agg(lambda r: set(r) - {""})
    stops = feed.stops[feed.stops["stop_id"].isin(refs.index)].copy()
    stops["route_ref"] = stops["stop_id"].map(refs)
    return to_metric(gpd.GeoDataFrame(stops, crs="EPSG:4326", geometry=gpd.points_from_xy(stops["lon"], stops["lat"])))


def osm_platforms(crs):
    """OSM bus platforms (nodes and ways) of the extract, as centroids in crs."""
    osm = read_osm_stops().to_crs(crs)
    osm["geometry"] = osm.geometry.centroid
    pt = osm["public_transport"] if "public_transport" in osm else pd.Series(None, index=osm.index)
    return osm[osm["id"].str[0].isin(["n", "w"]) & (pt != "stop_position")][["id", "geometry"]]


def nearest_pairs(stops, platforms, max_m):
    """stop_id -> (platform, distance) of the nearest pairs, one to one: by increasing distance, each stop
    and each platform is taken once (two opposite stops do not end up on the same platform)."""
    pairs = gpd.sjoin(stops, platforms, predicate="dwithin", distance=max_m)
    pairs["distance"] = pairs.geometry.distance(platforms.loc[pairs["index_right"]].geometry, align=False).values
    used_stops, used_platforms, result = set(), set(), {}
    for r in pairs.sort_values("distance").itertuples():
        if r.stop_id not in used_stops and r.id not in used_platforms:
            used_stops.add(r.stop_id)
            used_platforms.add(r.id)
            result[r.stop_id] = (r.id, r.distance)
    return result


def feed_tags(tags, stop, feed_id):
    """Platform tags completed with the GTFS stop."""
    t = dict(tags)
    suffix = f":{feed_id}" if feed_id else ""
    t[f"gtfs:stop_id{suffix}"] = stop["stop_id"]
    t[f"gtfs:stop_name{suffix}"] = stop["stop_name"]
    refs = {r for r in t.get("route_ref", "").split(";") if r} | set(stop["route_ref"])
    if refs:
        t["route_ref"] = ";".join(sorted(refs, key=ref_sort_key))
    t.setdefault("bus", "yes")
    if stop["wheelchair_boarding"] in WHEELCHAIR:
        t.setdefault("wheelchair", WHEELCHAIR[stop["wheelchair_boarding"]])
    return t


def run(network, feed_id=None, max_m=30):
    """Write <output_dir>/<network>_platforms.osm and <network>_platforms_unmatched.csv; returns their
    paths."""
    feed_id = settings.feed if feed_id is None else feed_id
    log.info("Reading the GTFS stops of %s...", network)
    stops = network_stops(Feed(), network)
    log.info("Reading the OSM platforms...")
    matches = nearest_pairs(stops, osm_platforms(stops.crs), max_m)

    osm = read_ways({osm_id for osm_id, _ in matches.values()})
    obj = ChainMap({}, osm)  # modified platforms above the extract's objects (see osm.py)
    for _, stop in stops[stops["stop_id"].isin(matches)].iterrows():
        osm_id = matches[stop["stop_id"]][0]
        if osm_id not in osm:
            continue
        tags = feed_tags(osm[osm_id]["tags"], stop, feed_id)
        if tags != osm[osm_id]["tags"]:
            obj[osm_id] = {**osm[osm_id], "tags": tags}

    base = settings.output_dir / f"{slug(network)}_platforms"
    out, unmatched = base.with_suffix(".osm"), base.with_name(base.name + "_unmatched.csv")
    write_osm(obj, out)
    missing = stops[~stops["stop_id"].isin(matches)]
    missing[["stop_id", "stop_code", "stop_name", "stop_lat", "stop_lon"]].to_csv(unmatched, index=False)
    log.info("%d GTFS stops: %d paired with an OSM platform (<= %g m), %d platform(s) modified",
             len(stops), len(matches), max_m, len(obj.maps[0]))
    log.info("%d stop(s) without a nearby OSM platform -> %s", len(missing), unmatched)
    return out, unmatched
