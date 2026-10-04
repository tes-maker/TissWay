"""Command line: python -m tissway [--profile FILE] <command> ...

Commands:
  routes      PTv2 route relations of the GTFS routes -> <output_dir>/<network>[_<refs>].osm
  platforms   complete the OSM platforms of a network with its GTFS stops (no relations)
  add-via     add "via …" to route relations sharing a name in a .osm file
  ptna        update or generate the PTNA route list of a network
  extracts    download and merge the OSM extracts of the profile
  valhalla    start the Valhalla server (rebuilding its tiles if the extract changed)
"""

from __future__ import annotations

import argparse
import logging
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

from . import __version__
from .config import configure, settings

log = logging.getLogger("tissway")


class _Formatter(logging.Formatter):
    def format(self, record):
        msg = super().format(record)
        if record.levelno < logging.WARNING:
            return msg
        text = msg.lstrip()
        return f"{msg[:len(msg) - len(text)]}{record.levelname.lower()}: {text}"  # indentation kept


def _setup_logging(verbose):
    handler = logging.StreamHandler()
    handler.setFormatter(_Formatter("%(message)s"))
    logging.basicConfig(level=logging.DEBUG if verbose else logging.INFO, handlers=[handler], force=True)
    for noisy in ("urllib3", "numexpr", "fiona", "pyogrio"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def _refs(values):
    """"301,305 310" -> ["301", "305", "310"], deduplicated, in the given order."""
    return list(dict.fromkeys(r.strip() for x in values for r in x.split(",") if r.strip()))


# --- commands --------------------------------------------------------------------------------------------

def cmd_routes(args):
    from . import extracts, valhalla
    from .pipeline import run

    if not args.no_prepare:
        if not args.no_download:
            extracts.update(offline=False)
        valhalla.ensure_running()
    if args.new_relations:
        settings.update_existing = False
    path = run(args.network, _refs(args.refs + args.line))
    print(f"-> {path}")


def cmd_platforms(args):
    from .platform_tags import run

    out, unmatched = run(args.network, args.feed, args.max_distance)
    print(f"-> {out}\n-> {unmatched}")


def cmd_add_via(args):
    from .via import add_vias

    tree = ET.parse(args.osm)
    changes, warnings = add_vias(tree.getroot(), args.prefix)
    for old, new in sorted(changes, key=lambda c: c[1]):
        print(f"{old}\n  -> {new}")
    for w in warnings:
        log.warning(w)
    path = args.osm if args.in_place else args.output or args.osm.with_name(f"{args.osm.stem}_renamed.osm")
    tree.write(path, encoding="UTF-8", xml_declaration=True)
    print(f"{len(changes)} relation(s) renamed -> {path}")


def _ask(question, default):
    try:
        return input(f"{question} [{default}]: ").strip() or default
    except EOFError:
        return default


def _choose_network(networks):
    names = sorted(networks, key=str.lower)
    for i, n in enumerate(names, 1):
        print(f"{i:3}. {n} ({len(networks[n])} routes)", file=sys.stderr)
    while True:
        try:
            answer = input("Network (number or name): ").strip()
        except EOFError:
            sys.exit("No network chosen.")
        if answer.isdigit() and 1 <= int(answer) <= len(names):
            return names[int(answer) - 1]
        match = [n for n in names if n.lower() == answer.lower()]
        if match:
            return match[0]
        print(f"Unknown network: {answer!r}", file=sys.stderr)


def cmd_ptna(args):
    from .gtfs import Feed
    from .naming import slug
    from .ptna import build, load_networks

    feed = Feed()
    networks = load_networks(feed)
    if args.network:
        match = [n for n in networks if n.lower() == args.network.lower()]
        if not match:
            sys.exit(f"Unknown network {args.network!r}. Available: {', '.join(sorted(networks, key=str.lower))}")
        network = match[0]
    else:
        network = _choose_network(networks)
        args.title = args.title or _ask("Network name in the page title", network)
        operators = " / ".join(sorted(set(networks[network]["operator"])))
        args.operator = args.operator or _ask("Operator (Enter: keep each route's)", operators)
        if args.operator == operators:
            args.operator = None
    lines = args.input.read_text(encoding="utf-8").splitlines() if args.input else None
    out, report = build(feed, network, lines, args.title, args.operator, args.ref_gtfs)
    path = args.output or settings.output_dir / f"ptna_{slug(args.title or network)}.txt"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(out) + "\n", encoding="utf-8")
    print(f"Network {network}: {len(networks[network])} routes in the GTFS", file=sys.stderr)
    print("\n".join("  " + m for m in report) or "  no change", file=sys.stderr)
    print(f"-> {path}", file=sys.stderr)


def cmd_extracts(args):
    from .extracts import update

    if not update(args.force, args.no_download):
        sys.exit("No extract configured (set 'extracts' in the profile).")


def cmd_valhalla(args):
    from .valhalla import ensure_running

    ensure_running()
    print(f"Valhalla ready on {settings.valhalla.url}")


# --- parser ----------------------------------------------------------------------------------------------

def parser():
    p = argparse.ArgumentParser(prog="tissway", description="GTFS to OpenStreetMap public transport (PTv2).")
    p.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    p.add_argument("-p", "--profile", type=Path, help="TOML profile (default: $TISSWAY_PROFILE, ./tissway.toml)")
    p.add_argument("-v", "--verbose", action="store_true")
    sub = p.add_subparsers(dest="command", required=True, metavar="COMMAND")

    r = sub.add_parser("routes", help="generate the PTv2 relations of GTFS routes")
    r.add_argument("refs", nargs="*", help="route numbers (route_short_name or route_id; default: all)")
    r.add_argument("-l", "--line", nargs="+", default=[], help="route numbers, separated by spaces or commas")
    r.add_argument("-n", "--network", help="only the routes of this network (value of the network tag)")
    r.add_argument("--no-prepare", action="store_true", help="neither refresh the extract nor manage Valhalla")
    r.add_argument("--no-download", action="store_true", help="do not refresh the extract (Valhalla still managed)")
    r.add_argument("--new-relations", action="store_true",
                   help="always create new relations, even when the line already exists in OSM")
    r.set_defaults(func=cmd_routes)

    pl = sub.add_parser("platforms", help="complete the OSM platforms of a network with its GTFS stops")
    pl.add_argument("-n", "--network", required=True)
    pl.add_argument("--feed", help="suffix of the gtfs:*:<feed> tags (default: feed of the profile)")
    pl.add_argument("--max-distance", type=float, default=30, help="GTFS stop -> OSM platform (m, default 30)")
    pl.set_defaults(func=cmd_platforms)

    v = sub.add_parser("add-via", help="add 'via …' to route relations sharing a name")
    v.add_argument("osm", type=Path, help=".osm file")
    out = v.add_mutually_exclusive_group()
    out.add_argument("-o", "--output", type=Path, help="output file (default: <file>_renamed.osm)")
    out.add_argument("--in-place", action="store_true", help="rewrite the input file")
    v.add_argument("--prefix", default="", help="only names starting with this (e.g. 'Bus 117:')")
    v.set_defaults(func=cmd_add_via)

    t = sub.add_parser("ptna", help="update or generate the PTNA route list of a network")
    t.add_argument("input", nargs="?", type=Path, help="current PTNA list (wiki text); none: generate it")
    t.add_argument("-n", "--network", help="network (case-insensitive); none: interactive menu")
    t.add_argument("-o", "--output", type=Path, help="output file (default: <output_dir>/ptna_<network>.txt)")
    t.add_argument("--title", help="network name in the title of a generated page and the output file name")
    t.add_argument("--operator", help="operator (6th field) of every route of the network, existing ones included")
    t.add_argument("--ref-gtfs", action="store_true", help="replace the refs by the GTFS route_short_name")
    t.set_defaults(func=cmd_ptna)

    e = sub.add_parser("extracts", help="download and merge the OSM extracts of the profile")
    e.add_argument("--force", action="store_true", help="download again even if today's file exists")
    e.add_argument("--no-download", action="store_true", help="merge the most recent extracts already present")
    e.set_defaults(func=cmd_extracts)

    vh = sub.add_parser("valhalla", help="start Valhalla (rebuilding the tiles if the extract changed)")
    vh.set_defaults(func=cmd_valhalla)
    return p


def main(argv=None):
    args = parser().parse_args(argv)
    _setup_logging(args.verbose)
    try:
        configure(args.profile)
        args.func(args)
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception as e:  # noqa: BLE001 - user-facing tool: one line, details with --verbose
        if args.verbose:
            raise
        sys.exit(f"error: {e}")
