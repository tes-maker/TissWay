"""Relations of a line: one route relation per variant and a route_master, new or existing ones updated in
place (see existing.py)."""

from __future__ import annotations

import logging
import math
import re

from .config import settings
from .existing import feed_key, updated_master, updated_relation
from .geo import latlon, xy
from .naming import master_endpoints_label, route_name
from .osm import new_key
from .platforms import VEHICLE, choose_platform, fix_side, kerb_side, locate_stop, materialize, travel_segment

log = logging.getLogger(__name__)

HEX_COLOUR = re.compile(r"#?([0-9A-Fa-f]{6})")


def route_tags(route, network):
    """Tags shared by the route relations and the route_master of a line."""
    tags = dict(network)
    for gtfs_key, osm_key in (("route_color", "colour"), ("route_text_color", "colour:text")):
        m = HEX_COLOUR.fullmatch(route.get(gtfs_key, "").strip())
        if m:
            tags[osm_key] = f"#{m.group(1)}"
    tags[feed_key("gtfs:route_id")] = route["route_id"]
    return tags


class LineBuilder:
    """Builds the relations of one line in obj. Platforms chosen are recorded in assignments (GTFS stop_id ->
    {platform: (network tags, position, mode)}); their tags are set afterwards by tag_platforms. created:
    GTFS stop_id -> platform created at its position, shared by all lines (never two platforms created at
    the same place). existing: existing.ExistingRoutes whose relations are updated instead of duplicated,
    or None."""

    def __init__(self, route, obj, stops, network, assignments, created, existing=None):
        self.route, self.obj, self.stops, self.network = route, obj, stops, network
        self.assignments, self.created, self.existing = assignments, created, existing
        self.updated, self.unpaired, self.elsewhere = [], [], []
        self.mode = route.get("mode") or "bus"
        self.vehicle = VEHICLE.get(self.mode, "bus")
        # stop_id -> [(heading, (platform, GTFS stop_id whose data it takes, platform position))]: a stop
        # served in both directions does not have the same platform each way. Keyed on the direction of
        # travel at the stop rather than on direction_id, which is optional (and sometimes wrong).
        self.chosen = {}
        self.missing, self.far, self.swapped, self.wrong_side, self.gaps = 0, [], [], [], set()

    def locate(self, ways, stop_id, start):
        """Spot of the stop_position of stop_id from ways[start]; beyond thresholds.stop_position_m, at the
        nearest point of the way (reported)."""
        pos = latlon(self.stops.df.loc[stop_id])
        rivals = self.stops.positions(self.stops.rivals.get(stop_id, ()))
        spot = locate_stop(self.obj, ways, pos, start, rivals=rivals, vehicle=self.vehicle)
        if spot is None:
            spot = locate_stop(self.obj, ways, pos, start, max_m=float("inf"), rivals=rivals, vehicle=self.vehicle)
        return spot

    def choose(self, stop_id, ways, spot):
        """(platform, data stop_id, platform position) of stop_id in this direction of travel, chosen at its
        first occurrence."""
        segment = spot and travel_segment(self.obj, ways, spot)
        heading = segment and math.atan2(*reversed(xy(segment[1], segment[0])))
        for h, choice in self.chosen.get(stop_id, ()):
            if h is None or heading is None or math.cos(h - heading) > 0:  # same way, within 90°
                return choice
        s = self.stops.df.loc[stop_id]
        c = choose_platform(self.stops.platforms.get(stop_id, []), latlon(s), segment, spot and spot.pos)
        c, data_id = fix_side(stop_id, c, segment, self.stops)
        if data_id != stop_id:
            self.swapped.append(f"{s['stop_name']} ({stop_id} -> {data_id}{', platform created' if not c else ''})")
        d = self.stops.df.loc[data_id]
        if not c and data_id not in self.created:
            self.created[data_id] = new_key("n")
            self.obj[self.created[data_id]] = {"lat": d["lat"], "lon": d["lon"], "tags": {}}
        platform = c["id"] if c else self.created[data_id]
        pos = c["pos"] if c else latlon(d)
        self.assignments.setdefault(data_id, {})[platform] = (self.network, pos, self.mode)
        self.chosen.setdefault(stop_id, []).append((heading, (platform, data_id, pos)))
        return platform, data_id, pos

    def variant_members(self, v):
        ways = v["ways"]
        members, start = [], 0
        for stop_id in v["seq"]:
            spot = self.locate(ways, stop_id, start)
            platform, data_id, platform_pos = self.choose(stop_id, ways, spot)
            if data_id != stop_id:  # the stop_position goes in front of the platform actually used
                spot = self.locate(ways, data_id, start) or spot
            if spot:
                start = spot.way_index
                name = self.stops.df.at[data_id, "stop_name"]
                if spot.distance > settings.thresholds.stop_position_m:
                    self.far.append(name)
                members.append((materialize(self.obj, ways, spot, name, self.vehicle), "stop"))
                if not kerb_side(platform_pos, *travel_segment(self.obj, ways, spot)):
                    self.wrong_side.append(name)
            else:
                self.missing += 1
            members.append((platform, "platform"))
        self.gaps |= {(a, b) for a, b in zip(ways, ways[1:])
                      if not set(self.obj[a]["nodes"]) & set(self.obj[b]["nodes"])}
        return members + [(w, "") for w in ways]

    def build(self, variants):
        ref = self.route["route_short_name"]
        common = route_tags(self.route, self.network)
        df = self.stops.df
        before = set(self.obj.maps[0])
        drafts, endpoints = [], []
        for v in variants:
            members = self.variant_members(v)
            first, last = df.loc[v["seq"][0]], df.loc[v["seq"][-1]]
            endpoints.append((first["label"], last["label"]))
            tags = {"type": "route", "route": self.mode, **({"ref": ref} if ref else {}),
                    "name": route_name(self.mode, ref, f"{first['label']} → {last['label']}"), **common,
                    feed_key("gtfs:trip_id:sample"): v["trip_id"]}
            if v.get("shape_id") and v.get("source", "shape") == "shape":
                tags[feed_key("gtfs:shape_id")] = v["shape_id"]
            tags |= {"ref_trips": v["trip_id"], "from": first["stop_name"], "to": last["stop_name"],
                     "public_transport:version": "2"}
            drafts.append((members, tags))

        paired, candidates = {}, []
        if self.existing:
            candidates = self.existing.candidates(self.mode, ref, self.network["network"], self.route["route_id"])
            paired = self.existing.pair(drafts, candidates)
        route_keys = []
        for i, (members, tags) in enumerate(drafts):
            if i in paired:
                key = paired[i]
                self.obj[key] = updated_relation(self.existing.routes[key], members, tags)
                self.updated.append(key)
            else:
                key = new_key("r")
                self.obj[key] = {"members": members, "tags": tags}
            route_keys.append(key)
        self.unpaired = [k for k in candidates if k not in paired.values()]
        if self.existing:
            self.elsewhere = self.existing.other_networks(self.mode, ref, self.network["network"], drafts)

        master_tags = {"type": "route_master", "route_master": self.mode, **({"ref": ref} if ref else {}),
                       "name": route_name(self.mode, ref, master_endpoints_label(endpoints)), **common}
        master = self.existing and self.existing.master(self.mode, ref, self.network["network"],
                                                        self.route["route_id"], self.updated)
        if master:
            self.obj[master] = updated_master(self.existing.masters[master], route_keys, master_tags)
            self.updated.append(master)
        else:
            self.obj[new_key("r")] = {"members": [(k, "") for k in route_keys], "tags": master_tags}
        self.report(ref or self.route["route_id"], len(variants), before)

    def report(self, ref, n_variants, before):
        new_nodes = [k for k in self.obj.maps[0] if k.startswith("n-") and k not in before]
        n_platforms = sum(k in set(self.created.values()) for k in new_nodes)
        log.info("line %s: %d variant(s), %d new stop_position(s), %d new platform(s)",
                 ref, n_variants, len(new_nodes) - n_platforms, n_platforms)
        if self.updated:
            log.info("  existing relation(s) updated in place: %s", ", ".join(self.updated))
        if self.unpaired:
            names = [f"{k} ({self.existing.routes[k]['tags'].get('name', '?')})" for k in self.unpaired]
            log.warning("  %d existing route relation(s) of the line not matched by any GTFS variant (obsolete? "
                        "to check in JOSM): %s", len(names), "; ".join(names))
        if self.elsewhere:
            names = [f"{k} ({self.existing.routes[k]['tags'].get('network')}: "
                     f"{self.existing.routes[k]['tags'].get('name', '?')})" for k in self.elsewhere]
            log.warning("  same line in OSM under another network, not updated (duplicate? check the network): %s",
                        "; ".join(names))
        if self.missing:
            log.warning("  %d stop(s) without stop_position (no way)", self.missing)
        if self.gaps:
            log.warning("  %d gap(s) between consecutive ways", len(self.gaps))
        far, wrong_side = list(dict.fromkeys(self.far)), list(dict.fromkeys(self.wrong_side))
        if far:
            log.warning("  %d stop_position(s) more than %g m from the GTFS stop (to check): %s",
                        len(far), settings.thresholds.stop_position_m, ", ".join(far))
        for x in self.swapped:
            log.info("  GTFS stop across the road, data of the opposite stop used: %s", x)
        if wrong_side:
            log.warning("  %d platform(s) across the road, no OSM platform or GTFS stop on the kerb side: %s",
                        len(wrong_side), ", ".join(wrong_side))


def build_line(route, variants, obj, stops, network, assignments, created, existing=None):
    """Add to obj the relations and stop_positions of a line (see LineBuilder)."""
    LineBuilder(route, obj, stops, network, assignments, created, existing).build(variants)
