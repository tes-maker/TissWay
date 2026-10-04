"""Valhalla server management (Docker mocked)."""
import pytest

from tissway import valhalla


@pytest.fixture
def setup(tmp_path, monkeypatch, default_settings):
    pbf = tmp_path / "extract.osm.pbf"
    pbf.write_bytes(b"pbf v1")
    default_settings.pbf = pbf
    default_settings.valhalla.data_dir = tmp_path / "valhalla_data"
    calls = []
    monkeypatch.setattr(valhalla, "_docker", lambda args, check=True: calls.append(args))
    monkeypatch.setattr(valhalla, "wait_until_ready", lambda: None)
    monkeypatch.setattr(valhalla, "container_mount", lambda: default_settings.valhalla.data_dir.resolve())
    return pbf, calls


def test_rebuilds_when_the_extract_changes(setup, monkeypatch, default_settings):
    pbf, calls = setup
    monkeypatch.setattr(valhalla, "container_state", lambda: True)
    assert valhalla.ensure_running()
    data = default_settings.valhalla.data_dir
    assert (data / pbf.name).read_bytes() == b"pbf v1"
    assert (data / valhalla.STAMP).read_text().strip() == valhalla.file_digest(pbf)
    assert ["rm", "-f", default_settings.valhalla.container] in calls
    assert any("--user" in a and a[a.index("--user") + 1] == "0:0" for a in calls)  # tiles removed as root
    assert any(a[:2] == ["run", "-d"] for a in calls)


def test_starts_the_stopped_container_when_unchanged(setup, monkeypatch, default_settings):
    pbf, calls = setup
    data = default_settings.valhalla.data_dir
    data.mkdir()
    (data / ".nomad_pbf_sha256").write_text(valhalla.file_digest(pbf))  # legacy stamp is migrated
    monkeypatch.setattr(valhalla, "container_state", lambda: False)
    assert not valhalla.ensure_running()
    assert ["start", default_settings.valhalla.container] in calls
    assert not any(a[:2] == ["run", "-d"] for a in calls)


def test_recreates_the_container_when_the_project_moved(setup, monkeypatch, default_settings, tmp_path):
    pbf, calls = setup
    data = default_settings.valhalla.data_dir
    data.mkdir()
    (data / valhalla.STAMP).write_text(valhalla.file_digest(pbf))
    monkeypatch.setattr(valhalla, "container_state", lambda: True)
    monkeypatch.setattr(valhalla, "container_mount", lambda: tmp_path / "old_place" / "valhalla_data")
    assert not valhalla.ensure_running()
    assert ["rm", "-f", default_settings.valhalla.container] in calls
    assert any(a[:2] == ["run", "-d"] for a in calls)
    assert not any("--user" in a for a in calls)  # tiles kept
