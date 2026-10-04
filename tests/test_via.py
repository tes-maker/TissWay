"""'via …' added to route relations sharing a name."""
import xml.etree.ElementTree as ET

from tissway.via import add_vias, choose_vias

OSM = """<osm>
  <node id="1"><tag k="name" v="A"/></node><node id="2"><tag k="name" v="B"/></node>
  <node id="3"><tag k="name" v="C"/></node><node id="4"><tag k="name" v="D"/></node>
  <relation id="10"><member type="node" ref="1" role="platform"/><member type="node" ref="2" role="platform"/>
    <member type="node" ref="4" role="platform"/><tag k="type" v="route"/><tag k="name" v="Bus 1: A → D"/></relation>
  <relation id="11"><member type="node" ref="1" role="platform"/><member type="node" ref="3" role="platform"/>
    <member type="node" ref="4" role="platform"/><tag k="type" v="route"/><tag k="name" v="Bus 1: A → D"/></relation>
  <relation id="12"><member type="node" ref="1" role="platform"/><member type="node" ref="4" role="platform"/>
    <tag k="type" v="route"/><tag k="name" v="Bus 1: A → D"/></relation>
</osm>"""


def test_choose_vias():
    a, b, c = [(None, x) for x in "abc"]
    vias = choose_vias([[a, b, c], [a, c]])
    assert vias == [[b], []]  # the shorter relation keeps its name


def test_add_vias():
    root = ET.fromstring(OSM)
    changes, warnings = add_vias(root)
    names = {r.get("id"): {t.get("k"): t.get("v") for t in r.findall("tag")}["name"] for r in root.iter("relation")}
    assert names == {"10": "Bus 1: A → D via B", "11": "Bus 1: A → D via C", "12": "Bus 1: A → D"}
    assert len(changes) == 2 and not warnings
    assert add_vias(root)[0] == []  # idempotent
