// What can be known about a feed from what OpenStreetMap already contains around its lines. All of this can be
// overridden on the Settings page. Each function only reads: the caller decides what to do with the answer.

import { nameKey } from "./naming.js";
import { relationsWithFeedCode } from "./osm.js";
import { CODE_IN_ID } from "./platforms.js";
import { log } from "./util.js";

const MIN_HITS = 3; // objects that must agree before a convention is taken for one

/** Feed code ("FR-NOR-Atoumod") used by OSM relations whose gtfs:route_id:<code> is one of these route_ids, or "". Only route_ids
 * prove it: a stop_id can be shared by several feeds (real case: the platforms of Argentan carry another feed's code), and writing a
 * route_id under the wrong code sends PTNA to the wrong feed. Only what PTNA takes for a code: not a number ("gtfs:route_id:2"). */
export function detectFeed(relations, routeIds) {
  const counts = new Map();
  for (const { tags } of Object.values(relations)) {
    for (const [key, value] of Object.entries(tags)) {
      const code = /^gtfs:route_id:([A-Z][A-Z][a-zA-Z0-9_.-]+)$/.exec(key)?.[1];
      if (code && value.split(";").some((v) => routeIds.has(v.trim()))) counts.set(code, (counts.get(code) || 0) + 1);
    }
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
}

/** Feed code of a whole GTFS: it belongs to the feed, not to the lines at hand. From the relations already read around these lines, else
 * from the OSM relations over the area of the feed (without its few faraway stops). Kept on the feed: asked once. */
export async function feedCodeOf(feed, relations = {}) {
  if (feed.feedCode) return feed.feedCode;
  const ids = new Set((await feed.routes()).map((r) => r.route_id));
  let code = detectFeed(relations, ids);
  if (!code && feed.feedCode === undefined) {
    const stops = await feed.stops();
    const trimmed = (values) => {
      const sorted = [...values].sort((a, b) => a - b), cut = Math.floor(sorted.length / 20);
      return [sorted[cut], sorted[sorted.length - 1 - cut]];
    };
    const [s, n] = trimmed(stops.map((x) => x.lat)), [w, e] = trimmed(stops.map((x) => x.lon));
    try {
      code = detectFeed(await relationsWithFeedCode([s, w, n, e]), ids);
    } catch (err) {
      if (err.name === "AbortError") throw err;
      log.warn(`OSM relations of the feed not available (${err.message})`);
      return ""; // not known: asked again next time
    }
  }
  feed.feedCode = code;
  return code;
}

/** ref:* tags holding the GTFS stop_id on the OSM platforms ("ref:FR:Atoumod"): at least half of their values are stop_ids. */
export function detectStopRefTags(osm, stopIds) {
  const seen = new Map();
  for (const { tags } of Object.values(osm)) {
    for (const [key, value] of Object.entries(tags)) {
      if (!key.startsWith("ref:") || /:\d+$/.test(key)) continue; // ":2": a second network's value, of the same tag
      const c = seen.get(key) ?? { hits: 0, all: 0 };
      c.all++;
      if (value.split(";").some((v) => stopIds.has(v.trim()))) c.hits++;
      seen.set(key, c);
    }
  }
  const found = [...seen].filter(([, c]) => c.hits >= MIN_HITS && c.hits * 2 >= c.all).map(([key]) => key);
  return found.filter((key) => !found.some((other) => key.startsWith(`${other}:`))); // "ref:FR:Atoumod:Nomad" is "ref:FR:Atoumod" for a second network
}

/** network tag used in OSM for the lines of an agency, or null: the relations carrying their route_id, else those with the ref
 * of one of its lines whose network is the agency's name, or its first words ("Nomad" for "Nomad Car"). */
export function networkFromOsm(name, routes, relations) {
  const ids = new Set(routes.map((r) => r.route_id)), refs = new Set(routes.map((r) => r.route_short_name).filter(Boolean));
  const words = nameKey(name).split(" ");
  const compact = words.join(""); // "ArgentanBus" is the "Argentan bus" of OSM
  const byId = new Map(), byName = new Map();
  const add = (map, key) => map.set(key, (map.get(key) || 0) + 1);
  for (const { tags } of Object.values(relations)) {
    if (!tags.network) continue;
    const held = Object.entries(tags).some(([k, v]) => k.startsWith("gtfs:route_id") && v.split(";").some((x) => ids.has(x.trim())));
    if (held) add(byId, tags.network);
    const own = nameKey(tags.network).split(" ");
    if (refs.has(tags.ref) && own[0] && (own.every((w, i) => words[i] === w) || own.join("") === compact)) add(byName, tags.network);
  }
  const top = (map) => [...map].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return top(byId) ?? top(byName);
}
