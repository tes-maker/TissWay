"""Download of the OSM extracts listed in settings.extracts and merge into settings.pbf.

Each extract is saved as <name>-<YYMMDD>.osm.pbf in settings.extracts_dir, <name> being the file name of
its URL without "-latest.osm.pbf". An extract already downloaded today is reused unless forced; offline,
or when a download fails, the most recent extract already downloaded is merged.
"""

from __future__ import annotations

import filecmp
import http.client
import logging
import shutil
import subprocess
import time
import urllib.error
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


def download(url, path, attempts=4):
    """Download url to path (through a .part file: no truncated extract if interrupted).

    Timeouts and connection errors are retried, resuming the .part file when the server accepts ranges.
    """
    tmp = path.with_name(path.name + ".part")
    tmp.unlink(missing_ok=True)  # a .part left by another run may come from an older "-latest" file
    log.info("Downloading %s...", url)
    for attempt in range(1, attempts + 1):
        done = tmp.stat().st_size if tmp.exists() else 0
        headers = {"User-Agent": USER_AGENT}
        if done:
            headers["Range"] = f"bytes={done}-"
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=60) as res:
                if done and res.status != 206:  # range ignored: start over
                    done = 0
                total = done + int(res.headers.get("Content-Length", 0))
                with open(tmp, "ab" if done else "wb") as f:
                    while chunk := res.read(1 << 20):
                        f.write(chunk)
                        done += len(chunk)
                        if total:
                            print(f"\r  {done / 1e6:.0f} / {total / 1e6:.0f} MB", end="", flush=True)
            if total:
                print()
            break
        except (OSError, http.client.HTTPException) as e:  # URLError, timeouts, IncompleteRead...
            if isinstance(e, urllib.error.HTTPError) and e.code < 500 or attempt == attempts:
                raise
            if done:
                print()
            log.warning("%s (attempt %d/%d), retrying in %ds...", e, attempt, attempts, 10 * attempt)
            time.sleep(10 * attempt)
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
        local = sorted(folder.glob(f"{name}-[0-9][0-9][0-9][0-9][0-9][0-9].osm.pbf"))
        if offline:
            if not local:
                raise RuntimeError(f"no extract {name}-<YYMMDD>.osm.pbf in {folder}")
            path = local[-1]
        elif force or not path.is_file():
            try:
                download(url, path)
            except (OSError, http.client.HTTPException) as e:
                if not local:
                    raise
                path = local[-1]
                log.warning("download of %s failed (%s): using %s", url, e, path)
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
