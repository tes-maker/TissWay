"""Paramètres : chemins des données, seuils de distance et réseaux connus.

Les distances sont en mètres. Les modifier ici suffit : aucun autre module ne code de valeur en dur.
"""

from pathlib import Path

# --- Données en entrée / sortie ---

GEO_API_URL = "https://geo.api.gouv.fr/communes"
VALHALLA_URL = "http://localhost:8002"
PBF_PATH = "normandy-latest.osm.pbf"
GTFS_DIR = "gtfs_atoumod"
OSM_STOPS_CACHE = "osm_bus_stops.geojsonseq"
OUTPUT_DIR = Path("output_osm")


# --- Seuils (mètres) ---

MAX_STOP_DISTANCE_M = 20  # arrêt GTFS -> quai OSM existant
MAX_STOP_POSITION_M = 40  # arrêt GTFS -> voie empruntée (stop_position)
MAX_OPPOSITE_STOP_M = 30  # arrêt GTFS -> arrêt GTFS d'en face, pour les arrêts sans code (voir sibling_code)
MAX_SIBLING_M = 100  # arrêt GTFS -> autre quai du même arrêt (même code, autre lettre : 2702282A / 2702282B)
MAX_HOLDER_M = 100  # arrêt GTFS -> quai OSM portant déjà son stop_id (coordonnées GTFS approximatives)
MAX_TRACE_M = 150_000  # Valhalla refuse les traces de plus de 200 km : on découpe au-delà


# --- GTFS et réseaux ---

MIN_VARIANT_SHARE = 0.10  # part minimale des trajets d'un sens pour qu'une variante soit cartographiée
BUS_ROUTE_TYPE = "3"  # GTFS route_type : on ignore train/tram/ferry, hors périmètre (voies + Valhalla costing bus)
# Réseaux vérifiés sur OSM (code d'agence Atoumod -> tags) ; les autres sont dérivés de agency_name, sans
# wikidata inventé (voir naming.agency_networks).
NETWORKS = {
    "040": {"network": "Nomad", "network:wikidata": "Q98131290", "network:wikipedia": "fr:Nomad (réseau)"},
    "029": {"network": "Twisto", "network:wikidata": "Q3537947"},
}
GTFS_FEED = "FR-NOR-Atoumod"
