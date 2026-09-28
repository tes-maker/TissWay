"""Quais d'un même arrêt GTFS (codes A/B)."""
from atoumod.stops import sibling_code


def test_sibling_code_meme_arret_meme_reseau():
    a = sibling_code("FR:27375:ZE:1118751:ATOUMOD040", "2702282A")
    assert a == "ATOUMOD040:2702282" == sibling_code("FR:27375:ZE:1:ATOUMOD040", "2702282B")


def test_sibling_code_autre_reseau_different():
    assert sibling_code("X:ATOUMOD040", "12A") != sibling_code("X:ATOUMOD029", "12A")


def test_sibling_code_sans_lettre():
    assert sibling_code("X:ATOUMOD029", "plca01") is None
    assert sibling_code("X:ATOUMOD040", None) is None
