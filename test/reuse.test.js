// When is a trace already in OSM good enough to be kept?
import assert from "node:assert/strict";
import { test } from "node:test";
import "./helpers.js";
import { ExistingRoutes } from "../src/existing.js";
import { Store } from "../src/osm.js";
import { traceProblem, waysOfRelation } from "../src/reuse.js";

const node = (lat) => ({ lat, lon: 1, tags: {} });
const way = (nodes, tags = {}) => ({ nodes, tags });
// North-south road n1 .. n5, in two ways; a third way far to the east
const road = (extra = {}) => new Store({ n1: node(49), n2: node(49.001), n3: node(49.002), n4: node(49.003), n5: node(49.004), e1: { lat: 49.004, lon: 1.01, tags: {} }, e2: { lat: 49.005, lon: 1.01, tags: {} },
  a: way(["n1", "n2", "n3"]), b: way(["n3", "n4", "n5"]), far: way(["e1", "e2"]), ...extra });
const STOPS = [[49.0001, 1], [49.002, 1], [49.0039, 1]];

test("a good trace", () => assert.equal(traceProblem(["a", "b"], STOPS, road()), null));

test("a gap between two ways", () => assert.match(traceProblem(["a", "far", "b"], STOPS, road()), /gap/));

test("a way no longer in OSM, or a way without its nodes", () => {
  assert.match(traceProblem(["a", "gone"], STOPS, road()), /gone is not in OSM/);
  assert.match(traceProblem(["a", "b"], STOPS, road({ b: way(["n3", "missing"]) })), /b is not in OSM/);
  assert.equal(traceProblem([], STOPS, road()), "no way");
});

test("travelled against a oneway, unless buses may", () => {
  const backwards = road({ b: way(["n5", "n4", "n3"], { oneway: "yes" }) });
  assert.match(traceProblem(["a", "b"], STOPS, backwards), /b is travelled against its oneway/);
  assert.equal(traceProblem(["a", "b"], STOPS, road({ b: way(["n5", "n4", "n3"], { oneway: "yes", "oneway:bus": "no" }) })), null);
  assert.equal(traceProblem(["a", "b"], STOPS, road({ b: way(["n3", "n4", "n5"], { oneway: "-1" }) })) !== null, true);
});

test("a stop it does not serve", () => {
  assert.match(traceProblem(["a", "b"], [[49.0001, 1], [49.002, 1.01], [49.0039, 1]], road()), /stop 2 of 3/);
});

test("the stops in the other order: the other direction", () => {
  assert.match(traceProblem(["a", "b"], [...STOPS].reverse(), road()), /not served in order|starts before|goes on after/);
});

test("a trace longer than the variant: a short turn does not take the whole line", () => {
  assert.match(traceProblem(["a", "b"], [[49.0001, 1], [49.0009, 1]], road()), /goes on after the last stop/);
  assert.match(traceProblem(["a", "b"], [[49.0031, 1], [49.0039, 1]], road()), /starts before the first stop/);
});

test("a loop may pass twice at the same place", () => {
  const loop = new Store({ n1: node(49), n2: node(49.001), w1: way(["n1", "n2"]), w2: way(["n2", "n1"]) });
  assert.equal(traceProblem(["w1", "w2"], [[49, 1], [49.001, 1], [49, 1]], loop), null);
});

test("only the travelled members are the trace", () => {
  assert.deepEqual(waysOfRelation({ members: [["n1", "stop"], ["w1", "platform"], ["w2", ""], ["w3", "forward"], ["r1", ""]] }), ["w2", "w3"]);
});

test("a kept trace stays in its relation, the other drafts are paired as usual", () => {
  const rel = (ways) => ({ version: "1", members: ways.map((w) => [w, ""]), tags: { type: "route", route: "bus", ref: "1" } });
  const existing = new ExistingRoutes({ r1: rel(["a"]), r2: rel(["b"]) });
  const drafts = [[[["a", ""]], {}], [[["b", ""]], {}]];
  assert.deepEqual([...existing.pair(drafts, ["r1", "r2"], ["r2", undefined])], [[0, "r2"]]); // r1 shares nothing with the second draft
});
