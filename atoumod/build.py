"""Construction des relations d'une ligne : une relation route par variante et un route_master."""

from .config import GTFS_FEED, MAX_STOP_POSITION_M
from .geo import latlon, right_of
from .naming import master_endpoints_label, slug
from .osm import is_new, new_ids
from .platforms import choose_platform, direction, enrich_stop_position, fix_side, forward, place_stop


def build_line(route, variants, obj, stops, network, assignments, created):
    """Ajoute à obj les relations de la ligne et ses stop_positions ; les quais retenus sont notés dans
    assignments (stop_id GTFS -> {quai: (tags réseau, position)}), leurs tags sont posés ensuite par
    tag_platforms. created : stop_id GTFS -> quai créé à sa position, commun à toutes les lignes (pas
    deux quais créés au même endroit)."""
    ref = route["route_short_name"]
    before = set(obj.maps[0])
    # (stop_id, direction) -> (quai retenu, stop_id GTFS dont il prend les données) : un arrêt GTFS desservi
    # dans les deux sens n'a pas le même quai à l'aller et au retour
    chosen = {}
    common ={**network, "colour": f"#{route['route_color']}",
              "colour:text": f"#{route['route_text_color']}", f"gtfs:route_id:{GTFS_FEED}": route["route_id"]}
    master_members, endpoints, missing, gaps, swapped, left = [], [], 0, set(), [], []
    for v in variants:
        ways = v["ways"]
        members, start = [], 0
        for stop_id in v["seq"]:
            s = stops.df.loc[stop_id]
            placed = place_stop(obj, ways, s, start)
            if placed:
                start = placed[0]
                if not is_new(placed[1]):  # stop_position existante
                    enrich_stop_position(obj, placed[1], s["stop_name"])
                members.append((placed[1], "stop"))
            else:
                missing += 1
            side = (stop_id, v["direction"])
            if side not in chosen:
                around = placed and (ways[placed[0]], placed[1], forward(obj, ways, placed[0]))
                c = choose_platform(stops.platforms[stop_id], latlon(s), obj, around)
                c, data_id = fix_side(stop_id, c, obj, around, stops)
                if data_id != stop_id:
                    swapped.append(f"{s['stop_name']} ({stop_id} -> {data_id}{', quai créé' if not c else ''})")
                if not c and data_id not in created:
                    d = stops.df.loc[data_id]
                    created[data_id] = f"n-{next(new_ids)}"
                    obj[created[data_id]] = {"lat": d["lat"], "lon": d["lon"], "tags": {}}
                chosen[side] = (c["id"] if c else created[data_id], data_id)
                assignments.setdefault(data_id, {})[chosen[side][0]] = (
                    network, c["pos"] if c else latlon(stops.df.loc[data_id]))
                if around and not right_of(c["pos"] if c else latlon(stops.df.loc[data_id]), *direction(obj, around)):
                    left.append(s["stop_name"])
            members.append((chosen[side][0], "platform"))
        members += [(w, "") for w in ways]
        gaps |= {(a, b) for a, b in zip(ways, ways[1:]) if not set(obj[a]["nodes"]) & set(obj[b]["nodes"])}
        first, last = stops.df.loc[v["seq"][0]], stops.df.loc[v["seq"][-1]]
        endpoints.append((first["label"], last["label"]))
        key = f"r-{next(new_ids)}"
        obj[key] = {"members": members, "tags": {
            "type": "route", "route": "bus", "ref": ref,
            "name": f"Bus {ref}: {first['label']} → {last['label']}", **common,
            f"gtfs:trip_id:sample:{GTFS_FEED}": v["trip_id"],
            f"gtfs:shape_id:{GTFS_FEED}": f"{slug(network['network']).upper()}:{v['shape_id']}",
            "ref_trips": v["trip_id"], "from": first["stop_name"], "to": last["stop_name"], "public_transport:version": "2"}}
        master_members.append((key, ""))
    obj[f"r-{next(new_ids)}"] = {"members": master_members, "tags": {
        "type": "route_master", "route_master": "bus", "ref": ref,
        "name": f"Bus {ref}: {master_endpoints_label(endpoints)}", **common}}

    new_nodes = [k for k in obj.maps[0] if k.startswith("n-") and k not in before]
    n_platforms = sum(k in created.values() for k in new_nodes)
    print(f"ligne {ref} : {len(variants)} variante(s), {len(new_nodes) - n_platforms} stop_position, "
          f"{n_platforms} quai(s)"
          + (f", warning: {missing} arrêt(s) à plus de {MAX_STOP_POSITION_M} m du tracé" if missing else "")
          + (f", warning: {len(gaps)} trou(s) entre voies" if gaps else ""))
    for x in swapped:
        print(f"  arrêt GTFS du mauvais côté, données de l'arrêt d'en face : {x}")
    if left:
        print(f"  warning: {len(left)} quai(s) à gauche faute de quai OSM ou d'arrêt GTFS à droite : {', '.join(left)}")
