// Checking the shape_ids of a network from ref_trips.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { makeZip } from "./helpers.js";
import { Feed } from "../src/gtfs.js";
import { clearCaches, services } from "../src/net.js";
import { parseXml } from "../src/osm.js";
import { proposeShapes, shapeFile } from "../src/shape_fix.js";
import { configure, settings } from "../src/settings.js";

const GTFS = {
  "agency.txt": "agency_id,agency_name\nAG,Nomad Car\n",
  "routes.txt": "route_id,agency_id,route_short_name,route_type\nR1,AG,224,3\n",
  "trips.txt": "route_id,service_id,trip_id,shape_id\nR1,S,t1,new1\nR1,S,t2,new2\nR1,S,t3,\n",
  "shapes.txt": "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\nnew1,49,1,1\nnew2,49,1,1\n",
  "stops.txt": "stop_id,stop_name,stop_lat,stop_lon\nA,A,49,1\nB,B,49.01,1\n",
  "stop_times.txt": "trip_id,stop_id,stop_sequence\nt1,A,1\nt1,B,2\n",
};
const route = (id, tags) => ({ type: "relation", id, version: 1, tags: { type: "route", route: "bus", ref: "224", network: "Nomad Car", ...tags }, members: [{ type: "way", ref: 7, role: "" }] });
let relations;
const realFetch = globalThis.fetch;
beforeEach(() => {
  configure();
  clearCaches();
  settings.feed = "FR-X";
  Object.assign(services, { valhalla_interval_ms: 0, lookup_interval_ms: 0 });
  relations = [
    route(1, { name: "old", ref_trips: "t1;t2", "gtfs:shape_id:FR-X": "old1;old2" }),
    route(2, { name: "ok", ref_trips: "t1", "gtfs:shape_id:FR-X": "new1" }),
    route(3, { name: "gone", ref_trips: "zz", "gtfs:shape_id:FR-X": "old3" }),
    route(4, { name: "no shape", ref_trips: "t3", "gtfs:shape_id:FR-X": "old4" }),
    route(5, { name: "no ref_trips", "gtfs:shape_id:FR-X": "old5" }),
    route(6, { name: "none yet", ref_trips: "t2" }),
  ];
  globalThis.fetch = async (url) => {
    if (String(url).includes("overpass")) return new Response(JSON.stringify({ elements: relations }));
    throw new Error(`unexpected call: ${url}`);
  };
});
afterEach(() => { globalThis.fetch = realFetch; configure(); });

const plan = async () => proposeShapes(await Feed.open(makeZip(GTFS)), { network: "Nomad Car" });

test("each relation is judged by the shape of its ref_trips trips in the feed", async () => {
  const p = await plan();
  const by = Object.fromEntries(p.rows.map((r) => [r.name, r]));
  assert.deepEqual([by.old.status, by.old.fresh], ["changed", ["new1", "new2"]]);
  assert.equal(by.ok.status, "same");
  assert.equal(by.gone.status, "unknown");
  assert.equal(by["no shape"].status, "noshape");
  assert.equal(by["none yet"].status, "added");
  assert.equal(p.withoutTrips, 1);
});

test("only the chosen relations are written, with the fresh shape_ids", async () => {
  const p = await plan();
  const xml = shapeFile(p, new Set(["r1"])).xml;
  const rels = parseXml(xml).children.filter((e) => e.name === "relation");
  assert.equal(rels.length, 1);
  assert.equal(rels[0].children.find((c) => c.attrs?.k === "gtfs:shape_id:FR-X").attrs.v, "new1;new2");
  assert.throws(() => shapeFile(p, new Set(["r2", "r3"])), /nothing to change/);
});
