"""Local geometry: distances, kerb side, polylines."""
import pytest

from tissway.geo import decode_polyline, dist, distances_to_polyline, path_length, project, right_of

A, B = (49.0, 1.0), (49.001, 1.0)  # northbound road (~110 m)


def test_dist_one_thousandth_of_a_degree_of_latitude():
    assert dist(A, B) == pytest.approx(110.6, abs=0.5)


def test_project_middle_of_the_segment():
    t, d = project((49.0005, 1.0001), A, B)
    assert t == pytest.approx(0.5, abs=0.01)
    assert d == pytest.approx(7.3, abs=0.2)  # 0.0001° of longitude at 49° N


def test_right_of_depends_on_the_direction_of_travel():
    east, west = (49.0005, 1.0002), (49.0005, 0.9998)
    assert right_of(east, A, B) and not right_of(west, A, B)  # northwards: east is on the right
    assert right_of(west, B, A) and not right_of(east, B, A)  # southwards: west is on the right


def test_path_length_and_distances_to_polyline():
    assert path_length([A, B, A])[-1] == pytest.approx(2 * dist(A, B), rel=1e-3)
    d = distances_to_polyline([(49.0005, 1.0001), (49.002, 1.0)], [A, B])
    assert d[0] == pytest.approx(7.3, abs=0.2) and d[1] == pytest.approx(dist((49.002, 1.0), B), rel=1e-3)
    assert distances_to_polyline([A], [])[0] == float("inf")


def test_decode_polyline_precision_6():
    # Valhalla's encoding of [(49.0, 1.0), (49.001, 1.0)]
    encoded = "_cvm|A_c`|@o}@?"
    assert decode_polyline(encoded) == [pytest.approx(A), pytest.approx(B)]
