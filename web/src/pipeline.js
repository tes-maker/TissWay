// Full run: GTFS -> map-matched variants -> PTv2 relations -> .osm text.
//
// Steps of runRoutes():
// 1. selection of the routes (network, route numbers) in the GTFS;
// 2. GTFS stops related to the OSM platforms read from Overpass around the stops (stops.matchStops), conventions of the feed
//    detected from OSM (detect.js), accents and towns of the names (lookup.js);
// 3. map-matching of each variant with Valhalla (matching.matchVariant);
// 4. reading of the travelled ways from Overpass;
// 5. network tags found (OSM, then Wikidata), relations of each line (build.buildLine), existing ones updated in place
//    (existing.js), then GTFS and network tags of the platforms (platforms.tagPlatforms);
// 6. ways split where routes enter or leave them, once for all the lines (splitting.splitWays);
// 7. a single .osm text is written (objects shared between lines: no conflict on upload).

import { borrowable, borrowedTrace, guidedPath } from "./borrow.js";
import { buildLine } from "./build.js";
import { detectStopRefTags, feedCodeOf, networkFromOsm } from "./detect.js";
import { ExistingRoutes, WIKI_KEYS } from "./existing.js";
import { inZones, latlon, zonesAround } from "./geo.js";
import { lineVariants, refSortKey, stopSequences } from "./gtfs.js";
import { matchVariant, valhalla } from "./matching.js";
import { keepTraces, reachStopPositions, terminusRoads } from "./reuse.js";
import { lookup } from "./lookup.js";
import { accentsFrom, agencyNetworks, cleanStopName, fixAccents, nameKey, slug, stopLabel, stopNames, words } from "./naming.js";
import { services, valhallaReady } from "./net.js";
import { Store, completeWayNodes, platformsIn, readWays, routesIn, stopPositionsIn, writeOsm } from "./osm.js";
import { filterRoadPlatforms, lostStops, nameNumberedNetworkTags, refKeyFor, tagPlatforms } from "./platforms.js";
import { reviewRefs } from "./ref_review.js";
import { activeFeed, settings } from "./settings.js";
import { splitWays } from "./splitting.js";
import { matchStops, pairStopPositions } from "./stops.js";
import { dedupe, listIn, log, sortedBy, unique } from "./util.js";

export class SelectionError extends Error {}

const PAD_M = 300; // OSM read beyond the stops of the selection, more than any distance used around a stop

/** Routes to generate, sorted by number: those of settings.modes, of the network (value of the network tag,
 * case-insensitive) and / or with these numbers (route_short_name, or route_id). SelectionError if unknown. */
export function selectRoutes(routes, networks, network = null, refs = []) {
  let out = routes.filter((r) => settings.modes.includes(r.mode));
  if (network) {
    const wanted = network.trim().toLowerCase();
    out = out.filter((r) => (networks[r.agency_id]?.network || "").toLowerCase() === wanted);
    if (!out.length) {
      const known = unique(Object.values(networks).map((n) => n.network)).sort().join(", ");
      throw new SelectionError(`No ${settings.modes.join("/")} line in network "${network}". Available networks: ${known}`);
    }
  }
  if (refs.length) {
    const known = new Set(out.flatMap((r) => [r.route_short_name, r.route_id]));
    const unknown = refs.filter((r) => !known.has(r));
    if (unknown.length) {
      const available = sortedBy(new Set(out.map((r) => r.route_short_name).filter(Boolean)), refSortKey).join(", ");
      throw new SelectionError(`Unknown line(s): ${unknown.join(", ")}. Available lines: ${available}`);
    }
    const wanted = new Set(refs);
    out = out.filter((r) => wanted.has(r.route_short_name) || wanted.has(r.route_id));
  }
  return sortedBy(out, (r) => refSortKey(r.route_short_name));
}

/** networks (agency_id -> network tags) completed with the network:wikidata / network:wikipedia of the existing OSM
 * relations, for the keys they lack. Nothing is taken when they already give another network:wikidata. */
export function withWikis(networks, wikis) {
  const out = {};
  for (const [agencyId, tags] of Object.entries(networks)) {
    let known = wikis[tags.network] || {};
    if ((tags["network:wikidata"] ?? known["network:wikidata"]) !== known["network:wikidata"]) known = {};
    const added = Object.entries(known).filter(([k]) => !(k in tags));
    out[agencyId] = { ...tags, ...Object.fromEntries(added) };
    if (added.length) log.info(`${tags.network}: ${added.map(([k, v]) => `${k}=${v}`).join(", ")} taken from the existing OSM relations`);
  }
  return out;
}

/** Add network:wikidata / network:wikipedia to route relations, route masters and platforms that lack them.
 * Secondary networks keep their name in the key. Values already set are kept. Returns the number of objects completed. */
export function completeWikis(obj, networks) {
  const wikis = {};
  for (const t of Object.values(networks)) {
    if (t.network) wikis[t.network] = Object.fromEntries(WIKI_KEYS.filter((k) => t[k]).map((k) => [k, t[k]]));
  }
  let done = 0;
  for (const [key, o] of obj.modified) {
    const tags = { ...(o.tags || {}) };
    if (!["route", "route_master"].includes(tags.type) && tags.public_transport !== "platform") continue;
    const hadNumberedTags = Object.keys(tags).some((k) => /^(?:network:wikidata|network:wikipedia|gtfs:stop_code(?::[A-Z][A-Z][a-zA-Z0-9_.-]+)?):\d+$/.test(k));
    nameNumberedNetworkTags(tags);
    const added = {};
    const networkTags = Object.keys(tags).filter((k) => /^network(?::\d+)?$/.test(k)).sort((a, b) => a === "network" ? -1 : b === "network" ? 1 : Number(a.slice(8)) - Number(b.slice(8)));
    for (const key of networkTags) {
      const network = tags[key];
      for (const [wiki, value] of Object.entries(wikis[network] || {})) {
        const target = key === "network" ? wiki : refKeyFor(wiki, network);
        if (!(target in tags)) added[target] = value;
      }
    }
    if (Object.keys(added).length || hadNumberedTags) {
      obj.set(key, { ...o, tags: { ...tags, ...added } });
      done++;
    }
  }
  return done;
}

/** [[route, variants]]: for each route, its map-matched variants. Variants Valhalla cannot match are reported and skipped,
 * as are routes without any variant. */
async function mapLines(feed, routes, trips, stops, networks, existing, onProgress) {
  const byRoute = new Map();
  for (const t of trips) listIn(byRoute, t.route_id).push(t);
  const pending = routes.map((route) => [route, lineVariants(byRoute.get(route.route_id) || [])]);
  const total = pending.reduce((n, [, vs]) => n + vs.length, 0);
  const keptOf = new Map(), lentTo = new Map();
  let roads = {}, done = 0;
  for (const [route, found] of pending) {
    const label = route.route_short_name || route.route_id;
    onProgress(`Existing traces of line ${label} (Overpass)…`);
    const network = (networks[route.agency_id] || { network: route.agency_id || "GTFS" }).network;
    const { kept, roads: read } = await keepTraces(route, found, network, existing, stops);
    keptOf.set(route, kept);
    const lent = await borrowable(route, found.filter((v) => !kept.has(v)), existing, stops);
    lentTo.set(route, lent);
    roads = { ...roads, ...read, ...lent.roads };
    if (kept.size) log.info(`line ${label}: ${kept.size} of ${found.length} trace(s) kept from OSM: ${[...kept.values()].map(([k]) => k).join(", ")}`);
  }
  const shapes = await feed.shapes(pending.flatMap(([route, vs]) => vs.filter((v) => !keptOf.get(route).has(v)).map((v) => v.shape_id).filter(Boolean)));
  const matched = new Map(); // a shape several variants follow is map-matched once
  const lines = [];
  for (const [route, found] of pending) {
    const label = route.route_short_name || route.route_id, variants = [], kept = keptOf.get(route);
    for (const v of found) {
      onProgress(`Map-matching: line ${label}, variant ${++done}/${total}`);
      if (kept.has(v)) {
        const [kept_from, ways, complete] = kept.get(v);
        variants.push({ ...v, ways, source: "existing", kept_from, complete });
        continue;
      }
      const lent = lentTo.get(route), pieces = lent.pieces(v), positions = stops.positions(v.seq);
      const borrowed = borrowedTrace(v, pieces, lent.obj, positions, shapes.get(v.shape_id));
      if (borrowed) {
        log.info(`  line ${label}, trip ${v.trip_id}: trace of the other lines serving the same stops (${unique(pieces.map((p) => p.relation)).join(", ")})`);
        variants.push({ ...v, ways: borrowed, source: "borrowed" });
        continue;
      }
      try {
        const guided = pieces.length ? (ps) => guidedPath(pieces, lent.obj, ps, valhalla.routeThrough) : undefined;
        const [ways, source] = await matchVariant(shapes.get(v.shape_id), positions, matched, guided);
        variants.push({ ...v, ways, source });
      } catch (e) {
        if (e.name === "AbortError") throw e;
        log.warn(`  line ${label}, trip ${v.trip_id} skipped: ${e.message}`);
      }
    }
    if (variants.length) lines.push([route, variants]);
    else log.warn(`  line ${label} skipped: no variant could be map-matched`);
  }
  return { lines, roads };
}

const outputName = (network, [route]) => `${network ? slug(network) : "gtfs"}_${slug(route.route_short_name || route.route_id)}.osm`;

/** Accents of the names of the stops ids restored: from the OSM platforms of the same name, else from Wiktionary. */
async function restoreAccents(stops, ids, lang) {
  const respell = (s, name, report) => {
    if (name !== s.stop_name) report(`accents: ${s.stop_name} -> ${name}`);
    s.stop_name = name;
  };
  const noted = new Set(); // a name is reported once, whatever the number of stops carrying it
  const once = (write) => (message) => {
    if (!noted.has(message)) write(message);
    noted.add(message);
  };
  const rows = ids.map((id) => stops.df.get(id));
  for (const [i, s] of rows.entries()) {
    const same = (stops.platforms.get(ids[i]) || []).filter((c) => c.name && nameKey(c.name) === nameKey(s.stop_name));
    for (const c of same) if (/[^\x00-\x7f]/.test(c.name)) respell(s, accentsFrom(s.stop_name, c.name), once(log.info));
  }
  const accents = await lookup.accents(rows.flatMap((s) => words(s.stop_name)), lang);
  for (const s of rows) respell(s, fixAccents(s.stop_name, accents), once((m) => log.warn(`${m} (from Wiktionary, to check)`)));
}

/** agency_id -> network tags for the agencies of the lines: what the settings say, else the network found in OSM, then the wiki
 * keys of the existing relations and of Wikidata. A value only known from Wikidata is reported, to check. */
async function resolveNetworks(networks, agencies, routes, relations, wikis, country, lang) {
  const out = { ...networks };
  for (const agency of agencies) {
    const id = agency.agency_id;
    let tags = networks[id];
    if (!tags) continue;
    if (!settings.networks[id] && !settings.networks[agency.agency_name]) {
      const name = networkFromOsm(tags.network, routes.filter((r) => r.agency_id === id), relations);
      if (name) tags = { network: name };
    }
    tags = withWikis({ [id]: tags }, wikis)[id];
    if (!tags["network:wikidata"]) {
      const qid = await lookup.wikidataNetwork(tags.network, agency.agency_url, country, lang);
      if (qid) {
        tags = { ...tags, "network:wikidata": qid };
        log.warn(`${tags.network}: network:wikidata=${qid} found on Wikidata, not used in OSM yet (to check)`);
      }
    }
    if (tags["network:wikidata"] && !tags["network:wikipedia"]) {
      const page = await lookup.wikipediaOf(tags["network:wikidata"], lang);
      if (page) tags = { ...tags, "network:wikipedia": page };
    }
    out[id] = tags;
  }
  return out;
}

/** {sizes: network -> number of stops in the feed, to tell a local network from a regional one on a shared stop (see platforms.enrich);
 * ofStop: stop_id -> networks calling at it, to tell the stop of another network from the one across the road}. */
export async function stopNetworks(feed, networks) {
  const sizes = new Map(), ofStop = new Map();
  for (const [stopId, agencies] of await feed.stopAgencies()) {
    const names = new Set([...agencies].map((a) => networks[a]?.network).filter(Boolean));
    ofStop.set(stopId, names);
    for (const name of names) sizes.set(name, (sizes.get(name) || 0) + 1);
  }
  return { sizes, ofStop };
}

/** The selected routes and what the feed says about them. */
async function readSelection(feed, network, ref) {
  if (!ref) throw new SelectionError("Choose a line: one is converted at a time.");
  const allNetworks = agencyNetworks(await feed.agency());
  const routes = selectRoutes(await feed.routes(), allNetworks, network, [ref]);
  if (routes.length > 1) throw new SelectionError(`Several lines answer to "${ref}": choose one by its route_id (${routes.map((r) => r.route_id).join(", ")}).`);
  const routeIds = new Set(routes.map((r) => r.route_id));
  const allStops = await feed.stops();
  const known = new Map(allStops.map((s) => [s.stop_id, s]));
  const selected = (await feed.trips()).filter((t) => routeIds.has(t.route_id));
  const stopTimes = await feed.stopTimes(selected.map((t) => t.trip_id));
  const unknown = unique(stopTimes.filter((st) => !known.has(st.stop_id)).map((st) => st.stop_id));
  if (unknown.length) log.warn(`${unknown.length} stop_id(s) of stop_times missing from stops.txt (skipped): ${unknown.slice(0, 10).join(", ")}`);
  const trips = stopSequences(selected, stopTimes.filter((st) => known.has(st.stop_id)));
  const used = unique(trips.flatMap((t) => t.stop_seq));
  if (!used.length) throw new SelectionError("No stop for this selection in the GTFS.");
  log.info(`${routes.length} line(s), ${trips.length} trip(s), ${used.length} stop(s)`);
  return { allNetworks, routes, allStops, known, trips, used };
}

/** Driving side of the country of the stops, when the settings leave it to "auto". */
async function detectDrivingSide(country, detected) {
  if (settings.driving_side !== "auto") return;
  const side = country && (await lookup.drivingSide(country));
  if (!side) log.warn("Driving side unknown: right-hand traffic assumed (see Settings)");
  settings.driving_side = side || "right";
  detected.push(["Driving side", `${settings.driving_side}${country ? ` (${country.toUpperCase()})` : ""}`]);
}

/** The stops of the area with their candidate platforms, and the tags OSM uses for them. */
async function prepareStops(feed, { allStops }, box, osmStops, detected) {
  const stopIds = new Set(allStops.map((s) => s.stop_id));
  const refTags = detectStopRefTags(osmStops, stopIds).filter((t) => !settings.stop_ref_tags.includes(t));
  if (refTags.length) {
    settings.stop_ref_tags = [...settings.stop_ref_tags, ...refTags];
    detected.push(["Tags holding the stop_id", refTags.join(", ")]);
  }
  const area = allStops.filter((s) => inZones(latlon(s), box)).map((s) => ({ ...s, stop_name: cleanStopName(s.stop_name) }));
  const stops = matchStops(area, await feed.stopAgencies(), osmStops);
  await pairStops(stops, box, osmStops);
  return stops;
}

/** Each platform of the area with its stop_position, and the bays. Without them, a stop_position is found on the trace alone. */
async function pairStops(stops, box, osmStops) {
  try {
    pairStopPositions(stops, await stopPositionsIn(box), osmStops);
    if (stops.bays.size) log.info(`${stops.bays.size} bay(s): stops of one name with at least 3 platforms with a ref`);
  } catch (e) {
    if (e.name === "AbortError") throw e;
    log.warn(`stop_positions of the area not available (${e.message})`);
  }
}

/** Final names of the stops (naming.stopNames) and their labels in the titles of the lines (naming.stopLabel). */
async function nameStops(stops, used, lang, onProgress) {
  if (settings.fix_accents) {
    onProgress("Spelling of the stop names…");
    await restoreAccents(stops, used, lang);
  }
  for (const s of stops.df.values()) s.label = s.stop_name;
  onProgress("Towns of the stops (Nominatim)…"); // with the opposite stops: the data of one may replace the other (platforms.fixSide)
  for (const id of new Set(used.flatMap((u) => [u, ...(stops.neighbours.get(u) || [])]))) {
    const s = stops.df.get(id), places = await lookup.placesAt(s.lat, s.lon, lang);
    const { name, official_name } = await stopNames(places, s.stop_name, (place) => lookup.placeNear(place, s.lat, s.lon), lookup.isDelegated);
    Object.assign(s, { stop_name: name, official_name, label: stopLabel({ name, official_name, places }) });
  }
}

/** The travelled ways of the variants, read from OSM; what OSM does not have any more is left out. */
async function readRoads(variants, stops, osmStops, known) {
  const roads = { ...known, ...(await readWays(new Set(variants.flatMap((v) => v.ways).filter((w) => !known[w])))) };
  for (const v of variants) {
    const before = v.ways.length;
    v.ways = dedupe(v.ways.filter((w) => roads[w]?.nodes)); // ways deleted from OSM since the Valhalla tiles were built
    if (v.ways.length < before) log.warn(`  trip ${v.trip_id}: ${before - v.ways.length} way(s) from Valhalla missing from OSM (older Valhalla data)`);
  }
  Object.assign(roads, { ...(await reachStopPositions(variants, stops, roads)), ...roads });
  Object.assign(roads, { ...(await terminusRoads(variants, stops, roads)), ...roads });
  // a node of a travelled way (legacy highway=bus_stop on the carriageway) is a stop_position, not a platform
  const osm = { ...osmStops, ...roads };
  const roadNodes = new Set(variants.flatMap((v) => v.ways.flatMap((w) => roads[w].nodes)));
  stops.platforms = filterRoadPlatforms(stops.platforms, roadNodes, osm);
  return osm;
}

/** Existing relations of the area, feed code and network tags. existing: null if the relations are not to be updated. */
async function readExisting({ feed, allNetworks, routes, agency, box, country, lang, detected, onProgress }) {
  if (!settings.update_existing && !settings.network_auto && settings.feed !== "auto") return { existing: null, networks: allNetworks };
  onProgress("Existing relations (Overpass)…");
  const relations = await routesIn(box, settings.modes);
  const existing = new ExistingRoutes(relations);
  existing.feedRouteIds = new Set((await feed.routes()).map((r) => r.route_id));
  let networks = allNetworks;
  if (settings.feed === "auto") {
    onProgress("Feed code (OSM)…");
    settings.feed = await feedCodeOf(feed, relations);
    if (settings.feed) detected.push(["Suffix of the gtfs:* tags", settings.feed]);
    else log.warn("No GTFS feed code for this run: PTNA cannot link the gtfs:* tags to a feed. Try again if OSM was not available just above, or set its code from the OSM wiki's List of GTFS feeds in Settings.");
  }
  if (settings.network_auto) {
    onProgress("Network tags (OSM, Wikidata)…");
    const usedAgencies = new Set(routes.map((route) => route.agency_id));
    const inUse = agency.filter((a) => usedAgencies.has(a.agency_id));
    networks = await resolveNetworks(allNetworks, inUse, routes, relations, existing.wikis, country, lang);
    for (const a of inUse) for (const [k, v] of Object.entries(networks[a.agency_id] || {})) detected.push([k, v]);
  }
  return { existing: settings.update_existing ? existing : null, networks };
}

/** Generate one line, the only unit of conversion: ref is its route_short_name or route_id. Returns {xml, filename, detected, summary, state}. detected: [[what, value]]
 * found online for this run; state holds everything computed, for debugging (window.tissway.last in the page). */
export async function runRoutes(feed, { network = null, ref = null, onProgress = () => {} } = {}) {
  onProgress("Reading the GTFS…");
  const agency = await feed.agency();
  const lang = await feed.language();
  const selection = await readSelection(feed, network, ref);
  const { allNetworks, routes, known, trips, used } = selection;

  const detected = [];
  const country = settings.driving_side === "auto" || settings.network_auto ? await lookup.countryAt(...latlon(known.get(used[0])), lang) : null;
  await detectDrivingSide(country, detected);

  onProgress("OSM platforms (Overpass)…");
  const box = zonesAround(used.map((id) => latlon(known.get(id))), PAD_M);
  const osmStops = await platformsIn(box);
  const stops = await prepareStops(feed, selection, box, osmStops, detected);
  await nameStops(stops, used, lang, onProgress);

  const { existing, networks } = await readExisting({ feed, allNetworks, routes, agency, box, country, lang, detected, onProgress });

  if (!(await valhallaReady())) throw new Error(`Valhalla does not answer on ${services.valhalla_url}`);
  const { lines, roads } = await mapLines(feed, routes, trips, stops, networks, existing, onProgress);
  if (!lines.length) throw new Error("No line could be matched on the roads: see the log.");

  onProgress("OSM ways (Overpass)…");
  const variants = lines.flatMap(([, vs]) => vs);
  const obj = new Store(await readRoads(variants, stops, osmStops, roads));

  onProgress("Building the relations…");
  const assignments = new Map(), created = new Map();
  for (const [route, routeVariants] of lines) {
    const tags = networks[route.agency_id] || { network: route.agency_id || "GTFS" };
    buildLine(route, routeVariants, obj, stops, tags, assignments, created, existing);
  }
  for (const id of lostStops(variants, stops, assignments)) log.warn(`${stops.df.get(id).stop_name} (${id}) is on OSM platform ${[...stops.holders.get(id)].join(", ")} and served in the GTFS, but no relation uses it: another stop took its place (to check)`);
  const owners = await stopNetworks(feed, networks);
  for (const x of tagPlatforms(obj, stops, assignments, owners)) log.warn(`stop_id already on another OSM platform, not set (to check): ${x}`);
  onProgress("Splitting ways…"); // after the relations: ways are also cut at the stop_positions of the termini
  const [nWays, nClosed, nRels] = await splitWays(obj);
  log.info(`${nWays} way(s) split, of which ${nClosed} roundabout(s) / closed way(s); ${nRels} existing OSM relation(s) updated`);
  const n = completeWikis(obj, networks);
  if (n) log.info(`network:wikidata / network:wikipedia completed on ${n} relation(s) / platform(s)`);
  await completeWayNodes(obj);
  const review = reviewRefs(obj, { ...owners, stops: await feed.stops(), feed: activeFeed(), network: networks[lines[0][0].agency_id]?.network ?? (lines[0][0].agency_id || "GTFS") });

  const summary = { lines: lines.length, variants: variants.length, stops: used.length, "kept traces": variants.filter((v) => v.kept_from).length,
    "borrowed traces": variants.filter((v) => v.source === "borrowed").length, "complete relations": variants.filter((v) => v.complete).length };
  return { get xml() { return writeOsm(obj); }, review, filename: outputName(network, routes), detected, summary, state: { routes, trips, stops, lines, obj, networks, assignments } };
}
