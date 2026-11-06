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
// With settings.stop_refs_from_gtfs off, the codes of the feed are wrong and those of OSM right: only stop_ids say whose a value is, and no ref is judged by the codes.
//
// Two networks with very close names ("Nomad Car" and "Nomad") may be one network under two names: the window asks, nothing is merged without an answer.
// The answer is kept in settings.network_merges, because each run brings the name of the feed back.
//
// The operators follow the refs: the one of the first network is in operator, those of the others in operator:<network>, which a file writes operator=a;b, in the order of network=a;b.
// So one already mapped goes with the network owning the stop, and moves with it when the priority changes. settings.operator goes in the place of the network of the line converted.
//
// The review keeps the ref tags detected by the run: changing a setting afterwards resets what a run detected.

import { dist } from "./geo.js";
import { unaccent } from "./naming.js";
import { CODE_IN_ID, NETWORK_KEYS, nameNumberedNetworkTags, refKeyFor, refKeyOn, sizeOf } from "./platforms.js";
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

/** Value -> [{network, stop}]: stop_id, stop_code and NeTEx code (only the stop_id with settings.stop_refs_from_gtfs off) of the stops called at by a single network. */
function valuesOfStops(stops, ofStop) {
  const known = new Map();
  for (const stop of stops) {
    const networks = ofStop.get(stop.stop_id);
    if (networks?.size !== 1) continue;
    const [network] = networks;
    const values = [stop.stop_id, ...(settings.stop_refs_from_gtfs ? [stop.stop_code, CODE_IN_ID.exec(stop.stop_id)?.[1]] : [])].filter(Boolean);
    for (const value of values) {
      if (!known.has(value)) known.set(value, []);
      known.get(value).push({ network, pos: [Number(stop.stop_lat), Number(stop.stop_lon)] });
    }
  }
  return known;
}

/** The ref tags of a network on these tags. */
const slotOf = (t, base, network) => (network === t.network ? base : refKeyOn(t, base, network));

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
  nameNumberedNetworkTags(t);
  const old = t.network;
  const number = Object.keys(t).find((k) => /^network:\d+$/.test(k) && t[k] === network);
  if (!old || !number) return false;
  for (const base of bases) {
    const slot = refKeyOn(t, base, network);
    const [mine, theirs] = [t[base], t[slot]];
    delete t[base];
    delete t[slot];
    if (mine !== undefined) t[refKeyFor(base, old)] = mine;
    if (theirs !== undefined) t[base] = theirs;
  }
  for (const key of NETWORK_KEYS.slice(1)) {
    const other = refKeyFor(key, network);
    const [a, b] = [t[key], t[other]];
    delete t[key];
    delete t[other];
    if (b !== undefined) t[key] = b;
    if (a !== undefined) t[refKeyFor(key, old)] = a;
  }
  const suffix = number.slice("network".length);
  t.network = network;
  t[`network${suffix}`] = old;
  return true;
}

/** Words of a network name, case, accents and punctuation ignored. */
const nameWords = (name) => unaccent(name).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** Same name, or the whole of one at the start or at the end of the other: "Nomad" and "Nomad Car". */
export function closeNames(a, b) {
  const [short, long] = [nameWords(a), nameWords(b)].sort((x, y) => x.length - y.length);
  if (!short.length) return false;
  return short.every((w, i) => w === long[i]) || short.every((w, i) => w === long[long.length - short.length + i]);
}

/** Network -> objects of the file that carry it. */
function networkCounts(obj) {
  const counts = new Map();
  for (const { tags } of obj.modified.values()) for (const network of networksOf(tags ?? {})) counts.set(network, (counts.get(network) ?? 0) + 1);
  return counts;
}

/** Pairs of networks of the file that may be one, not answered yet: [{keep, drop, keepCount, dropCount}]. The name kept is the shortest, the one OSM tends to use
 * (see sizeOf), then the most used. */
export function closeNetworks(review) {
  const counts = networkCounts(review.obj);
  const names = [...counts.keys()].sort((a, b) => nameWords(a).length - nameWords(b).length || counts.get(b) - counts.get(a) || a.localeCompare(b));
  return names.flatMap((keep, i) => names.slice(i + 1).filter((drop) => closeNames(keep, drop) && settings.network_merges[drop] !== false && review.decisions[drop] !== false)
    .map((drop) => ({ keep, drop, keepCount: counts.get(keep), dropCount: counts.get(drop) })));
}

/** One object: the name drop becomes keep, its refs and metadata go to the place of keep. A ref that keep already has with another value stays where it is, to check. */
function mergeTags(review, key, keep, drop) {
  const t = review.obj.get(key).tags;
  nameNumberedNetworkTags(t);
  if (!networksOf(t).includes(drop)) return false;
  const both = networksOf(t).includes(keep);
  if (t.network === drop && !both) {
    t.network = keep; // its tags are those of the first place, which it keeps
    return true;
  }
  if (t.network === drop) promote(t, keep, [...review.bases, "local_ref"]);
  const number = Object.keys(t).find((k) => /^network:\d+$/.test(k) && t[k] === drop);
  const suffix = refKeyFor("", drop);
  for (const tag of Object.keys(t).filter((k) => k.endsWith(suffix))) {
    const target = slotOf(t, tag.slice(0, -suffix.length), keep);
    if (tag === target) continue;
    if (t[target] === undefined || t[target] === t[tag]) t[target] = t[tag];
    else if (!tag.startsWith("network:")) {
      review.toCheck.push(`${t.name || key} (${key}): ${tag}=${t[tag]} left in place, ${target} already holds ${t[target]}`);
      continue;
    }
    delete t[tag];
  }
  if (both) {
    delete t[number];
    const numbered = Object.keys(t).filter((k) => /^network:\d+$/.test(k)).sort((a, b) => Number(a.slice(8)) - Number(b.slice(8)));
    const values = numbered.map((k) => t[k]);
    numbered.forEach((k) => delete t[k]);
    values.forEach((value, i) => { t[`network:${i + 2}`] = value; });
  } else t[number] = keep;
  return true;
}

/** Merge drop into keep on every object of the file. Returns the number of objects changed. */
function mergeInFile(review, keep, drop) {
  const changed = [...review.obj.modified.keys()].filter((key) => review.obj.get(key).tags && mergeTags(review, key, keep, drop)).length;
  if (changed) {
    const line = `${drop} merged into ${keep} on ${changed} object${changed === 1 ? "" : "s"}`;
    review.corrected.push(line);
    log.info(`Network merged: ${line}`);
  }
  return changed;
}

/** The answer yes in the window: keep takes the rank of the higher of the two in the priority. */
export function mergeNetworks(review, keep, drop) {
  const changed = mergeInFile(review, keep, drop);
  review.decisions[drop] = keep;
  review.feedNetworks.add(keep);
  for (const row of review.removed) if (row.network === drop) row.network = keep;
  const shared = new Set(platformKeys(review.obj).map((key) => networksOf(review.obj.get(key).tags)).filter((nets) => nets.length > 1).flat());
  applyPriority(review, [...new Set(review.order.map((n) => (n === drop ? keep : n)))].filter((n) => shared.has(n)));
  return changed;
}

/** The answer no in the window: this name is no longer proposed. */
export function keepNetworkApart(review, drop) {
  review.decisions[drop] = false;
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

/** What the order gives each network, in that order: [{network, tag, shared, holds}]. tag: its ref when it is not first on a stop.
 * shared: shared platforms it is on. holds: those where it has ref. */
export function priorityRows(review) {
  const shared = platformKeys(review.obj).map((key) => review.obj.get(key).tags).filter((t) => networksOf(t).length > 1);
  return review.order.map((network) => {
    const on = shared.filter((t) => networksOf(t).includes(network));
    return { network, tag: refKeyFor("ref", network), shared: on.length, holds: on.filter((t) => t.network === network).length };
  });
}

const REF_TAG = /^(?:ref(?::|$)|gtfs:stop_(?:id|code)(?::|$))/;

/** Why this value is obsolete, "" if nothing says so. */
function obsoleteBecause(review, tag, value, base, network, nets) {
  if (!review.inFeed.size) return "";
  if (tag.startsWith("gtfs:")) {
    const inCurrentFeed = review.feed && (tag === `gtfs:stop_code:${review.feed}` || tag.startsWith(`gtfs:stop_code:${review.feed}:`)
      || tag === `gtfs:stop_id:${review.feed}` || tag.startsWith(`gtfs:stop_id:${review.feed}:`));
    return inCurrentFeed && !review.inFeed.has(value) ? "not in this GTFS" : "";
  }
  if (network && !nets.includes(network)) return `${network} is no longer on this stop`;
  if (base === "ref" && !settings.stop_refs_from_gtfs) return "";
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
      return { platform, name: t.name || platform, tag, value, base, network, reason: obsoleteBecause(review, tag, value, base, network, nets) };
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

/** The operator of the line on a platform of its network, in the place of that network. An operator mapped that is no longer there is reported. */
function placeOperator(review, key) {
  const t = review.obj.get(key).tags, nets = networksOf(t);
  if (!nets.includes(review.operator.network)) return;
  t[slotOf(t, "operator", review.operator.network)] = review.operator.value;
  const now = nets.flatMap((network) => split(t[slotOf(t, "operator", network)]));
  const lost = split(review.obj.base.get(key)?.tags?.operator).filter((v) => !now.includes(v));
  if (lost.length) review.corrected.push(`${t.name || key} (${key}): operator ${lost.join(";")} replaced by ${now.join(";")}`);
}

/** Correct and review the refs of the platforms of the file: {obj, order, corrected, toCheck, removed}. Without settings.stop_owners, a platform only changes
 * owner when both sizes are known, like during the run (see takesOver).
 * sizes, ofStop: see stopNetworks. stops: the GTFS stops. feed: suffix of the gtfs:* tags. network: of the line converted, which takes settings.operator. */
export function reviewRefs(obj, { sizes = null, ofStop: feedOfStop = new Map(), stops = [], feed = "", network = null } = {}) {
  const merges = Object.entries(settings.network_merges).filter(([, keep]) => typeof keep === "string");
  const merged = new Map(merges);
  const ofStop = new Map([...feedOfStop].map(([stop, names]) => [stop, new Set([...names].map((n) => merged.get(n) ?? n))]));
  const stopCode = feed ? `gtfs:stop_code:${feed}` : "gtfs:stop_code";
  const review = { obj, feed, removed: [], inFeed: feedValues(stops), feedNetworks: new Set([...ofStop.values()].flatMap((names) => [...names])), known: valuesOfStops(stops, ofStop), bases: ["ref", ...settings.stop_ref_tags, stopCode], reach_m: settings.thresholds.holder_m,
    corrected: [], toCheck: [], order: [], decisions: {} };
  for (const [drop, keep] of merges) mergeInFile(review, keep, drop);
  const keys = platformKeys(obj);
  const networks = new Set(), held = new Map();
  for (const key of keys) {
    const tags = obj.get(key).tags;
    nameNumberedNetworkTags(tags);
    const nets = networksOf(tags);
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
  if (network && settings.operator) {
    review.operator = { network: merged.get(network) ?? network, value: settings.operator };
    for (const key of keys) placeOperator(review, key);
  }
  for (const line of review.corrected) log.info(`Ref corrected: ${line}`);
  for (const line of review.toCheck) log.warn(`Ref to check: ${line}`);
  return review;
}
