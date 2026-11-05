// Correct what is already mapped for a whole network, without touching a trace: the stops of its route relations and the names of its route and route_master
// relations are put in the form of this site. Only OSM is corrected, from OSM: the GTFS gives the networks and the area. Nothing is sent: the file is reviewed in JOSM.
//
// Stops: name and official_name (naming.stopNames), no bus=yes on platforms, GTFS ids and network tags tidied. Relations: name, from, to, via. Members never change.

import { networkFromOsm } from "./detect.js";
import { bbox, dist, latlon } from "./geo.js";
import { lookup } from "./lookup.js";
import { agencyNetworks, cleanStopName, masterLabel, nameKey, routeLabel, routeTitle, slug, stopKey, stopNames, tripLabel } from "./naming.js";
import { Store, completeWayNodes, readObjects, routesIn, writeOsm } from "./osm.js";
import { selectRoutes } from "./pipeline.js";
import { networkStops } from "./platform_tags.js";
import { VEHICLE, dropBusTag, nameNumberedNetworkTags, nameNumberedRefs } from "./platforms.js";
import { settings } from "./settings.js";
import { dedupe, log, sameTags } from "./util.js";

const PAD_M = 300;
const SAME_PLACE_M = 200; // the stops of one name this close are in one place: opposite stops get the same official_name, and Nominatim is asked once
const ARROWS = /\s*(?:=>|->|→|⇒)\s*/;

const positionOf = (o) => o.center ?? (o.lat !== undefined ? [o.lat, o.lon] : null);
const networksOf = (tags) => (tags.network ?? "").split(";").map(nameKey).filter(Boolean);
const capitalized = (s) => s[0].toUpperCase() + s.slice(1);

/** What comes before the ref in the names of a relation: the setting when it was changed, else what its name uses ("Car Nomad 224: …"), else fallback, else the setting. */
export function prefixOf(tags, mode, fallback = null) {
  const set = settings.prefixes[mode], usual = capitalized(mode);
  if (set && set !== usual) return set;
  const at = (tags.name ?? "").indexOf(":");
  const before = at < 0 || ARROWS.test(tags.name.slice(0, at)) ? "" : tags.name.slice(0, at).trim();
  const ref = tags.ref ?? "";
  const own = ref && before.endsWith(` ${ref}`) ? before.slice(0, -ref.length - 1) : !ref ? before : "";
  return own || fallback || set || usual;
}

/** Tags of a stop corrected. platform: it is a platform, not a stop_position; road: of a line on the road, highway=platform for a way, bus_stop for a node. */
function correctedStop(tags, names, { platform, road, way }) {
  const t = { ...tags, name: names.name };
  if (platform) {
    if (names.official_name) t.official_name = names.official_name;
    if (t.official_name === t.name) delete t.official_name;
    t.public_transport ??= "platform";
    dropBusTag(t);
    nameNumberedNetworkTags(t);
    nameNumberedRefs(t);
    for (const k of Object.keys(t)) {
      if (!/^gtfs:stop_name(?::|$)/.test(k)) continue;
      const kept = t[k].split(";").map((v) => v.trim()).filter((v) => v && v !== t.name);
      if (kept.length) t[k] = kept.join(";");
      else delete t[k];
    }
    if (road && !t.railway) t.highway ??= way ? "platform" : "bus_stop";
  }
  return t;
}

/** {name, official_name, places} of each stop, by key. A long network takes a while: Nominatim is asked at most once per second. */
async function nameAll(objects, lang, onProgress) {
  const seen = new Map(), out = new Map();
  const entries = [...objects].filter(([, o]) => o.tags.name && positionOf(o));
  for (const [i, [key, o]] of entries.entries()) {
    onProgress(`Towns of the stops (Nominatim): ${i + 1} of ${entries.length}…`);
    const name = cleanStopName(o.tags.name), pos = positionOf(o);
    const official = o.tags.official_name && stopKey(cleanStopName(o.tags.official_name)) === stopKey(name) ? cleanStopName(o.tags.official_name) : null;
    const nearby = seen.get(stopKey(name)) ?? [];
    let found = nearby.find((p) => dist(p.pos, pos) <= SAME_PLACE_M);
    if (!found) {
      found = { pos, places: await lookup.placesAt(pos[0], pos[1], lang) };
      seen.set(stopKey(name), [...nearby, found]);
    }
    const names = await stopNames(found.places, official ?? name, (place) => lookup.placeNear(place, pos[0], pos[1]));
    out.set(key, { ...names, places: found.places });
  }
  return out;
}

/** What separates the termini of a relation: its via, else the stops its name has between them. */
function viasOf(tags, renames) {
  const renamed = (v) => renames.get(v) ?? renames.get(cleanStopName(v)) ?? cleanStopName(v);
  if (tags.via) return dedupe(tags.via.split(";").map((v) => renamed(v.trim())).filter(Boolean));
  const text = (tags.name ?? "").slice((tags.name ?? "").indexOf(":") + 1).split(" via ")[0];
  return text.split(ARROWS).slice(1, -1).map((v) => renamed(v.trim())).filter(Boolean);
}

/** {xml, filename, summary, detected}: the corrected stops and relations of a network, read from OSM. Error if there is nothing to correct. */
export async function runNetworkFix(feed, { network, onProgress = () => {} }) {
  onProgress("GTFS stops of the network…");
  const stops = await networkStops(feed, network);
  if (!stops.length) throw new Error(`No stop for network "${network}".`);
  const networks = agencyNetworks(await feed.agency());
  const lines = selectRoutes(await feed.routes(), networks, network);

  onProgress("Relations of the network (Overpass)…");
  const relations = await routesIn(bbox(stops.map(latlon), PAD_M), settings.modes);
  const osmName = networkFromOsm(network, lines, relations);
  const wanted = new Set([nameKey(network), ...(osmName ? [nameKey(osmName)] : [])]);
  const ofNetwork = (tags) => networksOf(tags).some((n) => wanted.has(n));
  const routes = Object.entries(relations).filter(([, o]) => o.tags.route && ofNetwork(o.tags));
  if (!routes.length) throw new Error(`No route relation of "${[...new Set([network, osmName].filter(Boolean))].join('" or "')}" in OSM here: nothing to correct.`);

  // a member is a platform by its role, a stop_position by its tag if the two disagree
  const roles = new Map(), roadStops = new Set();
  for (const [, { tags, members }] of routes) {
    for (const [ref, role] of members) {
      if (ref[0] === "r" || !/^(?:platform|stop)/.test(role)) continue;
      if (role.startsWith("platform") || !roles.has(ref)) roles.set(ref, role.startsWith("platform"));
      if (tags.route in VEHICLE) roadStops.add(ref);
    }
  }
  onProgress(`The ${roles.size} stops of the network (Overpass)…`);
  const objects = new Map(Object.entries(await readObjects(roles.keys())));
  const lang = await feed.language();
  const names = await nameAll(objects, lang, onProgress);

  onProgress("Correcting…");
  const obj = new Store(Object.fromEntries(objects));
  const renames = new Map();
  let nStops = 0;
  for (const [key, o] of objects) {
    const found = names.get(key);
    if (!found) continue;
    renames.set(o.tags.name, found.name);
    const platform = roles.get(key) && o.tags.public_transport !== "stop_position";
    const tags = correctedStop(o.tags, found, { platform, road: roadStops.has(key), way: key[0] === "w" });
    if (sameTags(tags, o.tags) && !o.correctedIds) continue;
    if (o.tags.name !== tags.name || o.tags.official_name !== tags.official_name) log.info(`${key}: ${o.tags.name} -> ${tags.name}${tags.official_name ? ` (${tags.official_name})` : ""}`);
    obj.set(key, { ...o, tags });
    nStops++;
  }
  const unnamed = [...objects.keys()].filter((key) => !names.has(key));
  if (unnamed.length) log.warn(`${unnamed.length} stop(s) without a name, or without a position, left as they are (to check): ${unnamed.slice(0, 30).join(", ")}`);

  const set = (key, o, tags) => {
    if (sameTags(tags, o.tags) && !o.correctedIds) return false;
    if (tags.name !== o.tags.name) log.info(`${key}: ${o.tags.name ?? "(no name)"} -> ${tags.name}`);
    obj.set(key, { ...o, tags });
    return true;
  };
  const stopOf = (member) => names.get(member);
  const endpoints = new Map();
  let nRoutes = 0;
  const skipped = [];
  for (const [key, o] of routes) {
    const ordered = (role) => o.members.filter(([ref, r]) => r.startsWith(role) && stopOf(ref)).map(([ref]) => stopOf(ref));
    const members = ordered("platform").length >= 2 ? ordered("platform") : ordered("stop");
    if (members.length < 2) {
      skipped.push(key);
      continue;
    }
    const [first, last] = [members[0], members.at(-1)];
    const [from, to] = [first, last].map((s) => routeLabel(s.places, s.official_name ?? s.name));
    endpoints.set(key, [from, to]);
    const vias = viasOf(o.tags, renames);
    const prefix = prefixOf(o.tags, o.tags.route);
    const name = routeTitle(prefix, o.tags.ref, tripLabel(from, to, vias.map((v) => routeLabel([], v))), tripLabel(from, to));
    const tags = { ...o.tags, name, from: first.name, to: last.name, ...(o.tags.via ? { via: vias.join(";") } : {}) };
    if (set(key, o, tags)) nRoutes++;
  }
  if (skipped.length) log.warn(`${skipped.length} route relation(s) with less than two named stops, left as they are (to check): ${skipped.join(", ")}`);

  let nMasters = 0;
  for (const [key, o] of Object.entries(relations)) {
    if (!o.tags.route_master || (networksOf(o.tags).length && !ofNetwork(o.tags))) continue;
    const lines = o.members.map(([ref]) => ref).filter((ref) => endpoints.has(ref));
    if (!lines.length) continue;
    const route = relations[lines[0]].tags; // a route_master without a name of this form follows its routes
    const name = routeTitle(prefixOf(o.tags, o.tags.route_master, prefixOf(route, route.route)), o.tags.ref, masterLabel(lines.map((ref) => endpoints.get(ref))));
    if (set(key, o, { ...o.tags, name })) nMasters++;
  }

  const twins = new Map();
  for (const [key] of routes) {
    const name = obj.get(key)?.tags.name ?? relations[key].tags.name;
    twins.set(name, [...(twins.get(name) ?? []), key]);
  }
  for (const [name, keys] of twins) if (keys.length > 1) log.warn(`same name on ${keys.join(", ")}: ${name} (to tell apart in JOSM, or with the "via" tool)`);

  if (!obj.modified.size) throw new Error(`Nothing to correct: the ${roles.size} stops and ${routes.length} route relations of "${network}" are already in this form.`);
  await completeWayNodes(obj);
  log.info(`Network ${network}: ${nStops} of ${roles.size} stops corrected, ${nRoutes} of ${routes.length} route relations and ${nMasters} route_masters renamed`);
  return { xml: writeOsm(obj), filename: `${slug(network)}_correction.osm`, summary: { "corrected stops": nStops, "renamed routes": nRoutes, "renamed route_masters": nMasters },
    detected: osmName && nameKey(osmName) !== nameKey(network) ? [["Network in OSM", osmName]] : [] };
}
