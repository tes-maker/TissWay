"""Complète les quais OSM existants (public_transport=platform) avec les données GTFS de Nomad Car :
chaque arrêt GTFS Nomad est associé au quai OSM le plus proche (à moins de MAX_DISTANCE_M, un quai par
arrêt au plus), à relire dans JOSM.

Tags posés : gtfs:stop_id:<feed>, gtfs:stop_name:<feed>, route_ref (lignes Nomad ajoutées aux valeurs
existantes) et wheelchair / bus s'ils manquent. Le name existant n'est pas modifié.

Usage : python nomad_platforms.py   ->   output_osm/nomad_platforms.osm (+ nomad_platforms_non_trouves.csv)
"""

from collections import ChainMap

import geopandas as gpd
import pandas as pd

from atoumod.config import BUS_ROUTE_TYPE, GTFS_DIR, OUTPUT_DIR
from atoumod.gtfs import ref_sort_key
from atoumod.osm import read_ways, write_osm
from atoumod.stops import osm_stops_cache

NOMAD_AGENCY = "ATOUMOD040:Network:040:LOC"  # Nomad Car (Région Normandie)
FEED = "FR-NOR-Nomad"  # suffixe des tags gtfs:*, comme FR-NOR-Nomad50 / FR-NOR-Nomad61 déjà sur OSM
MAX_DISTANCE_M = 30  # arrêt GTFS -> quai OSM
WHEELCHAIR = {"1": "yes", "2": "no"}


def read_gtfs(name, **kw):
    return pd.read_csv(f"{GTFS_DIR}/{name}.txt", encoding="utf-8-sig", dtype=str, **kw)


def nomad_stops():
    """Arrêts GTFS Nomad Car (bus/car) avec leur route_ref ("301;305")."""
    routes = read_gtfs("routes")
    routes = routes[(routes["agency_id"] == NOMAD_AGENCY) & (routes["route_type"] == BUS_ROUTE_TYPE)]
    trips = read_gtfs("trips", usecols=["route_id", "trip_id"])
    trips = trips[trips["route_id"].isin(routes["route_id"])]
    trip_ref = trips.set_index("trip_id")["route_id"].map(routes.set_index("route_id")["route_short_name"])
    stop_times = read_gtfs("stop_times", usecols=["trip_id", "stop_id"])
    stop_times = stop_times[stop_times["trip_id"].isin(trip_ref.index)]
    refs = stop_times.assign(ref=stop_times["trip_id"].map(trip_ref)).groupby("stop_id")["ref"].agg(set)

    stops = read_gtfs("stops")
    stops = stops[stops["stop_id"].isin(refs.index)].copy()
    stops["route_ref"] = stops["stop_id"].map(refs)
    return gpd.GeoDataFrame(stops, crs="EPSG:4326", geometry=gpd.points_from_xy(
        stops["stop_lon"].astype(float), stops["stop_lat"].astype(float))).to_crs(epsg=2154)


def osm_platforms():
    """Quais de bus OSM (nœuds et voies) du PBF, en Lambert 93."""
    osm = gpd.read_file(osm_stops_cache()).to_crs(epsg=2154)  # même cache que mapping.py
    osm["geometry"] = osm.geometry.centroid
    pt = osm.get("public_transport", pd.Series(index=osm.index, dtype=str))
    keep = osm["id"].str[0].isin(["n", "w"]) & (pt != "stop_position")
    return osm[keep][["id", "geometry"]]


def nearest_pairs(stops, platforms):
    """Couples (arrêt GTFS, quai OSM) les plus proches, un à un : par distance croissante, chaque arrêt et
    chaque quai ne sont pris qu'une fois (deux arrêts opposés ne tombent pas sur le même quai)."""
    pairs = gpd.sjoin(stops, platforms, predicate="dwithin", distance=MAX_DISTANCE_M)
    pairs["distance"] = pairs.geometry.distance(platforms.loc[pairs["index_right"]].geometry, align=False).values
    used_stops, used_platforms, result = set(), set(), {}
    for r in pairs.sort_values("distance").itertuples():
        if r.stop_id not in used_stops and r.id not in used_platforms:
            used_stops.add(r.stop_id)
            used_platforms.add(r.id)
            result[r.stop_id] = (r.id, r.distance)
    return result


def nomad_tags(tags, stop):
    """Tags du quai complétés avec l'arrêt GTFS Nomad."""
    t = dict(tags)
    t[f"gtfs:stop_id:{FEED}"] = stop["stop_id"]
    t[f"gtfs:stop_name:{FEED}"] = stop["stop_name"]
    refs = {r for r in t.get("route_ref", "").split(";") if r} | stop["route_ref"]
    t["route_ref"] = ";".join(sorted(refs, key=ref_sort_key))
    t.setdefault("bus", "yes")
    if stop["wheelchair_boarding"] in WHEELCHAIR:
        t.setdefault("wheelchair", WHEELCHAIR[stop["wheelchair_boarding"]])
    return t


if __name__ == "__main__":
    print("Lecture du GTFS Nomad...")
    stops = nomad_stops()
    print("Lecture des quais OSM...")
    platforms = osm_platforms()
    matches = nearest_pairs(stops, platforms)

    osm = read_ways({osm_id for osm_id, _ in matches.values()})
    obj = ChainMap({}, osm)  # quais modifiés au-dessus des objets du PBF (voir atoumod.osm)
    for _, stop in stops[stops["stop_id"].isin(matches)].iterrows():
        osm_id = matches[stop["stop_id"]][0]
        if osm_id not in osm:  # absent du PBF (ne devrait pas arriver)
            continue
        tags = nomad_tags(osm[osm_id]["tags"], stop)
        if tags != osm[osm_id]["tags"]:
            obj[osm_id] = {**osm[osm_id], "tags": tags}

    OUTPUT_DIR.mkdir(exist_ok=True)
    out = OUTPUT_DIR / "nomad_platforms.osm"
    write_osm(obj, out)

    missing = stops[~stops["stop_id"].isin(matches)]
    missing[["stop_id", "stop_code", "stop_name", "stop_lat", "stop_lon"]].to_csv(
        OUTPUT_DIR / "nomad_platforms_non_trouves.csv", index=False)
    print(f"{len(stops)} arrêts Nomad : {len(matches)} associés à un quai OSM (<= {MAX_DISTANCE_M} m), "
          f"{len(obj.maps[0])} quai(s) modifié(s) -> {out}")
    print(f"{len(missing)} arrêt(s) sans quai OSM proche -> {OUTPUT_DIR / 'nomad_platforms_non_trouves.csv'}")
