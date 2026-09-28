"""Libellés « VILLE Arrêt » et noms de relations (sans appel à l'API Découpage administratif)."""
import pytest

from atoumod import naming

COMMUNES = {"50025": "Avranches", "14271": "Fleury-sur-Orne", "14258": "Condé-sur-Noireau",
            "27375": "Louviers", "35288": "Saint-Malo", "76451": "Mont-Saint-Aignan"}


@pytest.fixture(autouse=True)
def fake_communes(monkeypatch):
    monkeypatch.setattr(naming, "communes", lambda dept: {k: v for k, v in COMMUNES.items() if k[:2] == dept})


@pytest.mark.parametrize("insee, name, label", [
    ("50025", "Avranches - Gare", "AVRANCHES Gare"),  # « VILLE - Arrêt » (Nomad)
    ("50025", "Avranches", "AVRANCHES"),  # nom = commune
    ("14271", "Fleury Mairie", "FLEURY-SUR-ORNE Mairie"),  # début de la commune seulement
    ("14258", "CONDE-SUR-NOIREAU - Place", "CONDE-SUR-NOIREAU Place"),
    ("35288", "St-Malo Gare", "SAINT-MALO Gare"),  # St = Saint
    ("27375", "Châtel", "LOUVIERS Châtel"),  # commune absente du nom (réseaux urbains)
    ("76451", "Mont aux Malades", "MONT-SAINT-AIGNAN Mont aux Malades"),  # "Mont" suivi d'autre chose
])
def test_line_label(insee, name, label):
    assert naming.line_label(f"FR:{insee}:ZE:1:ATOUMOD040", name) == label


def test_line_label_commune_inconnue_garde_le_nom_gtfs():
    assert naming.line_label("FR:99999:ZE:1:ATOUMOD040", "Inconnu") == "Inconnu"


def test_master_endpoints_label():
    assert naming.master_endpoints_label([("A", "B"), ("B", "A")]) in ("A ↔ B", "B ↔ A")
    assert naming.master_endpoints_label([("A1", "B"), ("B", "A1"), ("A2", "B")]) == "A1 / A2 ↔ B"


def test_slug():
    assert naming.slug("Nomad Car (Région)") == "nomad-car-region"


def test_agency_networks():
    import pandas as pd
    agency = pd.DataFrame({"agency_id": ["ATOUMOD040:Network:040:LOC", "ATOUMOD036:Network:036:LOC"],
                           "agency_name": ["Nomad Car (Région Normandie)", "Astrobus (Lisieux Normandie)"]})
    networks = naming.agency_networks(agency)
    assert networks["ATOUMOD040:Network:040:LOC"]["network:wikidata"] == "Q98131290"
    assert networks["ATOUMOD036:Network:036:LOC"] == {"network": "Astrobus"}
