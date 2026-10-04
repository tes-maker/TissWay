"""Download of the OSM extracts listed in settings.extracts and merge into settings.pbf.

Each extract is saved as <name>-<YYMMDD>.osm.pbf in settings.extracts_dir, <name> being the file name of
its URL without "-latest.osm.pbf". An extract already downloaded today is reused unless forced; offline,
the most recent extract already downloaded is merged.
"""

from __future__ import annotations

import filecmp
import logging
import shutil
import subprocess
import urllib.request
from datetime import date
from pathlib import Path
from urllib.parse import urlparse

from .config import settings

log = logging.getLogger(__name__)

USER_AGENT = "TissWay (+https://wiki.openstreetmap.org/wiki/Public_transport)"


def extract_name(url):
    name = Path(urlparse(url).path).name
    for suffix in ("-latest.osm.pbf", ".osm.pbf", ".pbf"):
        if name.endswith(suffix):
            return name[:-len(suffix)]
    return name


def download(url, path):
    """Download url to path (through a .part file: no truncated extract if interrupted)."""
    tmp = path.with_name(path.name + ".part")
    log.info("Downloading %s...", url)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as res, open(tmp, "wb") as f:
        total, done = int(res.headers.get("Content-Length", 0)), 0
        while chunk := res.read(1 << 20):
            f.write(chunk)
            done += len(chunk)
            if total:
                print(f"\r  {done / 1e6:.0f} / {total / 1e6:.0f} MB", end="", flush=True)
    if total:
        print()
    tmp.replace(path)


def fetch(urls, force=False, offline=False):
    """Paths of today's extracts, downloaded if needed (offline: the most recent ones already present)."""
    folder = Path(settings.extracts_dir)
    folder.mkdir(parents=True, exist_ok=True)
    stamp = date.today().strftime("%y%m%d")
    paths = []
    for url in urls:
        name = extract_name(url)
        path = folder / f"{name}-{stamp}.osm.pbf"
        if offline:
            local = sorted(folder.glob(f"{name}-[0-9][0-9][0-9][0-9][0-9][0-9].osm.pbf"))
            if not local:
                raise RuntimeError(f"no extract {name}-<YYMMDD>.osm.pbf in {folder}")
            path = local[-1]
        elif force or not path.is_file():
            download(url, path)
        else:
            log.info("%s already downloaded today", path)
        paths.append(path)
    return paths


def merge(inputs, output):
    """Merge PBF files with osmium (objects duplicated along the borders are deduplicated)."""
    if len(inputs) == 1:
        shutil.copyfile(inputs[0], output)
        return
    log.info("Merging %s -> %s...", ", ".join(map(str, inputs)), output)
    subprocess.run(["osmium", "merge", *map(str, inputs), "-o", str(output), "--overwrite"], check=True)


def update(force=False, offline=False):
    """Refresh settings.pbf from settings.extracts. Returns False when no extract is configured."""
    if not settings.extracts:
        return False
    if shutil.which("osmium") is None:  # before downloading hundreds of MB for nothing
        raise RuntimeError("osmium-tool not found (e.g. sudo apt install osmium-tool).")
    pbf = Path(settings.pbf)
    tmp = pbf.with_name(f".{pbf.name.removesuffix('.osm.pbf')}.tmp.osm.pbf")  # osmium needs the extension
    merge(fetch(settings.extracts, force, offline), tmp)
    if pbf.is_file() and filecmp.cmp(tmp, pbf, shallow=False):
        tmp.unlink()  # unchanged: keep the old file and its mtime (OSM stops cache still valid)
    else:
        tmp.replace(pbf)
    log.info("OSM extract: %s (%.1f MB)", settings.pbf, Path(settings.pbf).stat().st_size / 1e6)
    return True
