"""Découpage d'un rond-point d'un seul tenant, entrée au nœud r1 et sortie au nœud r3."""
from collections import ChainMap

from atoumod import roundabouts

RING = ["n1", "n2", "n3", "n4", "n1"]  # sens giratoire = ordre des nœuds


def osm():
    return {
        "w10": {"version": "1", "tags": {"highway": "primary"}, "nodes": ["n0", "n1"]},  # entrée
        "w20": {"version": "3", "tags": {"highway": "primary", "junction": "roundabout"}, "nodes": list(RING)},
        "w30": {"version": "1", "tags": {"highway": "primary"}, "nodes": ["n3", "n9"]},  # sortie
    }


def test_split_roundabouts(monkeypatch):
    # une relation OSM existante (autre ligne) contient le rond-point entier
    other = {"r5": {"version": "2", "tags": {"type": "route"}, "members": [("w10", ""), ("w20", ""), ("w30", "")]}}
    monkeypatch.setattr(roundabouts, "parent_relations", lambda ids: other)
    obj = ChainMap({}, osm())
    variant = {"ways": ["w10", "w20", "w30"]}

    assert roundabouts.split_roundabouts([variant], obj) == 1

    # le plus long morceau (ici le premier, à égalité) garde l'id et la version du rond-point
    assert obj["w20"]["nodes"] == ["n1", "n2", "n3"] and obj["w20"]["version"] == "3"
    [new] = [k for k in obj.maps[0] if k.startswith("w-")]
    assert obj[new]["nodes"] == ["n3", "n4", "n1"] and "version" not in obj[new]
    assert obj[new]["tags"]["junction"] == "roundabout"
    # la ligne ne garde que le morceau parcouru, pas le tour complet
    assert variant["ways"] == ["w10", "w20", "w30"]
    # la relation existante reçoit tous les morceaux, dans le sens giratoire depuis son entrée : pas de trou
    assert obj["r5"]["members"] == [("w10", ""), ("w20", ""), (new, ""), ("w30", "")]
    # le PBF lu reste intact sous les objets modifiés
    assert obj.parents["w20"]["nodes"] == RING


def test_un_seul_passage_pas_de_decoupage(monkeypatch):
    monkeypatch.setattr(roundabouts, "parent_relations", lambda ids: {})
    obj = ChainMap({}, osm())
    variant = {"ways": ["w10", "w20"]}  # la ligne se termine sur le rond-point : une seule coupe
    assert roundabouts.split_roundabouts([variant], obj) == 0
    assert not obj.maps[0]


def test_traversed_demi_tour_fait_le_tour_complet():
    obj = {"a": {"nodes": ["n1", "n2", "n3"]}, "b": {"nodes": ["n3", "n4", "n1"]}}
    assert roundabouts.traversed(["a", "b"], obj, "n1", "n1") == ["a", "b"]
    assert roundabouts.traversed(["a", "b"], obj, "n3", "n1") == ["b"]
