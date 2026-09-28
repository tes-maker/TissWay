"""Géométrie locale : distances et côté de la route."""
import pytest

from atoumod.geo import dist, project, right_of

A, B = (49.0, 1.0), (49.001, 1.0)  # route vers le nord (~110 m)


def test_dist_un_millieme_de_degre_de_latitude():
    assert dist(A, B) == pytest.approx(110.6, abs=0.5)


def test_project_milieu_du_segment():
    t, d = project((49.0005, 1.0001), A, B)
    assert t == pytest.approx(0.5, abs=0.01)
    assert d == pytest.approx(7.3, abs=0.2)  # 0.0001° de longitude à 49° N


def test_right_of_depend_du_sens_de_parcours():
    east, west = (49.0005, 1.0002), (49.0005, 0.9998)
    assert right_of(east, A, B) and not right_of(west, A, B)  # vers le nord : l'est est à droite
    assert right_of(west, B, A) and not right_of(east, B, A)  # vers le sud : l'ouest est à droite
