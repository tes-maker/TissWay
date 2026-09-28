"""Lecture du PBF OSM (via osmium) et écriture du fichier .osm pour JOSM.

Les objets OSM sont des dicts indexés par une clé "n123" / "w123" / "r123" (type + id) :
- nœud : {"version", "tags", "lat", "lon"}
- voie : {"version", "tags", "nodes": ["n1", "n2", ...]}
- relation : {"version", "tags", "members": [("w123", "rôle"), ...]}
Les objets créés par le script ont un id négatif ("n-12") et pas de version.

Tout le traitement travaille sur obj = ChainMap(modifiés, PBF) : les objets créés ou modifiés sont dans
obj.maps[0] (ce qui sera écrit dans le fichier), les objets lus dans le PBF restent intacts en dessous
(obj.parents). edit() copie un objet du PBF dans les modifiés avant de le changer.
"""

import copy
import re
import subprocess
import tempfile
import xml.etree.ElementTree as ET
from itertools import count
from pathlib import Path

from .config import PBF_PATH

MEMBER_TYPES = {"n": "node", "w": "way", "r": "relation"}
new_ids = count(1)  # ids négatifs des objets créés, uniques pour tout le fichier


def unescape(s):
    return re.sub(r"%([0-9a-fA-F]+)%", lambda m: chr(int(m.group(1), 16)), s)


def read_osm(command, ids):
    """Objets du PBF renvoyés par la commande osmium (getid, getparents) pour ces ids, indexés
    "n123"/"w123"/"r123"."""
    objects = {}
    with tempfile.TemporaryDirectory() as tmp:
        Path(tmp, "ids.txt").write_text("\n".join(ids))
        out = Path(tmp, "out.opl")
        # code 1 = certains ids absents de l'extrait (voisines hors Normandie) : sans importance
        res = subprocess.run(["osmium", *command, PBF_PATH, "-i", Path(tmp, "ids.txt"), "-f", "opl", "-o", out],
                             stderr=subprocess.PIPE, text=True)
        if res.returncode > 1:
            raise RuntimeError(f"échec de osmium {command[0]} : {res.stderr}")
        for line in out.read_text().splitlines():
            key, *rest = line.split(" ")
            f = {x[0]: x[1:] for x in rest}
            obj = objects[key] = {"version": f["v"], "tags": dict(
                map(unescape, kv.split("=", 1)) for kv in f["T"].split(",") if kv)}
            if key[0] == "n":
                obj["lat"], obj["lon"] = float(f["y"]), float(f["x"])
            elif key[0] == "w":
                obj["nodes"] = f["N"].split(",") if f["N"] else []
            else:
                obj["members"] = [(ref, unescape(role)) for ref, _, role in
                                  (m.partition("@") for m in f["M"].split(",") if m)]
    return objects


def read_ways(ids):
    """Voies du PBF et leurs nœuds, indexés "n123"/"w123"."""
    return read_osm(["getid", "-r"], ids)


def parent_relations(ids):
    """Relations du PBF qui contiennent ces objets."""
    return {k: o for k, o in read_osm(["getparents"], ids).items() if k[0] == "r"}


def edit(obj, key):
    """Objet à modifier : copié du PBF dans les objets modifiés à la première modification."""
    if key not in obj.maps[0]:
        obj[key] = copy.deepcopy(obj[key])
    return obj[key]


def is_new(key):
    """Objet créé par le script (id négatif : "n-12")."""
    return key[1] == "-"


def write_osm(obj, path):
    """Objets modifiés (et nœuds de leurs voies) au format .osm de JOSM."""
    new = obj.maps[0]
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
