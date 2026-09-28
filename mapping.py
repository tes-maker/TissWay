"""Génère les relations PTv2 des lignes de bus/car du GTFS régional Atoumod (tous réseaux : Nomad,
Twisto, Astuce...) dans un seul fichier .osm par exécution, à relire dans JOSM (avec PT Assistant).

Pour chaque variante : la stop_position (existante ou créée sur la voie) et le quai de chaque arrêt,
puis les voies map-matchées par Valhalla. Seuls les ronds-points d'un seul tenant sont découpés (une
fois pour toutes les lignes du fichier, relations existantes mises à jour) ; les autres voies ne sont
pas découpées et les trous ne sont pas comblés : c'est à faire dans JOSM.

Le traitement est dans le paquet atoumod/ (voir atoumod/__init__.py) ; ce fichier n'est que la ligne
de commande.

Usage : python mapping.py [-r RÉSEAU] [-l LIGNE...] [LIGNE...]   (sans argument : toutes les lignes, tous réseaux)
"""

import argparse
import sys

from atoumod.pipeline import SelectionError, run


def parse_args():
    parser = argparse.ArgumentParser(description="Génère les relations PTv2 des lignes du GTFS Atoumod dans un .osm.")
    parser.add_argument("refs", nargs="*", help="numéros de ligne à générer (défaut : toutes)")
    parser.add_argument("-l", "--ligne", nargs="+", default=[],
                        help="numéro(s) de ligne à générer, séparés par des espaces ou des virgules (ex. -l 301 305, -l 301,305)")
    parser.add_argument("-r", "--reseau", help="ne générer que les lignes de ce réseau (ex. Nomad, Twisto)")
    args = parser.parse_args()
    # "-l 301,305 310" et "301 305" : numéros dédoublonnés, dans l'ordre donné
    refs = list(dict.fromkeys(r.strip() for x in args.refs + args.ligne for r in x.split(",") if r.strip()))
    return args.reseau, refs


if __name__ == "__main__":
    reseau, refs = parse_args()
    try:
        path = run(reseau, refs)
    except (SelectionError, RuntimeError) as e:
        sys.exit(str(e))
    print(f"-> {path}")
