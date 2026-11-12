// Check the gtfs:shape_id:<feed> of the route relations of a whole network against a new GTFS, from their ref_trips.
//
// ref_trips lists trips of the relation (PTNA's way of tying a relation to the feed, whose shape_ids change from one release to the next). Each of those trips
// still in the feed gives the shape_id it follows today: that is the value gtfs:shape_id:<feed> should hold. A relation none of whose trips is in the feed cannot
// be judged and is only reported. Nothing is changed until a row is chosen: proposeShapes reads and compares, shapeFile writes the rows kept.

import { feedCodeOf, networkFromOsm } from "./detect.js";
import { latlon, zonesAround } from "./geo.js";
import { agencyNetworks, nameKey, slug } from "./naming.js";
import { Store, changesOsm, cleanGtfsId, routesIn, writeOsm } from "./osm.js";
import { selectRoutes } from "./pipeline.js";
import { networkStops } from "./platform_tags.js";
import { joinIds } from "./existing.js";
import { settings } from "./settings.js";
import { log, splitTag, unique } from "./util.js";

const PAD_M = 300;

/** Rows to check for a network: {rows, relations, feed, key, network}. A row: {key, name, tag, old, fresh, trips, status}.
 * status: "changed" (fresh differs from old), "added" (no shape_id mapped yet), "unknown" (no ref_trips trip in the feed), "noshape" (found, but without shape), "same" (not listed). */
export async function proposeShapes(feed, { network, onProgress = () => {} }) {
  onProgress("GTFS stops of the network…");
  const stops = await networkStops(feed, network);
  if (!stops.length) throw new Error(`No stop for network "${network}".`);
  const networks = agencyNetworks(await feed.agency());
  const lines = selectRoutes(await feed.routes(), networks, network);

  onProgress("Relations of the network (Overpass)…");
  const relations = await routesIn(zonesAround(stops.map(latlon), PAD_M), settings.modes);
  const osmName = networkFromOsm(network, lines, relations);
  const wanted = new Set([nameKey(network), ...(osmName ? [nameKey(osmName)] : [])]);
  const routes = Object.entries(relations).filter(([, o]) => o.tags.route && (o.tags.network ?? "").split(";").map(nameKey).some((n) => wanted.has(n)));
  if (!routes.length) throw new Error(`No route relation of "${network}" in OSM here: nothing to check.`);

  const code = settings.feed === "auto" ? await feedCodeOf(feed, relations) : (settings.feed ?? "");
  const tag = code ? `gtfs:shape_id:${code}` : "gtfs:shape_id";

  onProgress("Trips of the feed…");
  const shapeOf = new Map((await feed.trips()).map((t) => [t.trip_id, t.shape_id]));
  const rows = [];
  for (const [key, o] of routes) {
    const trips = splitTag(o.tags.ref_trips ?? "");
    if (!trips.length) continue;
    const old = splitTag(o.tags[tag] ?? "").map(cleanGtfsId);
    const found = trips.map((t) => [t, shapeOf.has(t) ? t : shapeOf.has(cleanGtfsId(t)) ? cleanGtfsId(t) : null]).filter(([, id]) => id !== null);
    const fresh = unique(found.map(([, id]) => shapeOf.get(id)).filter(Boolean));
    let status = "changed";
    if (!found.length) status = "unknown";
    else if (!fresh.length) status = "noshape";
    else if (!old.length) status = "added";
    else if (new Set(old).size === fresh.length && fresh.every((s) => old.includes(s))) status = "same";
    rows.push({ key, name: o.tags.name || key, tag, old, fresh, trips, found: found.length, status });
  }
  const order = { changed: 0, added: 1, unknown: 2, noshape: 3, same: 4 };
  rows.sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name));
  const withoutTrips = routes.length - rows.length;
  log.info(`Network ${network}: ${routes.length} route relations, ${withoutTrips} without ref_trips, ${rows.filter((r) => r.status === "changed").length} with obsolete ${tag}`);
  return { rows, relations, feed: code, tag, network, osmName, withoutTrips, total: routes.length };
}

/** {xml, filename, summary} putting the fresh shape_ids on the chosen rows (their keys). Error if nothing is chosen or nothing changes. */
export function shapeFile(plan, chosen) {
  const obj = new Store(Object.fromEntries(Object.entries(plan.relations)));
  let n = 0;
  for (const row of plan.rows) {
    if (!chosen.has(row.key) || !["changed", "added"].includes(row.status)) continue;
    const o = plan.relations[row.key];
    obj.update(row.key, o, { ...o, tags: { ...o.tags, [row.tag]: joinIds(row.fresh) } });
    n++;
  }
  if (!n || !changesOsm(obj)) throw new Error("No shape_id chosen, or nothing to change.");
  return { xml: writeOsm(obj), filename: `${slug(plan.network)}_shape_ids.osm`, summary: { "corrected relations": n } };
}
