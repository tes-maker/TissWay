import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import "./helpers.js";
import { borrowable, borrowedTrace, guidedPath } from "../src/borrow.js";
import { settings } from "../src/settings.js";

// Stops A, B, C, D, E 111 m apart northwards on one road: nodes 1 to 5, ways w1 = 1-2, w2 = 2-3, w3 = 3-4, w4 = 4-5.
const LAT = (i) => 49 + i * 0.001;
const IDS = ["A", "B", "C", "D", "E"];
const nodes = IDS.map((_, i) => ({ type: "node", id: i + 1, lat: LAT(i), lon: 1, tags: {} }));
const ways = [1, 2, 3, 4].map((i) => ({ type: "way", id: i, nodes: [i, i + 1], tags: { highway: "primary" } }));

const stops = {
  platforms: new Map(IDS.map((id, i) => [id, [{ id: `n${100 + i}`, pos: [LAT(i), 1.0002] }]])),
  paired: new Map(IDS.map((_, i) => [`n${100 + i}`, `n${i + 1}`])),
  positions: (seq) => seq.map((id) => [LAT(IDS.indexOf(id)), 1.0002]),
};

/** A relation of another line: its stops (stop_position and platform) and ways. */
const relation = (served, wayIds, route = "bus") => ({
  tags: { type: "route", route },
  members: [...served.flatMap((id) => {
    const i = IDS.indexOf(id);
    return [[`n${i + 1}`, "stop"], [`n${100 + i}`, "platform"]];
  }), ...wayIds.map((w) => [`w${w}`, ""])],
});

const realFetch = globalThis.fetch;
let asked;
beforeEach(() => {
  asked = 0;
  globalThis.fetch = async () => { asked++; return new Response(JSON.stringify({ elements: [...ways, ...nodes] })); };
});
afterEach(() => { globalThis.fetch = realFetch; });

const variant = (seq) => ({ trip_id: "t", seq });

test("a variant whose stops are all served in a row by other lines takes their ways, without Valhalla", async () => {
  const existing = { routes: { r1: relation(["A", "B", "C"], [1, 2]), r2: relation(["C", "D", "E"], [3, 4], "coach") } };
  const v = variant(IDS);
  const lent = await borrowable({ mode: "bus" }, [v], existing, stops);
  const pieces = lent.pieces(v);
  assert.deepEqual(pieces.map((p) => [p.relation, p.from, p.to]), [["r1", 0, 2], ["r2", 2, 4]]);
  assert.deepEqual(borrowedTrace(v, pieces, lent.obj, stops.positions(v.seq)), ["w1", "w2", "w3", "w4"]);
});

test("a pair of stops no other line serves in a row is left to Valhalla, guided by the rest", async () => {
  const existing = { routes: { r1: relation(["A", "B", "C"], [1, 2]), r2: relation(["D", "E"], [4]) } };
  const v = variant(IDS);
  const lent = await borrowable({ mode: "bus" }, [v], existing, stops);
  const pieces = lent.pieces(v);
  assert.deepEqual(pieces.map((p) => [p.relation, p.from, p.to]), [["r1", 0, 2], ["r2", 3, 4]]);
  assert.equal(borrowedTrace(v, pieces, lent.obj, stops.positions(v.seq)), null);
  const routed = [];
  const path = await guidedPath(pieces, lent.obj, stops.positions(v.seq), async (ps) => { routed.push(ps.length); return ps; });
  assert.deepEqual(routed, [2]); // only C -> D
  assert.ok(path.length >= 5);
});

test("a shape far from the borrowed trace leaves the choice to Valhalla", async () => {
  const existing = { routes: { r1: relation(IDS, [1, 2, 3, 4]) } };
  const v = variant(IDS);
  const lent = await borrowable({ mode: "bus" }, [v], existing, stops);
  const elsewhere = IDS.map((_, i) => [LAT(i), 1.01]);
  assert.equal(borrowedTrace(v, lent.pieces(v), lent.obj, stops.positions(v.seq), elsewhere), null);
  assert.ok(borrowedTrace(v, lent.pieces(v), lent.obj, stops.positions(v.seq), stops.positions(v.seq)));
});

test("nothing borrowed: other modes, a single stop in common, another stop in between, or the setting off; then OSM is not asked", async () => {
  const v = variant(IDS);
  const between = relation(["A", "B"], [1]);
  between.members.splice(2, 0, ["n999", "stop"], ["n998", "platform"]); // the other line stops elsewhere between A and B: it may take another road
  for (const [existing, mode] of [
    [{ routes: { r1: between } }, "bus"],
    [{ routes: { r1: relation(IDS, [1, 2, 3, 4], "train") } }, "bus"],
    [{ routes: { r1: relation(["A"], [1]) } }, "bus"],
    [{ routes: { r1: relation(IDS, [1, 2, 3, 4]) } }, "tram"],
  ]) assert.deepEqual((await borrowable({ mode }, [v], existing, stops)).pieces(v), []);
  settings.borrow_traces = false;
  assert.deepEqual((await borrowable({ mode: "bus" }, [v], { routes: { r1: relation(IDS, [1, 2, 3, 4]) } }, stops)).pieces(v), []);
  assert.equal(asked, 0);
});
