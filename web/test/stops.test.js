// Opposite stops (parent_station, codes 12A / 12B), rival stops, candidate platforms.
import assert from "node:assert/strict";
import { test } from "node:test";
import "./helpers.js";
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
