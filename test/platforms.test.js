// Stops on the ground: stop_position placement (rival stops), kerb side, opposite stop, one platform per stop_id.
import assert from "node:assert/strict";
import { test } from "node:test";
import { approx } from "./helpers.js";
import { buildLine } from "../src/build.js";
import { Store } from "../src/osm.js";
import { stopPositionOnly, choosePlatform, completeRouteRef, enrich, filterRoadPlatforms, fixSide, forward, kerbSide, layBy, locateStop, lostStops, makeSpot, materialize,
  roadDistance, setStopPositionTags, sideSegment, stopPositionTags, stopRef, stopSegment, stopTags, tagPlatforms, travelSegment } from "../src/platforms.js";
import { settings } from "../src/settings.js";
import { Stops } from "../src/stops.js";
import { log } from "../src/util.js";

const NOMAD = { network: "Nomad" };
const WEST = 0.9998, EAST = 1.0002; // either side of a north-south road at longitude 1.0 (~15 m)

const node = (lat, lon, tags = {}) => ({ version: "1", lat, lon, tags });
const way = (nodes, tags = {}) => ({ version: "1", tags, nodes });

/** North-south road n1 -> n2 -> n3 drawn as two ways: w1 northwards, w2 southwards. */
const road = () => ({ n1: node(49.0, 1.0), n2: node(49.0005, 1.0), n3: node(49.001, 1.0), w1: way(["n1", "n2"]), w2: way(["n3", "n2"]) });

/** Two-way street drawn as a single way wR (r1 at 49.0 to r5 at 49.001, every ~28 m), extended by wS to the south and wN to the north. */
function street(extra = {}) {
  const objs = {};
  [49.0, 49.00025, 49.0005, 49.00075, 49.001].forEach((lat, i) => { objs[`r${i + 1}`] = node(lat, 1.0); });
  return new Store({ ...objs, s0: node(48.9995, 1.0), n6: node(49.0015, 1.0), wR: way(["r1", "r2", "r3", "r4", "r5"]), wS: way(["s0", "r1"]), wN: way(["r5", "n6"]), ...extra });
}

/** Insert an existing stop_position node key at lat on wR, after node after. */
function withStopPosition(objs, key, lat, after) {
  objs.base.set(key, node(lat, 1.0, { public_transport: "stop_position", bus: "yes", name: "Hôpital" }));
  const nodes = objs.base.get("wR").nodes;
  nodes.splice(nodes.indexOf(after) + 1, 0, key);
  return objs;
}

function makeStops(rows, { neighbours, platforms, holders, rivals } = {}) {
  const df = new Map(rows.map((r) => [r.stop_id, { ...r, label: r.stop_name }]));
  const empty = () => new Map(rows.map((r) => [r.stop_id, []]));
  const map = (o) => (o ? new Map(Object.entries(o)) : empty());
  return new Stops(df, map(platforms), map(neighbours), holders ? new Map(Object.entries(holders).map(([k, v]) => [k, new Set(v)])) : new Map(), map(rivals));
}

const gtfsStop = (stop_id, stop_code, lat, lon, stop_name = "Hopital") => ({ stop_id, stop_code, stop_name, wheelchair_boarding: "", platform_code: "", lat, lon });

const atoumodId = "FR:76216:ZE:TCARxCAILL3:ATOUMOD001";
test("stopRef", () => {
  settings.ref_from_stop_id = true;
  assert.equal(stopRef(gtfsStop(atoumodId, "", 49, 1), atoumodId), "TCARxCAILL3");
  assert.equal(stopRef(gtfsStop(atoumodId, "2705028A", 49, 1), atoumodId), "2705028A");
  assert.equal(stopRef(gtfsStop("1234", "", 49, 1), "1234"), null);
});

test("no ref from stop_id by default", () => assert.equal(stopRef(gtfsStop(atoumodId, "", 49, 1), atoumodId), null));

// --- direction of travel

test("forward: way drawn against travel", () => {
  const obj = new Store(road());
  assert.ok(forward(obj, ["w1", "w2"], 0));
  assert.ok(!forward(obj, ["w1", "w2"], 1));
});

test("travelSegment follows the direction of travel", () => {
  const obj = new Store(road());
  const spot = locateStop(obj, ["w1", "w2"], [49.0007, EAST], { start: 1 });
  const [a, b] = travelSegment(obj, ["w1", "w2"], spot);
  assert.ok(a[0] < b[0]);
});

// --- stop_position

test("locate changes nothing and materialize inserts the node", () => {
  const obj = street();
  const spot = locateStop(obj, ["wR"], [49.0004, EAST]);
  assert.equal(spot.node, null);
  approx(spot.pos[0], 49.0004);
  assert.equal(obj.modified.size, 0);
  const key = materialize(obj, ["wR"], spot, "Hôpital");
  assert.deepEqual(obj.get("wR").nodes, ["r1", "r2", key, "r3", "r4", "r5"]);
  assert.deepEqual(obj.get(key).tags, { bus: "yes", name: "Hôpital", public_transport: "stop_position" });
  assert.deepEqual(obj.base.get("wR").nodes, ["r1", "r2", "r3", "r4", "r5"]); // what was read is untouched
});

const reuseCases = [
  ["existing stop_position near the projection is reused", 49.00065, "r3", [49.0004, EAST], {}, "nSP"],
  // northbound stop on the east kerb; the stop of the same name for the other direction is on the west kerb in front of
  // the existing stop_position: a new stop_position is created in front of ours
  ["stop_position of the opposite stop is left to it", 49.00065, "r3", [49.0004, EAST], { rivals: [[49.00065, WEST]] }, null],
  ["face-to-face stops share the stop_position", 49.0004, "r2", [49.0004, EAST], { rivals: [[49.0004, WEST]] }, "nSP"],
  ["rival at the same place is the same platform", 49.00065, "r3", [49.0004, EAST], { rivals: [[49.00041, EAST]] }, "nSP"],
  ["rival on the same side shares the stop_position", 49.00065, "r3", [49.0004, EAST], { rivals: [[49.00065, EAST]] }, "nSP"],
  ["rival on another road is ignored", 49.00065, "r3", [49.0004, EAST], { rivals: [[49.00065, 1.002]] }, "nSP"],
  ["stop_position too far along the way is not reused", 49.00072, "r3", [49.0004, EAST], {}, null],
];
for (const [name, lat, after, pos, options, expected] of reuseCases) {
  test(name, () => {
    const obj = withStopPosition(street(), "nSP", lat, after);
    assert.equal(locateStop(obj, ["wR"], pos, options).node, expected);
  });
}

test("stop_position nearest to the platform is reused", () => {
  const obj = withStopPosition(withStopPosition(street(), "nSP1", 49.0004, "r2"), "nSP2", 49.00055, "r3");
  assert.equal(locateStop(obj, ["wR"], [49.00055, EAST], { platform: true }).node, "nSP2");
});

test("stop_position of the rival platform is left to it", () => {
  const obj = withStopPosition(street(), "nSP", 49.00065, "r3");
  const spot = locateStop(obj, ["wR"], [49.0004, EAST], { rivals: [[49.00065, WEST]], platform: true });
  assert.equal(spot.node, null);
  approx(spot.pos[0], 49.0004);
  assert.equal(locateStop(obj, ["wR"], [49.00065, EAST], { rivals: [[49.00065, WEST]], platform: true }).node, "nSP"); // face to face
});

test("stop_position of another vehicle is not reused", () => {
  const obj = withStopPosition(street(), "nSP", 49.0004, "r2");
  obj.base.get("nSP").tags = { public_transport: "stop_position", tram: "yes" };
  assert.equal(locateStop(obj, ["wR"], [49.0004, EAST]).node, null);
});

test("stop_position created even far from the trace", () => {
  const obj = new Store(road()), far = { stop_name: "Hopital", lat: 49.0005, lon: 1.001 }; // ~70 m east
  assert.equal(locateStop(obj, ["w1", "w2"], [far.lat, far.lon]), null);
  const spot = locateStop(obj, ["w1", "w2"], [far.lat, far.lon], { max_m: Infinity });
  const key = materialize(obj, ["w1", "w2"], spot, far.stop_name);
  assert.equal(obj.get(key).tags.name, "Hopital");
  assert.ok(obj.get(["w1", "w2"][spot.wayIndex]).nodes.includes(key));
});

test("an existing stop_position keeps only its vehicle and name, the rest goes to its platform", () => {
  const obj = withStopPosition(street(), "nSP", 49.0004, "r2");
  Object.assign(obj.base.get("nSP").tags, { highway: "bus_stop", direction: "forward", shelter: "yes", bench: "yes", ref: "DRELECL1", network: "Linéad", "gtfs:stop_id": "S1", route_ref: "1", name: "Leclerc" });
  obj.base.set("nP", { lat: 49.0004, lon: EAST, tags: { public_transport: "platform", bench: "no" } });
  const spot = locateStop(obj, ["wR"], [49.0004, EAST]);
  materialize(obj, ["wR"], spot, "Hôpital", "bus", { platform: "nP", exclusive: true });
  assert.deepEqual(obj.get(spot.node).tags, { bus: "yes", name: "Hôpital", public_transport: "stop_position" });
  assert.deepEqual(obj.get("nP").tags, { public_transport: "platform", bench: "no", shelter: "yes", ref: "DRELECL1", network: "Linéad", "gtfs:stop_id": "S1", route_ref: "1" });
  assert.equal(obj.modified.has("wR"), false);
});

test("a stop_position shared by two stops: what says which stop it is stays off the platform", () => {
  const obj = withStopPosition(street(), "nSP", 49.0004, "r2");
  Object.assign(obj.base.get("nSP").tags, { shelter: "yes", ref: "X", network: "N", "gtfs:stop_id": "S1" });
  obj.base.set("nP", { lat: 49.0004, lon: EAST, tags: { public_transport: "platform" } });
  materialize(obj, ["wR"], locateStop(obj, ["wR"], [49.0004, EAST]), "Hôpital", "bus", { platform: "nP", exclusive: false });
  assert.deepEqual(obj.get("nP").tags, { public_transport: "platform", shelter: "yes" });
});

test("what describes something else on the node of a stop_position stays", () => {
  assert.deepEqual(stopPositionOnly({ public_transport: "stop_position", highway: "traffic_signals", crossing: "marked", "crossing:island": "yes", barrier: "bollard", bus: "yes", tram: "yes", note: "à revoir", shelter: "yes" }, "Gare", ["bus"]), {
    tags: { public_transport: "stop_position", highway: "traffic_signals", crossing: "marked", "crossing:island": "yes", barrier: "bollard", bus: "yes", tram: "yes", note: "à revoir", name: "Gare" },
    moved: { shelter: "yes" },
  });
  assert.deepEqual(stopPositionOnly({ highway: "bus_stop", name: "Gare" }, null, ["trolleybus"]).tags, { public_transport: "stop_position", trolleybus: "yes", name: "Gare" });
});

test("a stop_position with nothing more is not modified", () => {
  const obj = withStopPosition(street(), "nSP", 49.0004, "r2");
  materialize(obj, ["wR"], locateStop(obj, ["wR"], [49.0004, EAST]), "Hôpital");
  assert.equal(obj.modified.size, 0);
});

test("existing stop_position keeps the other vehicles", () => {
  const obj = new Store(road());
  obj.base.get("n2").tags = { public_transport: "stop_position", tram: "yes", name: "X" };
  setStopPositionTags(obj, "n2", "Hôpital");
  assert.deepEqual(obj.get("n2").tags, { tram: "yes", bus: "yes", name: "Hôpital", public_transport: "stop_position" });
});

test("compliant stop_position not modified", () => {
  const obj = new Store(road());
  obj.base.get("n2").tags = stopPositionTags("Hôpital");
  setStopPositionTags(obj, "n2", "Hôpital");
  assert.ok(!obj.modified.has("n2"));
});

// --- whole lines

/** Stops along street(): S / A / N on the east kerb (northbound), N2 / B / S2 on the west kerb. */
function lineStops() {
  const pairs = { S: ["S2"], S2: ["S"], A: ["B"], B: ["A"], N: ["N2"], N2: ["N"] };
  return makeStops([gtfsStop("S", "1A", 48.9997, 1.00015, "Sud"), gtfsStop("A", "10A", 49.0004, EAST), gtfsStop("N", "2A", 49.0013, 1.00015, "Nord"),
    gtfsStop("N2", "2B", 49.0013, 0.99985, "Nord"), gtfsStop("B", "10B", 49.00065, WEST), gtfsStop("S2", "1B", 48.9997, 0.99985, "Sud")], { neighbours: pairs, rivals: pairs });
}

function build(variants, stops, obj) {
  const assignments = new Map();
  buildLine({ route_id: "R1", route_short_name: "1", route_color: "", route_text_color: "", mode: "bus" }, variants, obj, stops, NOMAD, assignments, new Map());
  return [[...obj.modified].filter(([k, o]) => k[0] === "r" && o.tags.type === "route").map(([, o]) => o), assignments];
}

const stopMembers = (rel) => rel.members.filter(([, role]) => role === "stop").map(([ref]) => ref);
const variant = (direction, seq, trip_id, ways) => ({ direction, seq, shape_id: "", trip_id, ways });

test("both directions get their own stop_position on a two-way street", () => {
  const obj = street();
  const [[rn, rs]] = build([variant("0", ["S", "A", "N"], "t1", ["wS", "wR", "wN"]), variant("1", ["N2", "B", "S2"], "t2", ["wN", "wR", "wS"])], lineStops(), obj);
  const a = stopMembers(rn)[1], b = stopMembers(rs)[1];
  assert.notEqual(a, b);
  approx(obj.get(a).lat, 49.0004);
  approx(obj.get(b).lat, 49.00065);
});

test("a stop across the road without an OSM platform: the platform created is the GTFS stop itself, at its position, with its data", () => {
  const obj = street();
  const [[rel], assignments] = build([variant("0", ["S", "B", "N"], "t1", ["wS", "wR", "wN"])], lineStops(), obj);
  approx(obj.get(stopMembers(rel)[1]).lat, 49.00065);
  assert.ok(assignments.has("B") && !assignments.has("A"));
  const platform = rel.members.filter(([, role]) => role === "platform")[1][0];
  assert.deepEqual([obj.get(platform).lat, obj.get(platform).lon].map(Number), [49.00065, WEST]);
});

test("a stop_position whose platform is created keeps what it has more: the platform only takes the GTFS", () => {
  const obj = new Store({ s: { lat: 49, lon: 1, tags: { public_transport: "stop_position", bus: "yes", shelter: "yes", ref: "X" } }, p: { lat: 49, lon: 1.0001, tags: {} } });
  obj.set("n-500", { lat: 49, lon: 1.0001, tags: {} });
  setStopPositionTags(obj, "s", "Gare", "bus", { platform: "n-500", exclusive: true });
  assert.deepEqual(obj.get("s").tags, { public_transport: "stop_position", bus: "yes", name: "Gare", shelter: "yes", ref: "X" });
  assert.deepEqual(obj.get("n-500").tags, {});
  setStopPositionTags(obj, "s", "Gare", "bus", { platform: "p", exclusive: true });
  assert.equal(obj.get("p").tags.shelter, "yes"); // an existing platform still takes it
});

// --- platforms

const SEGMENT = [[49.0, 1.0], [49.001, 1.0]]; // northbound: kerb side = east

test("fixSide takes the sibling on the kerb side", () => {
  const s = makeStops([gtfsStop("A", "10A", 49.0005, WEST), gtfsStop("B", "10B", 49.0005, EAST)], {
    neighbours: { A: ["B"], B: ["A"] },
    platforms: { A: [{ id: "nPA", pos: [49.0005, WEST], name: "Hopital", holder: false, sameName: true }], B: [{ id: "nPB", pos: [49.0005, EAST], name: "Hopital", holder: false, sameName: true }] },
  });
  const [platform, dataId] = fixSide("A", s.platforms.get("A")[0], SEGMENT, s);
  assert.deepEqual([platform.id, dataId], ["nPB", "B"]);
});

test("fixSide keeps a stop whose OSM platform carries its stop_id on the kerb side, wherever the GTFS puts it", () => {
  const s = makeStops([gtfsStop("A", "10A", 49.0005, WEST), gtfsStop("B", "10B", 49.0007, EAST)], {
    neighbours: { A: ["B"], B: ["A"] },
    platforms: { A: [{ id: "nPA", pos: [49.0005, EAST], name: "Hopital", holder: true }], B: [{ id: "nPB", pos: [49.0007, EAST], name: "Hopital", holder: true }] },
  });
  const [platform, dataId] = fixSide("A", s.platforms.get("A")[0], SEGMENT, s);
  assert.deepEqual([platform.id, dataId], ["nPA", "A"]);
});

test("fixSide still swaps when the platform carrying the stop_id is across the road", () => {
  const s = makeStops([gtfsStop("A", "10A", 49.0005, WEST), gtfsStop("B", "10B", 49.0005, EAST)], {
    neighbours: { A: ["B"], B: ["A"] },
    platforms: { A: [{ id: "nPA", pos: [49.0005, WEST], name: "Hopital", holder: true }], B: [{ id: "nPB", pos: [49.0005, EAST], name: "Hopital", holder: true }] },
  });
  const [platform, dataId] = fixSide("A", s.platforms.get("A")[0], SEGMENT, s);
  assert.deepEqual([platform.id, dataId], ["nPB", "B"]);
});

test("fixSide keeps a platform on the kerb side closer to the stop, without any stop_id", () => {
  const s = makeStops([gtfsStop("A", "10A", 49.0005, WEST), gtfsStop("B", "10B", 49.0009, EAST)], {
    neighbours: { A: ["B"], B: ["A"] },
    platforms: { A: [{ id: "nPA", pos: [49.0005, EAST], name: "Hopital", holder: false }], B: [{ id: "nPB", pos: [49.0009, EAST], name: "Hopital", holder: false }] },
  });
  assert.deepEqual(fixSide("A", s.platforms.get("A")[0], SEGMENT, s).map((x) => x.id ?? x), ["nPA", "A"]);
});

test("fixSide leaves to the opposite stop a kerb platform closer to it, or carrying its stop_id", () => {
  const near = { id: "nPB", pos: [49.0005, EAST], name: "Hopital", holder: false };
  const stopsOf = (bLat, holders = {}) => makeStops([gtfsStop("A", "10A", 49.0005, WEST), gtfsStop("B", "10B", bLat, EAST)], {
    neighbours: { A: ["B"], B: ["A"] }, platforms: { A: [near], B: [near] }, holders,
  });
  assert.equal(fixSide("A", near, SEGMENT, stopsOf(49.0005))[1], "B");
  assert.equal(fixSide("A", near, SEGMENT, stopsOf(49.0009, { B: ["nPB"] }))[1], "B");
});

test("fixSide: without a platform, a stop on the road is kept, one clearly across is replaced", () => {
  const stopsAt = (lon) => makeStops([gtfsStop("A", "10A", 49.0005, lon), gtfsStop("B", "10B", 49.0005, EAST)], { neighbours: { A: ["B"], B: ["A"] } });
  assert.deepEqual(fixSide("A", null, SEGMENT, stopsAt(1.0 - 0.00001)), [null, "A"]); // < 1 m west of the road
  assert.equal(fixSide("A", null, SEGMENT, stopsAt(WEST))[1], "B");
});

test("lostStops: a stop carried by OSM and served, that no relation uses", () => {
  const stops = { holders: new Map([["A", new Set(["n1"])], ["B", new Set(["n2"])]]) };
  const variants = [{ seq: ["A", "B", "C"] }];
  assert.deepEqual(lostStops(variants, stops, new Map([["B", new Map()]])), ["A"]);
});

test("fixSide without sibling changes nothing", () => {
  assert.deepEqual(fixSide("A", null, SEGMENT, makeStops([gtfsStop("A", "10A", 49.0005, WEST)])), [null, "A"]);
});

test("far platform only on the kerb side next to the road", () => {
  const far = (id, lon) => ({ id, pos: [49.0005, lon], name: "X", holder: false, sameName: true, far: true });
  const nearWest = { id: "nW", pos: [49.0005, WEST], name: "X", holder: false, sameName: true, far: false };
  const stop = [49.0005, 1.0];
  assert.equal(choosePlatform([far("nE", EAST)], stop, { segment: SEGMENT }).id, "nE");
  assert.equal(choosePlatform([far("nW2", WEST)], stop, { segment: SEGMENT }), null); // across the road
  assert.equal(choosePlatform([far("nP", 1.0005)], stop, { segment: SEGMENT }), null); // 37 m off: parallel street
  assert.equal(choosePlatform([far("nE", EAST)], stop), null); // side unknown
  assert.equal(choosePlatform([far("nE", EAST)], stop, { segment: SEGMENT, road: () => 32 }), null); // street the route does not take
  assert.equal(choosePlatform([nearWest, far("nW2", WEST)], stop, { segment: SEGMENT }), null); // never across the road: see fixSide, for a single pole
});

test("roadDistance stops at the end of the travelled ways", () => {
  const obj = street();
  approx(roadDistance(obj, ["wR"], [49.0005, EAST]), 14.6, 0.5);
  assert.ok(roadDistance(obj, ["wR"], [49.00135, EAST]) > 40);
});

const layByStreet = (tags = {}) => street({ b1: node(49.00025, 1.0002), b2: node(49.00075, 1.0002), wB: way(["r2", "b1", "b2", "r4"], tags) });

test("side of a GTFS stop in a lay-by judged on the road", () => {
  // Centre d'Art Contemporain (Atoumod): the spot falls on the eastward leg r2 - b1: the side is judged on wR, northwards
  const obj = layByStreet(), ways = ["wR", "wB", "wR"];
  const spot = makeSpot(1, [49.00025, 1.0001], 0, { a: "r2", b: "b1" });
  assert.ok(layBy(obj, ways, 1));
  const [a, b] = stopSegment(obj, ways, spot);
  assert.ok(a[0] < b[0] && a[1] === 1.0 && b[1] === 1.0);
  assert.ok(kerbSide([49.0003, 1.0003], a, b) && !kerbSide([49.0003, 0.9998], a, b));
});

test("named street between two others is not a lay-by", () => {
  const obj = layByStreet({ name: "Rue Haute" });
  assert.ok(!layBy(obj, ["wR", "wB", "wR"], 1));
  assert.ok(!layBy(obj, ["wR", "wB"], 1)); // end of the route
});

test("platform side judged on the road next to it", () => {
  const obj = new Store({ c1: node(49.0, 1.0), c2: node(49.0005, 1.0), c3: node(49.0005, 1.001), wC: way(["c1", "c2", "c3"]) });
  const spot = makeSpot(0, [49.0002, 1.0], 0, { a: "c1", b: "c2" }), p = [49.00058, 1.0008];
  assert.ok(kerbSide(p, ...travelSegment(obj, ["wC"], spot))); // prolongation: wrongly on the kerb side
  assert.ok(!kerbSide(p, ...sideSegment(obj, ["wC"], spot, p)));
});

test("platform between the road and a lay-by is judged on the road", () => {
  const obj = layByStreet(), ways = ["wR", "wB", "wR"], p = [49.0005, 1.00014];
  assert.ok(kerbSide(p, ...sideSegment(obj, ways, makeSpot(0, [49.0005, 1.0], 0, { a: "r2", b: "r3" }), p)));
});

test("left-hand traffic: platform on the left", () => {
  const candidates = [{ id: "nW", pos: [49.0005, WEST], name: "X", holder: false, sameName: true }, { id: "nE", pos: [49.0005, EAST], name: "X", holder: false, sameName: true }];
  settings.driving_side = "left";
  assert.equal(choosePlatform(candidates, [49.0005, 1.0], { segment: SEGMENT }).id, "nW");
  settings.driving_side = "right";
  assert.equal(choosePlatform(candidates, [49.0005, 1.0], { segment: SEGMENT }).id, "nE");
});

test("explicit platform on a way stays a platform", () => {
  const candidates = new Map([["A", [{ id: "nPlatform" }, { id: "nLegacy" }, { id: "nOffRoad" }]]]);
  const osm = { nPlatform: node(49, 1, { public_transport: "platform", highway: "bus_stop" }), nLegacy: node(49, 1, { highway: "bus_stop" }) };
  assert.deepEqual(filterRoadPlatforms(candidates, new Set(["nPlatform", "nLegacy"]), osm).get("A").map((c) => c.id), ["nPlatform", "nOffRoad"]);
});

const plats = (...entries) => new Map([["H", new Map(entries.map(([id, lon]) => [id, [NOMAD, [49.0005, lon], "bus"]]))]]);

test("single platform gets the stop_id", () => {
  settings.stop_ref_tags = ["ref:FR:Atoumod"];
  const s = makeStops([gtfsStop("H", "2705028A", 49.0005, 1.00005)]);
  const obj = new Store({ nE: node(49.0005, 1.0001, { name: "Hopital" }), nW: node(49.0005, 0.9999, { name: "Hopital" }) });
  tagPlatforms(obj, s, plats(["nE", 1.0001], ["nW", 0.9999]));
  assert.equal(obj.get("nE").tags["ref:FR:Atoumod"], "H");
  assert.equal(obj.get("nE").tags.ref, "2705028A");
  assert.ok(!("ref:FR:Atoumod" in obj.get("nW").tags) && !("ref" in obj.get("nW").tags));
  assert.equal(obj.get("nW").tags.network, "Nomad"); // still completed (name, network)
});

test("platform already holding the stop_id wins and duplicate removed", () => {
  const s = makeStops([gtfsStop("H", "2705028A", 49.0005, 1.00005)], { holders: { H: ["nE", "nW"] } });
  const obj = new Store({ nE: node(49.0005, 1.0001, { "gtfs:stop_id": "H" }), nW: node(49.0005, 0.9999, { "gtfs:stop_id": "H" }) });
  tagPlatforms(obj, s, plats(["nE", 1.0001], ["nW", 0.9999]));
  assert.equal(obj.get("nE").tags["gtfs:stop_id"], "H");
  assert.ok(!("gtfs:stop_id" in obj.get("nW").tags));
});

test("stop_id held by another OSM platform is not set", () => {
  const s = makeStops([gtfsStop("H", "2705028A", 49.0005, 1.00005)], { holders: { H: ["nElsewhere"] } });
  const obj = new Store({ nE: node(49.0005, 1.0001) });
  assert.equal(tagPlatforms(obj, s, plats(["nE", 1.0001])).length, 1);
  assert.ok(!("gtfs:stop_id" in obj.get("nE").tags));
});

test("enrich: a platform of a bus line has bus=yes, unless it says otherwise", () => {
  const after = (tags) => {
    const obj = new Store({ n1: { lat: 49, lon: 0, tags: { public_transport: "platform", ...tags } } });
    enrich(obj, "n1", stopTags({ stop_name: "Gare" }, "S1", { network: "Twisto" }, "bus"));
    return obj.get("n1").tags.bus;
  };
  assert.equal(after({ highway: "bus_stop" }), "yes");
  assert.equal(after({ highway: "platform" }), "yes");
  assert.equal(after({ highway: "bus_stop", bus: "yes" }), "yes");
  assert.equal(after({ highway: "bus_stop", bus: "no" }), "no");
});

test("platform tags: bus=yes for a bus or a coach, GTFS keys with the feed code", () => {
  const stop = { stop_name: "Gare", stop_code: "12A" };
  assert.equal(stopTags(stop, "S1", {}, "bus").bus, "yes");
  assert.deepEqual([stopTags(stop, "S1", {}, "coach").bus, stopTags(stop, "S1", {}, "coach").coach], ["yes", "yes"]);
  assert.deepEqual([stopTags(stop, "S1", {}, "trolleybus").bus, stopTags(stop, "S1", {}, "trolleybus").trolleybus], [undefined, "yes"]);
  assert.equal(stopTags(stop, "S1", {}).highway, "bus_stop");
  settings.feed = "FR-X";
  const t = stopTags(stop, "S1", {});
  assert.deepEqual([t["gtfs:stop_id:FR-X"], t["gtfs:stop_name:FR-X"], t["gtfs:stop_code:FR-X"], t["gtfs:stop_id"]], ["S1", undefined, "12A", undefined]);
});

test("alt_name leaves the stops of a line: platform and stop_position, without passing from one to the other", () => {
  const obj = new Store({ n1: { version: "1", lat: 49, lon: 1, tags: { public_transport: "platform", name: "Gare", alt_name: "Gare SNCF" } } });
  enrich(obj, "n1", { name: "Gare", network: "Twisto" });
  assert.ok(!("alt_name" in obj.get("n1").tags));
  const { tags, moved } = stopPositionOnly({ public_transport: "stop_position", bus: "yes", name: "Gare", alt_name: "Gare SNCF", shelter: "yes" }, "Gare");
  assert.ok(!("alt_name" in tags) && !("alt_name" in moved));
  assert.deepEqual(moved, { shelter: "yes" });
});

test("enrich removes a GTFS stop name only when it duplicates name", () => {
  settings.feed = "FR-X";
  const obj = new Store({
    same: node(49, 1, { name: "Gare", "gtfs:stop_name:FR-X": "Gare" }),
    different: node(49, 1, { name: "Gare", "gtfs:stop_name:FR-X": "Gare historique;Gare" }),
  });
  enrich(obj, "same", { name: "Gare", "gtfs:stop_id:FR-X": "S1" });
  enrich(obj, "different", { name: "Gare", "gtfs:stop_id:FR-X": "S2" });
  assert.equal(obj.get("same").tags["gtfs:stop_name:FR-X"], undefined);
  assert.equal(obj.get("different").tags["gtfs:stop_name:FR-X"], "Gare historique");
});

test("a platform drawn as a way never gets highway=bus_stop", () => {
  const obj = new Store({ w1: way(["n1", "n2", "n1"], { public_transport: "platform" }), w2: way(["n1", "n2"], { highway: "footway" }) });
  enrich(obj, "w1", stopTags({ stop_name: "Gare" }, "S", NOMAD));
  enrich(obj, "w2", stopTags({ stop_name: "Gare" }, "S", NOMAD));
  assert.equal(obj.get("w1").tags.highway, "platform");
  assert.equal(obj.get("w2").tags.highway, "footway");
});

test("route_ref is completed where it exists, never created", () => {
  const obj = new Store({ a: node(49, 1, { route_ref: "2;10" }), b: node(49, 1), c: node(49, 1, { route_ref: "5" }) });
  completeRouteRef(obj, "a", "5");
  completeRouteRef(obj, "b", "5");
  completeRouteRef(obj, "c", "5");
  assert.equal(obj.get("a").tags.route_ref, "2;5;10");
  assert.ok(!("route_ref" in obj.get("b").tags));
  assert.ok(!obj.modified.has("c"));
});

test("enrich numbers other networks and keeps survey tags", () => {
  const obj = new Store({ nP: node(49, 1, { network: "Twisto", ref: "X1", wheelchair: "no", highway: "platform" }) });
  enrich(obj, "nP", { network: "Nomad", "network:wikidata": "Q1", ref: "Y2", wheelchair: "yes", highway: "bus_stop", name: "Gare" });
  const t = obj.get("nP").tags;
  assert.deepEqual([t.network, t["network:2"], t["network:wikidata:Nomad"]], ["Twisto", "Nomad", "Q1"]);
  assert.deepEqual([t.ref, t["ref:Nomad"], t["ref:2"]], ["X1", "Y2", undefined]);
  assert.ok(t.wheelchair === "no" && t.highway === "platform" && !("wheelchair:2" in t));
  assert.equal(t.name, "Gare");
});

// node 2022995512, Hippodrome (Caen), as it is in OSM
const HIPPODROME = () => ({ "gtfs:stop_id": "FR:14118:ZE:hipp02:ATOUMOD029", "gtfs:stop_id:2": "FR:14118:ZE:1151877:ATOUMOD040", name: "Hippodrome", network: "Twisto", "network:2": "Nomad",
  "network:wikidata": "Q3537947", "network:wikidata:2": "Q98131290", ref: "hipp02", "ref:2": "14CAE21B", "ref:FR:Atoumod": "FR:14118:ZE:hipp02:ATOUMOD029", "ref:FR:Atoumod:2": "FR:14118:ZE:1151877:ATOUMOD040" });
const NOMAD_STOP = { network: "Nomad", ref: "14CAE21B", "ref:FR:Atoumod": "FR:14118:ZE:1151877:ATOUMOD040" };
const noNumberedRef = (t) => assert.deepEqual(Object.keys(t).filter((k) => /^(?:local_)?ref.*:\d+$/.test(k)), []);

test("Hippodrome: ref stays with Twisto, Nomad gets its name instead of a number", () => {
  settings.stop_ref_tags = ["ref:FR:Atoumod"];
  const obj = new Store({ n1: node(49, 1, HIPPODROME()) });
  enrich(obj, "n1", NOMAD_STOP);
  const t = obj.get("n1").tags;
  assert.equal(t.ref, "hipp02");
  assert.equal(t["ref:Nomad"], "14CAE21B");
  assert.equal(t["ref:FR:Atoumod"], "FR:14118:ZE:hipp02:ATOUMOD029");
  assert.equal(t["ref:FR:Atoumod:Nomad"], "FR:14118:ZE:1151877:ATOUMOD040");
  assert.deepEqual([t.network, t["network:2"]], ["Twisto", "Nomad"]);
  noNumberedRef(t);
});

test("a stop has one ref per network: the second one, across the road, is dropped; a key has no space", () => {
  const obj = new Store({ n1: node(49, 1, { network: "Twisto", "network:2": "Nomad", ref: "lyla12", "ref:2": "14CAE42A", "ref:3": "14CAE42B" }), n2: node(49, 1, { network: "Twisto", ref: "a" }) });
  enrich(obj, "n1", { network: "Twisto", ref: "lyla12" });
  assert.equal(obj.get("n1").tags["ref:Nomad"], "14CAE42A");
  noNumberedRef(obj.get("n1").tags);
  enrich(obj, "n2", { network: "Argentan bus", ref: "b" });
  assert.equal(obj.get("n2").tags["ref:Argentan_bus"], "b");
});

test("the local network takes over a stop from the regional one", () => {
  settings.stop_ref_tags = ["ref:FR:Atoumod"];
  const sizes = new Map([["Twisto", 900], ["Nomad Car", 7000]]); // the feed's name of the Nomad of OSM
  const obj = new Store({ n1: node(49, 1, { network: "Nomad", "network:wikidata": "Q9", ref: "14CAE21B", "ref:FR:Atoumod": "N", "gtfs:stop_code:FR-X": "14CAE21B" }) });
  enrich(obj, "n1", { network: "Twisto", "network:wikidata": "Q3", ref: "hipp02", "ref:FR:Atoumod": "T", "gtfs:stop_code:FR-X": "hipp02" }, sizes);
  const t = obj.get("n1").tags;
  assert.deepEqual([t.network, t["network:wikidata"], t["network:2"], t["network:wikidata:Nomad"]], ["Twisto", "Q3", "Nomad", "Q9"]);
  assert.deepEqual([t.ref, t["ref:Nomad"], t["ref:FR:Atoumod"], t["ref:FR:Atoumod:Nomad"]], ["hipp02", "14CAE21B", "T", "N"]);
  assert.deepEqual([t["gtfs:stop_code:FR-X"], t["gtfs:stop_code:FR-X:Nomad"]], ["hipp02", "14CAE21B"]);
  // the regional one coming back changes nothing
  enrich(obj, "n1", { network: "Nomad", "network:wikidata": "Q9", ref: "14CAE21B", "ref:FR:Atoumod": "N" }, sizes);
  assert.deepEqual([obj.get("n1").tags.ref, obj.get("n1").tags["ref:Nomad"], obj.get("n1").tags.network], ["hipp02", "14CAE21B", "Twisto"]);
  noNumberedRef(obj.get("n1").tags);
});

test("a ref written a;b keeps one value, the GTFS gives the value of its network", () => {
  const obj = new Store({ n1: node(49, 1, { network: "Twisto", "network:2": "Nomad", ref: "a;b", "ref:Nomad": "c;d" }) });
  enrich(obj, "n1", { network: "Twisto", ref: "e" });
  assert.deepEqual([obj.get("n1").tags.ref, obj.get("n1").tags["ref:Nomad"]], ["e", "c"]);
});

// Two stops face to face, a single OSM platform on the east kerb
const faceToFace = (holders) => {
  const s = makeStops([gtfsStop("E", "42A", 49.0005, EAST), gtfsStop("W", "42B", 49.0005, WEST)], holders ? { holders } : {});
  const obj = new Store({ nP: node(49.0005, 1.00018, { name: "Laplace" }) });
  const on = () => new Map([["nP", [NOMAD, [49.0005, 1.00018], "bus"]]]);
  return [obj, s, new Map([["W", on()], ["E", on()]])];
};

test("stops face to face on one platform: the ref and stop_id of the nearest one only", () => {
  const [obj, s, assignments] = faceToFace();
  tagPlatforms(obj, s, assignments);
  const t = obj.get("nP").tags;
  assert.deepEqual([t.ref, t["gtfs:stop_id"]], ["42A", "E"]);
  assert.ok(!Object.values(t).some((v) => v === "42B" || v === "W" || v.includes(";")));
});

test("one physical stop for two networks: an id for each, the one across the road removed (Lycée Laplace)", () => {
  settings.feed = "FR-X";
  settings.stop_ref_tags = ["ref:FR:Atoumod"];
  const ofStop = new Map([["T", new Set(["Twisto"])], ["A", new Set(["Nomad"])], ["B", new Set(["Nomad"])]]);
  const s = makeStops([gtfsStop("B", "42B", 49.0005, EAST, "Laplace")]);
  const obj = new Store({ nP: node(49.0005, EAST, { network: "Twisto", "network:2": "Nomad", ref: "lyla12", "ref:2": "42A", "ref:3": "42B",
    "gtfs:stop_id": "T", "gtfs:stop_id:2": "A", "ref:FR:Atoumod": "T", "ref:FR:Atoumod:2": "A" }) });
  tagPlatforms(obj, s, new Map([["B", new Map([["nP", [NOMAD, [49.0005, EAST], "bus", true]]])]]), { ofStop });
  const t = obj.get("nP").tags;
  assert.deepEqual([t.ref, t["ref:Nomad"]], ["lyla12", "42B"]);
  assert.deepEqual([t["ref:FR:Atoumod"], t["ref:FR:Atoumod:Nomad"]], ["T", "B"]);
  assert.equal(t["gtfs:stop_id:FR-X"], "T;B"); // the stops of the two networks, not the one across the road
  assert.ok(!("gtfs:stop_id" in t) && !("gtfs:stop_id:2" in t));
});

test("stops face to face on one platform: the one on the good side, even further", () => {
  const s = makeStops([gtfsStop("E", "42A", 49.0005, EAST), gtfsStop("W", "42B", 49.0005, WEST)]);
  const obj = new Store({ nP: node(49.0005, WEST, {}) });
  const on = (kerb) => new Map([["nP", [NOMAD, [49.0005, WEST], "bus", kerb]]]);
  tagPlatforms(obj, s, new Map([["W", on(false)], ["E", on(true)]]));
  assert.equal(obj.get("nP").tags.ref, "42A");
});

test("stops face to face: the stop_id it holds already decides, the other one is removed", () => {
  const [obj, s, assignments] = faceToFace({ W: ["nP"] });
  obj.base.get("nP").tags["gtfs:stop_id"] = "W";
  tagPlatforms(obj, s, assignments);
  const t = obj.get("nP").tags;
  assert.deepEqual([t.ref, t["gtfs:stop_id"]], ["42B", "W"]);
});

test("a ref is on one platform: not copied next to the one carrying it", () => {
  const s = makeStops([gtfsStop("E", "42A", 49.0005, EAST)]);
  const obj = new Store({ nP: node(49.0005, EAST, {}), nQ: node(49.0005, WEST, { highway: "bus_stop", network: "Nomad", ref: "42A" }) });
  tagPlatforms(obj, s, new Map([["E", new Map([["nP", [NOMAD, [49.0005, EAST], "bus"]]])]]));
  assert.ok(!("ref" in obj.get("nP").tags));
  assert.equal(obj.get("nP").tags["gtfs:stop_id"], "E"); // the stop itself is still linked
});

test("a ref is on one platform: two stops giving the same code to two platforms, the first only", () => {
  const s = makeStops([gtfsStop("E", "42", 49.0005, EAST), gtfsStop("W", "42", 49.0005, WEST)]);
  const obj = new Store({ nE: node(49.0005, EAST), nW: node(49.0005, WEST) });
  tagPlatforms(obj, s, new Map([["E", new Map([["nE", [NOMAD, [49.0005, EAST], "bus"]]])], ["W", new Map([["nW", [NOMAD, [49.0005, WEST], "bus"]]])]]));
  assert.deepEqual([obj.get("nE").tags.ref, obj.get("nW").tags.ref], ["42", undefined]);
});

test("a ref already on two platforms is reported", () => {
  const lines = [], sink = log.sink;
  log.sink = (level, m) => { if (level === "warn") lines.push(m); };
  const s = makeStops([gtfsStop("E", "1", 49.0005, EAST), gtfsStop("W", "2", 49.0005, WEST)]);
  const obj = new Store({ nE: node(49.0005, EAST, { public_transport: "platform", network: "Twisto", "network:2": "Nomad", ref: "ropo02" }), nW: node(49.0005, WEST, { public_transport: "platform", network: "Twisto", "network:2": "Nomad", ref: "ropo02" }) });
  tagPlatforms(obj, s, new Map([["E", new Map([["nE", [NOMAD, [49.0005, EAST], "bus"]]])], ["W", new Map([["nW", [NOMAD, [49.0005, WEST], "bus"]]])]]));
  log.sink = sink;
  assert.ok(lines.some((m) => m.includes("ref ropo02 of Twisto is on both nE and nW")), lines.join("|"));
});

test("another network may use the same code, and a platform changing its ref frees the old one", () => {
  const s = makeStops([gtfsStop("E", "42A", 49.0005, EAST), gtfsStop("W", "42B", 49.0005, WEST)]);
  const obj = new Store({ nE: node(49.0005, EAST, {}), nW: node(49.0005, WEST, { highway: "bus_stop", network: "Nomad", ref: "42A" }), nT: node(49, 1, { highway: "bus_stop", network: "Twisto", ref: "42B" }) });
  tagPlatforms(obj, s, new Map([["E", new Map([["nE", [NOMAD, [49.0005, EAST], "bus"]]])], ["W", new Map([["nW", [NOMAD, [49.0005, WEST], "bus"]]])]]));
  assert.deepEqual([obj.get("nE").tags.ref, obj.get("nW").tags.ref], ["42A", "42B"]);
});

test("the settings can name the owner, whatever the sizes", () => {
  settings.stop_owners = ["Nomad"];
  const sizes = new Map([["Twisto", 900], ["Nomad", 7000]]);
  const obj = new Store({ n1: node(49, 1, { network: "Twisto", ref: "hipp02" }) });
  enrich(obj, "n1", { network: "Nomad", ref: "14CAE21B" }, sizes);
  assert.deepEqual([obj.get("n1").tags.network, obj.get("n1").tags.ref, obj.get("n1").tags["ref:Twisto"]], ["Nomad", "14CAE21B", "hipp02"]);
});

test("stop served both ways without direction_id gets a platform per side", () => {
  const obj = street({ nE: node(49.0005, EAST, { name: "Milieu" }), nW: node(49.0005, WEST, { name: "Milieu" }) });
  const candidate = (id, lon) => ({ id, pos: [49.0005, lon], name: "Milieu", holder: false, sameName: true });
  const stops = makeStops([gtfsStop("S", "", 48.9997, 1.0, "Sud"), gtfsStop("M", "", 49.0005, 1.00001, "Milieu"), gtfsStop("N", "", 49.0013, 1.0, "Nord")],
    { platforms: { S: [], N: [], M: [candidate("nE", EAST), candidate("nW", WEST)] } });
  const [[rn, rs]] = build([variant("0", ["S", "M", "N"], "t1", ["wS", "wR", "wN"]), variant("0", ["N", "M", "S"], "t2", ["wN", "wR", "wS"])], stops, obj);
  const platform = (rel) => rel.members.filter(([, role]) => role === "platform")[1][0];
  assert.deepEqual([platform(rn), platform(rs)], ["nE", "nW"]);
});

test("enrich: the name of an OSM platform saying its town is corrected, official_name replaced", () => {
  const obj = new Store({ n1: { lat: 49, lon: 0, tags: { public_transport: "platform", highway: "bus_stop", name: "MONDEVILLE - Charlotte Corday", official_name: "Corday" } } });
  enrich(obj, "n1", { name: "Charlotte Corday", official_name: "MONDEVILLE - Charlotte Corday", network: "Twisto" });
  const { tags } = obj.get("n1");
  assert.deepEqual([tags.name, tags.official_name], ["Charlotte Corday", "MONDEVILLE - Charlotte Corday"]);
  assert.equal(tags["official_name:2"], undefined);
});

// --- a stop_position closer to the opposite stop (stop_position_own)

for (const [what, lat, after, pos, rival, own, off] of [
  ["a few metres away, in front of the rival: shared rather than duplicated", 49.00048, "r2", [49.0004, EAST], [49.00048, WEST], "nSP", "nSP"],
  ["further than stop_position_shared_m, in front of the rival", 49.00052, "r3", [49.0004, EAST], [49.00052, WEST], null, null],
  ["nearly face to face, closer to the rival", 49.000508, "r3", [49.0004, EAST], [49.00047, WEST], null, "nSP"],
  ["in front of this stop, the rival further on", 49.0004, "r2", [49.0004, EAST], [49.0006, WEST], "nSP", "nSP"],
  ["stops facing each other share it", 49.0005, "r3", [49.0004, EAST], [49.0004, WEST], "nSP", "nSP"],
  ["within 2 m along the road", 49.00044, "r2", [49.0004, EAST], [49.00041, WEST], "nSP", "nSP"],
  ["a stop on the same side is not opposite", 49.00048, "r2", [49.0004, EAST], [49.00048, EAST], "nSP", "nSP"],
  ["a stop on another road is not opposite", 49.00048, "r2", [49.0004, EAST], [49.00048, 1.002], "nSP", "nSP"],
]) {
  test(`stop_position_own: ${what}`, () => {
    const objs = () => withStopPosition(street(), "nSP", lat, after);
    assert.equal(locateStop(objs(), ["wR"], pos, { rivals: [rival] }).node, own);
    assert.equal(locateStop(objs(), ["wR"], pos, { platform: true, opposites: [rival] }).node, own);
    settings.stop_position_own = false;
    assert.equal(locateStop(objs(), ["wR"], pos, { rivals: [rival] }).node, off);
    settings.stop_position_own = true;
  });
}

test("stop_position_own: a platform set back from the road does not lose to one on the kerb", () => {
  const obj = withStopPosition(street(), "nSP", 49.0004, "r2");
  assert.equal(locateStop(obj, ["wR"], [49.0004, 1.0005], { rivals: [[49.0004, 0.99995]] }).node, "nSP");
});

test("stop_position_own: on by default, the new one stands in front of this stop", () => {
  assert.equal(settings.stop_position_own, true);
  const spot = locateStop(withStopPosition(street(), "nSP", 49.00052, "r3"), ["wR"], [49.0004, EAST], { rivals: [[49.00052, WEST]] });
  assert.equal(spot.node, null);
  approx(spot.pos[0], 49.0004, 0.00002);
});

test("stop_refs_from_gtfs off: the codes of the GTFS are not written, the ref of OSM stays", () => {
  settings.stop_refs_from_gtfs = false;
  settings.ref_from_stop_id = "yes";
  const stop = { stop_name: "Gare", stop_code: "WRONG" };
  const tags = stopTags(stop, "FR:14118:ZE:code:X", { network: "Twisto" });
  assert.equal(tags.ref, undefined);
  assert.equal(tags["gtfs:stop_code"], undefined);
  assert.equal(tags["gtfs:stop_id"], "FR:14118:ZE:code:X");
  const obj = new Store({ n1: { lat: 49, lon: 1, tags: { name: "Gare", network: "Twisto", ref: "GOOD" } } });
  enrich(obj, "n1", tags);
  assert.equal(obj.get("n1").tags.ref, "GOOD");
});

test("choosePlatform: its stop_id, then its ref, then the nearest; the kerb side first", () => {
  const stop = [49.0005, EAST];
  const at = (id, lat, lon, more = {}) => ({ id, pos: [lat, lon], name: id, holder: false, byRef: false, far: false, ...more });
  const near = at("near", 49.0005, EAST, { sameName: true }), byRef = at("byRef", 49.0007, EAST, { byRef: true }), holder = at("holder", 49.0008, EAST, { holder: true });
  assert.equal(choosePlatform([near, byRef], stop, { segment: SEGMENT }).id, "byRef");
  assert.equal(choosePlatform([near, byRef, holder], stop, { segment: SEGMENT }).id, "holder");
  assert.equal(choosePlatform([near, at("across", 49.0005, WEST, { byRef: true })], stop, { segment: SEGMENT }).id, "near");
  assert.equal(choosePlatform([at("far", 49.0005, WEST, { byRef: true, far: true })], stop, { segment: SEGMENT }), null);
});

test("fixSide: a platform with the ref of this stop only stays its own, even closer to the stop across", () => {
  const platform = { id: "nP", pos: [49.0005, EAST], name: "X", holder: false, byRef: true };
  const stopsWith = (refHolders) => new Stops(new Map([["A", gtfsStop("A", "10A", 49.0005, WEST)], ["B", gtfsStop("B", "10B", 49.0005, EAST)]]), new Map([["A", [platform]], ["B", []]]), new Map([["A", ["B"]], ["B", ["A"]]]), new Map(), new Map(), new Map(Object.entries(refHolders).map(([k, v]) => [k, new Set(v)])));
  assert.equal(fixSide("A", platform, SEGMENT, stopsWith({ A: ["nP"] }))[1], "A");
  assert.equal(fixSide("A", platform, SEGMENT, stopsWith({ A: ["nP"], B: ["nP"] }))[1], "B"); // both: nothing told apart, the nearest
  assert.equal(fixSide("A", { ...platform, byRef: false }, SEGMENT, stopsWith({ B: ["nP"] }))[1], "B");
});

test("the order of choosePlatform: its ref, its name, then a very close platform nobody else has", () => {
  const stop = [49.0005, EAST];
  const at = (id, lat, lon, more = {}) => ({ id, pos: [lat, lon], name: id, holder: false, byRef: false, sameName: false, claimed: false, far: false, ...more });
  const close = at("close", 49.00055, EAST); // 6 m, another name
  const named = at("named", 49.0007, EAST, { sameName: true }); // 22 m
  const choose = (...candidates) => choosePlatform(candidates, stop, { segment: SEGMENT })?.id ?? null;
  assert.equal(choose(close, named), "named");
  assert.equal(choose(close), "close");
  assert.equal(choose({ ...close, name: null }), "close");
  assert.equal(choose({ ...close, claimed: true }), null); // the ref or the name of another stop: a new platform
  assert.equal(choose(at("further", 49.0007, EAST)), null); // 22 m, another name
  settings.thresholds.platform_unclaimed_m = 25;
  assert.equal(choose(at("further", 49.0007, EAST)), "further");
  settings.thresholds.platform_unclaimed_m = 0;
  assert.equal(choose(close), null);
});

test("fixSide: the platform with the ref across the road gives the stop opposite, even when the GTFS position is on the kerb side", () => {
  const across = { id: "nW", pos: [49.0005, WEST], name: "H", holder: false, byRef: true };
  const kerbOfB = { id: "nE", pos: [49.0005, EAST], name: "H", holder: false, byRef: true };
  const s = makeStops([gtfsStop("A", "10A", 49.0005, EAST), gtfsStop("B", "10B", 49.0005, WEST)], { neighbours: { A: ["B"], B: ["A"] }, rivals: { A: ["B"], B: ["A"] }, platforms: { A: [across], B: [kerbOfB] } });
  assert.deepEqual(fixSide("A", null, SEGMENT, s).map((x) => x?.id ?? x), ["nE", "B"]);
});

test("fixSide: a single pole across the road, only with no stop on the other side", () => {
  const pole = { id: "nW", pos: [49.0005, WEST], name: "H", holder: false, sameName: true, far: false };
  const stopsWith = (more = {}) => makeStops([gtfsStop("A", "", 49.0005, EAST), gtfsStop("T", "", 49.0005, WEST)], { platforms: { A: [pole], T: [] }, ...more });
  assert.equal(fixSide("A", null, SEGMENT, stopsWith())[0].id, "nW");
  assert.equal(fixSide("A", null, SEGMENT, stopsWith({ rivals: { A: ["T"], T: ["A"] } }))[0], null); // it is the one of the stop opposite: a new platform
  const other = { ...pole, sameName: false };
  assert.equal(fixSide("A", null, SEGMENT, makeStops([gtfsStop("A", "", 49.0005, EAST)], { platforms: { A: [other] } }))[0], null); // nothing says it is this stop
  assert.equal(fixSide("A", null, SEGMENT, makeStops([gtfsStop("A", "", 49.0005, EAST)], { platforms: { A: [{ ...pole, far: true }] } }))[0], null); // too far to be a pole
});

test("a platform taken with neither the ref nor the name of the stop is reported, one with them is not", () => {
  const candidate = (more) => ({ id: "nE", pos: [49.0005, EAST], name: "Autre", holder: false, byRef: false, sameName: false, claimed: false, far: false, ...more });
  const warnings = (c) => {
    const obj = street({ nE: node(49.0005, EAST, { name: "Autre" }) });
    const stops = makeStops([gtfsStop("S", "", 48.9997, 1.0, "Sud"), gtfsStop("M", "", 49.0005, EAST, "Milieu"), gtfsStop("N", "", 49.0013, 1.0, "Nord")], { platforms: { S: [], N: [], M: [c] } });
    const seen = [], sink = log.sink;
    log.sink = (level, message) => { if (level === "warn") seen.push(message); };
    try {
      build([variant("0", ["S", "M", "N"], "t1", ["wS", "wR", "wN"])], stops, obj);
    } finally {
      log.sink = sink;
    }
    return seen.filter((m) => m.includes("rather than duplicated"));
  };
  assert.equal(warnings(candidate()).length, 1);
  assert.match(warnings(candidate())[0], /Milieu \(M\): nE "Autre"/);
  assert.equal(warnings(candidate({ sameName: true })).length, 0);
  assert.equal(warnings(candidate({ byRef: true })).length, 0);
});

test("a stop_position keeps its local_ref: it tells which bay it is", () => {
  assert.deepEqual(stopPositionOnly({ public_transport: "stop_position", bus: "yes", local_ref: "C", ref: "14CAE09C" }, "Gare Routière").tags,
    { public_transport: "stop_position", bus: "yes", local_ref: "C", name: "Gare Routière" });
});
