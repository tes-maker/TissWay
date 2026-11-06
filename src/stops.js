// GTFS stops and their candidate OSM platforms.
//
// Each GTFS stop (a stop_id = the platform of one direction, ideally) is related to:
// - nearby OSM platforms (candidates), preferring those already carrying its stop_id;
// - the other GTFS platforms of the same stop (the opposite stop): stops sharing a parent_station, or, for feeds
//   without stations, stops whose stop_code only differs by a trailing letter (12A / 12B) and that are served by
//   a common agency, or, without either, any stop very close by;
// - its rivals: the opposite stops and the stops of the same name nearby, one of which may own an existing
//   stop_position on the road this stop's routes use (see platforms.locateStop).

import { Grid, latlon, osmPosition } from "./geo.js";
import { nameKey, stopKey } from "./naming.js";
import { CODE_IN_ID, choosePlatform, isStopPositionFor } from "./platforms.js";
import { settings } from "./settings.js";
import { setIn, sortedBy, splitTag } from "./util.js";

/** Code shared by the platforms of one stop: the stop_code without its trailing letter ("2702282A" -> "2702282"),
 * null if the code does not have that form. */
export function siblingCode(code) {
  const alpha = (s) => /^\p{L}+$/u.test(s);
  return code.length > 1 && alpha(code.at(-1)) && !alpha(code.slice(0, -1)) ? code.slice(0, -1) : null;
}

/** GTFS stops (df: stop_id -> row) and their neighbours, see matchStops. */
export class Stops {
  constructor(df, platforms, neighbours, holders, rivals = new Map(), refHolders = new Map()) {
    this.df = df;
    // stop_id -> candidate OSM platforms [{id, pos, name, holder, byRef, sameName, claimed, far}]: within thresholds.platform_m, or holder_m if they already carry this
    // stop_id (holder), or ref_m if they have its code as a ref (byRef), or platform_same_name_m if they have its name (sameName) and no stop of another name is
    // clearly closer to them. claimed: another stop has its ref or its name. far = true: to be checked against the road (platforms.verified). platforms.choosePlatform decides among them
    this.platforms = platforms;
    this.neighbours = neighbours; // stop_id -> other GTFS platforms of the same stop (opposite stop)
    this.holders = holders; // stop_id -> Set of OSM platforms already carrying it (gtfs:stop_id*, stop_ref_tags)
    this.rivals = rivals; // stop_id -> neighbours + same-name stops nearby
    this.refHolders = refHolders; // stop_id -> Set of OSM platforms within ref_m with its code as a ref
    this.bays = new Set(); // stop_ids that are bays: their name has at least 3 platforms with a ref (pairStopPositions)
    this.paired = new Map(); // OSM platform, or stop_id without a platform -> its stop_position (pairStopPositions)
  }

  /** Positions of the stops a stop_position of this stop is compared with: the OSM platforms of its rivals, other than the one it uses, else their GTFS position. */
  opposites(stopId, platform = null) {
    return this.rivalsOf(stopId).flatMap((r) => {
      const theirs = (this.platforms.get(r) || []).filter((c) => c.id !== platform).map((c) => c.pos);
      return theirs.length ? theirs : [latlon(this.df.get(r))];
    });
  }

  /** Its rivals, none for a bay: the other bays are not across a road. */
  rivalsOf(stopId) {
    return this.bays.has(stopId) ? [] : this.rivals.get(stopId) || [];
  }

  /** The OSM platform with the ref of this stop, whatever the side of the road and the distance: see choosePlatform. null without one. */
  platformByRef(stopId) {
    const own = (this.platforms.get(stopId) || []).filter((c) => c.holder || c.byRef);
    return choosePlatform(own.map((c) => ({ ...c, far: false })), latlon(this.df.get(stopId)));
  }

  /** The platform of a bay: the one with its ref, else one of its candidates that no other bay has its ref on. */
  bayPlatform(stopId) {
    const taken = new Set((this.rivals.get(stopId) || []).map((r) => this.platformByRef(r)?.id));
    const free = (this.platforms.get(stopId) || []).filter((c) => !taken.has(c.id)).map((c) => ({ ...c, far: false }));
    return this.platformByRef(stopId) ?? choosePlatform(free, latlon(this.df.get(stopId)));
  }

  /** The stop_position of this stop, before its platform is known for sure: the one of the platform with its ref, else, without any platform, its own. */
  stopPositionOf(stopId) {
    return this.paired.get(this.platformByRef(stopId)?.id ?? stopId) ?? null;
  }

  positions(ids) {
    return ids.map((s) => latlon(this.df.get(s)));
  }
}

const BAYS = 3; // more platforms with a ref under one name than the two sides of a road

/** Set stops.bays and stops.paired. Each OSM platform takes the nearest stop_position within stop_position_reuse_m, each of them for one platform only, the closest pairs first. A stop without a
 * platform of its own counts at its GTFS position: a stop_position is left to it, if nearest. A platform with the stop_id or the ref of a stop of which another platform was chosen is a duplicate, and does not count.
 * positions, osm: {key: object} of the stop_positions and of the OSM stops. */
export function pairStopPositions(stops, positions, osm) {
  const byRef = new Map([...stops.df.keys()].map((id) => [id, stops.platformByRef(id)]));
  for (const id of stops.df.keys()) {
    const key = stopKey(stops.df.get(id).stop_name);
    const same = [id, ...(stops.rivals.get(id) || []).filter((r) => stopKey(stops.df.get(r).stop_name) === key)];
    if (new Set(same.map((s) => byRef.get(s)?.id).filter(Boolean)).size >= BAYS) stops.bays.add(id);
  }
  const chosen = new Set([...byRef.values()].filter(Boolean).map((c) => c.id));
  const holding = new Set([...stops.df.keys()].flatMap((id) => (stops.platforms.get(id) || []).filter((c) => c.holder || c.byRef).map((c) => c.id)));
  const owners = [
    ...osmPlatforms(osm).filter((p) => chosen.has(p.id) || !holding.has(p.id)).map((p) => [p.id, p.pos]),
    ...[...stops.df].filter(([id]) => !(stops.platforms.get(id) || []).some((c) => c.holder || c.byRef || c.sameName)).map(([id, s]) => [id, latlon(s)]),
  ];
  const nodes = Object.entries(positions).filter(([, o]) => o.lat !== undefined && isStopPositionFor(o.tags)).map(([k, o]) => [k, latlon(o)]);
  const reach = settings.thresholds.stop_position_reuse_m, grid = new Grid(nodes, ([, pos]) => pos, Math.max(reach, 1));
  const pairs = owners.flatMap(([owner, pos]) => grid.within(pos, reach).map(([[node], d]) => [d, owner, node]));
  const used = new Set();
  for (const [, owner, node] of sortedBy(pairs, ([d]) => d)) {
    if (stops.paired.has(owner) || used.has(node)) continue;
    stops.paired.set(owner, node);
    used.add(node);
  }
}

/** stop_id -> Set of the OSM objects carrying it. */
function holdersOf(osm) {
  const prefixes = ["gtfs:stop_id", ...settings.stop_ref_tags];
  const holders = new Map();
  for (const [key, o] of Object.entries(osm)) {
    for (const [k, value] of Object.entries(o.tags)) {
      if (!prefixes.some((p) => k.startsWith(p))) continue;
      for (const id of value.split(";")) {
        const stopId = id.trim();
        setIn(holders, stopId).add(key);
      }
    }
  }
  return holders;
}

/** The values of the refs of a platform. */
const refsOf = (tags) => new Set(Object.entries(tags).filter(([k]) => /^(?:ref|gtfs:stop_code)(?::|$)/.test(k)).flatMap(([, v]) => splitTag(v)));

/** What a ref of this stop can be: its stop_id, and its codes unless those of the GTFS are not trusted (settings.stop_refs_from_gtfs). */
const refValuesOf = (stop) => [stop.stop_id, ...(settings.stop_refs_from_gtfs ? [stop.stop_code, CODE_IN_ID.exec(stop.stop_id)?.[1]] : [])].filter(Boolean);

/** The keys a name can be recognised by: all of it, without what is in brackets at its end, and what follows its first separator, without the town of "Caen - Gare". "St" is read as "Saint". */
function nameKeysOf(name) {
  const part = /\s(?:-|–)\s|,\s/.exec(name);
  return [stopKey(name), stopKey(name.replace(/\s*\([^)]*\)\s*$/, "")), ...(part ? [nameKey(name.slice(part.index + part[0].length))] : [])].filter(Boolean)
    .map((key) => key.replace(/\bst\b/g, "saint").replace(/\bste\b/g, "sainte"));
}

/** Do the names of an OSM platform (name, official_name, gtfs:stop_name*) say it is this stop? A strong match: the same words, whatever the case, the accents and the town. */
function sameStopName(stopName, tags) {
  const keys = new Set(nameKeysOf(stopName ?? ""));
  return Object.entries(tags).some(([k, v]) => /^(?:name|official_name|gtfs:stop_name(?::.*)?)$/.test(k) && splitTag(v).some((name) => nameKeysOf(name).some((key) => keys.has(key))));
}

/** OSM stops usable as platforms: nodes and ways, a stop_position (even tagged highway=bus_stop) never is. */
export const osmPlatforms = (osm) => Object.entries(osm)
  .filter(([key, o]) => (key[0] === "n" || key[0] === "w") && o.tags.public_transport !== "stop_position" && osmPosition(o))
  .map(([id, o]) => ({ id, pos: osmPosition(o), name: o.tags.name ?? null }));

/** Stops of the given GTFS stops. agencies: stop_id -> Set of the agency_ids serving it (Feed.stopAgencies), keeps
 * the stop codes of different networks of an aggregated feed apart. osm: {key: object} of the OSM stops. */
export function matchStops(stopRows, agencies, osm) {
  const th = settings.thresholds;
  const holders = holdersOf(osm);
  const df = new Map(stopRows.map((s) => [s.stop_id, s]));
  const keys = new Map(stopRows.map((s) => [s.stop_id, stopKey(s.stop_name)]));
  const close = Math.max(th.platform_m, th.platform_unclaimed_m);
  const reach = Math.max(th.holder_m, th.ref_m, close, th.platform_same_name_m);
  const grid = new Grid(stopRows, latlon, Math.max(reach, th.sibling_m));
  const platforms = new Map(stopRows.map((s) => [s.stop_id, []]));
  const refHolders = new Map();
  const claims = new Map(); // OSM platform -> stops with its ref or its name

  for (const p of osmPlatforms(osm)) {
    const near = grid.within(p.pos, reach);
    // nearest GTFS stop of each name: a platform's "other" distance is that of the nearest stop of another name
    const byName = new Map();
    for (const [s, d] of near) {
      const key = keys.get(s.stop_id);
      if (!byName.has(key) || d < byName.get(key)) byName.set(key, d);
    }
    const ranked = [...byName].sort((a, b) => a[1] - b[1]);
    const { tags } = osm[p.id], refs = refsOf(tags);
    for (const [s, d] of near) {
      const key = keys.get(s.stop_id);
      const other = (ranked[0][0] !== key ? ranked[0][1] : ranked[1]?.[1]) ?? Infinity;
      const holder = holders.get(s.stop_id)?.has(p.id) ?? false;
      // beyond platform_m, the platform of another stop is likely: only if no stop of another name is clearly
      // closer to it (stops of the same name are left to the side check of platforms.verified)
      const alone = d <= other + th.duplicate_stop_m;
      const byRef = d <= th.ref_m && refValuesOf(s).some((v) => refs.has(v));
      if (byRef) setIn(refHolders, s.stop_id).add(p.id);
      const sameName = sameStopName(s.stop_name, tags);
      if (holder || byRef || sameName) setIn(claims, p.id).add(s.stop_id);
      if (holder || byRef || d <= close || (alone && sameName && d <= th.platform_same_name_m)) {
        platforms.get(s.stop_id).push({ id: p.id, pos: p.pos, name: p.name, holder, byRef, sameName, far: !holder && d > th.platform_m });
      }
    }
  }

  for (const [stopId, candidates] of platforms) {
    for (const c of candidates) {
      c.claimed = [...(claims.get(c.id) ?? [])].some((id) => id !== stopId);
      c.shared = [...holders].some(([id, keys]) => id !== stopId && df.has(id) && keys.has(c.id)); // it holds the stop_id of another stop as well
    }
  }

  const neighbours = new Map(stopRows.map((s) => [s.stop_id, []]));
  const rivals = new Map(stopRows.map((s) => [s.stop_id, []]));
  const none = new Set();
  for (const a of stopRows) {
    const code = siblingCode(a.stop_code || "");
    const agenciesA = agencies?.get(a.stop_id) ?? none;
    for (const [b, d] of grid.within(latlon(a), th.sibling_m)) {
      if (b.stop_id === a.stop_id) continue;
      let sibling;
      if (a.parent_station) sibling = a.parent_station === b.parent_station;
      else if (code) {
        const agenciesB = agencies?.get(b.stop_id) ?? none;
        const shared = [...agenciesA].some((x) => agenciesB.has(x));
        sibling = code === siblingCode(b.stop_code || "") && (shared || !agenciesA.size || !agenciesB.size);
      } else sibling = d <= th.opposite_stop_m;
      if (sibling) neighbours.get(a.stop_id).push(b.stop_id);
      const key = keys.get(a.stop_id);
      if (sibling || (key && key === keys.get(b.stop_id))) rivals.get(a.stop_id).push(b.stop_id);
    }
  }
  return new Stops(df, platforms, neighbours, holders, rivals, refHolders);
}
