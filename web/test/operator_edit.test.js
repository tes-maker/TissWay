// Adding or removing an operator on one line: this tag only, on what was chosen.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { makeZip } from "./helpers.js";
import { Feed } from "../src/gtfs.js";
import { clearCaches, services } from "../src/net.js";
import { heldByOthers, runOperatorEdit, withOperators } from "../src/operator_edit.js";
import { parseXml } from "../src/osm.js";
import { configure } from "../src/settings.js";
import { summaryText } from "../src/util.js";

const GTFS = {
  "agency.txt": "agency_id,agency_name\nAG,Twisto\n",
  "routes.txt": "route_id,agency_id,route_short_name,route_type\nR1,AG,12,3\nR2,AG,13,3\n",
  "trips.txt": "route_id,service_id,trip_id\nR1,S,t1\nR2,S,t2\n",
  "stops.txt": "stop_id,stop_name,stop_lat,stop_lon\nA,A,49,1\nB,B,49.01,1\n",
  "stop_times.txt": "trip_id,stop_id,stop_sequence\nt1,A,1\nt1,B,2\nt2,B,1\n",
};
const ALL = { routes: true, platforms: true, stops: true };
const node = (id, tags, lat = 49, lon = 1) => ({ type: "node", id, version: 2, lat, lon, tags });
const member = (type, ref, role) => ({ type, ref, role });

let answer;
const realFetch = globalThis.fetch;
beforeEach(() => {
  configure();
  clearCaches();
  Object.assign(services, { valhalla_interval_ms: 0, lookup_interval_ms: 0 });
  answer = {
    objects: [
      node(1, { public_transport: "platform", highway: "bus_stop", name: "A", network: "Twisto", "gtfs:stop_id:FR-X": "NOMAD:NOMAD:A", "network:2": "Other" }),
      node(2, { public_transport: "stop_position", bus: "yes", name: "A" }),
      node(3, { public_transport: "platform", highway: "bus_stop", name: "B", network: "Twisto;Nomad", operator: "Keolis" }, 49.01),
    ],
    relations: [
      { type: "relation", id: 30, version: 5, tags: { type: "route", route: "bus", ref: "12", network: "Twisto", name: "not  the form", "gtfs:shape_id:FR-X": "NOMAD:NOMAD:sh" }, members: [member("node", 2, "stop"), member("node", 1, "platform"), member("node", 3, "platform_exit_only"), member("way", 7, "")] },
      { type: "relation", id: 31, version: 5, tags: { type: "route_master", route_master: "bus", ref: "12", network: "Twisto", name: "M" }, members: [member("relation", 30, "")] },
      { type: "relation", id: 32, version: 5, tags: { type: "route", route: "bus", ref: "13", network: "Twisto", name: "Other line", operator: "Keolis" }, members: [member("node", 3, "platform")] },
    ],
  };
  globalThis.fetch = async (url, init = {}) => {
    const json = (body) => new Response(JSON.stringify(body));
    if (!String(url).includes("overpass")) throw new Error(`unexpected call: ${url}`);
    const q = decodeURIComponent(init.body.slice(5));
    if (q.includes("relation(bn)") || q.includes("relation(bw)")) return json({ elements: answer.ofStops ?? answer.relations });
    return json({ elements: q.includes("route_master") ? answer.relations : answer.objects });
  };
});
afterEach(() => { globalThis.fetch = realFetch; configure(); });

const run = async (options) => runOperatorEdit(await Feed.open(makeZip(GTFS)), { network: "Twisto", routeId: "R1", operator: "Keolis", action: "add", targets: ALL, ...options });
const read = (xml) => new Map(parseXml(xml).children.map((e) => [`${e.name[0]}${e.attrs.id}`, { ...e.attrs, members: e.children.filter((c) => c.name === "member").map((c) => c.attrs.ref), tags: Object.fromEntries(e.children.filter((c) => c.name === "tag").map((c) => [c.attrs.k, c.attrs.v])) }]));

test("withOperators: added once, in its place, removed, changed in place, nothing left", () => {
  assert.equal(withOperators(undefined, { add: ["K"] }), "K");
  assert.equal(withOperators("A", { add: ["K"] }), "A;K");
  assert.equal(withOperators("A", { add: ["K"], first: true }), "K;A");
  assert.equal(withOperators("A;K", { add: ["K"] }), "A;K");
  assert.equal(withOperators("A;K", { remove: ["K"] }), "A");
  assert.equal(withOperators("K", { remove: ["K"] }), undefined);
  assert.equal(withOperators("A;K;C", { remove: ["K"], add: ["N"] }), "A;N;C");
  assert.equal(withOperators("A; K", { add: ["K"] }), "A; K"); // nothing changes: not even the spelling
  assert.equal(withOperators("A; B", { remove: ["K"] }), "A; B");
});

test("heldByOthers: what another line has, what a line without an operator may have, nothing without another line", () => {
  assert.deepEqual(heldByOthers(["K"], [new Set(["K"])]), { used: ["K"], unsure: [] });
  assert.deepEqual(heldByOthers(["K"], [new Set(["R"])]), { used: [], unsure: [] });
  assert.deepEqual(heldByOthers(["K"], [new Set(["R"]), new Set()]), { used: [], unsure: ["K"] });
  assert.deepEqual(heldByOthers(["K"]), { used: [], unsure: [] });
});

test("added on the relations, platforms and stop_positions of the line, and not on another line", async () => {
  const { xml, summary } = await run();
  const out = read(xml);
  for (const key of ["r30", "r31", "n1", "n2"]) {
    assert.equal(out.get(key).tags.operator, "Keolis", key);
    assert.equal(out.get(key).action, "modify", key);
  }
  assert.ok(!out.has("r32"));
  assert.ok(!out.has("n3")); // already has it
  assert.deepEqual(summary, { "Routes changed": "1 of 1", "Route_masters changed": "1 of 1", "Platforms changed": "1 of 2", "Stop_positions changed": "1 of 1" }); // n3 already has it
});

test("only operator changes: the other tags and the members stay exactly as mapped", async () => {
  const out = read((await run()).xml);
  assert.deepEqual(out.get("n1").tags, { ...answer.objects[0].tags, operator: "Keolis" });
  assert.deepEqual(out.get("n2").tags, { ...answer.objects[1].tags, operator: "Keolis" });
  assert.deepEqual(out.get("r30").tags, { ...answer.relations[0].tags, operator: "Keolis" });
  assert.deepEqual(out.get("r30").members, ["2", "1", "3", "7"]);
  assert.equal(out.get("r30").version, "5");
  assert.equal(out.get("n1").lat, "49.0000000");
});

test("only what was chosen", async () => {
  let out = read((await run({ targets: { routes: true, platforms: false, stops: false } })).xml);
  assert.deepEqual([...out.keys()].sort(), ["r30", "r31"]);
  out = read((await run({ targets: { routes: false, platforms: true, stops: false } })).xml);
  assert.deepEqual([...out.keys()], ["n1"]);
  out = read((await run({ targets: { routes: false, platforms: false, stops: true } })).xml);
  assert.deepEqual([...out.keys()], ["n2"]);
});

test("on a shared platform: first when the network of the line is first, else last", async () => {
  answer.objects[2].tags.operator = "RATP Dev";
  assert.equal(read((await run()).xml).get("n3").tags.operator, "Keolis;RATP Dev");
  clearCaches();
  answer.objects[2].tags.network = "Nomad;Twisto";
  assert.equal(read((await run()).xml).get("n3").tags.operator, "RATP Dev;Keolis");
});

test("removed, and the tag goes with its last value", async () => {
  answer.objects[0].tags.operator = "Keolis;RATP Dev";
  answer.objects[1].tags.operator = "Keolis";
  answer.relations[0].tags.operator = "Keolis";
  const out = read((await run({ action: "remove" })).xml);
  assert.equal(out.get("n1").tags.operator, "RATP Dev");
  assert.ok(!("operator" in out.get("n2").tags));
  assert.ok(!("operator" in out.get("r30").tags));
});

test("removed: stays on a stop another line with this operator uses, and is reported", async () => {
  answer.relations[0].tags.operator = "Keolis";
  const { xml, summary } = await run({ action: "remove" });
  const out = read(xml);
  assert.ok(!out.has("n3"));
  assert.ok(!("operator" in out.get("r30").tags));
  assert.equal(summary["Kept for another line"], "1 stop");
});

test("removed from a stop of no other line with this operator", async () => {
  answer.relations[2].tags.operator = "RATP Dev";
  answer.relations[0].tags.operator = "Keolis";
  const out = read((await run({ action: "remove" })).xml);
  assert.ok(!("operator" in out.get("n3").tags));
});

test("removed: stays when the other line only has it on its route_master", async () => {
  delete answer.relations[2].tags.operator;
  answer.relations.push({ type: "relation", id: 33, version: 1, tags: { type: "route_master", route_master: "bus", ref: "13", operator: "Keolis" }, members: [member("relation", 32, "")] });
  answer.relations[0].tags.operator = "Keolis";
  const { xml, summary } = await run({ action: "remove" });
  assert.ok(!read(xml).has("n3"));
  assert.equal(summary["Kept for another line"], "1 stop");
  assert.equal(summary["To check"], undefined);
});

test("removed: stays next to a line without an operator, to check", async () => {
  delete answer.relations[2].tags.operator;
  answer.relations[0].tags.operator = "Keolis";
  const { xml, summary } = await run({ action: "remove" });
  assert.ok(!read(xml).has("n3"));
  assert.equal(summary["To check"], "1 stop");
});

test("removed: a line of another mode, found from the stop itself, counts too", async () => {
  answer.relations[2].tags.operator = "RATP Dev";
  answer.relations[0].tags.operator = "Keolis";
  answer.ofStops = [...answer.relations, { type: "relation", id: 40, version: 1, tags: { type: "route", route: "tram", ref: "T1", operator: "Keolis" }, members: [member("node", 3, "platform")] }];
  assert.ok(!read((await run({ action: "remove" })).xml).has("n3"));
});

test("a role other than a stop does not make another line", async () => {
  answer.relations[2] = { ...answer.relations[2], members: [member("node", 3, "guidepost")] };
  answer.relations[0].tags.operator = "Keolis";
  assert.ok(!("operator" in read((await run({ action: "remove" })).xml).get("n3").tags));
});

test("changed: on a stop of this line alone it is replaced in place, on a shared one the other line keeps its operator", async () => {
  answer.objects[0].tags.operator = "Keolis;Autre";
  answer.objects[1].tags.operator = "Keolis";
  answer.relations[0].tags.operator = "Keolis";
  const { xml, summary } = await run({ action: "change", newOperator: "RATP Dev" });
  const out = read(xml);
  assert.equal(out.get("n1").tags.operator, "RATP Dev;Autre");
  assert.equal(out.get("n2").tags.operator, "RATP Dev");
  assert.equal(out.get("r30").tags.operator, "RATP Dev");
  assert.equal(out.get("r31").tags.operator, "RATP Dev"); // its route_master had none
  assert.equal(out.get("n3").tags.operator, "RATP Dev;Keolis"); // line 13 keeps Keolis, and Twisto is the first network here
  assert.ok(!out.has("r32"));
  assert.equal(summary["Kept for another line"], "1 stop");
});

test("add: the operators of the other lines stay on the stop", async () => {
  answer.relations[2].tags.operator = "RATP Dev";
  answer.objects[2].tags.operator = "RATP Dev";
  answer.objects[2].tags.network = "Twisto";
  assert.equal(read((await run()).xml).get("n3").tags.operator, "RATP Dev;Keolis");
});

test("the count: what was chosen only, each stop once, as what it is tagged", async () => {
  // the platform n1 has the wrong role in a second variant, the stop_position n2 is there twice
  answer.relations[0].members.push(member("node", 1, "stop"), member("node", 2, "stop"));
  answer.relations.push({ type: "relation", id: 34, version: 1, tags: { ...answer.relations[0].tags }, members: [member("node", 1, "stop"), member("node", 2, "stop")] });
  answer.objects[1].tags.operator = "Keolis";
  let { summary } = await run({ targets: { routes: false, platforms: true, stops: false } });
  assert.deepEqual(summary, { "Platforms changed": "1 of 2" });
  clearCaches();
  answer.objects[1].tags.operator = "RATP Dev";
  ({ summary } = await run({ targets: { routes: false, platforms: false, stops: true } }));
  assert.deepEqual(summary, { "Stop_positions changed": "1 of 1" });
});

test("a stop without a tag counts as its role, one OSM does not give is left out of the count", async () => {
  delete answer.objects[1].tags.public_transport;
  answer.objects = answer.objects.filter((o) => o.id !== 3);
  const { summary } = await run();
  assert.equal(summary["Stop_positions changed"], "1 of 1");
  assert.equal(summary["Platforms changed"], "1 of 1");
});

test("summaryText: a number before its word, singular for 1, a text after its label", () => {
  assert.equal(summaryText({ stops: 12, "kept traces": 1, "Platforms changed": "2 of 3", "To check": "1 stop" }), "12 stops · 1 kept trace · Platforms changed: 2 of 3 · To check: 1 stop");
});

test("a platform drawn as a way keeps its nodes in the file", async () => {
  answer.objects = [{ type: "way", id: 8, version: 3, nodes: [81, 82], center: { lat: 49, lon: 1 }, tags: { public_transport: "platform", highway: "platform", name: "A" } }, node(81, {}), node(82, {})];
  answer.relations = [{ type: "relation", id: 30, version: 5, tags: { type: "route", route: "bus", ref: "12", network: "Twisto" }, members: [member("way", 8, "platform")] }];
  const out = read((await run()).xml);
  assert.equal(out.get("w8").tags.operator, "Keolis");
  assert.ok(out.has("n81") && out.has("n82"));
  assert.equal(out.get("n81").action, undefined);
});

test("nothing to do, a line not in OSM, no operator: an error", async () => {
  await assert.rejects(run({ operator: " " }), /Enter an operator/);
  await assert.rejects(run({ action: "remove", operator: "Inconnu" }), /Nothing to remove/);
  await assert.rejects(run({ action: "change" }), /new operator/);
  await assert.rejects(run({ action: "change", newOperator: "Keolis" }), /both the current and the new/);
  answer.relations = [];
  await assert.rejects(run(), /not in OSM/);
});
