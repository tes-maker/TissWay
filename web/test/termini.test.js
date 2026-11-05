// The ends of a line: a wider search for their stop_position, a trace stopping exactly there, and complete relations left as they are.
import assert from "node:assert/strict";
import { beforeEach, afterEach, test } from "node:test";
import { makeZip } from "./helpers.js";
import { Feed } from "../src/gtfs.js";
import { clearCaches, services } from "../src/net.js";
import { runRoutes } from "../src/pipeline.js";
import { configure, settings } from "../src/settings.js";

const LAT = (i) => 49 + i * 0.00025; // about 28 m apart
const node = (id, tags = {}, lon = 1) => ({ type: "node", id, version: 2, lat: LAT(id), lon, tags });
const way = (id, nodes, tags = {}) => ({ type: "way", id, version: 3, nodes, tags: { highway: "residential", oneway: "yes", ...tags } });
const stopPosition = (id, name = "") => node(id, { public_transport: "stop_position", bus: "yes", ...(name ? { name } : {}) });
const platform = (id, at, name) => ({ ...node(id, { public_transport: "platform", highway: "bus_stop", name }, 1.00015), lat: LAT(at) });

function encode(points) {
  let out = "", plat = 0, plon = 0;
  const one = (v) => {
    let x = v < 0 ? ~(v << 1) : v << 1;
    while (x >= 0x20) { out += String.fromCharCode((0x20 | (x & 0x1f)) + 63); x >>>= 5; }
    out += String.fromCharCode(x + 63);
  };
  for (const [lat, lon] of points) {
    const a = Math.round(lat * 1e6), b = Math.round(lon * 1e6);
    one(a - plat); one(b - plon);
    plat = a; plon = b;
  }
  return out;
}

let world;
const realFetch = globalThis.fetch;
beforeEach(() => {
  configure();
  clearCaches();
  Object.assign(services, { valhalla_interval_ms: 0, lookup_interval_ms: 0 });
  Object.assign(settings, { driving_side: "right", fix_accents: false, network_auto: false, feed: "" });
  world = { elements: [], platforms: [], relations: [], around: [], matched: [1, 2], shape: [0, 4], valhalla: 0, aroundAsked: 0 };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url), json = (body) => new Response(JSON.stringify(body));
    if (u.endsWith("/status")) return json({ version: "test" });
    if (u.includes("/reverse?")) return json({ address: { country_code: "fr" } });
    if (u.endsWith("/trace_attributes")) {
      world.valhalla++;
      const [a, b] = world.shape;
      const shape = Array.from({ length: b - a + 1 }, (_, i) => [LAT(a + i), 1]);
      return json({ edges: world.matched.map((way_id) => ({ way_id })), shape: encode(shape) });
    }
    if (u.includes("overpass")) {
      const q = decodeURIComponent(init.body.slice(5));
      if (q.includes("around:")) { world.aroundAsked++; return json({ elements: world.around }); }
      if (q.includes("highway=bus_stop")) return json({ elements: world.platforms });
      if (q.includes("rel(bw)")) return json({ elements: [] });
      if (q.includes("route_master")) return json({ elements: world.relations });
      return json({ elements: world.elements });
    }
    throw new Error(`unexpected call: ${u}`);
  };
});
afterEach(() => { globalThis.fetch = realFetch; configure(); });

/** A line with these stops [id, name, position along the road], travelled northwards. */
async function line(stops, others = []) {
  const zip = {
    "agency.txt": "agency_id,agency_name\nAG,Bustown\n",
    "routes.txt": "route_id,agency_id,route_short_name,route_type\nR1,AG,1,3\n",
    "trips.txt": "route_id,service_id,trip_id,shape_id\nR1,S,t1,sh1\n",
    "stops.txt": `stop_id,stop_name,stop_lat,stop_lon\n${[...stops, ...others].map(([id, name, at, lon = 1.00015]) => `${id},${name},${LAT(at)},${lon}`).join("\n")}\n`,
    "stop_times.txt": `trip_id,stop_id,stop_sequence\n${stops.map(([id], i) => `t1,${id},${i + 1}`).join("\n")}\n`,
    "shapes.txt": `shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n${stops.map(([, , at], i) => `sh1,${LAT(at)},1,${i + 1}`).join("\n")}\n`,
  };
  const { state, summary, xml } = await runRoutes(await Feed.open(makeZip(zip)), { network: "Bustown", ref: "1" });
  const { obj } = state;
  const [key, rel] = [...obj.modified].find(([k, o]) => k[0] === "r" && o.tags.type === "route");
  const nodesOf = (ref) => obj.get(ref).nodes;
  return { obj, key, rel, summary, xml, ways: rel.members.filter(([ref]) => ref[0] === "w").map(([ref]) => ref), stops: rel.members.filter(([, r]) => r === "stop").map(([ref]) => ref), nodesOf,
    created: [...obj.modified].filter(([k, o]) => k.startsWith("n-") && o.tags.public_transport === "stop_position").map(([k]) => k) };
}

const relation = (members) => ({ type: "relation", id: 30, version: 9, tags: { type: "route", route: "bus", ref: "1", network: "Bustown" },
  members: members.map(([type, ref, role]) => ({ type, ref, role })) });

function correctLine() {
  world.elements = [stopPosition(0), node(1), stopPosition(2), node(3), stopPosition(4), way(1, [0, 1, 2]), way(2, [2, 3, 4])];
  world.platforms = [platform(100, 0, "Alpha"), platform(101, 2, "Bravo"), platform(102, 4, "Charlie")];
  world.relations = [relation([["node", 0, "stop"], ["node", 100, "platform"], ["node", 2, "stop"], ["node", 101, "platform"], ["node", 4, "stop"], ["node", 102, "platform"], ["way", 1, ""], ["way", 2, ""]])];
}
const ABC = [["A", "Alpha", 0], ["B", "Bravo", 2], ["C", "Charlie", 4]];

test("a complete relation is left as it is: same ways, no way modified, no Valhalla", async () => {
  correctLine();
  const { obj, rel, summary, created } = await line(ABC);
  assert.equal(summary["complete relations"], 1);
  assert.equal(world.valhalla, 0);
  assert.deepEqual(rel.members.filter(([ref]) => ref[0] === "w").map(([ref]) => ref), ["w1", "w2"]);
  assert.deepEqual(rel.members.map(([ref]) => ref), ["n0", "n100", "n2", "n101", "n4", "n102", "w1", "w2"]);
  assert.deepEqual(created, []);
  assert.deepEqual([...obj.modified.keys()].filter((k) => k[0] === "w"), []);
  assert.equal(rel.tags.from, "Alpha"); // its tags are still completed
  assert.equal(obj.get("n100").tags.network, "Bustown");
});

test("a complete relation has its internal data out of the file", async () => {
  correctLine();
  const { xml } = await line(ABC);
  assert.ok(!xml.includes("complete"));
});

test("not complete: a platform missing", async () => {
  correctLine();
  world.relations[0].members = world.relations[0].members.filter((m) => m.ref !== 101);
  assert.equal((await line(ABC)).summary["complete relations"], 0);
});

test("not complete: stops in another order", async () => {
  correctLine();
  const { summary } = await line([["A", "Alpha", 0], ["C", "Charlie", 4], ["B", "Bravo", 2]]);
  assert.equal(summary["complete relations"], 0);
});

test("not complete: a platform across the road", async () => {
  correctLine();
  world.platforms[1] = { ...world.platforms[1], lon: 0.99985 };
  assert.equal((await line(ABC)).summary["complete relations"], 0);
});

test("not complete: the trace goes on after the last stop_position, and is then cut there", async () => {
  correctLine();
  world.elements = [stopPosition(0), node(1), stopPosition(2), stopPosition(3), node(4), way(1, [0, 1, 2]), way(2, [2, 3, 4])];
  world.relations[0].members = world.relations[0].members.map((m) => (m.ref === 4 ? { ...m, ref: 3 } : m));
  world.platforms[2] = platform(102, 3, "Charlie");
  const { summary, ways, stops, nodesOf, created } = await line([["A", "Alpha", 0], ["B", "Bravo", 2], ["C", "Charlie", 3]]);
  assert.equal(summary["complete relations"], 0);
  assert.equal(world.valhalla, 0); // the trace itself is still good
  assert.deepEqual(created, []);
  assert.equal(nodesOf(ways.at(-1)).at(-1), stops.at(-1));
});

test("the trace stops exactly at the stop_positions: ways beyond them left out, the others cut", async () => {
  world.elements = [node(0), stopPosition(1), node(2), stopPosition(3), node(4), node(5), way(1, [0, 1, 2]), way(2, [2, 3, 4]), way(3, [4, 5])];
  world.platforms = [platform(100, 1, "Alpha"), platform(101, 3, "Charlie")];
  world.matched = [1, 2, 3];
  world.shape = [0, 5];
  const { ways, stops, nodesOf, created } = await line([["A", "Alpha", 1], ["C", "Charlie", 3]]);
  assert.deepEqual(created, []);
  assert.deepEqual(stops, ["n1", "n3"]);
  assert.equal(ways.length, 2);
  assert.equal(nodesOf(ways[0])[0], "n1");
  assert.equal(nodesOf(ways.at(-1)).at(-1), "n3");
  assert.ok(!ways.includes("w3"));
});

test("a stop_position at the junction of two ways: the way ending there is left out", async () => {
  world.elements = [node(0), node(1), stopPosition(2), node(3), stopPosition(4), way(1, [0, 1, 2]), way(2, [2, 3, 4])];
  world.platforms = [platform(100, 2, "Alpha"), platform(101, 4, "Charlie")];
  const { ways } = await line([["A", "Alpha", 2], ["C", "Charlie", 4]]);
  assert.deepEqual(ways, ["w2"]);
});

test("a terminus finds a stop_position beyond the usual reach, rather than a duplicate", async () => {
  world.elements = [node(0), node(1), node(2), node(3), node(4), node(5), stopPosition(6, "Charlie"), node(8), way(1, [0, 1, 2, 3, 4, 5, 6, 8])];
  world.matched = [1];
  world.shape = [0, 4];
  const { created, stops } = await line([["A", "Alpha", 0], ["C", "Charlie", 4]]);
  assert.equal(stops.at(-1), "n6"); // about 56 m beyond the GTFS stop
  assert.equal(created.length, 1); // only the stop_position of A
});

test("its reach is its own setting", async () => {
  world.elements = [node(0), node(1), node(2), node(3), node(4), node(5), stopPosition(6, "Charlie"), node(8), way(1, [0, 1, 2, 3, 4, 5, 6, 8])];
  world.matched = [1];
  settings.thresholds.terminus_m = 40;
  const { stops } = await line([["A", "Alpha", 0], ["C", "Charlie", 4]]);
  assert.notEqual(stops.at(-1), "n6");
});

test("a stop in the middle of the line keeps the usual reach", async () => {
  world.elements = [node(0), node(1), node(2), node(3), stopPosition(5, "Bravo"), node(6), node(8), way(1, [0, 1, 2, 3, 5, 6, 8])];
  world.matched = [1];
  world.shape = [0, 8];
  const { stops } = await line([["A", "Alpha", 0], ["B", "Bravo", 3], ["C", "Charlie", 8]]);
  assert.notEqual(stops[1], "n5"); // about 56 m away: too far for a stop inside the line
});

test("beyond the usual reach, a stop_position of another name is not taken", async () => {
  world.elements = [node(0), node(1), node(2), node(3), node(4), node(5), stopPosition(6, "Autre"), node(8), way(1, [0, 1, 2, 3, 4, 5, 6, 8])];
  world.matched = [1];
  const { stops } = await line([["A", "Alpha", 0], ["C", "Charlie", 4]]);
  assert.notEqual(stops.at(-1), "n6");
});

test("the terminus takes the stop_position within its reach, and not one further", async () => {
  world.elements = [stopPosition(0), node(1), node(2), node(3), node(4), node(5), stopPosition(6), node(8), way(1, [0, 1, 2, 3, 4, 5, 6, 8])];
  world.matched = [1];
  world.shape = [0, 8];
  // n6 is 56 m from C and 83 m from A: C takes it. A, at n3, has n0 at 83 m: out of reach
  const { stops } = await line([["A", "Alpha", 3], ["C", "Charlie", 8]]);
  assert.notEqual(stops[0], "n0");
  assert.equal(stops[1], "n6");
});

test("the stop_position of the next stop, within the reach of the terminus, is not taken", async () => {
  world.elements = [node(0), node(1), node(2), stopPosition(3), node(4), node(5), way(1, [0, 1, 2, 3, 4, 5])];
  world.matched = [1];
  world.shape = [0, 5];
  const { stops } = await line([["A", "Alpha", 1], ["B", "Bravo", 3], ["C", "Charlie", 5]]); // n3 is 56 m from A, and on B
  assert.notEqual(stops[0], "n3");
  assert.equal(stops[1], "n3");
});

test("the stop_position just beyond the trace: its road is added, no duplicate", async () => {
  world.elements = [node(0), node(1), node(2), way(1, [0, 1, 2])];
  world.matched = [1];
  world.shape = [0, 2];
  world.around = [node(2), node(3), stopPosition(4, "Charlie"), way(2, [2, 3, 4, 5]), node(5)];
  const { ways, stops, nodesOf, created } = await line([["A", "Alpha", 0], ["C", "Charlie", 3]]);
  assert.equal(world.aroundAsked, 1);
  assert.equal(stops.at(-1), "n4");
  assert.equal(created.length, 1); // only the stop_position of A
  assert.equal(nodesOf(ways.at(-1)).at(-1), "n4"); // and the trace stops there
});

test("the road beyond is not taken against its oneway", async () => {
  world.elements = [node(0), node(1), node(2), way(1, [0, 1, 2])];
  world.matched = [1];
  world.shape = [0, 2];
  world.around = [node(2), node(3), stopPosition(4, "Charlie"), way(2, [4, 3, 2])];
  const { stops } = await line([["A", "Alpha", 0], ["C", "Charlie", 3]]);
  assert.notEqual(stops.at(-1), "n4");
});

test("nothing asked around a terminus with its stop_position on the trace", async () => {
  world.elements = [stopPosition(0), node(1), stopPosition(2), way(1, [0, 1, 2])];
  world.matched = [1];
  await line([["A", "Alpha", 0], ["C", "Charlie", 2]]);
  assert.equal(world.aroundAsked, 0);
});

test("the search around the termini failing is not fatal", async () => {
  world.elements = [node(0), node(1), node(2), way(1, [0, 1, 2])];
  world.matched = [1];
  world.shape = [0, 2];
  const fetchOk = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes("overpass") && decodeURIComponent(init.body.slice(5)).includes("around:")) return new Response("{}", { status: 400 });
    return fetchOk(url, init);
  };
  const { stops } = await line([["A", "Alpha", 0], ["C", "Charlie", 2]]);
  assert.equal(stops.length, 2);
});

test("a repeated prefix in the ids of OSM: the relation and its platform are recognised, the file has them corrected", async () => {
  correctLine();
  world.relations[0].tags["gtfs:shape_id:FR-X"] = "NOMAD:NOMAD:sh1";
  world.relations[0].tags["gtfs:route_id:FR-X"] = "NOMAD:NOMAD:R1";
  world.platforms[0].tags["gtfs:stop_id:FR-X"] = "NOMAD:NOMAD:A";
  world.relations.push({ type: "relation", id: 31, version: 4, tags: { type: "route", route: "bus", ref: "1", network: "Bustown", "gtfs:shape_id:FR-X": "NOMAD:NOMAD:old" }, members: [{ type: "way", ref: 2, role: "" }] });
  const { obj, xml } = await line(ABC);
  assert.ok(!xml.includes("NOMAD:NOMAD"));
  assert.equal(obj.get("n100").tags["gtfs:stop_id:FR-X"], "NOMAD:A");
  assert.equal(obj.get("r30").tags["gtfs:route_id:FR-X"], "NOMAD:R1");
  assert.equal(obj.get("r31").tags["gtfs:shape_id:FR-X"], "NOMAD:old"); // a relation no variant uses, still corrected
  assert.ok(!/correctedIds/.test(xml));
  assert.match(xml, /<relation id="31" version="4" action="modify">/);
});

test("a relation of the line with nothing to correct and no variant stays out of the file", async () => {
  correctLine();
  world.relations.push({ type: "relation", id: 31, version: 4, tags: { type: "route", route: "bus", ref: "1", network: "Bustown" }, members: [{ type: "way", ref: 2, role: "" }] });
  const { xml } = await line(ABC);
  assert.ok(!xml.includes('<relation id="31"'));
});

function closerToTheStopAcross() {
  correctLine();
  world.elements = [stopPosition(0), node(1), node(2), stopPosition(3), stopPosition(4), way(1, [0, 1, 2]), way(2, [2, 3, 4])];
  world.relations[0].members = world.relations[0].members.map((m) => (m.ref === 2 && m.role === "stop" ? { ...m, ref: 3 } : m));
}
const ACROSS = [["D", "Delta", 2.7, 0.99985]]; // across the road, next to n3

test("a good relation whose stop_position is closer to the stop across: the stop gets its own, the trace stays", async () => {
  closerToTheStopAcross();
  const { summary, stops, created, ways } = await line(ABC, ACROSS);
  assert.equal(summary["complete relations"], 0);
  assert.equal(world.valhalla, 0);
  assert.equal(created.length, 1);
  assert.equal(stops[1], created[0]);
  assert.deepEqual(ways, ["w1", "w2"]);
});

test("the toggle off: that stop_position stays, the relation is complete", async () => {
  closerToTheStopAcross();
  settings.stop_position_own = false;
  const { summary, stops, created } = await line(ABC, ACROSS);
  assert.equal(summary["complete relations"], 1);
  assert.equal(stops[1], "n3");
  assert.deepEqual(created, []);
});

test("a complete relation with a stop across, each stop_position being nearer its own: still complete", async () => {
  correctLine();
  const { summary } = await line(ABC, [["D", "Delta", 3, 0.99985]]);
  assert.equal(summary["complete relations"], 1);
});

test("a complete relation: its stop_positions are cleaned, its trace stays, what they had goes to the platforms", async () => {
  correctLine();
  Object.assign(world.elements[2].tags, { highway: "bus_stop", shelter: "yes", ref: "X", direction: "forward" });
  const { obj, summary, ways } = await line(ABC);
  assert.equal(summary["complete relations"], 1);
  assert.deepEqual(ways, ["w1", "w2"]);
  assert.deepEqual(obj.get("n2").tags, { public_transport: "stop_position", bus: "yes", name: "Bravo" });
  assert.equal(obj.get("n101").tags.shelter, "yes");
  assert.deepEqual([...obj.modified.keys()].filter((k) => k[0] === "w"), []);
});

