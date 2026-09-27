"""Génère un fichier .osm PTv2 par ligne NOMAD, à relire dans JOSM (avec PT Assistant).

Pour chaque variante : la stop_position (existante ou créée sur la voie) et le quai de chaque arrêt,
puis les voies map-matchées par Valhalla. Les voies ne sont pas découpées et les trous ne sont pas
comblés : c'est à faire dans JOSM, qui met à jour les relations des voies découpées.

Usage : python mapping.py [numéros de ligne...]   (sans argument : toutes les lignes)
"""

import copy
import math
import re
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from collections import ChainMap, Counter
from itertools import count, groupby
from pathlib import Path

import geopandas as gpd
import pandas as pd
import requests

VALHALLA_URL = "http://localhost:8002"
PBF_PATH = "normandy-latest.osm.pbf"
GTFS_DIR = "gtfs_nomad"
OSM_STOPS_CACHE = "osm_bus_stops.geojsonseq"
OUTPUT_DIR = Path("output_osm")
MAX_STOP_DISTANCE_M = 20  # arrêt GTFS -> quai OSM existant
MAX_STOP_POSITION_M = 40  # arrêt GTFS -> voie empruntée (stop_position)
MAX_TRACE_M = 150_000  # Valhalla refuse les traces de plus de 200 km : on découpe au-delà
MIN_VARIANT_SHARE = 0.10
NETWORK = {"network": "Nomad", "network:wikidata": "Q98131290", "network:wikipedia": "fr:Nomad (réseau)"}
OPERATOR = {"operator": "Keolis", "operator:wikidata": "Q664399", "operator:wikipedia": "fr:Keolis"}
GTFS_FEED = "FR-NOR-Atoumod"
MEMBER_TYPES = {"n": "node", "w": "way", "r": "relation"}
new_ids = count(1)


# --- Géométrie (projection locale, suffisante à l'échelle d'un arrêt) ---

def xy(p, origin):
    return ((p[1] - origin[1]) * 111_320 * math.cos(math.radians(origin[0])), (p[0] - origin[0]) * 110_574)


def dist(a, b):
    return math.hypot(*xy(a, b))


def project(p, a, b):
    """(t, distance) de la projection de p sur le segment [a, b]."""
    (ax, ay), (bx, by) = xy(a, p), xy(b, p)
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, -(ax * dx + ay * dy) / (dx * dx + dy * dy))) if dx or dy else 0.0
    return t, math.hypot(ax + t * dx, ay + t * dy)


# --- Données GTFS et OSM ---

def match_stops(stops):
    """stop_id GTFS -> quai OSM ("n123"/"w456") le plus proche, ou None si aucun à moins de 20 m."""
    if not Path(OSM_STOPS_CACHE).is_file():  # arrêts de bus du PBF, extraits une fois avec osmium
        subprocess.run(["osmium", "tags-filter", PBF_PATH, "n/highway=bus_stop",
                        "nw/public_transport=platform", "-o", "stops.pbf", "--overwrite"], check=True)
        subprocess.run(["osmium", "export", "stops.pbf", "-f", "geojsonseq", "--add-unique-id=type_id",
                        "-o", OSM_STOPS_CACHE, "--overwrite"], check=True)
        Path("stops.pbf").unlink()
    osm = gpd.read_file(OSM_STOPS_CACHE).to_crs(epsg=2154)
    osm["geometry"] = osm.geometry.centroid
    osm = osm[osm["id"].str[0].isin(["n", "w"])][["id", "geometry"]]
    gdf = gpd.GeoDataFrame(stops, crs="EPSG:4326", geometry=gpd.points_from_xy(
        stops["stop_lon"].astype(float), stops["stop_lat"].astype(float))).to_crs(epsg=2154)
    joined = gpd.sjoin_nearest(gdf, osm, how="left", max_distance=MAX_STOP_DISTANCE_M)
    joined = joined[~joined.index.duplicated()]
    return {s: (i if isinstance(i, str) else None) for s, i in zip(joined["stop_id"], joined["id"])}


def unescape(s):
    return re.sub(r"%([0-9a-fA-F]+)%", lambda m: chr(int(m.group(1), 16)), s)


def read_ways(ids):
    """Voies du PBF et leurs nœuds, indexés "n123"/"w123"."""
    objects = {}
    with tempfile.TemporaryDirectory() as tmp:
        Path(tmp, "ids.txt").write_text("\n".join(ids))
        out = Path(tmp, "out.opl")
        # code 1 = certains ids absents de l'extrait (voisines hors Normandie) : sans importance
        res = subprocess.run(["osmium", "getid", "-r", PBF_PATH, "-i", Path(tmp, "ids.txt"), "-f", "opl", "-o", out],
                             stderr=subprocess.PIPE, text=True)
        if res.returncode > 1:
            raise RuntimeError(f"échec de osmium getid : {res.stderr}")
        for line in out.read_text().splitlines():
            key, *rest = line.split(" ")
            f = {x[0]: x[1:] for x in rest}
            obj = objects[key] = {"version": f["v"], "tags": dict(
                map(unescape, kv.split("=", 1)) for kv in f["T"].split(",") if kv)}
            if key[0] == "n":
                obj["lat"], obj["lon"] = float(f["y"]), float(f["x"])
            else:
                obj["nodes"] = f["N"].split(",") if f["N"] else []
    return objects


# --- Variantes et map-matching ---

def line_variants(trips):
    """Par direction : séquences d'arrêts non incluses dans une autre et assez fréquentes."""
    for _, dir_trips in trips.groupby(trips["direction_id"].fillna("0")):
        counts = Counter(dir_trips["stop_seq"])
        full = [(seq, n) for seq, n in counts.most_common()
                if not any(len(o) > len(seq) and set(seq) <= set(o) for o in counts)]
        for seq, _ in [(s, n) for s, n in full if n / len(dir_trips) >= MIN_VARIANT_SHARE] or full[:1]:
            seq_trips = dir_trips[dir_trips["stop_seq"] == seq]
            shape_id = seq_trips["shape_id"].mode()[0]
            yield seq, shape_id, seq_trips[seq_trips["shape_id"] == shape_id]["trip_id"].iloc[0]


def map_match(shape_pts):
    """Voies suivies par le tracé GTFS, dans l'ordre, découpé en morceaux de MAX_TRACE_M."""
    ways = []
    part = (shape_pts["shape_dist_traveled"].astype(float) // MAX_TRACE_M).to_numpy()
    starts = [0] + [i for i in range(1, len(part)) if part[i] != part[i - 1]] + [len(part)]
    for start, end in zip(starts, starts[1:]):
        chunk = shape_pts.iloc[start:end + 1]  # 1 point de recouvrement entre morceaux
        payload = {"shape": [{"lat": float(a), "lon": float(b)} for a, b in zip(chunk["shape_pt_lat"], chunk["shape_pt_lon"])],
                   "costing": "bus", "shape_match": "map_snap",
                   "filters": {"attributes": ["edge.way_id"], "action": "include"}}
        res = requests.post(f"{VALHALLA_URL}/trace_attributes", json=payload, timeout=120).json()
        if "error" in res:  # rayon de recherche élargi si le tracé GTFS est imprécis
            payload["trace_options"] = {"search_radius": 50, "gps_accuracy": 20}
            res = requests.post(f"{VALHALLA_URL}/trace_attributes", json=payload, timeout=120).json()
        if "error" in res:
            raise RuntimeError(res["error"])
        ways += [f"w{e['way_id']}" for e in res["edges"]]
    return [w for w, _ in groupby(ways)]


# --- Construction d'une ligne ---

def stop_tags(stop, stop_id):
    """Tags d'un quai Nomad tirés du GTFS."""
    tags = {"public_transport": "platform", "highway": "bus_stop", "bus": "yes", "name": stop["short_name"],
            **NETWORK, **OPERATOR, "gtfs:stop_id": stop_id, "ref:FR:Atoumod": stop_id}
    if isinstance(stop["stop_code"], str):
        tags["ref"] = stop["stop_code"]
    if stop["wheelchair_boarding"] in ("1", "2"):
        tags["wheelchair"] = "yes" if stop["wheelchair_boarding"] == "1" else "no"
    return tags


def enrich(new, obj, key, tags):
    """Ajoute les tags Nomad à un objet OSM existant sans écraser ceux d'un autre réseau : les tags absents
    sont ajoutés, réseau/exploitant/référence Atoumod sont complétés en liste « a;b »."""
    o = new[key] = new.get(key) or copy.deepcopy(obj[key])
    t = o["tags"]
    for group in (NETWORK, OPERATOR):
        main = next(iter(group))
        if t.get(main, group[main]) == group[main]:
            t |= {k: v for k, v in group.items() if k not in t}
        else:  # autre réseau / exploitant : on complète, sans wikipedia (une seule valeur possible)
            for k, v in group.items():
                if not k.endswith(":wikipedia") and v not in t.get(k, "").split(";"):
                    t[k] = f"{t[k]};{v}" if k in t else v
    if "ref:FR:Atoumod" in tags and tags["ref:FR:Atoumod"] not in t.get("ref:FR:Atoumod", "").split(";"):
        t["ref:FR:Atoumod"] = ";".join(filter(None, [t.get("ref:FR:Atoumod"), tags["ref:FR:Atoumod"]]))
    t |= {k: v for k, v in tags.items() if k not in t}

def place_stop(obj, osm, ways, stop, start):
    """(index de la voie, stop_position existante ou créée) du premier passage près de l'arrêt,
    en cherchant à partir de ways[start], ou None."""
    c = (stop["lat"], stop["lon"])
    pos = lambda n: (obj[n]["lat"], obj[n]["lon"])
    best, run = None, []
    for i in range(start, len(ways)):
        nodes = obj[ways[i]]["nodes"]
        near = [(d, i, k, t) for k, (a, b) in enumerate(zip(nodes, nodes[1:]))
                for t, d in [project(c, pos(a), pos(b))] if d <= MAX_STOP_POSITION_M]
        if near:
            run.append(i)
            best = min(near + [best] if best else near)
        elif best:
            break
    if best is None:
        return None
    existing = [(dist(c, pos(n)), i, n) for i in run for n in obj[ways[i]]["nodes"]
                if obj[n]["tags"].get("public_transport") == "stop_position" and obj[n]["tags"].get("bus") != "no"
                and dist(c, pos(n)) <= MAX_STOP_POSITION_M]
    if existing:
        return min(existing)[1:]
    _, i, k, t = best
    w = ways[i]
    a, b = pos(obj[w]["nodes"][k]), pos(obj[w]["nodes"][k + 1])
    length = dist(a, b)
    t = min(max(t, 1 / length), 1 - 1 / length) if length > 2 else 0.5  # pas collé à un nœud existant
    key = f"n-{next(new_ids)}"
    obj[key] = {"lat": a[0] + t * (b[0] - a[0]), "lon": a[1] + t * (b[1] - a[1]), "tags": {
        "public_transport": "stop_position", "bus": "yes", "name": stop["short_name"], **NETWORK, **OPERATOR}}
    if w not in obj.maps[0]:
        obj[w] = copy.deepcopy(osm[w])
    obj[w]["nodes"].insert(k + 1, key)
    return i, key


def write_osm(new, obj, path):
    root = ET.Element("osm", version="0.6", generator="NOMAD_Automation", upload="true")
    keys = set(new) | {n for k in new if k[0] == "w" for n in obj[k]["nodes"]}
    for key in sorted(keys, key=lambda k: ("nwr".index(k[0]), k)):
        o = obj[key]
        attrs = {"id": key[1:], **({"version": o["version"]} if "version" in o else {})}
        if key in new:
            attrs["action"] = "modify"
        if key[0] == "n":
            attrs |= {"lat": f"{o['lat']:.7f}", "lon": f"{o['lon']:.7f}"}
        el = ET.SubElement(root, MEMBER_TYPES[key[0]], attrs)
        for n in o.get("nodes", []):
            ET.SubElement(el, "nd", ref=n[1:])
        for ref, role in o.get("members", []):
            ET.SubElement(el, "member", type=MEMBER_TYPES[ref[0]], ref=ref[1:], role=role)
        for k, v in o["tags"].items():
            ET.SubElement(el, "tag", k=k, v=v)
    ET.indent(root)
    ET.ElementTree(root).write(path, encoding="utf-8", xml_declaration=True)


def build_line(route, variants, osm, stops, platforms):
    ref = route["route_short_name"]
    new = {}  # objets créés ou modifiés pour cette ligne
    obj = ChainMap(new, osm)
    platforms = dict(platforms)  # quais créés pour cette ligne seulement
    common = {**NETWORK, **OPERATOR, "colour": f"#{route['route_color']}",
              "colour:text": f"#{route['route_text_color']}", f"gtfs:route_id:{GTFS_FEED}": route["route_id"]}
    master_members, missing, gaps = [], 0, set()
    for v in variants:
        ways = [w for w in v["ways"] if w in osm]
        members, start = [], 0
        for stop_id in v["seq"]:
            s = stops.loc[stop_id]
            if placed := place_stop(obj, osm, ways, s, start):
                start = placed[0]
                if not placed[1].startswith("n-"):  # stop_position existante
                    enrich(new, obj, placed[1], {"name": s["short_name"]})
                members.append((placed[1], "stop"))
            else:
                missing += 1
            if not platforms[stop_id]:
                platforms[stop_id] = key = f"n-{next(new_ids)}"
                new[key] = {"lat": s["lat"], "lon": s["lon"], "tags": stop_tags(s, stop_id)}
            elif platforms[stop_id] in osm:  # quai existant : complété avec les données Nomad
                enrich(new, obj, platforms[stop_id], stop_tags(s, stop_id))
            members.append((platforms[stop_id], "platform"))
        members += [(w, "") for w in ways]
        gaps |= {(a, b) for a, b in zip(ways, ways[1:]) if not set(obj[a]["nodes"]) & set(obj[b]["nodes"])}
        first, last = stops.at[v["seq"][0], "stop_name"], stops.at[v["seq"][-1], "stop_name"]
        key = f"r-{next(new_ids)}"
        new[key] = {"members": members, "tags": {
            "type": "route", "route": "bus", "ref": ref, "name": f"Bus {ref}: {first} => {last}", **common,
            f"gtfs:trip_id:sample:{GTFS_FEED}": v["trip_id"], f"gtfs:shape_id:{GTFS_FEED}": f"NOMAD:{v['shape_id']}",
            "ref_trips": v["trip_id"], "from": first, "to": last, "public_transport:version": "2"}}
        master_members.append((key, ""))
    new[f"r-{next(new_ids)}"] = {"members": master_members, "tags": {
        "type": "route_master", "route_master": "bus", "ref": ref, "name": f"Bus {ref}", **common}}
    write_osm(new, obj, OUTPUT_DIR / f"ligne_nomad_{ref}.osm")

    created = Counter(o["tags"].get("public_transport") for k, o in new.items() if k.startswith("n-"))
    print(f"✅ ligne {ref} : {len(variants)} variante(s), {created['stop_position']} stop_position et "
          f"{created['platform']} quai(s) créés"
          + (f", ⚠️  {missing} arrêt(s) à plus de {MAX_STOP_POSITION_M} m du tracé" if missing else "")
          + (f", ⚠️  {len(gaps)} trou(s) entre voies : " + ", ".join(f"{a} → {b}" for a, b in sorted(gaps))
             if gaps else ""))


if __name__ == "__main__":
    routes, trips, stops, stop_times, shapes = (pd.read_csv(f"{GTFS_DIR}/{name}.txt", encoding="utf-8-sig", dtype=str)
                                                for name in ("routes", "trips", "stops", "stop_times", "shapes"))
    shapes["shape_pt_sequence"] = shapes["shape_pt_sequence"].astype(int)
    shapes = shapes.sort_values("shape_pt_sequence").groupby("shape_id")
    stop_times["stop_sequence"] = stop_times["stop_sequence"].astype(int)
    trips["stop_seq"] = trips["trip_id"].map(
        stop_times.sort_values("stop_sequence").groupby("trip_id")["stop_id"].agg(tuple))
    platforms = match_stops(stops)
    stops = stops.set_index("stop_id")
    stops["lat"], stops["lon"] = stops["stop_lat"].astype(float), stops["stop_lon"].astype(float)
    stops["short_name"] = stops["stop_name"].str.split(" - ").str[-1]
    if len(sys.argv) > 1:
        routes = routes[routes["route_short_name"].isin(sys.argv[1:])]

    try:
        requests.get(f"{VALHALLA_URL}/status", timeout=5)
    except requests.RequestException:
        sys.exit(f"Valhalla ne répond pas sur {VALHALLA_URL} : lancer « docker start valhalla_nomad ».")

    print("Map-matching...")
    lines = []
    for _, route in routes.iterrows():
        variants = []
        for seq, shape_id, trip_id in line_variants(trips[trips["route_id"] == route["route_id"]]):
            try:
                variants.append({"seq": seq, "shape_id": shape_id, "trip_id": trip_id,
                                 "ways": map_match(shapes.get_group(shape_id))})
            except (RuntimeError, requests.RequestException) as e:
                print(f"  ⚠️  ligne {route['route_short_name']}, shape {shape_id} ignorée : {e}")
        lines.append((route, variants))

    print("Lecture des voies et des quais dans le PBF...")
    osm = read_ways({w for _, variants in lines for v in variants for w in v["ways"]}
                    | {platforms[s] for _, variants in lines for v in variants for s in v["seq"] if platforms[s]})

    OUTPUT_DIR.mkdir(exist_ok=True)
    for route, variants in lines:
        build_line(route, variants, osm, stops, platforms)
