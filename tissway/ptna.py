"""Update or generate the PTNA route list (CSV format of the OSM wiki) of a network from the GTFS.

The input file is the text of the wiki page (or only its <pre>…</pre> block). Everything that is not a CSV
line (titles "=", texts "-", comments "#") is copied as is. For each CSV line of the network, found by its
GTFS route_id (8th field):
- the comment (3rd field) gets the termini of the GTFS variants, "LOCALITY Stop ↔ LOCALITY Stop" ("A1 / A2 ↔
  B" with several origins; at most MAX_VARIANTS variants of at least MIN_VARIANT_SHARE of the trips,
  platforms merged), like the route_master names of the routes command; when route_long_name reads
  "A <> B via X", the termini follow the order A, B and "via X" is appended; route_long_name ("<>" replaced
  by "↔") when the route has no trip;
- the type (2nd field) follows the GTFS route_type; the GTFS feed is filled in when empty;
- the operator (6th field) is filled in when empty (GTFS agency_name), or replaced everywhere by --operator;
- the ref (1st field) is kept, since it must stay the one of the OSM tags ("10 EXPRESS" for "10EX"):
  differences with route_short_name are reported, and --ref-gtfs replaces them;
- a CSV line without route_id gets the one of the only GTFS route of that number not listed yet;
- a line whose route_id is no longer in the GTFS is commented out ("#");
- GTFS routes missing from the file are inserted at their place (route number order) among the listed
  routes of the same sub-section (settings.ptna["sections"]), or of the same mode for a network without
  sub-sections; if there are none, they go to a "new routes" section to sort out, with its sub-sections.
CSV lines of other networks (different route_id prefix) are left unchanged.

Without input file, the complete list of the network is generated: one "==" section per mode (tram,
bus...), split into "===" sub-sections according to settings.ptna["sections"], in a complete wiki page
(introduction, <pre>, "= Overview" header with the wiki and PTNA links, categories) described by
settings.ptna["pages"].

The wiki texts are in English (TEXT); a profile can replace them (settings.ptna["text"]).
"""

from __future__ import annotations

import csv
import re
from datetime import date

from .config import settings
from .gtfs import line_variants, osm_route, stop_sequences
from .naming import agency_networks, clean_stop_name, line_label, master_endpoints_label, unaccent

MODES = ["tram", "subway", "train", "bus", "coach", "ferry", "aerialway", "funicular", "trolleybus", "monorail"]

# Wiki texts. A profile replaces any of them with settings.ptna["text"] (e.g. to write French pages).
TEXT = {
    "modes": {"tram": "Tram lines", "subway": "Subway lines", "train": "Train lines", "bus": "Bus lines",
              "coach": "Coach lines", "ferry": "Ferry lines", "aerialway": "Aerialways",
              "funicular": "Funiculars", "trolleybus": "Trolleybus lines", "monorail": "Monorails"},
    "other": "Other lines",
    "new": "New lines (GTFS of {date:%Y-%m-%d}, to sort out)",
    "csv_intro": "This page follows the CSV format of PTNA. For more information, see "
                 "[[Public Transport Network Analysis/Syntax of CSV data]].",
    "tool": "# This data is entered for the tool: PTNA - Public Transport Network Analysis "
            "(https://ptna.openstreetmap.de)",
    "overview": "= Overview of the {title}",
    "default_title": "{network} network",
    "overview_link": "- An overview of the {link} is available in the OSM wiki.",
    "page_link": "- Configuration file for this analysis: {link}.",
    "config_link": "- Configuration file of [/en/config.php?network={ptna} PTNA]",
    "platform_suffix": r"[\s-]+(?:platform|bay|stand|stop)\s*\w{1,2}$",
}

# termini of a variant kept in the comment if it makes at least this share of the trips of the route
# (leaves out school or depot trips: "A1 / A2 / A3 ↔ B" is unreadable)
MIN_VARIANT_SHARE = 0.1
MAX_VARIANTS = 4  # at most, the most frequent ones (school routes with many variants of equal weight)
REF, TYPE, COMMENT, FROM, TO, OPERATOR, FEED, ROUTE_ID = range(8)
MIN_FIELDS = 9  # ref;type;comment;from;to;operator;gtfs_feed;route_id;release_date


def text():
    """Wiki texts: TEXT, overridden by settings.ptna["text"] (its "modes" merged with TEXT["modes"])."""
    custom = settings.ptna.get("text", {})
    return {**TEXT, **custom, "modes": {**TEXT["modes"], **custom.get("modes", {})}}


def sections():
    """network -> [(title, regex on the whole route_short_name)], in display order within each mode."""
    return settings.ptna.get("sections", {})


def page_settings(network):
    return settings.ptna.get("pages", {}).get(network, {})


def ptna_type(route_type, default="bus"):
    return osm_route(route_type) or default


def load_networks(feed):
    """{network name: DataFrame of its GTFS routes} (agencies with the same network tag merged)."""
    networks = agency_networks(feed.agency)
    names = feed.agency.set_index("agency_id")["agency_name"]
    routes = feed.routes.copy()
    routes["network"] = routes["agency_id"].map(lambda a: networks.get(a, {"network": a or "GTFS"})["network"])
    routes["operator"] = routes["agency_id"].map(names).fillna("")
    return {n: r for n, r in routes.groupby("network")}


def endpoint_labels(feed, routes):
    """route_id -> "LOCALITY Stop ↔ LOCALITY Stop" from the termini of its variants (same name as the
    route_master of the routes command)."""
    trips = feed.trips[feed.trips["route_id"].isin(routes["route_id"])]
    trips = stop_sequences(trips, feed.stop_times(trips["trip_id"]))
    stops = feed.stops.set_index("stop_id")
    platform_suffix = re.compile(text()["platform_suffix"], re.IGNORECASE)
    spellings = {}  # same stop spelt differently ("Presqu'île" / "Presqu'Île"): first spelling

    def label(stop_id):
        if stop_id in stops.index:
            s = stops.loc[stop_id]
            name = line_label(stop_id, platform_suffix.sub("", clean_stop_name(s["stop_name"])), (s["lat"], s["lon"]))
        else:
            name = stop_id
        return spellings.setdefault(unaccent(name).casefold(), name)

    labels = {}
    for route_id, route_trips in trips.groupby("route_id"):
        counts = route_trips["stop_seq"].value_counts()
        variants = [seq for _, seq, _, _ in line_variants(route_trips)]
        main = [seq for seq in variants if counts[seq] >= MIN_VARIANT_SHARE * len(route_trips)] or variants[:1]
        main = sorted(main, key=lambda seq: -counts[seq])[:MAX_VARIANTS]
        if main:
            labels[route_id] = master_endpoints_label([(label(seq[0]), label(seq[-1])) for seq in main])
    return labels


def with_long_name(label, long_name):
    """Final comment from a GTFS route_long_name "A <> B via X": termini in the order A then B, "via X"
    appended; without computed termini, the route_long_name with "↔"."""
    long_name = clean_stop_name(long_name)
    if not label:
        return re.sub(r"\s*<>\s*", " ↔ ", long_name)
    m = re.fullmatch(r"(.+?)\s*<>\s*(.+?)(\s+via\s+.+)?", long_name, re.IGNORECASE)
    if not m:
        return label
    a, b, via = m.groups()
    sides = label.split(" ↔ ")
    norm = lambda x: re.sub(r"[\s'-]+", " ", unaccent(x).casefold())
    if len(sides) == 2:
        left, right = map(norm, sides)
        if (norm(a) in right and norm(a) not in left) or (norm(b) in left and norm(b) not in right):
            label = f"{sides[1]} ↔ {sides[0]}"
    return label + (via or "")


def is_csv_line(line):
    s = line.strip()
    return bool(s) and ";" in s and s[0] not in "=-#@+<"


def parse_fields(line):
    fields = next(csv.reader([line.strip()], delimiter=";", quotechar='"'))
    return fields + [""] * (MIN_FIELDS - len(fields))


def format_fields(fields):
    """Fields -> PTNA CSV line: comment always quoted (as on the wiki), the others only if they contain ;
    or "."""
    def q(i, v):
        if (i == COMMENT and v) or ";" in v or '"' in v:
            return '"' + v.replace('"', '""') + '"'
        return v
    return ";".join(q(i, v) for i, v in enumerate(fields))


def ref_key(route):
    """Natural sort of route numbers: 6 < 6A < 6B < 7 < 12 < 137 < 137A < 138 < NAV < T1."""
    num, rest = re.match(r"(\d*)(.*)", route["route_short_name"]).groups()
    return (0, int(num), rest) if num else (1, 0, rest)


def section_of(route, network):
    """(mode title, sub-section title or None) of a GTFS route, and its rank for sorting."""
    mode = ptna_type(route["route_type"])
    title = text()["modes"].get(mode, mode)
    rules = sections().get(network, [])
    rank = next((i for i, (_, rx) in enumerate(rules) if re.fullmatch(rx, route["route_short_name"], re.I)), len(rules))
    order = MODES.index(mode) if mode in MODES else len(MODES)
    return (title, rules[rank][0] if rank < len(rules) else None), (order, rank)


def render(routes, network, level=2):
    """CSV lines grouped: "== mode" then "=== sub-section" (titles of level level and level + 1)."""
    groups = {}
    for r in routes:
        (mode, sub), rank = section_of(r, network)
        groups.setdefault(rank, (mode, sub, []))[2].append(r)
    renamed = page_settings(network).get("modes", {})
    out, last_mode, subs = [], None, set()
    for rank in sorted(groups):
        mode, sub, rs = groups[rank]
        if mode != last_mode:
            if last_mode:
                out.append("-")
            out.append(f"{'=' * level} {renamed.get(mode, mode)}")
            last_mode = mode
            subs = {s for m, s, _ in groups.values() if m == mode}
        if subs != {None}:
            out.append(f"{'=' * (level + 1)} {sub or text()['other']}")
        out += [format_fields(gtfs_fields(r)) for r in sorted(rs, key=ref_key)]
    return out + ["-"] if out else out


def gtfs_fields(route):
    return [route["route_short_name"], ptna_type(route["route_type"]), route["label"], "", "", route["operator"],
            settings.feed, route["route_id"], ""]


def update(lines, routes, network, ref_gtfs, force_operator=False):
    """Updated lines of the file + report (list of messages)."""
    by_id = {r["route_id"]: r for _, r in routes.iterrows()}
    prefixes = {i.split(":")[0] for i in by_id}
    listed, out, report, positions = set(), [], [], {}
    parsed = [(line, parse_fields(line) if is_csv_line(line) else None) for line in lines]
    listed.update(f[ROUTE_ID] for _, f in parsed if f and f[ROUTE_ID] in by_id)

    for line, fields in parsed:
        if fields is None:
            out.append(line)
            continue
        rid = fields[ROUTE_ID]
        if not rid:
            candidates = [i for i, r in by_id.items() if r["route_short_name"] == fields[REF] and i not in listed]
            if len(candidates) != 1:
                out.append(line)
                continue
            rid = fields[ROUTE_ID] = candidates[0]
            listed.add(rid)
            report.append(f"{fields[REF]}: route_id added ({rid})")
        if rid not in by_id:
            if rid.split(":")[0] in prefixes:
                out.append("# " + line.strip())
                report.append(f"{fields[REF]}: {rid} not in the GTFS any more, line commented out")
            else:
                out.append(line)
            continue
        route = by_id[rid]
        positions[rid] = len(out)
        new = fields.copy()
        new[TYPE] = ptna_type(route["route_type"], fields[TYPE])
        new[COMMENT] = route["label"] or fields[COMMENT]
        new[OPERATOR] = route["operator"] if force_operator or not fields[OPERATOR] else fields[OPERATOR]
        if new[OPERATOR] != fields[OPERATOR]:
            report.append(f"{new[REF]}: operator '{fields[OPERATOR]}' -> '{new[OPERATOR]}'")
        new[FEED] = fields[FEED] or settings.feed
        if fields[REF] != route["route_short_name"]:
            if ref_gtfs or not fields[REF]:
                new[REF] = route["route_short_name"]
                report.append(f"{fields[REF] or '(empty)'} -> {new[REF]}: ref replaced ({rid})")
            else:
                report.append(f"{fields[REF]}: ref differs from the GTFS '{route['route_short_name']}' ({rid}), kept")
        if new[COMMENT] != fields[COMMENT]:
            report.append(f"{new[REF]}: '{fields[COMMENT]}' -> '{new[COMMENT]}'")
        if new[TYPE] != fields[TYPE]:
            report.append(f"{new[REF]}: type {fields[TYPE]} -> {new[TYPE]}")
        out.append(format_fields(new) if new != fields else line)

    # new routes: among the listed routes of the same sub-section (or of the same mode)
    placed = {}  # rank of the sub-section -> [(sort key, position in out)]
    for rid, pos in positions.items():
        placed.setdefault(section_of(by_id[rid], network)[1], []).append((ref_key(by_id[rid]), pos))
    inserts, unplaced = [], []
    for r in (r for i, r in by_id.items() if i not in listed):
        (mode, sub), rank = section_of(r, network)
        same = sorted(placed.get(rank, []))
        if not same:
            unplaced.append(r)
            continue
        before = [pos for k, pos in same if k < ref_key(r)]
        pos = max(before) + 1 if before else min(pos for _, pos in same)
        inserts.append((pos, ref_key(r), r))
        report.append(f"{r['route_short_name']}: new route ({r['route_id']}), section '{sub or mode}'")
    for pos, _, r in sorted(inserts, key=lambda t: (t[0], t[1]), reverse=True):
        out.insert(pos, format_fields(gtfs_fields(r)))
    if unplaced:
        section = [f"== {text()['new'].format(date=date.today())}"] + render(unplaced, network, 3)
        report += [f"{r['route_short_name']}: new route ({r['route_id']}), to sort out" for r in unplaced]
        end = next((i for i in range(len(out) - 1, -1, -1) if out[i].strip().lower() == "</pre>"), len(out))
        out[end:end] = section
    return out, report


def generate(title, network, routes):
    """Complete PTNA wiki page of the network."""
    t, page = text(), page_settings(network)
    ptna = page.get("ptna_id") or settings.ptna.get("id_prefix", "") + re.sub(r"[^A-Za-z0-9]", "", unaccent(title))
    intro = []
    if page.get("overview"):
        intro += [t["overview_link"].format(link=page["overview"]), "-"]
    if page.get("page"):
        intro += [t["page_link"].format(link=page["page"]), "-"]
    intro += [t["config_link"].format(ptna=ptna), "-"]
    out = [t["csv_intro"], "", "<pre>", "#", t["tool"], "#", "",
           t["overview"].format(title=page.get("title") or t["default_title"].format(network=title)), "",
           *intro, "", ""]
    out += render([r for _, r in routes.iterrows()], network)
    categories = page.get("categories", settings.ptna.get("categories", ["PTNA"]))
    out += ["", "</pre>", "", "".join(f"[[Category:{c}]]" for c in categories)]
    return out, [f"{len(routes)} routes generated"]


def build(feed, network, input_lines=None, title=None, operator=None, ref_gtfs=False):
    """(lines, report) of the PTNA list of network: input_lines updated, or a new page if None."""
    routes = load_networks(feed)[network]
    if operator:
        routes = routes.assign(operator=operator)
    labels = endpoint_labels(feed, routes)
    routes = routes.assign(label=[with_long_name(labels.get(i), n)
                                  for i, n in zip(routes["route_id"], routes["route_long_name"])])
    if input_lines is not None:
        return update(input_lines, routes, network, ref_gtfs, force_operator=bool(operator))
    return generate(title or network, network, routes)
