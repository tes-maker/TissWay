// A stop takes the platform with its ref and the stop_position nearest to it: the bays of a bus station, drawn as those of Caen (a stub per bay, off the road the GTFS shape follows).
import assert from "node:assert/strict";
import { test } from "node:test";
import "./helpers.js";
import { Store } from "../src/osm.js";
import { choosePlatform, locateStop } from "../src/platforms.js";
import { throughNode } from "../src/reuse.js";
import { matchStops, pairStopPositions } from "../src/stops.js";

const stop = (code, lat, lon, name = "Gare Routière") => ({ stop_id: `id${code}`, stop_code: code, stop_name: name, lat: String(lat), lon: String(lon), parent_station: "" });
const platform = (lat, lon, code, more = {}) => ({ lat, lon, tags: { public_transport: "platform", name: "Gare Routière", ref: code, ...more } });
const position = (lat, lon) => ({ lat, lon, tags: { public_transport: "stop_position", bus: "yes" } });
const paired = (rows, osm, nodes) => {
  const stops = matchStops(rows, null, osm);
  pairStopPositions(stops, nodes, osm);
  return stops;
};

// real coordinates of bays C and D at Caen: both are nearest to n74, and C must not take it from D
const C = [49.17651, -0.34658], D = [49.17654, -0.3465];
const BAYS = [stop("14A", 49.17634, -0.34672), stop("14C", 49.17642, -0.34669), stop("14D", 49.17646, -0.34664)];
const OSM = { n1: platform(49.17639, -0.3467, "14A"), n2: platform(...C, "14C"), n3: platform(...D, "14D") };
const NODES = { n70: position(49.17638, -0.34668), n38: position(49.176499, -0.346524), n74: position(49.1765254, -0.3465319) };

test("each platform has its own stop_position, the closest pairs first", () => {
  const { paired: p } = paired(BAYS, OSM, NODES);
  assert.deepEqual([p.get("n1"), p.get("n2"), p.get("n3")], ["n70", "n38", "n74"]);
});

test("3 platforms with a ref under one name are bays; 2 are the two sides of a road", () => {
  assert.equal(paired(BAYS, OSM, NODES).bays.size, 3);
  const { n1, n2 } = OSM;
  assert.equal(paired(BAYS.slice(0, 2), { n1, n2 }, NODES).bays.size, 0);
});

test("the other bays are not rivals across a road", () => {
  const stops = paired(BAYS, OSM, NODES);
  assert.deepEqual(stops.rivalsOf("id14A"), []);
  assert.deepEqual(stops.opposites("id14A"), []);
});

test("a stray node with the stop_id comes after the platform drawn, and takes no stop_position", () => {
  const way = { version: "1", tags: { public_transport: "platform", name: "Gare Routière", ref: "14A", "gtfs:stop_id": "id14A" }, nodes: [], center: [49.17639, -0.3467] };
  const stray = { lat: 49.17635, lon: -0.34671, tags: { public_transport: "platform", name: "Gare Routière", ref: "NOMAD1", "gtfs:stop_id": "id14A" } };
  const { n1: drawnElsewhere, ...others } = OSM;
  assert.ok(drawnElsewhere);
  const stops = paired(BAYS, { ...others, w1: way, n9: stray }, NODES);
  assert.equal(stops.platformByRef("id14A").id, "w1");
  assert.ok(!stops.paired.has("n9"));
  assert.equal(stops.paired.get("w1"), "n70");
});

test("choosePlatform: a platform holding another stop too comes after the one holding this stop alone", () => {
  const at = (id, more) => ({ id, pos: [49, 1], holder: true, byRef: true, far: false, ...more });
  assert.equal(choosePlatform([at("n1", { shared: true }), at("n2", { shared: false })], [49, 1]).id, "n2");
});

test("a stop without a platform of its own keeps the stop_position nearest to it", () => {
  const rows = [stop("X", 49, 1, "Poste"), stop("Y", 49.0001, 1, "Mairie")];
  const stops = paired(rows, {}, { n5: position(49.00011, 1) });
  assert.equal(stops.paired.get("idY"), "n5");
  assert.ok(!stops.paired.has("idX"));
});

// --- the trace brought to the stop_position

/** The road the shape follows (w1, n1 -> n2 -> n3), and a bay: its stub w2 from the stop_position n9 to n8, on the one-way w3 of the station from n8 to n2. */
const station = () => {
  const n = (lat, lon) => ({ lat, lon, tags: {} });
  return new Store({
    n1: n(49, 1), n2: n(49.001, 1), n3: n(49.002, 1), n7: n(49.001, 1.002), n8: n(49.001, 1.001), n9: n(49.0012, 1.001),
    w1: { tags: { highway: "residential" }, nodes: ["n1", "n2", "n3"] },
    w2: { tags: { highway: "service", bus: "yes", access: "no" }, nodes: ["n9", "n8"] },
    w3: { tags: { highway: "service", psv: "designated", access: "no", oneway: "yes" }, nodes: ["n8", "n2"] },
  });
};
const ROADS = ["w1", "w2", "w3"];

test("first stop: from its stop_position to the trace, by the ways of the station, what comes before left out", () => {
  assert.deepEqual(throughNode(station(), ["w1"], "n9", 0, 5, ROADS, 500), ["w2", "w3", "w1"]);
});

test("last stop: a one-way against the trace cannot be taken", () => {
  assert.equal(throughNode(station(), ["w1"], "n9", 4, 5, ROADS, 500), null);
});

test("too far along the roads, or closed to buses: the trace stays as it is", () => {
  assert.equal(throughNode(station(), ["w1"], "n9", 0, 5, ROADS, 50), null);
  const closed = station();
  closed.get("w3").tags = { highway: "service", access: "private" };
  assert.equal(throughNode(closed, ["w1"], "n9", 0, 5, ROADS, 500), null);
});

test("a stop_position is not created next to an existing one, even left to the stop across the road", () => {
  const obj = new Store({ a: { lat: 49, lon: 1, tags: {} }, s: { ...position(49.00006, 1) }, b: { lat: 49.001, lon: 1, tags: {} }, w: { tags: { highway: "residential" }, nodes: ["a", "s", "b"] } });
  assert.equal(locateStop(obj, ["w"], [49, 1.0002], { rivals: [[49.00006, 0.9998]] }).node, "s");
});

// --- local_ref, and an area drawn with a node of the same ref

test("local_ref: the stop_position with the local_ref of the platform goes first, one with another local_ref is never its own", () => {
  const osm = { n1: platform(49.17639, -0.3467, "14A", { local_ref: "A" }) };
  const nodes = { near: { ...position(49.17639, -0.34668), tags: { ...position(0, 0).tags, local_ref: "B" } }, own: { ...position(49.17641, -0.34675), tags: { ...position(0, 0).tags, local_ref: "A" } } };
  assert.equal(paired(BAYS.slice(0, 1), osm, nodes).paired.get("n1"), "own");
  const { own, ...other } = nodes;
  assert.ok(own);
  assert.ok(!paired(BAYS.slice(0, 1), osm, other).paired.has("n1"));
});

test("a stop without a platform: its platform_code is its local_ref", () => {
  const rows = [{ ...stop("X", 49, 1, "Gare"), platform_code: "2" }];
  const tagged = (lat, ref) => ({ ...position(lat, 1), tags: { ...position(0, 0).tags, local_ref: ref } });
  assert.equal(paired(rows, {}, { a: tagged(49.00001, "1"), b: tagged(49.00008, "2") }).paired.get("idX"), "b");
});

test("an area and a node with the same ref: one platform, the node used, nearest to the stop_position by either", () => {
  const area = { version: "1", tags: { public_transport: "platform", name: "Gare Routière", ref: "14A" }, nodes: [], center: [49.1766, -0.3467] };
  const pole = platform(49.1766, -0.34672, "14A");
  const stops = paired(BAYS.slice(0, 1), { w1: area, n1: pole }, { s: position(49.17638, -0.34668) });
  assert.equal(stops.platformByRef("id14A").id, "n1");
  assert.equal(stops.platforms.get("id14A").find((c) => c.id === "w1").twin, "n1");
  assert.equal(stops.platforms.get("id14A").find((c) => c.id === "n1").twin, "w1");
  const area2 = { ...area, center: [49.17639, -0.3467] };
  const near = paired(BAYS.slice(0, 1), { w1: area2, n1: pole }, { s: position(49.17638, -0.34668) });
  assert.equal(near.paired.get("n1"), "s"); // 24 m from the node, 2 m from its area
  assert.ok(!near.paired.has("w1"));
});

test("the node drawn with an area of the same ref goes first, then that area, then a platform carrying the stop_id alone", () => {
  const at = (id, more) => ({ id, pos: [49, 1], holder: false, byRef: true, far: false, ...more });
  assert.equal(choosePlatform([at("n1", { holder: true }), at("w2", { twin: "n3" }), at("n3", { twin: "w2" })], [49, 1]).id, "n3");
  assert.equal(choosePlatform([at("n1", { holder: true }), at("w2", { twin: "n3" })], [49, 1]).id, "w2");
});

test("tagPlatforms: the area drawn with the node of the same ref holds the stop_id too, and is not a duplicate elsewhere", async () => {
  const { tagPlatforms } = await import("../src/platforms.js");
  const area = { version: "1", tags: { public_transport: "platform", name: "Gare Routière", ref: "14A", "gtfs:stop_id": "id14A" }, nodes: [], center: [49.17639, -0.3467] };
  const pole = { ...platform(49.17639, -0.34668, "14A"), version: "1" };
  pole.tags["gtfs:stop_id"] = "id14A";
  const stops = paired(BAYS.slice(0, 1), { w1: area, n1: pole }, {});
  const obj = new Store({ w1: area, n1: pole });
  const elsewhere = tagPlatforms(obj, stops, new Map([["id14A", new Map([["n1", [{ network: "Nomad" }, [49.17639, -0.34668], "bus", true]]])]]));
  assert.deepEqual(elsewhere, []);
});
