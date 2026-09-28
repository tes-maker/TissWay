"""Noms : réseau d'une agence GTFS, libellés « VILLE Arrêt » et noms des relations."""

import re
import unicodedata
from collections import Counter
from functools import lru_cache

import requests

from .config import GEO_API_URL, NETWORKS


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
