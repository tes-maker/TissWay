// A trace already mapped in OSM is kept when it is good: corrections made by hand are not replaced by what Valhalla computes, and the public server
// is not called for nothing. It is good when it can be travelled from end to end and serves the stops of the variant, in order. Otherwise, the
// reason is logged and the variant is matched as usual. Only the ways are kept: the stops of the relation come from the GTFS.
//
// A relation with nothing left to do is complete (completeRelation): its ways and stops are all right, so that it is left as it is, ways not split.
//
// The stop_position of a terminus may be just beyond the trace: terminusRoads brings the road it is on, to avoid creating a duplicate.

import { dist, latlon, project } from "./geo.js";
import { Store, readWays, stopPositionsAround } from "./osm.js";
import { VEHICLE, fitsTerminus, forward, isStopPositionFor, makeSpot, onKerb, sideSegment, stopSegment } from "./platforms.js";
import { settings } from "./settings.js";
import { linkNode } from "./splitting.js";
import { log, maxBy } from "./util.js";

const TRAVELLED = new Set(["", "forward", "backward"]);

/** The ways of a relation, in order. */
export const waysOfRelation = (relation) => relation.members.filter(([ref, role]) => ref[0] === "w" && TRAVELLED.has(role)).map(([ref]) => ref);

function isOnewayAgainst(obj, ways, i) {
  const { tags, nodes } = obj.get(ways[i]);
  if (nodes[0] === nodes.at(-1)) return false; // a closed way has no first node to compare with
  if (tags["oneway:bus"] === "no" || tags["oneway:psv"] === "no") return false;
  const fwd = forward(obj, ways, i);
  if (tags.oneway === "-1") return fwd;
  return (tags.oneway === "yes" || tags.oneway === "1" || tags.oneway === "true" || tags.junction === "roundabout") && !fwd;
}

/** Why this trace is not good for these stops [[lat, lon]], null if it is. obj: the ways and their nodes. */
export function traceProblem(ways, stops, obj) {
  if (!ways.length) return "no way";
  const absent = ways.find((w) => !obj.get(w)?.nodes?.every((n) => obj.has(n)));
  if (absent) return `${absent} is not in OSM any more`;
  const path = [];
  for (let i = 0; i < ways.length; i++) {
    if (i && !obj.get(ways[i - 1]).nodes.some((n) => obj.get(ways[i]).nodes.includes(n))) return `gap between ${ways[i - 1]} and ${ways[i]}`;
    if (isOnewayAgainst(obj, ways, i)) return `${ways[i]} is travelled against its oneway`;
    const nodes = obj.get(ways[i]).nodes.map((n) => latlon(obj.get(n)));
    path.push(...(forward(obj, ways, i) ? nodes : nodes.reverse()));
  }
  const { stop_position_m, terminus_m } = settings.thresholds;
  let at = 0;
  for (const [k, stop] of stops.entries()) {
    const reach = k === 0 || k === stops.length - 1 ? terminus_m : stop_position_m;
    let found = -1;
    for (let i = at; i + 1 < path.length && found < 0; i++) if (project(stop, path[i], path[i + 1])[1] <= reach) found = i;
    if (found < 0) return `stop ${k + 1} of ${stops.length} is not served in order`;
    at = found;
  }
  const near = (stop, way) => {
    const nodes = obj.get(way).nodes.map((n) => latlon(obj.get(n)));
    return nodes.some((p, i) => dist(stop, p) <= terminus_m || (i && project(stop, nodes[i - 1], p)[1] <= terminus_m));
  };
  if (!near(stops[0], ways[0])) return "it starts before the first stop";
  if (!near(stops.at(-1), ways.at(-1))) return "it goes on after the last stop";
  return null;
}

/** Does the trace use each way from end to end, starting and ending exactly at these stop_positions? A closed way may be left at any node. */
function endsAt(ways, first, last, obj) {
  const nodesOf = (w) => obj.get(w).nodes, closed = (w) => nodesOf(w)[0] === nodesOf(w).at(-1);
  const isEnd = (n, w) => closed(w) ? nodesOf(w).includes(n) : n === nodesOf(w)[0] || n === nodesOf(w).at(-1);
  if (!isEnd(first, ways[0]) || !isEnd(last, ways.at(-1))) return false;
  if (ways.length === 1) return closed(ways[0]) || first !== last;
  const links = ways.slice(1).map((w, i) => linkNode(obj, ways[i], w));
  if (links.some((n, i) => n === null || !isEnd(n, ways[i]) || !isEnd(n, ways[i + 1]))) return false;
  return (closed(ways[0]) || first !== links[0]) && (closed(ways.at(-1)) || last !== links.at(-1));
}

/** [{stop, platform, way, pos}] for each stop of the variant, when the relation has nothing left to do, else null: a stop_position and a platform for each
 * GTFS stop, in order, each platform being one of the stop's, on the kerb side and not on the road, and a trace ending exactly at its first and last
 * stop_positions. The trace itself has been judged by traceProblem. */
export function completeRelation(relation, v, stops, ways, obj, vehicle = "bus") {
  const ofRole = (role) => relation.members.filter(([, r]) => r.startsWith(role)).map(([ref]) => ref);
  const stopNodes = ofRole("stop"), platforms = ofRole("platform");
  if (stopNodes.length !== v.seq.length || platforms.length !== v.seq.length) return null;
  if (stopNodes.some((n) => !obj.get(n)?.tags || !isStopPositionFor(obj.get(n).tags, vehicle))) return null;
  if (!endsAt(ways, stopNodes[0], stopNodes.at(-1), obj)) return null;
  const onRoad = new Set(ways.flatMap((w) => obj.get(w).nodes));
  const out = [];
  let at = 0;
  for (const [i, id] of v.seq.entries()) {
    const c = (stops.platforms.get(id) || []).find((p) => p.id === platforms[i]);
    if (!c || onRoad.has(c.id)) return null;
    while (at < ways.length && !obj.get(ways[at]).nodes.includes(stopNodes[i])) at++;
    if (at === ways.length) return null;
    const spot = makeSpot(at, latlon(obj.get(stopNodes[i])), 0, { node: stopNodes[i] });
    if (!onKerb(c.pos, stopSegment(obj, ways, spot), (p) => sideSegment(obj, ways, spot, p))) return null;
    out.push({ stop: stopNodes[i], platform: c.id, way: at, pos: c.pos });
  }
  return out;
}

/** Existing relations whose trace is kept for the variants of a route: {kept: Map variant -> [relation key, ways, stops of a complete relation or null], roads: the
 * ways read}. One relation for one variant: a complete one, else the one sharing the most platforms with it. */
export async function keepTraces(route, variants, network, existing, stops) {
  const kept = new Map();
  if (!settings.reuse_traces || !existing) return { kept, roads: {} };
  const candidates = existing.candidates(route.mode || "bus", route.route_short_name, network, route.route_id);
  const traces = new Map(candidates.map((k) => [k, waysOfRelation(existing.routes[k])]));
  const roads = await readWays(new Set([...traces.values()].flat()));
  const obj = new Store(roads);
  const taken = new Set();
  for (const v of variants) {
    const stopsOf = stops.positions(v.seq);
    const platforms = new Set(v.seq.flatMap((id) => (stops.platforms.get(id) || []).map((c) => c.id)));
    const good = [];
    for (const k of candidates) {
      if (taken.has(k)) continue;
      const problem = traceProblem(traces.get(k), stopsOf, obj);
      if (problem) log.debug(`  ${k} not kept for trip ${v.trip_id}: ${problem}`);
      else good.push(k);
    }
    const complete = good.map((k) => [k, completeRelation(existing.routes[k], v, stops, traces.get(k), obj, VEHICLE[route.mode] || "bus")]).find(([, c]) => c);
    const best = complete?.[0] ?? maxBy(good, (k) => existing.routes[k].members.filter(([ref]) => platforms.has(ref)).length);
    if (best) {
      kept.set(v, [best, traces.get(best), complete?.[1] ?? null]);
      taken.add(best);
    }
  }
  return { kept, roads };
}

/** The first and last stops of a variant to look for: [variant, index in its ways (0 or -1), stop position, neighbour position, name]. */
function terminiOf(v, stops) {
  const position = (id) => latlon(stops.df.get(id));
  const end = (i, next) => [v, i, position(v.seq.at(i)), v.seq.at(next) === v.seq.at(i) ? [] : [position(v.seq.at(next))], stops.df.get(v.seq.at(i)).stop_name];
  return v.seq.length > 1 ? [end(0, 1), end(-1, -2)] : [];
}

/** Add to the variants the road just beyond their trace holding the stop_position of their first or last stop, when the trace has none within terminus_m:
 * without it, a duplicate would be created. A road only used when it touches the trace and can be travelled that way. Unused, it is left out when the line is
 * built, the trace ending at the stop_position. Returns the ways and nodes read. */
export async function terminusRoads(variants, stops, roads) {
  const reach = settings.thresholds.terminus_m;
  const near = (v, pos) => v.ways.some((w) => roads[w].nodes.some((n) => isStopPositionFor(roads[n]?.tags ?? {}) && dist(latlon(roads[n]), pos) <= reach));
  const pending = variants.filter((v) => !v.complete).flatMap((v) => terminiOf(v, stops)).filter(([v, , pos]) => v.ways.length && !near(v, pos));
  if (!reach || !pending.length) return {};
  let found;
  try {
    found = await stopPositionsAround(pending.map(([, , pos]) => pos), reach);
  } catch (e) {
    if (e.name === "AbortError") throw e;
    log.warn(`stop_positions around the termini not available (${e.message})`);
    return {};
  }
  const obj = new Store({ ...found, ...roads });
  const entries = Object.entries(found);
  const candidates = entries.filter(([, o]) => o.lat !== undefined && isStopPositionFor(o.tags));
  for (const [v, i, pos, others, name] of pending) {
    const end = v.ways.at(i), inTrace = new Set(v.ways), touching = new Set(obj.get(end).nodes);
    const usable = (w) => {
      const ways = i === 0 ? [w, end] : [end, w];
      return !inTrace.has(w) && obj.get(w).nodes.some((n) => touching.has(n)) && !isOnewayAgainst(obj, ways, i === 0 ? 0 : 1);
    };
    const nearest = candidates.filter(([, o]) => dist(latlon(o), pos) <= reach && fitsTerminus(o.tags, latlon(o), pos, { name, others }))
      .sort(([, a], [, b]) => dist(latlon(a), pos) - dist(latlon(b), pos));
    for (const [n] of nearest) {
      const road = entries.find(([k, o]) => k[0] === "w" && o.nodes.includes(n) && usable(k));
      if (!road) continue;
      v.ways = i === 0 ? [road[0], ...v.ways] : [...v.ways, road[0]];
      log.info(`  trip ${v.trip_id}: ${road[0]} added to reach the stop_position ${n} of ${name}`);
      break;
    }
  }
  return found;
}
