// The stops of a route on the ground: a stop_position on the way and a platform beside it.
//
// Rules:
// - every stop gets a stop_position and a platform;
// - the stop_position lies on the travelled way, at the projection of the GTFS stop, in two steps: locateStop finds
//   the spot without changing anything, materialize creates the node or reuses an existing stop_position, so that
//   the caller can fix the side of the stop (fixSide) before anything is written;
// - when an existing OSM platform is used, the existing stop_position nearest to it is reused, unless it clearly
//   belongs to the platform of a rival stop (nearestToPlatform);
// - otherwise an existing stop_position is reused when near the projection of the stop, unless closer to the
//   projection of a rival across the road: on a two-way road both directions are often one way, and the
//   stop_position of the opposite stop may be within reach (reusable);
// - whatever the above, a stop_position closer to the stop across the road than to this stop is not reused, even on a good trace (closerToOpposite,
//   settings.stop_position_own): it is left to that stop, and this stop gets its own;
// - a new stop_position only carries public_transport=stop_position, <vehicle>=yes, name and, on a two-way way,
//   direction=forward|backward. An existing one keeps its tags: only the missing ones are added, except name,
//   replaced by the name of the stop. A direction set here is removed if it turns out to be served both ways;
// - the platform is chosen on the kerb side of the way (settings.driving_side) in the direction of travel, judged
//   on the road segment next to the platform (sideSegment), and for the GTFS stop on its segment (stopSegment);
// - a platform found with the extended reach is only used on the kerb side and next to the way (verified);
// - when the GTFS attaches the route to the opposite platform (a common error), the data of the other GTFS platform
//   of the same stop is used instead (fixSide);
// - a GTFS stop_id is set on a single OSM platform (tagPlatforms), even when the GTFS has a single stop for both
//   directions;
// - tags of another network are never overwritten: ref belongs to the network owning the stop, the others use ref:<network> (enrich).

import { feedKey } from "./existing.js";
import { dist, interpolate, latlon, lineDistance, project, rightOf, xy } from "./geo.js";
import { refSortKey } from "./gtfs.js";
import { stopKey } from "./naming.js";
import { isNew, newKey } from "./osm.js";
import { settings } from "./settings.js";
import { listIn, log, minBy, sameTags, sortedBy } from "./util.js";

export const VEHICLE = { bus: "bus", coach: "bus", trolleybus: "trolleybus" };
const OTHER_VEHICLES = ["tram", "train", "subway", "light_rail", "monorail", "ferry", "funicular"];

/** Is p on the kerb side (right, or left in left-hand traffic) of the directed segment a -> b? */
export const kerbSide = (p, a, b) => rightOf(p, a, b) !== (settings.driving_side === "left");

// --- stop_position ----------------------------------------------------------------------------------------

/** Spot {wayIndex, pos, distance, node, a, b}: where a stop_position goes on ways[wayIndex], an existing one (node)
 * or a new node at pos on the segment a -> b (node keys). distance: GTFS stop -> way. */
export const makeSpot = (wayIndex, pos, distance, { node = null, a = null, b = null } = {}) => ({ wayIndex, pos, distance, node, a, b });

export function isStopPositionFor(tags, vehicle = "bus") {
  if (tags.public_transport !== "stop_position" || tags[vehicle] === "no") return false;
  return tags[vehicle] === "yes" || !OTHER_VEHICLES.some((v) => tags[v] === "yes");
}

/** [position a, position b] of each segment of a way. */
function* segmentsOf(obj, way) {
  const nodes = obj.get(way).nodes;
  for (let i = 1; i < nodes.length; i++) yield [latlon(obj.get(nodes[i - 1])), latlon(obj.get(nodes[i]))];
}

/** [distance, projected point, [a, b] positions] of p on the nearest segment of these ways. */
function nearestOn(obj, wayKeys, p) {
  let best = [Infinity, null, null];
  for (const w of wayKeys) {
    for (const [pa, pb] of segmentsOf(obj, w)) {
      const [t, d] = project(p, pa, pb);
      if (d < best[0]) best = [d, interpolate(pa, pb, t), [pa, pb]];
    }
  }
  return best;
}

/** Projections on these ways of the rivals of the stop at pos (projected at target) that stand across the road and
 * are offset along it by more than stop_position_shared_m. Rivals on the same side are the same platform for another
 * network (aggregated feeds); face-to-face rivals share the stop_position. */
function rivalPoints(obj, wayKeys, pos, target, rivals) {
  const th = settings.thresholds, points = [];
  for (const r of rivals) {
    if (dist(r, pos) <= th.duplicate_stop_m) continue;
    const [d, point, seg] = nearestOn(obj, wayKeys, r);
    if (d <= th.stop_position_m && rightOf(r, ...seg) !== rightOf(pos, ...seg) && dist(point, target) > th.stop_position_shared_m) {
      points.push(point);
    }
  }
  return points;
}

const OPPOSITE_MARGIN_M = 2; // along the road: stops this close face each other, and share their stop_position

/** Is the stop_position at p closer to a stop across the road (opposites: positions) than to the stop at pos (settings.stop_position_own)? Compared along these ways,
 * at the projections of the stops: a platform set back from the road must not lose to one on the kerb. A stop on the same side is the same platform for another network. */
export function closerToOpposite(obj, wayKeys, p, pos, opposites) {
  if (!settings.stop_position_own || !opposites.length) return false;
  const th = settings.thresholds, own = dist(p, nearestOn(obj, wayKeys, pos)[1]);
  return opposites.some((r) => {
    if (dist(r, pos) <= th.duplicate_stop_m) return false;
    const [d, point, seg] = nearestOn(obj, wayKeys, r);
    return d <= th.stop_position_m && rightOf(r, ...seg) !== rightOf(pos, ...seg) && dist(p, point) < own - OPPOSITE_MARGIN_M;
  });
}

/** [way index, node, position] of the existing stop_positions on this run of ways. */
function* stopPositionsOn(obj, ways, run, vehicle) {
  for (const j of run) {
    for (const n of obj.get(ways[j]).nodes) {
      if (isStopPositionFor(obj.get(n).tags, vehicle)) yield [j, n, latlon(obj.get(n))];
    }
  }
}

const smallest = (found) => (found.length ? minBy(found).slice(1) : null);

/** May the stop_position at p be the one of the first or last stop at pos? terminus: {name of the stop, others: positions of the next stops}. It may be
 * further than the usual reach: then a name, if any, must be the one of the stop, and it must be closer to this stop than to the next one. */
export function fitsTerminus(tags, p, pos, terminus) {
  return (!tags.name || stopKey(tags.name) === stopKey(terminus.name)) && !terminus.others.some((other) => dist(p, other) < dist(p, pos));
}

/** Is the stop_position n at p within reach of the stop at pos, projected at target? */
function inReach(obj, n, p, pos, target, terminus) {
  const th = settings.thresholds, d = dist(p, target);
  if (d > (terminus ? th.terminus_m : th.stop_position_reuse_m)) return false;
  return d <= th.stop_position_reuse_m || fitsTerminus(obj.get(n).tags, p, pos, terminus);
}

/** [way index, node] of the existing stop_position to reuse for a stop at pos whose projection is target, or null.
 * Within stop_position_shared_m of target it is always reused. Further, up to stop_position_reuse_m, it is left to a
 * rival across the road whose projection is closer to it: a new stop_position is then created in front of this stop. */
function reusable(obj, ways, run, pos, target, rivals, vehicle, terminus, opposites) {
  const th = settings.thresholds, found = [];
  let points = null; // computed only when needed
  for (const [j, n, p] of stopPositionsOn(obj, ways, run, vehicle)) {
    if (!inReach(obj, n, p, pos, target, terminus)) continue;
    if (closerToOpposite(obj, run.map((k) => ways[k]), p, pos, opposites)) continue;
    const d = dist(p, target);
    if (d > th.stop_position_shared_m) {
      points ??= rivalPoints(obj, run.map((k) => ways[k]), pos, target, rivals);
      if (points.some((q) => dist(p, q) < d)) continue; // the rival's stop_position
    }
    found.push([d, j, n]);
  }
  return smallest(found);
}

/** [way index, node] of the existing stop_position nearest to the platform at pos (within stop_position_reuse_m of its
 * projection target), or null. One clearly closer to the platform of a rival stop (rivals: positions of OSM platforms)
 * is left to it. */
function nearestToPlatform(obj, ways, run, pos, target, rivals, vehicle, terminus, opposites) {
  const th = settings.thresholds, found = [];
  for (const [j, n, p] of stopPositionsOn(obj, ways, run, vehicle)) {
    if (!inReach(obj, n, p, pos, target, terminus)) continue;
    if (closerToOpposite(obj, run.map((k) => ways[k]), p, pos, opposites)) continue;
    const d = dist(p, pos);
    if (!rivals.some((r) => dist(p, r) < d - th.stop_position_shared_m)) found.push([d, j, n]);
  }
  return smallest(found);
}

/** Spot of the stop_position of a GTFS stop at pos on the first run of ways, from ways[start], passing within max_m
 * (default stop_position_m) of it, or null. Nothing is changed (see materialize). rivals: positions of the GTFS stops
 * that may own an existing stop_position nearby. platform: pos is the OSM platform used, rivals the OSM platforms of
 * the rival stops. terminus: for the first or last stop, see fitsTerminus; the reach is then terminus_m. opposites: positions of the stops closerToOpposite compares with,
 * by default the rivals. */
export function locateStop(obj, ways, pos, { start = 0, max_m = null, rivals = [], vehicle = "bus", platform = false, terminus = null, opposites = rivals } = {}) {
  const limit = max_m ?? (terminus ? settings.thresholds.terminus_m : settings.thresholds.stop_position_m);
  let best = null;
  const run = [];
  for (let i = start; i < ways.length; i++) {
    const nodes = obj.get(ways[i]).nodes;
    let near = false;
    for (let k = 0; k + 1 < nodes.length; k++) {
      const [t, d] = project(pos, latlon(obj.get(nodes[k])), latlon(obj.get(nodes[k + 1])));
      if (d > limit) continue;
      near = true;
      if (!best || d < best[0]) best = [d, i, k, t];
    }
    if (near) run.push(i);
    else if (best) break;
  }
  if (!best) return null;
  const [d, i, k] = best;
  let t = best[3];
  const nodes = obj.get(ways[i]).nodes;
  const pa = latlon(obj.get(nodes[k])), pb = latlon(obj.get(nodes[k + 1]));
  const target = interpolate(pa, pb, t);
  const reuse = (platform ? nearestToPlatform : reusable)(obj, ways, run, pos, target, rivals, vehicle, terminus, opposites);
  if (reuse) return makeSpot(reuse[0], latlon(obj.get(reuse[1])), d, { node: reuse[1] });
  const length = dist(pa, pb);
  t = length > 2 ? Math.min(Math.max(t, 1 / length), 1 - 1 / length) : 0.5; // not on top of an existing node
  return makeSpot(i, interpolate(pa, pb, t), d, { a: nodes[k], b: nodes[k + 1] });
}

/** Key of the stop_position of spot: the existing one, retagged, or a new node inserted in the way. Either way it
 * gets the direction of travel (setDirection). */
export function materialize(obj, ways, spot, name, vehicle = "bus") {
  const fwd = forward(obj, ways, spot.wayIndex);
  const way = ways[spot.wayIndex];
  if (spot.node) {
    setStopPositionTags(obj, spot.node, name, vehicle);
    setDirection(obj, way, spot.node, fwd);
    return spot.node;
  }
  const nodes = obj.edit(way).nodes;
  const k = nodes.findIndex((n, i) => n === spot.a && nodes[i + 1] === spot.b);
  const key = newKey("n");
  obj.set(key, { lat: spot.pos[0], lon: spot.pos[1], tags: stopPositionTags(name, vehicle) });
  nodes.splice(k + 1, 0, key);
  Object.assign(spot, { node: key, a: null, b: null });
  setDirection(obj, way, key, fwd);
  return key;
}

const ONEWAY = new Set(["yes", "1", "true", "-1", "reversible", "alternating"]);

/** direction=forward|backward on the stop_position key of way: the direction of travel relative to the order of the
 * way's nodes. Only on a two-way way and inside it (at an end, shared with the next way, it would be ambiguous). A
 * direction already in OSM is kept; one set here is removed if the stop_position is served both ways (o.directions,
 * not written). */
function setDirection(obj, way, key, fwd) {
  const { tags, nodes } = obj.get(way);
  if (ONEWAY.has(tags.oneway) || tags.junction === "roundabout" || tags.junction === "circular") return;
  if (!nodes.slice(1, -1).includes(key)) return;
  if ("direction" in obj.get(key).tags && !obj.get(key).directions) return;
  const o = obj.edit(key);
  (o.directions ??= new Set()).add(fwd ? "forward" : "backward");
  if (o.directions.size === 1) o.tags.direction = [...o.directions][0];
  else delete o.tags.direction;
}

/** Does the variant travel ways[i] in the order of its nodes? Deduced from the nodes shared with the previous way
 * (entry) and the next one (exit); failing that, node order unless oneway=-1. */
export function forward(obj, ways, i) {
  const nodes = obj.get(ways[i]).nodes;
  const shared = (j) => {
    if (j < 0 || j >= ways.length) return [];
    const other = new Set(obj.get(ways[j]).nodes);
    return nodes.flatMap((n, k) => (other.has(n) ? [k] : []));
  };
  const entry = shared(i - 1), exit = shared(i + 1);
  if (entry.length && exit.length) return Math.min(...entry) < Math.max(...exit);
  if (exit.length) return Math.max(...exit) > 0;
  if (entry.length) return Math.min(...entry) < nodes.length - 1;
  return obj.get(ways[i]).tags.oneway !== "-1";
}

/** Segment [a, b] of positions around the spot, in the direction of travel (not in the order of the way's nodes). */
export function travelSegment(obj, ways, spot) {
  const nodes = obj.get(ways[spot.wayIndex]).nodes;
  let [a, b] = [spot.a, spot.b];
  if (spot.node) {
    const i = nodes.indexOf(spot.node);
    [a, b] = [nodes[Math.max(i - 1, 0)], nodes[Math.min(i + 1, nodes.length - 1)]];
  }
  const pa = latlon(obj.get(a)), pb = latlon(obj.get(b));
  return forward(obj, ways, spot.wayIndex) ? [pa, pb] : [pb, pa];
}

// --- platform ---------------------------------------------------------------------------------------------

/** Is ways[i] a detour off a road and back onto it (lay-by, bus bay, service road): an unnamed or service way between
 * the same way, or two ways of the same name? */
export function layBy(obj, ways, i) {
  if (!(i > 0 && i < ways.length - 1)) return false;
  const tags = obj.get(ways[i]).tags;
  if (tags.name && tags.highway !== "service") return false;
  const name = obj.get(ways[i - 1]).tags.name;
  return ways[i - 1] === ways[i + 1] || (Boolean(name) && name === obj.get(ways[i + 1]).tags.name);
}

/** [distance, segment [a, b] in the direction of travel] of the segment of ways[k], k in indices, nearest to p. */
function nearestTravelled(obj, ways, p, indices) {
  let best = [Infinity, null];
  for (const k of indices) {
    for (const [pa, pb] of segmentsOf(obj, ways[k])) {
      const d = project(p, pa, pb)[1];
      if (d < best[0]) best = [d, forward(obj, ways, k) ? [pa, pb] : [pb, pa]];
    }
  }
  return best;
}

/** Cosine of the angle between the directed segments s and t. */
function cosine(s, t) {
  const [ux, uy] = xy(s[1], s[0]), [vx, vy] = xy(t[1], t[0]);
  const norm = Math.hypot(ux, uy) * Math.hypot(vx, vy);
  return norm ? (ux * vx + uy * vy) / norm : 1;
}

/** Segment on which the side of the GTFS stop is judged: the one of the spot, or, when the spot is on a leg of a lay-by
 * entering or leaving the road (more than 45° off it), the segment of the road next to it. */
export function stopSegment(obj, ways, spot) {
  const segment = travelSegment(obj, ways, spot), i = spot.wayIndex;
  if (!layBy(obj, ways, i)) return segment;
  const road = nearestTravelled(obj, ways, spot.pos, [i - 1, i + 1])[1];
  return road && cosine(segment, road) < Math.SQRT1_2 ? road : segment;
}

/** Segment on which the side of an OSM platform at p is judged: the segment of the road at the stop nearest to the
 * platform. The road: the way of the stop and its neighbours, except other lay-bys; the way of the stop is kept unless
 * another one is closer by more than thresholds.side_way_m. */
export function sideSegment(obj, ways, spot, p) {
  const i = spot.wayIndex, road = [];
  for (let k = Math.max(i - 1, 0); k < Math.min(i + 2, ways.length); k++) if (k === i || !layBy(obj, ways, k)) road.push(k);
  const best = minBy(road, (k) => nearestTravelled(obj, ways, p, [k])[0] - (k === i ? settings.thresholds.side_way_m : 0));
  return nearestTravelled(obj, ways, p, [best])[1];
}

/** Distance from p to the travelled ways (around the index around, all of them if null). The projection stops at the
 * ends of the segments: a platform on a street the route does not take is far from them, even next to the junction. */
export function roadDistance(obj, ways, p, around = null, span = 3) {
  const lo = around === null ? 0 : Math.max(around - span, 0);
  const hi = around === null ? ways.length : Math.min(around + span + 1, ways.length);
  return nearestTravelled(obj, ways, p, Array.from({ length: hi - lo }, (_, i) => lo + i))[0];
}

/** Is the OSM platform at p on the kerb side: of side(p) (see sideSegment), else of segment? */
export function onKerb(p, segment, side = null) {
  const seg = side ? side(p) : segment;
  return Boolean(seg) && kerbSide(p, ...seg);
}

/** Can this candidate be used? Always if within platform_m of the GTFS stop (or carrying its stop_id); found with the
 * extended reach (far), only on the kerb side and within platform_road_m of the travelled ways. */
function verified(candidate, segment, road = null, side = null) {
  if (!candidate.far) return true;
  if (!segment || !onKerb(candidate.pos, segment, side)) return false;
  const d = road ? road(candidate.pos) : lineDistance(candidate.pos, ...segment);
  return d <= settings.thresholds.platform_road_m;
}

const best = (candidates, ref) => minBy(candidates, (c) => [c.holder ? 0 : 1, dist(ref, c.pos)]) ?? null;

/** Candidate OSM platform on the kerb side rather than across the road: the one already carrying the stop_id in OSM,
 * else the nearest to the GTFS stop, or to the stop_position (spotPos) when they all have the same name. Unverified far
 * candidates are left out. null without candidates. */
export function choosePlatform(candidates, stop, { segment = null, spotPos = null, road = null, side = null } = {}) {
  let usable = candidates.filter((c) => verified(c, segment, road, side));
  let ref = stop;
  if (segment) {
    const kerb = usable.filter((c) => onKerb(c.pos, segment, side));
    if (kerb.length) usable = kerb;
    if (spotPos && new Set(usable.map((c) => c.name)).size === 1) ref = spotPos;
  }
  return best(usable, ref);
}

/** [platform, GTFS stop_id whose data it takes]. When the GTFS attaches the route to the stop across the road, the other
 * GTFS platform of the same stop on the kerb side is used: its OSM platform on that side, else the chosen platform if on
 * that side, else null (a platform is created at its position). Unchanged when the stop is already on the kerb side or
 * when the GTFS has no platform on that side. */
export function fixSide(stopId, platform, segment, stops, road = null, side = null) {
  if (!segment) return [platform, stopId];
  const pos = (id) => latlon(stops.df.get(id));
  const kerb = (p) => kerbSide(p, ...segment); // GTFS stops: on the segment of the stop
  if (kerb(pos(stopId))) return [platform, stopId];
  const opposite = minBy((stops.neighbours.get(stopId) || []).filter((id) => kerb(pos(id))), (id) => dist(pos(id), pos(stopId)));
  if (opposite === undefined) return [platform, stopId];
  let candidates = (stops.platforms.get(opposite) || []).filter((c) => onKerb(c.pos, segment, side) && verified(c, segment, road, side));
  if (!candidates.length && platform && onKerb(platform.pos, segment, side)) candidates = [platform];
  return [best(candidates, pos(opposite)), opposite];
}

// --- tags -------------------------------------------------------------------------------------------------

export const CODE_IN_ID = /(?:^|:)[A-Z]{2}:[^:]*:ZE:([^:]+)/; // NeTEx-style ids: "FR:<INSEE>:ZE:<code>:..."

/** ref of a platform: the stop_code, else (settings.ref_from_stop_id) the code of a NeTEx-style stop_id, else null. */
export function stopRef(stop, stopId) {
  if (stop.stop_code) return stop.stop_code;
  const m = settings.ref_from_stop_id === true || settings.ref_from_stop_id === "yes" ? CODE_IN_ID.exec(stopId) : null;
  return m ? m[1] : null;
}

const PHYSICAL_TAGS = new Set(["public_transport", "highway", "bus", "trolleybus", "wheelchair"]); // survey data wins

/** Remove bus=yes from a platform: PTv2 only asks for it on stop_positions. Kept when it tells the bus apart from another mode using the platform. */
export function dropBusTag(t) {
  const shared = t.railway || t.trolleybus === "yes" || t.coach === "yes" || OTHER_VEHICLES.some((v) => t[v] === "yes");
  if (t.bus === "yes" && !shared) delete t.bus;
}

/** Platform tags taken from the GTFS. No bus=yes (see dropBusTag); trolleybus=yes and coach=yes say what highway=bus_stop does not. */
export function stopTags(stop, stopId, network, mode = "bus") {
  const tags = { public_transport: "platform", highway: "bus_stop", ...(mode === "trolleybus" || mode === "coach" ? { [mode]: "yes" } : {}),
    name: stop.stop_name, ...network, [feedKey("gtfs:stop_id")]: stopId };
  if (stop.official_name) tags.official_name = stop.official_name;
  if (stop.stop_code) tags[feedKey("gtfs:stop_code")] = stop.stop_code;
  for (const t of settings.stop_ref_tags) tags[t] = stopId;
  const ref = stopRef(stop, stopId);
  if (ref) tags.ref = ref;
  if (stop.platform_code) tags.local_ref = stop.platform_code;
  if (stop.wheelchair_boarding === "1" || stop.wheelchair_boarding === "2") tags.wheelchair = stop.wheelchair_boarding === "1" ? "yes" : "no";
  return tags;
}

/** Set the GTFS data on the platforms chosen by the routes (assignments: stop_id -> Map platform -> [network tags, position, mode]). A stop_id
 * is set on a single platform: the one already carrying it in OSM, else the nearest to the GTFS stop. The others only get name and network, and
 * lose the stop_id if they had it. If an OSM platform outside these routes already carries the stop_id, it is set nowhere. Returns the stop_ids
 * left out for that reason.
 *
 * A ref identifies one physical stop, so that a platform has one ref per network and a ref is on one platform (see uniqueOwners, refTaken). */
export function tagPlatforms(obj, stops, assignments, { sizes = null, ofStop = new Map() } = {}) {
  const elsewhere = [];
  const own = new Set([feedKey("gtfs:stop_id"), feedKey("gtfs:stop_name"), feedKey("gtfs:stop_code"), ...settings.stop_ref_tags, "ref", "local_ref", "wheelchair"]);
  const prefixes = ["gtfs:stop_id", ...settings.stop_ref_tags];
  const owners = new Map();
  for (const [dataId, plats] of assignments) {
    const d = stops.df.get(dataId);
    const holders = stops.holders.get(dataId) ?? new Set();
    const outside = [...holders].filter((h) => !plats.has(h)).sort();
    if (outside.length) elsewhere.push(`${d.stop_name} (${dataId}: ${outside.join(", ")})`);
    owners.set(dataId, outside.length ? null : minBy([...plats.keys()], (p) => [holders.has(p) ? 0 : 1, dist(latlon(d), plats.get(p)[1])]));
  }
  uniqueOwners(owners, stops, assignments);
  const refsOnPlatforms = platformRefs(obj, owners, assignments);
  const given = new Map(); // network + ref -> platform that received it in this run
  for (const [dataId, plats] of assignments) {
    const d = stops.df.get(dataId);
    const holders = stops.holders.get(dataId) ?? new Set();
    const owner = owners.get(dataId);
    for (const [p, [network, , mode]] of plats) {
      let tags = stopTags(d, dataId, network, mode);
      if (p !== owner) {
        tags = Object.fromEntries(Object.entries(tags).filter(([k]) => !own.has(k)));
        if (holders.has(p)) removeStopIds(obj.edit(p).tags, prefixes, (v) => v === dataId); // duplicate already in OSM
      } else if (tags.ref) {
        const key = `${network.network}\u0001${tags.ref}`;
        const other = given.get(key) ?? refsOnPlatforms.get(key);
        if (other && other !== p) {
          log.warn(`ref ${tags.ref} of ${d.stop_name} (${dataId}) is already on ${other}, not set on ${p} (to check)`);
          delete tags.ref;
        } else given.set(key, p);
      }
      if (p === owner && !isNew(p) && plats.get(p)[3] !== false) { // the stop across the road, same network, is not this platform's
        const other = (v) => v !== dataId && ofStop.get(v)?.has(network.network);
        const removed = removeStopIds(obj.edit(p).tags, prefixes, other);
        if (removed.size) log.info(`${p}: ${[...removed].join(", ")} removed, stop(s) of ${network.network} on the other side of ${dataId}`);
        const codes = new Set([...removed].map((v) => stops.df.get(v)?.stop_code).filter(Boolean));
        if (codes.size) removeStopIds(obj.get(p).tags, ["gtfs:stop_code"], (v) => codes.has(v));
      }
      if (isNew(p)) obj.get(p).tags = { ...tags, ...obj.get(p).tags };
      else enrich(obj, p, tags, sizes, ofStop);
    }
  }
  reportSameRefs(obj);
  return elsewhere;
}

/** A ref on two platforms of the file, of any network, is reported: possibly in OSM already, for a network not treated in this run. */
function reportSameRefs(obj) {
  const seen = new Map();
  for (const [key, o] of obj.modified) {
    const t = o.tags;
    if (t?.public_transport !== "platform") continue;
    for (const [k, v] of Object.entries(t)) {
      const network = k === "ref" ? t.network : k.startsWith("ref:") ? networkOfRefKey(k, t) : null;
      if (!network) continue;
      const id = `${network}\u0001${v}`;
      if (seen.has(id) && seen.get(id) !== key) log.warn(`ref ${v} of ${network} is on both ${seen.get(id)} and ${key}: a ref is for one physical stop (to check)`);
      seen.set(id, key);
    }
  }
}

/** Values taken out of the tags of a platform holding stop ids (keys with these prefixes, values separated by ";"). Returns the values removed. */
function removeStopIds(t, prefixes, unwanted) {
  const removed = new Set();
  for (const key of Object.keys(t)) {
    if (!prefixes.some((x) => key.startsWith(x))) continue;
    const values = t[key].split(";").map((v) => v.trim());
    const left = values.filter((v) => !unwanted(v));
    if (left.length === values.length) continue;
    values.filter((v) => unwanted(v)).forEach((v) => removed.add(v));
    if (left.length) t[key] = left.join(";");
    else delete t[key];
  }
  return removed;
}

/** Two stops of a network on one platform (a single OSM platform for both directions): it is the platform of the one on the good side, then of the
 * one it already holds, then of the nearest. The other one, across the road, has no platform of its own: no ref nor stop_id, reported. owners is changed. */
function uniqueOwners(owners, stops, assignments) {
  const onPlatform = new Map();
  for (const [dataId, owner] of owners) {
    if (owner) listIn(onPlatform, `${owner}\u0001${assignments.get(dataId).get(owner)[0].network}`).push(dataId);
  }
  for (const [key, ids] of onPlatform) {
    if (ids.length < 2) continue;
    const owner = key.split("\u0001")[0];
    const keep = minBy(ids, (id) => [assignments.get(id).get(owner)[3] === true ? 0 : 1, stops.holders.get(id)?.has(owner) ? 0 : 1, dist(latlon(stops.df.get(id)), assignments.get(id).get(owner)[1])]);
    for (const id of ids) {
      if (id === keep) continue;
      owners.set(id, null);
      log.warn(`${stops.df.get(id).stop_name} (${id}) and ${keep} share platform ${owner}: its ref and stop_id stay with ${keep}, a platform is missing on the other side (to check)`);
    }
  }
}

/** network + ref -> platform of OSM carrying it, among those of the area. A platform about to receive another ref of that network does not count. */
function platformRefs(obj, owners, assignments) {
  const changing = new Set();
  for (const [dataId, owner] of owners) if (owner) changing.add(`${owner}\u0001${assignments.get(dataId).get(owner)[0].network}`);
  const out = new Map();
  for (const [key, o] of obj.base) {
    const t = o.tags;
    if (!t || (t.public_transport !== "platform" && t.highway !== "bus_stop")) continue;
    const named = { ...t };
    nameNumberedNetworkTags(named);
    nameNumberedRefs(named);
    for (const [k, v] of Object.entries(named)) {
      const network = k === "ref" ? named.network : k.startsWith("ref:") ? networkOfRefKey(k, named) : null;
      if (network && !changing.has(`${key}\u0001${network}`) && !out.has(`${network}\u0001${v}`)) out.set(`${network}\u0001${v}`, key);
    }
  }
  return out;
}

/** Network named by a ref:<network> key on these tags, null for another ref:* tag. */
function networkOfRefKey(key, t) {
  for (const [k, v] of Object.entries(t)) if (/^network(?::\d+)?$/.test(k) && refKeyFor("ref", v) === key) return v;
  return null;
}

/** Add a value to a tag without overwriting a different value set by another network: it goes to the first free numbered key
 * ("gtfs:stop_id:2"...). The refs have their own rule, see enrich. */
function addTag(t, key, value) {
  if (!(key in t)) t[key] = value;
  else if (t[key] !== value) {
    let n = 2;
    while ((t[`${key}:${n}`] ?? value) !== value) n++;
    t[`${key}:${n}`] = value;
  }
}

const splitValues = (value) => (value ?? "").split(";").map((v) => v.trim()).filter(Boolean);
const NUMBERED_REF = /^((?:local_)?ref(?::.*?)?)((?::\d+)+)$/;
export const NETWORK_KEYS = ["network", "network:wikidata", "network:wikipedia"];
const isRefKey = (key) => /^(?:ref|local_ref)$/.test(key) || settings.stop_ref_tags.includes(key);

/** Key of a ref for a network that does not own the stop: "ref:Nomad", "ref:FR:Atoumod:Nomad". */
export const refKeyFor = (base, network) => `${base}:${network.trim().replace(/\s+/g, "_").replace(/[^\p{L}\p{N}_.-]/gu, "")}`;
export const networkKeyFor = (base, network) => refKeyFor(base, network);

/** A platform exported by this tool has network=a;b: during processing each network has its own tag, like network:2, and its metadata its name (see outputPlatformTags). */
function splitNetworkLists(t) {
  const names = splitValues(t.network);
  if (names.length < 2) return;
  const taken = Object.keys(t).filter((k) => /^network:\d+$/.test(k)).map((k) => Number(k.slice(8)));
  let number = Math.max(1, ...taken);
  t.network = names[0];
  for (const name of names.slice(1)) t[`network:${++number}`] = name;
  for (const key of NETWORK_KEYS.slice(1)) {
    const values = splitValues(t[key]);
    if (values.length !== names.length) continue;
    t[key] = values[0];
    names.slice(1).forEach((name, i) => { t[networkKeyFor(key, name)] = values[i + 1]; });
  }
}

/** Key of the ref of a network on these tags: the one it already has, under a shorter name if need be (ref:Nomad for Nomad Car, unless Nomad is on the platform too), else refKeyFor. */
export function refKeyOn(t, base, network) {
  const key = refKeyFor(base, network);
  if (key in t) return key;
  const words = network.trim().split(/\s+/);
  const present = Object.keys(t).filter((k) => /^network(?::\d+)?$/.test(k)).map((k) => t[k]);
  for (let n = words.length - 1; n > 0; n--) {
    const short = words.slice(0, n).join(" ");
    if (!present.includes(short) && refKeyFor(base, short) in t) return refKeyFor(base, short);
  }
  return key;
}

/** Network-specific metadata and stop codes use the network name, not the number of its network tag. */
export function nameNumberedNetworkTags(t) {
  splitNetworkLists(t);
  const numbered = Object.keys(t).filter((k) => /^network:\d+$/.test(k)).sort((a, b) => Number(a.slice(8)) - Number(b.slice(8)));
  const names = new Map(numbered.map((k) => [k.slice("network:".length), t[k]]));
  for (const key of Object.keys(t)) {
    const wiki = /^(network:wikidata|network:wikipedia):(\d+)$/.exec(key);
    const code = /^(gtfs:stop_code(?::[A-Z][A-Z][a-zA-Z0-9_.-]+)?):(\d+)$/.exec(key);
    const match = wiki || code;
    if (!match) continue;
    const network = names.get(match[2]);
    if (!network) continue;
    const target = networkKeyFor(match[1], network);
    if (!(target in t)) t[target] = t[key];
    delete t[key];
  }
}

const STOP_KEY = /^gtfs:stop_(?:id|name|code)(?::|$)/;

/** A list in one tag, "a;b", for the stops of several networks on one platform: gtfs:stop_id, never gtfs:stop_id:2. */
export function addStopValue(t, key, value) {
  const values = (t[key] ?? "").split(";").map((v) => v.trim()).filter(Boolean);
  if (!values.includes(value)) t[key] = [...values, value].join(";");
}

/** gtfs:stop_* tags without their numbers, and with the feed code for the stop ids of this feed. */
function tidyStopKeys(t, ofStop) {
  for (const key of Object.keys(t)) {
    const m = /^(gtfs:stop_(?:id|name|code)(?::[A-Z][A-Z][a-zA-Z0-9_.-]+)?)(?::\d+)+$/.exec(key);
    if (!m) continue;
    addStopValue(t, m[1], t[key]);
    delete t[key];
  }
  const target = feedKey("gtfs:stop_id");
  if (target === "gtfs:stop_id" || !t["gtfs:stop_id"]) return;
  const values = t["gtfs:stop_id"].split(";").map((v) => v.trim());
  const left = values.filter((v) => !ofStop.has(v));
  for (const v of values) if (ofStop.has(v)) addStopValue(t, target, v);
  if (left.length) t["gtfs:stop_id"] = left.join(";");
  else delete t["gtfs:stop_id"];
}

/** Numbered refs ("ref:2", "ref:FR:Atoumod:2") under the name of their network ("ref:Nomad", "ref:FR:Atoumod:Nomad"): the number of
 * network:<n>, else the last network of the stop. A ref is one value for one physical stop: a second one for the same network ("ref:3" with two
 * networks, "a;b") is the stop across the road, and it is dropped, reported if stop names the object. */
export function nameNumberedRefs(t, stop = null) {
  const drop = (key, value) => { if (stop) log.warn(`${stop} ${key}: second ref ${value} dropped, a ref is for one physical stop (to check)`); };
  const others = Object.keys(t).filter((k) => /^network:\d+$/.test(k)).sort().map((k) => t[k]);
  for (const key of Object.keys(t)) {
    const m = NUMBERED_REF.exec(key);
    if (!m) continue;
    const network = t[`network:${m[2].split(":")[1]}`] ?? others.at(-1);
    const target = !network || network === t.network ? m[1] : refKeyFor(m[1], network);
    const value = t[key];
    delete t[key];
    if (target in t) drop(target, value);
    else t[target] = value;
  }
  for (const key of Object.keys(t)) {
    if (!/^(?:local_)?ref(?::|$)/.test(key) || !t[key].includes(";")) continue;
    const [first, ...rest] = t[key].split(";").map((v) => v.trim()).filter(Boolean);
    for (const value of rest) drop(key, value);
    t[key] = first;
  }
}

/** Does this network take over the refs of a stop from the network in place? Those listed in settings.stop_owners do, the first ones before the next, and without a list
 * the one with fewer stops in the feed: a local network owns its stops, a regional one only calls at them. sizes: network -> stops. */
function takesOver(network, current, sizes) {
  const owners = settings.stop_owners;
  if (owners.length) {
    const rank = (n) => (owners.includes(n) ? owners.indexOf(n) : Infinity);
    return rank(network) < rank(current);
  }
  const [a, b] = [sizeOf(sizes, network), sizeOf(sizes, current)];
  return a !== undefined && b !== undefined && a < b;
}

/** Stops of a network in the feed. The feed may name it longer than OSM: "Nomad Car" for "Nomad". */
export function sizeOf(sizes, network) {
  if (!sizes) return undefined;
  if (sizes.has(network)) return sizes.get(network);
  const longer = [...sizes.keys()].filter((name) => name.startsWith(`${network} `)).map((name) => sizes.get(name));
  return longer.length ? Math.max(...longer) : undefined;
}

/** The network tags and the refs of the stop go to the network at number suffix (":2"), which becomes its owner. */
function changeOwner(t, suffix, old) {
  const incoming = t[`network${suffix}`];
  for (const key of new Set(["ref", "local_ref", ...settings.stop_ref_tags])) {
    const other = refKeyOn(t, key, incoming);
    const [a, b] = [t[key], t[other]];
    delete t[key];
    delete t[other];
    if (b !== undefined) t[key] = b;
    if (a !== undefined) t[refKeyFor(key, old)] = a;
  }
  for (const key of NETWORK_KEYS.slice(1)) {
    const other = networkKeyFor(key, incoming);
    const [a, b] = [t[key], t[other]];
    delete t[key];
    delete t[other];
    if (b !== undefined) t[key] = b;
    if (a !== undefined) t[networkKeyFor(key, old)] = a;
  }
  const codes = Object.keys(t).filter((k) => /^gtfs:stop_code(?::[A-Z][A-Z][a-zA-Z0-9_.-]+)?$/.test(k));
  for (const key of codes) {
    const other = networkKeyFor(key, incoming);
    const [a, b] = [t[key], t[other]];
    delete t[key];
    delete t[other];
    if (b !== undefined) t[key] = b;
    if (a !== undefined) t[networkKeyFor(key, old)] = a;
  }
  const [a, b] = [t.network, t[`network${suffix}`]];
  if (b !== undefined) t.network = b;
  if (a !== undefined) t[`network${suffix}`] = a;
}

/** Complete an existing OSM platform with the GTFS / network tags without overwriting another network's, except name, replaced by the
 * name of the stop, official_name likewise, and the physical tags, only added when missing. The network name is numbered; its metadata and stop code use its name. ref and
 * the tags holding a stop_id belong to the network owning the stop (network=*): the others use ref:<network>, never a number. A physical stop is
 * one platform for all its networks, each with its own ids: gtfs:stop_id:<feed> lists those of the networks, separated by ";".
 * sizes: see takesOver. */
export function enrich(obj, key, tags, sizes = null, ofStop = new Map()) {
  const t = obj.edit(key).tags;
  nameNumberedNetworkTags(t);
  nameNumberedRefs(t, key);
  tidyStopKeys(t, ofStop);
  const stopNameKey = feedKey("gtfs:stop_name");
  if (t[stopNameKey]) {
    const names = t[stopNameKey].split(";").map((v) => v.trim()).filter((v) => v !== tags.name);
    if (names.length) t[stopNameKey] = names.join(";");
    else delete t[stopNameKey];
  }
  let suffix = "", n = 1;
  while ((t[`network${suffix}`] ?? tags.network) !== tags.network) suffix = `:${++n}`;
  const incoming = tags.network;
  const current = t.network;
  for (const [k, v] of Object.entries(tags)) {
    if (k === "network") t[k + suffix] = v;
    else if (k.startsWith("network:")) t[suffix ? networkKeyFor(k, incoming) : k] = v;
  }
  if (suffix && takesOver(incoming, current, sizes)) {
    changeOwner(t, suffix, current);
    suffix = "";
  }
  for (const [k, v] of Object.entries(tags)) {
    if (k === "name" || k === "official_name") t[k] = v;
    else if (k === "highway" && key[0] === "w") t.highway ??= "platform"; // highway=bus_stop is for nodes only (wiki, PTNA)
    else if (k.startsWith("network")) continue;
    else if (PHYSICAL_TAGS.has(k)) t[k] ??= v;
    else if (isRefKey(k)) t[suffix ? refKeyOn(t, k, incoming) : k] = v; // the GTFS gives the ref of this network: one value
    else if (STOP_KEY.test(k)) {
      const target = k.startsWith("gtfs:stop_code") && t.network && incoming !== t.network ? networkKeyFor(k, incoming) : k;
      addStopValue(t, target, v);
    }
    else addTag(t, k, v);
  }
  dropBusTag(t);
}

/** The only tags of a stop_position: the stop's data (ref, network, operator...) is on the platform. */
export const stopPositionTags = (name, vehicle = "bus") => ({ [vehicle]: "yes", name, public_transport: "stop_position" });

/** Complete the tags of an existing OSM stop_position: its own tags are kept, only the missing ones are added, except
 * name, replaced by the name of the stop like on the platform. */
export function setStopPositionTags(obj, key, name, vehicle = "bus") {
  const old = obj.get(key).tags;
  const tags = { ...stopPositionTags(name, vehicle), ...old, [vehicle]: "yes", name, public_transport: "stop_position" };
  if (!sameTags(old, tags)) obj.edit(key).tags = tags;
}

/** route_ref of a stop, when it has one, completed with this line: PTNA reports a route_ref that lacks it. None is added where
 * there is none: only the selected lines are known here, and a partial list would be wrong. */
export function completeRouteRef(obj, key, ref) {
  const value = obj.get(key)?.tags?.route_ref;
  if (!ref || !value) return;
  const refs = value.split(";").map((r) => r.trim()).filter(Boolean);
  if (!refs.includes(ref)) obj.edit(key).tags.route_ref = sortedBy([...refs, ref], refSortKey).join(";");
}

/** Drop the candidate platforms that are nodes of a travelled way (legacy highway=bus_stop drawn on the carriageway: a
 * stop_position, not a platform), unless explicitly tagged public_transport=platform. */
export function filterRoadPlatforms(platforms, roadNodes, osm) {
  const out = new Map();
  for (const [stopId, candidates] of platforms) {
    out.set(stopId, candidates.filter((c) => !roadNodes.has(c.id) || osm[c.id].tags.public_transport === "platform"));
  }
  return out;
}
