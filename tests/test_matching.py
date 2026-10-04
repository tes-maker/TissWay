"""Map-matching: chunks, shape rejected when wrong, routing through the stops (Valhalla mocked)."""
import pytest

from tissway import matching

STOPS = [(49.0, 1.0), (49.01, 1.0)]
ON_ROAD = [(49.0, 1.0), (49.005, 1.0), (49.01, 1.0)]
ELSEWHERE = [(49.0, 1.1), (49.01, 1.1)]  # ~7 km east of the stops


@pytest.fixture
def valhalla(monkeypatch):
    calls = []

    def fake_map_match(points):
        calls.append(("match", points))
        if points == "bad":
            raise matching.MatchError("no way matched")
        return (["w1"], ON_ROAD) if points in (ON_ROAD, "route") else (["w9"], ELSEWHERE)

    monkeypatch.setattr(matching, "map_match", fake_map_match)
    monkeypatch.setattr(matching, "route_through", lambda stops: calls.append(("route", stops)) or "route")
    return calls


def test_good_shape_is_used(valhalla):
    assert matching.match_variant(ON_ROAD, STOPS) == (["w1"], "shape")
    assert [c[0] for c in valhalla] == ["match"]


def test_shape_far_from_the_stops_is_replaced_by_routing(valhalla):
    assert matching.match_variant(ELSEWHERE, STOPS) == (["w1"], "stops")


def test_missing_or_unmatchable_shape_routes_through_the_stops(valhalla):
    assert matching.match_variant(None, STOPS) == (["w1"], "stops")
    assert matching.match_variant("bad", STOPS) == (["w1"], "stops")


def test_chunks_overlap_and_respect_the_limits(default_settings):
    default_settings.thresholds.trace_points = 3
    points = [(49.0 + i * 1e-4, 1.0) for i in range(7)]
    chunks = matching._chunks(points)
    assert chunks[0][0] == 0 and chunks[-1][1] == 6
    assert all(e - s <= 3 for s, e in chunks)
    assert all(a[1] == b[0] for a, b in zip(chunks, chunks[1:]))  # one point of overlap
