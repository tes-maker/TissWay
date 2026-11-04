// Existing OSM route relations updated in place instead of duplicated.
import assert from "node:assert/strict";
import { test } from "node:test";
import { approx } from "./helpers.js";
import { buildLine } from "../src/build.js";
import { ExistingRoutes, joinIds, mergeTags, networkWikis, sameDirection, similarity } from "../src/existing.js";
import { Store } from "../src/osm.js";
import { completeWikis, withWikis } from "../src/pipeline.js";
import { settings } from "../src/settings.js";
import { Stops } from "../src/stops.js";

const NOMAD = { network: "Nomad" };
const relation = (members, tags = {}, version = "7") => ({ version, members, tags: { type: "route", route: "bus", ...tags } });
const routeMembers = (platforms, ways) => [...platforms.map((p) => [p, "platform"]), ...ways.map((w) => [w, ""])];
const NORTH = routeMembers(["nP1", "nP2", "nP3"], ["w1", "w2", "w3"]);
const SOUTH = routeMembers(["nQ3", "nQ2", "nQ1"], ["w3", "w2", "w1"]);

test("sameDirection", () => {
  assert.ok(sameDirection(["a", "b", "c"], ["x", "a", "b", "c"]));
  assert.ok(!sameDirection(["a", "b", "c"], ["c", "b", "a"]));
});

test("similarity", () => {
  approx(similarity(NORTH, {}, relation(NORTH)), 1);
  assert.equal(similarity(NORTH, {}, relation(SOUTH)), 0); // same ways, other direction
  const partial = similarity(NORTH, {}, relation(routeMembers(["nP1", "nP2"], ["w1", "w2"])));
  assert.ok(partial > 0.4 && partial < 1);
  assert.equal(similarity([], { "gtfs:trip_id:sample": "t1" }, relation([], { ref_trips: "t0;t1" })), 1); // same sample trip
});

test("mergeTags: no key left without the feed code, no old via", () => {
  settings.feed = "FR-X";
  const old = { "gtfs:route_id": "R", "gtfs:feed": "FR-X", "gtfs:trip_id": "t", via: "Y", roundtrip: "yes", "gtfs:route_id:FR-Y": "other", operator: "K" };
  assert.deepEqual(mergeTags(old, { "gtfs:route_id:FR-X": "R" }), { "gtfs:route_id:FR-Y": "other", operator: "K", "gtfs:route_id:FR-X": "R" });
});

test("mergeTags keeps unmanaged tags and drops stale GTFS references", () => {
  assert.deepEqual(mergeTags({ name: "Old", operator: "Keolis", "gtfs:shape_id": "s0", wikidata: "Q1" }, { name: "New" }), { name: "New", operator: "Keolis", wikidata: "Q1" });
});

const existingRoutes = () => new ExistingRoutes({
  r10: relation(NORTH, { ref: "1", network: "Nomad", name: "Bus 1 north", operator: "Keolis" }),
  r11: relation(SOUTH, { ref: "1", network: "Nomad", name: "Bus 1 south" }),
  r12: relation(NORTH, { ref: "1", network: "Twisto", name: "Twisto 1" }), // other network
  r13: relation(routeMembers(["nX"], ["w9"]), { ref: "1", network: "Nomad", name: "Bus 1 obsolete" }),
  r20: { version: "3", members: [["r10", ""], ["r11", ""], ["r13", ""]], tags: { type: "route_master", route_master: "bus", ref: "1", network: "Nomad" } },
});

test("candidates and pairing", () => {
  const existing = existingRoutes();
  const candidates = existing.candidates("bus", "1", "Nomad", "R1");
  assert.deepEqual(candidates.sort(), ["r10", "r11", "r13"]);
  assert.deepEqual([...existing.pair([[SOUTH, {}], [NORTH, {}]], candidates)].sort(), [[0, "r11"], [1, "r10"]]);
  assert.deepEqual(existing.candidates("bus", "1", "Nomad", "R1"), ["r13"]); // claimed relations are not offered again
  assert.equal(existing.master("bus", "1", "Nomad", "R1", ["r10", "r11"]), "r20");
  assert.deepEqual(existing.otherNetworks("bus", "1", "Nomad", [[NORTH, {}]]), ["r12"]); // Twisto 1: reported only
});

test("gtfs ids: several values with ;, within what OSM allows, and those no longer in the feed leave the route_master", () => {
  assert.equal(joinIds(["a", "b", "a"]), "a;b");
  assert.ok(joinIds(Array.from({ length: 40 }, (_, i) => `ATOUMOD040:ServiceJourney:${i}`)).length <= 255);
  const existing = new ExistingRoutes({});
  existing.feedRouteIds = new Set(["A", "B"]);
  assert.equal(existing.masterRouteIds({ tags: { "gtfs:route_id": "A;OLD" } }, "B"), "A;B");
  assert.equal(existing.masterRouteIds({ tags: {} }, "B"), "B");
  assert.ok(similarity([], { "gtfs:shape_id": "s2;s3" }, relation([], { "gtfs:shape_id": "s1;s2" })) === 1);
});

test("route_id matches whatever the ref", () => {
  const existing = new ExistingRoutes({ r1: relation(NORTH, { ref: "1 EXPRESS", "gtfs:route_id": "R1" }) });
  assert.deepEqual(existing.candidates("bus", "1EX", "Nomad", "R1"), ["r1"]);
});

test("buildLine updates the existing relations", () => {
  const obj = new Store({ n1: { version: "1", lat: 49.0, lon: 1.0, tags: {} }, n2: { version: "1", lat: 49.001, lon: 1.0, tags: {} }, w1: { version: "1", tags: {}, nodes: ["n1", "n2"] } });
  const row = (s, lat) => [s, { stop_id: s, stop_code: "", stop_name: s, wheelchair_boarding: "", platform_code: "", lat, lon: 1.0002, label: s }];
  const empty = () => new Map([["A", []], ["B", []]]);
  const stops = new Stops(new Map([row("A", 49.0001), row("B", 49.0009)]), empty(), empty(), new Map(), empty());
  const existing = new ExistingRoutes({
    r10: relation([["w1", ""]], { ref: "1", network: "Nomad", name: "Old", operator: "Keolis" }),
    r20: { version: "3", members: [["r10", ""], ["r99", ""]], tags: { type: "route_master", route_master: "bus", ref: "1", network: "Nomad" } },
  });
  const route = { route_id: "R1", route_short_name: "1", route_color: "", route_text_color: "", mode: "bus" };
  buildLine(route, [{ direction: "0", seq: ["A", "B"], shape_id: "", trip_id: "t1", ways: ["w1"] }], obj, stops, NOMAD, new Map(), new Map(), existing);
  const rel = obj.get("r10");
  assert.deepEqual([rel.version, rel.tags.name, rel.tags.operator], ["7", "Bus 1: A → B", "Keolis"]);
  assert.deepEqual(rel.members.map(([, role]) => role), ["stop", "platform", "stop", "platform", ""]);
  assert.deepEqual(obj.get("r20").members, [["r10", ""], ["r99", ""]]); // other member kept, ours already there
  assert.ok(![...obj.modified.keys()].some((k) => k.startsWith("r-"))); // nothing duplicated
});

test("networkWikis only when the existing relations agree", () => {
  const rel = (tags) => ({ tags: { type: "route", ...tags }, members: [] });
  const relations = {};
  for (let i = 0; i < 3; i++) {
    relations[`a${i}`] = rel({ network: "Astuce", "network:wikidata": "Q3537964" });
    relations[`n${i}`] = rel({ network: "Nomad", "network:wikidata": "Q98131290" });
  }
  relations.a3 = rel({ network: "Astuce" }); // without wikidata: ignored
  relations.n3 = rel({ network: "Nomad", "network:wikidata": "Q1" }); // disagreement: nothing
  relations.l0 = rel({ network: "Lexo", "network:wikidata": "Q2" }); // too few
  relations.l1 = rel({ network: "Lexo", "network:wikidata": "Q2" });
  const wikis = networkWikis(relations);
  assert.deepEqual(wikis.Astuce, { "network:wikidata": "Q3537964" });
  assert.deepEqual(wikis.Nomad, {});
  assert.deepEqual(wikis.Lexo, {});
});

test("withWikis completes the profile without overriding it", () => {
  const wikis = { Astuce: { "network:wikidata": "Q3537964", "network:wikipedia": "fr:Réseau Astuce" }, Twisto: { "network:wikidata": "Q3537947", "network:wikipedia": "fr:Twisto" },
    Nomad: { "network:wikidata": "Q1", "network:wikipedia": "fr:Autre" } };
  const networks = { a1: { network: "Astuce" }, a2: { network: "Twisto", "network:wikidata": "Q3537947" }, a3: { network: "Nomad", "network:wikidata": "Q98131290" }, a4: { network: "Inconnu" } };
  const out = withWikis(networks, wikis);
  assert.deepEqual(out.a1, { network: "Astuce", "network:wikidata": "Q3537964", "network:wikipedia": "fr:Réseau Astuce" });
  assert.equal(out.a2["network:wikipedia"], "fr:Twisto"); // same entity: missing key completed
  assert.deepEqual(out.a3, networks.a3); // the profile names another entity: nothing taken
  assert.deepEqual(out.a4, { network: "Inconnu" });
});

test("completeWikis on the objects of the file", () => {
  const networks = { A1: { network: "Astuce", "network:wikidata": "Q3537964", "network:wikipedia": "fr:Réseau Astuce" }, A2: { network: "Twisto", "network:wikidata": "Q3537947" } };
  const obj = new Store({ r9: { tags: { type: "route", network: "Astuce" } } }, {
    r1: { tags: { type: "route", network: "Astuce", "network:wikidata": "Q1" } }, // existing relation updated by a split way: its wikidata kept
    n1: { tags: { public_transport: "platform", network: "Twisto", "network:2": "Astuce" } }, // shared platform: the numbered keys of Astuce
    r2: { tags: { type: "route", network: "lcn" } }, // unknown network
    w1: { tags: { highway: "residential", network: "Astuce" } }, // neither route nor platform
  });
  assert.equal(completeWikis(obj, networks), 2);
  assert.deepEqual(obj.get("r1").tags, { type: "route", network: "Astuce", "network:wikidata": "Q1", "network:wikipedia": "fr:Réseau Astuce" });
  assert.deepEqual(obj.get("n1").tags, { public_transport: "platform", network: "Twisto", "network:2": "Astuce", "network:wikidata": "Q3537947",
    "network:wikidata:2": "Q3537964", "network:wikipedia:2": "fr:Réseau Astuce" });
  assert.deepEqual(obj.get("r2").tags, { type: "route", network: "lcn" });
  assert.ok(!("network:wikidata" in obj.get("w1").tags));
  assert.ok(!obj.modified.has("r9")); // objects outside the file are not added to it
});
