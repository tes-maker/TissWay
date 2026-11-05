// Correcting a whole network: stops and names, read from OSM, never the ways or the members.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { makeZip } from "./helpers.js";
import { Feed } from "../src/gtfs.js";
import { clearCaches, services } from "../src/net.js";
import { prefixOf, runNetworkFix } from "../src/network_fix.js";
import { parseXml } from "../src/osm.js";
import { configure, settings } from "../src/settings.js";

const GTFS = {
  "agency.txt": "agency_id,agency_name\nAG,Nomad Car\nZ,Autre\n",
  "routes.txt": "route_id,agency_id,route_short_name,route_type\nR1,AG,224,3\nR2,Z,9,3\n",
  "trips.txt": "route_id,service_id,trip_id\nR1,S,t1\nR2,S,t2\n",
  "stops.txt": "stop_id,stop_name,stop_lat,stop_lon\nA,A,49,1\nB,B,49.01,1\nZ,Z,49.02,1\n",
  "stop_times.txt": "trip_id,stop_id,stop_sequence\nt1,A,1\nt1,B,2\nt2,Z,1\n",
};
const node = (id, tags, lat = 49, lon = 1) => ({ type: "node", id, version: 2, lat, lon, tags });
const member = (type, ref, role) => ({ type, ref, role });

let answer, towns, asked;
const realFetch = globalThis.fetch;
beforeEach(() => {
  configure();
  clearCaches();
  Object.assign(services, { valhalla_interval_ms: 0, lookup_interval_ms: 0 });
  asked = { reverse: 0 };
  towns = (lat) => (lat < 49.005 ? "Mondeville" : "Lisieux");
  answer = { relations: [], objects: [], places: [] };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url), json = (body) => new Response(JSON.stringify(body));
    if (u.includes("/reverse?")) {
      asked.reverse++;
      return json({ address: { town: towns(Number(new URL(u).searchParams.get("lat"))) } });
    }
    if (u.includes("geo.api")) return json([]);
    if (u.includes("/search?")) return json(answer.places.includes(new URL(u).searchParams.get("q")) ? [{ name: new URL(u).searchParams.get("q"), addresstype: "city" }] : []);
    if (u.includes("overpass")) {
      const q = decodeURIComponent(init.body.slice(5));
      if (q.includes("route_master")) return json({ elements: answer.relations });
      return json({ elements: answer.objects });
    }
    throw new Error(`unexpected call: ${u}`);
  };
});
afterEach(() => { globalThis.fetch = realFetch; configure(); });

const line = () => {
  answer.objects = [
    node(1, { public_transport: "platform", highway: "bus_stop", bus: "yes", name: "MONDEVILLE - Charlotte Corday" }),
    node(2, { public_transport: "stop_position", bus: "yes", name: "MONDEVILLE -Charlotte Corday" }),
    node(3, { public_transport: "platform", highway: "bus_stop", name: "Gare , Lisieux", "gtfs:stop_id:FR-X": "NOMAD:NOMAD:B" }, 49.01),
    node(4, { public_transport: "stop_position", bus: "yes", name: "Gare" }, 49.01),
  ];
  answer.relations = [
    { type: "relation", id: 30, version: 5, tags: { type: "route", route: "bus", ref: "224", network: "Nomad Car", name: "Car Nomad 224: A => B", from: "A", to: "B", "gtfs:shape_id:FR-X": "NOMAD:NOMAD:sh" },
      members: [member("node", 2, "stop"), member("node", 1, "platform"), member("node", 4, "stop"), member("node", 3, "platform"), member("way", 7, "")] },
    { type: "relation", id: 31, version: 5, tags: { type: "route_master", route_master: "bus", ref: "224", network: "Nomad Car", name: "Car Nomad 224: A <=> B" }, members: [member("relation", 30, "")] },
    { type: "relation", id: 32, version: 5, tags: { type: "route", route: "bus", ref: "9", network: "Autre", name: "Bus 9: X → Y" }, members: [member("node", 50, "platform"), member("node", 51, "platform")] },
  ];
};
const run = async (network = "Nomad Car") => runNetworkFix(await Feed.open(makeZip(GTFS)), { network });
const read = (xml) => new Map(parseXml(xml).children.map((e) => [`${e.name[0]}${e.attrs.id}`, { ...e.attrs, name: e.name, members: e.children.filter((c) => c.name === "member").map((c) => c.attrs.ref), tags: Object.fromEntries(e.children.filter((c) => c.name === "tag").map((c) => [c.attrs.k, c.attrs.v])) }]));

test("the stops of the network: name, official_name, no bus=yes on platforms, ids", async () => {
  line();
  const out = read((await run()).xml);
  assert.deepEqual(out.get("n1").tags, { public_transport: "platform", highway: "bus_stop", name: "Charlotte Corday", official_name: "MONDEVILLE - Charlotte Corday" });
  assert.equal(out.get("n3").tags.name, "Gare");
  assert.equal(out.get("n3").tags.official_name, "LISIEUX - Gare");
  assert.equal(out.get("n3").tags["gtfs:stop_id"], "NOMAD:B");
});

test("a stop_position gets the short name, keeps bus=yes, has no official_name", async () => {
  line();
  const out = read((await run()).xml);
  assert.deepEqual(out.get("n2").tags, { public_transport: "stop_position", bus: "yes", name: "Charlotte Corday" });
  assert.ok(!out.has("n4")); // already right
});

test("the route and route_master: idiomatic names, their own prefix kept, members untouched", async () => {
  line();
  const out = read((await run()).xml);
  const route = out.get("r30"), master = out.get("r31");
  assert.equal(route.tags.name, "Car Nomad 224: MONDEVILLE Charlotte Corday → LISIEUX Gare");
  assert.deepEqual([route.tags.from, route.tags.to], ["Charlotte Corday", "Gare"]);
  assert.deepEqual(route.members, ["2", "1", "4", "3", "7"]);
  assert.equal(route.tags["gtfs:shape_id:FR-X"], "NOMAD:sh");
  assert.equal(master.tags.name, "Car Nomad 224: LISIEUX Gare ↔ MONDEVILLE Charlotte Corday");
  assert.equal(route.action, "modify");
});

test("nothing of another network, and no way in the file", async () => {
  line();
  const out = read((await run()).xml);
  assert.ok(!out.has("r32"));
  assert.ok(![...out.keys()].some((k) => k[0] === "w"));
});

test("run again on what it wrote: nothing to correct", async () => {
  line();
  const first = read((await run()).xml);
  const tagsOf = (id, o) => first.get(`${o}${id}`)?.tags;
  answer.objects = answer.objects.map((e) => ({ ...e, tags: tagsOf(e.id, "n") ?? e.tags }));
  answer.relations = answer.relations.map((e) => ({ ...e, tags: tagsOf(e.id, "r") ?? e.tags }));
  await assert.rejects(run(), /Nothing to correct/);
});

test("a town from a former commune stays, also when run again", async () => {
  line();
  answer.places = ["CAEN"];
  answer.objects[0].tags.name = "CAEN Chemin Vert";
  const once = read((await run()).xml).get("n1").tags;
  assert.deepEqual([once.name, once.official_name], ["Chemin Vert", "CAEN - Chemin Vert"]);
  answer.objects[0].tags = once;
  const twice = read((await run()).xml).get("n1");
  assert.ok(!twice || twice.tags.official_name === "CAEN - Chemin Vert");
});

test("opposite stops of one name: one request, one official_name", async () => {
  line();
  answer.objects[1] = node(2, { public_transport: "platform", highway: "bus_stop", name: "Charlotte Corday" }, 49.0002);
  answer.objects[2] = node(3, { public_transport: "platform", highway: "bus_stop", name: "Gare" }, 49.01);
  answer.objects[3] = node(4, { public_transport: "platform", highway: "bus_stop", name: "Gare" }, 49.0101);
  answer.relations[0].members = [member("node", 2, "platform"), member("node", 1, "platform"), member("node", 4, "platform"), member("node", 3, "platform")];
  const out = read((await run()).xml);
  assert.equal(out.get("n2").tags.official_name, out.get("n1").tags.official_name);
  assert.equal(asked.reverse, 2);
});

test("variants told apart keep their via: the tag and the title follow the new names", async () => {
  line();
  answer.objects.push(node(5, { public_transport: "platform", highway: "bus_stop", name: "MONDEVILLE - Mairie" }));
  answer.relations[0].tags.via = "MONDEVILLE - Mairie";
  answer.relations[0].members.splice(2, 0, member("node", 5, "platform"));
  const route = read((await run()).xml).get("r30");
  assert.equal(route.tags.via, "Mairie");
  assert.equal(route.tags.name, "Car Nomad 224: MONDEVILLE Charlotte Corday → Mairie → LISIEUX Gare");
});

test("stops between the termini in a name, without via, are kept", async () => {
  line();
  answer.relations[0].tags.name = "Car Nomad 224: A → X → B";
  assert.equal(read((await run()).xml).get("r30").tags.name, "Car Nomad 224: MONDEVILLE Charlotte Corday → X → LISIEUX Gare");
});

test("a route_master without a name of this form follows its routes", async () => {
  line();
  answer.relations[1].tags.name = "Car Nomad 224";
  assert.match(read((await run()).xml).get("r31").tags.name, /^Car Nomad 224: /);
  delete answer.relations[1].tags.name;
  assert.match(read((await run()).xml).get("r31").tags.name, /^Car Nomad 224: /);
});

test("no relation of the network", async () => {
  await assert.rejects(run(), /No route relation of "Nomad Car"/);
});

test("a stop without a name, or a relation without two named stops, is left as it is", async () => {
  line();
  delete answer.objects[0].tags.name;
  answer.relations[0].members = answer.relations[0].members.filter((m) => ![1, 2].includes(m.ref));
  const out = read((await run()).xml);
  assert.ok(!out.has("n1"));
  assert.ok(!out.has("r30"));
});

test("the prefix of a relation: the setting when changed, else its own name", () => {
  assert.equal(prefixOf({ ref: "224", name: "Car Nomad 224: A → B" }, "bus"), "Car Nomad");
  assert.equal(prefixOf({ ref: "224", name: "Ligne 224 A - B" }, "bus"), "Bus");
  assert.equal(prefixOf({ ref: "224" }, "coach"), "Coach");
  assert.equal(prefixOf({ ref: "", name: "Navette: A → B" }, "bus"), "Navette");
  settings.prefixes.bus = "Bus Twisto";
  assert.equal(prefixOf({ ref: "224", name: "Car Nomad 224: A → B" }, "bus"), "Bus Twisto");
});
