// Opposite stops (parent_station, codes 12A / 12B), rival stops, candidate platforms.
import assert from "node:assert/strict";
import { test } from "node:test";
import "./helpers.js";
import { settings } from "../src/settings.js";
import { matchStops, siblingCode } from "../src/stops.js";

test("siblingCode", () => {
  assert.equal(siblingCode("2702282A"), "2702282");
  assert.equal(siblingCode("2702282B"), "2702282");
  assert.equal(siblingCode("plca01"), null);
  assert.equal(siblingCode("AB"), null);
  assert.equal(siblingCode(""), null);
});

const gtfs = (rows) => rows.map(([stop_id, stop_code, stop_name, parent_station, lat, lon]) => ({ stop_id, stop_code, stop_name, parent_station, lat, lon }));
const osm = (rows) => Object.fromEntries(rows.map(([id, name, pt, stopId, lat, lon]) => [id, { version: "1", lat, lon,
  tags: { ...(name ? { name } : {}), ...(pt ? { public_transport: pt } : {}), ...(stopId ? { "gtfs:stop_id": stopId } : {}) } }]));

test("neighbours and rivals", () => {
  const stops = gtfs([
    ["P1", "", "Gare", "ST", 49.0, 1.0002], ["P2", "", "Gare", "ST", 49.0, 0.9998], // same station
    ["A", "10A", "Mairie", "", 49.01, 1.0002], ["B", "10B", "Mairie", "", 49.01, 0.9998], // codes
    ["C", "10C", "Mairie", "", 49.0102, 1.0], // same code, other agency
    ["X", "", "Poste", "", 49.02, 1.0002], ["Y", "", "Poste", "", 49.0206, 0.9998], // same name, 67 m
  ]);
  const agencies = new Map([["A", new Set(["ag1"])], ["B", new Set(["ag1"])], ["C", new Set(["ag2"])]]);
  const s = matchStops(stops, agencies, osm([["n1", "Gare", null, null, 49.0, 1.0003]]));
  assert.deepEqual(s.neighbours.get("P1"), ["P2"]);
  assert.deepEqual(s.neighbours.get("A"), ["B"]);
  assert.deepEqual(s.neighbours.get("X"), []);
  assert.deepEqual(s.rivals.get("X"), ["Y"]); // too far to be opposite, but same name
  assert.ok(s.rivals.get("A").includes("C") && !s.neighbours.get("A").includes("C"));
});

test("candidate platforms and holders", () => {
  const s = matchStops(gtfs([["A", "", "Mairie", "", 49.0, 1.0]]), null, osm([
    ["n1", "Mairie", "platform", null, 49.0, 1.0002], // 15 m
    ["n2", "Mairie", null, "A", 49.0007, 1.0], // 78 m but holds the stop_id
    ["n3", "Mairie", "stop_position", null, 49.0, 1.0], // never a platform
    ["n4", "Mairie", null, null, 49.0005, 1.0], // 55 m: extended reach, to be checked
    ["n5", "Poste", null, null, 49.0007, 1.0003], // 81 m, other name: out of reach
    ["n6", "MAIRIE", null, null, 49.0007, 1.0003], // 81 m, same name: extended reach
  ]));
  const got = s.platforms.get("A").map((c) => [c.id, c.holder, c.far]).sort();
  assert.deepEqual(got, [["n1", false, false], ["n2", true, false], ["n4", false, true], ["n6", false, true]]);
  assert.deepEqual([...s.holders], [["A", new Set(["n2"])]]);
});

test("far platform of another stop left out", () => {
  // n1 is 55 m from A but next to B: B's platform, not a candidate of A
  const s = matchStops(gtfs([["A", "", "Mairie", "", 49.0, 1.0], ["B", "", "Poste", "", 49.0006, 1.0]]), null, osm([["n1", "Poste", null, null, 49.0005, 1.0]]));
  assert.deepEqual(s.platforms.get("A"), []);
  assert.deepEqual(s.platforms.get("B").map((c) => c.id), ["n1"]);
});

test("far platform closer to a stop of the same name", () => {
  // Jules Ferry (Atoumod): both GTFS directions 37 m apart and ~40 m off; the OSM platforms are closer to J1 but remain
  // candidates of J0 (the side is checked when the platform is chosen)
  const s = matchStops(gtfs([["J0", "", "Jules Ferry", "", 49.468174, 1.044779], ["J1", "", "Jules Ferry", "", 49.468505, 1.044659]]), null,
    osm([["n19", "Jules Ferry", "platform", null, 49.4688143, 1.0444221], ["n20", "Jules Ferry", "platform", null, 49.4686988, 1.0443729]]));
  assert.deepEqual(s.platforms.get("J0").map((c) => c.id).sort(), ["n19", "n20"]);
});

const platformAt = (lat, tags) => ({ version: "1", lat, lon: 1, tags: { name: "Poste", ...tags } });

test("a platform with the code of the stop as a ref: a candidate up to ref_m, even with another name and a closer stop", () => {
  // Poste is 16 m from the platform, Mairie 40 m: without its ref, the platform is left to Poste
  const stops = gtfs([["A", "77", "Mairie", "", 49.0, 1.0], ["B", "88", "Poste", "", 49.0005, 1.0]]);
  const candidates = (tags, lat = 49.00036) => matchStops(stops, null, { n1: platformAt(lat, tags) }).platforms.get("A").map((c) => [c.id, c.byRef, c.far]);
  assert.deepEqual(candidates({}), []);
  for (const tags of [{ ref: "77" }, { "ref:Twisto": "77" }, { ref: "9;77" }, { "gtfs:stop_code:FR-X": "77" }]) assert.deepEqual(candidates(tags), [["n1", true, true]], JSON.stringify(tags));
  assert.deepEqual(candidates({ ref: "78" }), []);
  assert.deepEqual(candidates({ local_ref: "77" }), []);
  assert.deepEqual(candidates({ ref: "77" }, 49.00054), []); // 60 m: too far
  settings.thresholds.ref_m = 70;
  assert.deepEqual(candidates({ ref: "77" }, 49.00054), [["n1", true, true]]);
  settings.thresholds.ref_m = 0;
  assert.deepEqual(candidates({ ref: "77" }), []);
});

test("the code in a NeTEx stop_id counts as a ref; with the codes of the GTFS not trusted, only the stop_id", () => {
  const stops = gtfs([["FR:14:ZE:abc:1", "77", "Mairie", "", 49.0, 1.0]]);
  const refHolders = (ref) => [...(matchStops(stops, null, { n1: platformAt(49.00036, { ref }) }).refHolders.get("FR:14:ZE:abc:1") ?? [])];
  assert.deepEqual(refHolders("abc"), ["n1"]);
  assert.deepEqual(refHolders("77"), ["n1"]);
  settings.stop_refs_from_gtfs = false;
  assert.deepEqual(refHolders("abc"), []);
  assert.deepEqual(refHolders("77"), []);
  assert.deepEqual(refHolders("FR:14:ZE:abc:1"), ["n1"]);
});

test("a strong name: case, accents, the town, brackets and St do not count; other words do", () => {
  const sameName = (stopName, tags) => matchStops(gtfs([["A", "", stopName, "", 49.0, 1.0]]), null, { n1: { version: "1", lat: 49.0001, lon: 1, tags } }).platforms.get("A")[0].sameName;
  assert.equal(sameName("Hôpital", { name: "HOPITAL" }), true);
  assert.equal(sameName("CAEN - Gare", { name: "Gare" }), true);
  assert.equal(sameName("Gare", { name: "Caen - Gare" }), true);
  assert.equal(sameName("Bravo", { name: "Bravo (ancien)" }), true);
  assert.equal(sameName("St Pierre", { name: "Saint-Pierre" }), true);
  assert.equal(sameName("Mairie", { name: "Autre", official_name: "CAEN - Mairie" }), true);
  assert.equal(sameName("Mairie", { name: "Autre", "gtfs:stop_name:FR-X": "Mairie" }), true);
  assert.equal(sameName("Gare", { name: "Gare Routière" }), false);
  assert.equal(sameName("Mairie", {}), false);
});

test("claimed: another stop has the ref or the name of the platform", () => {
  const claimed = (tags) => matchStops(gtfs([["A", "77", "Mairie", "", 49.0, 1.0], ["B", "88", "Poste", "", 49.0004, 1.0]]), null, { n1: { version: "1", lat: 49.0001, lon: 1, tags } }).platforms.get("A")[0].claimed;
  assert.equal(claimed({ name: "Autre" }), false);
  assert.equal(claimed({ name: "Poste" }), true);
  assert.equal(claimed({ name: "Autre", ref: "88" }), true);
  assert.equal(claimed({ name: "Mairie" }), false);
});
