"""Local Valhalla server in Docker: started on demand, tiles rebuilt when the OSM extract changes.

The extract is copied into settings.valhalla.data_dir, mounted as /custom_files in the container. A
SHA-256 stamp of the extract tells whether the tiles are up to date; the local configuration files in that
directory are kept across rebuilds.
"""

from __future__ import annotations

import hashlib
import logging
import shutil
import subprocess
import time
from pathlib import Path

import requests

from .config import settings

log = logging.getLogger(__name__)

STAMP = ".pbf_sha256"
LEGACY_STAMPS = (".nomad_pbf_sha256",)
GENERATED = ("admin_data", "valhalla_tiles", "valhalla_tiles.tar", "duplicateways.txt", "file_hashes.txt")


def _docker(args, check=True):
    try:
        return subprocess.run(["docker", *args], check=check, capture_output=True, text=True)
    except FileNotFoundError as e:
        raise RuntimeError("Docker not found: install Docker to run Valhalla.") from e
    except subprocess.CalledProcessError as e:
        raise RuntimeError(e.stderr.strip() or f"docker {' '.join(args)} failed.") from e


def file_digest(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as f:
        while chunk := f.read(4 * 1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def container_state():
    """True if the container runs, False if it is stopped, None if it does not exist."""
    res = _docker(["inspect", "--format", "{{.State.Running}}", settings.valhalla.container], check=False)
    return res.stdout.strip().lower() == "true" if res.returncode == 0 else None


def container_mount():
    """Host directory mounted as /custom_files in the container, None if unknown."""
    res = _docker(["inspect", "--format",
                   '{{range .Mounts}}{{if eq .Destination "/custom_files"}}{{.Source}}{{end}}{{end}}',
                   settings.valhalla.container], check=False)
    return Path(res.stdout.strip()) if res.returncode == 0 and res.stdout.strip() else None


def _data_dir():
    return Path(settings.valhalla.data_dir).resolve()


def remove_tiles():
    """Delete the generated tiles (as root inside a container: they belong to the container's user)."""
    _docker(["run", "--rm", "--user", "0:0", "--entrypoint", "/bin/rm", "-v", f"{_data_dir()}:/custom_files",
             settings.valhalla.image, "-rf", *(f"/custom_files/{g}" for g in GENERATED)])


def create_container():
    v = settings.valhalla
    _docker(["run", "-d", "--name", v.container, "--restart", "unless-stopped", "-p", "8002:8002",
             "-v", f"{_data_dir()}:/custom_files", "-e", "serve_tiles=True", "-e", "build_admins=True",
             "-e", f"server_threads={v.threads}", v.image])


def wait_until_ready():
    v = settings.valhalla
    deadline = time.monotonic() + v.wait_s
    while time.monotonic() < deadline:
        try:
            requests.get(f"{v.url}/status", timeout=5).raise_for_status()
            return
        except requests.RequestException:
            time.sleep(2)
    logs = _docker(["logs", "--tail", "50", v.container], check=False)
    raise RuntimeError(f"Valhalla not ready after {v.wait_s // 60} minutes.\n{logs.stdout or logs.stderr}")


def _stamp():
    stamp = _data_dir() / STAMP
    for legacy in LEGACY_STAMPS:
        old = _data_dir() / legacy
        if not stamp.exists() and old.exists():
            old.rename(stamp)
    return stamp


def ensure_running():
    """Start Valhalla, rebuilding its tiles first if the extract changed. Returns True if it changed."""
    pbf = Path(settings.pbf)
    if not pbf.is_file():
        raise RuntimeError(f"OSM extract not found: {pbf}")
    _data_dir().mkdir(parents=True, exist_ok=True)
    digest = file_digest(pbf)
    stamp = _stamp()
    changed = not stamp.exists() or stamp.read_text().strip() != digest
    state = container_state()

    if changed:
        shutil.copy2(pbf, _data_dir() / pbf.name)
        if state is not None:
            _docker(["rm", "-f", settings.valhalla.container])
        remove_tiles()
        log.info("OSM extract changed: rebuilding the Valhalla tiles (docker logs -f %s)...",
                 settings.valhalla.container)
        create_container()
    elif container_mount() not in (None, _data_dir()):  # project moved: same tiles, new mount
        log.info("Valhalla data directory moved: recreating the container (tiles kept)...")
        _docker(["rm", "-f", settings.valhalla.container])
        create_container()
    elif state is False:
        _docker(["start", settings.valhalla.container])
    elif state is None:
        create_container()

    _docker(["update", "--restart", "unless-stopped", settings.valhalla.container])
    wait_until_ready()
    if changed:
        stamp.write_text(f"{digest}\n")
    return changed
