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
import { log } from "./util.js";

const PAD_M = 300;

const split = (value) => (value ?? "").split(";").map((v) => v.trim()).filter(Boolean);
const tagsOf = (o) => o.osmTags ?? o.tags;

/** The value of operator with these operators removed and added: in the place of the first one removed, else at the start if first, else at the end. undefined when none is left.
 * As it is, spelling included, when nothing changes. */
export function withOperators(value, { add = [], remove = [], first = false } = {}) {
  const current = split(value);
  const fresh = add.filter((v) => !current.includes(v));
  const at = current.findIndex((v) => remove.includes(v));
  if (at < 0 && !fresh.length) return value;
  const kept = (list) => list.filter((v) => !remove.includes(v));
  const list = at >= 0 ? [...kept(current.slice(0, at)), ...fresh, ...kept(current.slice(at))] : first ? [...fresh, ...current] : [...current, ...fresh];
  return list.length ? list.join(";") : undefined;
}

/** The tags with this value of operator, the same object if it does not change. */
function setOperator(tags, value) {
  if (tags.operator === value) return tags;
  const out = { ...tags };
  if (value === undefined) delete out.operator;
  else out.operator = value;
  return out;
}

/** {route relations, route_masters} of the line in OSM, keys of relations. */
function relationsOfLine(relations, line, names) {
  const existing = new ExistingRoutes(relations);
  const routes = [...new Set(names.flatMap((name) => existing.candidates(line.mode, line.route_short_name, name, line.route_id)))];
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
    for (const [ref] of members) ofMasters.set(ref, [...(ofMasters.get(ref) ?? []), ...split(tags.operator)]);
  }
  const out = new Map();
  for (const [key, { tags, members }] of Object.entries(relations)) {
    if (own.has(key) || !tags.route) continue;
    const operators = new Set([...split(tags.operator), ...(ofMasters.get(key) ?? [])]);
    for (const [ref, role] of members) {
      if (!/^(?:platform|stop)/.test(role)) continue;
      if (!out.has(ref)) out.set(ref, []);
      out.get(ref).push(operators);
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

/** {xml, filename, summary}: the objects of the line whose operator changes. action: "add" or "remove" operator, or "change" it to newOperator. targets: {routes, platforms, stops}. Error if there is nothing to change. */
export async function runOperatorEdit(feed, { network, routeId, operator, newOperator = "", action, targets, onProgress = () => {} }) {
  const named = split(operator), replacing = split(newOperator);
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
  const stopKeys = [...roles.keys()].filter((key) => (roles.get(key) === "platform" ? targets.platforms : targets.stops));
  onProgress(`The ${stopKeys.length} stops of the line (Overpass)…`);
  const objects = stopKeys.length ? await readObjects(stopKeys) : {};

  // what the other lines hold is read from the stops themselves: every line calling at them, not only those around the GTFS stops or of the modes generated
  onProgress("Other lines of the stops (Overpass)…");
  const others = removed.length && stopKeys.length ? otherLinesOfStops(await relationsOfStops(stopKeys), new Set(routes)) : new Map();

  const obj = new Store();
  const wanted = new Set(names.map(nameKey));
  const count = { routes: 0, masters: 0, platforms: 0, stops: 0 };
  const put = (key, o, value) => {
    const tags = tagsOf(o), changed = setOperator(tags, value);
    if (changed === tags) return false;
    const { correctedIds, osmTags, center, ...rest } = o;
    obj.set(key, { ...rest, tags: changed });
    log.info(`${key}: operator ${tags.operator ?? "(none)"} -> ${value ?? "(none)"}`);
    return true;
  };

  if (targets.routes) {
    for (const key of routes) if (put(key, relations[key], withOperators(tagsOf(relations[key]).operator, { add: added, remove: removed }))) count.routes++;
    for (const key of masters) if (put(key, relations[key], withOperators(tagsOf(relations[key]).operator, { add: added, remove: removed }))) count.masters++;
  }

  const kept = [], toCheck = [];
  for (const key of stopKeys) {
    const o = objects[key];
    if (!o) continue;
    const tags = tagsOf(o), nets = split(tags.network);
    const { used, unsure } = heldByOthers(removed.filter((v) => split(tags.operator).includes(v)), others.get(key));
    if (used.length) kept.push(`${tags.name || key} (${key}): ${used.join(";")}`);
    if (unsure.length) toCheck.push(`${tags.name || key} (${key}): ${unsure.join(";")}`);
    const first = roles.get(key) === "platform" && nets.length > 1 && wanted.has(nameKey(nets[0]));
    const remove = removed.filter((v) => !used.includes(v) && !unsure.includes(v));
    if (put(key, o, withOperators(tags.operator, { add: added, remove, first }))) count[roles.get(key) === "platform" ? "platforms" : "stops"]++;
  }
  if (kept.length) log.info(`Operator kept on ${kept.length} stop(s) used by another line with this operator: ${kept.join(", ")}`);
  if (toCheck.length) log.warn(`Operator kept on ${toCheck.length} stop(s) also used by a line without an operator, to check: ${toCheck.join(", ")}`);

  if (!obj.modified.size) {
    const why = kept.length || toCheck.length ? `the stops keep it for other lines` : added.length && !removed.length ? `line ${label} already has ${added.join(";")} on what was chosen` : `${removed.join(";")} is not on what was chosen of line ${label}`;
    throw new Error(`Nothing to ${action}: ${why}.`);
  }
  await completeWayNodes(obj);
  log.info(`Line ${label}: operator ${action === "change" ? `${named.join(";")} changed to ${added.join(";")} on` : `${named.join(";")} ${action === "remove" ? "removed from" : "added to"}`} ${obj.modified.size} object(s)`);
  return { xml: writeOsm(obj, { asIs: true }), filename: `${slug(network)}_${slug(String(label))}_operator.osm`,
    summary: { "changed routes": count.routes, "changed route_masters": count.masters, "changed platforms": count.platforms, "changed stop_positions": count.stops, ...(kept.length ? { "stops kept for another line": kept.length } : {}), ...(toCheck.length ? { "stops to check": toCheck.length } : {}) } };
}
