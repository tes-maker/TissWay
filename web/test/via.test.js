// 'via …' added to route relations sharing a name.
import assert from "node:assert/strict";
import { test } from "node:test";
import "./helpers.js";
import { lookup } from "../src/lookup.js";
import { parseXml } from "../src/osm.js";
import { addVias, chooseVias, renameInFile } from "../src/via.js";

const OSM = `<osm>
  <node id="1"><tag k="name" v="A"/></node><node id="2"><tag k="name" v="B"/></node>
  <node id="3"><tag k="name" v="C"/></node><node id="4"><tag k="name" v="D"/></node>
  <relation id="10"><member type="node" ref="1" role="platform"/><member type="node" ref="2" role="platform"/>
    <member type="node" ref="4" role="platform"/><tag k="type" v="route"/><tag k="name" v="Bus 1: A → D"/></relation>
  <relation id="11"><member type="node" ref="1" role="platform"/><member type="node" ref="3" role="platform"/>
    <member type="node" ref="4" role="platform"/><tag k="type" v="route"/><tag k="name" v="Bus 1: A → D"/></relation>
  <relation id="12"><member type="node" ref="1" role="platform"/><member type="node" ref="4" role="platform"/>
    <tag k="type" v="route"/><tag k="name" v="Bus 1: A → D"/></relation>
</osm>`;

test("chooseVias", () => assert.deepEqual(chooseVias([["a", "b", "c"], ["a", "c"]]), [["b"], []])); // the shorter relation keeps its name

test("addVias", async () => {
  const root = parseXml(OSM);
  const { changes, warnings } = await addVias(root);
  const names = Object.fromEntries(root.children.filter((e) => e.name === "relation").map((r) => [r.attrs.id, r.children.find((c) => c.attrs.k === "name").attrs.v]));
  assert.deepEqual(names, { 10: "Bus 1: A → B → D", 11: "Bus 1: A → C → D", 12: "Bus 1: A → D" });
  assert.equal(changes.length, 2);
  assert.deepEqual(warnings, []);
  assert.deepEqual((await addVias(root)).changes, []); // idempotent
  const via = (id) => root.children.find((e) => e.attrs.id === id).children.find((c) => c.attrs.k === "via")?.attrs.v;
  assert.deepEqual([via("10"), via("11"), via("12")], ["B", "C", undefined]);
});

test("the whole file survives a round trip", async () => {
  const { xml } = await renameInFile(OSM);
  assert.equal(parseXml(xml).children.length, 7);
  assert.ok(xml.includes('v="Bus 1: A → B → D"') && xml.includes('action="modify"'));
});

test("the vias of a title are VILLE Arret too: its official_name, else the town of its position; the via tag stays the name", async () => {
  const stop = (id, name, lat, extra = "") => `<node id="${id}" lat="${lat}" lon="1"><tag k="name" v="${name}"/>${extra}</node>`;
  const route = (id, ...stops) => `<relation id="${id}">${stops.map((s) => `<member type="node" ref="${s}" role="platform"/>`).join("")}<tag k="type" v="route"/><tag k="name" v="Bus 1: CAEN A → VIRE D"/></relation>`;
  const xml = `<osm>${stop(1, "A", 49)}${stop(2, "Mairie", 49.1)}${stop(3, "Brouay Gare", 49.2, '<tag k="official_name" v="THUE ET MUE - Brouay Gare"/>')}${stop(4, "D", 49.3)}${route(10, 1, 2, 4)}${route(11, 1, 3, 4)}</osm>`;
  const real = lookup.placesAt;
  lookup.placesAt = async () => ["Fleury-sur-Orne"];
  try {
    const { changes, xml: out } = await renameInFile(xml, "");
    assert.deepEqual(changes.map(([, name]) => name).sort(), ["Bus 1: CAEN A → FLEURY-SUR-ORNE Mairie → VIRE D", "Bus 1: CAEN A → THUE ET MUE Brouay Gare → VIRE D"]);
    assert.ok(out.includes('k="via" v="Mairie"') && out.includes('k="via" v="Brouay Gare"'));
  } finally {
    lookup.placesAt = real;
  }
});

