"""Opposite stops (parent_station, codes 12A / 12B), rival stops, candidate platforms."""
import geopandas as gpd
import pandas as pd

from tissway.stops import match_stops, sibling_code


def test_sibling_code():
    assert sibling_code("2702282A") == sibling_code("2702282B") == "2702282"
    assert sibling_code("plca01") is None  # no trailing letter
    assert sibling_code("AB") is None  # letters only
    assert sibling_code("") is None


def gtfs(rows):
    cols = ["stop_id", "stop_code", "stop_name", "parent_station", "lat", "lon"]
    return pd.DataFrame([dict(zip(cols, r)) for r in rows])


def osm(rows):
    return gpd.GeoDataFrame({"id": [r[0] for r in rows], "name": [r[1] for r in rows],
                             "public_transport": [r[2] for r in rows], "gtfs:stop_id": [r[3] for r in rows]},
                            geometry=gpd.points_from_xy([r[5] for r in rows], [r[4] for r in rows]), crs="EPSG:4326")


def test_neighbours_and_rivals():
    stops = gtfs([
        ("P1", "", "Gare", "ST", 49.0, 1.0002), ("P2", "", "Gare", "ST", 49.0, 0.9998),  # same station
        ("A", "10A", "Mairie", "", 49.01, 1.0002), ("B", "10B", "Mairie", "", 49.01, 0.9998),  # codes
        ("C", "10C", "Mairie", "", 49.0102, 1.0),  # same code, other agency
        ("X", "", "Poste", "", 49.02, 1.0002), ("Y", "", "Poste", "", 49.0206, 0.9998),  # same name, 67 m
    ])
    agencies = {"A": frozenset({"ag1"}), "B": frozenset({"ag1"}), "C": frozenset({"ag2"})}
    s = match_stops(stops, agencies, osm=osm([("n1", "Gare", None, None, 49.0, 1.0003)]))
    assert s.neighbours["P1"] == ["P2"] and sorted(s.neighbours["A"]) == ["B"]
    assert s.neighbours["X"] == [] and s.rivals["X"] == ["Y"]  # too far to be opposite, but same name
    assert "C" in s.rivals["A"] and "C" not in s.neighbours["A"]


def test_candidate_platforms_and_holders():
    stops = gtfs([("A", "", "Mairie", "", 49.0, 1.0)])
    s = match_stops(stops, osm=osm([
        ("n1", "Mairie", "platform", None, 49.0, 1.0002),  # 15 m
        ("n2", "Mairie", None, "A", 49.0007, 1.0),  # 78 m but holds the stop_id
        ("n3", "Mairie", "stop_position", None, 49.0, 1.0),  # never a platform
        ("n4", "Mairie", None, None, 49.0005, 1.0),  # 55 m: extended reach, to be checked
        ("n5", "Poste", None, None, 49.0007, 1.0003),  # 81 m, other name: out of reach
        ("n6", "MAIRIE", None, None, 49.0007, 1.0003),  # 81 m, same name: extended reach
    ]))
    assert sorted((c["id"], c["holder"], c["far"]) for c in s.platforms["A"]) == [
        ("n1", False, False), ("n2", True, False), ("n4", False, True), ("n6", False, True)]
    assert s.holders == {"A": {"n2"}}


def test_far_platform_of_another_stop_left_out():
    # n1 is 55 m from A but next to B: B's platform, not a candidate of A
    stops = gtfs([("A", "", "Mairie", "", 49.0, 1.0), ("B", "", "Poste", "", 49.0006, 1.0)])
    s = match_stops(stops, osm=osm([("n1", "Poste", None, None, 49.0005, 1.0)]))
    assert s.platforms["A"] == [] and [c["id"] for c in s.platforms["B"]] == ["n1"]


def test_far_platform_closer_to_a_stop_of_the_same_name():
    # Jules Ferry (Atoumod): both GTFS directions 37 m apart and ~40 m off; the OSM platforms are closer to
    # J1 but remain candidates of J0 (the side is checked when the platform is chosen)
    stops = gtfs([("J0", "", "Jules Ferry", "", 49.468174, 1.044779),
                  ("J1", "", "Jules Ferry", "", 49.468505, 1.044659)])
    s = match_stops(stops, osm=osm([("n19", "Jules Ferry", "platform", None, 49.4688143, 1.0444221),
                                    ("n20", "Jules Ferry", "platform", None, 49.4686988, 1.0443729)]))
    assert sorted(c["id"] for c in s.platforms["J0"]) == ["n19", "n20"]
