// GPX track -> OSM route relation for people on foot or on a bike (route=hiking / foot / bicycle / mtb).
//
// 1. The points of the GPX (tracks, else routes, else waypoints) are map-matched with Valhalla, with the costing of the
//    profile chosen: pedestrian for walkers, bicycle of the right type for cyclists.
// 2. When "adapt" is on, the path is made to suit the profile, piece by piece. Anchors are taken every ANCHOR_M along the
//    matched path and moved onto a way better suited nearby, parallel to the path (the cycleway beside the road for a
//    cyclist, the footway beside it for a walker). The path is routed through them with the profile, and a piece routed
//    again replaces the matched one only if it stays close to it and runs more on the ways the profile prefers.
// 3. The ways followed are read from Overpass, split where the route enters or leaves them, and put in a route relation.
//
// The result is a .osm for JOSM and the path on the ways as a .gpx.

import { decodePolyline, dist, distancesToPolyline, pathLength, xy } from "./geo.js";
import { chunks } from "./matching.js";
import { slug } from "./naming.js";
import { overpass, services, valhallaPost, valhallaReady } from "./net.js";
import { Store, completeWayNodes, newKey, readWays, writeOsm } from "./osm.js";
import { splitWays } from "./splitting.js";
import { dedupe, log } from "./util.js";

// --- profiles ---------------------------------------------------------------------------------------------
//
// prefer(edge) says how well a way suits the profile, from 0 (a road with traffic) to 1 (what it is made for). edge: the Valhalla
// attributes {use, cycle_lane, road_class, sidewalk}.

const CYCLE_LANES = { separated: 1, dedicated: 0.7, shared: 0.4 };
const MINOR_ROADS = new Set(["residential", "service_other"]);
const minorRoad = (e) => e.use === "road" && MINOR_ROADS.has(e.road_class);
const hasSidewalk = (e) => Boolean(e.sidewalk) && e.sidewalk !== "none";
const WALKWAYS = new Set(["footway", "path", "track", "steps", "bridleway", "pedestrian", "sidewalk", "pedestrian_crossing"]);

function cycling(e, { trails = 0.4 } = {}) {
  if (e.use === "cycleway" || e.use === "mountain_bike") return 1;
  if (CYCLE_LANES[e.cycle_lane]) return CYCLE_LANES[e.cycle_lane];
  if (e.use === "living_street") return 0.5;
  if (["footway", "path", "pedestrian", "bridleway", "track"].includes(e.use)) return trails;
  return minorRoad(e) ? 0.3 : 0;
}

/** The profiles offered: the OSM route=* value, the letter of the network tag (lwn, lcn…), the Valhalla costing and its options,
 * how well a way suits it. */
export const PROFILES = {
  hiking: {
    label: "Hiking", route: "hiking", network: "w", costing: "pedestrian",
    options: { use_tracks: 1, max_hiking_difficulty: 6, walkway_factor: 0.7, sidewalk_factor: 1, use_living_streets: 0.8, service_penalty: 5 },
    prefer: (e) => (["path", "footway", "track", "steps", "bridleway", "pedestrian", "mountain_bike"].includes(e.use) ? 1
      : e.use === "sidewalk" ? 0.7 : e.use === "living_street" ? 0.6 : hasSidewalk(e) ? 0.4 : minorRoad(e) ? 0.3 : 0),
  },
  foot: {
    label: "Walking", route: "foot", network: "w", costing: "pedestrian",
    options: { walkway_factor: 0.8, sidewalk_factor: 0.7, use_living_streets: 0.8, max_hiking_difficulty: 2 },
    prefer: (e) => (WALKWAYS.has(e.use) || e.use === "living_street" ? (["path", "track"].includes(e.use) ? 0.8 : 1)
      : hasSidewalk(e) ? 0.8 : minorRoad(e) ? 0.4 : 0),
  },
  bicycle: {
    label: "Bike (city, touring)", route: "bicycle", network: "c", costing: "bicycle",
    options: { bicycle_type: "Hybrid", use_roads: 0, use_living_streets: 0.7, avoid_bad_surfaces: 0.4 },
    prefer: (e) => cycling(e),
  },
  road_bike: {
    label: "Road bike", route: "bicycle", network: "c", costing: "bicycle",
    options: { bicycle_type: "Road", use_roads: 0.25, avoid_bad_surfaces: 1 },
    prefer: (e) => (e.use === "mountain_bike" ? 0 : cycling(e, { trails: 0 })),
  },
  mtb: {
    label: "Mountain bike", route: "mtb", network: "c", costing: "bicycle",
    options: { bicycle_type: "Mountain", use_roads: 0, avoid_bad_surfaces: 0, use_living_streets: 0.5 },
    prefer: (e) => (["path", "track", "mountain_bike", "bridleway"].includes(e.use) ? 1 : e.use === "cycleway" ? 0.7 : e.use === "footway" ? 0.6 : cycling(e) / 2),
  },
};

/** Values of the network tag: l, r, n, i + w (walking) or c (cycling). */
export const LEVELS = { "": "None", l: "Local", r: "Regional", n: "National", i: "International" };

const ANCHOR_M = 400; // distance between the anchors of the path
const SNAP_M = 30; // an anchor moves onto a better way this close: the cycleway beside the road is within it
const PARALLEL_DEG = 35; // and only onto a way this parallel to the path: not onto a crossing
const DEVIATION_M = 40; // a piece routed again further than this from the matched path is not taken
const DETOUR = 1.3; // nor one longer than this ratio of the matched piece (plus DEVIATION_M)
const GAIN = 0.05; // nor one that does not run more on the preferred ways by this share of its length
const MAX_LOCATIONS = 20;

// --- reading a GPX ----------------------------------------------------------------------------------------

const unescape = (s) => s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (_, e) => {
  if (e[0] !== "#") return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[e];
  return String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
});
/** Consecutive repeated points removed. */
const dedupePoints = (pts) => pts.filter((p, i) => i === 0 || p[0] !== pts[i - 1][0] || p[1] !== pts[i - 1][1]);
const cdata = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");

/** [[lat, lon]] of the points of an element kind (trkpt, rtept, wpt) in a GPX text. */
function points(text, kind) {
  const out = [];
  for (const m of text.matchAll(new RegExp(`<${kind}\\b([^>]*)>`, "g"))) {
    const lat = /\blat\s*=\s*["']([^"']+)["']/.exec(m[1]), lon = /\blon\s*=\s*["']([^"']+)["']/.exec(m[1]);
    const p = [Number(lat?.[1]), Number(lon?.[1])];
    if (Number.isFinite(p[0]) && Number.isFinite(p[1])) out.push(p);
  }
  return out;
}

/** {name, points} of a GPX text: the points of its tracks, else of its routes, else its waypoints, in file order. Throws if there is none. */
export function parseGpx(text) {
  if (!/<gpx\b/.test(text)) throw new Error("This file is not a GPX file.");
  const found = [["trkpt", "track"], ["rtept", "route"], ["wpt", "waypoint"]].map(([kind, what]) => [points(text, kind), what]).find(([p]) => p.length >= 2);
  if (!found) throw new Error("This GPX file has no track: at least two points are needed.");
  // the name of the track or route, before its points, else the first name of the file (metadata)
  const head = /<(trk|rte)\b[^>]*>([\s\S]*?)(?:<trkseg\b|<rtept\b|<\/\1>)/.exec(text)?.[2] ?? "";
  const name = /<name>([\s\S]*?)<\/name>/.exec(head)?.[1] ?? /<name>([\s\S]*?)<\/name>/.exec(text)?.[1] ?? "";
  return { name: unescape(cdata(name)).trim(), points: dedupePoints(found[0]) };
}

const escapeXml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const trkpt = ([lat, lon]) => `      <trkpt lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}" />`;

// The colour of a line in the CSS names OSM's colour=* often uses; anything else is written as #rrggbb.
const NAMED_COLOURS = {
  black: "000000", white: "ffffff", red: "ff0000", green: "008000", blue: "0000ff", yellow: "ffff00", orange: "ffa500", purple: "800080",
  pink: "ffc0cb", brown: "a52a2a", grey: "808080", gray: "808080", silver: "c0c0c0", maroon: "800000", navy: "000080", teal: "008080",
  olive: "808000", lime: "00ff00", aqua: "00ffff", cyan: "00ffff", fuchsia: "ff00ff", magenta: "ff00ff", violet: "ee82ee", gold: "ffd700",
  darkgreen: "006400", darkblue: "00008b", darkred: "8b0000", lightblue: "add8e6", lightgreen: "90ee90", skyblue: "87ceeb",
};

/** "rrggbb" of an OSM colour=* value ("#E3001B", "#e30", "red"), or "" when it is not a colour. */
export function hexColour(value) {
  const v = String(value ?? "").trim().toLowerCase();
  if (NAMED_COLOURS[v]) return NAMED_COLOURS[v];
  const hex = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/.exec(v)?.[1];
  return hex?.length === 3 ? [...hex].map((c) => c + c).join("") : hex ?? "";
}

// Styles in the extensions read by the apps: gpx_style (gpx.studio, Locus...) and OsmAnd's. A stop: a white dot circled with black.
const STYLE_NS = 'xmlns:gpx_style="http://www.topografix.com/GPX/gpx_style/0/2" xmlns:osmand="https://osmand.net"';
const trackStyle = (hex) => (hex
  ? `<extensions><gpx_style:line><gpx_style:color>${hex.toUpperCase()}</gpx_style:color><gpx_style:width>4</gpx_style:width></gpx_style:line>`
    + `<osmand:color>#${hex}</osmand:color><osmand:width>bold</osmand:width></extensions>`
  : "");
const STOP_STYLE = "<extensions><gpx_style:line><gpx_style:color>000000</gpx_style:color></gpx_style:line>"
  + "<gpx_style:fill><gpx_style:color>FFFFFF</gpx_style:color></gpx_style:fill>"
  + "<osmand:color>#ffffff</osmand:color><osmand:background>circle</osmand:background></extensions>";

/** A GPX text of tracks [{name, segments: [[[lat, lon]]], colour}] and waypoints [{lat, lon, name}]: each track in its colour (an OSM
 * colour=*, none if empty), the waypoints as white dots circled with black. */
export function writeTracks(tracks, waypoints = []) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<gpx version="1.1" creator="tissway" xmlns="http://www.topografix.com/GPX/1/1" ${STYLE_NS}>`,
    ...waypoints.map((w) => `  <wpt lat="${w.lat.toFixed(7)}" lon="${w.lon.toFixed(7)}">${w.name ? `<name>${escapeXml(w.name)}</name>` : ""}${STOP_STYLE}</wpt>`),
    ...tracks.flatMap(({ name, segments, colour }) => [
      `  <trk>${name ? `<name>${escapeXml(name)}</name>` : ""}${trackStyle(hexColour(colour))}`,
      ...segments.flatMap((seg) => ["    <trkseg>", ...dedupePoints(seg).map(trkpt), "    </trkseg>"]),
      "  </trk>",
    ]),
    "</gpx>",
    "",
  ].join("\n");
}

/** A GPX text of a path [[lat, lon]]. */
export const writeGpx = (name, path) => writeTracks([{ name, segments: [path] }]);

// --- Valhalla ---------------------------------------------------------------------------------------------

const costingOf = (profile) => ({ costing: profile.costing, costing_options: { [profile.costing]: profile.options } });
const ATTRIBUTES = ["edge.way_id", "edge.use", "edge.cycle_lane", "edge.road_class", "edge.sidewalk", "edge.begin_shape_index", "edge.end_shape_index", "matched.edge_index", "shape"];

/** The network calls, as an object so that tests can replace them. */
export const valhalla = {
  /** Match of points with the costing of the profile: {ways: keys followed in order, path: matched path, edges: [{way, use, cycle_lane,
   * road_class, sidewalk, begin, end}] with begin / end their indices in path, pointEdge: index in edges of each point, -1 if unmatched}. */
  async mapMatch(pts, profile) {
    const path = [], edges = [], pointEdge = new Array(pts.length).fill(-1);
    for (const [start, end] of chunks(pts)) {
      const payload = { shape: pts.slice(start, end + 1).map(([lat, lon]) => ({ lat, lon })), ...costingOf(profile), shape_match: "map_snap", filters: { attributes: ATTRIBUTES, action: "include" } };
      let res;
      try {
        res = await valhallaPost("trace_attributes", payload);
      } catch (e) {
        if (e.name === "AbortError") throw e;
        payload.trace_options = { search_radius: 50, gps_accuracy: 20 }; // imprecise trace (drawn by hand, poor GPS): wider search radius
        res = await valhallaPost("trace_attributes", payload);
      }
      const shift = path.length, first = edges.length, chunk = res.edges || [];
      for (const e of chunk) {
        edges.push({ way: "way_id" in e ? `w${e.way_id}` : null, use: e.use, cycle_lane: e.cycle_lane, road_class: e.road_class, sidewalk: e.sidewalk, begin: e.begin_shape_index + shift, end: e.end_shape_index + shift });
      }
      (res.matched_points || []).forEach((m, i) => {
        if (pointEdge[start + i] < 0 && m.edge_index < chunk.length) pointEdge[start + i] = first + m.edge_index;
      });
      path.push(...decodePolyline(res.shape || ""));
    }
    const ways = dedupe(edges.map((e) => e.way).filter(Boolean));
    if (!ways.length) throw new Error("no way matched");
    return { ways, path, edges, pointEdge };
  },

  /** Ways near each point, nearest first: [[{lat, lon, distance, heading, allowed, edge: {use, cycle_lane, road_class, sidewalk}}]]. */
  async nearby(pts, profile) {
    const out = [];
    for (let start = 0; start < pts.length; start += MAX_LOCATIONS) {
      const locations = pts.slice(start, start + MAX_LOCATIONS).map(([lat, lon]) => ({ lat, lon, radius: SNAP_M }));
      const res = await valhallaPost("locate", { locations, ...costingOf(profile), verbose: true });
      for (const r of res) {
        out.push((r.edges || []).map((e) => ({
          lat: e.correlated_lat, lon: e.correlated_lon, distance: e.distance, heading: e.heading,
          allowed: e.edge?.access?.[profile.costing === "bicycle" ? "bicycle" : "pedestrian"] !== false,
          edge: { use: e.edge?.classification?.use, road_class: e.edge?.classification?.classification, cycle_lane: e.edge?.cycle_lane, sidewalk: e.edge?.sidewalk_left || e.edge?.sidewalk_right ? "both" : "" },
        })).sort((a, b) => a.distance - b.distance));
      }
    }
    return out;
  },

  /** Path of each leg between consecutive anchors, routed with the profile: [[lat, lon]] per leg, null for a leg Valhalla cannot route. */
  async routeLegs(anchors, profile) {
    const out = [];
    for (let start = 0; start < anchors.length - 1; start += MAX_LOCATIONS - 1) {
      const part = anchors.slice(start, start + MAX_LOCATIONS);
      const locations = part.map(([lat, lon], i) => ({ lat, lon, type: i === 0 || i === part.length - 1 ? "break" : "break_through" }));
      try {
        const res = await valhallaPost("route", { locations, ...costingOf(profile) });
        for (const leg of res.trip.legs) out.push(decodePolyline(leg.shape));
      } catch (e) {
        if (e.name === "AbortError") throw e;
        log.debug(`routing from anchor ${start} failed: ${e.message}`);
        for (let i = 1; i < part.length; i++) out.push(null);
      }
    }
    return out;
  },
};

// --- adapting the path to the profile ---------------------------------------------------------------------

/** Indices in path of the anchors: the ends, and a point every step metres along it. */
export function anchorIndices(path, step = ANCHOR_M) {
  const length = pathLength(path), out = [0];
  for (let i = 1; i < path.length - 1; i++) if (length[i] - length[out.at(-1)] >= step) out.push(i);
  if (path.length > 1) {
    // a last piece too short to route is joined to the one before
    if (out.length > 1 && length.at(-1) - length[out.at(-1)] < step / 3) out.pop();
    out.push(path.length - 1);
  }
  return out;
}

/** Is a leg routed again close enough to the piece of the matched path it replaces? */
export function fits(leg, piece) {
  if (!leg || leg.length < 2) return false;
  const length = (p) => pathLength(p).at(-1) || 0;
  if (length(leg) > DETOUR * length(piece) + DEVIATION_M) return false;
  return Math.max(...distancesToPolyline(leg, piece)) <= DEVIATION_M && Math.max(...distancesToPolyline(piece, leg)) <= DEVIATION_M;
}

/** Heading in degrees (0 = north, clockwise) from a to b. */
const heading = (a, b) => {
  const [x, y] = xy(b, a);
  return (Math.atan2(x, y) * 180 / Math.PI + 360) % 360;
};
const parallel = (h1, h2) => {
  const d = Math.abs(h1 - h2) % 180;
  return Math.min(d, 180 - d) <= PARALLEL_DEG;
};

/** The anchors (indices in path), each moved onto the way that suits the profile best within SNAP_M, parallel to the path, when it suits
 * it better than the way under it. */
export async function snapAnchors(path, idx, profile) {
  const anchors = idx.map((i) => path[i]);
  let nearby;
  try {
    nearby = await valhalla.nearby(anchors, profile);
  } catch (e) {
    if (e.name === "AbortError") throw e;
    log.debug(`ways near the anchors not available: ${e.message}`);
    return anchors;
  }
  return idx.map((i, k) => {
    const candidates = (nearby[k] || []).filter((c) => c.allowed && c.distance <= SNAP_M);
    if (!candidates.length) return anchors[k];
    const along = heading(path[Math.max(i - 1, 0)], path[Math.min(i + 1, path.length - 1)]);
    const here = profile.prefer(candidates[0].edge);
    let best = null;
    for (const c of candidates) {
      if (c.heading !== undefined && !parallel(c.heading, along)) continue;
      if (profile.prefer(c.edge) > (best ? profile.prefer(best.edge) : here)) best = c;
    }
    return best ? [best.lat, best.lon] : anchors[k];
  });
}

/** How well each segment of a matched path suits the profile, from its edges (begin / end: indices in the path). */
export function segmentScores(path, edges, profile) {
  const out = new Array(Math.max(path.length - 1, 0)).fill(0);
  for (const e of edges) for (let j = e.begin; j < e.end && j < out.length; j++) out[j] = profile.prefer(e);
  return out;
}

/** The same for points matched one by one (pointEdge: index in edges of each point). */
export function pointScores(pts, pointEdge, edges, profile) {
  const at = (i) => (pointEdge[i] >= 0 ? profile.prefer(edges[pointEdge[i]]) : 0);
  return pts.slice(1).map((_, j) => (at(j) + at(j + 1)) / 2);
}

/** Share of the length of points[lo..hi] on ways suited to the profile, weighted by how well. */
export function rangeScore(pts, scores, lo, hi) {
  let total = 0, good = 0;
  for (let j = lo; j < hi; j++) {
    const d = dist(pts[j], pts[j + 1]);
    total += d;
    good += d * (scores[j] ?? 0);
  }
  return total ? good / total : 0;
}

/** {points, ranges}: the parts end to end, ranges[k] = [first, last] index of part k in points. A part starting where the one before ends
 * shares that point. */
function assemble(parts) {
  const points = [], ranges = [];
  for (const part of parts) {
    const joined = points.length && dist(points.at(-1), part[0]) < 0.5;
    const start = joined ? points.length - 1 : points.length;
    points.push(...(joined ? part.slice(1) : part));
    ranges.push([start, points.length - 1]);
  }
  return { points, ranges };
}

/** The matched path made to suit the profile (see the top of this file): {match, changed: pieces replaced, pieces}. */
export async function adaptPath(match, profile) {
  const { path } = match;
  const idx = anchorIndices(path), n = idx.length - 1;
  if (n < 1) return { match, changed: 0, pieces: 0 };
  const pieces = idx.slice(1).map((end, k) => path.slice(idx[k], end + 1));
  const scores = segmentScores(path, match.edges, profile);
  const pieceScore = idx.slice(1).map((end, k) => rangeScore(path, scores, idx[k], end));
  const snapped = await snapAnchors(path, idx, profile);
  const legs = await valhalla.routeLegs(snapped, profile);

  // the legs matched together, to know which ways they take
  const trial = assemble(legs.map((leg, k) => leg ?? pieces[k]));
  let trialMatch;
  try {
    trialMatch = await valhalla.mapMatch(trial.points, profile);
  } catch (e) {
    if (e.name === "AbortError") throw e;
    log.warn(`The path could not be adapted to the profile (${e.message}): the matched path is kept`);
    return { match, changed: 0, pieces: n };
  }
  const legScores = pointScores(trial.points, trialMatch.pointEdge, trialMatch.edges, profile);
  const taken = legs.map((leg, k) => {
    const close = fits(leg, pieces[k]), score = rangeScore(trial.points, legScores, ...trial.ranges[k]);
    log.debug(`piece ${k + 1}: suited ${Math.round(pieceScore[k] * 100)}% -> ${leg ? `${Math.round(score * 100)}%${close ? "" : ", too far from the track"}` : "no route"}`);
    return Boolean(leg) && close && score > pieceScore[k] + GAIN;
  });
  const changed = taken.filter(Boolean).length;
  if (!changed) return { match, changed, pieces: n };
  if (changed === n) return { match: trialMatch, changed, pieces: n };

  // where a piece kept meets a leg taken, the anchor goes back on the matched path, and the leg is routed again from it: it joins the
  // better way where the network allows it, instead of jumping across
  const anchors = snapped.map((a, i) => (i > 0 && i < n && taken[i - 1] !== taken[i] ? path[idx[i]] : a));
  for (let k = 0; k < n; k++) {
    if (!taken[k] || (anchors[k] === snapped[k] && anchors[k + 1] === snapped[k + 1])) continue;
    const [leg] = await valhalla.routeLegs([anchors[k], anchors[k + 1]], profile);
    if (fits(leg, pieces[k])) legs[k] = leg;
    else taken[k] = false;
  }
  const final = assemble(legs.map((leg, k) => (taken[k] ? leg : pieces[k])));
  return { match: await valhalla.mapMatch(final.points, profile), changed: taken.filter(Boolean).length, pieces: n };
}

// --- the relation -----------------------------------------------------------------------------------------

/** Tags of the route relation. */
export function routeTags(profile, { name = "", ref = "", level = "" } = {}) {
  const tags = { type: "route", route: profile.route };
  if (name) tags.name = name;
  if (ref) tags.ref = ref;
  if (level) tags.network = `${level}${profile.network}n`;
  return tags;
}

/** Convert a GPX text. options: profile (key of PROFILES), adapt (make the path suit the profile), name, ref, level (key of LEVELS).
 * Returns {xml, gpx, filename, gpxName, summary, state}. */
export async function runGpx(text, { profile: key = "bicycle", adapt = true, name = "", ref = "", level = "", fileName = "track.gpx", onProgress = () => {} } = {}) {
  const profile = PROFILES[key];
  if (!profile) throw new Error(`Unknown profile: ${key}`);
  const track = parseGpx(text);
  const title = name.trim() || track.name || fileName.replace(/\.gpx$/i, "");
  log.info(`${track.points.length} point(s) in the GPX, profile ${profile.label}`);

  if (!(await valhallaReady())) throw new Error(`Valhalla does not answer on ${services.valhalla_url}`);
  onProgress("Map-matching the track (Valhalla)…");
  let match = await valhalla.mapMatch(track.points, profile);
  const far = distancesToPolyline(track.points, match.path).filter((d) => d > DEVIATION_M * 2).length;
  if (far) log.warn(`${far} point(s) of the GPX more than ${DEVIATION_M * 2} m from the matched path: no way for this profile there, or a poor track (to check)`);

  let changed = 0, pieces = 0;
  if (adapt) {
    onProgress(`Adapting the path to the profile ${profile.label} (Valhalla)…`);
    ({ match, changed, pieces } = await adaptPath(match, profile));
    log.info(changed ? `${changed} of ${pieces} piece(s) of the path moved onto ways better suited to the profile ${profile.label}` : "The path already suits the profile: nothing changed");
  }

  onProgress("OSM ways (Overpass)…");
  let { ways } = match;
  const roads = await readWays(new Set(ways));
  const before = ways.length;
  ways = dedupe(ways.filter((w) => roads[w]?.nodes));
  if (ways.length < before) log.warn(`${before - ways.length} way(s) from Valhalla missing from OSM (older Valhalla data)`);
  if (!ways.length) throw new Error("None of the ways matched is in OSM any more.");

  onProgress("Building the relation…");
  const obj = new Store(roads);
  const relation = newKey("r");
  obj.set(relation, { tags: routeTags(profile, { name: title, ref: ref.trim(), level }), members: ways.map((w) => [w, ""]) });
  onProgress("Splitting ways…");
  const [nWays, nClosed, nRels] = await splitWays(obj);
  log.info(`${nWays} way(s) split, of which ${nClosed} roundabout(s) / closed way(s); ${nRels} existing OSM relation(s) updated`);
  await completeWayNodes(obj);

  const km = (pathLength(match.path).at(-1) || 0) / 1000;
  const base = slug(title) || "track";
  return {
    get xml() { return writeOsm(obj); },
    gpx: writeGpx(title, match.path),
    filename: `${profile.route}_${base}.osm`,
    gpxName: `${base}_${key}.gpx`,
    summary: { ways: obj.get(relation).members.length, Length: `${km.toFixed(1)} km`, ...(adapt ? { "Pieces adapted": `${changed} of ${pieces}` } : {}) },
    state: { track, match, obj, relation },
  };
}

// --- an OSM relation as a GPX -----------------------------------------------------------------------------

const TRAVELLED = new Set(["", "forward", "backward", "main", "alternative", "excursion", "approach", "connection"]); // roles of the ways travelled

/** The id of a relation from "123", "r123" or a link to it (openstreetmap.org/relation/123). null if there is none. */
export function relationId(text) {
  const m = /^\s*(?:r|relation\/?)?(\d+)\s*$/i.exec(text) ?? /relation\/(\d+)/.exec(text);
  return m ? m[1] : null;
}

/** The node lists of ways put end to end in travel order: [[node ids]] per continuous segment. Each way is turned to follow the one
 * before (the first one, to lead to the next); a closed way (roundabout) is followed from where the route enters it to where the next way
 * leaves it, in its own direction. */
export function chainWays(ways) {
  const segments = [];
  const meets = (n, way) => Boolean(way) && (n === way[0] || n === way.at(-1) || (way[0] === way.at(-1) && way.includes(n)));
  let current = null, single = false; // single: current holds one way, whose direction the next one settles
  ways.forEach((nodes, i) => {
    const next = ways[i + 1];
    const closed = nodes.length > 2 && nodes[0] === nodes.at(-1);
    if (single && current[0] !== current.at(-1) && meets(current[0], nodes) && !meets(current.at(-1), nodes)) current.reverse();
    const end = current?.at(-1);
    single = false;
    if (current && closed && nodes.includes(end)) {
      const ring = nodes.slice(0, -1), from = ring.indexOf(end);
      const exit = next ? ring.findIndex((n, k) => k !== from && (n === next[0] || n === next.at(-1))) : -1;
      const steps = exit < 0 ? ring.length : (exit - from + ring.length) % ring.length;
      for (let k = 1; k <= steps; k++) current.push(ring[(from + k) % ring.length]);
    } else if (current && nodes[0] === end) current.push(...nodes.slice(1));
    else if (current && nodes.at(-1) === end) current.push(...[...nodes].reverse().slice(1));
    else {
      // the start, or after a gap: the way is turned towards the next one
      current = closed || !next || meets(nodes.at(-1), next) || !meets(nodes[0], next) ? [...nodes] : [...nodes].reverse();
      single = true;
      segments.push(current);
    }
  });
  return segments;
}

/** A route relation (or each route of a route_master) as a GPX: its ways as a track, its stops (else its platforms) as waypoints.
 * Returns {gpx, filename, summary}. */
export async function relationToGpx(text, { onProgress = () => {} } = {}) {
  const id = relationId(text);
  if (!id) throw new Error("Enter the id of an OSM relation, or a link to it.");
  onProgress(`Relation ${id} (Overpass)…`);
  const elements = await overpass(`relation(${id})->.r;(.r;relation(r.r);)->.all;.all out body;way(r.all)->.w;.w out body;node(w.w)->.n;.n out skel qt;node(r.all);out body qt;`);
  const of = { node: new Map(), way: new Map(), relation: new Map() };
  for (const e of elements) of[e.type].set(e.id, e);
  const top = of.relation.get(Number(id));
  if (!top) throw new Error(`Relation ${id} not found in OSM.`);
  const routes = top.tags?.type === "route_master" ? top.members.filter((m) => m.type === "relation").map((m) => of.relation.get(m.ref)).filter(Boolean) : [top];
  if (!routes.length) throw new Error(`Relation ${id} has no route.`);

  const at = (n) => [of.node.get(n).lat, of.node.get(n).lon];
  const tracks = [], waypoints = [], seen = new Set();
  let missing = 0;
  for (const route of routes) {
    const ways = route.members.filter((m) => m.type === "way" && TRAVELLED.has(m.role) && of.way.get(m.ref)?.nodes).map((m) => of.way.get(m.ref).nodes);
    const segments = chainWays(ways).map((seg) => seg.filter((n) => of.node.has(n)).map(at)).filter((seg) => seg.length > 1);
    const name = route.tags?.name || [route.tags?.route, route.tags?.ref].filter(Boolean).join(" ") || `Relation ${route.id}`;
    if (!segments.length) {
      log.warn(`${name}: no way to follow`);
      continue;
    }
    if (segments.length > 1) log.warn(`${name}: ${segments.length - 1} gap(s) between its ways, written as separate segments (to check in OSM)`);
    tracks.push({ name, segments, colour: route.tags?.colour || top.tags?.colour || "" });
    const nodes = route.members.filter((m) => m.type === "node");
    const stops = nodes.filter((m) => m.role.startsWith("stop"));
    for (const m of stops.length ? stops : nodes.filter((x) => x.role.startsWith("platform"))) {
      const node = of.node.get(m.ref);
      if (!node) missing++;
      else if (!seen.has(m.ref)) {
        seen.add(m.ref);
        waypoints.push({ lat: node.lat, lon: node.lon, name: node.tags?.name ?? "" });
      }
    }
  }
  if (!tracks.length) throw new Error(`Relation ${id} has no way to follow.`);
  if (missing) log.warn(`${missing} stop(s) not found in OSM`);
  const km = tracks.flatMap((t) => t.segments).reduce((sum, seg) => sum + (pathLength(seg).at(-1) || 0), 0) / 1000;
  const title = top.tags?.name || tracks[0].name;
  log.info(`${title}: ${tracks.length} track(s), ${waypoints.length} stop(s), ${km.toFixed(1)} km`);
  return {
    gpx: writeTracks(tracks, waypoints),
    filename: `${slug(title) || "relation"}_${id}.gpx`,
    summary: { tracks: tracks.length, stops: waypoints.length, Length: `${km.toFixed(1)} km` },
  };
}
