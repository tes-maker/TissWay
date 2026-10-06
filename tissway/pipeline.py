"""Full run: GTFS -> map-matched variants -> PTv2 relations -> .osm file.

Steps of run():
1. selection of the routes (network, route numbers) in the GTFS;
2. GTFS stops related to the OSM platforms (stops.match_stops);
3. map-matching of each variant with Valhalla (matching.match_variant);
4. reading of the travelled ways and candidate platforms in the extract;
5. relations of each line (build.build_line), existing ones updated in place (existing.py), with the
   network:wikidata / network:wikipedia of the existing relations when the profile has none (with_wikis),
   then GTFS and network tags of the platforms (platforms.tag_platforms);
6. ways split where routes enter or leave them (streets, roundabouts, termini), once for all the lines,
   existing relations updated (splitting.split_ways);
7. a single .osm file is written (objects shared between lines: no conflict on upload).
"""

from __future__ import annotations

import logging
from collections import ChainMap
from itertools import groupby

import requests

from .build import build_line
from .config import settings
from .existing import WIKI_KEYS, ExistingRoutes
from .gtfs import Feed, line_variants, ref_sort_key, stop_sequences
from .matching import MatchError, match_variant, valhalla_ready
from .naming import agency_networks, clean_stop_name, line_label, slug
from .osm import read_ways, write_osm
from .platforms import filter_road_platforms, tag_platforms
from .splitting import split_ways
from .stops import match_stops

log = logging.getLogger(__name__)


class SelectionError(Exception):
    """Unknown network or route (the message lists the possible values)."""


def select_routes(routes, networks, network=None, refs=()):
    """Routes to generate, sorted by number: those of settings.modes, of the network (value of the network
    tag, case-insensitive) and / or with these numbers (route_short_name, or route_id). SelectionError if a
    network or a number is unknown."""
    routes = routes[routes["mode"].isin(settings.modes)]
    if network:
        wanted = network.strip().lower()
        routes = routes[routes["agency_id"].map(lambda a: networks.get(a, {}).get("network", "").lower() == wanted)]
        if routes.empty:
            raise SelectionError(f"No {'/'.join(settings.modes)} route in network '{network}'. Available "
                                 "networks: " + ", ".join(sorted({n["network"] for n in networks.values()})))
    if refs:
        known = set(routes["route_short_name"]) | set(routes["route_id"])
        unknown = [r for r in refs if r not in known]
        if unknown:
            available = sorted(set(routes["route_short_name"]) - {""}, key=ref_sort_key)
            raise SelectionError(f"Unknown route(s){f' in network {network!r}' if network else ''}: "
                                 f"{', '.join(unknown)}. Available routes: {', '.join(available)}")
        routes = routes[routes["route_short_name"].isin(refs) | routes["route_id"].isin(refs)]
    return routes.sort_values("route_short_name", key=lambda s: s.map(ref_sort_key))


def map_lines(feed, routes, trips, stops):
    """[(route, variants)]: for each route, its map-matched variants {"direction", "seq", "shape_id",
    "trip_id", "ways", "source"}. Variants Valhalla cannot match are reported and skipped, as are routes
    without any variant."""
    pending = [(route, list(line_variants(trips[trips["route_id"] == route["route_id"]])))
               for _, route in routes.iterrows()]
    shapes = feed.shapes({shape_id for _, vs in pending for _, _, shape_id, _ in vs if shape_id})
    lines = []
    for route, found in pending:
        label = route["route_short_name"] or route["route_id"]
        variants = []
        for direction_id, seq, shape_id, trip_id in found:
            try:
                ways, source = match_variant(shapes.get(shape_id), stops.positions(seq))
            except (MatchError, requests.RequestException) as e:
                log.warning("  line %s, trip %s skipped: %s", label, trip_id, e)
                continue
            variants.append({"direction": direction_id, "seq": seq, "shape_id": shape_id, "trip_id": trip_id,
                             "ways": ways, "source": source})
        if variants:
            lines.append((route, variants))
        else:
            log.warning("  line %s skipped: no variant could be map-matched", label)
    return lines


def output_path(network, refs):
    """<output_dir>/<network|output_name>[_<routes>].osm"""
    name = slug(network) if network else slug(settings.output_name) or "gtfs"
    return settings.output_dir / f"{'_'.join([name, *map(slug, refs)])}.osm"


def with_wikis(networks, wikis):
    """networks (agency_id -> network tags) completed with the network:wikidata / network:wikipedia of
    the existing OSM relations (wikis: see existing.network_wikis), for the keys the profile does not set.
    Nothing is taken when the profile gives another network:wikidata (another entity)."""
    out = {}
    for agency_id, tags in networks.items():
        known = wikis.get(tags["network"], {})
        if tags.get("network:wikidata", known.get("network:wikidata")) != known.get("network:wikidata"):
            known = {}  # the profile names another entity: nothing taken from OSM
        out[agency_id] = {**tags, **{k: v for k, v in known.items() if k not in tags}}
        added = sorted(set(out[agency_id]) - set(tags))
        if added:
            log.info("%s: %s taken from the existing OSM relations", tags["network"],
                     ", ".join(f"{k}={out[agency_id][k]}" for k in added))
    return out


def complete_wikis(obj, networks):
    """Add the network:wikidata / network:wikipedia of the known networks (networks: agency_id -> network
    tags) to the objects of the output file (obj.maps[0]: our relations and platforms, and the existing
    relations updated by the split ways) that lack them: route relations, route masters and platforms whose
    network, network:2... is one of them; the wiki keys get the same suffix. Values already set are kept.
    Returns the number of objects completed."""
    wikis = {t["network"]: {k: t[k] for k in WIKI_KEYS if t.get(k)} for t in networks.values() if t.get("network")}
    done = 0
    for key, o in obj.maps[0].items():
        tags = o.get("tags", {})
        if tags.get("type") not in ("route", "route_master") and tags.get("public_transport") != "platform":
            continue
        added = {f"{k}{suffix}": v for suffix in ("", *(f":{i}" for i in range(2, 10)))
                 for k, v in wikis.get(tags.get(f"network{suffix}"), {}).items() if f"{k}{suffix}" not in tags}
        if added:
            obj[key] = {**o, "tags": {**tags, **added}}
            done += 1
    return done


def run(network=None, refs=()):
    """Write the .osm file of the requested routes (all of them by default) and return its path.
    SelectionError if the network or a route is unknown, RuntimeError if Valhalla does not answer."""
    feed = Feed()
    networks = agency_networks(feed.agency)
    routes = select_routes(feed.routes, networks, network, refs)

    stops_df = feed.stops.assign(stop_name=lambda df: df["stop_name"].map(clean_stop_name))
    known = set(stops_df["stop_id"])
    trips = feed.trips[feed.trips["route_id"].isin(routes["route_id"])]
    stop_times = feed.stop_times(trips["trip_id"])
    unknown = stop_times.loc[~stop_times["stop_id"].isin(known), "stop_id"].unique()
    if len(unknown):
        log.warning("%d stop_id(s) of stop_times missing from stops.txt (skipped): %s",
                    len(unknown), ", ".join(unknown[:10]))
    trips = stop_sequences(trips, stop_times[stop_times["stop_id"].isin(known)])

    log.info("Matching GTFS stops with OSM platforms...")
    stops = match_stops(stops_df, feed.stop_agencies())
    used = sorted({s for seq in trips["stop_seq"] for s in seq})  # labels: stops of the selected routes only
    stops.df["label"] = stops.df["stop_name"]
    stops.df.loc[used, "label"] = [line_label(i, stops.df.at[i, "stop_name"], stops.positions([i])[0]) for i in used]

    if not valhalla_ready():
        raise RuntimeError(f"Valhalla does not answer on {settings.valhalla.url}: start it "
                           f"(docker start {settings.valhalla.container}).")
    log.info("Map-matching...")
    lines = map_lines(feed, routes, trips, stops)

    log.info("Reading ways and platforms from the extract...")
    osm = read_ways({w for _, variants in lines for v in variants for w in v["ways"]}
                    | {c["id"] for _, variants in lines for v in variants for s in v["seq"]
                       for n in [s, *stops.neighbours[s]] for c in stops.platforms[n]})

    variants = [v for _, vs in lines for v in vs]
    for v in variants:  # ways missing from the extract (neighbours outside it) ignored
        v["ways"] = [w for w, _ in groupby(w for w in v["ways"] if w in osm)]
    # a node of a travelled way (legacy highway=bus_stop on the carriageway) is a stop_position, not a
    # platform
    road_nodes = {n for v in variants for w in v["ways"] for n in osm[w]["nodes"]}
    stops.platforms = filter_road_platforms(stops.platforms, road_nodes, osm)

    # modified objects shared by all the lines: a single file avoids conflicts between lines (split ways,
    # shared platforms and stop_positions)
    obj = ChainMap({}, osm)

    existing = None
    if settings.update_existing or settings.network_wiki_from_osm:
        log.info("Reading the existing route relations...")
        existing = ExistingRoutes.load()
    if settings.network_wiki_from_osm:
        used = {route["agency_id"] for route, _ in lines}
        networks = {**networks, **with_wikis({a: t for a, t in networks.items() if a in used}, existing.wikis)}
    if not settings.update_existing:
        existing = None
    assignments, created = {}, {}
    for route, route_variants in lines:
        network_tags = networks.get(route["agency_id"]) or {"network": route["agency_id"] or "GTFS"}
        build_line(route, route_variants, obj, stops, network_tags, assignments, created, existing)
    for x in tag_platforms(obj, stops, assignments):
        log.warning("stop_id already on another OSM platform, not set (to check): %s", x)
    # after the relations: ways are also cut at the stop_positions of the termini
    n_ways, n_closed, n_rels = split_ways(obj)
    log.info("%d way(s) split, of which %d roundabout(s) / closed way(s); %d existing OSM relation(s) updated",
             n_ways, n_closed, n_rels)
    n = complete_wikis(obj, networks)
    if n:
        log.info("network:wikidata / network:wikipedia completed on %d relation(s) / platform(s)", n)

    path = output_path(network, refs)
    write_osm(obj, path)
    return path
