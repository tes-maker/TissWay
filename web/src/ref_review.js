// Review of the refs of the platforms shared by several networks, before the file is downloaded.
//
// Each network has its own ref on a shared platform: the first network in priority holds ref (and network=*), the others ref:<network>.
// A value is known to belong to a network when it is the stop_id, the stop_code or the NeTEx code of one of its GTFS stops near the platform:
// a value in the place of another network is moved to its own place, and what cannot be settled safely is left as it is and reported.
//
// A ref is proposed for removal when the GTFS says it is obsolete: a value of a network of the feed that no stop of the feed has, a ref of a network of the
// feed no longer on the platform, a gtfs:stop_id:<feed> or gtfs:stop_code:<feed> unknown to this feed. Nothing is removed without being asked for: the
// feed may be partial, and a mapper may have had a reason. The refs of the networks outside the feed cannot be judged, they can only be removed by hand.
//
// The review keeps the ref tags detected by the run: changing a setting afterwards resets what a run detected.

import { dist } from "./geo.js";
import { CODE_IN_ID, NETWORK_KEYS, refKeyFor, sizeOf } from "./platforms.js";
import { settings } from "./settings.js";
import { log } from "./util.js";

const split = (value) => (value ?? "").split(";").map((v) => v.trim()).filter(Boolean);
const isPlatform = (t) => t?.public_transport === "platform" || t?.highway === "bus_stop";
const positionOf = (o) => (o.lat !== undefined ? [o.lat, o.lon] : o.center ?? null);

/** Networks of a platform, network=* first. */
export function networksOf(t) {
  const numbered = Object.keys(t).filter((k) => /^network:\d+$/.test(k)).sort((a, b) => Number(a.slice(8)) - Number(b.slice(8)));
  return [...new Set([t.network, ...numbered.map((k) => t[k])].filter(Boolean))];
}

/** Value -> [{network, stop}]: stop_id, stop_code and NeTEx code of the stops called at by a single network. */
function valuesOfStops(stops, ofStop) {
  const known = new Map();
  for (const stop of stops) {
    const networks = ofStop.get(stop.stop_id);
    if (networks?.size !== 1) continue;
    const [network] = networks;
    const values = [stop.stop_id, stop.stop_code, CODE_IN_ID.exec(stop.stop_id)?.[1]].filter(Boolean);
    for (const value of values) {
      if (!known.has(value)) known.set(value, []);
      known.get(value).push({ network, pos: [Number(stop.stop_lat), Number(stop.stop_lon)] });
    }
  }
  return known;
}

/** The ref tags of a network on these tags. */
const slotOf = (t, base, network) => (network === t.network ? base : refKeyFor(base, network));

/** Every value of the feed that a ref can hold, whichever networks call at the stop. */
function feedValues(stops) {
  return new Set(stops.flatMap((stop) => [stop.stop_id, stop.stop_code, CODE_IN_ID.exec(stop.stop_id)?.[1]]).filter(Boolean));
}

/** Put the refs of a platform in the place of their network. */
function placeValues(review, key) {
  const o = review.obj.get(key), t = o.tags, name = t.name || key;
  const pos = positionOf(o);
  const nets = networksOf(t);
  const before = review.obj.base.get(key)?.tags ?? {};
  const ownerOf = (value) => {
    if (!pos) return null;
    const near = (review.known.get(value) ?? []).filter((s) => dist(pos, s.pos) <= review.reach_m);
    const owners = new Set(near.map((s) => s.network));
    if (owners.size !== 1) return null;
    const [owner] = owners;
    return nets.find((n) => owner === n || owner.startsWith(`${n} `)) ?? owner; // the feed may name it longer than OSM: "Nomad Car" for "Nomad"
  };
  for (const base of review.bases) {
    for (const holder of nets) {
      const key_ = slotOf(t, base, holder);
      const current = split(t[key_]);
      const lost = split(before[key_]).filter((v) => !current.includes(v)); // cut from a list "a;b" when the file was read
      const keep = [];
      for (const value of [...current, ...lost]) {
        const owner = ownerOf(value);
        const here = current.includes(value);
        if (!owner || owner === holder) {
          if (here) keep.push(value);
        } else if (!nets.includes(owner)) {
          if (here) {
            keep.push(value);
            review.toCheck.push(`${name} (${key}): ${key_}=${value} belongs to ${owner}, which is not on this platform`);
          }
        } else {
          const target = slotOf(t, base, owner);
          const there = split(t[target]);
          if (there.includes(value)) continue;
          if (there.length) {
            if (here) {
              keep.push(value);
              review.toCheck.push(`${name} (${key}): ${key_}=${value} belongs to ${owner}, but ${target} already holds ${there.join(";")}`);
            }
            continue;
          }
          t[target] = value;
          review.corrected.push(`${name} (${key}): ${value} ${here ? `moved from ${key_}` : "put back"} to ${target}, the place of ${owner}`);
        }
      }
      if (keep.length) t[key_] = keep.join(";");
      else delete t[key_];
    }
  }
}

/** network becomes the owner of the platform: its refs and network tags take the first place, the old owner's go to ref:<old owner> and its number. */
function promote(t, network, bases) {
  const old = t.network;
  const number = Object.keys(t).find((k) => /^network:\d+$/.test(k) && t[k] === network);
  if (!old || !number) return false;
  for (const base of bases) {
    const [mine, theirs] = [t[base], t[refKeyFor(base, network)]];
    delete t[base];
    delete t[refKeyFor(base, network)];
    if (mine !== undefined) t[refKeyFor(base, old)] = mine;
    if (theirs !== undefined) t[base] = theirs;
  }
  const suffix = number.slice("network".length);
  for (const key of NETWORK_KEYS) {
    const [a, b] = [t[key], t[key + suffix]];
    delete t[key];
    delete t[key + suffix];
    if (b !== undefined) t[key] = b;
    if (a !== undefined) t[key + suffix] = a;
  }
  return true;
}

const platformKeys = (obj) => [...obj.modified].filter(([, o]) => isPlatform(o.tags)).map(([key]) => key);

/** The order proposed: the networks of settings.stop_owners in their order, then the fewest stops first, then those holding the most platforms. */
function proposedOrder(networks, sizes, held) {
  const rank = (n) => (settings.stop_owners.includes(n) ? settings.stop_owners.indexOf(n) : Infinity);
  const size = (n) => sizeOf(sizes, n) ?? Infinity;
  return [...networks].sort((a, b) => rank(a) - rank(b) || size(a) - size(b) || (held.get(b) ?? 0) - (held.get(a) ?? 0) || a.localeCompare(b));
}

/** Shared platforms as [{key, name, refs: [[tag, value]]}], in the order of the file. */
export function sharedPlatforms(review) {
  return platformKeys(review.obj).filter((key) => networksOf(review.obj.get(key).tags).length > 1).map((key) => {
    const t = review.obj.get(key).tags;
    const refs = networksOf(t).flatMap((network) => review.bases.map((base) => slotOf(t, base, network)).filter((k) => k in t).map((k) => [k, t[k]]));
    return { key, name: t.name || key, refs };
  });
}

const REF_TAG = /^(?:ref(?::|$)|gtfs:stop_(?:id|code)(?::|$))/;

/** Why this value is obsolete, "" if nothing says so. */
function obsoleteBecause(review, tag, value, network, nets) {
  if (!review.inFeed.size) return "";
  if (tag.startsWith("gtfs:")) return review.feed && tag.endsWith(`:${review.feed}`) && !review.inFeed.has(value) ? "not in this GTFS" : "";
  if (network && !nets.includes(network)) return `${network} is no longer on this stop`;
  const inFeed = network && [...review.feedNetworks].some((n) => n === network || n.startsWith(`${network} `));
  return inFeed && !review.inFeed.has(value) ? `not in the GTFS of ${network}` : "";
}

/** Base and network of a ref tag: "ref:Nomad" is ref for Nomad. A network of the feed may have left the platform. */
function slotInfo(review, t, tag, nets) {
  for (const network of new Set([...nets, ...review.feedNetworks])) {
    for (const base of review.bases) if (tag === slotOf(t, base, network)) return { base, network };
  }
  return { base: null, network: null };
}

/** Refs of the platforms of the file, one row per value: {platform, name, tag, value, base, network, reason}. reason: why it looks obsolete, "" otherwise. */
export function listRefs(review) {
  return platformKeys(review.obj).flatMap((platform) => {
    const t = review.obj.get(platform).tags, nets = networksOf(t);
    return Object.keys(t).filter((tag) => REF_TAG.test(tag)).flatMap((tag) => split(t[tag]).map((value) => {
      const { base, network } = slotInfo(review, t, tag, nets);
      return { platform, name: t.name || platform, tag, value, base, network, reason: obsoleteBecause(review, tag, value, network, nets) };
    }));
  });
}

/** Take this value out of its tag. It stays in review.removed, for restoreRef. */
export function removeRef(review, row) {
  const t = review.obj.get(row.platform).tags;
  const left = split(t[row.tag]).filter((v) => v !== row.value);
  if (left.length) t[row.tag] = left.join(";");
  else delete t[row.tag];
  review.removed.push(row);
  log.info(`Ref removed: ${row.name} (${row.platform}) ${row.tag}=${row.value}`);
}

/** Put a removed value back, in the place of its network if the priority has changed since. */
export function restoreRef(review, row) {
  const t = review.obj.get(row.platform).tags;
  const tag = row.base ? slotOf(t, row.base, row.network) : row.tag;
  t[tag] = [...split(t[tag]), row.value].join(";");
  review.removed = review.removed.filter((r) => r !== row);
  log.info(`Ref restored: ${row.name} (${row.platform}) ${tag}=${row.value}`);
}

/** Apply a priority to the shared platforms: the first of these networks present on each one owns it. Returns the number of platforms changed. */
export function applyPriority(review, order) {
  let changed = 0;
  for (const key of platformKeys(review.obj)) {
    const t = review.obj.get(key).tags;
    const nets = networksOf(t);
    const best = order.find((n) => nets.includes(n));
    if (nets.length > 1 && best && best !== t.network && promote(t, best, [...review.bases, "local_ref"])) changed++;
  }
  review.order = order;
  return changed;
}

/** Correct and review the refs of the platforms of the file: {obj, order, corrected, toCheck, removed}. Without settings.stop_owners, a platform only changes
 * owner when both sizes are known, like during the run (see takesOver).
 * sizes, ofStop: see stopNetworks. stops: the GTFS stops. feed: suffix of the gtfs:* tags. */
export function reviewRefs(obj, { sizes = null, ofStop = new Map(), stops = [], feed = "" } = {}) {
  const review = { obj, feed, removed: [], inFeed: feedValues(stops), feedNetworks: new Set([...ofStop.values()].flatMap((names) => [...names])), known: valuesOfStops(stops, ofStop), bases: ["ref", ...settings.stop_ref_tags], reach_m: settings.thresholds.holder_m,
    corrected: [], toCheck: [], order: [] };
  const keys = platformKeys(obj);
  const networks = new Set(), held = new Map();
  for (const key of keys) {
    const nets = networksOf(obj.get(key).tags);
    if (nets.length > 1) {
      nets.forEach((n) => networks.add(n));
      held.set(nets[0], (held.get(nets[0]) ?? 0) + 1);
    }
    placeValues(review, key);
  }
  review.order = proposedOrder(networks, sizes, held);
  const listed = settings.stop_owners.length > 0;
  const trusted = review.order.filter((n) => listed ? settings.stop_owners.includes(n) : sizeOf(sizes, n) !== undefined);
  for (const key of keys) {
    const t = obj.get(key).tags;
    const nets = networksOf(t);
    if (nets.length < 2 || (!listed && !trusted.includes(t.network))) continue;
    const best = trusted.find((n) => nets.includes(n));
    if (best && best !== t.network && promote(t, best, [...review.bases, "local_ref"])) review.corrected.push(`${t.name || key} (${key}): ref given to ${best}, the first in priority`);
  }
  for (const line of review.corrected) log.info(`Ref corrected: ${line}`);
  for (const line of review.toCheck) log.warn(`Ref to check: ${line}`);
  return review;
}
