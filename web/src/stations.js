// Bus stations: the stops of a bus station are its bays, not stops facing each other across a road.
//
// - which stops: those inside an amenity=bus_station with another stop of their name, or at least STATION_BAYS stops of one name whose codes only differ by a letter;
// - which platform: the one carrying the stop_id and the ref of the bay (bayPlatform). The side of the road means nothing here, and no bay stands for another (platforms.fixSide);
// - which stop_position: the one in front of that platform, each of them having its own (pairBays), within thresholds.bay_stop_position_m;
// - the trace goes up to that stop_position, by the roads of the station, when the GTFS shape stops before it (reachBays). No new stop_position is needed.

import { dist, latlon, osmPosition } from "./geo.js";
import { stopKey } from "./naming.js";
import { isStopPositionFor } from "./platforms.js";
import { settings } from "./settings.js";
import { siblingCode } from "./stops.js";
import { minBy, sortedBy } from "./util.js";

const STATION_BAYS = 4;
const STATION_MARGIN_M = 20; // a bay may stand just outside what is drawn as the station
const M_PER_DEGREE = 111_320;

/** Is the point within this box {minlat, minlon, maxlat, maxlon}, with a margin in metres? */
function inBox([lat, lon], box, margin) {
  const dLat = margin / M_PER_DEGREE, dLon = margin / (M_PER_DEGREE * Math.cos((lat * Math.PI) / 180));
  return lat >= box.minlat - dLat && lat <= box.maxlat + dLat && lon >= box.minlon - dLon && lon <= box.maxlon + dLon;
}

/** The stops that are bays of a station, see above. boxes: bounds of the amenity=bus_station of the area. */
export function stationStops(stops, boxes) {
  const out = new Set();
  for (const [id, s] of stops.df) {
    const pos = latlon(s), sameName = (stops.rivals.get(id) || []).filter((r) => stopKey(stops.df.get(r).stop_name) === stopKey(s.stop_name));
    const inStation = sameName.length > 0 && boxes.some((box) => inBox(pos, box, STATION_MARGIN_M));
    const code = siblingCode(s.stop_code || "");
    const codes = new Set([s.stop_code, ...sameName.map((r) => stops.df.get(r).stop_code).filter((c) => siblingCode(c || "") === code)]);
    const lettered = code && codes.size >= STATION_BAYS; // several networks may list the same bay: its letters are counted
    if (inStation || lettered) out.add(id);
  }
  return out;
}

/** The platform of a bay among its candidates: with its stop_id, then its ref, then holding no other stop, then drawn as a way, then the nearest: a stray node comes after the bay drawn. */
export function bayPlatform(candidates, stop, stops) {
  const own = candidates.filter((c) => c.holder || c.byRef);
  const shared = (c) => [...stops.holders].some(([id, keys]) => keys.has(c.id) && id !== stop.stop_id && stops.df.has(id));
  return minBy(own, (c) => [c.holder ? 0 : 1, c.byRef ? 0 : 1, shared(c) ? 1 : 0, c.id[0] === "w" ? 0 : 1, dist(latlon(stop), c.pos)]) ?? null;
}

/** platform -> its stop_position, each of them for one platform only, the closest pairs first. platforms: [{id, pos}], positions: [[key, position]]. */
export function pairBays(platforms, positions) {
  const reach = settings.thresholds.bay_stop_position_m;
  const pairs = platforms.flatMap((p) => positions.map(([key, pos]) => [dist(p.pos, pos), p.id, key])).filter(([d]) => d <= reach);
  const out = new Map(), used = new Set();
  for (const [, platform, key] of sortedBy(pairs, ([d]) => d)) {
    if (out.has(platform) || used.has(key)) continue;
    out.set(platform, key);
    used.add(key);
  }
  return out;
}

/** Set stops.stations and stops.bays (stop_id -> {platform: candidate, stop: key of its stop_position or null}). boxes: see stationStops. nodes: {key: object} of the stop_positions of the area. osm: the
 * OSM platforms. A platform of the station that no stop uses still takes its stop_position, with no stop to give it to. */
export function markStations(stops, boxes, nodes, osm) {
  stops.stations = stationStops(stops, boxes);
  stops.bays = new Map();
  if (!stops.stations.size) return;
  const positions = Object.entries(nodes).filter(([, o]) => o.lat !== undefined && isStopPositionFor(o.tags)).map(([k, o]) => [k, latlon(o)]);
  const chosen = new Map();
  for (const id of stops.stations) chosen.set(id, bayPlatform(stops.platforms.get(id) || [], stops.df.get(id), stops));
  const taken = new Set([...chosen.values()].filter(Boolean).map((c) => c.id));
  const holding = new Set([...stops.holders.values()].flatMap((keys) => [...keys]));
  const stationPoints = [...stops.stations].map((id) => latlon(stops.df.get(id)));
  const others = Object.entries(osm).filter(([k, o]) => (k[0] === "n" || k[0] === "w") && !taken.has(k) && !holding.has(k) && o.tags?.public_transport === "platform" && osmPosition(o))
    .map(([id, o]) => ({ id, pos: osmPosition(o) })).filter((p) => stationPoints.some((q) => dist(p.pos, q) <= settings.thresholds.sibling_m));
  const pairs = pairBays([...[...chosen.values()].filter(Boolean), ...others], positions);
  for (const [id, platform] of chosen) if (platform) stops.bays.set(id, { platform, stop: pairs.get(platform.id) ?? null });
}
