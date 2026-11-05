// Relations of a line: one route relation per variant and a route_master, new or existing ones updated in place.

import { feedKey, joinIds, updatedMaster, updatedRelation } from "./existing.js";
import { latlon, xy } from "./geo.js";
import { masterLabel, modePrefix, routeName, tripTitle } from "./naming.js";
import { isNew, newKey } from "./osm.js";
import { linkNode } from "./splitting.js";
import { VEHICLE, choosePlatform, completeRouteRef, fixSide, kerbSide, locateStop, makeSpot, materialize, onKerb, roadDistance, sideSegment, stopSegment } from "./platforms.js";
import { settings } from "./settings.js";
import { counter, dedupe, listIn, log, unique } from "./util.js";
import { chooseVias } from "./via.js";

const HEX_COLOUR = /^#?([0-9A-Fa-f]{6})$/;

/** Tags shared by the route relations and the route_master of a line. */
function routeTags(route, network) {
  const tags = { ...network };
  for (const [gtfsKey, setting, osmKey] of [["route_color", "colour", "colour"], ["route_text_color", "colour_text", "colour:text"]]) {
    const m = HEX_COLOUR.exec((settings[setting] || route[gtfsKey] || "").trim());
    if (m) tags[osmKey] = `#${m[1]}`;
  }
  tags[feedKey("gtfs:route_id")] = route.route_id;
  return tags;
}

/** Builds the relations of one line in obj. Platforms chosen are recorded in assignments (stop_id -> Map platform ->
 * [network tags, position, mode]); their tags are set afterwards by tagPlatforms. created: stop_id -> platform created at
 * its position, shared by all lines. existing: ExistingRoutes whose relations are updated instead of duplicated, or null. */
class LineBuilder {
  constructor(route, obj, stops, network, assignments, created, existing) {
    Object.assign(this, { route, obj, stops, network, assignments, created, existing });
    this.updated = [];
    this.unpaired = [];
    this.elsewhere = [];
    this.mode = route.mode || "bus";
    this.vehicle = VEHICLE[this.mode] || "bus";
    // stop_id -> [[heading, choice]]: a stop served in both directions does not have the same platform each way. Keyed on
    // the direction of travel at the stop rather than on direction_id, which is optional (and sometimes wrong).
    this.chosen = new Map();
    this.missing = 0;
    this.far = [];
    this.swapped = [];
    this.wrongSide = [];
    this.gaps = new Set();
    this.sameNames = [];
  }

  /** Spot of the stop_position of stopId (at pos, default: the GTFS position) from ways[start]; beyond stop_position_m, at
   * the nearest point of the way (reported). */
  locate(ways, stopId, start, terminus = null) {
    const at = latlon(this.stops.df.get(stopId));
    const rivals = this.stops.positions(this.stops.rivals.get(stopId) || []);
    const options = { start, rivals, vehicle: this.vehicle, terminus };
    return locateStop(this.obj, ways, at, options) ?? locateStop(this.obj, ways, at, { ...options, max_m: Infinity });
  }

  /** {platform, dataId, pos, kerb} of stopId in this direction of travel, chosen at its first occurrence. kerb: on the kerb
   * side, judged when choosing (null without a spot). */
  choose(stopId, ways, spot) {
    const { obj, stops } = this;
    const segment = spot && stopSegment(obj, ways, spot);
    const heading = segment && Math.atan2(...xy(segment[1], segment[0]).reverse());
    for (const [h, choice] of this.chosen.get(stopId) || []) {
      if (h === null || heading === null || Math.cos(h - heading) > 0) return choice; // same way, within 90°
    }
    const s = stops.df.get(stopId);
    const road = spot && ((p) => roadDistance(obj, ways, p, spot.wayIndex));
    const side = spot && ((p) => sideSegment(obj, ways, spot, p));
    const initial = choosePlatform(stops.platforms.get(stopId) || [], latlon(s), { segment, spotPos: spot?.pos, road, side });
    const [c, dataId] = fixSide(stopId, initial, segment, stops, road, side);
    if (dataId !== stopId) this.swapped.push(`${s.stop_name} (${stopId} -> ${dataId}${c ? "" : ", platform created"})`);
    const d = stops.df.get(dataId);
    if (!c && !this.created.has(dataId)) {
      this.created.set(dataId, newKey("n"));
      obj.set(this.created.get(dataId), { lat: d.lat, lon: d.lon, tags: {} });
    }
    const platform = c ? c.id : this.created.get(dataId);
    const pos = c ? c.pos : latlon(d);
    // a platform created at the GTFS position is judged as the GTFS stop, an OSM platform on the road next to it
    const kerb = segment ? Boolean(c ? onKerb(pos, segment, side) : kerbSide(pos, ...segment)) : null;
    if (!this.assignments.has(dataId)) this.assignments.set(dataId, new Map());
    const before = this.assignments.get(dataId).get(platform);
    this.assignments.get(dataId).set(platform, [this.network, pos, this.mode, kerb === true || before?.[3] === true]); // on the good side, one way at least
    const choice = { platform, dataId, pos, kerb };
    listIn(this.chosen, stopId).push([heading ?? null, choice]);
    return choice;
  }

  /** The members of a complete relation, as they are: only the tags of its stops are completed (see reuse.completeRelation). */
  completeMembers(v) {
    const { obj, stops } = this;
    v.seq.forEach((stopId, i) => {
      const { stop, platform, way, pos } = v.complete[i];
      materialize(obj, v.ways, makeSpot(way, latlon(obj.get(stop)), 0, { node: stop }), stops.df.get(stopId).stop_name, this.vehicle, { platform, exclusive: !stops.rivals.get(stopId)?.length });
      if (this.mode === "coach") obj.edit(stop).tags.coach = "yes";
      completeRouteRef(obj, platform, this.route.route_short_name);
      if (!this.assignments.has(stopId)) this.assignments.set(stopId, new Map());
      this.assignments.get(stopId).set(platform, [this.network, pos, this.mode, true]);
    });
    return this.existing.routes[v.kept_from].members;
  }

  /** What the first or last of the n stops of a variant is compared with (see platforms.fitsTerminus), null for the others. */
  terminusOf(v, i) {
    if (i !== 0 && i !== v.seq.length - 1) return null;
    const next = v.seq[i === 0 ? 1 : i - 1];
    const others = next === undefined || next === v.seq[i] ? [] : [latlon(this.stops.df.get(next))];
    return { name: this.stops.df.get(v.seq[i]).stop_name, others };
  }

  variantMembers(v) {
    if (v.complete) return this.completeMembers(v);
    const { obj, stops } = this, members = [];
    let { ways } = v;
    let start = 0, first = null, last = null;
    for (const [i, stopId] of v.seq.entries()) {
      const terminus = this.terminusOf(v, i);
      let spot = this.locate(ways, stopId, start, terminus);
      const { platform, dataId, pos, kerb } = this.choose(stopId, ways, spot);
      // the stop_position goes in front of the platform actually used: an existing OSM platform is more accurate than
      // the GTFS position (often tens of metres off)
      if (!isNew(platform)) {
        const rivals = (stops.rivals.get(dataId) || []).flatMap((r) => (stops.platforms.get(r) || [])
          .filter((c) => c.id !== platform).map((c) => c.pos));
        spot = locateStop(obj, ways, pos, { start, rivals, vehicle: this.vehicle, platform: true, terminus, opposites: stops.opposites(dataId, platform) }) || spot;
      } else if (dataId !== stopId) {
        spot = this.locate(ways, dataId, start, terminus) || spot;
      }
      if (spot) {
        start = spot.wayIndex;
        const name = stops.df.get(dataId).stop_name;
        if (spot.distance > settings.thresholds.stop_position_m) this.far.push(name);
        const stopPosition = materialize(obj, ways, spot, name, this.vehicle, { platform, exclusive: !stops.rivals.get(dataId)?.length });
        if (this.mode === "coach") obj.edit(stopPosition).tags.coach = "yes"; // required with route=coach by PTNA
        members.push([stopPosition, "stop"]);
        if (i === 0) first = [spot.wayIndex, stopPosition];
        if (i === v.seq.length - 1) last = [spot.wayIndex, stopPosition];
        if (kerb === false) this.wrongSide.push(name);
      } else this.missing++;
      completeRouteRef(obj, platform, this.route.route_short_name);
      members.push([platform, "platform"]);
    }
    ways = this.betweenTermini(ways, first, last);
    for (let i = 1; i < ways.length; i++) {
      const next = new Set(obj.get(ways[i]).nodes);
      if (!obj.get(ways[i - 1]).nodes.some((n) => next.has(n))) this.gaps.add(`${ways[i - 1]}/${ways[i]}`);
    }
    return [...members, ...ways.map((w) => [w, ""])];
  }

  /** The ways from the first stop_position to the last one, [way index, node] (null: unknown, that end is left as it is). What comes before or after is not
   * travelled. A stop_position at the junction of two ways belongs to the one the line goes on with: the way ending there is left out. Ways still partly
   * travelled are cut at these stop_positions (splitting). */
  betweenTermini(ways, first, last) {
    const { obj } = this;
    let lo = first ? first[0] : 0, hi = last ? last[0] : ways.length - 1;
    while (first && lo < hi && linkNode(obj, ways[lo], ways[lo + 1]) === first[1]) lo++;
    while (last && lo < hi && linkNode(obj, ways[hi - 1], ways[hi]) === last[1]) hi--;
    return ways.slice(lo, hi + 1);
  }

  build(variants) {
    const { obj, route, network, existing, mode } = this;
    const ref = route.route_short_name;
    const common = routeTags(route, network);
    const before = new Set(obj.modified.keys());
    const drafts = [], endpoints = [];
    for (const v of variants) {
      const members = this.variantMembers(v);
      const first = this.stops.df.get(v.seq[0]), last = this.stops.df.get(v.seq.at(-1));
      endpoints.push([first.label, last.label, v.trips ?? 1]);
      const tags = { type: "route", route: mode, ...(ref ? { ref } : {}), name: tripTitle(modePrefix(mode), ref, first.label, last.label),
        ...common, [feedKey("gtfs:trip_id:sample")]: joinIds(v.trip_ids ?? [v.trip_id]) };
      if (v.shape_id && v.source !== "stops") tags[feedKey("gtfs:shape_id")] = joinIds(v.shape_ids ?? [v.shape_id]);
      Object.assign(tags, { from: first.stop_name, to: last.stop_name, "public_transport:version": "2" });
      if (v.duration) tags.duration = v.duration;
      const platforms = members.filter(([, role]) => role === "platform").map(([key]) => key);
      if (platforms.length > 1 && platforms[0] === platforms.at(-1)) tags.roundtrip = "yes";
      drafts.push([members, tags]);
    }
    this.addVias(variants, drafts, ref, endpoints);

    let paired = new Map(), candidates = [];
    if (existing) {
      candidates = existing.candidates(mode, ref, network.network, route.route_id);
      paired = existing.pair(drafts, candidates, variants.map((v) => v.kept_from)); // a trace kept stays in its relation
    }
    const routeKeys = drafts.map(([members, tags], i) => {
      if (paired.has(i)) {
        const key = paired.get(i);
        obj.set(key, { ...updatedRelation(existing.routes[key], members, tags), ...(variants[i].complete ? { complete: true } : {}) });
        this.updated.push(key);
        return key;
      }
      const key = newKey("r");
      obj.set(key, { members, tags });
      return key;
    });
    const used = new Set(paired.values());
    this.unpaired = candidates.filter((k) => !used.has(k));
    for (const k of this.unpaired) if (existing.routes[k].correctedIds) obj.set(k, existing.routes[k]);
    if (existing) this.elsewhere = existing.otherNetworks(mode, ref, network.network, drafts);

    const masterTags = { type: "route_master", route_master: mode, ...(ref ? { ref } : {}), name: routeName(mode, ref, masterLabel(endpoints)), ...common };
    const master = existing && existing.master(mode, ref, network.network, route.route_id, this.updated);
    if (master) {
      masterTags[feedKey("gtfs:route_id")] = existing.masterRouteIds(existing.masters[master], route.route_id);
      obj.set(master, updatedMaster(existing.masters[master], routeKeys, masterTags));
      this.updated.push(master);
      this.shareOperator([master, ...routeKeys]);
    } else {
      const key = newKey("r");
      obj.set(key, { members: routeKeys.map((k) => [k, ""]), tags: masterTags });
      this.shareOperator([key, ...routeKeys]);
    }
    this.report(ref || route.route_id, variants.length, before);
  }

  /** via=* on the variants sharing their termini, and in their title: the fewest stops telling them apart. */
  addVias(variants, drafts, ref, endpoints) {
    const groups = new Map();
    endpoints.forEach((pair, i) => {
      const key = pair.slice(0, 2).join("\u0001");
      listIn(groups, key).push(i);
    });
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const names = group.map((i) => dedupe(variants[i].seq.map((id) => this.stops.df.get(id).stop_name)));
      const vias = chooseVias(names);
      group.forEach((i, k) => {
        if (!vias[k].length) return;
        drafts[i][1].via = joinIds(vias[k]); // the exact names of the platforms
        const [from, to] = endpoints[i];
        const stops = variants[i].seq.map((id) => this.stops.df.get(id));
        const labels = vias[k].map((name) => stops.find((s) => s.stop_name === name)?.label ?? name);
        drafts[i][1].name = tripTitle(modePrefix(this.mode), ref, from, to, labels);
      });
    }
    this.sameNames = [...counter(drafts.map(([, tags]) => tags.name))].filter(([, n]) => n > 1).map(([name]) => name);
  }

  /** PTNA reports a route without the operator of its route_master, and the reverse. The operator is never taken from the GTFS (its
   * agency is often not the real operator): only an operator the mapped relations of the line agree on is shared with the others. */
  shareOperator(keys) {
    const values = new Set(keys.map((k) => this.obj.get(k)?.tags.operator).filter(Boolean));
    if (values.size !== 1) return;
    const operator = [...values][0];
    for (const k of keys) if (!this.obj.get(k).tags.operator) this.obj.get(k).tags.operator = operator;
  }

  report(ref, nVariants, before) {
    const created = new Set(this.created.values());
    const fresh = [...this.obj.modified.keys()].filter((k) => k.startsWith("n-") && !before.has(k));
    const nPlatforms = fresh.filter((k) => created.has(k)).length;
    log.info(`line ${ref}: ${nVariants} variant(s), ${fresh.length - nPlatforms} new stop_position(s), ${nPlatforms} new platform(s)`);
    if (this.updated.length) log.info(`  existing relations updated in place: ${this.updated.join(", ")}`);
    const name = (k, extra = "") => `${k} (${extra}${this.existing.routes[k].tags.name ?? "?"})`;
    if (this.unpaired.length) {
      log.warn(`  ${this.unpaired.length} existing route relation(s) not matched by any GTFS variant (obsolete? to check in JOSM): ${this.unpaired.map((k) => name(k)).join("; ")}`);
    }
    if (this.elsewhere.length) {
      log.warn(`  same line in OSM under another network, not updated (duplicate? check the network): ${this.elsewhere.map((k) => name(k, `${this.existing.routes[k].tags.network}: `)).join("; ")}`);
    }
    if (this.sameNames.length) log.warn(`  variants with the same name and the same stops, different ways (to tell apart in JOSM): ${this.sameNames.join("; ")}`);
    if (this.missing) log.warn(`  ${this.missing} stop(s) without stop_position (no way)`);
    if (this.gaps.size) log.warn(`  ${this.gaps.size} gap(s) between consecutive ways`);
    const far = unique(this.far), wrongSide = unique(this.wrongSide);
    if (far.length) log.warn(`  ${far.length} stop_position(s) more than ${settings.thresholds.stop_position_m} m from the GTFS stop (to check): ${far.join(", ")}`);
    for (const x of this.swapped) log.info(`  GTFS stop across the road, data of the opposite stop used: ${x}`);
    if (wrongSide.length) log.warn(`  ${wrongSide.length} platform(s) across the road, no OSM platform or GTFS stop on the kerb side: ${wrongSide.join(", ")}`);
  }
}

/** Add to obj the relations and stop_positions of a line (see LineBuilder). */
export function buildLine(route, variants, obj, stops, network, assignments, created, existing = null) {
  new LineBuilder(route, obj, stops, network, assignments, created, existing).build(variants);
}
