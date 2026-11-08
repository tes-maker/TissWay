// Complete existing OSM platforms with the GTFS stops of one network, without creating relations: each GTFS stop is paired
// with the nearest OSM platform (within max_m, one platform per stop at most), to be reviewed in JOSM.
//
// Tags set: gtfs:stop_id:<feed>, gtfs:stop_name:<feed>, route_ref (routes of the network added to the existing values), and
// wheelchair when missing. The existing name is left unchanged.

import { feedCodeOf } from "./detect.js";
import { Grid, latlon, zonesAround } from "./geo.js";
import { refSortKey } from "./gtfs.js";
import { agencyNetworks, slug } from "./naming.js";
import { Store, completeWayNodes, platformsIn, writeOsm } from "./osm.js";
import { stopNetworks } from "./pipeline.js";
import { reviewRefs } from "./ref_review.js";
import { settings } from "./settings.js";
import { addStopValue, nameNumberedNetworkTags, nameNumberedRefs, refKeyFor } from "./platforms.js";
import { osmPlatforms } from "./stops.js";
import { log, sameTags, setIn, setList, sortedBy, splitTag, unique } from "./util.js";

const WHEELCHAIR = { 1: "yes", 2: "no" };

/** GTFS stops served by the network, each with its route_ref (Set of route numbers). */
export async function networkStops(feed, network) {
  const networks = agencyNetworks(await feed.agency());
  const agencies = new Set(Object.entries(networks).filter(([, t]) => t.network.toLowerCase() === network.toLowerCase()).map(([a]) => a));
  if (!agencies.size) throw new Error(`Unknown network "${network}". Available: ${unique(Object.values(networks).map((t) => t.network)).sort().join(", ")}`);
  const refOf = new Map((await feed.routes()).filter((r) => agencies.has(r.agency_id) && settings.modes.includes(r.mode)).map((r) => [r.route_id, r.route_short_name]));
  const tripRef = new Map((await feed.trips()).filter((t) => refOf.has(t.route_id)).map((t) => [t.trip_id, refOf.get(t.route_id)]));
  const refs = new Map();
  for (const { trip_id, stop_id } of await feed.stopTimes(tripRef.keys())) {
    const lineRefs = setIn(refs, stop_id);
    if (tripRef.get(trip_id)) lineRefs.add(tripRef.get(trip_id));
  }
  return (await feed.stops()).filter((s) => refs.has(s.stop_id)).map((s) => ({ ...s, route_ref: refs.get(s.stop_id) }));
}

/** stop_id -> [platform, distance] of the nearest pairs, one to one: by increasing distance, each stop and each platform is
 * taken once (two opposite stops do not end up on the same platform). */
export function nearestPairs(stops, platforms, max_m) {
  const grid = new Grid(platforms, (p) => p.pos, max_m);
  const pairs = stops.flatMap((s) => grid.within(latlon(s), max_m).map(([p, d]) => [s.stop_id, p.id, d]));
  pairs.sort((a, b) => a[2] - b[2]);
  const usedPlatforms = new Set(), result = new Map();
  for (const [stopId, platform, d] of pairs) {
    if (result.has(stopId) || usedPlatforms.has(platform)) continue;
    usedPlatforms.add(platform);
    result.set(stopId, [platform, d]);
  }
  return result;
}

/** Platform tags completed with the GTFS stop. */
export function feedTags(tags, stop, feedId, network = tags.network) {
  const t = { ...tags }, suffix = feedId ? `:${feedId}` : "";
  nameNumberedNetworkTags(t);
  nameNumberedRefs(t, stop.stop_id);
  addStopValue(t, `gtfs:stop_id${suffix}`, stop.stop_id);
  setList(t, `gtfs:stop_name${suffix}`, splitTag(t[`gtfs:stop_name${suffix}`]).filter((v) => v !== t.name));
  if (stop.stop_name !== t.name) addStopValue(t, `gtfs:stop_name${suffix}`, stop.stop_name);
  if (stop.stop_code && settings.stop_refs_from_gtfs) {
    const key = `gtfs:stop_code${suffix}`;
    addStopValue(t, t.network && network !== t.network ? refKeyFor(key, network) : key, stop.stop_code);
  }
  const refs = new Set([...(t.route_ref || "").split(";").filter(Boolean), ...stop.route_ref]);
  if (refs.size) t.route_ref = sortedBy(refs, refSortKey).join(";");
  if (WHEELCHAIR[stop.wheelchair_boarding]) t.wheelchair ??= WHEELCHAIR[stop.wheelchair_boarding];
  return t;
}

const csvCell = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** {xml, filename, csv, csvName}: the modified platforms, and the stops without a nearby platform. */
export async function runPlatforms(feed, { network, feedId = null, max_m = 30, onProgress = () => {} }) {
  onProgress("GTFS stops of the network…");
  const stops = await networkStops(feed, network);
  if (!stops.length) throw new Error(`No stop for network "${network}".`);
  onProgress("OSM platforms (Overpass)…");
  const osm = await platformsIn(zonesAround(stops.map(latlon), max_m + 50));
  const matches = nearestPairs(stops, osmPlatforms(osm), max_m);
  const suffix = feedId ?? (settings.feed === "auto" ? await feedCodeOf(feed) : settings.feed);

  const obj = new Store(osm);
  for (const stop of stops) {
    if (!matches.has(stop.stop_id)) continue;
    const id = matches.get(stop.stop_id)[0];
    const tags = feedTags(osm[id].tags, stop, suffix, network);
    if (!sameTags(tags, osm[id].tags) || osm[id].correctedIds) obj.set(id, { ...osm[id], tags });
  }
  await completeWayNodes(obj);
  const review = reviewRefs(obj, { ...await stopNetworks(feed, agencyNetworks(await feed.agency())), stops: await feed.stops(), feed: suffix });
  const missing = stops.filter((s) => !matches.has(s.stop_id));
  const columns = ["stop_id", "stop_code", "stop_name", "stop_lat", "stop_lon"];
  const csv = `${[columns.join(","), ...missing.map((s) => columns.map((c) => csvCell(s[c] || "")).join(","))].join("\n")}\n`;
  log.info(`${stops.length} GTFS stops: ${matches.size} paired with an OSM platform (<= ${max_m} m), ${obj.modified.size} platform(s) modified`);
  log.info(`${missing.length} stop(s) without a nearby OSM platform`);
  const base = `${slug(network)}_platforms`;
  return { get xml() { return writeOsm(obj); }, review, filename: `${base}.osm`, csv, csvName: `${base}_unmatched.csv`, detected: suffix ? [["Suffix of the gtfs:* tags", suffix]] : [], summary: { stops: stops.length, paired: matches.size, missing: missing.length } };
}
