"""Reading the OSM extract (through osmium) and writing the .osm file for JOSM.

OSM objects are dicts keyed "n123" / "w123" / "r123" (type + id):
- node: {"version", "tags", "lat", "lon"}
- way: {"version", "tags", "nodes": ["n1", "n2", ...]}
- relation: {"version", "tags", "members": [("w123", "role"), ...]}
Objects created by the tool have a negative id ("n-12") and no version.

All processing works on obj = ChainMap(modified, extract): created or modified objects live in obj.maps[0]
(what is written to the output file), objects read from the extract stay untouched below (obj.parents).
edit() copies an object from the extract into the modified layer before it is changed.
"""

from __future__ import annotations

import copy
import re
import subprocess
import tempfile
import xml.etree.ElementTree as ET
from itertools import count
from pathlib import Path

from .config import settings

MEMBER_TYPES = {"n": "node", "w": "way", "r": "relation"}
ID_BLOCK_BITS = 22  # see id_batches
new_ids = count(1)  # negative ids of created objects, unique within the output file


def new_key(kind):
    """Key of a new object of kind "n", "w" or "r"."""
    return f"{kind}-{next(new_ids)}"


def _unescape(s):
    return re.sub(r"%([0-9a-fA-F]+)%", lambda m: chr(int(m.group(1), 16)), s)


def id_batches(ids):
    """ids split into the batches of read_osm: each touches at most settings.osmium_id_blocks blocks of
    2**ID_BLOCK_BITS ids. osmium getid / getparents allocate about 4 MB per block touched, so that the ids
    of objects scattered over a region would otherwise cost gigabytes."""
    blocks = {}
    for i in ids:
        blocks.setdefault((i[0], int(i[1:]) >> ID_BLOCK_BITS), []).append(i)
    keys = sorted(blocks)
    step = max(1, settings.osmium_id_blocks)
    return [[i for k in keys[s:s + step] for i in blocks[k]] for s in range(0, len(keys), step)]


def read_osm(command, ids):
    """Objects returned by an osmium command (getid, getparents) for these ids, keyed "n123"/"w123"/"r123".
    One osmium call per batch of id_batches (one pass over the extract each)."""
    objects = {}
    for batch in id_batches(ids):
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, "ids.txt").write_text("\n".join(batch))
            out = Path(tmp, "out.opl")
            # exit code 1 = some ids are not in the extract (neighbouring ways outside it): harmless
            res = subprocess.run(["osmium", *command, str(settings.pbf), "-i", str(Path(tmp, "ids.txt")),
                                  "-f", "opl", "-o", str(out)], stderr=subprocess.PIPE, text=True)
            if res.returncode > 1:
                raise RuntimeError(f"osmium {command[0]} failed: {res.stderr.strip()}")
            objects.update(parse_opl(out.read_text()))
    return objects


def parse_opl(text):
    """Objects of an OPL text (osmium's line format), keyed "n123"/"w123"/"r123"."""
    objects = {}
    for line in text.splitlines():
        key, *rest = line.split(" ")
        f = {x[0]: x[1:] for x in rest if x}
        obj = objects[key] = {"version": f["v"], "tags": dict(
            map(_unescape, kv.split("=", 1)) for kv in f.get("T", "").split(",") if kv)}
        if key[0] == "n":
            obj["lat"], obj["lon"] = float(f["y"]), float(f["x"])
        elif key[0] == "w":
            obj["nodes"] = f["N"].split(",") if f.get("N") else []
        else:
            obj["members"] = [(ref, _unescape(role)) for ref, _, role in
                              (m.partition("@") for m in f.get("M", "").split(",") if m)]
    return objects


def read_ways(ids):
    """Objects of the extract with these ids (nodes and ways), plus the nodes of the ways, keyed
    "n123"/"w123". The nodes are read afterwards, in their own batches (not with getid -r, which would hold
    the ids of every node at once)."""
    objects = read_osm(["getid"], ids)
    nodes = {n for o in objects.values() for n in o.get("nodes", ())} - set(objects)
    objects.update(read_osm(["getid"], nodes))
    return objects


def parent_relations(ids):
    """Relations of the extract that contain these objects."""
    return {k: o for k, o in read_osm(["getparents"], ids).items() if k[0] == "r"}


def edit(obj, key):
    """Object to modify: copied from the extract into the modified layer on its first change."""
    if key not in obj.maps[0]:
        obj[key] = copy.deepcopy(obj[key])
    return obj[key]


def is_new(key):
    """Object created by the tool (negative id: "n-12")."""
    return key[1] == "-"


def write_osm(obj, path):
    """Modified objects (and the nodes of their ways) as a JOSM .osm file."""
    new = obj.maps[0]
    root = ET.Element("osm", version="0.6", generator="TissWay", upload="true")
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
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    ET.ElementTree(root).write(path, encoding="utf-8", xml_declaration=True)
