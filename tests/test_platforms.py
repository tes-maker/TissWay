"""Choix du quai : sens de parcours, arrêt d'en face (codes A/B), un seul quai par stop_id GTFS."""
from collections import ChainMap

import pandas as pd

from atoumod.platforms import direction, fix_side, forward, tag_platforms
from atoumod.stops import Stops

NOMAD = {"network": "Nomad"}
WEST, EAST = 0.9998, 1.0002  # de part et d'autre d'une route nord-sud à la longitude 1.0


def node(lat, lon, **tags):
    return {"version": "1", "lat": lat, "lon": lon, "tags": tags}


def road():
    """Route nord-sud n1 -> n2 -> n3, dessinée en deux voies : w1 vers le nord, w2 vers le sud."""
    return {"n1": node(49.0, 1.0), "n2": node(49.0005, 1.0), "n3": node(49.001, 1.0),
            "w1": {"version": "1", "tags": {}, "nodes": ["n1", "n2"]},
            "w2": {"version": "1", "tags": {}, "nodes": ["n3", "n2"]}}


def stops(rows, neighbours=None, platforms=None, holders=None):
    df = pd.DataFrame(rows).set_index("stop_id")
    return Stops(df, platforms or {s: [] for s in df.index}, neighbours or {s: [] for s in df.index}, holders or {})


def gtfs_stop(stop_id, code, lat, lon):
    return {"stop_id": stop_id, "stop_code": code, "stop_name": "Hopital", "wheelchair_boarding": "0",
            "lat": lat, "lon": lon}


def test_forward_voie_dessinee_a_contre_sens():
    obj = road()
    assert forward(obj, ["w1", "w2"], 0)  # w1 parcourue dans le sens de ses nœuds
    assert not forward(obj, ["w1", "w2"], 1)  # w2 dessinée vers le sud, parcourue vers le nord


def test_direction_suit_le_sens_de_parcours():
    obj = road()
    a, b = direction(obj, ("w2", "n2", False))
    assert a[0] < b[0]  # vers le nord, bien que w2 soit dessinée vers le sud


def test_fix_side_prend_l_arret_jumeau_de_droite():
    # le GTFS rattache la ligne (vers le nord) au quai A, à l'ouest = à gauche ; B (même code) est à droite
    s = stops([gtfs_stop("A", "10A", 49.0005, WEST), gtfs_stop("B", "10B", 49.0005, EAST)],
              neighbours={"A": ["B"], "B": ["A"]},
              platforms={"A": [{"id": "nPA", "pos": (49.0005, WEST), "name": "Hopital", "holder": False}],
                         "B": [{"id": "nPB", "pos": (49.0005, EAST), "name": "Hopital", "holder": False}]})
    obj = road()
    platform, data_id = fix_side("A", s.platforms["A"][0], obj, ("w1", "n2", True), s)
    assert (platform["id"], data_id) == ("nPB", "B")


def test_fix_side_sans_jumeau_ne_change_rien():
    s = stops([gtfs_stop("A", "10A", 49.0005, WEST)])
    obj = road()
    assert fix_side("A", None, obj, ("w1", "n2", True), s) == (None, "A")


def test_un_seul_quai_recoit_le_stop_id():
    # cas « Hopital » : un seul arrêt GTFS pour les deux sens, un quai OSM de chaque côté
    s = stops([gtfs_stop("H", "2705028A", 49.0005, 1.00005)])
    osm = {"nE": node(49.0005, 1.0001, name="Hopital"), "nW": node(49.0005, 0.9999, name="Hopital")}
    obj = ChainMap({}, osm)
    tag_platforms(obj, s, {"H": {"nE": (NOMAD, (49.0005, 1.0001)), "nW": (NOMAD, (49.0005, 0.9999))}})
    assert obj["nE"]["tags"]["ref:FR:Atoumod"] == "H" and obj["nE"]["tags"]["ref"] == "2705028A"
    assert "ref:FR:Atoumod" not in obj["nW"]["tags"] and "ref" not in obj["nW"]["tags"]
    assert obj["nW"]["tags"]["network"] == "Nomad"  # toujours complété (nom, réseau)


def test_quai_portant_deja_le_stop_id_est_prioritaire_et_doublon_retire():
    s = stops([gtfs_stop("H", "2705028A", 49.0005, 1.00005)], holders={"H": {"nE", "nW"}})
    osm = {"nE": node(49.0005, 1.0001, **{"gtfs:stop_id": "H"}), "nW": node(49.0005, 0.9999, **{"gtfs:stop_id": "H"})}
    obj = ChainMap({}, osm)
    tag_platforms(obj, s, {"H": {"nE": (NOMAD, (49.0005, 1.0001)), "nW": (NOMAD, (49.0005, 0.9999))}})
    assert obj["nE"]["tags"]["gtfs:stop_id"] == "H"
    assert "gtfs:stop_id" not in obj["nW"]["tags"]  # doublon déjà présent dans OSM : retiré


def test_stop_id_deja_sur_un_autre_quai_osm_n_est_pas_pose():
    s = stops([gtfs_stop("H", "2705028A", 49.0005, 1.00005)], holders={"H": {"nAilleurs"}})
    obj = ChainMap({}, {"nE": node(49.0005, 1.0001)})
    elsewhere = tag_platforms(obj, s, {"H": {"nE": (NOMAD, (49.0005, 1.0001))}})
    assert len(elsewhere) == 1 and "ref:FR:Atoumod" not in obj["nE"]["tags"]
