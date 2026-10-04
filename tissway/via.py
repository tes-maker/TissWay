"""Add "via …" to the names of route relations sharing the same name in a .osm file (JOSM).

Relations are grouped by name (without any "via" already present, so the command can be run again). In
each group of several relations, each one gets as few stops as possible, taken from its intermediate stops
(platforms), that set it apart from the others:
    Bus 117: FLERS Gare → CAEN Gare Routière via Les Landes, Les Vallées
A relation whose stops are all served by another one keeps its name without "via": the other relation gets
the extra stops.

A stop is identified by its locality (INSEE code of its stop_id "FR:<insee>:…" in French feeds) and its
name. The locality is only shown ("LAIZE-LA-VILLE Mairie") when two different stops of the group share a
name.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from collections import Counter, defaultdict

from .config import settings
from .naming import INSEE_IN_ID, commune_of_insee, unaccent

VIA = " via "
PLATFORM_ROLES = ("platform", "platform_entry_only", "platform_exit_only")
STOP_ROLES = ("stop", "stop_entry_only", "stop_exit_only")


def tags_of(elem):
    return {t.get("k"): t.get("v") for t in elem.findall("tag")}


def set_tag(elem, k, v):
    for t in elem.findall("tag"):
        if t.get("k") == k:
            t.set("v", v)
            return
    ET.SubElement(elem, "tag", k=k, v=v)


def locality_label(code):
    """Commune of an INSEE code, upper case and unaccented ("LAIZE-LA-VILLE"), or the code itself."""
    name = commune_of_insee(code)
    return unaccent(name).upper() if name else code


def stop_key(tags):
    """(locality code or None, name) of a platform; None if it has no name."""
    if "name" not in tags:
        return None
    stop_id = next((tags[k] for k in ("gtfs:stop_id", *settings.stop_ref_tags) if tags.get(k)), "")
    m = INSEE_IN_ID.search(stop_id)
    return (m and m.group(1), tags["name"])


def route_stops(rel, objs):
    """Stops of the relation in order (platforms, else stop_positions), without consecutive repeats; None if
    one of these members is not in the file (incomplete existing relation) or if there are none."""
    for roles in (PLATFORM_ROLES, STOP_ROLES):
        members = [(m.get("type"), m.get("ref")) for m in rel.findall("member") if m.get("role") in roles]
        if any(m not in objs for m in members):
            return None
        keys = [stop_key(objs[m]) for m in members]
        keys = [k for i, k in enumerate(keys) if k and (i == 0 or k != keys[i - 1])]
        if keys:
            return keys
    return None


def choose_vias(stops):
    """For each relation (ordered list of stops), the intermediate stops to name after "via".

    Each relation must stand apart from every other relation it has at least one more stop than: the stops
    setting it apart from the most relations at once are picked greedily (on ties, the least frequent in
    the group, then the first on the way). Two relations with different stops then get different vias: if
    A has a stop B lacks, the via of A contains a stop absent from B."""
    middles = [s[1:-1] for s in stops]
    sets = [set(s) for s in stops]
    freq = Counter(k for s in middles for k in set(s))
    vias = []
    for i, mid in enumerate(middles):
        todo = {j: set(mid) - sets[j] for j in range(len(stops)) if j != i and set(mid) - sets[j]}
        chosen = set()
        while todo:
            best = max(dict.fromkeys(mid), key=lambda k: (sum(k in d for d in todo.values()), -freq[k], -mid.index(k)))
            chosen.add(best)
            todo = {j: d for j, d in todo.items() if best not in d}
        vias.append([k for k in dict.fromkeys(mid) if k in chosen])
    return vias


def add_vias(root, prefix=""):
    """Rename the relations in place; returns [(old name, new name)] and the warnings."""
    objs = {(e.tag, e.get("id")): tags_of(e) for e in root if e.tag in ("node", "way", "relation")}
    groups = defaultdict(list)
    for rel in root.findall("relation"):
        tags = tags_of(rel)
        if tags.get("type") == "route" and tags.get("name") and tags["name"].startswith(prefix):
            groups[tags["name"].split(VIA)[0]].append(rel)

    changes, warnings = [], []
    for base, rels in groups.items():
        if len(rels) < 2:  # name already unique: any "via" is kept
            continue
        stops = [route_stops(r, objs) for r in rels]
        if None in stops:
            warnings.append(f"skipped, stops missing from the file (download the whole relation): {base}")
            continue
        vias = choose_vias(stops)
        # locality shown only for names carried by several distinct stops of the group
        keys = {k for s in stops for k in s}
        homonyms = {n for n, c in Counter(n for _, n in keys).items() if c > 1}
        names = []
        for rel, via in zip(rels, vias):
            labels = [f"{locality_label(i)} {n}" if n in homonyms and i else n for i, n in via]
            name = f"{base}{VIA}{', '.join(labels)}" if labels else base
            names.append(name)
            old = tags_of(rel)["name"]
            if name != old:
                set_tag(rel, "name", name)
                if rel.get("action") != "delete":
                    rel.set("action", "modify")
                changes.append((old, name))
        for name, n in Counter(names).items():
            if n > 1:
                ids = [r.get("id") for r, x in zip(rels, names) if x == name]
                warnings.append(f"{n} relations keep the same name (same stops): {name} [{', '.join(ids)}]")
    return changes, warnings
