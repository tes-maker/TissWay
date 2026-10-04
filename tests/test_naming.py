"""Stop labels "LOCALITY Stop", relation names, networks, accents (without calling the Découpage
administratif API)."""
import pandas as pd
import pytest

from tissway import naming

COMMUNES = {"50025": "Avranches", "14271": "Fleury-sur-Orne", "14258": "Condé-sur-Noireau",
            "27375": "Louviers", "35288": "Saint-Malo", "76451": "Mont-Saint-Aignan", "2A004": "Ajaccio"}


@pytest.fixture
def insee(monkeypatch, default_settings):
    default_settings.locality = "insee"
    monkeypatch.setattr(naming, "communes", lambda dept: {k: v for k, v in COMMUNES.items() if k.startswith(dept)})
    monkeypatch.setattr(naming, "commune_at", lambda lat, lon: None)


@pytest.mark.parametrize("code, name, label", [
    ("50025", "Avranches - Gare", "AVRANCHES Gare"),  # "TOWN - Stop" (Nomad)
    ("50025", "Avranches", "AVRANCHES"),  # name = commune
    ("14271", "Fleury Mairie", "FLEURY-SUR-ORNE Mairie"),  # beginning of the commune only
    ("14258", "CONDE-SUR-NOIREAU - Place", "CONDE-SUR-NOIREAU Place"),
    ("35288", "St-Malo Gare", "SAINT-MALO Gare"),  # St = Saint
    ("27375", "Châtel", "LOUVIERS Châtel"),  # commune missing from the name (urban networks)
    ("76451", "Mont aux Malades", "MONT-SAINT-AIGNAN Mont aux Malades"),  # "Mont" followed by something else
    ("2A004", "Cours Napoléon", "AJACCIO Cours Napoléon"),  # Corsican code
])
def test_line_label(insee, code, name, label):
    assert naming.line_label(f"FR:{code}:ZE:1:ATOUMOD040", name) == label


def test_line_label_unknown_commune_keeps_the_gtfs_name(insee):
    assert naming.line_label("FR:99999:ZE:1:ATOUMOD040", "Inconnu") == "Inconnu"


def test_line_label_from_the_position_without_insee_code(insee, monkeypatch):
    monkeypatch.setattr(naming, "commune_at", lambda lat, lon: "Caen")
    assert naming.line_label("stop-12", "Gare", (49.17, -0.35)) == "CAEN Gare"


def test_line_label_without_locality_is_the_stop_name():
    assert naming.line_label("FR:50025:ZE:1", "Avranches - Gare") == "Avranches - Gare"


def test_route_names():
    assert naming.route_name("bus", "12", "A → B") == "Bus 12: A → B"
    assert naming.route_name("coach", "", "A → B") == "Coach: A → B"
    assert naming.master_endpoints_label([("A", "B"), ("B", "A")]) in ("A ↔ B", "B ↔ A")
    assert naming.master_endpoints_label([("A1", "B"), ("B", "A1"), ("A2", "B")]) == "A1 / A2 ↔ B"


def test_slug_and_name_key():
    assert naming.slug("Nomad Car (Région)") == "nomad-car-region"
    assert naming.name_key("Hôpital - Nord") == naming.name_key("HOPITAL NORD")


def test_agency_networks(default_settings):
    default_settings.networks = {"ATOUMOD040:Network:040:LOC": {"network": "Nomad", "network:wikidata": "Q98131290"},
                                 "Bus Co": {"network": "BC"}}
    agency = pd.DataFrame({
        "agency_id": ["ATOUMOD040:Network:040:LOC", "ATOUMOD036:Network:036:LOC", "X", ""],
        "agency_name": ["Nomad Car (Région Normandie)", "Astrobus (Lisieux Normandie)", "Bus Co", ""]})
    networks = naming.agency_networks(agency)
    assert networks["ATOUMOD040:Network:040:LOC"]["network:wikidata"] == "Q98131290"
    assert networks["ATOUMOD036:Network:036:LOC"] == {"network": "Astrobus"}
    assert networks["X"] == {"network": "BC"}  # configured by agency_name
    assert networks[""] == {"network": "GTFS"}


@pytest.mark.parametrize("name, fixed", [
    ("Gare Routiere", "Gare Routière"),
    ("EGLISE", "ÉGLISE"),  # case kept
    ("Ecole Saint-Andre", "École Saint-André"),
    ("La Musardiere", "La Musardière"),  # -iere ending
    ("Lycée Léopold Sédar Senghor", "Lycée Léopold Sédar Senghor"),  # already accented
    ("Clemenceau", "Clemenceau"),  # proper name without accent
    ("Rue de la Marche", "Rue de la Marche"),  # ambiguous: left alone
])
def test_fix_accents(name, fixed):
    assert naming.fix_accents(name) == fixed


def test_clean_stop_name_only_fixes_accents_when_enabled(default_settings):
    assert naming.clean_stop_name("  Gare   Routiere ") == "Gare Routiere"
    default_settings.fix_accents = True
    assert naming.clean_stop_name("Gare Routiere") == "Gare Routière"
