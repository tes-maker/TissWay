// Overpass answers -> objects, and the .osm file.
import assert from "node:assert/strict";
import { test } from "node:test";
import "./helpers.js";
import { Store, fromOverpass, parseXml, writeOsm } from "../src/osm.js";
import { nearestPairs, feedTags } from "../src/platform_tags.js";
import { configure } from "../src/settings.js";

test("fromOverpass", () => {
  const out = fromOverpass([
    { type: "node", id: 1, version: 3, lat: 49, lon: 1, tags: { a: "b" } },
    { type: "way", id: 2, version: 1, nodes: [1, 5], center: { lat: 49, lon: 1 } },
    { type: "relation", id: 3, version: 2, members: [{ type: "way", ref: 2, role: "" }, { type: "node", ref: 1, role: "stop" }], tags: {} },
  ]);
  assert.deepEqual(out.n1, { version: "3", tags: { a: "b" }, lat: 49, lon: 1 });
  assert.deepEqual(out.w2, { version: "1", tags: {}, nodes: ["n1", "n5"], center: [49, 1] });
  assert.deepEqual(out.r3.members, [["w2", ""], ["n1", "stop"]]);
});

test("writeOsm: modified objects, the nodes of their ways, escaped tags, parsed back", () => {
  const obj = new Store({
    n1: { version: "1", lat: 49, lon: 1, tags: {} }, n2: { version: "4", lat: 49.1, lon: 1.1, tags: { x: "1" } }, n9: { version: "1", lat: 0, lon: 0, tags: {} },
    w1: { version: "2", tags: {}, nodes: ["n1", "n2"] },
  });
  obj.edit("w1").tags.name = `Rue "A" & <B>`;
  obj.set("n-1", { lat: 49.05, lon: 1.05, tags: { name: "é" } });
  obj.set("r-2", { members: [["w1", ""], ["n-1", "stop"]], tags: { type: "route" } });
  const root = parseXml(writeOsm(obj));
  const ids = root.children.map((e) => `${e.name}${e.attrs.id}`);
  assert.deepEqual(ids, ["node-1", "node1", "node2", "way1", "relation-2"]); // not n9
  const way = root.children.find((e) => e.name === "way");
  assert.equal(way.attrs.action, "modify");
  assert.equal(way.attrs.version, "2");
  assert.equal(way.children.find((c) => c.name === "tag").attrs.v, `Rue "A" & <B>`);
  assert.equal(root.children[1].attrs.action, undefined); // node of a modified way, itself unchanged
  assert.equal(root.children[0].attrs.version, undefined); // new object
});

test("writeOsm compacts shared platform network tags, keeps the stop id of the first network and no secondary stop code", () => {
  const tags = {
    alt_name: "Péricentre", bench: "yes", bin: "yes", bus: "yes", departures_board: "timetable",
    "gtfs:stop_code:FR-NOR-Atoumod:Nomad": "14CAE27A",
    "gtfs:stop_id:FR-NOR-Atoumod": "FR:14118:ZE:peric01:ATOUMOD029;FR:14118:ZE:1151885:ATOUMOD040",
    highway: "bus_stop", lit: "yes", name: "Péricentre", network: "Twisto", "network:2": "Nomad",
    "network:wikidata": "Q3537947", "network:wikidata:Nomad": "Q98131290",
    "network:wikipedia": "fr:Transports en commun de Caen",
    "network:wikipedia:Nomad": "fr:Nomad (réseau)",
    operator: "RATP Dev Caen la mer", public_transport: "platform", ref: "peric01",
    "ref:FR:Atoumod": "FR:14118:ZE:peric01:ATOUMOD029",
    "ref:FR:Atoumod:Nomad": "FR:14118:ZE:1151885:ATOUMOD040",
    "ref:Nomad": "14CAE27A", shelter: "no", tactile_paving: "no", wheelchair: "no",
  };
  const obj = new Store({ n1: { version: "1", lat: 49, lon: 1, tags } });
  obj.edit("n1");
  const originalTags = structuredClone(tags);
  const root = parseXml(writeOsm(obj));
  const output = Object.fromEntries(root.children[0].children.map((tag) => [tag.attrs.k, tag.attrs.v]));

  assert.deepEqual(output, {
    alt_name: "Péricentre", bench: "yes", bin: "yes", bus: "yes", departures_board: "timetable",
    "gtfs:stop_id": "FR:14118:ZE:peric01:ATOUMOD029",
    highway: "bus_stop", lit: "yes", name: "Péricentre", network: "Twisto;Nomad",
    "network:wikidata": "Q3537947;Q98131290",
    "network:wikipedia": "fr:Transports en commun de Caen;fr:Nomad (réseau)",
    operator: "RATP Dev Caen la mer", public_transport: "platform", ref: "peric01",
    "ref:FR:Atoumod": "FR:14118:ZE:peric01:ATOUMOD029",
    "ref:FR:Atoumod:Nomad": "FR:14118:ZE:1151885:ATOUMOD040", "ref:Nomad": "14CAE27A",
    shelter: "no", tactile_paving: "no", wheelchair: "no",
  });
  assert.deepEqual(obj.get("n1").tags, originalTags);
});

test("writeOsm: gtfs:stop_id follows the network holding ref", () => {
  const TWISTO = "FR:14118:ZE:chuo02:ATOUMOD029", NOMAD = "FR:14118:ZE:1151885:ATOUMOD040", OTHER = "FR:14118:ZE:1151999:ATOUMOD040";
  const exported = (tags) => {
    const obj = new Store({ n1: { version: "1", lat: 49, lon: 1, tags: { public_transport: "platform", ...tags } } });
    obj.edit("n1");
    return Object.fromEntries(parseXml(writeOsm(obj)).children[0].children.map((tag) => [tag.attrs.k, tag.attrs.v]));
  };
  const shared = { network: "Twisto", "network:2": "Nomad" };
  const ids = { "gtfs:stop_id:F": `${TWISTO};${NOMAD}` };
  assert.equal(exported({ ...shared, ...ids, ref: "chuo02", "ref:Nomad": "14CAE74A" })["gtfs:stop_id"], TWISTO);
  assert.equal(exported({ ...shared, "gtfs:stop_id:F": `${NOMAD};${TWISTO}`, ref: "chuo02" })["gtfs:stop_id"], TWISTO); // whatever the order
  // Nomad first: its id has no code of its ref, the ref of the other network tells
  assert.equal(exported({ network: "Nomad", "network:2": "Twisto", ...ids, ref: "14CAE74A", "ref:Twisto": "chuo02" })["gtfs:stop_id"], NOMAD);
  // the id of the second network already in OSM goes too, not an id of another feed
  assert.equal(exported({ ...shared, "gtfs:stop_id": NOMAD, "gtfs:stop_id:F": TWISTO, ref: "chuo02", "ref:Nomad": "1151885" })["gtfs:stop_id"], TWISTO);
  assert.equal(exported({ ...shared, "gtfs:stop_id": "G1", "gtfs:stop_id:F": TWISTO, ref: "chuo02" })["gtfs:stop_id"], `G1;${TWISTO}`);
  // the only id known stays, even of the second network; no ref to tell: the last one
  assert.equal(exported({ ...shared, "gtfs:stop_id:F": NOMAD, "ref:Nomad": "1151885" })["gtfs:stop_id"], NOMAD);
  assert.equal(exported({ ...shared, "gtfs:stop_id:F": `${NOMAD};${OTHER}` })["gtfs:stop_id"], OTHER);
});

test("writeOsm: only the stop code of the first network", () => {
  const obj = new Store({ n1: { version: "1", lat: 49, lon: 1, tags: { public_transport: "platform", network: "Twisto", "network:2": "Nomad",
    "gtfs:stop_code:F": "chuo02", "gtfs:stop_code:F:Nomad": "14CAE74A", "gtfs:stop_code:Nomad": "14CAE74A" } } });
  obj.edit("n1");
  const keys = parseXml(writeOsm(obj)).children[0].children.map((tag) => tag.attrs.k).filter((k) => k.startsWith("gtfs:stop_code"));
  assert.deepEqual(keys, ["gtfs:stop_code:F"]);
  assert.equal(obj.get("n1").tags["gtfs:stop_code:F:Nomad"], "14CAE74A"); // kept for a change of priority
});

test("nearestPairs: one to one, nearest first", () => {
  const stop = (stop_id, lon) => ({ stop_id, lat: 49, lon });
  const pairs = nearestPairs([stop("A", 1.0), stop("B", 1.0001)], [{ id: "n1", pos: [49, 1.00012] }], 30);
  assert.deepEqual([...pairs.keys()], ["B"]); // A does not end up on the platform of B
});

test("feedTags names network-specific tags", () => {
  const t = feedTags({ network: "Twisto", "network:2": "Nomad", "network:wikidata": "Q1", "network:wikidata:2": "Q2",
    ref: "a", "ref:2": "b", "gtfs:stop_code:F": "fadr01" },
  { stop_id: "S", stop_name: "G", stop_code: "14CAE13A", route_ref: new Set(), wheelchair_boarding: "" }, "F", "Nomad");
  assert.deepEqual([t.ref, t["ref:Nomad"], t["ref:2"]], ["a", "b", undefined]);
  assert.deepEqual([t["network:wikidata"], t["network:wikidata:Nomad"]], ["Q1", "Q2"]);
  assert.deepEqual([t["gtfs:stop_code:F"], t["gtfs:stop_code:F:Nomad"]], ["fadr01", "14CAE13A"]);
});

test("feedTags", () => {
  configure();
  const t = feedTags({ name: "Gare", route_ref: "10;2" }, { stop_id: "S", stop_name: "Gare", route_ref: new Set(["3"]), wheelchair_boarding: "1" }, "F");
  assert.deepEqual(t, { name: "Gare", route_ref: "2;3;10", "gtfs:stop_id:F": "S", bus: "yes", wheelchair: "yes" });
});

test("feedTags keeps the GTFS stop name when it differs from the OSM name", () => {
  configure();
  const t = feedTags({ name: "Gare historique" }, { stop_id: "S", stop_name: "Gare", route_ref: new Set(), wheelchair_boarding: "" }, "F");
  assert.equal(t["gtfs:stop_name:F"], "Gare");
});
