"""Settings: data paths, distance thresholds, networks and naming rules.

Every setting has a generic default that works with any GTFS feed. A TOML profile overrides them for a
given feed (see the annotated ``tissway.toml`` shipped with the project). The profile is looked up in
this order: ``--profile`` on the command line, ``$TISSWAY_PROFILE``, ``./tissway.toml``.

Modules read ``settings.<name>`` when they run (never copy a value at import time), so that loading a
profile, or monkeypatching a setting in a test, takes effect everywhere.

Distances are in metres. No other module hard-codes a threshold.
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field, fields
from pathlib import Path

if sys.version_info >= (3, 11):
    import tomllib
else:  # Python < 3.11: same API from the backport
    import tomli as tomllib

PROFILE_ENV = "TISSWAY_PROFILE"
DEFAULT_PROFILE = Path("tissway.toml")


@dataclass
class Thresholds:
    platform_m: float = 20  # GTFS stop -> existing OSM platform
    holder_m: float = 100  # GTFS stop -> OSM platform already carrying its stop_id (GTFS coordinates are rough)
    stop_position_m: float = 40  # GTFS stop -> travelled way (stop_position)
    # Projection of the GTFS stop on the travelled way -> existing stop_position that may be reused. Further
    # away, a new stop_position is created at the projection.
    stop_position_reuse_m: float = 30
    # Existing stop_position this close to the projection: always reused, even when it is closer to the stop
    # across the road (face-to-face stops share it; a second node a few metres away would only be noise).
    stop_position_shared_m: float = 10
    duplicate_stop_m: float = 5  # two GTFS stops this close are the same physical platform (aggregated feeds)
    opposite_stop_m: float = 30  # GTFS stop -> opposite stop, for stops without sibling information
    sibling_m: float = 100  # GTFS stop -> other platform of the same stop (parent_station, codes 12A / 12B)
    trace_m: float = 150_000  # Valhalla rejects traces longer than 200 km: longer shapes are matched in chunks
    trace_points: int = 10_000  # same for the number of shape points (Valhalla max_shape defaults to 16 000)
    # Share of a variant's stops that may lie further than stop_position_m from the map-matched shape before
    # the GTFS shape is considered wrong and the variant is re-routed through its stops.
    max_far_stops: float = 0.2


@dataclass
class Valhalla:
    url: str = "http://localhost:8002"
    container: str = "valhalla"
    image: str = "ghcr.io/nilsnolde/docker-valhalla/valhalla:latest"
    data_dir: Path = Path("valhalla_data")
    wait_s: int = 1800  # tile building can take a long time on a large extract
    threads: int = 8


@dataclass
class Settings:
    # --- input / output ---
    gtfs: Path = Path("gtfs")  # GTFS directory or .zip
    pbf: Path = Path("data.osm.pbf")  # OSM extract covering the feed
    extracts: list[str] = field(default_factory=list)  # URLs of .osm.pbf extracts downloaded and merged into pbf
    extracts_dir: Path = Path(".")
    output_dir: Path = Path("output_osm")
    stops_cache: Path = Path("osm_bus_stops.geojsonseq")  # OSM platforms extracted from pbf (regenerated with it)
    routes_cache: Path = Path("osm_routes.opl")  # OSM route relations extracted from pbf (regenerated with it)
    output_name: str = "gtfs"  # output file name when no network is selected

    # --- tagging ---
    feed: str = ""  # suffix of the gtfs:*:<feed> tags (PTNA feed id, e.g. "DE-BY-MVV"); empty: no suffix
    stop_ref_tags: list[str] = field(default_factory=list)  # extra platform tags holding the stop_id
    modes: list[str] = field(default_factory=lambda: ["bus", "coach", "trolleybus"])  # OSM route=* generated
    driving_side: str = "right"  # "left" in left-hand traffic countries: platforms are on the kerb side
    # agency_id (or agency_name) -> network tags, e.g. {"network": "MVV", "network:wikidata": "Q..."}. Other
    # agencies get {"network": <agency_name without its parenthesised part>}.
    networks: dict[str, dict[str, str]] = field(default_factory=dict)

    # --- existing relations (see existing.py) ---
    update_existing: bool = True  # update the existing OSM relations of a line instead of creating new ones
    existing_min_similarity: float = 0.4  # generated variant <-> existing relation, see existing.similarity

    # --- naming ---
    locality: str = "none"  # "none" or "insee" (French commune, see naming.locality)
    locality_api: str = "https://geo.api.gouv.fr/communes"
    fix_accents: bool = False  # restore French accents commonly dropped by GTFS producers

    thresholds: Thresholds = field(default_factory=Thresholds)
    valhalla: Valhalla = field(default_factory=Valhalla)
    ptna: dict = field(default_factory=dict)  # see ptna.py

    profile: Path | None = None  # profile file actually loaded


settings = Settings()

_PATHS = {"gtfs", "pbf", "extracts_dir", "output_dir", "stops_cache", "routes_cache"}


def _apply(target, values, base, section=""):
    known = {f.name: f for f in fields(target)}
    for key, value in values.items():
        if key not in known:
            raise ValueError(f"unknown setting '{section}{key}' in the profile")
        current = getattr(target, key)
        if isinstance(current, (Thresholds, Valhalla)):
            _apply(current, value, base, f"{section}{key}.")
        elif key in _PATHS or (isinstance(current, Path) and isinstance(value, str)):
            setattr(target, key, base / Path(value).expanduser())
        else:
            setattr(target, key, value)


def configure(path: str | os.PathLike | None = None) -> Settings:
    """Reset the settings to their defaults, then load a TOML profile over them (relative paths, defaults
    included, are resolved from the profile's directory). Without path: $TISSWAY_PROFILE, then
    ./tissway.toml if it exists, else defaults only."""
    if path is None:
        path = os.environ.get(PROFILE_ENV) or (DEFAULT_PROFILE if DEFAULT_PROFILE.is_file() else None)
    fresh = Settings()
    if path is not None:
        path = Path(path)
        base = path.resolve().parent
        with path.open("rb") as f:
            _apply(fresh, tomllib.load(f), base)
        for name in _PATHS:  # defaults too are relative to the profile
            setattr(fresh, name, base / getattr(fresh, name))
        fresh.valhalla.data_dir = base / fresh.valhalla.data_dir
        fresh.profile = path
    return _install(fresh)


def reset() -> Settings:
    """Back to the defaults, without any profile (tests)."""
    return _install(Settings())


def _install(values):
    for f in fields(Settings):
        setattr(settings, f.name, getattr(values, f.name))
    return settings
