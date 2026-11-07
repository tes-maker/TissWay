// A whole run on a small invented network, every online service mocked: GTFS -> relations -> .osm.
//
// North-south street w1 (n1 .. n5, at longitude 1.0), continued by w2 (n5, n6). Line 1 runs north, from A to C, stopping
// in the middle of w1 at B. Terminus A stands in the middle of w1, so w1 is split there. n20 is an existing platform of
// B on the east kerb; relation r30 already maps the line.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { makeZip, ptnaMatches, ptnaProblems } from "./helpers.js";
import { Feed } from "../src/gtfs.js";
import { lookup } from "../src/lookup.js";
import { services } from "../src/net.js";
import { parseXml } from "../src/osm.js";
import { SelectionError, runRoutes, selectRoutes } from "../src/pipeline.js";
import { runPlatforms } from "../src/platform_tags.js";
import { buildList } from "../src/ptna.js";
import { clearCaches } from "../src/net.js";
import { configure, settings } from "../src/settings.js";

const GTFS = {
  "agency.txt": "agency_id,agency_name\nAG,Bustown (Ville)\n",
  "routes.txt": "route_id,agency_id,route_short_name,route_long_name,route_type,route_color\nR1,AG,1,A <> C,3,FF0000\nR2,AG,2,Autre,3,\nT,AG,T,Tram,0,\n",
  "trips.txt": "route_id,service_id,trip_id,direction_id,shape_id\nR1,S,t1,0,sh1\nR1,S,t2,0,sh1\n",
  "stops.txt": "stop_id,stop_name,stop_lat,stop_lon\nA,Alpha,49.00025,1.00015\nB,Bravo,49.0007,1.00015\nC,Charlie,49.0014,1.00015\nZ,Loin,49.5,1.5\n",
  "stop_times.txt": "trip_id,stop_id,stop_sequence\nt1,A,1\nt1,B,2\nt1,C,3\nt2,A,1\nt2,B,2\nt2,C,3\n",
  "shapes.txt": "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\nsh1,49.00025,1.0,1\nsh1,49.0005,1.0,2\nsh1,49.0014,1.0,3\n",
};
const node = (id, lat, lon, tags = {}) => ({ type: "node", id, version: 2, lat, lon, tags });
const STREET = [node(1, 49, 1), node(2, 49.00025, 1), node(3, 49.0005, 1), node(4, 49.00075, 1), node(5, 49.001, 1), node(6, 49.0015, 1),
  { type: "way", id: 1, version: 5, nodes: [1, 2, 3, 4, 5], tags: { highway: "residential", name: "Grande Rue", oneway: "yes" } },
  { type: "way", id: 2, version: 3, nodes: [5, 6], tags: { highway: "residential", name: "Grande Rue", oneway: "yes" } }];
const PLATFORM = node(20, 49.0007, 1.00015, { highway: "bus_stop", name: "Bravo (ancien)" });
const EXISTING = { type: "relation", id: 30, version: 9, tags: { type: "route", route: "bus", ref: "1", network: "Bustown", operator: "Keolis" },
  members: [{ type: "way", ref: 1, role: "" }, { type: "way", ref: 2, role: "" }] };
const PARENT = { type: "relation", id: 40, version: 1, tags: { type: "route", route: "bicycle" }, members: [{ type: "way", ref: 1, role: "" }] };

// polyline6 of the path n2 -> n6 (what Valhalla answers)
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

const realFetch = globalThis.fetch;
let queries, town, valhallaCalls;
beforeEach(() => {
  queries = [];
  town = null;
  valhallaCalls = 0;
  clearCaches();
  Object.assign(services, { valhalla_interval_ms: 0, lookup_interval_ms: 0 });
  Object.assign(settings, { driving_side: "right", fix_accents: false, network_auto: false, feed: "" });
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const json = (body) => new Response(JSON.stringify(body));
    if (u.endsWith("/status")) return json({ version: "test" });
    if (u.includes("/reverse?")) return json({ address: { ...(town ? { town } : {}), country_code: "fr" } });
    if (u.includes("query.wikidata.org")) return json({ results: { bindings: decodeURIComponent(u).includes("P1622") ? [{ sideLabel: { value: "left" } }] : [{ i: { value: "http://www.wikidata.org/entity/Q7" }, site: { value: "https://www.bustown.example/" }, transit: { value: "false" } }] } });
    if (u.includes("wbsearchentities")) return json({ search: [{ id: "Q7", label: "Bustown" }, { id: "Q8", label: "Bustown Band" }] });
    if (u.includes("wbgetentities")) return json({ entities: { Q7: { sitelinks: { frwiki: { title: "Bustown (réseau)" }, commonswiki: { title: "x" } } } } });
    if (u.includes("wiktionary.org") && u.includes("titles=")) return json({ query: { pages: { 1: { title: "alpha", missing: "" }, 2: { title: "bravo" } } } });
    if (u.includes("wiktionary.org")) return json({ query: { search: [{ title: "Alpha" }, { title: "álpha" }] } });
    if (u.endsWith("/trace_attributes")) valhallaCalls++;
    if (u.endsWith("/trace_attributes")) return json({ edges: [{ way_id: 1 }, { way_id: 1 }, { way_id: 2 }], shape: encode([[49.00025, 1], [49.0005, 1], [49.001, 1], [49.0015, 1]]) });
    if (u.includes("overpass")) {
      const q = decodeURIComponent(init.body.slice(5));
      queries.push(q);
      if (q.includes("^gtfs:route_id:")) return json({ elements: [{ type: "relation", id: 99, tags: { "gtfs:route_id:FR-Z": "R2" } }] });
      if (q.includes("highway=bus_stop")) return json({ elements: [PLATFORM] });
      if (q.includes("rel(bw)")) return json({ elements: [EXISTING, PARENT] });
      if (q.includes("route_master")) return json({ elements: [EXISTING] });
      return json({ elements: STREET });
    }
    throw new Error(`unexpected call: ${u}`);
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

const open = () => Feed.open(makeZip(GTFS));
const tags = (el) => Object.fromEntries(el.children.filter((c) => c.name === "tag").map((t) => [t.attrs.k, t.attrs.v]));

test("selectRoutes: modes, network, refs, and readable errors", () => {
  const routes = [{ route_id: "R2", route_short_name: "10", agency_id: "AG", mode: "bus" }, { route_id: "R1", route_short_name: "2", agency_id: "AG", mode: "bus" }, { route_id: "T", route_short_name: "T", agency_id: "AG", mode: "tram" }];
  const networks = { AG: { network: "Bustown" } };
  assert.deepEqual(selectRoutes(routes, networks).map((r) => r.route_id), ["R1", "R2"]); // numeric order, no tram
  assert.deepEqual(selectRoutes(routes, networks, "bustown", ["10"]).map((r) => r.route_id), ["R2"]);
  assert.throws(() => selectRoutes(routes, networks, "Nope"), SelectionError);
  assert.throws(() => selectRoutes(routes, networks, null, ["99"]), /99.*Available lines: 2, 10/);
});

test("the colours of the settings replace those of the GTFS", async () => {
  configure({ colour: "#00ff00", colour_text: "ffffff" });
  const { xml } = await runRoutes(await open(), { network: "Bustown", ref: "R1" });
  const t = tags(parseXml(xml).children.find((e) => e.name === "relation" && e.attrs.id === "30"));
  assert.equal(t.colour, "#00ff00");
  assert.equal(t["colour:text"], "#ffffff");
});

test("runRoutes: a line from GTFS to .osm", async () => {
  const { xml, filename, state } = await runRoutes(await open(), { network: "Bustown", ref: "R1" });
  assert.equal(filename, "bustown_1.osm");
  const root = parseXml(xml);
  const byId = (name, id) => root.children.find((e) => e.name === name && e.attrs.id === id);

  // existing relation updated in place: id, version, unmanaged tags kept
  const route = byId("relation", "30");
  assert.equal(route.attrs.version, "9");
  assert.equal(route.attrs.action, "modify");
  const t = tags(route);
  assert.equal(t.name, "Bus 1: Alpha → Charlie");
  assert.equal(t.operator, "Keolis");
  assert.equal(t.colour, "#FF0000");
  assert.equal(t["gtfs:shape_id"], "sh1");
  assert.equal(t["public_transport:version"], "2");

  // members in order: stop + platform of each stop, then the ways
  const members = route.children.filter((c) => c.name === "member");
  assert.deepEqual(members.map((m) => m.attrs.role).slice(0, 6), ["stop", "platform", "stop", "platform", "stop", "platform"]);
  assert.equal(members[3].attrs.ref, "20"); // the existing platform of B

  // the existing platform completed, its GTFS name replacing the old one
  const platform = tags(byId("node", "20"));
  assert.deepEqual([platform.name, platform.network, platform["gtfs:stop_id"]], ["Bravo", "Bustown", "B"]);

  // w1 split at the stop_position of terminus A: the longest part keeps the id, the route only has what it travels
  const ways = members.filter((m) => m.attrs.role === "").map((m) => m.attrs.ref);
  const kept = byId("way", "1");
  assert.equal(kept.attrs.version, "5");
  assert.equal(kept.children.filter((c) => c.name === "nd")[0].attrs.ref, members[0].attrs.ref);
  assert.deepEqual(ways, ["1", "2"]);
  // the other relation using w1 gets both parts
  const parent = byId("relation", "40").children.filter((c) => c.name === "member").map((m) => m.attrs.ref);
  assert.equal(parent.length, 2);
  assert.ok(parent.includes("1") && parent.some((r) => r.startsWith("-")));

  // new route_master, and every node of a modified way is in the file
  assert.ok(root.children.some((e) => e.name === "relation" && tags(e).type === "route_master" && tags(e).ref === "1"));
  for (const way of root.children.filter((e) => e.name === "way")) {
    for (const nd of way.children.filter((c) => c.name === "nd")) assert.ok(byId("node", nd.attrs.ref), `node ${nd.attrs.ref}`);
  }
  assert.ok(state.lines.length === 1);
});

test("runRoutes finds what is not in the GTFS online, with nothing configured", async () => {
  town = "Fleury-sur-Orne";
  Object.assign(settings, { driving_side: "auto", fix_accents: true, network_auto: true, feed: "auto" });
  const zip = { ...GTFS, "agency.txt": "agency_id,agency_name,agency_url,agency_lang\nAG,Bustown (Ville),https://bustown.example,FR\n" };
  const { xml, detected } = await runRoutes(await Feed.open(makeZip(zip)), { network: "Bustown", ref: "R1" });
  const found = Object.fromEntries(detected);
  assert.equal(found["Driving side"], "left (FR)");
  assert.equal(found["Suffix of the gtfs:* tags"], "FR-Z"); // from another line of the feed, elsewhere
  assert.equal(found.network, "Bustown");
  assert.equal(found["network:wikidata"], "Q7"); // Q8 has another label; Q7 is confirmed by the website of the agency
  assert.equal(found["network:wikipedia"], "fr:Bustown (réseau)");
  assert.equal(settings.driving_side, "left");
  const name = tags(parseXml(xml).children.find((e) => e.attrs.id === "30")).name;
  assert.equal(name, "Bus 1: FLEURY-SUR-ORNE Álpha → FLEURY-SUR-ORNE Charlie"); // town on the termini, accent from Wiktionary
});

// A line with two variants between the same termini, one of them through D, and a loop: via and roundtrip are needed.
const VARIANTS = {
  ...GTFS,
  "trips.txt": "route_id,service_id,trip_id,direction_id,shape_id\nR1,S,t1,0,sh1\nR1,S,t2,0,sh1\nR1,S,t3,0,sh1\nR2,S,t4,0,sh1\n",
  "stops.txt": "stop_id,stop_name,stop_lat,stop_lon\nA,Alpha,49.00025,1.00015\nB,Bravo,49.0007,1.00015\nC,Charlie,49.0014,1.00015\nD,Delta,49.0011,1.00015\n",
  "stop_times.txt": "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n"
    + "t1,08:00:00,08:00:00,A,1\nt1,08:05:00,08:05:00,B,2\nt1,08:10:00,08:10:00,C,3\n"
    + "t2,09:00:00,09:00:00,A,1\nt2,09:05:00,09:05:00,B,2\nt2,09:12:00,09:12:00,C,3\n"
    + "t3,10:00:00,10:00:00,A,1\nt3,10:05:00,10:05:00,D,2\nt3,10:20:00,10:20:00,C,3\n"
    + "t4,11:00:00,11:00:00,A,1\nt4,11:05:00,11:05:00,B,2\nt4,11:10:00,11:10:00,A,3\n",
};

test("a good trace in OSM is kept: Valhalla is not asked, the relation keeps its ways", async () => {
  const { state, summary } = await runRoutes(await open(), { network: "Bustown", ref: "R1" });
  assert.equal(summary["kept traces"], 1);
  assert.equal(state.lines[0][1][0].kept_from, "r30");
  assert.equal(valhallaCalls, 0);
  assert.equal(state.obj.get("r30").tags["gtfs:shape_id"], "sh1"); // the GTFS is still referenced
});

test("the trace is computed when OSM has none, or when keeping is off", async () => {
  settings.reuse_traces = false;
  const { summary } = await runRoutes(await open(), { network: "Bustown", ref: "R1" });
  assert.equal(summary["kept traces"], 0);
  assert.ok(valhallaCalls > 0);
});

test("one line at a time: nothing else is converted", async () => {
  await assert.rejects(runRoutes(await open(), { network: "Bustown" }), /one is converted at a time/);
  const same = { ...GTFS, "routes.txt": "route_id,agency_id,route_short_name,route_type\nR1,AG,1,3\nR9,AG,1,3\n" };
  await assert.rejects(runRoutes(await Feed.open(makeZip(same)), { network: "Bustown", ref: "1" }), /Several lines answer to "1".*R1, R9/);
  assert.equal((await runRoutes(await open(), { network: "Bustown", ref: "1" })).filename, "bustown_1.osm");
});

test("what PTNA checks: no message on the generated relations", async () => {
  settings.feed = "FR-X";
  const feed = await Feed.open(makeZip(VARIANTS));
  const runs = [await runRoutes(feed, { network: "Bustown", ref: "R1" }), await runRoutes(feed, { network: "Bustown", ref: "R2" })];
  const objs = runs.map((r) => r.state.obj);
  const routes = objs.flatMap((obj) => [...obj.modified].filter(([, o]) => o.tags?.type === "route" && o.tags["public_transport:version"]).map(([key, rel]) => [key, rel, obj]));
  assert.equal(routes.length, 3);
  for (const [key, rel, obj] of routes) assert.deepEqual(ptnaProblems(rel, (k) => obj.get(k).tags.name), [], `${key}: ${rel.tags.name}`);
  const byName = Object.fromEntries(routes.map(([, r]) => [r.tags.name, r.tags]));
  assert.ok(byName["Bus 1: Alpha → Delta → Charlie"], Object.keys(byName).join(" | "));
  assert.equal(byName["Bus 1: Alpha → Delta → Charlie"].via, "Delta");
  assert.equal(byName["Bus 1: Alpha → Delta → Charlie"].duration, "00:20");
  assert.equal(byName["Bus 1: Alpha → Bravo → Charlie"].via, "Bravo");
  assert.equal(byName["Bus 1: Alpha → Bravo → Charlie"].duration, "00:12"); // median of 10 and 12 min
  assert.equal(byName["Bus 2: Alpha → Alpha"].roundtrip, "yes");
  const masters = objs.flatMap((obj) => [...obj.modified.values()]).filter((o) => o.tags?.type === "route_master");
  assert.deepEqual(masters.map((m) => m.tags.name).sort(), ["Bus 1: Charlie ↔ Alpha", "Bus 2: Alpha"]);
  // the vehicle on stop_positions (PTNA's check) and on platforms (iD's)
  for (const [, rel, obj] of routes) {
    for (const [k, role] of rel.members.filter(([, r]) => r)) assert.equal(obj.get(k).tags.bus, "yes", `${role} ${k}`);
  }
});

test("stops named without their town, official_name on the platforms; the title says VILLE Arret", async () => {
  town = "Fleury-sur-Orne";
  settings.update_existing = false;
  const zip = { ...GTFS, "stops.txt": "stop_id,stop_name,stop_lat,stop_lon\nA,Fleury Alpha,49.00025,1.00015\nB,Bravo - Fleury-sur-Orne,49.0007,1.00015\nC,Charlie,49.0014,1.00015\n" };
  const { state } = await runRoutes(await Feed.open(makeZip(zip)), { network: "Bustown", ref: "R1" });
  const { obj } = state;
  const [rel] = [...obj.modified].filter(([k, o]) => k.startsWith("r-") && o.tags.type === "route").map(([, o]) => o);
  assert.equal(rel.tags.name, "Bus 1: FLEURY-SUR-ORNE Alpha → FLEURY-SUR-ORNE Charlie");
  assert.deepEqual([rel.tags.from, rel.tags.to], ["Alpha", "Charlie"]);
  const tagged = (role, key) => rel.members.filter(([, r]) => r === role).map(([k]) => obj.get(k).tags[key]);
  assert.deepEqual(tagged("platform", "name"), ["Alpha", "Bravo", "Charlie"]);
  assert.deepEqual(tagged("platform", "official_name"), ["FLEURY-SUR-ORNE - Alpha", "FLEURY-SUR-ORNE - Bravo", "FLEURY-SUR-ORNE - Charlie"]);
  assert.deepEqual(tagged("stop", "name"), ["Alpha", "Bravo", "Charlie"]);
});

test("variants sharing their termini: the vias of the title say their town too, the via tag the name of the platform", async () => {
  town = "Fleury-sur-Orne";
  settings.update_existing = false;
  const zip = { ...GTFS, "trips.txt": "route_id,service_id,trip_id,direction_id,shape_id\nR1,S,t1,0,sh1\nR1,S,t2,0,sh1\n",
    "stops.txt": `${GTFS["stops.txt"]}D,Delta,49.0009,1.00015\n`,
    "stop_times.txt": "trip_id,stop_id,stop_sequence\nt1,A,1\nt1,B,2\nt1,C,3\nt2,A,1\nt2,D,2\nt2,C,3\n" };
  const { state } = await runRoutes(await Feed.open(makeZip(zip)), { network: "Bustown", ref: "R1" });
  const names = [...state.obj.modified.values()].filter((o) => o.tags?.type === "route" && o.tags.name).map((o) => [o.tags.name, o.tags.via]).sort();
  assert.deepEqual(names, [
    ["Bus 1: FLEURY-SUR-ORNE Alpha → FLEURY-SUR-ORNE Bravo → FLEURY-SUR-ORNE Charlie", "Bravo"],
    ["Bus 1: FLEURY-SUR-ORNE Alpha → FLEURY-SUR-ORNE Delta → FLEURY-SUR-ORNE Charlie", "Delta"],
  ]);
});

test("variants told apart by two stops of one name in two towns: the title says the town, the via tag the name", async () => {
  settings.update_existing = false;
  const zip = { ...GTFS, "stops.txt": "stop_id,stop_name,stop_lat,stop_lon\nA,Alpha,49.00025,1.00015\nB,CAEN - Mairie,49.0007,1.00015\nD,FLERS - Mairie,49.0009,1.00015\nC,Charlie,49.0014,1.00015\n",
    "stop_times.txt": "trip_id,stop_id,stop_sequence\nt1,A,1\nt1,B,2\nt1,C,3\nt2,A,1\nt2,D,2\nt2,C,3\n" };
  const place = lookup.placeNear;
  lookup.placeNear = async () => true;
  try {
    const { state } = await runRoutes(await Feed.open(makeZip(zip)), { network: "Bustown", ref: "R1" });
    const names = [...state.obj.modified.values()].filter((o) => o.tags?.type === "route" && o.tags.name).map((o) => [o.tags.name, o.tags.via]).sort();
    assert.deepEqual(names, [["Bus 1: Alpha → CAEN Mairie → Charlie", "Mairie"], ["Bus 1: Alpha → FLERS Mairie → Charlie", "Mairie"]]);
  } finally {
    lookup.placeNear = place;
  }
});

test("several shapes for a variant: separated by ;, and the feed's other route_ids stay on the route_master", async () => {
  settings.feed = "FR-X";
  const zip = { ...GTFS, "trips.txt": "route_id,service_id,trip_id,direction_id,shape_id\nR1,S,t1,0,sh1\nR1,S,t2,0,sh2\n",
    "shapes.txt": `${GTFS["shapes.txt"]}sh2,49.00025,1.0,1\nsh2,49.0014,1.0,2\n` };
  const { state } = await runRoutes(await Feed.open(makeZip(zip)), { network: "Bustown", ref: "R1" });
  const tags = state.obj.get("r30").tags;
  assert.equal(tags["gtfs:shape_id:FR-X"], "sh1;sh2");
  assert.equal(tags["gtfs:trip_id:sample:FR-X"], "t1;t2");
  assert.equal(tags["gtfs:route_id:FR-X"], "R1");
});

test("a line tagged with an operator shares it, the GTFS agency is never used for it", async () => {
  const { state } = await runRoutes(await open(), { network: "Bustown", ref: "R1" });
  assert.equal(state.obj.get("r30").tags.operator, "Keolis"); // from the existing relation
  const master = [...state.obj.modified.values()].find((o) => o.tags?.type === "route_master");
  assert.equal(master.tags.operator, "Keolis");
  settings.update_existing = false;
  const { state: fresh } = await runRoutes(await open(), { network: "Bustown", ref: "R1" });
  const created = [...fresh.obj.modified].filter(([k, o]) => k.startsWith("r-") && o.tags.type === "route");
  assert.ok(created.length && created.every(([, o]) => !o.tags.operator));
});

test("the operator of the settings goes on the relations and platforms of the line, not on stop_positions, and replaces the one of the relations", async () => {
  settings.operator = "Transdev";
  const { state, xml } = await runRoutes(await open(), { network: "Bustown", ref: "R1" });
  assert.equal(state.obj.get("r30").tags.operator, "Transdev");
  const objects = [...state.obj.modified.values()].filter((o) => o.tags);
  assert.equal(objects.find((o) => o.tags.type === "route_master").tags.operator, "Transdev");
  const platforms = objects.filter((o) => o.tags.public_transport === "platform");
  assert.ok(platforms.length && platforms.every((o) => o.tags.operator === "Transdev"));
  assert.ok(objects.some((o) => o.tags.public_transport === "stop_position"));
  assert.ok(objects.filter((o) => o.tags.public_transport === "stop_position").every((o) => !o.tags.operator));
  assert.ok(!xml.includes("Keolis"));
});

test("our PTNA comparison behaves like PTNA's", () => {
  assert.ok(ptnaMatches("Gare Routière", "CAEN Gare Routière"));
  assert.ok(ptnaMatches("Gare (Départ)", "CAEN Gare"));
  assert.ok(!ptnaMatches("Avranches - Gare", "AVRANCHES Gare")); // why labels never rewrite the stop name
});

test("runRoutes without updating existing relations creates new ones", async () => {
  settings.update_existing = false;
  const { xml } = await runRoutes(await open(), { network: "Bustown", ref: "R1" });
  const root = parseXml(xml);
  const route = root.children.find((e) => e.name === "relation" && tags(e).type === "route" && tags(e).name);
  assert.ok(Number(route.attrs.id) < 0);
  assert.equal(route.attrs.version, undefined);
});

test("runPlatforms completes the nearest platform and lists the others", async () => {
  const result = await runPlatforms(await open(), { network: "Bustown", feedId: "F" });
  const t = tags(parseXml(result.xml).children.find((e) => e.attrs.id === "20"));
  assert.deepEqual([t["gtfs:stop_id:F"], t.route_ref, t.name], ["B", "1", "Bravo (ancien)"]); // the name is left unchanged
  assert.equal(result.filename, "bustown_platforms.osm");
  assert.deepEqual(result.csv.trim().split("\n").map((l) => l.split(",")[0]), ["stop_id", "A", "C"]);
});

test("PTNA list from the feed", async () => {
  settings.feed = "F";
  const [lines] = await buildList(await open(), "Bustown");
  assert.ok(lines.includes('1;bus;"Alpha ↔ Charlie";;;;F;R1;'));
  assert.ok(lines.includes('2;bus;"Autre";;;;F;R2;'));
  assert.ok(lines.includes("</pre>"));
});
