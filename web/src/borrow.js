// A variant without a trace of its own in OSM borrows the ways of the other relations of the area that already serve the same stops one
// after the other: between two stops served in a row, with no other stop in between, a bus takes the road that has been mapped, most often
// checked by hand. The relations of any line of a road mode (bus, coach, trolleybus, share_taxi) are used, whatever their network.
//
// - every pair of consecutive stops of the variant served by such relations: the variant is the sequence of their pieces, each from the
//   relation serving the longest run of stops, if the whole can be travelled (reuse.traceProblem) and agrees with the GTFS shape when there
//   is one. Valhalla is not called;
// - some pairs only: the pieces guide Valhalla when the variant is routed through its stops (matching.matchVariant), the gaps being
//   routed between their stops.

import { dist, distancesToPolyline, latlon, project } from "./geo.js";
import { Store, readWays } from "./osm.js";
import { forward } from "./platforms.js";
import { traceProblem, waysOfRelation } from "./reuse.js";
import { settings } from "./settings.js";
import { log } from "./util.js";

const ROAD_MODES = new Set(["bus", "coach", "trolleybus", "share_taxi"]);
const STOP_ROLE = /^(?:stop|platform)(?:_entry_only|_exit_only)?$/;

/** Positions of the ways in the order of travel. */
export function pathOf(obj, ways) {
  const path = [];
  for (let i = 0; i < ways.length; i++) {
    const nodes = obj.get(ways[i]).nodes.map((n) => latlon(obj.get(n)));
    path.push(...(forward(obj, ways, i) ? nodes : nodes.reverse()).slice(path.length ? 1 : 0));
  }
  return path;
}

const wayDistance = (obj, way, p) => {
  const nodes = obj.get(way).nodes.map((n) => latlon(obj.get(n)));
  return nodes.length === 1 ? dist(p, nodes[0]) : Math.min(...nodes.slice(1).map((q, i) => project(p, nodes[i], q)[1]));
};

/** OSM member -> the stop_ids of the variants it may be: their candidate platforms and the stop_positions paired with them. */
function membersOfStops(ids, stops) {
  const out = new Map();
  const add = (member, id) => {
    if (!member) return;
    if (!out.has(member)) out.set(member, new Set());
    out.get(member).add(id);
  };
  for (const id of ids) {
    add(stops.paired?.get(id), id);
    for (const c of stops.platforms.get(id) || []) {
      add(c.id, id);
      add(stops.paired?.get(c.id), id);
    }
  }
  return out;
}

/** The stops of a relation in order: [{ids: Set of stop_ids, members}], the stop_position and the platform of one stop together. A member
 * none of our stops can be is a stop of its own, with no id: a run of stops never goes past it. */
function stopsOfRelation(relation, owners) {
  const out = [];
  for (const [ref, role] of relation.members) {
    if (!STOP_ROLE.test(role)) continue;
    const ids = owners.get(ref) || new Set(), kind = role.split("_")[0];
    const last = out.at(-1);
    if (last && ids.size && !last.kinds.has(kind) && [...ids].some((id) => last.ids.has(id))) {
      last.members.push(ref);
      last.kinds.add(kind);
      last.ids = new Set([...ids].filter((id) => last.ids.has(id)));
    } else out.push({ ids, members: [ref], kinds: new Set([kind]) });
  }
  return out;
}

/** Longest run of the relation's stops matching seq from position start: [first stop of the relation, number of stops], or null. */
function longestRun(relStops, seq, start) {
  let best = null;
  for (let p = 0; p < relStops.length; p++) {
    let n = 0;
    while (start + n < seq.length && p + n < relStops.length && relStops[p + n].ids.has(seq[start + n])) n++;
    if (n >= 2 && (!best || n > best[1])) best = [p, n];
  }
  return best;
}

/** Index in ways of the way serving this stop of the relation, from index from: the one with its stop_position, else the first one within
 * reach of its platform, or the nearest one after it. -1 if none is within reach. */
function wayAt(obj, ways, stop, from, positionOf) {
  const node = stop.members.find((m) => m[0] === "n" && ways.slice(from).some((w) => obj.get(w).nodes.includes(m)));
  if (node) return ways.findIndex((w, i) => i >= from && obj.get(w).nodes.includes(node));
  const pos = stop.members.map(positionOf).find(Boolean);
  if (!pos) return -1;
  const reach = settings.thresholds.terminus_m;
  let i = from;
  while (i < ways.length && wayDistance(obj, ways[i], pos) > reach) i++;
  if (i === ways.length) return -1;
  while (i + 1 < ways.length && wayDistance(obj, ways[i + 1], pos) < wayDistance(obj, ways[i], pos)) i++;
  return i;
}

/** The relations of the area that may lend pieces to these variants, and the ways read for them: {pieces(v), obj}. */
export async function borrowable(route, variants, existing, stops) {
  const none = { obj: new Store({}), roads: {}, pieces: () => [] };
  if (!settings.borrow_traces || !existing || !ROAD_MODES.has(route.mode || "bus")) return none;
  const owners = membersOfStops(new Set(variants.flatMap((v) => v.seq)), stops);
  const lenders = Object.entries(existing.routes)
    .filter(([, r]) => ROAD_MODES.has(r.tags.route))
    .map(([k, r]) => [k, stopsOfRelation(r, owners)])
    .filter(([, relStops]) => variants.some((v) => v.seq.some((_, i) => longestRun(relStops, v.seq, i))));
  if (!lenders.length) return none;
  const roads = await readWays(new Set(lenders.flatMap(([k]) => waysOfRelation(existing.routes[k]))));
  const obj = new Store(roads);
  const platformPos = new Map([...stops.platforms.values()].flat().map((c) => [c.id, c.pos]));
  const positionOf = (m) => (obj.get(m) ? latlon(obj.get(m)) : platformPos.get(m));
  const traces = new Map(lenders.map(([k]) => [k, waysOfRelation(existing.routes[k])]));
  const usable = lenders.filter(([k]) => traces.get(k).length && traces.get(k).every((w) => obj.get(w)?.nodes?.every((n) => obj.has(n))));

  /** [{from, to, ways, relation}] pieces of the variant, each from the relation serving the longest run of its stops from there. */
  const pieces = (v) => {
    const out = [];
    for (let i = 0; i + 1 < v.seq.length;) {
      let best = null;
      for (const [k, relStops] of usable) {
        const run = longestRun(relStops, v.seq, i);
        if (!run || (best && run[1] <= best.n)) continue;
        const ways = traces.get(k), a = wayAt(obj, ways, relStops[run[0]], 0, positionOf);
        const b = a < 0 ? -1 : wayAt(obj, ways, relStops[run[0] + run[1] - 1], a, positionOf);
        if (b >= 0) best = { n: run[1], from: i, to: i + run[1] - 1, ways: ways.slice(a, b + 1), relation: k };
      }
      if (!best) { i++; continue; }
      out.push(best);
      i = best.to;
    }
    return out;
  };
  return { obj, roads, pieces };
}

const withoutRepeat = (ways) => ways.filter((w, i) => w !== ways[i - 1]);

/** Ways of the variant made of borrowed pieces only, or null: every pair of stops covered, a trace that can be travelled, and close to the
 * GTFS shape if any (a shape that disagrees leaves the choice to Valhalla). */
export function borrowedTrace(v, pieces, obj, positions, shape = null) {
  if (!pieces.length || pieces[0].from !== 0 || pieces.at(-1).to !== v.seq.length - 1 || pieces.some((p, i) => i && p.from !== pieces[i - 1].to)) return null;
  const ways = withoutRepeat(pieces.flatMap((p) => p.ways));
  const problem = traceProblem(ways, positions, obj);
  if (problem) {
    log.debug(`  trip ${v.trip_id}: the traces of ${[...new Set(pieces.map((p) => p.relation))].join(", ")} not borrowed: ${problem}`);
    return null;
  }
  if (shape?.length > 1) {
    const far = distancesToPolyline(shape, pathOf(obj, ways)).filter((d) => d > settings.thresholds.terminus_m).length;
    if (far / shape.length > settings.thresholds.max_far_stops) {
      log.debug(`  trip ${v.trip_id}: borrowed trace far from the GTFS shape, not used`);
      return null;
    }
  }
  return ways;
}

/** Path guiding Valhalla through the stops: the borrowed pieces, cut at their stops, and the gaps routed with routeThrough(stops). */
export async function guidedPath(pieces, obj, positions, routeThrough) {
  const path = [];
  const nearest = (line, p, from = 0) => {
    let best = from;
    for (let i = from; i < line.length; i++) if (dist(line[i], p) < dist(line[best], p)) best = i;
    return best;
  };
  let at = 0;
  for (const piece of [...pieces, null]) {
    const until = piece ? piece.from : positions.length - 1;
    if (until > at) path.push(...(await routeThrough(positions.slice(at, until + 1))));
    if (!piece) break;
    const line = pathOf(obj, piece.ways), a = nearest(line, positions[piece.from]);
    path.push(...line.slice(a, nearest(line, positions[piece.to], a) + 1));
    at = piece.to;
  }
  return path;
}
