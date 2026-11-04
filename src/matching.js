// Map-matching of the GTFS variants on the OSM road network, with an online Valhalla server.
//
// A variant is matched from its GTFS shape when it has one. The shape is rejected, and the variant routed through
// its stops instead, when it is missing, when Valhalla cannot follow it, or when too many stops lie far from the
// matched path (straight-line or misplaced shapes, which some producers publish).

import { decodePolyline, distancesToPolyline, pathLength } from "./geo.js";
import { valhallaPost } from "./net.js";
import { settings } from "./settings.js";
import { dedupe, log } from "./util.js";

const MAX_ROUTE_LOCATIONS = 20; // Valhalla's default limit for a bus route request

/** Index ranges [start, end] of consecutive chunks of points short enough for Valhalla, overlapping by one point. */
export function chunks(points) {
  const th = settings.thresholds, length = pathLength(points), starts = [0];
  for (let i = 1; i < points.length; i++) {
    const s = starts.at(-1);
    if (length[i] - length[s] > th.trace_m || i - s >= th.trace_points) starts.push(i - 1 > s ? i - 1 : i);
  }
  const out = starts.map((s, k) => [s, starts[k + 1] ?? points.length - 1]).filter(([s, e]) => e > s);
  return out.length ? out : [[0, points.length - 1]];
}

/** The network calls, as an object so that tests can replace them. */
export const valhalla = {
  /** [way keys "w123" followed in order, matched path] of a trace. */
  async mapMatch(points) {
    const ways = [], path = [];
    for (const [start, end] of chunks(points)) {
      const payload = {
        shape: points.slice(start, end + 1).map(([lat, lon]) => ({ lat, lon })),
        costing: "bus",
        shape_match: "map_snap",
        filters: { attributes: ["edge.way_id", "shape"], action: "include" },
      };
      let res;
      try {
        res = await valhallaPost("trace_attributes", payload);
      } catch (e) {
        if (e.name === "AbortError") throw e;
        payload.trace_options = { search_radius: 50, gps_accuracy: 20 }; // imprecise shape: wider search radius
        res = await valhallaPost("trace_attributes", payload);
      }
      for (const e of res.edges || []) if ("way_id" in e) ways.push(`w${e.way_id}`);
      for (const point of decodePolyline(res.shape || "")) path.push(point);
    }
    if (!ways.length) throw new Error("no way matched");
    return [dedupe(ways), path];
  },

  /** Path of a bus driving through the stops in order. */
  async routeThrough(stops) {
    const path = [], step = MAX_ROUTE_LOCATIONS - 1;
    for (let start = 0; start < Math.max(stops.length - 1, 1); start += step) {
      // "break" rather than "through": a stop drawn on the wrong side of the road then costs a U-turn, not a
      // detour around the block
      const locations = stops.slice(start, start + step + 1).map(([lat, lon]) => ({ lat, lon, type: "break" }));
      const res = await valhallaPost("route", { locations, costing: "bus" });
      for (const leg of res.trip.legs) for (const point of decodePolyline(leg.shape)) path.push(point);
    }
    return path;
  },
};

/** Share of the stops further than thresholds.stop_position_m from the path. */
function farShare(stops, path) {
  if (!stops.length) return 0;
  const far = distancesToPolyline(stops, path).filter((d) => d > settings.thresholds.stop_position_m);
  return far.length / stops.length;
}

/** [ways, source] of a variant: shape or null, stops in order. source is "shape" or "stops" (routed through the
 * stops because the shape is missing, unusable or wrong). Throws if neither works. */
export async function matchVariant(shape, stops) {
  let best = null, reason = "no shape";
  if (shape && shape.length > 1) {
    try {
      const [ways, path] = await valhalla.mapMatch(shape);
      const share = farShare(stops, path);
      if (share <= settings.thresholds.max_far_stops) return [ways, "shape"];
      best = [share, ways, "shape"];
      reason = `${Math.round(share * 100)}% of the stops far from the shape`;
    } catch (e) {
      if (e.name === "AbortError") throw e;
      reason = e.message;
    }
  }
  try {
    const [ways, path] = await valhalla.mapMatch(await valhalla.routeThrough(stops));
    const share = farShare(stops, path);
    if (!best || share < best[0]) best = [share, ways, "stops"];
  } catch (e) {
    if (e.name === "AbortError") throw e;
    if (!best) throw new Error(`${reason}; routing through the stops failed: ${e.message}`);
  }
  if (best[2] === "stops") log.info(`    routed through the stops (${reason})`);
  return [best[1], best[2]];
}
