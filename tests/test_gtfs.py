"""GTFS reading: optional files and columns, zip archives, route types, variants."""
import zipfile

import pandas as pd
import pytest

from tissway.gtfs import Feed, GTFSError, is_sub_route, line_variants, osm_route, stop_sequences

MINIMAL = {  # only the required files and columns: no agency.txt, shapes.txt, direction_id, stop_code...
    "routes.txt": "route_id,route_short_name,route_type\nR1,1,3\nR2,T,0\n",
    "trips.txt": "route_id,service_id,trip_id\nR1,S,t1\nR1,S,t2\n",
    "stops.txt": ("stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\n"
                  "ST,Gare,49.0,1.0,1,\nA,,49.0001,1.0001,0,ST\nB,Mairie,49.001,1.0,,\nE,Entrance,49.0,1.0,2,ST\n"),
    "stop_times.txt": ("trip_id,arrival_time,departure_time,stop_id,stop_sequence\n"
                       "t1,08:00:00,08:00:00,A,1\nt1,08:05:00,08:05:00,B,10\n"
                       "t2,09:00:00,09:00:00,B,2\nt2,09:05:00,09:05:00,A,1\n"),
}


def write_feed(folder, files):
    folder.mkdir()
    for name, content in files.items():
        (folder / name).write_text(content, encoding="utf-8")
    return folder


def test_minimal_feed_gets_the_optional_columns(tmp_path):
    feed = Feed(write_feed(tmp_path / "gtfs", MINIMAL))
    assert list(feed.agency["agency_id"]) == [""]
    assert {"agency_id", "route_color", "mode"} <= set(feed.routes)
    assert list(feed.routes["mode"]) == ["bus", "tram"]
    assert set(feed.trips["shape_id"]) == {""} and set(feed.trips["direction_id"]) == {""}
    assert feed.shapes({"x"}) == {}


def test_stops_keep_boarding_locations_and_inherit_the_station_name(tmp_path):
    stops = Feed(write_feed(tmp_path / "gtfs", MINIMAL)).stops.set_index("stop_id")
    assert sorted(stops.index) == ["A", "B"]
    assert stops.at["A", "stop_name"] == "Gare" and stops.at["A", "lat"] == pytest.approx(49.0001)
    assert stops.at["A", "stop_code"] == ""


def test_zip_feed_in_a_sub_folder(tmp_path):
    path = tmp_path / "feed.zip"
    with zipfile.ZipFile(path, "w") as z:
        for name, content in MINIMAL.items():
            z.writestr(f"export/{name}", "﻿" + content)  # with a byte order mark
    feed = Feed(path)
    assert list(feed.routes["route_id"]) == ["R1", "R2"]
    st = feed.stop_times(["t1"])
    assert list(st.sort_values("stop_sequence")["stop_id"]) == ["A", "B"]


def test_missing_feed_or_file(tmp_path):
    with pytest.raises(GTFSError):
        Feed(tmp_path / "nowhere")
    with pytest.raises(GTFSError):
        Feed(write_feed(tmp_path / "gtfs", {"routes.txt": "route_id\n"})).read("trips")


def test_single_agency_fills_route_agency_id(tmp_path):
    files = MINIMAL | {"agency.txt": "agency_id,agency_name,agency_url,agency_timezone\nAG,Bus Co,http://x,UTC\n"}
    assert set(Feed(write_feed(tmp_path / "gtfs", files)).routes["agency_id"]) == {"AG"}


def test_stop_sequences_order_by_stop_sequence(tmp_path):
    feed = Feed(write_feed(tmp_path / "gtfs", MINIMAL))
    trips = stop_sequences(feed.trips, feed.stop_times())
    assert dict(zip(trips["trip_id"], trips["stop_seq"])) == {"t1": ("A", "B"), "t2": ("A", "B")}


@pytest.mark.parametrize("route_type, mode", [("3", "bus"), ("700", "bus"), ("715", "bus"), ("200", "coach"),
                                              ("11", "trolleybus"), ("800", "trolleybus"), ("0", "tram"),
                                              ("2", "train"), ("1000", "ferry"), ("", None), ("42", None)])
def test_osm_route(route_type, mode):
    assert osm_route(route_type) == mode


def test_is_sub_route():
    assert is_sub_route(("b", "c"), ("a", "b", "c", "d"))
    assert not is_sub_route(("a", "c"), ("a", "b", "c"))  # stops not consecutive
    assert not is_sub_route(("c", "b"), ("a", "b", "c"))  # reverse order
    assert not is_sub_route(("a", "b"), ("a", "b"))  # same sequence


def test_line_variants_drops_sub_routes():
    trips = pd.DataFrame({
        "trip_id": ["t1", "t2", "t3", "t4"],
        "direction_id": ["0"] * 4,
        "shape_id": ["s1", "s2", "s3", "s4"],
        "stop_seq": [("a", "b", "c", "d"), ("b", "c"), ("a", "c", "d"), ("a", "b", "c", "d")],
    })
    assert [(seq, trip) for _, seq, _, trip in line_variants(trips)] == [
        (("a", "b", "c", "d"), "t1"), (("a", "c", "d"), "t3")]


def test_line_variants_without_direction_nor_shape():
    trips = pd.DataFrame({"trip_id": ["t1"], "direction_id": [""], "shape_id": [""], "stop_seq": [("a", "b")]})
    assert list(line_variants(trips)) == [("0", ("a", "b"), "", "t1")]
