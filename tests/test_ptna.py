"""PTNA route lists."""
import pandas as pd

from tissway import ptna


def routes(*rows):
    df = pd.DataFrame(rows, columns=["route_id", "route_short_name", "route_type", "operator", "label"])
    return df


def test_fields_round_trip():
    line = '12;bus;"A ↔ B";;;Op;FEED;R12;'
    assert ptna.format_fields(ptna.parse_fields(line)) == line


def test_with_long_name_orders_the_termini_and_keeps_via():
    assert ptna.with_long_name("CAEN Gare ↔ FALAISE Mairie", "Falaise <> Caen via Bretteville") == \
        "FALAISE Mairie ↔ CAEN Gare via Bretteville"
    assert ptna.with_long_name(None, "A <> B") == "A ↔ B"


def test_ref_key_natural_order():
    refs = ["T1", "12", "6B", "137A", "6", "NAV", "7", "137"]
    assert sorted(refs, key=lambda r: ptna.ref_key({"route_short_name": r})) == \
        ["6", "6B", "7", "12", "137", "137A", "NAV", "T1"]


def test_update(default_settings):
    default_settings.feed = "FEED"
    lines = ["== Lignes de bus", "1;bus;\"old\";;;Op;FEED;X:1;", "9;bus;;;;Op;FEED;X:9;", "</pre>"]
    rs = routes(("X:1", "1", "3", "Op", "A ↔ B"), ("X:2", "2", "3", "Op", "C ↔ D"))
    out, report = ptna.update(lines, rs, "Net", ref_gtfs=False)
    assert out == ["== Lignes de bus", '1;bus;"A ↔ B";;;Op;FEED;X:1;', '2;bus;"C ↔ D";;;Op;FEED;X:2;',
                   "# 9;bus;;;;Op;FEED;X:9;", "</pre>"]
    assert any("X:9" in r for r in report)


def test_generate_in_english(default_settings):
    default_settings.ptna = {"id_prefix": "DE-", "categories": ["PTNA"]}
    out, _ = ptna.generate("VBN", "VBN", routes(("X:1", "1", "3", "Op", "A ↔ B")))
    assert "= Overview of the VBN network" in out and "== Bus lines" in out
    assert "- Configuration file of [/en/config.php?network=DE-VBN PTNA]" in out


def test_profile_replaces_the_texts(default_settings):
    default_settings.ptna = {"text": {"overview": "= Aperçu du {title}", "modes": {"bus": "Lignes de bus"}}}
    out, _ = ptna.generate("Nomad", "Nomad", routes(("X:1", "1", "3", "Op", "A ↔ B")))
    assert "= Aperçu du Nomad network" in out and "== Lignes de bus" in out
