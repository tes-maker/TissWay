"""Génère un fichier .osm PTv2 par ligne de bus/car du GTFS régional Atoumod (tous réseaux : Nomad,
Twisto, Astuce...), à relire dans JOSM (avec PT Assistant).

Pour chaque variante : la stop_position (existante ou créée sur la voie) et le quai de chaque arrêt,
puis les voies map-matchées par Valhalla. Les voies ne sont pas découpées et les trous ne sont pas
comblés : c'est à faire dans JOSM, qui met à jour les relations des voies découpées.

Usage : python mapping.py [-r RÉSEAU] [numéros de ligne...]   (sans argument : toutes les lignes, tous réseaux)
"""

import argparse
import copy
import math
import re
import subprocess
import sys
import tempfile
import unicodedata
import xml.etree.ElementTree as ET
from collections import ChainMap, Counter
from functools import lru_cache
from itertools import chain, count, groupby
from pathlib import Path

import geopandas as gpd
import pandas as pd
import requests

GEO_API_URL = "https://geo.api.gouv.fr/communes"
VALHALLA_URL = "http://localhost:8002"
PBF_PATH = "normandy-latest.osm.pbf"
GTFS_DIR = "gtfs_atoumod"
OSM_STOPS_CACHE = "osm_bus_stops.geojsonseq"
OUTPUT_DIR = Path("output_osm")
MAX_STOP_DISTANCE_M = 20  # arrêt GTFS -> quai OSM existant
MAX_STOP_POSITION_M = 40  # arrêt GTFS -> voie empruntée (stop_position)
MAX_TRACE_M = 150_000  # Valhalla refuse les traces de plus de 200 km : on découpe au-delà
MIN_VARIANT_SHARE = 0.10
BUS_ROUTE_TYPE = "3"  # GTFS route_type : on ignore train/tram/ferry, hors périmètre (voies + Valhalla costing bus)
# Réseaux vérifiés sur OSM (network:wikidata) ; les autres sont dérivés de agency_name, sans wikidata inventé.
NETWORKS = {
    "040": {"network": "Nomad", "network:wikidata": "Q98131290", "network:wikipedia": "fr:Nomad (réseau)"},
    "029": {"network": "Twisto", "network:wikidata": "Q3537947"},
}
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


def right_of(p, a, b):
    """p est-il à droite du segment orienté a -> b (sens de progression sur la voie) ?"""
    (ax, ay), (bx, by) = xy(a, p), xy(b, p)
    return ax * by - ay * bx < 0


# --- Données GTFS et OSM ---

def match_stops(stops):
    """stop_id GTFS -> quais OSM candidats à moins de 20 m : [{"id": "n123"/"w456", "pos": (lat, lon), "name"}]."""
    if not Path(OSM_STOPS_CACHE).is_file():  # arrêts de bus du PBF, extraits une fois avec osmium
        subprocess.run(["osmium", "tags-filter", PBF_PATH, "n/highway=bus_stop",
                        "nw/public_transport=platform", "-o", "stops.pbf", "--overwrite"], check=True)
        subprocess.run(["osmium", "export", "stops.pbf", "-f", "geojsonseq", "--add-unique-id=type_id",
                        "-o", OSM_STOPS_CACHE, "--overwrite"], check=True)
        Path("stops.pbf").unlink()
    osm = gpd.read_file(OSM_STOPS_CACHE).to_crs(epsg=2154)
    osm["geometry"] = osm.geometry.centroid
    osm = osm[osm["id"].str[0].isin(["n", "w"])][["id", "name", "geometry"]]
    ll = osm.to_crs(epsg=4326).geometry
    osm = osm.assign(lat=ll.y, lon=ll.x)
    gdf = gpd.GeoDataFrame(stops[["stop_id"]], crs="EPSG:4326", geometry=gpd.points_from_xy(
        stops["stop_lon"].astype(float), stops["stop_lat"].astype(float))).to_crs(epsg=2154)
    platforms = {s: [] for s in stops["stop_id"]}
    for r in gpd.sjoin(gdf, osm, predicate="dwithin", distance=MAX_STOP_DISTANCE_M).itertuples():
        platforms[r.stop_id].append({"id": r.id, "pos": (r.lat, r.lon), "name": r.name})
    return platforms


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

def unaccent(s):
    return "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c))


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", unaccent(s).lower()).strip("-")


def agency_networks(agency):
    """agency_id -> tags réseau (NETWORKS si connu, sinon dérivé de agency_name : "Twisto (Caen la mer)"
    -> {"network": "Twisto"}, sans exploitant ni wikidata non vérifiés)."""
    codes = agency["agency_id"].str.split(":").str[2]
    names = agency["agency_name"].str.partition(" (")[0].str.strip()
    return {i: NETWORKS.get(c, {"network": n}) for i, c, n in zip(agency["agency_id"], codes, names)}


@lru_cache(maxsize=None)
def communes(dept):
    """Code INSEE -> nom officiel des communes d'un département, via l'API Découpage administratif :
    {} si l'API n'est pas joignable."""
    try:
        res = requests.get(GEO_API_URL, params={"codeDepartement": dept, "fields": "nom,code"}, timeout=10)
        res.raise_for_status()
        return {c["code"]: c["nom"] for c in res.json()}
    except requests.RequestException as e:
        print(f"  warning: communes du département {dept} non récupérées ({e}) : villes non complétées")
        return {}


LINK_WORDS = r"(?:SUR|EN|LES?|LA|DE|DU|DES|AUX?)"


def line_label(stop_id, name):
    """"VILLE Arrêt" pour les noms de ligne : commune du code INSEE du stop_id ("FR:<insee>:..."), en
    majuscules sans accent, + nom GTFS privé de la commune ou de son début s'il la répète ("Avranches - X",
    "St-Malo X", "Fleury X" à Fleury-sur-Orne...). Nom GTFS inchangé si la commune est inconnue."""
    insee = re.match(r"FR:(\d{5}):", stop_id)
    ville = insee and communes(insee.group(1)[:2]).get(insee.group(1))
    if not ville:
        return name
    ville = unaccent(ville).upper()
    words = ["(?:STE?|SAINTE?)" if w in ("SAINT", "SAINTE") else re.escape(w) for w in ville.split("-")]
    starts = ["[ -]".join(words)]
    for n in range(len(words) - 1, 0, -1):
        # début de la commune ("Fleury Mairie" à Fleury-sur-Orne), sauf "Saint" seul ou fini par une liaison
        if re.fullmatch(LINK_WORDS, words[n - 1]) or (n == 1 and words[0].startswith("(?:")):
            continue
        # suivi d'une espace ou « : » (pas "CONDE-SUR-NOIREAU"), puis ni « / », ni liaison, ni la suite
        # de la commune ("PACY S/ EURE", "Mont aux Malades", "NOTRE DAME D'ESTREES")
        starts.append(rf"{'[ -]'.join(words[:n])}(?=[ :][ :-]*+(?!/|S/|D'|(?:{LINK_WORDS}|{words[n]})\b))")
    prefix = re.match(rf"(?:{'|'.join(starts)})\b[ :-]*", unaccent(name), re.IGNORECASE)
    rest = name[prefix.end():] if prefix else name
    return f"{ville} {rest}" if rest else ville


def master_endpoints_label(endpoints):
    """Termini d'une ligne (route_master) à partir des (origine, terminus) de ses variantes, au format
    Twisto : "A ↔ B", ou "A1 / A2 ↔ B" si plusieurs origines partagent le même terminus B."""
    counts = Counter(name for pair in endpoints for name in pair)
    hub = counts.most_common(1)[0][0]
    others = list(dict.fromkeys(name for pair in endpoints for name in pair if name != hub))
    return f"{' / '.join(others)} ↔ {hub}" if others else hub


def stop_tags(stop, stop_id, network):
    """Tags d'un quai tirés du GTFS."""
    tags = {"public_transport": "platform", "highway": "bus_stop", "bus": "yes", "name": stop["stop_name"],
            **network, "gtfs:stop_id": stop_id, "ref:FR:Atoumod": stop_id}
    if isinstance(stop["stop_code"], str):
        tags["ref"] = stop["stop_code"]
    if stop["wheelchair_boarding"] in ("1", "2"):
        tags["wheelchair"] = "yes" if stop["wheelchair_boarding"] == "1" else "no"
    return tags


def add_tag(t, key, value):
    """Ajoute une valeur à un tag sans écraser une valeur différente déjà posée par un autre réseau :
    posée sur la 1re clé numérotée libre ("network:2", "ref:FR:Atoumod:2"...)."""
    if key not in t:
        t[key] = value
    elif t[key] != value:
        n = next(n for n in count(2) if t.get(f"{key}:{n}", value) == value)
        t[f"{key}:{n}"] = value


def enrich(new, obj, key, tags):
    """Complète un quai OSM existant avec les tags du GTFS/réseau sans écraser ceux d'un autre réseau
    (voir add_tag), sauf name, remplacé par le nom officiel GTFS. Les tags network* d'un même réseau
    prennent tous le même numéro ("network:2", "network:wikidata:2"...)."""
    o = new[key] = new.get(key) or copy.deepcopy(obj[key])
    t = o["tags"]
    n = next(n for n in chain([""], (f":{i}" for i in count(2))) if t.get(f"network{n}", tags["network"]) == tags["network"])
    for k, v in tags.items():
        if k == "name":
            t[k] = v
        elif k.startswith("network"):
            t[k + n] = v
        else:
            add_tag(t, k, v)


def enrich_stop_position(new, obj, key, name):
    """Complète a minima une stop_position OSM existante (bus=yes, name officiel GTFS), sans toucher à
    ses autres tags."""
    o = new[key] = new.get(key) or copy.deepcopy(obj[key])
    o["tags"].setdefault("bus", "yes")
    o["tags"]["name"] = name


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
        "public_transport": "stop_position", "bus": "yes", "name": stop["stop_name"]}}
    if w not in obj.maps[0]:
        obj[w] = copy.deepcopy(osm[w])
    obj[w]["nodes"].insert(k + 1, key)
    return i, key


def choose_platform(candidates, stop, obj, placed):
    """Quai OSM candidat à droite de la voie (sens des nœuds autour de la stop_position placed = (voie,
    nœud)) plutôt qu'en face, le plus proche de l'arrêt GTFS, ou de la stop_position s'ils sont
    homonymes. None si aucun candidat."""
    if placed:
        way, key = placed
        nodes = obj[way]["nodes"]
        i = nodes.index(key)
        pos = lambda n: (obj[n]["lat"], obj[n]["lon"])
        a, b = pos(nodes[max(i - 1, 0)]), pos(nodes[min(i + 1, len(nodes) - 1)])
        candidates = [c for c in candidates if right_of(c["pos"], a, b)] or candidates
        if len({c["name"] for c in candidates}) == 1:
            stop = pos(key)
    return min(candidates, key=lambda c: dist(stop, c["pos"]), default=None)


def write_osm(new, obj, path):
    root = ET.Element("osm", version="0.6", generator="Atoumod_Automation", upload="true")
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


def build_line(route, variants, osm, stops, platforms, network, path):
    ref = route["route_short_name"]
    new = {}  # objets créés ou modifiés pour cette ligne
    obj = ChainMap(new, osm)
    chosen = {}  # stop_id -> quai retenu pour cette ligne
    common ={**network, "colour": f"#{route['route_color']}",
              "colour:text": f"#{route['route_text_color']}", f"gtfs:route_id:{GTFS_FEED}": route["route_id"]}
    master_members, endpoints, missing, gaps = [], [], 0, set()
    for v in variants:
        ways = [w for w in v["ways"] if w in osm]
        members, start = [], 0
        for stop_id in v["seq"]:
            s = stops.loc[stop_id]
            placed = place_stop(obj, osm, ways, s, start)
            if placed:
                start = placed[0]
                if not placed[1].startswith("n-"):  # stop_position existante
                    enrich_stop_position(new, obj, placed[1], s["stop_name"])
                members.append((placed[1], "stop"))
            else:
                missing += 1
            if stop_id not in chosen:
                c = choose_platform(platforms[stop_id], (s["lat"], s["lon"]), obj,
                                    placed and (ways[placed[0]], placed[1]))
                chosen[stop_id] = c["id"] if c else f"n-{next(new_ids)}"
                if not c:
                    new[chosen[stop_id]] = {"lat": s["lat"], "lon": s["lon"], "tags": stop_tags(s, stop_id, network)}
            if chosen[stop_id] in osm:  # quai existant : complété avec les données du réseau
                enrich(new, obj, chosen[stop_id], stop_tags(s, stop_id, network))
            members.append((chosen[stop_id], "platform"))
        members += [(w, "") for w in ways]
        gaps |= {(a, b) for a, b in zip(ways, ways[1:]) if not set(obj[a]["nodes"]) & set(obj[b]["nodes"])}
        first, last = stops.loc[v["seq"][0]], stops.loc[v["seq"][-1]]
        endpoints.append((first["label"], last["label"]))
        key = f"r-{next(new_ids)}"
        new[key] = {"members": members, "tags": {
            "type": "route", "route": "bus", "ref": ref,
            "name": f"Bus {ref}: {first['label']} → {last['label']}", **common,
            f"gtfs:trip_id:sample:{GTFS_FEED}": v["trip_id"],
            f"gtfs:shape_id:{GTFS_FEED}": f"{slug(network['network']).upper()}:{v['shape_id']}",
            "ref_trips": v["trip_id"], "from": first["stop_name"], "to": last["stop_name"], "public_transport:version": "2"}}
        master_members.append((key, ""))
    new[f"r-{next(new_ids)}"] = {"members": master_members, "tags": {
        "type": "route_master", "route_master": "bus", "ref": ref,
        "name": f"Bus {ref}: {master_endpoints_label(endpoints)}", **common}}
    write_osm(new, obj, path)

    created = Counter(o["tags"].get("public_transport") for k, o in new.items() if k.startswith("n-"))
    print(f"ligne {ref} : {len(variants)} variante(s), {created['stop_position']} stop_position, "
          f"{created['platform']} quai(s)"
          + (f", warning: {missing} arrêt(s) à plus de {MAX_STOP_POSITION_M} m du tracé" if missing else "")
          + (f", warning: {len(gaps)} trou(s) entre voies" if gaps else ""))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Génère un .osm PTv2 par ligne à partir du GTFS Atoumod.")
    parser.add_argument("refs", nargs="*", help="numéros de ligne à générer (défaut : toutes)")
    parser.add_argument("-r", "--reseau", help="ne générer que les lignes de ce réseau (ex. Nomad, Twisto)")
    args = parser.parse_args()

    agency, routes, trips, stops, stop_times, shapes = (
        pd.read_csv(f"{GTFS_DIR}/{name}.txt", encoding="utf-8-sig", dtype=str)
        for name in ("agency", "routes", "trips", "stops", "stop_times", "shapes"))
    networks = agency_networks(agency)

    routes = routes[routes["route_type"] == BUS_ROUTE_TYPE]
    if args.reseau:
        wanted = args.reseau.strip().lower()
        routes = routes[routes["agency_id"].map(lambda a: networks[a]["network"].lower() == wanted)]
        if routes.empty:
            sys.exit(f"Aucune ligne de bus pour le réseau « {args.reseau} ». Réseaux disponibles : "
                      + ", ".join(sorted({n["network"] for n in networks.values()})))
    if args.refs:
        routes = routes[routes["route_short_name"].isin(args.refs)]
    routes = routes.sort_values(  # ordre lisible dans les logs : numérique si possible, sinon alphabétique
        "route_short_name", key=lambda s: s.map(lambda r: (0, int(r)) if r.isdigit() else (1, r)))

    # on ne garde que les arrêts effectivement utilisés par les lignes retenues : plus rapide sur un
    # sous-ensemble (--reseau, numéros de ligne) que sur tout le GTFS régional
    trips = trips[trips["route_id"].isin(routes["route_id"])]
    shapes["shape_pt_sequence"] = shapes["shape_pt_sequence"].astype(int)
    shapes = shapes.sort_values("shape_pt_sequence").groupby("shape_id")
    stop_times = stop_times[stop_times["trip_id"].isin(trips["trip_id"])]
    stop_times["stop_sequence"] = stop_times["stop_sequence"].astype(int)
    trips["stop_seq"] = trips["trip_id"].map(
        stop_times.sort_values("stop_sequence").groupby("trip_id")["stop_id"].agg(tuple))

    used_stops = {s for seq in trips["stop_seq"].dropna() for s in seq}
    stops = stops[stops["stop_id"].isin(used_stops)]
    platforms = match_stops(stops)
    stops = stops.set_index("stop_id")
    stops["lat"], stops["lon"] = stops["stop_lat"].astype(float), stops["stop_lon"].astype(float)
    stops["label"] = [line_label(i, n) for i, n in zip(stops.index, stops["stop_name"])]

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
                print(f"  warning: ligne {route['route_short_name']}, shape {shape_id} ignorée : {e}")
        if not variants:
            print(f"  warning: ligne {route['route_short_name']} ignorée : aucune variante map-matchée")
            continue
        lines.append((route, variants))

    print("Lecture des voies et des quais dans le PBF...")
    osm = read_ways({w for _, variants in lines for v in variants for w in v["ways"]}
                    | {c["id"] for _, variants in lines for v in variants for s in v["seq"] for c in platforms[s]})

    OUTPUT_DIR.mkdir(exist_ok=True)
    used_names = Counter()
    for route, variants in lines:
        network = networks[route["agency_id"]]
        name = f"{slug(network['network'])}_{slug(route['route_short_name'])}"
        used_names[name] += 1
        if used_names[name] > 1:  # même réseau, même ref (ex. variantes scolaires) : on distingue les fichiers
            name = f"{name}-{used_names[name]}"
        build_line(route, variants, osm, stops, platforms, network, OUTPUT_DIR / f"{name}.osm")
