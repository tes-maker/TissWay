"""Splitting ways where routes enter or leave them: streets, roundabouts, termini.

A route relation must only contain what the vehicle travels. When a route enters or leaves a way at an
inner node (it turns in the middle of a street, uses part of a roundabout, or starts at a stop_position in
the middle of a way), the way is split at that node. Splitting is done once for all the routes of the
output file (the cuts of every route are pooled), after the relations are built, so that ways can be cut
at the stop_positions of the termini.

Open way: cut at every inner entry / exit node. Closed way (single-way roundabout...): cut at every entry /
exit as soon as there are at least two, otherwise a route would travel all the way round. With
split_roundabouts = false, roundabouts (junction=roundabout / circular) are left whole: the relations
contain the full way.

Every relation containing a split way gets the parts it travels instead, in travel order:
- our relations and the existing OSM route relations: only the travelled parts, deduced from the
  neighbouring ways in the relation (an existing route turning elsewhere does not keep a dead-end part,
  which would leave a gap);
- the other existing relations (street, associatedStreet, multipolygon...): all the parts.
The longest part (in number of nodes) keeps the id and history of the original way, as JOSM does.
"""

from .config import settings
from .osm import new_key, parent_relations

ROUTE_ROLES = ("", "forward", "backward")  # roles of the travelled ways in a route relation
ROUNDABOUTS = ("roundabout", "circular")  # junction=* values kept whole when split_roundabouts is false


class Split:
    """A split way: nodes (original list, closed if nodes[0] == nodes[-1]), cuts (indices of the cuts in
    nodes, ends included for an open way; in nodes[:-1] for a closed way) and parts (ids of the parts, in
    node order)."""

    def __init__(self, nodes, cuts, parts):
        self.nodes, self.cuts, self.parts = nodes, sorted(cuts), parts
        self.closed = nodes[0] == nodes[-1]

    def arcs(self):
        """Nodes of each part, in the order of parts."""
        if not self.closed:
            return [self.nodes[i:j + 1] for i, j in zip(self.cuts, self.cuts[1:])]
        ring, c = self.nodes[:-1], self.cuts
        return [ring[i:j + 1] if j > i else ring[i:] + ring[:j + 1] for i, j in zip(c, c[1:] + c[:1])]

    def traversed(self, entry, exit):
        """Parts travelled from entry to exit (nodes of the way), in travel order. None = unknown (end of
        the relation, or neighbouring way missing): from / to the end of the way for an open way, a single
        part for a closed way; all the parts if both are unknown."""
        entry = entry if entry in self.nodes else None
        exit = exit if exit in self.nodes else None
        if entry is None and exit is None:
            return list(self.parts)
        return self._traversed_closed(entry, exit) if self.closed else self._traversed_open(entry, exit)

    def _traversed_open(self, entry, exit):
        last = len(self.nodes) - 1
        px = self.nodes.index(exit) if exit is not None else None
        pe = self.nodes.index(entry) if entry is not None else (0 if px else last)
        if px is None:
            px = last if pe < last else 0
        lo, hi = sorted((pe, px))
        spans = zip(self.parts, self.cuts, self.cuts[1:])
        parts = [p for p, i, j in spans if i < hi and j > lo] or [
            next(p for p, i, j in zip(self.parts, self.cuts, self.cuts[1:]) if i <= lo <= j)]
        return parts if pe <= px else parts[::-1]

    def _traversed_closed(self, entry, exit):
        arcs, n = self.arcs(), len(self.parts)
        if entry is None:  # a single part: the one reaching the exit
            return [next(p for p, arc in zip(self.parts, arcs) if exit in arc[1:])]
        k = next(k for k, arc in enumerate(arcs) if entry in arc[:-1])
        if exit is None:
            return [self.parts[k]]
        out = []
        for step in range(n + 1):  # n + 1: a full turn is possible (U-turn on the roundabout)
            arc = arcs[(k + step) % n]
            out.append(self.parts[(k + step) % n])
            start = arc.index(entry) if step == 0 else 0
            if exit in arc[start + 1:]:
                break
        return out


def link_node(obj, prev, next_):
    """Node where the route passes from way prev to way next_ (exit of one = entry of the other: computed
    once for both, otherwise two ways touching at several nodes could be cut at two different places and
    leave a gap). If there are several, the one ending both ways, else one of them (real junction), else
    the first in the order of prev. None if they do not touch."""
    a, b = obj[prev]["nodes"], obj[next_]["nodes"]
    common = [n for n in a if n in set(b)]
    ends = lambda n: (n in (a[0], a[-1])) + (n in (b[0], b[-1]))
    return max(common, key=ends, default=None)  # max keeps the first one on ties


def passages(obj, rel):
    """[(member index, way, entry, exit)] of the ways travelled by the route relation rel: entry and exit =
    node shared with the previous / next way; at the ends of the relation, first / last stop_position if it
    is on the way; None otherwise."""
    members = rel["members"]
    ways = [(i, ref) for i, (ref, role) in enumerate(members)
            if ref[0] == "w" and role in ROUTE_ROLES and ref in obj and "nodes" in obj[ref]]
    stops = [ref for ref, role in members if role.startswith("stop")]
    links = [link_node(obj, a, b) for (_, a), (_, b) in zip(ways, ways[1:])]
    out = []
    for k, (i, w) in enumerate(ways):
        nodes = obj[w]["nodes"]
        entry = links[k - 1] if k else (stops[0] if stops and stops[0] in nodes else None)
        exit = links[k] if k + 1 < len(ways) else (stops[-1] if stops and stops[-1] in nodes else None)
        out.append((i, w, entry, exit))
    return out


def cut_nodes(obj, routes):
    """Way -> nodes where to cut it: inner entries / exits (open way) or all entries / exits (closed way)
    of the route relations. Roundabouts are left out when split_roundabouts is false."""
    cuts = {}
    for key in routes:
        for _, w, entry, exit in passages(obj, obj[key]):
            nodes = obj[w]["nodes"]
            closed = nodes[0] == nodes[-1]
            if not settings.split_roundabouts and obj[w]["tags"].get("junction") in ROUNDABOUTS:
                continue
            if not closed and len(set(nodes)) != len(nodes):
                continue  # way passing twice through a node: ambiguous position, not split
            inner = set(nodes) if closed else set(nodes[1:-1])
            cuts.setdefault(w, set()).update(n for n in (entry, exit) if n in inner)
    return cuts


def plan_splits(obj, cuts):
    """Way -> Split of the ways to split (at least two parts)."""
    splits = {}
    for w, nodes_cut in cuts.items():
        nodes = obj[w]["nodes"]
        if nodes[0] == nodes[-1]:
            idx = {nodes[:-1].index(n) for n in nodes_cut}
            if len(idx) < 2:  # a single cut on a closed way: nothing to split
                continue
        else:
            idx = {0, len(nodes) - 1} | {nodes.index(n) for n in nodes_cut}
            if len(idx) < 3:
                continue
        split = Split(nodes, idx, [])
        arcs = split.arcs()
        keep = max(range(len(arcs)), key=lambda k: len(arcs[k]))
        split.parts = [w if k == keep else new_key("w") for k in range(len(arcs))]
        splits[w] = split
    return splits


def rewrite_members(rel, splits, route_passages):
    """Members of rel where every split way is replaced by its travelled parts (route relation,
    route_passages = {member index: (entry, exit)}) or by all its parts (other relation)."""
    members = []
    for i, (ref, role) in enumerate(rel["members"]):
        if ref not in splits:
            members.append((ref, role))
        elif i in route_passages:
            members += [(p, role) for p in splits[ref].traversed(*route_passages[i])]
        else:
            members += [(p, role) for p in splits[ref].parts]
    return members


def split_ways(obj):
    """Split the ways of the route relations of obj (those created by the tool) where the routes enter or
    leave them, and update our relations and the existing OSM relations containing them.
    Returns (split ways, of which closed ways, existing relations updated)."""
    routes = [k for k, o in obj.maps[0].items() if k[0] == "r" and o["tags"].get("type") == "route"]
    splits = plan_splits(obj, cut_nodes(obj, routes))
    if not splits:
        return 0, 0, 0

    existing = {k: o for k, o in parent_relations(splits).items() if k not in obj.maps[0]}
    # entries / exits computed on the original ways, before writing the parts
    ordered = lambda rel: rel["tags"].get("type", "route") == "route"
    route_passages = {k: {i: (e, x) for i, _, e, x in passages(obj, rel)}
                      for k, rel in [*[(k, obj[k]) for k in routes], *existing.items()] if ordered(rel)}

    for w, split in splits.items():
        tags, version = obj[w]["tags"], obj[w].get("version")
        for p, arc in zip(split.parts, split.arcs()):
            obj[p] = {**({"version": version} if p == w and version else {}), "nodes": arc, "tags": dict(tags)}

    for k in routes:
        obj[k] = {**obj[k], "members": rewrite_members(obj[k], splits, route_passages[k])}
    for k, rel in existing.items():
        obj[k] = {**rel, "members": rewrite_members(rel, splits, route_passages.get(k, {}))}

    return len(splits), sum(s.closed for s in splits.values()), len(existing)
