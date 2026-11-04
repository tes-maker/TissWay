// Ways split where routes enter or leave them.
// Main street wA: a0 - a1 - a2 - a3; side street wS: s0 - a1 (joining wA in its middle); street wE: a3 - e1 (continuing wA);
// roundabout wR: r1 r2 r3 r4 r1.
import assert from "node:assert/strict";
import { test } from "node:test";
import "./helpers.js";
import { Store } from "../src/osm.js";
import { settings } from "../src/settings.js";
import { Split, linkNode, splitWays } from "../src/splitting.js";

const way = (nodes, tags = {}) => ({ version: "4", tags: { highway: "residential", ...tags }, nodes });
const osm = () => ({ wA: way(["a0", "a1", "a2", "a3"]), wS: way(["s0", "a1"]), wE: way(["a3", "e1"]),
  wR: way(["r1", "r2", "r3", "r4", "r1"], { junction: "roundabout" }), wIn: way(["s9", "r1"]), wOut: way(["r3", "s8"]) });
const route = (ways, first, last) => ({ tags: { type: "route" }, members: [[first, "stop"], ["nQ1", "platform"], [last, "stop"], ["nQ2", "platform"], ...ways.map((w) => [w, ""])] });

async function run(routes, existing = {}, base = osm()) {
  const obj = new Store(base, routes);
  return [obj, await splitWays(obj, async () => existing)];
}

const waysOf = (obj, key) => obj.get(key).members.filter(([, role]) => role === "").map(([ref]) => ref);
const newPart = (obj) => {
  const parts = [...obj.modified.keys()].filter((k) => k.startsWith("w-"));
  assert.equal(parts.length, 1);
  return parts[0];
};

test("route turning in the middle of a street", async () => {
  const existing = { r7: { version: "2", tags: { type: "route" }, members: [["wA", ""], ["wE", ""]] } };
  const [obj, counts] = await run({ "r-1": route(["wS", "wA", "wE"], "s0", "e1") }, existing);
  assert.deepEqual(counts, [1, 0, 1]);
  const p = newPart(obj);
  assert.deepEqual(obj.get("wA").nodes, ["a1", "a2", "a3"]);
  assert.equal(obj.get("wA").version, "4"); // the longest part keeps the id
  assert.deepEqual(obj.get(p).nodes, ["a0", "a1"]);
  assert.ok(!("version" in obj.get(p)));
  assert.deepEqual(waysOf(obj, "r-1"), ["wS", "wA", "wE"]); // only the travelled part
  assert.deepEqual(waysOf(obj, "r7"), [p, "wA", "wE"]); // existing relation travelling the whole street: all
  assert.deepEqual(obj.base.get("wA").nodes, ["a0", "a1", "a2", "a3"]);
});

test("same street travelled the other way", async () => {
  const [obj] = await run({ "r-1": route(["wE", "wA", "wS"], "e1", "s0") });
  assert.deepEqual(waysOf(obj, "r-1"), ["wE", "wA", "wS"]);
  assert.deepEqual(obj.get("wA").nodes, ["a1", "a2", "a3"]);
});

test("two routes: cuts pooled", async () => {
  const [obj, [n]] = await run({ "r-1": route(["wS", "wA", "wE"], "s0", "e1"), "r-2": route(["wA", "wE"], "a0", "e1") });
  assert.equal(n, 1);
  assert.deepEqual(waysOf(obj, "r-2"), [newPart(obj), "wA", "wE"]);
});

test("terminus in the middle of a way", async () => {
  const [obj, [n]] = await run({ "r-1": route(["wA"], "a1", "a2") });
  assert.equal(n, 1);
  const [kept] = waysOf(obj, "r-1");
  assert.deepEqual(obj.get(kept).nodes, ["a1", "a2"]);
});

test("way travelled end to end not split", async () => {
  const [obj, [n]] = await run({ "r-1": route(["wA", "wE"], "a0", "e1") });
  assert.equal(n, 0);
  assert.ok(!obj.modified.has("wA"));
});

test("roundabout: only the travelled part", async () => {
  const existing = { r5: { version: "1", tags: {}, members: [["wIn", ""], ["wR", ""], ["wOut", ""]] } };
  const [obj, [n, nClosed]] = await run({ "r-1": route(["wIn", "wR", "wOut"], "s9", "s8") }, existing);
  assert.deepEqual([n, nClosed], [1, 1]);
  const p = newPart(obj);
  assert.deepEqual(obj.get("wR").nodes, ["r1", "r2", "r3"]);
  assert.deepEqual(obj.get(p).nodes, ["r3", "r4", "r1"]);
  assert.deepEqual(waysOf(obj, "r-1"), ["wIn", "wR", "wOut"]); // not the full turn
  assert.deepEqual(waysOf(obj, "r5"), ["wIn", "wR", "wOut"]); // existing relation: same path, no gap

  const street = { r6: { version: "1", tags: { type: "street" }, members: [["wR", "street"]] } }; // unordered relation: all the parts
  const [obj2] = await run({ "r-1": route(["wIn", "wR", "wOut"], "s9", "s8") }, street);
  assert.deepEqual(obj2.get("r6").members.map(([ref]) => ref).sort(), ["wR", newPart(obj2)].sort());
});

test("roundabout kept whole", async () => {
  settings.split_roundabouts = false;
  const [obj, counts] = await run({ "r-1": route(["wIn", "wR", "wOut"], "s9", "s8"), "r-2": route(["wS", "wA", "wE"], "s0", "e1") });
  assert.deepEqual(counts.slice(0, 2), [1, 0]); // the street is still split
  assert.ok(!obj.modified.has("wR"));
  assert.deepEqual(waysOf(obj, "r-1"), ["wIn", "wR", "wOut"]);
});

for (const [entry, exit, expected] of [["r1", "r1", ["a", "b"]], ["r3", "r1", ["b"]], ["r1", "r3", ["a"]], ["r2", "r4", ["a", "b"]], ["r4", "r2", ["b", "a"]]]) {
  test(`traversed roundabout ${entry} -> ${exit}`, () => {
    assert.deepEqual(new Split(["r1", "r2", "r3", "r4", "r1"], [0, 2], ["a", "b"]).traversed(entry, exit), expected);
  });
}

for (const [entry, exit, expected] of [["a1", "a3", ["q"]], ["a3", "a1", ["q"]], ["a0", "a3", ["p", "q"]], ["a3", "a0", ["q", "p"]], ["a2", "a0", ["q", "p"]], [null, "a1", ["p"]], ["a1", null, ["q"]]]) {
  test(`traversed open way ${entry} -> ${exit}`, () => {
    assert.deepEqual(new Split(["a0", "a1", "a2", "a3"], [0, 1, 3], ["p", "q"]).traversed(entry, exit), expected);
  });
}

test("existing relation turning elsewhere has no gap", async () => {
  // it must only keep the part a1-a3, otherwise a0-a1 would leave a gap before wS
  const existing = { r7: { version: "2", tags: { type: "route" }, members: [["wE", ""], ["wA", ""], ["wS", ""]] } };
  const [obj] = await run({ "r-1": route(["wS", "wA", "wE"], "s0", "e1") }, existing);
  assert.deepEqual(waysOf(obj, "r7"), ["wE", "wA", "wS"]);
});

test("ways touching at two nodes: no gap", async () => {
  // wL leaves the end of wA (a3) and comes back to its middle (a1): the passage from wA to wL is a3, not a1
  const base = { ...osm(), wL: way(["a3", "l1", "a1"]) };
  const [obj] = await run({ "r-1": route(["wA", "wL"], "a0", "l1") }, {}, base);
  const ws = waysOf(obj, "r-1");
  for (let i = 1; i < ws.length; i++) assert.ok(obj.get(ws[i - 1]).nodes.some((n) => obj.get(ws[i]).nodes.includes(n)));
  assert.equal(obj.get(ws[0]).nodes[0], "a0");
  assert.equal(obj.get(ws.at(-1)).nodes.at(-1), "l1");
  assert.equal(linkNode(new Store(base), "wA", "wL"), "a3");
});
