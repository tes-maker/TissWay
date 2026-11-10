// The traces of a GTFS line as GPX: one per shape, trips without a shape by stop sequence.
import assert from "node:assert/strict";
import { test } from "node:test";
import { makeZip } from "./helpers.js";
import { Feed } from "../src/gtfs.js";
import { lineToGpx, lineTraces } from "../src/gtfs_gpx.js";
import { parseGpx } from "../src/gpx.js";

const FEED = {
  "routes.txt": "route_id,route_short_name,route_long_name,route_type,route_color\nR1,12,Gare - Plage,3,E3001B\nR2,13,,3,\n",
  "trips.txt": "route_id,service_id,trip_id,direction_id,shape_id\n"
    + "R1,S,t1,0,sh1\nR1,S,t2,0,sh1\nR1,S,t3,1,sh2\nR1,S,t4,1,\nR2,S,t5,0,sh1\n",
  "shapes.txt": "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n"
    + "sh1,49.0,1.0,1\nsh1,49.005,1.002,2\nsh1,49.01,1.0,3\nsh2,49.01,1.0,1\nsh2,49.0,1.0,2\n",
  "stops.txt": "stop_id,stop_code,stop_name,stop_lat,stop_lon\nA,a1,Gare,49.0,1.0\nB,,Mairie,49.005,1.0\nC,,Plage,49.01,1.0\n",
  "stop_times.txt": "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n"
    + "t1,08:00:00,08:00:00,A,1\nt1,08:05:00,08:05:00,B,2\nt1,08:10:00,08:10:00,C,3\n"
    + "t2,09:00:00,09:00:00,A,1\nt2,09:10:00,09:10:00,C,2\n"
    + "t3,10:00:00,10:00:00,C,1\nt3,10:10:00,10:10:00,A,2\n"
    + "t4,11:00:00,11:00:00,C,1\nt4,11:05:00,11:05:00,B,2\nt4,11:10:00,11:10:00,A,3\n"
    + "t5,12:00:00,12:00:00,A,1\nt5,12:10:00,12:10:00,C,2\n",
};

test("traces: one per shape, trips without a shape by stop sequence, by direction then frequency", () => {
  const trips = [
    { trip_id: "a", direction_id: "1", shape_id: "", stop_seq: ["C", "A"] },
    { trip_id: "b", direction_id: "0", shape_id: "s", stop_seq: ["A", "C"] },
    { trip_id: "c", direction_id: "0", shape_id: "s", stop_seq: ["A", "B", "C"] },
    { trip_id: "d", direction_id: "0", shape_id: "s", stop_seq: ["A", "B", "C"] },
    { trip_id: "e", direction_id: "1", shape_id: "", stop_seq: ["C", "A"] },
    { trip_id: "f", direction_id: "1", shape_id: "", stop_seq: ["C", "B", "A"] },
  ];
  assert.deepEqual(lineTraces(trips).map((t) => [t.shape_id, t.direction, t.seq.join(""), t.trips]),
    [["s", "0", "ABC", 3], ["", "1", "CA", 2], ["", "1", "CBA", 1]]);
});

test("a line as GPX: one file, a track per trace in the line's colour, no waypoint", async () => {
  const feed = await Feed.open(makeZip(FEED));
  const route = (await feed.routes())[0];
  const { files, summary } = await lineToGpx(feed, route);
  assert.deepEqual(files.map((f) => f.name), ["bus-12.gpx"]);
  assert.deepEqual(summary, { traces: 3, trips: 4, Length: summary.Length });
  const { text } = files[0];
  assert.equal((text.match(/<trk>/g) || []).length, 3);
  assert.doesNotMatch(text, /<wpt/);
  assert.match(text, /E3001B/);
  assert.match(text, /shape_id=sh1/);
  assert.match(text, /straight lines between the stops/);
  assert.deepEqual(parseGpx(text).points.slice(0, 3), [[49.0, 1.0], [49.005, 1.002], [49.01, 1.0]]);
});
