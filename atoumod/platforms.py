"""Arrêts d'une ligne sur le terrain : stop_position sur la voie et quai (platform) à côté.

Règles appliquées :
- la stop_position est prise (ou créée) sur la voie empruntée, au plus près de l'arrêt GTFS ;
- le quai est choisi à droite de la voie dans le sens de parcours de la ligne ;
- si le GTFS rattache la ligne au quai d'en face (erreur fréquente), on prend les données de l'autre quai
  GTFS du même arrêt (fix_side) ;
- un stop_id GTFS n'est posé que sur un seul quai OSM (tag_platforms), même quand le GTFS n'a qu'un
  arrêt pour les deux sens ;
- les tags d'un autre réseau ne sont jamais écrasés (add_tag, enrich).
"""

from itertools import chain, count

from .config import MAX_STOP_POSITION_M
from .geo import dist, latlon, project, right_of
from .osm import edit, is_new, new_ids


def place_stop(obj, ways, stop, start):
    """(index de la voie, stop_position existante ou créée) du premier passage près de l'arrêt,
    en cherchant à partir de ways[start], ou None."""
    c = latlon(stop)
    best, run = None, []
    for i in range(start, len(ways)):
        nodes = obj[ways[i]]["nodes"]
        near = [(d, i, k, t) for k, (a, b) in enumerate(zip(nodes, nodes[1:]))
                for t, d in [project(c, latlon(obj[a]), latlon(obj[b]))] if d <= MAX_STOP_POSITION_M]
        if near:
            run.append(i)
            best = min(near + [best] if best else near)
        elif best:
            break
    if best is None:
        return None
    existing = [(d, i, n) for i in run for n in obj[ways[i]]["nodes"]
                if obj[n]["tags"].get("public_transport") == "stop_position" and obj[n]["tags"].get("bus") != "no"
                for d in [dist(c, latlon(obj[n]))] if d <= MAX_STOP_POSITION_M]
    if existing:
        return min(existing)[1:]
    _, i, k, t = best
    nodes = edit(obj, ways[i])["nodes"]
    a, b = latlon(obj[nodes[k]]), latlon(obj[nodes[k + 1]])
    length = dist(a, b)
    t = min(max(t, 1 / length), 1 - 1 / length) if length > 2 else 0.5  # pas collé à un nœud existant
    key = f"n-{next(new_ids)}"
    obj[key] = {"lat": a[0] + t * (b[0] - a[0]), "lon": a[1] + t * (b[1] - a[1]), "tags": {
        "public_transport": "stop_position", "bus": "yes", "name": stop["stop_name"]}}
    nodes.insert(k + 1, key)
    return i, key


def forward(obj, ways, i):
    """La variante parcourt-elle ways[i] dans le sens de ses nœuds ? Déduit des nœuds partagés avec la
    voie précédente (entrée) et suivante (sortie) ; à défaut, sens des nœuds sauf oneway=-1."""
    nodes = obj[ways[i]]["nodes"]
    shared = lambda j: [k for k, n in enumerate(nodes) if n in set(obj[ways[j]]["nodes"])] if 0 <= j < len(ways) else []
    entry, exit = shared(i - 1), shared(i + 1)
    if entry and exit:
        return min(entry) < max(exit)
    if exit:
        return max(exit) > 0
    if entry:
        return min(entry) < len(nodes) - 1
    return obj[ways[i]]["tags"].get("oneway") != "-1"


def direction(obj, placed):
    """Segment (a, b) de la voie autour de la stop_position placed = (voie, nœud, sens des nœuds ?), dans
    le sens de parcours de la ligne (et non celui des nœuds de la voie)."""
    way, key, fwd = placed
    nodes = obj[way]["nodes"]
    i = nodes.index(key)
    a, b = latlon(obj[nodes[max(i - 1, 0)]]), latlon(obj[nodes[min(i + 1, len(nodes) - 1)]])
    return (a, b) if fwd else (b, a)


def choose_platform(candidates, stop, obj, placed):
    """Quai OSM candidat à droite de la voie (dans le sens de parcours autour de la stop_position placed,
    voir direction) plutôt qu'en face : celui qui porte déjà le stop_id dans OSM, sinon le plus proche de
    l'arrêt GTFS, ou de la stop_position s'ils sont homonymes. None si aucun candidat."""
    if placed:
        a, b = direction(obj, placed)
        candidates = [c for c in candidates if right_of(c["pos"], a, b)] or candidates
        if len({c["name"] for c in candidates}) == 1:
            stop = latlon(obj[placed[1]])
    return min(candidates, key=lambda c: (not c["holder"], dist(stop, c["pos"])), default=None)


def fix_side(stop_id, platform, obj, placed, stops):
    """(quai, stop_id GTFS dont il prend les données). Si le GTFS rattache la ligne à l'arrêt de gauche
    (erreur de leur côté : la ligne n'est pas rattachée au bon quai), on prend l'autre quai GTFS du même
    arrêt situé à droite (stops.neighbours : même code à la lettre près, ex. 2702282A -> 2702282B) :
    son quai OSM à droite (celui qui porte déjà son stop_id, sinon le plus proche), sinon le quai OSM
    retenu s'il est à droite, sinon None (quai à créer à sa position).
    (platform, stop_id) inchangés si l'arrêt est déjà à droite ou si le GTFS n'a pas de quai à droite
    pour cet arrêt (un seul stop_id pour les deux sens : voir tag_platforms)."""
    if not placed:
        return platform, stop_id
    a, b = direction(obj, placed)
    pos = lambda sid: latlon(stops.df.loc[sid])
    if right_of(pos(stop_id), a, b):
        return platform, stop_id
    opposite = min((sid for sid in stops.neighbours[stop_id] if right_of(pos(sid), a, b)),
                   key=lambda sid: dist(pos(sid), pos(stop_id)), default=None)
    if opposite is None:
        return platform, stop_id
    candidates = [c for c in stops.platforms[opposite] if right_of(c["pos"], a, b)]
    if not candidates and platform and right_of(platform["pos"], a, b):
        candidates = [platform]
    return min(candidates, key=lambda c: (not c["holder"], dist(pos(opposite), c["pos"])), default=None), opposite


def stop_tags(stop, stop_id, network):
    """Tags d'un quai tirés du GTFS."""
    tags = {"public_transport": "platform", "highway": "bus_stop", "bus": "yes", "name": stop["stop_name"],
            **network, "gtfs:stop_id": stop_id, "ref:FR:Atoumod": stop_id}
    if isinstance(stop["stop_code"], str):
        tags["ref"] = stop["stop_code"]
    if stop["wheelchair_boarding"] in ("1", "2"):
        tags["wheelchair"] = "yes" if stop["wheelchair_boarding"] == "1" else "no"
    return tags


ID_TAGS = ("gtfs:stop_id", "ref:FR:Atoumod", "ref", "wheelchair")  # propres à un seul quai physique


def tag_platforms(obj, stops, assignments):
    """Pose les données GTFS sur les quais retenus par les lignes (assignments : stop_id -> {quai: (tags
    réseau, position)}). Un stop_id n'est posé (ID_TAGS) que sur un seul quai : celui qui le porte déjà
    dans OSM, sinon le plus proche de l'arrêt GTFS. Les autres (arrêt GTFS unique pour les deux sens,
    quais de part et d'autre de la route) ne reçoivent que name et network, et perdent le stop_id s'ils
    l'avaient déjà. Si un quai OSM hors de ces lignes porte déjà le stop_id, il n'est posé nulle part.
    Renvoie les stop_id non posés pour cette raison."""
    elsewhere = []
    for data_id, plats in assignments.items():
        d = stops.df.loc[data_id]
        holders = stops.holders.get(data_id, set())
        owner = None
        if holders - set(plats):
            elsewhere.append(f"{d['stop_name']} ({data_id} : {', '.join(sorted(holders - set(plats)))})")
        else:
            owner = min(plats, key=lambda p: (p not in holders, dist(latlon(d), plats[p][1])))
        for p, (network, _) in plats.items():
            tags = stop_tags(d, data_id, network)
            if p != owner:
                tags = {k: v for k, v in tags.items() if k not in ID_TAGS}
                if p in holders:  # doublon déjà dans OSM : retiré
                    t = edit(obj, p)["tags"]
                    for k in [k for k, v in t.items() if k.startswith(ID_TAGS[:2]) and v == data_id]:
                        del t[k]
            if is_new(p):
                obj[p]["tags"] = {**tags, **obj[p]["tags"]}
            else:
                enrich(obj, p, tags)
    return elsewhere


def add_tag(t, key, value):
    """Ajoute une valeur à un tag sans écraser une valeur différente déjà posée par un autre réseau :
    posée sur la 1re clé numérotée libre ("network:2", "ref:FR:Atoumod:2"...)."""
    if key not in t:
        t[key] = value
    elif t[key] != value:
        n = next(n for n in count(2) if t.get(f"{key}:{n}", value) == value)
        t[f"{key}:{n}"] = value


def enrich(obj, key, tags):
    """Complète un quai OSM existant avec les tags du GTFS/réseau sans écraser ceux d'un autre réseau
    (voir add_tag), sauf name, remplacé par le nom officiel GTFS. Les tags network* d'un même réseau
    prennent tous le même numéro ("network:2", "network:wikidata:2"...)."""
    t = edit(obj, key)["tags"]
    n = next(n for n in chain([""], (f":{i}" for i in count(2))) if t.get(f"network{n}", tags["network"]) == tags["network"])
    for k, v in tags.items():
        if k == "name":
            t[k] = v
        elif k.startswith("network"):
            t[k + n] = v
        else:
            add_tag(t, k, v)


def enrich_stop_position(obj, key, name):
    """Complète a minima une stop_position OSM existante (bus=yes, name officiel GTFS), sans toucher à
    ses autres tags."""
    t = edit(obj, key)["tags"]
    t.setdefault("bus", "yes")
    t["name"] = name
