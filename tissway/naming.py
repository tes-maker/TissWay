"""Names: network of a GTFS agency, stop labels used in relation names, relation names.

Route names follow the PTv2 convention ``<Mode> <ref>: <from> → <to>`` and route masters
``<Mode> <ref>: <A> ↔ <B>`` (``A1 / A2 ↔ B`` when several origins share a terminus). The stop labels
are the GTFS stop names, prefixed with their locality when settings.locality enables it (see locality).
"""

from __future__ import annotations

import logging
import re
import unicodedata
from collections import Counter
from functools import cache
from importlib.resources import files

import requests

from .config import settings

log = logging.getLogger(__name__)

MODE_LABELS = {"bus": "Bus", "coach": "Coach", "trolleybus": "Trolleybus", "tram": "Tram", "train": "Train",
               "subway": "Subway", "ferry": "Ferry", "monorail": "Monorail", "funicular": "Funicular",
               "aerialway": "Aerialway"}


def unaccent(s):
    return "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c))


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", unaccent(s).lower()).strip("-")


def name_key(name):
    """Comparison key of a stop name: case, accents and punctuation ignored."""
    return re.sub(r"[\W_]+", " ", unaccent(name or "").casefold()).strip()


# --- French accents --------------------------------------------------------------------------------------

# Accented French words, read from data/fr_accents.txt (see the comments there).
ACCENTS = {unaccent(w): w for w in (line.strip() for line in
           files(__package__).joinpath("data/fr_accents.txt").read_text(encoding="utf-8").splitlines())
           if w and not w.startswith("#")}
WORD = re.compile(r"[^\W\d_]+")


def fix_accents(name):
    """Restore the accents dropped by the GTFS ("Gare Routiere" -> "Gare Routière", "EGLISE" -> "ÉGLISE"):
    words of ACCENTS and -iere(s) endings -> -ière(s), keeping the case of each word."""
    def fix(m):
        w = m.group()
        if not w.isascii():
            return w
        low = w.lower()
        new = ACCENTS.get(low) or re.sub(r"iere(s?)$", r"ière\1", low)
        if new == low:
            return w
        return new.upper() if w.isupper() and len(w) > 1 else new.capitalize() if w[0].isupper() else new
    return WORD.sub(fix, name) if isinstance(name, str) else name


def clean_stop_name(name):
    """Stop name as written on OSM objects: trimmed, accents restored if settings.fix_accents."""
    name = " ".join(str(name).split())
    return fix_accents(name) if settings.fix_accents else name


# --- networks --------------------------------------------------------------------------------------------

def agency_networks(agency):
    """agency_id -> network tags: settings.networks (keyed by agency_id or agency_name) when configured,
    else derived from agency_name ("Twisto (Caen la mer)" -> {"network": "Twisto"}), never with an
    unverified operator or wikidata."""
    out = {}
    for agency_id, name in zip(agency["agency_id"], agency["agency_name"]):
        configured = settings.networks.get(agency_id) or settings.networks.get(name)
        derived = name.partition(" (")[0].strip() or agency_id or "GTFS"
        out[agency_id] = dict(configured) if configured else {"network": derived}
    return out


# --- localities ------------------------------------------------------------------------------------------

INSEE_IN_ID = re.compile(r"(?:^|:)FR:(\d[\dAB]\d{3}):")  # NeTEx-style ids: "FR:<INSEE>:ZE:..."


@cache
def communes(dept):
    """INSEE code -> official name of the communes of a French département (Découpage administratif API);
    {} if the API cannot be reached."""
    try:
        res = requests.get(settings.locality_api, params={"codeDepartement": dept, "fields": "nom,code"}, timeout=10)
        res.raise_for_status()
        return {c["code"]: c["nom"] for c in res.json()}
    except requests.RequestException as e:
        log.warning("communes of département %s not fetched (%s): localities left out", dept, e)
        return {}


@cache
def commune_at(lat, lon):
    """Name of the French commune at (lat, lon) (rounded by the caller), None if none or unreachable."""
    try:
        res = requests.get(settings.locality_api, params={"lat": lat, "lon": lon, "fields": "nom"}, timeout=10)
        res.raise_for_status()
        found = res.json()
        return found[0]["nom"] if found else None
    except (requests.RequestException, ValueError, KeyError, IndexError):
        return None


def commune_of_insee(code):
    dept = code[:3] if code.startswith("97") else code[:2]
    return communes(dept).get(code)


def locality(stop_id, pos=None):
    """Locality of a stop according to settings.locality, None if disabled or unknown.
    "insee": French commune of the INSEE code in the stop_id ("FR:<insee>:..."), else of the stop position."""
    if settings.locality != "insee":
        return None
    m = INSEE_IN_ID.search(stop_id)
    if m:
        name = commune_of_insee(m.group(1))
        if name:
            return name
    if pos is not None:
        return commune_at(round(pos[0], 4), round(pos[1], 4))
    return None


LINK_WORDS = r"(?:SUR|EN|LES?|LA|DE|DU|DES|AUX?)"


def strip_locality(ville, name):
    """name without the locality ville (upper case, unaccented) or its beginning when it repeats it
    ("Avranches - X", "St-Malo X", "Fleury X" in Fleury-sur-Orne...)."""
    words = ["(?:STE?|SAINTE?)" if w in ("SAINT", "SAINTE") else re.escape(w) for w in ville.split("-")]
    starts = ["[ -]".join(words)]
    for n in range(len(words) - 1, 0, -1):
        # beginning of the commune ("Fleury Mairie" in Fleury-sur-Orne), but not "Saint" alone or ending
        # with a link word
        if re.fullmatch(LINK_WORDS, words[n - 1]) or (n == 1 and words[0].startswith("(?:")):
            continue
        # followed by a space or ":" (not "CONDE-SUR-NOIREAU"), then neither "/", a link word nor the rest
        # of the commune ("PACY S/ EURE", "Mont aux Malades", "NOTRE DAME D'ESTREES"). "[ :-]" in the negative
        # lookahead makes [ :-]* consume every separator (no possessive *+ before Python 3.11)
        starts.append(rf"{'[ -]'.join(words[:n])}(?=[ :][ :-]*(?![ :-]|/|S/|D'|(?:{LINK_WORDS}|{words[n]})\b))")
    prefix = re.match(rf"(?:{'|'.join(starts)})\b[ :-]*", unaccent(name), re.IGNORECASE)
    return name[prefix.end():] if prefix else name


def line_label(stop_id, name, pos=None):
    """Stop label for relation names: "LOCALITY Stop" (locality upper case and unaccented, removed from
    the stop name if it repeats it) when the locality is known, else the GTFS stop name."""
    ville = locality(stop_id, pos)
    if not ville:
        return name
    ville = unaccent(ville).upper()
    rest = strip_locality(ville, name)
    return f"{ville} {rest}" if rest else ville


def route_name(mode, ref, label):
    prefix = MODE_LABELS.get(mode, mode.capitalize())
    return f"{prefix} {ref}: {label}" if ref else f"{prefix}: {label}"


def master_endpoints_label(endpoints):
    """Termini of a line (route_master) from the (origin, terminus) of its variants: "A ↔ B", or
    "A1 / A2 ↔ B" when several origins share the terminus B."""
    counts = Counter(name for pair in endpoints for name in pair)
    hub = counts.most_common(1)[0][0]
    others = list(dict.fromkeys(name for pair in endpoints for name in pair if name != hub))
    return f"{' / '.join(others)} ↔ {hub}" if others else hub
