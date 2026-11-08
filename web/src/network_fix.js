// Correct what is already mapped for a whole network, without touching a trace: the stops of its route relations and the names of its route and route_master
// relations are put in the form of this site. Only OSM is corrected, from OSM: the GTFS gives the networks and the area. Nothing is sent: the file is reviewed in JOSM.
//
// Stops: name and official_name (naming.stopNames), no alt_name, no bus=yes on platforms, GTFS ids and network tags tidied, a stop_position with only its vehicle and name, what it has more
// going to its platform; an object tagged as the other kind, or in the other role, put right (stopKind). Relations: name, from, to, via, these roles. No member moves; one platform per stop: an area
// next to the node of the same platform (same ref, or same name within platform_m) leaves the relation, the node stays.

import { networkFromOsm } from "./detect.js";
import { dist, latlon, osmPosition, zonesAround } from "./geo.js";
import { lookup } from "./lookup.js";
import { ARROWS, agencyNetworks, cleanStopName, masterLabel, nameKey, routeTitle, slug, stopKey, stopLabel, stopNames, tripTitle } from "./naming.js";
import { Store, changesOsm, completeWayNodes, differsFromOsm, onRoad, readObjects, routesIn, writeOsm } from "./osm.js";
import { selectRoutes } from "./pipeline.js";
import { networkStops } from "./platform_tags.js";
import { twinsOf } from "./stops.js";
import { chooseVias } from "./via.js";
import { VEHICLE, nameNumberedNetworkTags, nameNumberedRefs, stopPositionOnly, takeFromStopPosition } from "./platforms.js";
import { settings } from "./settings.js";
import { capitalized, dedupe, listIn, log, setIn, setList, splitTag, unique } from "./util.js";

const PAD_M = 300;
const SAME_PLACE_M = 200; // the stops of one name this close are in one place: opposite stops get the same official_name, and Nominatim is asked once

const networksOf = (tags) => (tags.network ?? "").split(";").map(nameKey).filter(Boolean);

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

/** Tags of a platform corrected. names: its names, if it has any. road: of a line on the road, highway=platform for a way, bus_stop for a node. bus: of a bus or coach line, bus=yes unless it says otherwise. */
function correctedPlatform(tags, names, { road, way, bus }) {
  const t = { ...tags, ...(names ? { name: names.name } : {}), public_transport: "platform" };
  if (names?.official_name) t.official_name = names.official_name;
  if (t.official_name === t.name) delete t.official_name;
  if (bus) t.bus ??= "yes";
  delete t.alt_name;
  nameNumberedNetworkTags(t);
  nameNumberedRefs(t);
  for (const k of Object.keys(t)) {
    if (!/^gtfs:stop_name(?::|$)/.test(k)) continue;
    setList(t, k, splitTag(t[k]).filter((v) => v !== t.name));
  }
  if (road && !t.railway) t.highway ??= way ? "platform" : "bus_stop";
  return t;
}

/** Is this object a "stop" or a "platform"? Its tag and its role, when they agree. Otherwise, or without a tag, where it is: on the road, a stop_position, beside it, a platform.
 * A way is always a platform. roles: {stop, platform}, those it has in the relations. */
export function stopKind(key, tags, roles, road) {
  if (key[0] === "w") return "platform";
  if (tags.public_transport === "stop_position" && roles.stop) return "stop";
  if (tags.public_transport === "platform" && roles.platform) return "platform";
  return road ? "stop" : "platform";
}

/** The platforms each stop_position goes with in these relations [[key, {members}]]: the first one after it, before the next stop_position, else the one before. */
function platformsOfStops(routes, kinds) {
  const out = new Map();
  for (const [, { members }] of routes) {
    const stops = members.map(([ref]) => [ref, kinds.get(ref)]).filter(([, kind]) => kind);
    stops.forEach(([ref, kind], i) => {
      if (kind !== "stop") return;
      const [next, previous] = [stops[i + 1], stops[i - 1]];
      const platform = next?.[1] === "platform" ? next[0] : previous?.[1] === "platform" ? previous[0] : null;
      if (platform) setIn(out, ref).add(platform);
    });
  }
  return out;
}

/** {name, official_name, places} of each stop, by key. A long network takes a while: Nominatim is asked at most once per second. */
async function nameAll(objects, lang, onProgress) {
  const seen = new Map(), out = new Map();
  const entries = [...objects].filter(([, o]) => o.tags.name && osmPosition(o));
  for (const [i, [key, o]] of entries.entries()) {
    onProgress(`Towns of the stops (Nominatim): ${i + 1} of ${entries.length}…`);
    const name = cleanStopName(o.tags.name), pos = osmPosition(o);
    const official = o.tags.official_name && stopKey(cleanStopName(o.tags.official_name)) === stopKey(name) ? cleanStopName(o.tags.official_name) : null;
    const nearby = seen.get(stopKey(name)) ?? [];
    let found = nearby.find((p) => dist(p.pos, pos) <= SAME_PLACE_M);
    if (!found) {
      found = { pos, places: await lookup.placesAt(pos[0], pos[1], lang) };
      seen.set(stopKey(name), [...nearby, found]);
    }
    const names = await stopNames(found.places, official ?? name, (place) => lookup.placeNear(place, pos[0], pos[1]), lookup.isDelegated);
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
  const relations = await routesIn(zonesAround(stops.map(latlon), PAD_M), settings.modes);
  const osmName = networkFromOsm(network, lines, relations);
  const wanted = new Set([nameKey(network), ...(osmName ? [nameKey(osmName)] : [])]);
  const ofNetwork = (tags) => networksOf(tags).some((n) => wanted.has(n));
  const routes = Object.entries(relations).filter(([, o]) => o.tags.route && ofNetwork(o.tags));
  if (!routes.length) throw new Error(`No route relation of "${unique([network, osmName].filter(Boolean)).join('" or "')}" in OSM here: nothing to correct.`);

  const roles = new Map(), roadStops = new Set(), vehicles = new Map();
  for (const [, { tags, members }] of routes) {
    for (const [ref, role] of members) {
      if (ref[0] === "r" || !/^(?:platform|stop)/.test(role)) continue;
      if (!roles.has(ref)) roles.set(ref, { stop: false, platform: false });
      roles.get(ref)[role.startsWith("stop") ? "stop" : "platform"] = true;
      setIn(vehicles, ref);
      if (tags.route in VEHICLE) {
        roadStops.add(ref);
        vehicles.get(ref).add(VEHICLE[tags.route]);
        if (tags.route === "coach") vehicles.get(ref).add("coach");
      }
    }
  }
  onProgress(`The ${roles.size} stops of the network (Overpass)…`);
  const objects = new Map(Object.entries(await readObjects(roles.keys())).filter(([key]) => roles.has(key)));
  const lang = await feed.language();
  const names = await nameAll(objects, lang, onProgress);

  onProgress("Stop_positions and platforms (Overpass)…");
  const agrees = (key, { tags }) => (tags.public_transport === "stop_position" && roles.get(key).stop) || (tags.public_transport === "platform" && roles.get(key).platform);
  const unsure = [...objects].filter(([key, o]) => key[0] === "n" && !agrees(key, o)).map(([key]) => key);
  let road = null;
  try {
    road = await onRoad(unsure);
  } catch (e) {
    if (e.name === "AbortError") throw e;
    log.warn(`Ways of the stops not available (${e.message}): those tagged differently from their role are left as they are`);
  }
  const kinds = new Map();
  for (const [key, o] of objects) {
    if (!road && !agrees(key, o)) continue;
    kinds.set(key, stopKind(key, o.tags, roles.get(key), road?.has(key)));
  }

  onProgress("Correcting…");
  const obj = new Store(Object.fromEntries(objects));
  const renames = new Map();
  for (const [key, o] of objects) if (names.has(key)) renames.set(o.tags.name, names.get(key).name);
  const platformsOf = platformsOfStops(routes, kinds);
  const corrected = new Map();
  const nameOfPlatform = (key) => [...(platformsOf.get(key) ?? [])].map((p) => names.get(p)?.name).find(Boolean);
  for (const [key, o] of objects) {
    if (kinds.get(key) === "platform") corrected.set(key, correctedPlatform(o.tags, names.get(key), { road: roadStops.has(key), way: key[0] === "w", bus: vehicles.get(key).has("bus") }));
  }
  for (const [key, o] of objects) {
    if (kinds.get(key) !== "stop") continue;
    const { tags, moved } = stopPositionOnly(o.tags, names.get(key)?.name ?? nameOfPlatform(key), [...vehicles.get(key)]);
    corrected.set(key, tags);
    const own = platformsOf.get(key) ?? new Set();
    for (const p of own) if (corrected.has(p)) takeFromStopPosition(corrected.get(p), moved, own.size === 1);
    const lost = own.size ? [] : Object.keys(moved);
    if (lost.length) log.warn(`${key}: stop_position without a platform in its relations, ${lost.join(", ")} dropped (to check)`);
  }
  let nStops = 0, nKinds = 0;
  for (const [key, tags] of corrected) {
    const o = objects.get(key);
    if (!differsFromOsm({ ...o, tags }, o)) continue;
    if (o.tags.public_transport && o.tags.public_transport !== tags.public_transport) {
      nKinds++;
      log.info(`${key}: public_transport=${o.tags.public_transport} -> ${tags.public_transport}, from where it stands`);
    }
    if (o.tags.name !== tags.name || o.tags.official_name !== tags.official_name) log.info(`${key}: ${o.tags.name} -> ${tags.name}${tags.official_name ? ` (${tags.official_name})` : ""}`);
    obj.set(key, { ...o, tags });
    nStops++;
  }
  const unnamed = [...objects.keys()].filter((key) => !corrected.get(key)?.name);
  if (unnamed.length) log.warn(`${unnamed.length} stop(s) without a name, or without a position, left without one (to check): ${unnamed.slice(0, 30).join(", ")}`);

  // the role of a member follows the kind of the object
  let nRoles = 0;
  const withRoles = (members) => members.map(([ref, role]) => {
    const kind = kinds.get(ref);
    if (!kind || !/^(?:platform|stop)/.test(role) || role.startsWith(kind)) return [ref, role];
    nRoles++;
    log.info(`${ref}: role ${role} -> ${role.replace(/^(?:platform|stop)/, kind)}`);
    return [ref, role.replace(/^(?:platform|stop)/, kind)];
  });
  for (const route of routes) route[1] = { ...route[1], members: withRoles(route[1].members) };

  // one platform per stop: an area next to the node of the same platform leaves the relation, the node stays
  const drawnTwice = twinsOf(Object.fromEntries(objects));
  const samePlatform = (area, node) => {
    if (drawnTwice.get(area) === node) return true;
    const [a, n] = [objects.get(area), objects.get(node)];
    return Boolean(a && n && a.tags.name && stopKey(a.tags.name) === stopKey(n.tags.name ?? "") && osmPosition(a) && dist(osmPosition(a), latlon(n)) <= settings.thresholds.platform_m);
  };
  let nAreas = 0;
  const withoutAreas = (key, members) => members.filter(([ref, role], i) => {
    if (ref[0] !== "w" || kinds.get(ref) !== "platform" || !role.startsWith("platform")) return true;
    const node = [members[i - 1], members[i + 1]].find((m) => m && m[0][0] === "n" && m[1].startsWith("platform") && kinds.get(m[0]) === "platform" && samePlatform(ref, m[0]));
    if (!node) return true;
    nAreas++;
    log.info(`${key}: area ${ref} removed, the node ${node[0]} of the same platform stays`);
    return false;
  });
  for (const route of routes) route[1] = { ...route[1], members: withoutAreas(route[0], route[1].members) };

  const set = (key, o, tags) => {
    if (!differsFromOsm({ ...o, tags }, relations[key])) return false;
    if (tags.name !== o.tags.name) log.info(`${key}: ${o.tags.name ?? "(no name)"} -> ${tags.name}`);
    obj.update(key, relations[key], { ...o, tags });
    return true;
  };
  const endpoints = new Map();
  let nRoutes = 0;
  const skipped = [], trips = [];
  for (const [key, o] of routes) {
    const ordered = (role) => o.members.filter(([ref, r]) => r.startsWith(role) && names.has(ref)).map(([ref]) => names.get(ref));
    const platforms = ordered("platform");
    const members = platforms.length >= 2 ? platforms : ordered("stop");
    if (members.length < 2) {
      skipped.push(key);
      continue;
    }
    const [from, to] = [members[0], members.at(-1)].map(stopLabel);
    endpoints.set(key, [from, to]);
    trips.push({ key, o, members, from, to, prefix: prefixOf(o.tags, o.tags.route) });
  }
  // relations of one line sharing their termini are told apart like the variants of a line generated; alone, a relation keeps what it had
  const sameTitle = new Map();
  for (const trip of trips) listIn(sameTitle, [trip.o.tags.route, trip.prefix, trip.o.tags.ref, trip.from, trip.to].join("\u0001")).push(trip);
  for (const group of sameTitle.values()) {
    const chosen = group.length > 1 ? chooseVias(group.map((trip) => dedupe(trip.members.map(stopLabel)))) : null;
    group.forEach((trip, k) => {
      const { key, o, members, from, to, prefix } = trip;
      const vias = chosen ? chosen[k].map((label) => members.find((s) => stopLabel(s) === label).name) : viasOf(o.tags, renames);
      const labels = chosen ? chosen[k] : vias.map((v) => stopLabel(members.find((s) => s.name === v) ?? { name: v }));
      const { via, ...others } = o.tags;
      const hasVia = chosen ? vias.length > 0 : via !== undefined;
      const tags = { ...others, name: tripTitle(prefix, o.tags.ref, from, to, labels), from: members[0].name, to: members.at(-1).name, ...(hasVia ? { via: unique(vias).join(";") } : {}) };
      if (set(key, o, tags)) nRoutes++;
    });
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

  if (!changesOsm(obj)) throw new Error(`Nothing to correct: the ${roles.size} stops and ${routes.length} route relations of "${network}" are already in this form.`);
  await completeWayNodes(obj);
  log.info(`Network ${network}: ${nStops} of ${roles.size} stops corrected, ${nKinds} of them platform <-> stop_position, ${nRoles} role(s) put right, ${nAreas} area(s) beside the node of their platform removed, ${nRoutes} of ${routes.length} route relations and ${nMasters} route_masters corrected`);
  return { xml: writeOsm(obj), filename: `${slug(network)}_correction.osm`, summary: { "corrected stops": nStops, "corrected roles": nRoles, "corrected routes": nRoutes, "corrected route_masters": nMasters },
    detected: osmName && nameKey(osmName) !== nameKey(network) ? [["Network in OSM", osmName]] : [] };
}
