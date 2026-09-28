"""Découpage des ronds-points d'un seul tenant.

Un rond-point dessiné comme une seule voie fermée ferait faire le tour complet à chaque ligne qui
l'emprunte. On le découpe une fois, pour toutes les lignes du fichier, à chaque entrée et sortie : chaque
ligne ne garde que les morceaux qu'elle parcourt, et les relations OSM existantes qui contenaient le
rond-point reçoivent tous les morceaux (pas de trou pour les autres lignes, itinéraires vélo...).
"""

from .osm import new_ids, parent_relations


def is_roundabout(o):
    """Rond-point d'un seul tenant (voie fermée) : une ligne qui l'emprunte en ferait tout le tour."""
    nodes = o.get("nodes", [])
    return (o["tags"].get("junction") in ("roundabout", "circular")
            and len(nodes) > 3 and nodes[0] == nodes[-1])


def passages(ways, obj, i):
    """(entrée, sortie) de la variante sur la voie ways[i] : nœud partagé avec la voie précédente /
    suivante, None en bout de variante ou s'il y a un trou."""
    shared = lambda j: next(iter(set(obj[ways[j]]["nodes"]) & set(obj[ways[i]]["nodes"])), None)
    return shared(i - 1) if i else None, shared(i + 1) if i + 1 < len(ways) else None


def traversed(parts, obj, entry, exit):
    """Morceaux d'un rond-point découpé (dans le sens giratoire) parcourus de entry à exit (tour complet si
    entry == exit, un seul morceau si l'une des deux est inconnue)."""
    if entry is None and exit is None:
        return parts
    starts = [obj[p]["nodes"][0] for p in parts]
    ends = [obj[p]["nodes"][-1] for p in parts]
    k = starts.index(entry) if entry in starts else ends.index(exit) if exit in ends else 0
    out = []
    for step in range(len(parts)):
        out.append(parts[(k + step) % len(parts)])
        if exit is None or ends[(k + step) % len(parts)] == exit:
            break
    return out


def split_roundabouts(variants, obj):
    """Découpe une seule fois, pour toutes les variantes, les ronds-points d'un seul tenant à chaque entrée et
    sortie des lignes, et ne garde dans chaque variante que les morceaux parcourus (plutôt que le tour
    complet). Le morceau le plus long garde l'id du rond-point. Les relations OSM existantes qui le
    contiennent reçoivent tous les morceaux, dans l'ordre du sens giratoire, pour ne pas y créer de trou.
    Renvoie le nombre de ronds-points découpés."""
    osm = obj.parents  # nœuds d'origine des ronds-points, avant découpage
    cuts = {}  # rond-point -> nœuds de coupe
    for v in variants:
        for i, w in enumerate(v["ways"]):
            if is_roundabout(osm[w]):
                cuts.setdefault(w, set()).update(n for n in passages(v["ways"], osm, i) if n)
    parts = {}  # rond-point -> ids des morceaux dans le sens giratoire
    for w, nodes in cuts.items():
        ring = osm[w]["nodes"][:-1]
        idx = sorted({ring.index(n) for n in nodes})
        if len(idx) < 2:  # une seule coupe : rien à découper
            continue
        arcs = [ring[i:j + 1] if j > i else ring[i:] + ring[:j + 1] for i, j in zip(idx, idx[1:] + idx[:1])]
        keep = max(range(len(arcs)), key=lambda k: len(arcs[k]))
        parts[w] = [w if k == keep else f"w-{next(new_ids)}" for k in range(len(arcs))]
        for p, arc in zip(parts[w], arcs):
            obj[p] = {**({"version": osm[w]["version"]} if p == w else {}),
                      "nodes": arc, "tags": dict(osm[w]["tags"])}

    for key, rel in parent_relations(parts).items():
        members = []
        for ref, role in rel["members"]:
            if ref not in parts:
                members.append((ref, role))
                continue
            # on commence par le morceau qui part de la voie précédente de la relation, si elle est connue
            prev = members[-1][0] if members else None
            prev_nodes = set(obj[prev]["nodes"]) if prev in obj and "nodes" in obj[prev] else set()
            k = next((k for k, p in enumerate(parts[ref]) if obj[p]["nodes"][0] in prev_nodes), 0)
            members += [(p, role) for p in parts[ref][k:] + parts[ref][:k]]
        obj[key] = {**rel, "members": members}

    for v in variants:
        ways = []
        for i, w in enumerate(v["ways"]):
            ways += traversed(parts[w], obj, *passages(v["ways"], osm, i)) if w in parts else [w]
        v["ways"] = ways
    return len(parts)
