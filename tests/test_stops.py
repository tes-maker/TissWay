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
        ("n4", "Mairie", None, None, 49.0005, 1.0),  # 55 m
    ]))
    assert sorted((c["id"], c["holder"]) for c in s.platforms["A"]) == [("n1", False), ("n2", True)]
    assert s.holders == {"A": {"n2"}}
