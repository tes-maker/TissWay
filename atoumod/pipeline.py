"""Enchaînement complet : GTFS -> variantes map-matchées -> relations PTv2 -> fichier .osm.

Étapes de run() :
1. choix des lignes (réseau, numéros) dans le GTFS ;
2. arrêts GTFS rapprochés des quais OSM (stops.match_stops) ;
3. map-matching de chaque variante par Valhalla (matching.map_match) ;
4. lecture dans le PBF des voies empruntées et des quais candidats ;
5. découpage des ronds-points, une fois pour toutes les lignes (roundabouts.split_roundabouts) ;
6. relations de chaque ligne (build.build_line), puis tags GTFS des quais (platforms.tag_platforms) ;
7. écriture d'un seul fichier .osm (objets partagés entre lignes : pas de conflit à l'envoi).
"""

from collections import ChainMap
from itertools import groupby

import requests

from .build import build_line
from .config import BUS_ROUTE_TYPE, OUTPUT_DIR, VALHALLA_URL
from .gtfs import line_variants, read_gtfs, ref_sort_key
from .matching import map_match, valhalla_ready
from .naming import agency_networks, line_label, slug
from .osm import read_ways, write_osm
from .platforms import tag_platforms
from .roundabouts import split_roundabouts
from .stops import match_stops


class SelectionError(Exception):
    """Réseau ou ligne demandé absent du GTFS (le message liste les valeurs possibles)."""


def select_routes(routes, networks, reseau=None, refs=()):
    """Lignes de bus du GTFS à générer : celles du réseau reseau (nom du tag network, insensible à la
    casse) et/ou de numéros refs, triées par numéro. SelectionError si un réseau ou un numéro est inconnu."""
    routes = routes[routes["route_type"] == BUS_ROUTE_TYPE]
    if reseau:
        wanted = reseau.strip().lower()
        routes = routes[routes["agency_id"].map(lambda a: networks[a]["network"].lower() == wanted)]
        if routes.empty:
            raise SelectionError(f"Aucune ligne de bus pour le réseau « {reseau} ». Réseaux disponibles : "
                                 + ", ".join(sorted({n["network"] for n in networks.values()})))
    if refs:
        unknown = [r for r in refs if r not in set(routes["route_short_name"])]
        if unknown:
            available = sorted(set(routes["route_short_name"]), key=ref_sort_key)
            raise SelectionError(f"Ligne(s) inconnue(s){f' sur le réseau « {reseau} »' if reseau else ''} : "
                                 f"{', '.join(unknown)}. Lignes disponibles : {', '.join(available)}")
        routes = routes[routes["route_short_name"].isin(refs)]
    # ordre lisible dans les logs : numérique si possible, sinon alphabétique
    return routes.sort_values("route_short_name", key=lambda s: s.map(ref_sort_key))


def stop_sequences(trips, stop_times):
    """trips complété d'une colonne stop_seq : tuple des stop_id de chaque trajet, dans l'ordre."""
    trips = trips.copy()
    stop_times = stop_times[stop_times["trip_id"].isin(trips["trip_id"])].copy()
    stop_times["stop_sequence"] = stop_times["stop_sequence"].astype(int)
    trips["stop_seq"] = trips["trip_id"].map(
        stop_times.sort_values("stop_sequence").groupby("trip_id")["stop_id"].agg(tuple))
    return trips


def map_lines(routes, trips, shapes):
    """[(ligne, variantes)] : pour chaque ligne, ses variantes map-matchées
    {"direction", "seq", "shape_id", "trip_id", "ways"}. Les shapes que Valhalla ne sait pas suivre sont
    signalées et ignorées, de même que les lignes sans aucune variante."""
    lines = []
    for _, route in routes.iterrows():
        variants = []
        for direction_id, seq, shape_id, trip_id in line_variants(trips[trips["route_id"] == route["route_id"]]):
            try:
                variants.append({"direction": direction_id, "seq": seq, "shape_id": shape_id, "trip_id": trip_id,
                                 "ways": map_match(shapes.get_group(shape_id))})
            except (RuntimeError, requests.RequestException) as e:
                print(f"  warning: ligne {route['route_short_name']}, shape {shape_id} ignorée : {e}")
        if not variants:
            print(f"  warning: ligne {route['route_short_name']} ignorée : aucune variante map-matchée")
            continue
        lines.append((route, variants))
    return lines


def output_path(reseau, refs):
    """output_osm/<réseau|atoumod>[_<lignes>].osm"""
    name = slug(reseau) if reseau else "atoumod"
    return OUTPUT_DIR / f"{'_'.join([name, *map(slug, refs)])}.osm"


def run(reseau=None, refs=()):
    """Génère le fichier .osm des lignes demandées (toutes si rien n'est précisé) et renvoie son chemin.
    SelectionError si le réseau ou une ligne est inconnu, RuntimeError si Valhalla ne répond pas."""
    agency, routes, trips, stops, stop_times, shapes = read_gtfs(
        "agency", "routes", "trips", "stops", "stop_times", "shapes")
    networks = agency_networks(agency)
    routes = select_routes(routes, networks, reseau, refs)

    # seulement les trajets des lignes retenues : plus rapide sur un sous-ensemble (--reseau, numéros de
    # ligne) que sur tout le GTFS régional
    trips = stop_sequences(trips[trips["route_id"].isin(routes["route_id"])], stop_times)
    shapes["shape_pt_sequence"] = shapes["shape_pt_sequence"].astype(int)
    shapes = shapes.sort_values("shape_pt_sequence").groupby("shape_id")

    stops = match_stops(stops)
    used = sorted({s for seq in trips["stop_seq"].dropna() for s in seq})  # libellés : arrêts des lignes seulement
    stops.df.loc[used, "label"] = [line_label(i, stops.df.at[i, "stop_name"]) for i in used]

    if not valhalla_ready():
        raise RuntimeError(f"Valhalla ne répond pas sur {VALHALLA_URL} : lancer « docker start valhalla_nomad ».")
    print("Map-matching...")
    lines = map_lines(routes, trips, shapes)

    print("Lecture des voies et des quais dans le PBF...")
    osm = read_ways({w for _, variants in lines for v in variants for w in v["ways"]}
                    | {c["id"] for _, variants in lines for v in variants for s in v["seq"]
                       for n in [s, *stops.neighbours[s]] for c in stops.platforms[n]})

    variants = [v for _, vs in lines for v in vs]
    for v in variants:  # voies absentes de l'extrait (voisines hors Normandie) ignorées
        v["ways"] = [w for w, _ in groupby(w for w in v["ways"] if w in osm)]
    # un nœud posé sur une voie empruntée (vieux highway=bus_stop sur la chaussée) est une stop_position,
    # pas un quai : on ne le propose pas comme quai
    road_nodes = {n for v in variants for w in v["ways"] for n in osm[w]["nodes"]}
    stops.platforms = {s: [c for c in cs if c["id"] not in road_nodes] for s, cs in stops.platforms.items()}

    # objets modifiés communs à toutes les lignes : un seul fichier pour éviter les conflits entre lignes
    # (ronds-points découpés, quais et stop_positions partagés)
    obj = ChainMap({}, osm)
    print(f"{split_roundabouts(variants, obj)} rond(s)-point(s) découpé(s)")

    assignments, created = {}, {}
    for route, variants in lines:
        build_line(route, variants, obj, stops, networks[route["agency_id"]], assignments, created)
    for x in tag_platforms(obj, stops, assignments):
        print(f"warning: stop_id déjà porté par un autre quai OSM, non posé (à vérifier) : {x}")

    OUTPUT_DIR.mkdir(exist_ok=True)
    path = output_path(reseau, refs)
    write_osm(obj, path)
    return path
