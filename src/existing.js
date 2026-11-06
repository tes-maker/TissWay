// Existing OSM route relations: a line already mapped is updated in place rather than duplicated.
//
// For each line:
// - candidates: existing route relations of the same mode whose gtfs:route_id* is the GTFS route_id, or whose ref is the
//   line's ref and whose network, if any, is one of the line's;
// - each generated variant is paired with its most similar candidate, one to one, best pairs first (see similarity).
//   Pairs scoring below settings.existing_min_similarity are not made;
// - a paired relation keeps its id, its history and the tags this tool does not manage: its members are replaced by the
//   generated ones, the generated tags are written over its own, stale GTFS references are removed;
// - the route_master: the existing one containing a paired relation, else one with the same mode, ref and network. It
//   keeps its id and its other members; the generated relations are added to it.
// Existing relations of the line left unpaired are never deleted: they are reported, to check in JOSM.
//
// The network:wikidata / network:wikipedia of a network are taken from its existing relations when they agree (networkWikis),
// so that platforms and relations all carry them.

import { activeFeed, settings } from "./settings.js";
import { listIn, splitTag } from "./util.js";

/** gtfs:* tag key, suffixed with the feed id when there is one ("gtfs:route_id:DE-BY-MVV"). */
export const feedKey = (key) => (activeFeed() ? `${key}:${activeFeed()}` : key);

const values = (tags, prefix) => new Set(Object.entries(tags).filter(([k]) => k.startsWith(prefix))
  .flatMap(([, v]) => splitTag(v)));

const norm = (value) => (value || "").trim().split(/\s+/).join(" ").toLowerCase();

/** Member keys whose role starts with one of kinds ("" = travelled ways), in order, without repeats. */
function memberRefs(members, kinds) {
  const out = new Set();
  for (const [ref, role] of members) {
    const kind = ref[0] === "w" && ["", "forward", "backward"].includes(role) ? "" : role.split("_")[0];
    if (kinds.includes(kind)) out.add(ref);
  }
  return [...out];
}

function jaccard(a, b) {
  const sa = new Set(a), sb = new Set(b);
  const inter = [...sa].filter((x) => sb.has(x)).length, union = new Set([...sa, ...sb]).size;
  return union ? inter / union : 0;
}

/** Do the members shared by two ordered lists come in the same order (not the other direction)? */
export function sameDirection(ours, theirs) {
  const first = new Map();
  theirs.forEach((m, i) => { if (!first.has(m)) first.set(m, i); });
  const seq = ours.filter((m) => first.has(m)).map((m) => first.get(m));
  let fwd = 0, back = 0;
  for (let i = 1; i < seq.length; i++) {
    if (seq[i] > seq[i - 1]) fwd++;
    if (seq[i] < seq[i - 1]) back++;
  }
  return fwd >= back;
}

/** Similarity (0..1) of a generated route relation (members, tags) with an existing one. 1 when the existing relation
 * carries the same sample trip or shape id. Otherwise the share of common platforms (stop_positions when either has no
 * platform) weighs 0.7 and the share of common ways 0.3 (Jaccard indices); 0 when the shared members come in reverse order
 * (the other direction). */
export function similarity(members, tags, existing) {
  const theirs = existing.tags;
  const refs = new Set([...values(theirs, "gtfs:shape_id"), ...values(theirs, "gtfs:trip_id"), ...values(theirs, "ref_trips")]);
  const ours = [tags[feedKey("gtfs:shape_id")], tags[feedKey("gtfs:trip_id:sample")]].filter(Boolean).flatMap((v) => v.split(";"));
  if (ours.some((x) => refs.has(x))) return 1;
  let stopsA = memberRefs(members, ["platform"]), stopsB = memberRefs(existing.members, ["platform"]);
  if (!stopsA.length || !stopsB.length) [stopsA, stopsB] = [memberRefs(members, ["stop"]), memberRefs(existing.members, ["stop"])];
  const waysA = memberRefs(members, [""]), waysB = memberRefs(existing.members, [""]);
  const setB = new Set(stopsB);
  const shared = new Set(stopsA.filter((s) => setB.has(s))).size;
  if (!(shared >= 2 ? sameDirection(stopsA, stopsB) : sameDirection(waysA, waysB))) return 0;
  if (!stopsA.length || !stopsB.length) return jaccard(waysA, waysB);
  return 0.7 * jaccard(stopsA, stopsB) + 0.3 * jaccard(waysA, waysB);
}

/** With a feed suffix, keys left without one: PTNA reports the mix as an error on the relation ("Mixed use of GTFS keys"). */
const UNSUFFIXED = /^gtfs:(?:feed|release_date|route_id|shape_id|trip_id(?::sample|:like)?)$/;

/** Tags of an updated relation: the existing ones, without what the generation replaces (stale GTFS references, via and roundtrip
 * of another itinerary), under the generated ones. */
export function mergeTags(old, fresh) {
  const stale = new Set([feedKey("gtfs:shape_id"), feedKey("gtfs:trip_id:sample"), "via", "roundtrip"]);
  const keep = ([k]) => !stale.has(k) && !(activeFeed() && UNSUFFIXED.test(k));
  return { ...Object.fromEntries(Object.entries(old).filter(keep)), ...fresh };
}

export const WIKI_KEYS = ["network:wikidata", "network:wikipedia"];
const WIKI_MIN_RELATIONS = 3; // existing relations agreeing on a value before it is used

/** network -> {network:wikidata, network:wikipedia} of the existing route relations and route masters with that network
 * tag. A value is kept only when every relation carrying the key agrees on it, and at least WIKI_MIN_RELATIONS do: mapped
 * by the community, not guessed. */
export function networkWikis(relations) {
  const seen = {};
  for (const { tags } of Object.values(relations)) {
    if (!tags.network || !["route", "route_master"].includes(tags.type)) continue;
    for (const key of WIKI_KEYS) {
      if (tags[key]) ((seen[tags.network] ??= {})[key] ??= []).push(tags[key]);
    }
  }
  const out = {};
  for (const [network, byKey] of Object.entries(seen)) {
    out[network] = {};
    for (const [key, vals] of Object.entries(byKey)) {
      if (vals.length >= WIKI_MIN_RELATIONS && new Set(vals).size === 1) out[network][key] = vals[0];
    }
  }
  return out;
}

/** Route relations and route masters read from OSM, and those already claimed by a generated line. */
export class ExistingRoutes {
  constructor(relations) {
    const pick = (type) => Object.fromEntries(Object.entries(relations).filter(([, o]) => o.tags.type === type));
    this.routes = pick("route");
    this.masters = pick("route_master");
    this.parents = new Map(); // route relation -> route masters containing it
    for (const [k, o] of Object.entries(this.masters)) {
      for (const [ref] of o.members) {
        listIn(this.parents, ref).push(k);
      }
    }
    this.claimed = new Set();
    this.wikis = networkWikis(relations);
  }

  static sameLine(tags, modeKey, mode, ref, network, routeId) {
    if (tags[modeKey] !== mode) return false;
    if (routeId && values(tags, "gtfs:route_id").has(routeId)) return true;
    const theirs = Object.entries(tags)
      .filter(([k]) => k === "network" || (k.startsWith("network:") && /^\d+$/.test(k.split(":").at(-1))))
      .flatMap(([, v]) => v.split(";").map(norm));
    return Boolean(ref) && norm(tags.ref) === norm(ref) && (!theirs.length || theirs.includes(norm(network)));
  }

  /** gtfs:route_id of a route_master: the id of this line, after those it holds already that are still in the feed (feedRouteIds). */
  masterRouteIds(old, id) {
    const held = (old?.tags[feedKey("gtfs:route_id")] ?? "").split(";").map((v) => v.trim()).filter((v) => this.feedRouteIds?.has(v));
    return joinIds([...held, id]);
  }

  /** Unclaimed existing route relations of the line. */
  candidates(mode, ref, network, routeId) {
    return Object.keys(this.routes).filter((k) => !this.claimed.has(k)
      && ExistingRoutes.sameLine(this.routes[k].tags, "route", mode, ref, network, routeId));
  }

  /** Existing route relations with the same mode and ref in another network that follow one of the drafts closely (the
   * line may be tagged with another network in OSM): reported, never updated. */
  otherNetworks(mode, ref, network, drafts) {
    if (!ref) return [];
    return Object.entries(this.routes).filter(([k, o]) => {
      const t = o.tags;
      return !this.claimed.has(k) && t.route === mode && norm(t.ref) === norm(ref) && norm(t.network) !== "" && norm(t.network) !== norm(network)
        && Math.max(...drafts.map(([m, tg]) => similarity(m, tg, o))) >= settings.existing_min_similarity;
    }).map(([k]) => k);
  }

  /** Map index of a draft -> existing relation for the generated relations drafts [[members, tags]], one to one, best pairs
   * first; the paired relations are claimed. preset: relation already decided for some drafts, by index. */
  pair(drafts, candidates, preset = []) {
    const paired = new Map();
    for (const [i, k] of preset.entries()) {
      if (!k) continue;
      paired.set(i, k);
      this.claimed.add(k);
    }
    const scores = drafts.flatMap(([m, t], i) => candidates.map((k) => [similarity(m, t, this.routes[k]), i, k]));
    scores.sort((a, b) => b[0] - a[0] || b[1] - a[1] || (a[2] < b[2] ? 1 : a[2] > b[2] ? -1 : 0));
    for (const [score, i, k] of scores) {
      if (score < settings.existing_min_similarity) break;
      if (!paired.has(i) && !this.claimed.has(k)) {
        paired.set(i, k);
        this.claimed.add(k);
      }
    }
    return paired;
  }

  /** Existing route_master of the line, or null: the one containing most of the paired relations, else one with the same
   * mode, ref and network. It is claimed. */
  master(mode, ref, network, routeId, paired) {
    const counts = new Map();
    for (const k of paired) for (const m of this.parents.get(k) || []) counts.set(m, (counts.get(m) || 0) + 1);
    let found = [...counts].sort((a, b) => b[1] - a[1]).map(([m]) => m).filter((m) => !this.claimed.has(m));
    if (!found.length) {
      found = Object.keys(this.masters).filter((k) => !this.claimed.has(k)
        && ExistingRoutes.sameLine(this.masters[k].tags, "route_master", mode, ref, network, routeId));
    }
    if (!found.length) return null;
    this.claimed.add(found[0]);
    return found[0];
  }
}

const TAG_LIMIT = 255; // characters in an OSM tag value

/** Several GTFS ids in one tag, separated by ";", as far as OSM allows. */
export function joinIds(ids) {
  let out = "";
  for (const id of new Set(ids)) {
    if (out && out.length + id.length + 1 > TAG_LIMIT) break;
    out += (out ? ";" : "") + id;
  }
  return out;
}

/** Existing relation old with the generated members and tags. */
export const updatedRelation = (old, members, tags) => ({ version: old.version, members, tags: mergeTags(old.tags, tags) });

/** Existing route_master old with the generated route relations added (its other members kept). */
export function updatedMaster(old, routeKeys, tags) {
  const present = new Set(old.members.map(([ref]) => ref));
  const members = [...old.members, ...routeKeys.filter((k) => !present.has(k)).map((k) => [k, ""])];
  return { version: old.version, members, tags: mergeTags(old.tags, tags) };
}
