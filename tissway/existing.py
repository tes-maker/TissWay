"""Existing OSM route relations: a line already mapped is updated in place rather than duplicated.

The route relations and route masters of settings.modes are extracted once from the OSM extract (cache
settings.routes_cache, rebuilt whenever the extract is newer). For each line:
- candidates: existing route relations of the same mode whose gtfs:route_id* is the GTFS route_id, or
  whose ref is the line's ref and whose network, if any, is one of the line's;
- each generated variant is paired with its most similar candidate, one to one, best pairs first (see
  similarity). Pairs scoring below settings.existing_min_similarity are not made;
- a paired relation keeps its id, its history and the tags this tool does not manage (operator, wikidata,
  note, interval...): its members are replaced by the generated ones, the generated tags are written over
  its own, and the stale GTFS references (old shape or sample trip) are removed;
- the route_master: the existing one containing a paired relation, else one with the same mode, ref and
  network. It keeps its id and its other members; the generated relations are added to it.
Existing relations of the line left unpaired are never deleted: they are reported, to check in JOSM
(obsolete variant, or one the GTFS no longer runs).

The network:wikidata / network:wikipedia of a network missing from the profile are taken from its existing
relations when they agree (network_wikis), so that platforms and relations all carry them.
"""

from __future__ import annotations

import logging
import subprocess
from collections import defaultdict
from pathlib import Path

from .config import settings
from .osm import parse_opl

log = logging.getLogger(__name__)


def routes_cache():
    """Path of the OPL cache of the route relations and route masters of settings.modes, extracted from the
    OSM extract with osmium (again whenever the extract is newer than the cache)."""
    cache, pbf = Path(settings.routes_cache), Path(settings.pbf)
    if not cache.is_file() or (pbf.is_file() and pbf.stat().st_mtime > cache.stat().st_mtime):
        modes = ",".join(settings.modes)
        subprocess.run(["osmium", "tags-filter", str(pbf), f"r/route={modes}", f"r/route_master={modes}",
                        "--omit-referenced", "-f", "opl", "-o", str(cache), "--overwrite"], check=True)
    return cache


def feed_key(key):
    """gtfs:* tag key, suffixed with the feed id when there is one ("gtfs:route_id:DE-BY-MVV")."""
    return f"{key}:{settings.feed}" if settings.feed else key


def stale_keys():
    """Tags describing the GTFS source of a relation: removed from an updated relation unless regenerated."""
    return {feed_key("gtfs:shape_id"), feed_key("gtfs:trip_id:sample"), "ref_trips"}


def _values(tags, prefix):
    return {v.strip() for k, v in tags.items() if k.startswith(prefix) for v in v.split(";") if v.strip()}


def _norm(value):
    return " ".join((value or "").split()).casefold()


def _refs(members, kinds):
    """Member keys whose role starts with one of kinds ("" = travelled ways), in order, without repeats."""
    out = []
    for ref, role in members:
        kind = "" if ref[0] == "w" and role in ("", "forward", "backward") else role.split("_")[0]
        if kind in kinds and ref not in out:
            out.append(ref)
    return out


def _jaccard(a, b):
    a, b = set(a), set(b)
    return len(a & b) / len(a | b) if a | b else 0.0


def same_direction(ours, theirs):
    """Do the members shared by two ordered lists come in the same order (not the other direction)?"""
    first = {}
    for i, m in enumerate(theirs):
        first.setdefault(m, i)
    seq = [first[m] for m in ours if m in first]
    forward = sum(b > a for a, b in zip(seq, seq[1:]))
    backward = sum(b < a for a, b in zip(seq, seq[1:]))
    return forward >= backward


def similarity(members, tags, existing):
    """Similarity (0..1) of a generated route relation (members, tags) with an existing one.

    1 when the existing relation carries the same sample trip or shape id. Otherwise the share of common
    platforms (stop_positions when either relation has no platform) weighs 0.7 and the share of common ways
    0.3 (Jaccard indices); 0 when the shared members come in reverse order (the other direction)."""
    theirs = existing["tags"]
    refs = _values(theirs, "gtfs:shape_id") | _values(theirs, "gtfs:trip_id") | _values(theirs, "ref_trips")
    ours = {tags.get(feed_key("gtfs:shape_id")), tags.get(feed_key("gtfs:trip_id:sample"))} - {None}
    if ours & refs:
        return 1.0
    stops_kind = ("platform",)
    if not _refs(members, stops_kind) or not _refs(existing["members"], stops_kind):
        stops_kind = ("stop",)
    stops_a, stops_b = _refs(members, stops_kind), _refs(existing["members"], stops_kind)
    ways_a, ways_b = _refs(members, ("",)), _refs(existing["members"], ("",))
    check = (stops_a, stops_b) if len(set(stops_a) & set(stops_b)) >= 2 else (ways_a, ways_b)
    if not same_direction(*check):
        return 0.0
    if not stops_a or not stops_b:
        return _jaccard(ways_a, ways_b)
    return 0.7 * _jaccard(stops_a, stops_b) + 0.3 * _jaccard(ways_a, ways_b)


def merge_tags(old, new):
    """Tags of an updated relation: the existing ones, without the stale GTFS references, under the
    generated ones."""
    stale = stale_keys()
    return {**{k: v for k, v in old.items() if k not in stale}, **new}


WIKI_KEYS = ("network:wikidata", "network:wikipedia")
WIKI_MIN_RELATIONS = 3  # existing relations agreeing on a value before it is used


def network_wikis(relations):
    """network -> {network:wikidata, network:wikipedia} of the existing route relations and route masters
    with that network tag. A value is kept only when every relation carrying the key agrees on it, and at
    least WIKI_MIN_RELATIONS of them do: mapped by the community, not guessed."""
    seen = defaultdict(lambda: defaultdict(list))
    for o in relations.values():
        tags = o["tags"]
        if tags.get("network") and tags.get("type") in ("route", "route_master"):
            for key in WIKI_KEYS:
                if tags.get(key):
                    seen[tags["network"]][key].append(tags[key])
    return {network: {key: values[0] for key, values in by_key.items()
                      if len(values) >= WIKI_MIN_RELATIONS and len(set(values)) == 1}
            for network, by_key in seen.items()}


class ExistingRoutes:
    """Route relations and route masters of the extract, and those already claimed by a generated line."""

    def __init__(self, relations):
        self.routes = {k: o for k, o in relations.items() if o["tags"].get("type") == "route"}
        self.masters = {k: o for k, o in relations.items() if o["tags"].get("type") == "route_master"}
        self.parents = defaultdict(list)  # route relation -> route masters containing it
        for k, o in self.masters.items():
            for ref, _ in o["members"]:
                self.parents[ref].append(k)
        self.claimed = set()
        self.wikis = network_wikis(relations)

    @classmethod
    def load(cls):
        return cls(parse_opl(routes_cache().read_text(encoding="utf-8")))

    @staticmethod
    def _same_line(tags, mode_key, mode, ref, networks, route_id):
        if tags.get(mode_key) != mode:
            return False
        if route_id and route_id in _values(tags, "gtfs:route_id"):
            return True
        theirs = {_norm(v) for k, v in tags.items() if k == "network" or k.startswith("network:")
                  and k.split(":")[-1].isdigit() for v in v.split(";")}
        return bool(ref) and _norm(tags.get("ref")) == _norm(ref) and (not theirs or bool(theirs & networks))

    def candidates(self, mode, ref, network, route_id):
        """Unclaimed existing route relations of the line."""
        networks = {_norm(network)}
        return [k for k, o in self.routes.items()
                if k not in self.claimed and self._same_line(o["tags"], "route", mode, ref, networks, route_id)]

    def other_networks(self, mode, ref, network, drafts):
        """Existing route relations with the same mode and ref in another network that follow one of the
        drafts closely (the line may be tagged with another network in OSM): reported, never updated."""
        if not ref:
            return []
        found = []
        for k, o in self.routes.items():
            t = o["tags"]
            if (k not in self.claimed and t.get("route") == mode and _norm(t.get("ref")) == _norm(ref)
                    and _norm(t.get("network")) not in ("", _norm(network))
                    and max(similarity(m, tg, o) for m, tg in drafts) >= settings.existing_min_similarity):
                found.append(k)
        return found

    def pair(self, drafts, candidates):
        """{index of a draft: existing relation} for the generated relations drafts [(members, tags)], one to
        one, best pairs first; the paired relations are claimed."""
        scores = sorted(((similarity(m, t, self.routes[k]), i, k) for i, (m, t) in enumerate(drafts)
                         for k in candidates), reverse=True)
        paired = {}
        for score, i, k in scores:
            if score < settings.existing_min_similarity:
                break
            if i not in paired and k not in self.claimed:
                paired[i] = k
                self.claimed.add(k)
        return paired

    def master(self, mode, ref, network, route_id, paired):
        """Existing route_master of the line, or None: the one containing most of the paired relations, else
        one with the same mode, ref and network. It is claimed."""
        counts = defaultdict(int)
        for k in paired:
            for m in self.parents.get(k, ()):
                counts[m] += 1
        found = [m for m in sorted(counts, key=counts.get, reverse=True) if m not in self.claimed]
        if not found:
            found = [k for k, o in self.masters.items() if k not in self.claimed and self._same_line(
                o["tags"], "route_master", mode, ref, {_norm(network)}, route_id)]
        if found:
            self.claimed.add(found[0])
            return found[0]
        return None


def updated_relation(old, members, tags):
    """Existing relation old with the generated members and tags."""
    return {"version": old["version"], "members": members, "tags": merge_tags(old["tags"], tags)}


def updated_master(old, route_keys, tags):
    """Existing route_master old with the generated route relations added (its other members kept)."""
    members = list(old["members"])
    present = {ref for ref, _ in members}
    members += [(k, "") for k in route_keys if k not in present]
    return {"version": old["version"], "members": members, "tags": merge_tags(old["tags"], tags)}
