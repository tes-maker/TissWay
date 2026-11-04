// A trace already mapped in OSM is kept when it is good: corrections made by hand are not replaced by what Valhalla computes, and the public server
// is not called for nothing. It is good when it can be travelled from end to end and serves the stops of the variant, in order. Otherwise, the
// reason is logged and the variant is matched as usual. Only the ways are kept: the stops of the relation always come from the GTFS.

import { dist, latlon, project } from "./geo.js";
import { Store, readWays } from "./osm.js";
import { forward } from "./platforms.js";
import { settings } from "./settings.js";
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
  const reach = settings.thresholds.stop_position_m;
  let at = 0;
  for (const [k, stop] of stops.entries()) {
    let found = -1;
    for (let i = at; i + 1 < path.length && found < 0; i++) if (project(stop, path[i], path[i + 1])[1] <= reach) found = i;
    if (found < 0) return `stop ${k + 1} of ${stops.length} is not served in order`;
    at = found;
  }
  const near = (stop, way) => {
    const nodes = obj.get(way).nodes.map((n) => latlon(obj.get(n)));
    return nodes.some((p, i) => dist(stop, p) <= reach || (i && project(stop, nodes[i - 1], p)[1] <= reach));
  };
  if (!near(stops[0], ways[0])) return "it starts before the first stop";
  if (!near(stops.at(-1), ways.at(-1))) return "it goes on after the last stop";
  return null;
}

/** Existing relations whose trace is kept for the variants of a route: {kept: Map variant -> [relation key, ways], roads: the ways read}. One relation for
 * one variant, the one sharing the most platforms with it. */
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
    const best = maxBy(good, (k) => existing.routes[k].members.filter(([ref]) => platforms.has(ref)).length);
    if (best) {
      kept.set(v, [best, traces.get(best)]);
      taken.add(best);
    }
  }
  return { kept, roads };
}
