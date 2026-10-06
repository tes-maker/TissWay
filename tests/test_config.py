"""TOML profiles."""
import pytest

from tissway import config


def test_profile_overrides_defaults_and_resolves_paths(tmp_path):
    profile = tmp_path / "p.toml"
    profile.write_text('gtfs = "feed.zip"\nfeed = "DE-X"\n[thresholds]\nstop_position_m = 25\n'
                       '[valhalla]\ncontainer = "v"\n[networks."A1"]\nnetwork = "N"\n')
    s = config.configure(profile)
    assert s.gtfs == tmp_path / "feed.zip" and s.output_dir == tmp_path / "output_osm"
    assert s.valhalla.data_dir == tmp_path / "valhalla_data" and s.valhalla.container == "v"
    assert s.thresholds.stop_position_m == 25 and s.thresholds.platform_m == 30
    assert s.feed == "DE-X" and s.networks == {"A1": {"network": "N"}}


def test_unknown_setting_is_an_error(tmp_path):
    profile = tmp_path / "p.toml"
    profile.write_text("[thresholds]\nstop_positon_m = 25\n")
    with pytest.raises(ValueError, match="thresholds.stop_positon_m"):
        config.configure(profile)


def test_configure_resets_previous_profile(tmp_path, monkeypatch):
    profile = tmp_path / "p.toml"
    profile.write_text('feed = "X"\n')
    config.configure(profile)
    monkeypatch.chdir(tmp_path)  # no tissway.toml here
    monkeypatch.delenv(config.PROFILE_ENV, raising=False)
    assert config.configure().feed == ""
