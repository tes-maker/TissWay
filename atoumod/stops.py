"""Arrêts GTFS et quais OSM candidats.

Chaque arrêt GTFS (un stop_id = un quai physique d'un sens) est rapproché :
- des quais OSM proches (candidats), en privilégiant ceux qui portent déjà son stop_id ;
- des autres quais GTFS du même arrêt (l'arrêt d'en face), grâce au code GTFS : les quais d'un même
  arrêt partagent le code à la lettre près (2702282A / 2702282B).
"""

import subprocess
from dataclasses import dataclass
from pathlib import Path

import geopandas as gpd
import pandas as pd

from .config import (MAX_HOLDER_M, MAX_OPPOSITE_STOP_M, MAX_SIBLING_M, MAX_STOP_DISTANCE_M, OSM_STOPS_CACHE,
                     PBF_PATH)


def osm_stops_cache():
    """Chemin du cache des arrêts de bus OSM (GeoJSON), extrait une fois du PBF avec osmium. Le supprimer
    après une mise à jour du PBF pour le régénérer."""
    if not Path(OSM_STOPS_CACHE).is_file():
        subprocess.run(["osmium", "tags-filter", PBF_PATH, "n/highway=bus_stop",
                        "nw/public_transport=platform", "-o", "stops.pbf", "--overwrite"], check=True)
        subprocess.run(["osmium", "export", "stops.pbf", "-f", "geojsonseq", "--add-unique-id=type_id",
                        "-o", OSM_STOPS_CACHE, "--overwrite"], check=True)
        Path("stops.pbf").unlink()
    return OSM_STOPS_CACHE


def sibling_code(stop_id, stop_code):
    """Code commun aux quais d'un même arrêt GTFS : réseau + code sans sa lettre finale
    ("2702282A" -> "ATOUMOD040:2702282"), None si le code n'a pas cette forme."""
    if isinstance(stop_code, str) and len(stop_code) > 1 and stop_code[-1].isalpha():
        return f"{stop_id.rsplit(':', 1)[-1]}:{stop_code[:-1]}"
    return None


@dataclass
class Stops:
    """Arrêts GTFS (df indexé par stop_id, avec lat/lon) et leurs voisins, voir match_stops."""
    df: pd.DataFrame
    # stop_id -> quais OSM candidats [{"id": "n123"/"w456", "pos", "name", "holder"}] : à moins de
    # MAX_STOP_DISTANCE_M, ou à moins de MAX_HOLDER_M s'ils portent déjà ce stop_id (holder=True)
    platforms: dict
    neighbours: dict  # stop_id -> autres quais GTFS du même arrêt (arrêt d'en face), voir match_stops
    holders: dict  # stop_id -> quais OSM qui le portent déjà (gtfs:stop_id*, ref:FR:Atoumod*)


def match_stops(stops):
    """Quais OSM et arrêts d'en face de tous les arrêts GTFS (pas seulement ceux des lignes retenues)."""
    osm = gpd.read_file(osm_stops_cache()).to_crs(epsg=2154)
    osm["geometry"] = osm.geometry.centroid
    holders = {}
    for col in [c for c in osm.columns if c.startswith(("gtfs:stop_id", "ref:FR:Atoumod"))]:
        for osm_id, value in osm[col].dropna().items():
            for stop_id in value.split(";"):
                holders.setdefault(stop_id.strip(), set()).add(osm.at[osm_id, "id"])
    # une stop_position (même taguée highway=bus_stop) n'est jamais un quai
    pt = osm["public_transport"] if "public_transport" in osm else pd.Series(None, index=osm.index)
    osm = osm[osm["id"].str[0].isin(["n", "w"]) & (pt != "stop_position")][["id", "name", "geometry"]]
    ll = osm.to_crs(epsg=4326).geometry
    osm = osm.assign(lat=ll.y, lon=ll.x)
    stops = stops.set_index("stop_id")
    stops["lat"], stops["lon"] = stops["stop_lat"].astype(float), stops["stop_lon"].astype(float)
    gdf = gpd.GeoDataFrame({"stop_id": stops.index}, crs="EPSG:4326",
                           geometry=gpd.points_from_xy(stops["lon"], stops["lat"])).to_crs(epsg=2154)
    platforms = {s: [] for s in stops.index}
    for r in gpd.sjoin(gdf, osm, predicate="dwithin", distance=MAX_HOLDER_M).itertuples():
        holder = r.id in holders.get(r.stop_id, ())
        if holder or r.geometry.distance(osm.at[r.index_right, "geometry"]) <= MAX_STOP_DISTANCE_M:
            platforms[r.stop_id].append({"id": r.id, "pos": (r.lat, r.lon), "name": r.name, "holder": holder})
    # arrêt d'en face : quais du même arrêt dans le GTFS (même code à la lettre près, même réseau, à moins
    # de MAX_SIBLING_M), ou à défaut de code, arrêts à moins de MAX_OPPOSITE_STOP_M
    code = pd.Series([sibling_code(i, c) for i, c in zip(stops.index, stops["stop_code"])], index=stops.index)
    neighbours = {s: [] for s in stops.index}
    for r in gpd.sjoin(gdf, gdf, predicate="dwithin", distance=MAX_SIBLING_M).itertuples():
        a, b = r.stop_id_left, r.stop_id_right
        if a == b:
            continue
        if code[a] and code[a] == code[b]:
            neighbours[a].append(b)
        elif not code[a] and r.geometry.distance(gdf.geometry.iloc[r.index_right]) <= MAX_OPPOSITE_STOP_M:
            neighbours[a].append(b)
    return Stops(stops, platforms, neighbours, holders)
