// Review of the refs of shared platforms, before the download.
import assert from "node:assert/strict";
import { test } from "node:test";
import "./helpers.js";
import { Store } from "../src/osm.js";
import { applyPriority, listRefs, networksOf, priorityRows, removeRef, restoreRef, reviewRefs } from "../src/ref_review.js";
import { settings } from "../src/settings.js";

const TWISTO_ID = "FR:14118:ZE:chuo02:ATOUMOD029", NOMAD_ID = "FR:14118:ZE:1151928:ATOUMOD040";
const stops = [{ stop_id: TWISTO_ID, stop_lat: "49", stop_lon: "1" }, { stop_id: NOMAD_ID, stop_code: "14CAE74A", stop_lat: "49", stop_lon: "1" }];
const ofStop = new Map([[TWISTO_ID, new Set(["Twisto"])], [NOMAD_ID, new Set(["Nomad"])]]);
const sizes = new Map([["Twisto", 900], ["Nomad", 7000]]);
const SHARED = { name: "Mont Coco", public_transport: "platform", network: "Twisto", "network:wikidata": "Q3537947", "network:2": "Nomad", "network:wikidata:2": "Q98131290" };

/** A platform of the file, read from OSM with base and changed since into tags. */
function store(tags, base = tags, position = { lat: 49, lon: 1 }) {
  const obj = new Store({ n1: { version: "1", ...position, tags: base } });
  obj.edit("n1").tags = { ...tags };
  return obj;
}

function reviewed(tags, base) {
  settings.stop_ref_tags = ["ref:FR:Atoumod"];
  const obj = store(tags, base);
  return [reviewRefs(obj, { sizes, ofStop, stops }), obj.get("n1").tags];
}

test("Mont Coco: the code of Nomad in ref goes to ref:Nomad", () => {
  const [review, t] = reviewed({ ...SHARED, ref: "14CAE74A" });
  assert.equal(t.ref, undefined);
  assert.equal(t["ref:Nomad"], "14CAE74A");
  assert.match(review.corrected[0], /Mont Coco.*14CAE74A moved from ref to ref:Nomad/);
});

test("Mont Coco: the ids of a list go each to their network, with what was cut from it when read", () => {
  const list = `${TWISTO_ID};${NOMAD_ID}`;
  const [, t] = reviewed({ ...SHARED, "ref:FR:Atoumod": TWISTO_ID }, { ...SHARED, "ref:FR:Atoumod": list });
  assert.equal(t["ref:FR:Atoumod"], TWISTO_ID);
  assert.equal(t["ref:FR:Atoumod:Nomad"], NOMAD_ID);
});

test("well placed refs are left alone", () => {
  const tags = { ...SHARED, ref: "chuo02", "ref:Nomad": "14CAE74A", "ref:FR:Atoumod": TWISTO_ID, "ref:FR:Atoumod:Nomad": NOMAD_ID };
  const [review, t] = reviewed(tags);
  const expected = { ...tags, "network:wikidata:Nomad": "Q98131290" };
  delete expected["network:wikidata:2"];
  assert.deepEqual(t, expected);
  assert.deepEqual([review.corrected, review.toCheck], [[], []]);
  assert.deepEqual(review.order, ["Twisto", "Nomad"]);
});

test("a value of the feed is not moved when its place is taken: to check", () => {
  const [review, t] = reviewed({ ...SHARED, ref: "14CAE74A", "ref:Nomad": "OTHER" });
  assert.deepEqual([t.ref, t["ref:Nomad"]], ["14CAE74A", "OTHER"]);
  assert.match(review.toCheck[0], /already holds OTHER/);
});

test("a value of the feed for a network absent from the platform: to check", () => {
  const [review, t] = reviewed({ name: "Mont Coco", public_transport: "platform", network: "Twisto", ref: "14CAE74A" });
  assert.equal(t.ref, "14CAE74A");
  assert.match(review.toCheck[0], /belongs to Nomad, which is not on this platform/);
});

test("a code of a stop far away is a coincidence, not an error", () => {
  settings.stop_ref_tags = [];
  const obj = store({ ...SHARED, ref: "14CAE74A" }, undefined, { lat: 49.1, lon: 1 });
  const review = reviewRefs(obj, { sizes, ofStop, stops });
  assert.equal(obj.get("n1").tags.ref, "14CAE74A");
  assert.deepEqual(review.corrected, []);
});

test("the priority moves ref and network, and comes back", () => {
  const tags = { ...SHARED, ref: "chuo02", "ref:Nomad": "14CAE74A", "ref:FR:Atoumod": TWISTO_ID, "ref:FR:Atoumod:Nomad": NOMAD_ID, local_ref: "A" };
  const [review, t] = reviewed(tags);
  assert.equal(applyPriority(review, ["Nomad", "Twisto"]), 1);
  assert.deepEqual([t.network, t["network:2"], t["network:wikidata"], t["network:wikidata:Twisto"]], ["Nomad", "Twisto", "Q98131290", "Q3537947"]);
  assert.deepEqual([t.ref, t["ref:Twisto"], t["ref:Nomad"]], ["14CAE74A", "chuo02", undefined]);
  assert.deepEqual([t["ref:FR:Atoumod"], t["ref:FR:Atoumod:Twisto"]], [NOMAD_ID, TWISTO_ID]);
  assert.equal(t["local_ref:Twisto"], "A");
  assert.equal(applyPriority(review, ["Twisto", "Nomad"]), 1);
  assert.deepEqual([t.network, t["network:wikidata"], t["network:wikidata:Nomad"], t.ref, t["ref:Nomad"]],
    ["Twisto", "Q3537947", "Q98131290", "chuo02", "14CAE74A"]);
});

test("the stop code is kept with the network whose GTFS stop has that code", () => {
  const feedStops = [{ ...stops[0], stop_code: "fadr01" }, stops[1]];
  const obj = store({ ...SHARED, "gtfs:stop_code:FR-X": "fadr01;14CAE74A" });
  reviewRefs(obj, { sizes, ofStop, stops: feedStops, feed: "FR-X" });
  assert.deepEqual([obj.get("n1").tags["gtfs:stop_code:FR-X"], obj.get("n1").tags["gtfs:stop_code:FR-X:Nomad"]], ["fadr01", "14CAE74A"]);
});

test("the first in priority takes the platform: fewest stops without a list, the list otherwise", () => {
  const nomadFirst = { ...SHARED, network: "Nomad", "network:wikidata": "Q98131290", "network:2": "Twisto", "network:wikidata:2": "Q3537947", ref: "14CAE74A", "ref:Twisto": "chuo02" };
  const [review, t] = reviewed(nomadFirst);
  assert.deepEqual([t.network, t.ref, t["ref:Nomad"]], ["Twisto", "chuo02", "14CAE74A"]);
  assert.match(review.corrected[0], /ref given to Twisto/);

  settings.stop_owners = ["Nomad", "Twisto"];
  const [listed, u] = reviewed({ ...SHARED, ref: "chuo02", "ref:Nomad": "14CAE74A" });
  assert.deepEqual([u.network, u.ref, u["ref:Twisto"]], ["Nomad", "14CAE74A", "chuo02"]);
  assert.deepEqual(listed.order, ["Nomad", "Twisto"]);
});

test("without sizes nor list, the network in place keeps the platform", () => {
  const obj = store({ ...SHARED, ref: "x", "ref:Nomad": "y" });
  const review = reviewRefs(obj);
  assert.equal(obj.get("n1").tags.network, "Twisto");
  assert.deepEqual(review.corrected, []);
});

test("the feed may name a network longer than OSM", () => {
  const longer = new Map([[NOMAD_ID, new Set(["Nomad Car"])], [TWISTO_ID, new Set(["Twisto"])]]);
  const obj = store({ ...SHARED, ref: "14CAE74A" });
  reviewRefs(obj, { sizes, ofStop: longer, stops });
  assert.equal(obj.get("n1").tags["ref:Nomad"], "14CAE74A");
});

test("without sizes, the order shown starts with the network holding the platforms", () => {
  assert.deepEqual(reviewRefs(store({ ...SHARED, ref: "x" })).order, ["Twisto", "Nomad"]);
});

const proposed = (review) => listRefs(review).filter((r) => r.reason).map((r) => [r.tag, r.value]);

test("obsolete: a value unknown to the feed is proposed, never removed by itself", () => {
  const [review, t] = reviewed({ ...SHARED, ref: "old99", "ref:Nomad": "14CAE74A" });
  assert.deepEqual(proposed(review), [["ref", "old99"]]);
  assert.equal(t.ref, "old99");
});

test("obsolete: the ref of a network of the feed no longer on the stop", () => {
  const [review] = reviewed({ name: "Mont Coco", public_transport: "platform", network: "Twisto", ref: "chuo02", "ref:Nomad": "14CAE74A" });
  assert.deepEqual(proposed(review), [["ref:Nomad", "14CAE74A"]]);
});

test("obsolete: a network outside the feed and the other ref tags cannot be judged", () => {
  const [review] = reviewed({ name: "X", public_transport: "platform", network: "Bus Verts", "network:2": "Twisto", ref: "b1", "ref:FNTV": "z", "ref:Twisto": "chuo02" });
  assert.deepEqual(proposed(review), []);
  assert.ok(listRefs(review).some((r) => r.tag === "ref:FNTV"));
});

test("obsolete: the stop_ids of this feed only, value by value", () => {
  const obj = store({ ...SHARED, "gtfs:stop_id:FR-X": `${TWISTO_ID};gone`, "gtfs:stop_id:FR-Y": "other", "gtfs:stop_id": "unknown" });
  const review = reviewRefs(obj, { sizes, ofStop, stops, feed: "FR-X" });
  assert.deepEqual(proposed(review), [["gtfs:stop_id:FR-X", "gone"]]);
  removeRef(review, listRefs(review).find((r) => r.reason));
  assert.equal(obj.get("n1").tags["gtfs:stop_id:FR-X"], TWISTO_ID);
});

test("a stop shared by two networks in the feed is not obsolete", () => {
  const both = new Map([[TWISTO_ID, new Set(["Twisto", "Nomad"])], [NOMAD_ID, new Set(["Nomad"])]]);
  const review = reviewRefs(store({ ...SHARED, ref: "chuo02", "ref:Nomad": "14CAE74A" }), { sizes, ofStop: both, stops });
  assert.deepEqual(proposed(review), []);
});

test("a removed ref comes back, in the place of its network even after a change of priority", () => {
  const [review, t] = reviewed({ ...SHARED, ref: "chuo02", "ref:Nomad": "old99" });
  const row = listRefs(review).find((r) => r.value === "old99");
  removeRef(review, row);
  assert.equal(t["ref:Nomad"], undefined);
  assert.deepEqual(review.removed, [row]);
  applyPriority(review, ["Nomad", "Twisto"]);
  restoreRef(review, row);
  assert.deepEqual([t.ref, t["ref:Twisto"]], ["old99", "chuo02"]);
  assert.deepEqual(review.removed, []);
});

test("networksOf: network first, then by number", () => {
  assert.deepEqual(networksOf({ "network:10": "C", "network:2": "B", network: "A" }), ["A", "B", "C"]);
});

test("priorityRows says what the order gives each network, and follows it", () => {
  const [review] = reviewed({ ...SHARED, ref: "chuo02", "ref:Nomad": "14CAE74A" });
  const row = (network) => priorityRows(review).find((r) => r.network === network);
  applyPriority(review, ["Twisto", "Nomad"]);
  assert.deepEqual(priorityRows(review).map((r) => r.network), ["Twisto", "Nomad"]);
  assert.deepEqual(row("Twisto"), { network: "Twisto", tag: "ref:Twisto", shared: 1, holds: 1 });
  assert.deepEqual(row("Nomad"), { network: "Nomad", tag: "ref:Nomad", shared: 1, holds: 0 });
  applyPriority(review, ["Nomad", "Twisto"]);
  assert.equal(row("Nomad").holds, 1);
  assert.equal(row("Twisto").holds, 0);
});
