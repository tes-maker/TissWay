"""The stops of a route on the ground: a stop_position on the way and a platform beside it.

Rules:
- every stop gets a stop_position and a platform;
- the stop_position lies on the travelled way, at the projection of the GTFS stop. It is placed in two
  steps: locate_stop finds the spot without changing anything, and materialize creates the node there or
  reuses an existing stop_position. Splitting them lets the caller fix the side of the stop (fix_side)
  before anything is written;
- an existing stop_position is reused when it is near the projection of the stop, unless it is closer to
  the projection of a rival stop across the road (the opposite platform, or a stop of the same name). On a
  two-way road both directions are often drawn as one way, and the stop_position of the opposite stop may
  be within reach. Taking it would put both directions at the same spot, so a new stop_position is created,
  closer on the way (see _reusable);
- a stop_position only carries public_transport=stop_position, <vehicle>=yes and name
  (stop_position_tags): it is shared by every route on that way, whatever its network;
- the platform is chosen on the kerb side of the way (settings.driving_side) in the direction of travel;
- when the GTFS attaches the route to the opposite platform (a common error), the data of the other GTFS
  platform of the same stop is used instead (fix_side);
- a GTFS stop_id is set on a single OSM platform (tag_platforms), even when the GTFS has a single stop for
  both directions;
- tags of another network are never overwritten (add_tag, enrich).
"""

from __future__ import annotations

from dataclasses import dataclass
from itertools import chain, count

from .config import settings
from .geo import dist, interpolate, latlon, project, right_of
from .osm import edit, is_new, new_key

VEHICLE = {"bus": "bus", "coach": "bus", "trolleybus": "trolleybus"}
OTHER_VEHICLES = ("tram", "train", "subway", "light_rail", "monorail", "ferry", "funicular")


def kerb_side(p, a, b):
    """Is p on the kerb side (right, or left in left-hand traffic) of the directed segment a -> b?"""
    return right_of(p, a, b) != (settings.driving_side == "left")


# --- stop_position ---------------------------------------------------------------------------------------

@dataclass
class Spot:
    """Where a stop_position goes on ways[way_index]: an existing stop_position (node), or a new node at pos
    on the segment a -> b (node keys) of that way."""
    way_index: int
    pos: tuple
    distance: float  # GTFS stop -> way
    node: str | None = None
    a: str | None = None
    b: str | None = None


def is_stop_position_for(tags, vehicle="bus"):
    """Can a node with these tags serve as a stop_position for vehicle?"""
    if tags.get("public_transport") != "stop_position" or tags.get(vehicle) == "no":
        return False
    return tags.get(vehicle) == "yes" or not any(tags.get(v) == "yes" for v in OTHER_VEHICLES)


def _nearest_on(obj, way_keys, p):
    """(distance, projected point, segment (a, b) positions) of p on the nearest segment of these ways."""
    best = (float("inf"), None, None)
    for w in way_keys:
        nodes = obj[w]["nodes"]
        for a, b in zip(nodes, nodes[1:]):
            pa, pb = latlon(obj[a]), latlon(obj[b])
            t, d = project(p, pa, pb)
            if d < best[0]:
                best = (d, interpolate(pa, pb, t), (pa, pb))
    return best


def _rival_points(obj, way_keys, pos, target, rivals):
    """Projections on these ways of the rivals of the stop at pos (projected at target) that stand across
    the road and are offset along it by more than thresholds.stop_position_shared_m. Rivals on the same
    side are the same platform for another network (aggregated feeds); face-to-face rivals share the
    stop_position."""
    th = settings.thresholds
    points = []
    for r in rivals:
        if dist(r, pos) <= th.duplicate_stop_m:
            continue
        d, point, (a, b) = _nearest_on(obj, way_keys, r)
        if (d <= th.stop_position_m and right_of(r, a, b) != right_of(pos, a, b)
                and dist(point, target) > th.stop_position_shared_m):
            points.append(point)
    return points


def _reusable(obj, ways, run, pos, target, rivals, vehicle):
    """(way index, node) of the existing stop_position of the run of ways to reuse for a stop at pos whose
    projection on the way is target, or None.

    Within thresholds.stop_position_shared_m of target, a stop_position is always reused. Further, up to
    thresholds.stop_position_reuse_m, it is left to a rival across the road, offset along it, whose
    projection is closer to it: a new stop_position is then created in front of this stop."""
    th = settings.thresholds
    rival_points = None  # computed only when needed
    found = []
    for j in run:
        for n in obj[ways[j]]["nodes"]:
            if not is_stop_position_for(obj[n]["tags"], vehicle):
                continue
            p = latlon(obj[n])
            d = dist(p, target)
            if d > th.stop_position_reuse_m:
                continue
            if d > th.stop_position_shared_m:
                if rival_points is None:
                    rival_points = _rival_points(obj, [ways[k] for k in run], pos, target, rivals)
                if any(dist(p, q) < d for q in rival_points):
                    continue  # the rival's stop_position: ours goes closer on the way
            found.append((d, j, n))
    return min(found)[1:] if found else None


def locate_stop(obj, ways, pos, start=0, max_m=None, rivals=(), vehicle="bus"):
    """Spot of the stop_position of a GTFS stop at pos (lat, lon) on the first run of ways, from
    ways[start], passing within max_m (default thresholds.stop_position_m) of it, or None. Nothing is
    changed (see materialize). rivals: positions of the GTFS stops that may own an existing stop_position
    nearby (Stops.rivals)."""
    max_m = settings.thresholds.stop_position_m if max_m is None else max_m
    best, run = None, []
    for i in range(start, len(ways)):
        nodes = obj[ways[i]]["nodes"]
        near = [(d, i, k, t) for k, (a, b) in enumerate(zip(nodes, nodes[1:]))
                for t, d in [project(pos, latlon(obj[a]), latlon(obj[b]))] if d <= max_m]
        if near:
            run.append(i)
            best = min(near + [best]) if best else min(near)
        elif best:
            break
    if best is None:
        return None
    d, i, k, t = best
    nodes = obj[ways[i]]["nodes"]
    pa, pb = latlon(obj[nodes[k]]), latlon(obj[nodes[k + 1]])
    target = interpolate(pa, pb, t)
    reuse = _reusable(obj, ways, run, pos, target, rivals, vehicle)
    if reuse:
        j, n = reuse
        return Spot(j, latlon(obj[n]), d, node=n)
    length = dist(pa, pb)
    t = min(max(t, 1 / length), 1 - 1 / length) if length > 2 else 0.5  # not on top of an existing node
    return Spot(i, interpolate(pa, pb, t), d, a=nodes[k], b=nodes[k + 1])


def materialize(obj, ways, spot, name, vehicle="bus"):
    """Key of the stop_position of spot: the existing one, retagged (set_stop_position_tags), or a new node
    inserted in the way."""
    if spot.node:
        set_stop_position_tags(obj, spot.node, name, vehicle)
        return spot.node
    nodes = edit(obj, ways[spot.way_index])["nodes"]
    k = next(k for k in range(len(nodes) - 1) if nodes[k] == spot.a and nodes[k + 1] == spot.b)
    key = new_key("n")
    obj[key] = {"lat": spot.pos[0], "lon": spot.pos[1], "tags": stop_position_tags(name, vehicle)}
    nodes.insert(k + 1, key)
    spot.node, spot.a, spot.b = key, None, None
    return key


def place_stop(obj, ways, stop, start=0, max_m=None, rivals=(), vehicle="bus"):
    """(way index, stop_position key) of a GTFS stop {"lat", "lon", "stop_name"}, or None (locate_stop
    then materialize)."""
    spot = locate_stop(obj, ways, latlon(stop), start, max_m, rivals, vehicle)
    return spot and (spot.way_index, materialize(obj, ways, spot, stop["stop_name"], vehicle))


def forward(obj, ways, i):
    """Does the variant travel ways[i] in the order of its nodes? Deduced from the nodes shared with the
    previous way (entry) and the next one (exit); failing that, node order unless oneway=-1."""
    nodes = obj[ways[i]]["nodes"]
    shared = lambda j: [k for k, n in enumerate(nodes) if n in set(obj[ways[j]]["nodes"])] if 0 <= j < len(ways) else []
    entry, exit_ = shared(i - 1), shared(i + 1)
    if entry and exit_:
        return min(entry) < max(exit_)
    if exit_:
        return max(exit_) > 0
    if entry:
        return min(entry) < len(nodes) - 1
    return obj[ways[i]]["tags"].get("oneway") != "-1"


def travel_segment(obj, ways, spot):
    """Segment (a, b) of positions around the spot, in the direction of travel of the variant (not in the
    order of the way's nodes)."""
    nodes = obj[ways[spot.way_index]]["nodes"]
    if spot.node:
        i = nodes.index(spot.node)
        a, b = nodes[max(i - 1, 0)], nodes[min(i + 1, len(nodes) - 1)]
    else:
        a, b = spot.a, spot.b
    a, b = latlon(obj[a]), latlon(obj[b])
    return (a, b) if forward(obj, ways, spot.way_index) else (b, a)


# --- platform --------------------------------------------------------------------------------------------

def _best(candidates, ref):
    return min(candidates, key=lambda c: (not c["holder"], dist(ref, c["pos"])), default=None)


def choose_platform(candidates, stop, segment=None, spot_pos=None):
    """Candidate OSM platform on the kerb side of segment (direction of travel, see travel_segment) rather
    than across the road: the one already carrying the stop_id in OSM, else the nearest to the GTFS stop,
    or to the stop_position (spot_pos) when they all have the same name. None without candidates."""
    if segment:
        candidates = [c for c in candidates if kerb_side(c["pos"], *segment)] or candidates
        if spot_pos and len({c["name"] for c in candidates}) == 1:
            stop = spot_pos
    return _best(candidates, stop)


def fix_side(stop_id, platform, segment, stops):
    """(platform, GTFS stop_id whose data it takes). When the GTFS attaches the route to the stop across
    the road (an error on their side), the other GTFS platform of the same stop on the kerb side
    (stops.neighbours) is used: its OSM platform on that side (the one carrying its stop_id, else the
    nearest), else the chosen platform if on that side, else None (a platform is created at its position).
    (platform, stop_id) are unchanged when the stop is already on the kerb side or when the GTFS has no
    platform on that side for this stop (a single stop_id for both directions: see tag_platforms)."""
    if not segment:
        return platform, stop_id
    pos = lambda sid: latlon(stops.df.loc[sid])
    if kerb_side(pos(stop_id), *segment):
        return platform, stop_id
    opposite = min((sid for sid in stops.neighbours.get(stop_id, ()) if kerb_side(pos(sid), *segment)),
                   key=lambda sid: dist(pos(sid), pos(stop_id)), default=None)
    if opposite is None:
        return platform, stop_id
    candidates = [c for c in stops.platforms.get(opposite, ()) if kerb_side(c["pos"], *segment)]
    if not candidates and platform and kerb_side(platform["pos"], *segment):
        candidates = [platform]
    return _best(candidates, pos(opposite)), opposite


# --- tags ------------------------------------------------------------------------------------------------

def id_tags():
    """Tags specific to a single physical platform."""
    return ("gtfs:stop_id", *settings.stop_ref_tags, "ref", "local_ref", "wheelchair")


PHYSICAL_TAGS = {"public_transport", "highway", "bus", "trolleybus", "wheelchair"}  # survey data wins


def stop_tags(stop, stop_id, network, mode="bus"):
    """Platform tags taken from the GTFS."""
    tags = {"public_transport": "platform", "highway": "bus_stop", VEHICLE.get(mode, "bus"): "yes",
            "name": stop["stop_name"], **network, "gtfs:stop_id": stop_id,
            **{t: stop_id for t in settings.stop_ref_tags}}
    if stop.get("stop_code"):
        tags["ref"] = stop["stop_code"]
    if stop.get("platform_code"):
        tags["local_ref"] = stop["platform_code"]
    if stop.get("wheelchair_boarding") in ("1", "2"):
        tags["wheelchair"] = "yes" if stop["wheelchair_boarding"] == "1" else "no"
    return tags


def tag_platforms(obj, stops, assignments):
    """Set the GTFS data on the platforms chosen by the routes (assignments: stop_id -> {platform:
    (network tags, position, mode)}). A stop_id (id_tags) is set on a single platform: the one already
    carrying it in OSM, else the nearest to the GTFS stop. The others (single GTFS stop for both
    directions, platforms on both sides of the road) only get name and network, and lose the stop_id if
    they already had it. If an OSM platform outside these routes already carries the stop_id, it is set
    nowhere. Returns the stop_ids left out for that reason."""
    elsewhere = []
    own = id_tags()
    prefixes = ("gtfs:stop_id", *settings.stop_ref_tags)
    for data_id, plats in assignments.items():
        d = stops.df.loc[data_id]
        holders = stops.holders.get(data_id, set())
        owner = None
        if holders - set(plats):
            elsewhere.append(f"{d['stop_name']} ({data_id}: {', '.join(sorted(holders - set(plats)))})")
        else:
            owner = min(plats, key=lambda p: (p not in holders, dist(latlon(d), plats[p][1])))
        for p, (network, _, mode) in plats.items():
            tags = stop_tags(d, data_id, network, mode)
            if p != owner:
                tags = {k: v for k, v in tags.items() if k not in own}
                if p in holders:  # duplicate already in OSM: removed
                    t = edit(obj, p)["tags"]
                    for k in [k for k, v in t.items() if k.startswith(prefixes) and v == data_id]:
                        del t[k]
            if is_new(p):
                obj[p]["tags"] = {**tags, **obj[p]["tags"]}
            else:
                enrich(obj, p, tags)
    return elsewhere


def add_tag(t, key, value):
    """Add a value to a tag without overwriting a different value set by another network: it goes to the
    first free numbered key ("network:2", "gtfs:stop_id:2"...)."""
    if key not in t:
        t[key] = value
    elif t[key] != value:
        n = next(n for n in count(2) if t.get(f"{key}:{n}", value) == value)
        t[f"{key}:{n}"] = value


def enrich(obj, key, tags):
    """Complete an existing OSM platform with the GTFS / network tags without overwriting another
    network's (see add_tag), except name, replaced by the official GTFS name, and the physical tags
    (PHYSICAL_TAGS), only added when missing. The network* tags of one network all get the same number
    ("network:2", "network:wikidata:2"...)."""
    t = edit(obj, key)["tags"]
    network = tags["network"]
    n = next(n for n in chain([""], (f":{i}" for i in count(2))) if t.get(f"network{n}", network) == network)
    for k, v in tags.items():
        if k == "name":
            t[k] = v
        elif k.startswith("network"):
            t[k + n] = v
        elif k in PHYSICAL_TAGS:
            t.setdefault(k, v)
        else:
            add_tag(t, k, v)


def stop_position_tags(name, vehicle="bus"):
    """The only tags of a stop_position: the stop's data (ref, network, operator...) is on the platform."""
    return {vehicle: "yes", "name": name, "public_transport": "stop_position"}


def set_stop_position_tags(obj, key, name, vehicle="bus"):
    """Replace the tags of an existing OSM stop_position by stop_position_tags (official GTFS name), keeping
    the other vehicles it serves."""
    old = obj[key]["tags"]
    tags = {**{v: "yes" for v in (*VEHICLE.values(), *OTHER_VEHICLES) if old.get(v) == "yes"},
            **stop_position_tags(name, vehicle)}
    if old != tags:
        edit(obj, key)["tags"] = tags


def filter_road_platforms(platforms, road_nodes, osm):
    """Drop the candidate platforms that are nodes of a travelled way (legacy highway=bus_stop drawn on the
    carriageway: a stop_position, not a platform), unless explicitly tagged public_transport=platform."""
    return {stop_id: [c for c in candidates
                      if c["id"] not in road_nodes or osm[c["id"]]["tags"].get("public_transport") == "platform"]
            for stop_id, candidates in platforms.items()}
