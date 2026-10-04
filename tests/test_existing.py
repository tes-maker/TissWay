"""Existing OSM route relations updated in place instead of duplicated."""
from collections import ChainMap

import pandas as pd
import pytest

from tissway.build import build_line
from tissway.existing import ExistingRoutes, merge_tags, same_direction, similarity

NOMAD = {"network": "Nomad"}


def relation(members, version="7", **tags):
    return {"version": version, "members": members, "tags": {"type": "route", "route": "bus", **tags}}


def route_members(platforms, ways):
    return [(p, "platform") for p in platforms] + [(w, "") for w in ways]


NORTH = route_members(["nP1", "nP2", "nP3"], ["w1", "w2", "w3"])
SOUTH = route_members(["nQ3", "nQ2", "nQ1"], ["w3", "w2", "w1"])


def test_same_direction():
    assert same_direction(["a", "b", "c"], ["x", "a", "b", "c"])
    assert not same_direction(["a", "b", "c"], ["c", "b", "a"])


def test_similarity():
    assert similarity(NORTH, {}, relation(NORTH)) == pytest.approx(1.0)
    assert similarity(NORTH, {}, relation(SOUTH)) == 0.0  # same ways, other direction
    partial = route_members(["nP1", "nP2"], ["w1", "w2"])
    assert 0.4 < similarity(NORTH, {}, relation(partial)) < 1
    # same sample trip: the same relation, whatever its members
    assert similarity([], {"gtfs:trip_id:sample": "t1"}, relation([], ref_trips="t0;t1")) == 1.0


def test_merge_tags_keeps_unmanaged_tags_and_drops_stale_gtfs_references():
    old = {"name": "Old", "operator": "Keolis", "gtfs:shape_id": "s0", "wikidata": "Q1"}
    assert merge_tags(old, {"name": "New"}) == {"name": "New", "operator": "Keolis", "wikidata": "Q1"}


def existing_routes():
    return ExistingRoutes({
        "r10": relation(NORTH, ref="1", network="Nomad", name="Bus 1 north", operator="Keolis"),
        "r11": relation(SOUTH, ref="1", network="Nomad", name="Bus 1 south"),
        "r12": relation(NORTH, ref="1", network="Twisto", name="Twisto 1"),  # other network
        "r13": relation(route_members(["nX"], ["w9"]), ref="1", network="Nomad", name="Bus 1 obsolete"),
        "r20": {"version": "3", "members": [("r10", ""), ("r11", ""), ("r13", "")],
                "tags": {"type": "route_master", "route_master": "bus", "ref": "1", "network": "Nomad"}},
    })


def test_candidates_and_pairing():
    existing = existing_routes()
    candidates = existing.candidates("bus", "1", "Nomad", "R1")
    assert sorted(candidates) == ["r10", "r11", "r13"]
    paired = existing.pair([(SOUTH, {}), (NORTH, {})], candidates)
    assert paired == {0: "r11", 1: "r10"}
    assert existing.candidates("bus", "1", "Nomad", "R1") == ["r13"]  # claimed relations are not offered again
    assert existing.master("bus", "1", "Nomad", "R1", ["r10", "r11"]) == "r20"
    assert existing.other_networks("bus", "1", "Nomad", [(NORTH, {})]) == ["r12"]  # Twisto 1: reported only


def test_route_id_matches_whatever_the_ref():
    existing = ExistingRoutes({"r1": relation(NORTH, ref="1 EXPRESS", **{"gtfs:route_id": "R1"})})
    assert existing.candidates("bus", "1EX", "Nomad", "R1") == ["r1"]


def test_build_line_updates_the_existing_relations():
    obj = ChainMap({}, {
        "n1": {"version": "1", "lat": 49.0, "lon": 1.0, "tags": {}},
        "n2": {"version": "1", "lat": 49.001, "lon": 1.0, "tags": {}},
        "w1": {"version": "1", "tags": {}, "nodes": ["n1", "n2"]},
    })
    df = pd.DataFrame([{"stop_id": s, "stop_code": "", "stop_name": s, "wheelchair_boarding": "", "platform_code": "",
                        "lat": lat, "lon": 1.0002, "label": s} for s, lat in (("A", 49.0001), ("B", 49.0009))])
    from tissway.stops import Stops
    stops = Stops(df.set_index("stop_id"), {"A": [], "B": []}, {"A": [], "B": []}, {}, {"A": [], "B": []})
    existing = ExistingRoutes({
        "r10": relation([("w1", "")], ref="1", network="Nomad", name="Old", operator="Keolis"),
        "r20": {"version": "3", "members": [("r10", ""), ("r99", "")],
                "tags": {"type": "route_master", "route_master": "bus", "ref": "1", "network": "Nomad"}},
    })
    route = pd.Series({"route_id": "R1", "route_short_name": "1", "route_color": "", "route_text_color": "",
                       "mode": "bus"})
    variant = {"direction": "0", "seq": ("A", "B"), "shape_id": "", "trip_id": "t1", "ways": ["w1"]}
    build_line(route, [variant], obj, stops, NOMAD, {}, {}, existing)

    rel = obj["r10"]
    assert rel["version"] == "7" and rel["tags"]["name"] == "Bus 1: A → B" and rel["tags"]["operator"] == "Keolis"
    assert [role for _, role in rel["members"]] == ["stop", "platform", "stop", "platform", ""]
    assert obj["r20"]["members"] == [("r10", ""), ("r99", "")]  # other member kept, ours already there
    assert not [k for k in obj.maps[0] if k.startswith("r-")]  # nothing duplicated
