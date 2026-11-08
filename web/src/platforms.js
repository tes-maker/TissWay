// The stops of a route on the ground: a stop_position on the way and a platform beside it.
//
// Rules:
// - every stop gets a stop_position and a platform;
// - the stop_position lies on the travelled way, at the projection of the GTFS stop, in two steps: locateStop finds
//   the spot without changing anything, materialize creates the node or reuses an existing stop_position, so that
//   the caller can fix the side of the stop (fixSide) before anything is written;
// - a platform takes the nearest existing stop_position, each of them going to one platform (stops.pairStopPositions), when the trace goes there;
// - otherwise, when an existing OSM platform is used, the existing stop_position nearest to it is reused, unless it clearly
//   belongs to the platform of a rival stop (nearestToPlatform);
// - otherwise an existing stop_position is reused when near the projection of the stop, unless closer to the
//   projection of a rival across the road: on a two-way road both directions are often one way, and the
//   stop_position of the opposite stop may be within reach (reusable);
// - a stop_position closer to the stop across the road than to this stop is not reused, even on a good trace (closerToOpposite, settings.stop_position_own): it is left to that stop, and
//   this stop gets its own, unless closer than stop_position_shared_m: a stop_position is only created in last resort (sharedWith);
// - a stop_position only carries public_transport=stop_position, <vehicle>=yes and name, replaced by the name of the stop: what an existing one has more goes to its platform
//   when it lacks it (stopPositionOnly), but for what describes something else on the node, like a crossing;
// - the platform is chosen on the kerb side of the way (settings.driving_side) in the direction of travel, judged
//   on the road segment next to the platform (sideSegment), and for the GTFS stop on its segment (stopSegment);
// - a platform found with the extended reach is only used on the kerb side and next to the way (verified);
// - when the GTFS attaches the route to the opposite platform (a common error), the other GTFS platform of the same stop is used instead, with its OSM
//   platform (fixSide); a platform created takes only the GTFS stop of the route, its position and its data;
// - a GTFS stop_id is set on a single OSM platform (tagPlatforms), even when the GTFS has a single stop for both
//   directions;
// - tags of another network are never overwritten: ref belongs to the network owning the stop, the others use ref:<network> (enrich).

import { feedKey } from "./existing.js";
import { dist, interpolate, latlon, lineDistance, project, rightOf, xy } from "./geo.js";
import { refSortKey } from "./gtfs.js";
import { stopKey } from "./naming.js";
import { isNew, newKey } from "./osm.js";
import { settings } from "./settings.js";
import { listIn, log, minBy, sameTags, setList, sortedBy, splitTag, unique } from "./util.js";

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

/** [way index, node] of the existing stop_position so close to target that a second one would duplicate it (stop_position_shared_m), whoever it is left to, or null. */
function sharedWith(obj, ways, run, target, vehicle) {
  const found = [];
  for (const [j, n, p] of stopPositionsOn(obj, ways, run, vehicle)) if (dist(p, target) <= settings.thresholds.stop_position_shared_m) found.push([dist(p, target), j, n]);
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
  const reuse = (platform ? nearestToPlatform : reusable)(obj, ways, run, pos, target, rivals, vehicle, terminus, opposites) ?? sharedWith(obj, ways, run, target, vehicle);
  if (reuse) return makeSpot(reuse[0], latlon(obj.get(reuse[1])), d, { node: reuse[1] });
  const length = dist(pa, pb);
  t = length > 2 ? Math.min(Math.max(t, 1 / length), 1 - 1 / length) : 0.5; // not on top of an existing node
  return makeSpot(i, interpolate(pa, pb, t), d, { a: nodes[k], b: nodes[k + 1] });
}

/** Key of the stop_position of spot: the existing one, retagged, or a new node inserted in the way. into: see setStopPositionTags. */
export function materialize(obj, ways, spot, name, vehicle = "bus", into = null) {
  if (spot.node) {
    setStopPositionTags(obj, spot.node, name, vehicle, into);
    return spot.node;
  }
  const nodes = obj.edit(ways[spot.wayIndex]).nodes;
  const k = nodes.findIndex((n, i) => n === spot.a && nodes[i + 1] === spot.b);
  const key = newKey("n");
  obj.set(key, { lat: spot.pos[0], lon: spot.pos[1], tags: stopPositionTags(name, vehicle) });
  nodes.splice(k + 1, 0, key);
  Object.assign(spot, { node: key, a: null, b: null });
  return key;
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

const nearest = (candidates, ref) => minBy(candidates, (c) => dist(ref, c.pos)) ?? null;
const hasItsRef = (c) => c.holder || c.byRef;

/** The OSM platform of a stop, on the kerb side of the road, or null to create one:
 * 1. the one with its ref: the node drawn with an area of the same ref (one platform drawn twice, see stops.twinsOf), then that area, then carrying its stop_id, then with its code as a ref, then holding no other stop, then drawn as a way (a stray node comes after the platform drawn), then the nearest;
 * 2. else the one with its name, the nearest to the GTFS stop, or to the stop_position (spotPos), more accurate;
 * 3. else one very close (thresholds.platform_unclaimed_m), whatever its name, that no other stop has the ref or the name of: a second platform would duplicate it. The caller reports it.
 * Unverified far candidates are left out. Without a segment, the side is not judged. */
export function choosePlatform(candidates, stop, { segment = null, spotPos = null, road = null, side = null } = {}) {
  const usable = candidates.filter((c) => verified(c, segment, road, side) && (!segment || onKerb(c.pos, segment, side)));
  const ofRef = usable.filter(hasItsRef);
  if (ofRef.length) return minBy(ofRef, (c) => [c.twin && c.byRef ? (c.id[0] === "n" ? 0 : 1) : 2, c.holder ? 0 : 1, c.byRef ? 0 : 1, c.shared ? 1 : 0, c.id[0] === "w" ? 0 : 1, dist(stop, c.pos)]);
  const named = usable.filter((c) => c.sameName);
  if (named.length) return nearest(named, segment && spotPos ? spotPos : stop);
  return nearest(usable.filter((c) => !c.claimed && dist(stop, c.pos) <= settings.thresholds.platform_unclaimed_m), stop);
}

/** The platform across the road with the ref or the name of the stop: a single pole for both directions, when no other stop stands on that side. */
function poleAcross(candidates, stop, segment, road, side) {
  const own = candidates.filter((c) => verified(c, segment, road, side) && (hasItsRef(c) || c.sameName));
  const rank = (c) => (c.holder ? 0 : c.byRef ? 1 : 2);
  return minBy(own, (c) => [rank(c), dist(stop, c.pos)]) ?? null;
}

/** Is this OSM platform, on the kerb side, the one of stopId rather than of the stop opposite? Yes if it carries the stop_id of stopId, then if only stopId has its code as a ref, or, with
 * nothing to tell them apart, if it is closer to stopId: the GTFS position is then what is wrong, as at a bus station whose bays only differ by a letter. */
function ownsKerb(platform, stopId, opposite, stops, segment, side) {
  if (!onKerb(platform.pos, segment, side)) return false;
  if (platform.holder) return true;
  if (stops.holders?.get(opposite)?.has(platform.id)) return false;
  const [mine, theirs] = [stopId, opposite].map((id) => Boolean(stops.refHolders?.get(id)?.has(platform.id)));
  if (mine !== theirs) return mine;
  const pos = (id) => latlon(stops.df.get(id));
  return dist(platform.pos, pos(stopId)) < dist(platform.pos, pos(opposite));
}

/** [platform, GTFS stop_id whose data it takes]. The platform with the ref of the stop is across the road, or the GTFS attaches the route to the stop across the road:
 * the other GTFS platform of the same stop on the kerb side is used, with its OSM platform on that side (see choosePlatform), else the chosen platform if on that side, else null (a platform
 * is created at its position). Without a stop opposite in the GTFS, the stop stays itself. Also unchanged when its OSM platform is on the kerb side (see ownsKerb), or when it has no platform and
 * is too close to the road for its side to mean anything (thresholds.side_doubt_m). A stop that stays itself without a platform, with no stop nearby on the other side, takes its pole across the road (see poleAcross). */
export function fixSide(stopId, platform, segment, stops, road = null, side = null) {
  if (!segment) return [platform, stopId];
  const pos = (id) => latlon(stops.df.get(id));
  const kerb = (p) => kerbSide(p, ...segment); // GTFS stops: on the segment of the stop
  const candidates = stops.platforms.get(stopId) || [];
  const withRef = candidates.filter(hasItsRef);
  const refAcross = withRef.length > 0 && !withRef.some((c) => onKerb(c.pos, segment, side));
  const staying = () => {
    const alone = !(stops.rivals?.get(stopId) || []).some((id) => kerb(pos(id)) !== kerb(pos(stopId)));
    return [platform ?? (alone ? poleAcross(candidates, pos(stopId), segment, road, side) : null), stopId];
  };
  if (!refAcross && kerb(pos(stopId))) return staying();
  const neighbours = stops.neighbours.get(stopId) || [];
  const onThisSide = neighbours.filter((id) => kerb(pos(id)));
  const opposite = minBy(refAcross && !onThisSide.length ? neighbours : onThisSide, (id) => dist(pos(id), pos(stopId)));
  if (opposite === undefined) return staying();
  if (!refAcross && (platform ? ownsKerb(platform, stopId, opposite, stops, segment, side) : lineDistance(pos(stopId), ...segment) <= settings.thresholds.side_doubt_m)) return staying();
  const theirs = choosePlatform(stops.platforms.get(opposite) || [], pos(opposite), { segment, road, side });
  return [theirs ?? (platform && onKerb(platform.pos, segment, side) ? platform : null), opposite];
}

// --- tags -------------------------------------------------------------------------------------------------

export const CODE_IN_ID = /(?:^|:)[A-Z]{2}:[^:]*:ZE:([^:]+)/; // NeTEx-style ids: "FR:<INSEE>:ZE:<code>:..."

/** ref of a platform: the stop_code, else, unless settings.ref_from_stop_id is "no", the code of a NeTEx-style stop_id ("FR:0:ZE:ESxBIO:ATOUMOD080" -> "ESxBIO"), else the whole stop_id.
 * Always null with settings.stop_refs_from_gtfs off. */
export function stopRef(stop, stopId) {
  if (!settings.stop_refs_from_gtfs) return null;
  if (stop.stop_code) return stop.stop_code;
  if (settings.ref_from_stop_id === "no" || settings.ref_from_stop_id === false || !stopId) return null;
  return CODE_IN_ID.exec(stopId)?.[1] ?? stopId;
}

const PHYSICAL_TAGS = new Set(["public_transport", "highway", "bus", "trolleybus", "wheelchair"]); // survey data wins

/** Platform tags taken from the GTFS. bus=yes for a bus or a coach: without it, iD reports a highway=bus_stop as having incomplete tags. trolleybus=yes and coach=yes say what highway=bus_stop does not. */
export function stopTags(stop, stopId, network, mode = "bus") {
  const tags = { public_transport: "platform", highway: "bus_stop", ...(VEHICLE[mode] === "bus" ? { bus: "yes" } : {}), ...(mode === "trolleybus" || mode === "coach" ? { [mode]: "yes" } : {}),
    name: stop.stop_name, ...network, [feedKey("gtfs:stop_id")]: stopId };
  if (stop.official_name) tags.official_name = stop.official_name;
  if (stop.stop_code && settings.stop_refs_from_gtfs) tags[feedKey("gtfs:stop_code")] = stop.stop_code;
  for (const t of settings.stop_ref_tags) tags[t] = stopId;
  const ref = stopRef(stop, stopId);
  if (ref) tags.ref = ref;
  if (stop.platform_code) tags.local_ref = stop.platform_code;
  if (stop.wheelchair_boarding === "1" || stop.wheelchair_boarding === "2") tags.wheelchair = stop.wheelchair_boarding === "1" ? "yes" : "no";
  return tags;
}

/** Stops of these variants whose OSM platform carries their stop_id, but which no relation uses: the run gave them to another stop (fixSide). */
export function lostStops(variants, stops, assignments) {
  const ids = new Set(variants.flatMap((v) => v.seq));
  return [...ids].filter((id) => stops.holders.get(id)?.size && !assignments.has(id));
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
    const twins = new Set((stops.platforms.get(dataId) || []).filter((c) => plats.has(c.id) && c.twin).map((c) => c.twin)); // the area of the node used, or the reverse: the same platform
    const outside = [...holders].filter((h) => !plats.has(h) && !twins.has(h)).sort();
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
      if (isNew(p)) obj.get(p).tags = tags; // created: the GTFS only
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
    setList(t, key, left);
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
    const keep = minBy(ids, (id) => [assignments.get(id).get(owner)[3] === true ? 0 : 1, stops.holders.get(id)?.has(owner) ? 0 : 1, stops.refHolders?.get(id)?.has(owner) ? 0 : 1, dist(latlon(stops.df.get(id)), assignments.get(id).get(owner)[1])]);
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
    if (!isPlatform(t)) continue;
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

const NUMBERED_REF = /^((?:local_)?ref(?::.*?)?)((?::\d+)+)$/;
export const NETWORK_KEYS = ["network", "network:wikidata", "network:wikipedia", "operator"]; // what follows the network owning the stop
const isRefKey = (key) => /^(?:ref|local_ref)$/.test(key) || settings.stop_ref_tags.includes(key);

/** Key of a ref for a network that does not own the stop: "ref:Nomad", "ref:FR:Atoumod:Nomad". */
export const refKeyFor = (base, network) => `${base}:${network.trim().replace(/\s+/g, "_").replace(/[^\p{L}\p{N}_.-]/gu, "")}`;

export const isPlatform = (t) => t?.public_transport === "platform" || t?.highway === "bus_stop";

/** The keys network:2, network:3... of a stop, in the order of their numbers. */
export const numberedNetworks = (t) => Object.keys(t).filter((k) => /^network:\d+$/.test(k)).sort((a, b) => Number(a.slice(8)) - Number(b.slice(8)));

/** A platform exported by this tool has network=a;b: during processing each network has its own tag, like network:2, and its metadata its name (see outputPlatformTags). */
function splitNetworkLists(t) {
  const names = splitTag(t.network);
  if (names.length < 2) return;
  const taken = Object.keys(t).filter((k) => /^network:\d+$/.test(k)).map((k) => Number(k.slice(8)));
  let number = Math.max(1, ...taken);
  t.network = names[0];
  for (const name of names.slice(1)) t[`network:${++number}`] = name;
  for (const key of NETWORK_KEYS.slice(1)) {
    if (key === "operator" && t.type) continue; // a relation has no form for it: only a platform puts operator:<network> back together in a file
    const values = splitTag(t[key]);
    if (values.length !== names.length) continue;
    t[key] = values[0];
    names.slice(1).forEach((name, i) => { t[refKeyFor(key, name)] = values[i + 1]; });
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
  const numbered = numberedNetworks(t);
  const names = new Map(numbered.map((k) => [k.slice("network:".length), t[k]]));
  for (const key of Object.keys(t)) {
    const wiki = /^(network:wikidata|network:wikipedia|operator):(\d+)$/.exec(key);
    const code = /^(gtfs:stop_code(?::[A-Z][A-Z][a-zA-Z0-9_.-]+)?):(\d+)$/.exec(key);
    const match = wiki || code;
    if (!match) continue;
    const network = names.get(match[2]);
    if (!network) continue;
    const target = refKeyFor(match[1], network);
    if (!(target in t)) t[target] = t[key];
    delete t[key];
  }
  mergeSameNetworks(t);
}

/** network:wikidata of the network named so on these tags (the main one, or one of network:<n>). */
const wikidataOf = (t, name) => (name === t.network ? t["network:wikidata"] : t[refKeyFor("network:wikidata", name)]);

/** Keys of the data of a network that follow its name when it is not the main one: ref:<name>, network:wikidata:<name>... */
const namedBases = (t) => unique(["ref", "local_ref", ...settings.stop_ref_tags, ...NETWORK_KEYS.slice(1),
  ...Object.keys(t).map((k) => /^gtfs:stop_code(?::[A-Z][A-Z][a-zA-Z0-9_.-]+)?(?=:)/.exec(k)?.[0]).filter(Boolean)]);

/** Move the data named after the network old to the main network (into "") or to the name into. A value the target has already
 * stays where it is, unless it is the same. */
function moveNamedData(t, old, into = "") {
  for (const base of namedBases(t)) {
    const from = refKeyFor(base, old), to = into ? refKeyFor(base, into) : base;
    if (!(from in t) || from === to) continue;
    if (!(to in t)) t[to] = t[from];
    if (t[to] === t[from]) delete t[from];
  }
}

/** One network under two names on one object, "Nomad" and network:2=Nomad Car with the same network:wikidata (or twice the same name):
 * a single network, the main one. Its data under the second name goes back to the main keys, and nothing is left named after the main
 * network itself (network:wikidata:Nomad_Car next to network=Nomad Car). */
function mergeSameNetworks(t) {
  if (!t.network) return;
  const main = t["network:wikidata"];
  const numbered = numberedNetworks(t);
  for (const slot of numbered) {
    const name = t[slot];
    if (name !== t.network && !(main && wikidataOf(t, name) === main)) continue;
    moveNamedData(t, name);
    delete t[slot];
  }
  moveNamedData(t, t.network);
  const left = numberedNetworks(t);
  if (left.length === numbered.length) return;
  const names = left.map((k) => t[k]);
  for (const k of left) delete t[k];
  names.forEach((name, i) => { t[`network:${i + 2}`] = name; });
}

const STOP_KEY = /^gtfs:stop_(?:id|name|code)(?::|$)/;

/** A list in one tag, "a;b", for the stops of several networks on one platform: gtfs:stop_id, never gtfs:stop_id:2. */
export function addStopValue(t, key, value) {
  const values = splitTag(t[key]);
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
  setList(t, "gtfs:stop_id", left);
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
    const [first, ...rest] = splitTag(t[key]);
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

/** The value under other goes to key, the one under key to the tag of the old owner. */
export function swapSlot(t, key, other, old) {
  const [a, b] = [t[key], t[other]];
  delete t[key];
  delete t[other];
  if (b !== undefined) t[key] = b;
  if (a !== undefined) t[refKeyFor(key, old)] = a;
}

/** The network tags and the refs of the stop go to the network at number suffix (":2"), which becomes its owner. */
function changeOwner(t, suffix, old) {
  const incoming = t[`network${suffix}`];
  for (const key of new Set(["ref", "local_ref", ...settings.stop_ref_tags])) swapSlot(t, key, refKeyOn(t, key, incoming), old);
  for (const key of NETWORK_KEYS.slice(1)) swapSlot(t, key, refKeyFor(key, incoming), old);
  const codes = Object.keys(t).filter((k) => /^gtfs:stop_code(?::[A-Z][A-Z][a-zA-Z0-9_.-]+)?$/.test(k));
  for (const key of codes) swapSlot(t, key, refKeyFor(key, incoming), old);
  t.network = incoming;
  t[`network${suffix}`] = old;
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
    setList(t, stopNameKey, t[stopNameKey].split(";").map((v) => v.trim()).filter((v) => v !== tags.name));
  }
  // the slot of this network: its name, or another name with the same network:wikidata ("Nomad" for "Nomad Car"), which then takes the
  // name of the relations written; else the first free one
  const incoming = tags.network;
  const sameNetwork = (name) => name === undefined || name === incoming
    || (tags["network:wikidata"] !== undefined && wikidataOf(t, name) === tags["network:wikidata"]);
  let suffix = "", n = 1;
  while (!sameNetwork(t[`network${suffix}`])) suffix = `:${++n}`;
  const old = t[`network${suffix}`];
  if (old !== undefined && old !== incoming) {
    if (suffix) moveNamedData(t, old, incoming);
    t[`network${suffix}`] = incoming;
  }
  const current = t.network;
  for (const [k, v] of Object.entries(tags)) {
    if (k === "network") t[k + suffix] = v;
    else if (k.startsWith("network:")) t[suffix ? refKeyFor(k, incoming) : k] = v;
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
      const target = k.startsWith("gtfs:stop_code") && t.network && incoming !== t.network ? refKeyFor(k, incoming) : k;
      addStopValue(t, target, v);
    }
    else addTag(t, k, v);
  }
  delete t.alt_name;
}

/** The only tags of a stop_position: the stop's data (ref, network, operator...) is on the platform. */
export const stopPositionTags = (name, vehicle = "bus") => ({ [vehicle]: "yes", name, public_transport: "stop_position" });

const VEHICLE_KEYS = new Set(["bus", "coach", "trolleybus", "share_taxi", ...OTHER_VEHICLES]);
/** On a node of the road, what describes something else than the stop. */
const OTHER_FEATURE = /^(?:crossing(?::.*)?|traffic_signals(?::.*)?|traffic_calming|barrier|ford|railway|note|fixme)$/i;
/** What says which stop it is: on a stop_position shared by two stops, it may be the other one's. */
const STOP_IDENTITY = /^(?:gtfs:|(?:ref|local_ref|network|operator|route_ref)(?::|$))/;

/** {tags, moved} of an object that is a stop_position: tags, only public_transport=stop_position, its vehicles, its name and its local_ref, as well as what describes something else on the node
 * (highway=traffic_signals, crossing...), and moved, the tags that belong on its platform. direction and alt_name are dropped, and highway=bus_stop or platform, which its platform has. */
export function stopPositionOnly(old, name, vehicles = []) {
  const tags = { public_transport: "stop_position" }, moved = {};
  for (const [k, v] of Object.entries(old)) {
    if (k === "public_transport" || k === "name" || k === "direction" || k === "alt_name") continue;
    if (k === "highway") {
      if (v !== "bus_stop" && v !== "platform") tags[k] = v;
    } else if (VEHICLE_KEYS.has(k) || OTHER_FEATURE.test(k) || k === "local_ref") tags[k] = v; // local_ref: which bay, the way its platform is found
    else moved[k] = v;
  }
  for (const vehicle of vehicles) tags[vehicle] = "yes";
  if (name ?? old.name) tags.name = name ?? old.name;
  return { tags, moved };
}

/** Add to the tags t of a platform what its stop_position should not have, without replacing anything. Its identity only from a stop_position of one stop (exclusive). */
export function takeFromStopPosition(t, moved, exclusive = false) {
  for (const [k, v] of Object.entries(moved)) if (!(k in t) && (exclusive || !STOP_IDENTITY.test(k))) t[k] = v;
}

/** The tags of an existing OSM stop_position, see stopPositionOnly. into: {platform, exclusive}, where what it should not have goes; a platform created takes nothing from it, and it keeps what it has. */
export function setStopPositionTags(obj, key, name, vehicle = "bus", into = null) {
  const old = obj.get(key).tags;
  const { tags, moved } = stopPositionOnly(old, name, [vehicle]);
  if (into?.platform && isNew(into.platform)) Object.assign(tags, moved); // a platform created only takes the GTFS: what the stop_position has more stays on it
  if (!sameTags(old, tags)) obj.edit(key).tags = tags;
  if (!into?.platform || !obj.has(into.platform) || isNew(into.platform)) return;
  const taken = { ...obj.get(into.platform).tags };
  takeFromStopPosition(taken, moved, into.exclusive);
  if (!sameTags(taken, obj.get(into.platform).tags)) obj.edit(into.platform).tags = taken;
}

/** route_ref of a stop, when it has one, completed with this line: PTNA reports a route_ref that lacks it. None is added where
 * there is none: only the selected lines are known here, and a partial list would be wrong. */
export function completeRouteRef(obj, key, ref) {
  const value = obj.get(key)?.tags?.route_ref;
  if (!ref || !value) return;
  const refs = splitTag(value);
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
