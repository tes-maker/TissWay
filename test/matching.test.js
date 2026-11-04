// Map-matching: chunks, shape rejected when wrong, routing through the stops (Valhalla mocked).
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import "./helpers.js";
import { chunks, matchVariant, valhalla } from "../src/matching.js";
import { settings } from "../src/settings.js";

const STOPS = [[49.0, 1.0], [49.01, 1.0]];
const ON_ROAD = [[49.0, 1.0], [49.005, 1.0], [49.01, 1.0]];
const ELSEWHERE = [[49.0, 1.1], [49.01, 1.1]]; // ~7 km east of the stops

beforeEach(() => {
  valhalla.mapMatch = async (points) => {
    if (points === "bad" || points[0] === "bad") throw new Error("no way matched");
    return points === ON_ROAD || points === "route" ? [["w1"], ON_ROAD] : [["w9"], ELSEWHERE];
  };
  valhalla.routeThrough = async () => "route";
});

test("good shape is used", async () => assert.deepEqual(await matchVariant(ON_ROAD, STOPS), [["w1"], "shape"]));

test("shape far from the stops is replaced by routing", async () => assert.deepEqual(await matchVariant(ELSEWHERE, STOPS), [["w1"], "stops"]));

test("missing or unmatchable shape routes through the stops", async () => {
  assert.deepEqual(await matchVariant(null, STOPS), [["w1"], "stops"]);
  assert.deepEqual(await matchVariant(["bad", "bad"], STOPS), [["w1"], "stops"]);
});

test("cancelling is not mistaken for a failure", async () => {
  valhalla.mapMatch = async () => { throw new DOMException("stop", "AbortError"); };
  await assert.rejects(matchVariant(ON_ROAD, STOPS), { name: "AbortError" });
});

test("chunks overlap and respect the limits", () => {
  settings.thresholds.trace_points = 3;
  const points = Array.from({ length: 7 }, (_, i) => [49 + i * 1e-4, 1]);
  const out = chunks(points);
  assert.equal(out[0][0], 0);
  assert.equal(out.at(-1)[1], 6);
  assert.ok(out.every(([s, e]) => e - s <= 3));
  assert.ok(out.slice(1).every(([s], k) => s === out[k][1])); // one point of overlap
});
