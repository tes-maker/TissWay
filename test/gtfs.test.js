// GTFS reading: optional files and columns, zip archives, route types, variants.
import assert from "node:assert/strict";
import { test } from "node:test";
import { approx, makeZip } from "./helpers.js";
import { Feed, GTFSError, isSubRoute, lineVariants, osmRoute, splitCsvLine, stopSequences } from "../src/gtfs.js";

const MINIMAL = { // only the required files and columns: no agency.txt, shapes.txt, direction_id, stop_code...
  "routes.txt": "route_id,route_short_name,route_type\nR1,1,3\nR2,T,0\n",
  "trips.txt": "route_id,service_id,trip_id\nR1,S,t1\nR1,S,t2\n",
  "stops.txt": "stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\n"
    + "ST,Gare,49.0,1.0,1,\nA,,49.0001,1.0001,0,ST\nB,Mairie,49.001,1.0,,\nE,Entrance,49.0,1.0,2,ST\n",
  "stop_times.txt": "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n"
    + "t1,08:00:00,08:00:00,A,1\nt1,08:05:00,08:05:00,B,10\nt2,09:00:00,09:00:00,B,2\nt2,09:05:00,09:05:00,A,1\n",
};
const open = (files = MINIMAL) => Feed.open(makeZip(files));

test("minimal feed gets the optional columns", async () => {
  const feed = await open();
  assert.deepEqual((await feed.agency()).map((a) => a.agency_id), [""]);
  const routes = await feed.routes();
  assert.ok("agency_id" in routes[0] && "route_color" in routes[0]);
  assert.deepEqual(routes.map((r) => r.mode), ["bus", "tram"]);
  const trips = await feed.trips();
  assert.ok(trips.every((t) => t.shape_id === "" && t.direction_id === ""));
  assert.equal((await feed.shapes(["x"])).size, 0);
});

test("stops keep boarding locations and inherit the station name", async () => {
  const stops = new Map((await (await open()).stops()).map((s) => [s.stop_id, s]));
  assert.deepEqual([...stops.keys()].sort(), ["A", "B"]);
  assert.equal(stops.get("A").stop_name, "Gare");
  approx(stops.get("A").lat, 49.0001);
  assert.equal(stops.get("A").stop_code, "");
});

test("zip feed in a sub-folder, with a byte order mark", async () => {
  const files = Object.fromEntries(Object.entries(MINIMAL).map(([n, c]) => [`export/${n}`, `﻿${c}`]));
  const feed = await open(files);
  assert.deepEqual((await feed.routes()).map((r) => r.route_id), ["R1", "R2"]);
  const st = await feed.stopTimes(["t1"]);
  assert.deepEqual(st.sort((a, b) => a.stop_sequence - b.stop_sequence).map((s) => s.stop_id), ["A", "B"]);
});

test("a required file missing is reported", async () => {
  await assert.rejects(Feed.open(makeZip({ "routes.txt": "route_id\n" })), GTFSError);
  await assert.rejects(Feed.open(new Blob(["not a zip"])), /ZIP/);
});

test("single agency fills route agency_id", async () => {
  const feed = await open({ ...MINIMAL, "agency.txt": "agency_id,agency_name,agency_url,agency_timezone\nAG,Bus Co,http://x,UTC\n" });
  assert.ok((await feed.routes()).every((r) => r.agency_id === "AG"));
});

test("stopSequences orders by stop_sequence", async () => {
  const feed = await open();
  const trips = await feed.trips();
  const out = stopSequences(trips, await feed.stopTimes(trips.map((t) => t.trip_id)));
  assert.deepEqual(out.map((t) => [t.trip_id, t.stop_seq]), [["t1", ["A", "B"]], ["t2", ["A", "B"]]]);
});

for (const [type, mode] of [["3", "bus"], ["700", "bus"], ["715", "bus"], ["200", "coach"], ["11", "trolleybus"], ["800", "trolleybus"],
  ["0", "tram"], ["2", "train"], ["1000", "ferry"], ["", null], ["42", null]]) {
  test(`osmRoute(${JSON.stringify(type)}) = ${mode}`, () => assert.equal(osmRoute(type), mode));
}

test("isSubRoute", () => {
  assert.ok(isSubRoute(["b", "c"], ["a", "b", "c", "d"]));
  assert.ok(!isSubRoute(["a", "c"], ["a", "b", "c"])); // stops not consecutive
  assert.ok(!isSubRoute(["c", "b"], ["a", "b", "c"])); // reverse order
  assert.ok(!isSubRoute(["a", "b"], ["a", "b"])); // same sequence
});

const trip = (trip_id, shape_id, stop_seq, direction_id = "0") => ({ trip_id, shape_id, stop_seq, direction_id });

test("lineVariants drops sub-routes", () => {
  const out = lineVariants([trip("t1", "s1", ["a", "b", "c", "d"]), trip("t2", "s2", ["b", "c"]), trip("t3", "s3", ["a", "c", "d"]), trip("t4", "s4", ["a", "b", "c", "d"])]);
  assert.deepEqual(out.map((v) => [v.seq, v.trip_id]), [[["a", "b", "c", "d"], "t1"], [["a", "c", "d"], "t3"]]);
});

test("lineVariants lists the shapes of a variant, most frequent first, each with a sample trip", () => {
  const [v] = lineVariants([trip("t1", "s2", ["a", "b"]), trip("t2", "s1", ["a", "b"]), trip("t3", "s1", ["a", "b"])]);
  assert.deepEqual([v.shape_id, v.trip_id, v.shape_ids, v.trip_ids], ["s1", "t2", ["s1", "s2"], ["t2", "t1"]]);
});

test("lineVariants without direction nor shape", () => {
  assert.deepEqual(lineVariants([trip("t1", "", ["a", "b"], "")]), [{ direction: "0", seq: ["a", "b"], shape_id: "", trip_id: "t1", trips: 1 }]);
});

test("shapes, unordered, with spaces in the header", async () => {
  const shapes = "shape_id, shape_pt_lat,shape_pt_lon,shape_pt_sequence\n"
    + [["s1", [3, 1, 2]], ["s2", [1, 2]]].flatMap(([sid, seqs]) => seqs.map((seq, i) => `${sid},${i}.5,${i},${seq}\n`)).join("");
  const feed = await open({ ...MINIMAL, "shapes.txt": shapes });
  assert.deepEqual([...(await feed.shapes(["s1", "nope"]))], [["s1", [[1.5, 1], [2.5, 2], [0.5, 0]]]]);
  assert.equal((await feed.shapes([])).size, 0);
});

test("stopAgencies", async () => {
  const agencies = await (await open()).stopAgencies();
  assert.deepEqual([...agencies.keys()].sort(), ["A", "B"]);
  assert.deepEqual([...agencies.get("A")], [""]);
});

test("CSV: quotes, doubled quotes, separators and line breaks inside quotes, CRLF, spaces", async () => {
  assert.deepEqual(splitCsvLine('a,"b,c","d""e", f,'), ["a", "b,c", 'd"e', "f", ""]);
  const feed = await open({ ...MINIMAL, "routes.txt": 'route_id,route_long_name,route_type\r\nR1,"Ligne\nsur deux",3\r\nR2,"A, B",3' });
  assert.deepEqual((await feed.routes()).map((r) => r.route_long_name), ["Ligne\nsur deux", "A, B"]);
});

test("multi-byte characters split across chunks are kept", async () => {
  const feed = await open({ ...MINIMAL, "routes.txt": `route_id,route_long_name,route_type\n${Array.from({ length: 20000 }, (_, i) => `R${i},Hôpital Général é,3`).join("\n")}\n` });
  const routes = await feed.routes();
  assert.equal(routes.length, 20000);
  assert.ok(routes.every((r) => r.route_long_name === "Hôpital Général é"));
});

test("rows left out without parsing: what is read does not change, quotes and spaces included", async () => {
  const feed = await Feed.open(makeZip({
    "agency.txt": "agency_id,agency_name\nA,A\n",
    "routes.txt": "route_id,agency_id,route_short_name,route_type\nR,A,1,3\n",
    "trips.txt": "route_id,service_id,trip_id,shape_id\nR,S,t1,s1\nR,S,t2,s2\n",
    "stops.txt": "stop_id,stop_name,stop_lat,stop_lon\nX,X,49,1\nY,Y,49,1\nZ,Z,49,1\n",
    "stop_times.txt": 'trip_id,stop_id,stop_sequence\nt1,X,1\n"t1",Y,2\n t1,Z,3\nt2,X,1\n"t2",Y,2\n',
    "shapes.txt": 'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\ns1,49,1,2\n"s1",48,1,1\ns2,47,1,1\n',
  }));
  await feed.stopAgencies(); // the first pass needs every row
  assert.deepEqual((await feed.stopTimes(["t1"])).map((s) => [s.trip_id, s.stop_id]), [["t1", "X"], ["t1", "Y"], ["t1", "Z"]]);
  assert.deepEqual(await feed.shapes(["s1"]), new Map([["s1", [[48, 1], [49, 1]]]]));
});

test("the trip_id in another column than the first: the same rows", async () => {
  const feed = await Feed.open(makeZip({
    "agency.txt": "agency_id,agency_name\nA,A\n",
    "routes.txt": "route_id,agency_id,route_short_name,route_type\nR,A,1,3\n",
    "trips.txt": "route_id,service_id,trip_id\nR,S,t1\nR,S,t2\n",
    "stops.txt": "stop_id,stop_name,stop_lat,stop_lon\nX,X,49,1\nY,Y,49,1\n",
    "stop_times.txt": "stop_sequence,stop_id,trip_id\n1,X,t1\n1,Y,t2\n",
  }));
  await feed.stopAgencies();
  assert.deepEqual((await feed.stopTimes(["t2"])).map((s) => s.stop_id), ["Y"]);
});
