"""Stops on the ground: stop_position placement (rival stops), kerb side, opposite stop, one platform per
stop_id."""
from collections import ChainMap

import pandas as pd
import pytest

from tissway.build import build_line
from tissway.platforms import (
    choose_platform,
    enrich,
    filter_road_platforms,
    fix_side,
    forward,
    locate_stop,
    materialize,
    place_stop,
    road_distance,
    set_stop_position_tags,
    stop_position_tags,
    stop_ref,
    tag_platforms,
    travel_segment,
)
from tissway.stops import Stops

NOMAD = {"network": "Nomad"}
WEST, EAST = 0.9998, 1.0002  # either side of a north-south road at longitude 1.0 (~15 m)


def node(lat, lon, **tags):
    return {"version": "1", "lat": lat, "lon": lon, "tags": tags}


def way(*nodes, **tags):
    return {"version": "1", "tags": tags, "nodes": list(nodes)}


def road():
    """North-south road n1 -> n2 -> n3 drawn as two ways: w1 northwards, w2 southwards."""
    return {"n1": node(49.0, 1.0), "n2": node(49.0005, 1.0), "n3": node(49.001, 1.0),
            "w1": way("n1", "n2"), "w2": way("n3", "n2")}


def street(**extra):
    """Two-way street drawn as a single way wR (r1 at 49.0 to r5 at 49.001, every ~28 m), extended by wS to
    the south and wN to the north."""
    lats = [49.0, 49.00025, 49.0005, 49.00075, 49.001]
    objs = {f"r{i + 1}": node(lat, 1.0) for i, lat in enumerate(lats)}
    objs |= {"s0": node(48.9995, 1.0), "n6": node(49.0015, 1.0),
             "wR": way(*[f"r{i + 1}" for i in range(5)]), "wS": way("s0", "r1"), "wN": way("r5", "n6")}
    return ChainMap({}, objs | extra)


def with_stop_position(objs, key, lat, after):
    """Insert an existing stop_position node key at lat on wR, after node after."""
    objs.maps[1][key] = node(lat, 1.0, public_transport="stop_position", bus="yes", name="Hôpital")
    nodes = objs.maps[1]["wR"]["nodes"]
    nodes.insert(nodes.index(after) + 1, key)
    return objs


def make_stops(rows, neighbours=None, platforms=None, holders=None, rivals=None):
    df = pd.DataFrame(rows).set_index("stop_id")
    df["label"] = df["stop_name"]
    empty = {s: [] for s in df.index}
    return Stops(df, platforms or dict(empty), neighbours or dict(empty), holders or {}, rivals or dict(empty))


def gtfs_stop(stop_id, code, lat, lon, name="Hopital"):
    return {"stop_id": stop_id, "stop_code": code, "stop_name": name, "wheelchair_boarding": "",
            "platform_code": "", "lat": lat, "lon": lon}


@pytest.mark.parametrize("stop_id, code, ref", [
    ("FR:76216:ZE:TCARxCAILL3:ATOUMOD001", "", "TCARxCAILL3"),  # no stop_code: code of the NeTEx id
    ("FR:76216:ZE:TCARxCAILL3:ATOUMOD001", "2705028A", "2705028A"),  # stop_code wins
    ("1234", "", None),
])
def test_stop_ref(stop_id, code, ref, default_settings):
    default_settings.ref_from_stop_id = True
    assert stop_ref(gtfs_stop(stop_id, code, 49.0, 1.0), stop_id) == ref


def test_no_ref_from_stop_id_by_default():
    stop_id = "FR:76216:ZE:TCARxCAILL3:ATOUMOD001"
    assert stop_ref(gtfs_stop(stop_id, "", 49.0, 1.0), stop_id) is None


# --- direction of travel ---------------------------------------------------------------------------------

def test_forward_way_drawn_against_travel():
    obj = road()
    assert forward(obj, ["w1", "w2"], 0)  # w1 travelled in node order
    assert not forward(obj, ["w1", "w2"], 1)  # w2 drawn southwards, travelled northwards


def test_travel_segment_follows_direction_of_travel():
    obj = ChainMap({}, road())
    spot = locate_stop(obj, ["w1", "w2"], (49.0007, EAST), start=1)
    a, b = travel_segment(obj, ["w1", "w2"], spot)
    assert a[0] < b[0]  # northwards, although w2 is drawn southwards


# --- stop_position ---------------------------------------------------------------------------------------

def test_locate_changes_nothing_and_materialize_inserts_the_node():
    obj = street()
    spot = locate_stop(obj, ["wR"], (49.0004, EAST))
    assert spot.node is None and spot.pos[0] == pytest.approx(49.0004) and not obj.maps[0]
    key = materialize(obj, ["wR"], spot, "Hôpital")
    assert obj["wR"]["nodes"] == ["r1", "r2", key, "r3", "r4", "r5"]
    assert obj[key]["tags"] == stop_position_tags("Hôpital")
    assert obj.parents["wR"]["nodes"] == ["r1", "r2", "r3", "r4", "r5"]  # extract untouched


def test_existing_stop_position_near_the_projection_is_reused():
    obj = with_stop_position(street(), "nSP", 49.00065, "r3")  # 28 m north of the projection
    spot = locate_stop(obj, ["wR"], (49.0004, EAST))
    assert spot.node == "nSP"


def test_stop_position_of_the_opposite_stop_is_left_to_it():
    # northbound stop on the east kerb at 49.0004; the stop of the same name for the other direction is on
    # the west kerb at 49.00065 and the existing stop_position is in front of it: a new stop_position is
    # created in front of ours, closer on the way
    obj = with_stop_position(street(), "nSP", 49.00065, "r3")
    spot = locate_stop(obj, ["wR"], (49.0004, EAST), rivals=[(49.00065, WEST)])
    assert spot.node is None and spot.pos[0] == pytest.approx(49.0004)


def test_face_to_face_stops_share_the_stop_position():
    obj = with_stop_position(street(), "nSP", 49.0004, "r2")
    spot = locate_stop(obj, ["wR"], (49.0004, EAST), rivals=[(49.0004, WEST)])
    assert spot.node == "nSP"


def test_rival_at_the_same_place_is_the_same_platform():
    # another network's stop_id for the same physical platform does not take the stop_position away
    obj = with_stop_position(street(), "nSP", 49.00065, "r3")
    spot = locate_stop(obj, ["wR"], (49.0004, EAST), rivals=[(49.00041, EAST)])
    assert spot.node == "nSP"


def test_rival_on_the_same_side_shares_the_stop_position():
    # same name, same kerb, 28 m apart: duplicate of the platform (another network), not the other direction
    obj = with_stop_position(street(), "nSP", 49.00065, "r3")
    spot = locate_stop(obj, ["wR"], (49.0004, EAST), rivals=[(49.00065, EAST)])
    assert spot.node == "nSP"


def test_stop_position_a_few_metres_away_is_shared_even_with_a_rival_in_front():
    obj = with_stop_position(street(), "nSP", 49.00048, "r2")  # 9 m from the projection
    spot = locate_stop(obj, ["wR"], (49.0004, EAST), rivals=[(49.00048, WEST)])
    assert spot.node == "nSP"


def test_nearly_face_to_face_stops_keep_the_existing_stop_position():
    # stops 8 m apart along the road: they share the existing stop_position 12 m away, rather than one of
    # them getting a new node that the other would then take too
    obj = with_stop_position(street(), "nSP", 49.000508, "r3")
    spot = locate_stop(obj, ["wR"], (49.0004, EAST), rivals=[(49.00047, WEST)])
    assert spot.node == "nSP"


def test_rival_on_another_road_is_ignored():
    obj = with_stop_position(street(), "nSP", 49.00065, "r3")
    spot = locate_stop(obj, ["wR"], (49.0004, EAST), rivals=[(49.00065, 1.002)])  # ~150 m east
    assert spot.node == "nSP"


def test_stop_position_nearest_to_the_platform_is_reused():
    # two existing stop_positions within reach: the one in front of the platform (east kerb, 49.00055)
    obj = with_stop_position(street(), "nSP1", 49.0004, "r2")
    obj = with_stop_position(obj, "nSP2", 49.00055, "r3")
    spot = locate_stop(obj, ["wR"], (49.00055, EAST), platform=True)
    assert spot.node == "nSP2"


def test_stop_position_of_the_rival_platform_is_left_to_it():
    # the only stop_position within reach is in front of the opposite platform (west kerb, 49.00065): ours
    # is created in front of our platform
    obj = with_stop_position(street(), "nSP", 49.00065, "r3")
    spot = locate_stop(obj, ["wR"], (49.0004, EAST), rivals=[(49.00065, WEST)], platform=True)
    assert spot.node is None and spot.pos[0] == pytest.approx(49.0004)
    # face to face: shared
    spot = locate_stop(obj, ["wR"], (49.00065, EAST), rivals=[(49.00065, WEST)], platform=True)
    assert spot.node == "nSP"


def test_stop_position_too_far_along_the_way_is_not_reused():
    obj = with_stop_position(street(), "nSP", 49.00072, "r3")  # 35 m from the projection
    spot = locate_stop(obj, ["wR"], (49.0004, EAST))
    assert spot.node is None


def test_stop_position_of_another_vehicle_is_not_reused():
    obj = with_stop_position(street(), "nSP", 49.0004, "r2")
    obj.maps[1]["nSP"]["tags"] = {"public_transport": "stop_position", "tram": "yes"}
    assert locate_stop(obj, ["wR"], (49.0004, EAST)).node is None


def test_stop_position_created_even_far_from_the_trace():
    obj = ChainMap({}, road())
    far = {"stop_name": "Hopital", "lat": 49.0005, "lon": 1.001}  # ~70 m east of the road
    assert place_stop(obj, ["w1", "w2"], far, 0) is None
    i, key = place_stop(obj, ["w1", "w2"], far, 0, max_m=float("inf"))
    assert obj[key]["tags"] == stop_position_tags("Hopital") and key in obj[["w1", "w2"][i]]["nodes"]


def test_existing_stop_position_keeps_only_its_tags():
    obj = ChainMap({}, road())
    obj.maps[1]["n2"]["tags"] = {"public_transport": "stop_position", "bus": "yes", "name": "Leclerc",
                                 "ref": "DRELECL1", "network": "Linéad", "operator": "Keolis"}
    set_stop_position_tags(obj, "n2", "Hôpital")
    assert obj["n2"]["tags"] == {"bus": "yes", "name": "Hôpital", "public_transport": "stop_position"}


def test_existing_stop_position_keeps_the_other_vehicles():
    obj = ChainMap({}, road())
    obj.maps[1]["n2"]["tags"] = {"public_transport": "stop_position", "tram": "yes", "name": "X"}
    set_stop_position_tags(obj, "n2", "Hôpital")
    assert obj["n2"]["tags"] == {"tram": "yes", "bus": "yes", "name": "Hôpital", "public_transport": "stop_position"}


def test_compliant_stop_position_not_modified():
    obj = ChainMap({}, road())
    obj.maps[1]["n2"]["tags"] = stop_position_tags("Hôpital")
    set_stop_position_tags(obj, "n2", "Hôpital")
    assert "n2" not in obj.maps[0]


# --- whole lines -----------------------------------------------------------------------------------------

def line_stops():
    """Stops along street(): S / A / N on the east kerb (northbound), N2 / B / S2 on the west kerb."""
    rows = [gtfs_stop("S", "1A", 48.9997, 1.00015, "Sud"), gtfs_stop("A", "10A", 49.0004, EAST),
            gtfs_stop("N", "2A", 49.0013, 1.00015, "Nord"), gtfs_stop("N2", "2B", 49.0013, 0.99985, "Nord"),
            gtfs_stop("B", "10B", 49.00065, WEST), gtfs_stop("S2", "1B", 48.9997, 0.99985, "Sud")]
    pairs = {"S": ["S2"], "S2": ["S"], "A": ["B"], "B": ["A"], "N": ["N2"], "N2": ["N"]}
    return make_stops(rows, neighbours=pairs, rivals=pairs)


def build(variants, stops, obj):
    assignments, created = {}, {}
    route = pd.Series({"route_id": "R1", "route_short_name": "1", "route_color": "", "route_text_color": "",
                       "mode": "bus"})
    build_line(route, variants, obj, stops, NOMAD, assignments, created)
    return [o for k, o in obj.maps[0].items() if k[0] == "r" and o["tags"]["type"] == "route"], assignments


def stop_members(rel):
    return [ref for ref, role in rel["members"] if role == "stop"]


def test_both_directions_get_their_own_stop_position_on_a_two_way_street():
    obj, stops = street(), line_stops()
    north = {"direction": "0", "seq": ("S", "A", "N"), "shape_id": "", "trip_id": "t1", "ways": ["wS", "wR", "wN"]}
    south = {"direction": "1", "seq": ("N2", "B", "S2"), "shape_id": "", "trip_id": "t2", "ways": ["wN", "wR", "wS"]}
    (rn, rs), _ = build([north, south], stops, obj)
    a, b = stop_members(rn)[1], stop_members(rs)[1]
    assert a != b
    assert obj[a]["lat"] == pytest.approx(49.0004) and obj[b]["lat"] == pytest.approx(49.00065)


def test_stop_across_the_road_uses_the_opposite_stop_and_its_stop_position():
    # the GTFS gives stop B (west) to the northbound route: the data and the stop_position of A (east, same
    # stop) are used
    obj, stops = street(), line_stops()
    north = {"direction": "0", "seq": ("S", "B", "N"), "shape_id": "", "trip_id": "t1", "ways": ["wS", "wR", "wN"]}
    (rel,), assignments = build([north], stops, obj)
    assert obj[stop_members(rel)[1]]["lat"] == pytest.approx(49.0004)
    assert "A" in assignments and "B" not in assignments


# --- platforms -------------------------------------------------------------------------------------------

def test_fix_side_takes_the_sibling_on_the_kerb_side():
    # the GTFS attaches the (northbound) route to platform A, west = across the road; B (same code) is on
    # the kerb side
    s = make_stops([gtfs_stop("A", "10A", 49.0005, WEST), gtfs_stop("B", "10B", 49.0005, EAST)],
                   neighbours={"A": ["B"], "B": ["A"]},
                   platforms={"A": [{"id": "nPA", "pos": (49.0005, WEST), "name": "Hopital", "holder": False}],
                              "B": [{"id": "nPB", "pos": (49.0005, EAST), "name": "Hopital", "holder": False}]})
    segment = ((49.0, 1.0), (49.001, 1.0))
    platform, data_id = fix_side("A", s.platforms["A"][0], segment, s)
    assert (platform["id"], data_id) == ("nPB", "B")


def test_fix_side_without_sibling_changes_nothing():
    s = make_stops([gtfs_stop("A", "10A", 49.0005, WEST)])
    assert fix_side("A", None, ((49.0, 1.0), (49.001, 1.0)), s) == (None, "A")


def test_far_platform_only_on_the_kerb_side_next_to_the_road():
    segment = ((49.0, 1.0), (49.001, 1.0))  # northbound: kerb side = east
    far = lambda pid, lon: {"id": pid, "pos": (49.0005, lon), "name": "X", "holder": False, "far": True}
    near_west = {"id": "nW", "pos": (49.0005, WEST), "name": "X", "holder": False, "far": False}
    assert choose_platform([far("nE", EAST)], (49.0005, 1.0), segment)["id"] == "nE"
    assert choose_platform([far("nW2", WEST)], (49.0005, 1.0), segment) is None  # across the road
    assert choose_platform([far("nP", 1.0005)], (49.0005, 1.0), segment) is None  # 37 m off: parallel street
    assert choose_platform([far("nE", EAST)], (49.0005, 1.0)) is None  # side unknown
    # on a street the route does not take (beyond the end of the travelled ways), even along the line
    assert choose_platform([far("nE", EAST)], (49.0005, 1.0), segment, road=lambda p: 32) is None
    # a near platform across the road is still the fallback, a far one never is
    assert choose_platform([near_west, far("nW2", WEST)], (49.0005, 1.0), segment)["id"] == "nW"


def test_road_distance_stops_at_the_end_of_the_travelled_ways():
    # 15 m east of the line of wR, but 39 m beyond its end (r5, 49.001): the route does not go there
    obj = street()
    assert road_distance(obj, ["wR"], (49.0005, EAST)) == pytest.approx(14.6, abs=0.5)
    assert road_distance(obj, ["wR"], (49.00135, EAST)) > 40


def test_left_hand_traffic_platform_on_the_left(default_settings):
    default_settings.driving_side = "left"
    candidates = [{"id": "nW", "pos": (49.0005, WEST), "name": "X", "holder": False},
                  {"id": "nE", "pos": (49.0005, EAST), "name": "X", "holder": False}]
    assert choose_platform(candidates, (49.0005, 1.0), ((49.0, 1.0), (49.001, 1.0)))["id"] == "nW"
    default_settings.driving_side = "right"
    assert choose_platform(candidates, (49.0005, 1.0), ((49.0, 1.0), (49.001, 1.0)))["id"] == "nE"


def test_explicit_platform_on_a_way_stays_a_platform():
    candidates = {"A": [{"id": "nPlatform"}, {"id": "nLegacy"}, {"id": "nOffRoad"}]}
    osm = {"nPlatform": node(49.0, 1.0, public_transport="platform", highway="bus_stop"),
           "nLegacy": node(49.0, 1.0, highway="bus_stop")}
    result = filter_road_platforms(candidates, {"nPlatform", "nLegacy"}, osm)
    assert [c["id"] for c in result["A"]] == ["nPlatform", "nOffRoad"]


def test_single_platform_gets_the_stop_id(default_settings):
    # a single GTFS stop for both directions, an OSM platform on each side
    default_settings.stop_ref_tags = ["ref:FR:Atoumod"]
    s = make_stops([gtfs_stop("H", "2705028A", 49.0005, 1.00005)])
    obj = ChainMap({}, {"nE": node(49.0005, 1.0001, name="Hopital"), "nW": node(49.0005, 0.9999, name="Hopital")})
    tag_platforms(obj, s, {"H": {"nE": (NOMAD, (49.0005, 1.0001), "bus"), "nW": (NOMAD, (49.0005, 0.9999), "bus")}})
    assert obj["nE"]["tags"]["ref:FR:Atoumod"] == "H" and obj["nE"]["tags"]["ref"] == "2705028A"
    assert "ref:FR:Atoumod" not in obj["nW"]["tags"] and "ref" not in obj["nW"]["tags"]
    assert obj["nW"]["tags"]["network"] == "Nomad"  # still completed (name, network)


def test_platform_already_holding_the_stop_id_wins_and_duplicate_removed():
    s = make_stops([gtfs_stop("H", "2705028A", 49.0005, 1.00005)], holders={"H": {"nE", "nW"}})
    obj = ChainMap({}, {"nE": node(49.0005, 1.0001, **{"gtfs:stop_id": "H"}),
                        "nW": node(49.0005, 0.9999, **{"gtfs:stop_id": "H"})})
    tag_platforms(obj, s, {"H": {"nE": (NOMAD, (49.0005, 1.0001), "bus"), "nW": (NOMAD, (49.0005, 0.9999), "bus")}})
    assert obj["nE"]["tags"]["gtfs:stop_id"] == "H"
    assert "gtfs:stop_id" not in obj["nW"]["tags"]  # duplicate already in OSM: removed


def test_stop_id_held_by_another_osm_platform_is_not_set():
    s = make_stops([gtfs_stop("H", "2705028A", 49.0005, 1.00005)], holders={"H": {"nElsewhere"}})
    obj = ChainMap({}, {"nE": node(49.0005, 1.0001)})
    elsewhere = tag_platforms(obj, s, {"H": {"nE": (NOMAD, (49.0005, 1.0001), "bus")}})
    assert len(elsewhere) == 1 and "gtfs:stop_id" not in obj["nE"]["tags"]


def test_enrich_numbers_other_networks_and_keeps_survey_tags():
    obj = ChainMap({}, {"nP": node(49.0, 1.0, network="Twisto", ref="X1", wheelchair="no", highway="platform")})
    enrich(obj, "nP", {"network": "Nomad", "network:wikidata": "Q1", "ref": "Y2", "wheelchair": "yes",
                       "highway": "bus_stop", "name": "Gare"})
    t = obj["nP"]["tags"]
    assert t["network"] == "Twisto" and t["network:2"] == "Nomad" and t["network:wikidata:2"] == "Q1"
    assert t["ref"] == "X1" and t["ref:2"] == "Y2"
    assert t["wheelchair"] == "no" and t["highway"] == "platform" and "wheelchair:2" not in t
    assert t["name"] == "Gare"


def test_stop_served_both_ways_without_direction_id_gets_a_platform_per_side():
    # a single GTFS stop for both directions, an OSM platform on each kerb, no direction_id in the feed
    obj = street(nE=node(49.0005, EAST, name="Milieu"), nW=node(49.0005, WEST, name="Milieu"))
    stops = make_stops([gtfs_stop("S", "", 48.9997, 1.0, "Sud"), gtfs_stop("M", "", 49.0005, 1.00001, "Milieu"),
                        gtfs_stop("N", "", 49.0013, 1.0, "Nord")],
                       platforms={"S": [], "N": [],
                                  "M": [{"id": "nE", "pos": (49.0005, EAST), "name": "Milieu", "holder": False},
                                        {"id": "nW", "pos": (49.0005, WEST), "name": "Milieu", "holder": False}]})
    north = {"direction": "0", "seq": ("S", "M", "N"), "shape_id": "", "trip_id": "t1", "ways": ["wS", "wR", "wN"]}
    south = {"direction": "0", "seq": ("N", "M", "S"), "shape_id": "", "trip_id": "t2", "ways": ["wN", "wR", "wS"]}
    (rn, rs), _ = build([north, south], stops, obj)
    platform = lambda rel: [ref for ref, role in rel["members"] if role == "platform"][1]
    assert (platform(rn), platform(rs)) == ("nE", "nW")
