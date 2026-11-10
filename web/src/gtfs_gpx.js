// The traces of a GTFS line as GPX, without OSM: one track per distinct trace the trips of the line follow.
//
// A trace is a shape of shapes.txt; trips without a shape are grouped by stop sequence, and drawn as straight lines between their stops.
// You get one file per trace and, when the line has several, one file with all of them. The stops are waypoints, the ref of the line a
// label along each track, what the GTFS says of each in their descriptions.

import { pathLength } from "./geo.js";
import { stopSequences } from "./gtfs.js";
import { labelPoints, writeTracks } from "./gpx.js";
import { modePrefix, slug, tripTitle } from "./naming.js";
import { counter, listIn, log, mostCommon, sortedBy } from "./util.js";

const SEP = "\u0001";

/** The distinct traces of trips with their stop_seq (stopSequences): [{shape_id ("" if none), direction, seq (the most frequent stop sequence
 * of its trips), trip_id (a sample), trips (their number)}], by direction, the most frequent first (a shape before none). Trips with a shape_id are grouped by it,
 * the others by stop sequence. */
export function lineTraces(trips) {
  const groups = new Map();
  for (const t of trips) listIn(groups, t.shape_id ? `s${t.shape_id}` : `q${t.stop_seq.join(SEP)}`).push(t);
  const traces = [...groups.values()].map((list) => {
    const [[key]] = mostCommon(counter(list.map((t) => t.stop_seq.join(SEP))));
    const sample = list.find((t) => t.stop_seq.join(SEP) === key);
    const [[direction]] = mostCommon(counter(list.map((t) => t.direction_id || "0")));
    return { shape_id: sample.shape_id, direction, seq: sample.stop_seq, trip_id: sample.trip_id, trips: list.length };
  });
  return sortedBy(traces, (t) => [t.direction, -t.trips, t.shape_id ? 0 : 1, t.shape_id, t.trip_id]);
}

const lines = (pairs) => pairs.filter(([, v]) => v !== "" && v !== undefined && v !== null).map(([k, v]) => `${k}=${v}`).join("\n");
const WHEELCHAIR = { 1: "yes", 2: "no" };

/** The traces of a GTFS route (a row of feed.routes()) as GPX: {files: [{name, text, type}], summary}. */
export async function lineToGpx(feed, route, { onProgress = () => {} } = {}) {
  const ref = route.route_short_name || "";
  const label = ref || route.route_long_name || route.route_id;
  onProgress(`Trips of line ${label}…`);
  const trips = (await feed.trips()).filter((t) => t.route_id === route.route_id);
  if (!trips.length) throw new Error(`Line ${label} has no trip in the GTFS.`);
  onProgress("Stop times…");
  const traces = lineTraces(stopSequences(trips, await feed.stopTimes(trips.map((t) => t.trip_id))));
  if (!traces.length) throw new Error(`Line ${label} has no stop time in the GTFS.`);
  onProgress("Shapes and stops…");
  const shapes = await feed.shapes(traces.map((t) => t.shape_id).filter(Boolean));
  const stops = new Map((await feed.stops()).map((s) => [s.stop_id, s]));

  const prefix = modePrefix(route.mode || "bus"), colour = route.route_color || "";
  const at = (id) => stops.get(id);
  let straight = 0;
  const tracks = traces.map((trace, k) => {
    const seqStops = trace.seq.map(at).filter(Boolean);
    const shape = shapes.get(trace.shape_id);
    const fromShape = shape?.length > 1;
    if (!fromShape) straight++;
    if (trace.shape_id && !fromShape) log.warn(`Shape ${trace.shape_id} missing from shapes.txt: drawn through its stops`);
    const path = fromShape ? shape : seqStops.map((s) => [s.lat, s.lon]);
    const from = seqStops[0]?.stop_name || "", to = seqStops.at(-1)?.stop_name || "";
    const name = tripTitle(prefix, ref, from, to);
    const km = (pathLength(path).at(-1) || 0) / 1000;
    const desc = lines([["route_id", route.route_id], ["shape_id", trace.shape_id], ["direction_id", trace.direction], ["trips", trace.trips],
      ["trip_id", trace.trip_id], ["stops", trace.seq.length], ["length", `${km.toFixed(1)} km`], ["trace", fromShape ? "GTFS shape" : "straight lines between the stops"]]);
    return { name, cmt: ref, desc, type: route.mode, colour, segments: path.length > 1 ? [path] : [], stops: seqStops, km, from, to, index: k + 1 };
  }).filter((t) => t.segments.length);
  if (!tracks.length) throw new Error(`Line ${label}: no trace with at least two points.`);
  if (straight) log.warn(`${straight} trace(s) of line ${label} without a shape: straight lines between the stops`);

  const waypoint = (s) => ({
    lat: s.lat, lon: s.lon, name: s.stop_name, cmt: s.stop_code,
    desc: lines([["lines", ref], ["stop_id", s.stop_id], ["stop_code", s.stop_code], ["platform_code", s.platform_code], ["wheelchair", WHEELCHAIR[s.wheelchair_boarding]]]),
    type: "platform",
  });
  const labelsOf = (t) => (ref ? t.segments.flatMap(labelPoints).map(([lat, lon]) => ({ lat, lon, name: ref, desc: t.name, type: "label", colour })) : []);
  const stopsOf = (list) => [...new Map(list.flatMap((t) => t.stops).map((s) => [s.stop_id, s])).values()];
  const gpxOf = (list) => writeTracks(list, [...stopsOf(list).map(waypoint), ...list.flatMap(labelsOf)]);

  const base = slug(`${prefix} ${label}`) || "line";
  const file = (name, text) => ({ name, text, type: "application/gpx+xml" });
  const files = tracks.map((t) => file(`${base}_${t.index}_${slug(t.from) || "start"}_${slug(t.to) || "end"}.gpx`, gpxOf([t])));
  if (tracks.length > 1) files.unshift(file(`${base}_all.gpx`, gpxOf(tracks)));
  const km = tracks.reduce((sum, t) => sum + t.km, 0);
  log.info(`Line ${label}: ${tracks.length} trace(s), ${stopsOf(tracks).length} stop(s), ${trips.length} trip(s)`);
  return { files, summary: { traces: tracks.length, stops: stopsOf(tracks).length, trips: trips.length, Length: `${km.toFixed(1)} km` } };
}
