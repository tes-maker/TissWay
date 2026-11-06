// Add, remove or change one operator on a line already mapped: its route and route_master relations, its platforms, its stop_positions, as chosen.
// Only the operator tag changes: the other tags are written as OSM has them, without the form of this site, and an object with nothing to change stays out of the file.
// Nothing is sent: the file is reviewed in JOSM.
//
// A stop belongs to every line calling at it, whatever their mode: what this line loses must not be taken from the others.
// - an operator another line of the stop has (on its route, or on its route_master) stays on the stop;
// - next to another line without any operator, nothing says whose it is: it stays too, reported to check;
// - a new operator is added next to what stays: the operators of the other lines are never replaced.
// On a platform shared by several networks, operator=a;b follows network=a;b: an operator changed keeps its place, one added comes first when the network of the line does, else last.

import { networkFromOsm } from "./detect.js";
import { ExistingRoutes } from "./existing.js";
import { bbox, latlon } from "./geo.js";
import { nameKey, slug } from "./naming.js";
import { Store, completeWayNodes, readObjects, relationsOfStops, routesIn, writeOsm } from "./osm.js";
import { settings } from "./settings.js";
import { listIn, log, splitTag, unique } from "./util.js";

const PAD_M = 300;


/** "platform" or "stop": what the object is tagged as, a way being a platform, else the role it has in the line. */
const kindOf = (key, tags, role) => (key[0] === "w" || tags.public_transport === "platform" ? "platform" : tags.public_transport === "stop_position" ? "stop" : role);
const stopCount = (n) => `${n} stop${n === 1 ? "" : "s"}`;

/** The value of operator with these operators removed and added: in the place of the first one removed, else at the start if first, else at the end. undefined when none is left.
 * As it is, spelling included, when nothing changes. */
export function withOperators(value, { add = [], remove = [], first = false } = {}) {
  const current = splitTag(value);
  const fresh = add.filter((v) => !current.includes(v));
  const at = current.findIndex((v) => remove.includes(v));
  if (at < 0 && !fresh.length) return value;
  const kept = (list) => list.filter((v) => !remove.includes(v));
  const list = at >= 0 ? [...kept(current.slice(0, at)), ...fresh, ...kept(current.slice(at))] : first ? [...fresh, ...current] : [...current, ...fresh];
  return list.length ? list.join(";") : undefined;
}

/** {route relations, route_masters} of the line in OSM, keys of relations. */
function relationsOfLine(relations, line, names) {
  const existing = new ExistingRoutes(relations);
  const routes = unique(names.flatMap((name) => existing.candidates(line.mode, line.route_short_name, name, line.route_id)));
  const masters = new Set(routes.flatMap((k) => existing.parents.get(k) ?? []));
  for (const [k, o] of Object.entries(existing.masters)) {
    if (names.some((name) => ExistingRoutes.sameLine(o.tags, "route_master", line.mode, line.route_short_name, name, line.route_id))) masters.add(k);
  }
  return { routes, masters: [...masters] };
}

/** The other lines of each stop: stop key -> [Set of the operators of a route relation that is not one of own, on it or on its route_masters]. */
function otherLinesOfStops(relations, own) {
  const ofMasters = new Map();
  for (const { tags, members } of Object.values(relations)) {
    if (!tags.route_master) continue;
    for (const [ref] of members) listIn(ofMasters, ref).push(...splitTag(tags.operator));
  }
  const out = new Map();
  for (const [key, { tags, members }] of Object.entries(relations)) {
    if (own.has(key) || !tags.route) continue;
    const operators = new Set([...splitTag(tags.operator), ...(ofMasters.get(key) ?? [])]);
    for (const [ref, role] of members) {
      if (/^(?:platform|stop)/.test(role)) listIn(out, ref).push(operators);
    }
  }
  return out;
}

/** Of the operators to remove from a stop, those it has to keep for its other lines (Sets of operators): {used: another line has it, unsure: a line without an operator may have it}. */
export function heldByOthers(present, lines = []) {
  const used = present.filter((v) => lines.some((operators) => operators.has(v)));
  const unsure = lines.some((operators) => !operators.size) ? present.filter((v) => !used.includes(v)) : [];
  return { used, unsure };
}

const ofChosen = (label, chosen, changed, total) => (chosen && total ? { [label]: `${changed} of ${total}` } : {});

/** {xml, filename, summary}: the objects of the line whose operator changes. summary: how many of those chosen changed, each stop counted once, as what it is tagged. action: "add" or "remove" operator, or "change" it to newOperator. targets: {routes, platforms, stops}. Error if there is nothing to change. */
export async function runOperatorEdit(feed, { network, routeId, operator, newOperator = "", action, targets, onProgress = () => {} }) {
  const named = splitTag(operator), replacing = splitTag(newOperator);
  if (!named.length) throw new Error("Enter an operator.");
  if (action === "change" && !replacing.length) throw new Error("Enter the new operator.");
  const added = action === "add" ? named : action === "change" ? replacing : [];
  const removed = action === "add" ? [] : named.filter((v) => !added.includes(v));
  if (action === "change" && !removed.length && added.every((v) => named.includes(v))) throw new Error(`${named.join(";")} is both the current and the new operator.`);
  const line = (await feed.routes()).find((r) => r.route_id === routeId);
  if (!line) throw new Error(`Unknown line "${routeId}".`);
  const label = line.route_short_name || line.route_long_name || routeId;

  onProgress("GTFS stops of the line…");
  const trips = new Set((await feed.trips()).filter((t) => t.route_id === routeId).map((t) => t.trip_id));
  const stopIds = new Set((await feed.stopTimes(trips)).map((s) => s.stop_id));
  const stops = (await feed.stops()).filter((s) => stopIds.has(s.stop_id));
  if (!stops.length) throw new Error(`No stop for line ${label}.`);

  onProgress("Relations of the line (Overpass)…");
  const relations = await routesIn(bbox(stops.map(latlon), PAD_M), settings.modes);
  const osmName = networkFromOsm(network, [line], relations);
  const names = [network, ...(osmName ? [osmName] : [])];
  const { routes, masters } = relationsOfLine(relations, line, names);
  if (!routes.length && !masters.length) throw new Error(`Line ${label} of ${network} is not in OSM: nothing to change. Convert it first.`);

  const roles = new Map();
  for (const key of routes) {
    for (const [ref, role] of relations[key].members) {
      if (ref[0] === "r") continue;
      const kind = /^(platform|stop)/.exec(role)?.[1];
      if (kind && !roles.has(ref)) roles.set(ref, kind);
    }
  }
  const anyStop = targets.platforms || targets.stops;
  onProgress(`The ${roles.size} stops of the line (Overpass)…`);
  const objects = anyStop ? await readObjects(roles.keys()) : {};
  const missing = anyStop ? [...roles.keys()].filter((key) => !objects[key]) : [];
  if (missing.length) log.warn(`${stopCount(missing.length)} of the relations not found in OSM, left out: ${missing.join(", ")}`);
  const kinds = new Map([...roles.keys()].filter((key) => objects[key]).map((key) => [key, kindOf(key, objects[key].tags, roles.get(key))]));
  const stopKeys = [...kinds.keys()].filter((key) => (kinds.get(key) === "platform" ? targets.platforms : targets.stops));

  // what the other lines hold is read from the stops themselves: every line calling at them, not only those around the GTFS stops or of the modes generated
  const readOthers = removed.length && stopKeys.length;
  if (readOthers) onProgress("Other lines of the stops (Overpass)…");
  const others = readOthers ? otherLinesOfStops(await relationsOfStops(stopKeys), new Set(routes)) : new Map();

  const obj = new Store();
  const wanted = new Set(names.map(nameKey));
  const count = { routes: 0, masters: 0, platforms: 0, stops: 0 };
  const put = (key, o, counted, options) => {
    const old = o.tags.operator, value = withOperators(old, options);
    if (value === old) return;
    const { operator, ...others } = o.osmTags ?? o.tags; // as OSM has them: the GTFS ids a reading cleans stay as they are
    obj.set(key, { ...o, tags: value === undefined ? others : { ...o.osmTags ?? o.tags, operator: value } });
    log.info(`${key}: operator ${old ?? "(none)"} -> ${value ?? "(none)"}`);
    count[counted]++;
  };

  if (targets.routes) {
    for (const key of routes) put(key, relations[key], "routes", { add: added, remove: removed });
    for (const key of masters) put(key, relations[key], "masters", { add: added, remove: removed });
  }

  const kept = [], toCheck = [];
  for (const key of stopKeys) {
    const o = objects[key], { tags } = o, isPlatform = kinds.get(key) === "platform", nets = splitTag(tags.network);
    const { used, unsure } = heldByOthers(removed.filter((v) => splitTag(tags.operator).includes(v)), others.get(key));
    const report = (list, values) => { if (values.length) list.push(`${tags.name || key} (${key}): ${values.join(";")}`); };
    report(kept, used);
    report(toCheck, unsure);
    const first = isPlatform && nets.length > 1 && wanted.has(nameKey(nets[0]));
    const remove = removed.filter((v) => !used.includes(v) && !unsure.includes(v));
    put(key, o, isPlatform ? "platforms" : "stops", { add: added, remove, first });
  }
  if (kept.length) log.info(`Operator kept on ${stopCount(kept.length)} used by another line with this operator: ${kept.join(", ")}`);
  if (toCheck.length) log.warn(`Operator kept on ${stopCount(toCheck.length)} also used by a line without an operator, to check: ${toCheck.join(", ")}`);

  if (!obj.modified.size) {
    const why = kept.length || toCheck.length ? `the stops keep it for other lines` : added.length && !removed.length ? `line ${label} already has ${added.join(";")} on what was chosen` : `${removed.join(";")} is not on what was chosen of line ${label}`;
    throw new Error(`Nothing to ${action}: ${why}.`);
  }
  await completeWayNodes(obj);
  log.info(`Line ${label}: operator ${action === "change" ? `${named.join(";")} changed to ${added.join(";")} on` : `${named.join(";")} ${action === "remove" ? "removed from" : "added to"}`} ${obj.modified.size} object(s)`);
  return { xml: writeOsm(obj, { asIs: true }), filename: `${slug(network)}_${slug(String(label))}_operator.osm`,
    summary: {
      ...ofChosen("Routes changed", targets.routes, count.routes, routes.length),
      ...ofChosen("Route_masters changed", targets.routes, count.masters, masters.length),
      ...ofChosen("Platforms changed", targets.platforms, count.platforms, stopKeys.filter((key) => kinds.get(key) === "platform").length),
      ...ofChosen("Stop_positions changed", targets.stops, count.stops, stopKeys.filter((key) => kinds.get(key) === "stop").length),
      ...(kept.length ? { "Kept for another line": stopCount(kept.length) } : {}),
      ...(toCheck.length ? { "To check": stopCount(toCheck.length) } : {}),
    } };
}
