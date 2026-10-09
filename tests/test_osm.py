"""Reading the extract: osmium calls split by blocks of ids (osmium mocked)."""
from tissway import osm


def test_id_batches_limit_the_blocks_per_call(default_settings):
    default_settings.osmium_id_blocks = 2
    block = 1 << osm.ID_BLOCK_BITS
    ids = ["n1", "n2", f"n{block}", f"n{3 * block}", "w1", f"w{5 * block}"]
    batches = osm.id_batches(ids)
    assert sorted(i for b in batches for i in b) == sorted(ids)
    assert batches == [["n1", "n2", f"n{block}"], [f"n{3 * block}", "w1"], [f"w{5 * block}"]]
    assert osm.id_batches([]) == []


def test_read_ways_reads_the_nodes_afterwards(monkeypatch):
    extract = {"w1": {"version": "1", "tags": {}, "nodes": ["n1", "n2"]},
               "n1": {"version": "1", "tags": {}, "lat": 0.0, "lon": 0.0},
               "n2": {"version": "1", "tags": {}, "lat": 0.0, "lon": 1.0},
               "n9": {"version": "1", "tags": {}, "lat": 1.0, "lon": 1.0}}
    calls = []

    def read_osm(command, ids):
        calls.append((command, set(ids)))
        return {i: extract[i] for i in ids if i in extract}

    monkeypatch.setattr(osm, "read_osm", read_osm)
    assert set(osm.read_ways({"w1", "n9"})) == {"w1", "n1", "n2", "n9"}
    assert calls == [(["getid"], {"w1", "n9"}), (["getid"], {"n1", "n2"})]
