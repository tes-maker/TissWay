"""Ways split where routes enter or leave them.

Main street wA: a0 - a1 - a2 - a3; side street wS: s0 - a1 (joining wA in its middle); street wE: a3 - e1
(continuing wA); roundabout wR: r1 r2 r3 r4 r1.
"""
from collections import ChainMap

import pytest

from tissway import splitting


def way(*nodes, **tags):
    return {"version": "4", "tags": {"highway": "residential", **tags}, "nodes": list(nodes)}


def osm():
    return {"wA": way("a0", "a1", "a2", "a3"), "wS": way("s0", "a1"), "wE": way("a3", "e1"),
            "wR": way("r1", "r2", "r3", "r4", "r1", junction="roundabout"),
            "wIn": way("s9", "r1"), "wOut": way("r3", "s8")}


def route(ways, first_stop, last_stop):
    return {"tags": {"type": "route"},
            "members": [(first_stop, "stop"), ("nQ1", "platform"), (last_stop, "stop"), ("nQ2", "platform"),
                        *[(w, "") for w in ways]]}


def run(routes, existing=None, monkeypatch=None):
    monkeypatch.setattr(splitting, "parent_relations", lambda ids: existing or {})
    obj = ChainMap({}, osm())
    obj.maps[0].update(routes)
    return obj, splitting.split_ways(obj)


def ways_of(obj, key):
    return [ref for ref, role in obj[key]["members"] if role == ""]


def new_part(obj):
    [p] = [k for k in obj.maps[0] if k.startswith("w-")]
    return p


def test_route_turning_in_the_middle_of_a_street(monkeypatch):
    # the route comes from wS, turns onto wA at node a1 (middle of wA) and goes on along wE
    existing = {"r7": {"version": "2", "tags": {"type": "route"}, "members": [("wA", ""), ("wE", "")]}}
    obj, (n, n_closed, n_rel) = run({"r-1": route(["wS", "wA", "wE"], "s0", "e1")}, existing, monkeypatch)
    assert (n, n_closed, n_rel) == (1, 0, 1)
    p = new_part(obj)
    assert obj["wA"]["nodes"] == ["a1", "a2", "a3"] and obj["wA"]["version"] == "4"  # the longest part keeps the id
    assert obj[p]["nodes"] == ["a0", "a1"] and "version" not in obj[p]
    assert ways_of(obj, "r-1") == ["wS", "wA", "wE"]  # only the travelled part
    assert ways_of(obj, "r7") == [p, "wA", "wE"]  # existing relation travelling the whole street: all
    assert obj.parents["wA"]["nodes"] == ["a0", "a1", "a2", "a3"]  # extract untouched


def test_same_street_travelled_the_other_way(monkeypatch):
    obj, _ = run({"r-1": route(["wE", "wA", "wS"], "e1", "s0")}, monkeypatch=monkeypatch)
    assert ways_of(obj, "r-1") == ["wE", "wA", "wS"]
    assert obj["wA"]["nodes"] == ["a1", "a2", "a3"]


def test_two_routes_cuts_pooled(monkeypatch):
    # r-1 turns at a1, r-2 travels the whole street: r-2 gets both parts
    obj, (n, _, _) = run({"r-1": route(["wS", "wA", "wE"], "s0", "e1"),
                          "r-2": route(["wA", "wE"], "a0", "e1")}, monkeypatch=monkeypatch)
    assert n == 1
    assert ways_of(obj, "r-2") == [new_part(obj), "wA", "wE"]


def test_terminus_in_the_middle_of_a_way(monkeypatch):
    # the route starts at stop_position a1 and ends at a2, on the single way wA
    obj, (n, _, _) = run({"r-1": route(["wA"], "a1", "a2")}, monkeypatch=monkeypatch)
    assert n == 1
    [kept] = ways_of(obj, "r-1")
    assert obj[kept]["nodes"] == ["a1", "a2"]


def test_way_travelled_end_to_end_not_split(monkeypatch):
    obj, (n, _, _) = run({"r-1": route(["wA", "wE"], "a0", "e1")}, monkeypatch=monkeypatch)
    assert n == 0 and "wA" not in obj.maps[0]


def test_roundabout_only_the_travelled_part(monkeypatch):
    existing = {"r5": {"version": "1", "tags": {}, "members": [("wIn", ""), ("wR", ""), ("wOut", "")]}}
    obj, (n, n_closed, _) = run({"r-1": route(["wIn", "wR", "wOut"], "s9", "s8")}, existing, monkeypatch)
    assert (n, n_closed) == (1, 1)
    p = new_part(obj)
    assert obj["wR"]["nodes"] == ["r1", "r2", "r3"] and obj[p]["nodes"] == ["r3", "r4", "r1"]
    assert ways_of(obj, "r-1") == ["wIn", "wR", "wOut"]  # not the full turn
    assert ways_of(obj, "r5") == ["wIn", "wR", "wOut"]  # existing relation: same path, no gap

    # unordered relation (e.g. street): all the parts
    monkeypatch.setattr(splitting, "parent_relations", lambda ids: {
        "r6": {"version": "1", "tags": {"type": "street"}, "members": [("wR", "street")]}})
    obj = ChainMap({}, osm())
    obj.maps[0]["r-1"] = route(["wIn", "wR", "wOut"], "s9", "s8")
    splitting.split_ways(obj)
    assert sorted(ref for ref, _ in obj["r6"]["members"]) == sorted(["wR", new_part(obj)])


@pytest.mark.parametrize("entry, exit, expected", [
    ("r1", "r1", ["a", "b"]), ("r3", "r1", ["b"]), ("r1", "r3", ["a"]),
    ("r2", "r4", ["a", "b"]),  # entry / exit between cuts (existing relation): arcs containing them
    ("r4", "r2", ["b", "a"]),
])
def test_traversed_roundabout(entry, exit, expected):
    s = splitting.Split(["r1", "r2", "r3", "r4", "r1"], [0, 2], ["a", "b"])
    assert s.traversed(entry, exit) == expected


@pytest.mark.parametrize("entry, exit, expected", [
    ("a1", "a3", ["q"]), ("a3", "a1", ["q"]), ("a0", "a3", ["p", "q"]), ("a3", "a0", ["q", "p"]),
    ("a2", "a0", ["q", "p"]),  # entry between cuts: parts covering the path
    (None, "a1", ["p"]), ("a1", None, ["q"]),  # terminus off the way
])
def test_traversed_open_way(entry, exit, expected):
    s = splitting.Split(["a0", "a1", "a2", "a3"], [0, 1, 3], ["p", "q"])
    assert s.traversed(entry, exit) == expected


def test_existing_relation_turning_elsewhere_has_no_gap(monkeypatch):
    # an existing OSM route comes from wE, travels wA down to a1 then takes wS: it must only keep the part
    # a1-a3, otherwise a0-a1 would leave a gap before wS
    existing = {"r7": {"version": "2", "tags": {"type": "route"}, "members": [("wE", ""), ("wA", ""), ("wS", "")]}}
    obj, _ = run({"r-1": route(["wS", "wA", "wE"], "s0", "e1")}, existing, monkeypatch)
    assert ways_of(obj, "r7") == ["wE", "wA", "wS"]


def test_ways_touching_at_two_nodes_no_gap(monkeypatch):
    # wL leaves the end of wA (a3) and comes back to its middle (a1): a1 and a3 are shared by both ways;
    # the passage from wA to wL is a3 (end of both ways), not a1
    monkeypatch.setattr(splitting, "parent_relations", lambda ids: {})
    obj = ChainMap({}, {**osm(), "wL": way("a3", "l1", "a1")})
    obj.maps[0]["r-1"] = route(["wA", "wL"], "a0", "l1")
    splitting.split_ways(obj)
    ws = ways_of(obj, "r-1")
    assert all(set(obj[x]["nodes"]) & set(obj[y]["nodes"]) for x, y in zip(ws, ws[1:]))
    assert obj[ws[0]]["nodes"][0] == "a0" and obj[ws[-1]]["nodes"][-1] == "l1"
    assert splitting.link_node(obj.parents, "wA", "wL") == "a3"

