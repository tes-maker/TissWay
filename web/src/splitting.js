// Splitting ways where routes enter or leave them: streets, roundabouts, termini.
//
// A route relation must only contain what the vehicle travels. When a route enters or leaves a way at an inner node (it
// turns in the middle of a street, uses part of a roundabout, or starts at a stop_position in the middle of a way), the
// way is split at that node. Splitting is done once for all the routes of the output file (the cuts of every route are
// pooled), after the relations are built, so that ways can be cut at the stop_positions of the termini.
//
// Open way: cut at every inner entry / exit node. Closed way (single-way roundabout...): cut at every entry / exit as soon
// as there are at least two. With split_roundabouts = false, roundabouts are left whole.
//
// Every relation containing a split way gets the parts it travels instead, in travel order:
// - our relations and the existing OSM route relations: only the travelled parts, deduced from the neighbouring ways;
// - the other existing relations (street, associatedStreet, multipolygon...): all the parts.
// The longest part (in number of nodes) keeps the id and history of the original way, as JOSM does.

import { newKey, parentRelations as readParents } from "./osm.js";
import { settings } from "./settings.js";
import { maxBy } from "./util.js";

const ROUTE_ROLES = ["", "forward", "backward"]; // roles of the travelled ways in a route relation
const ROUNDABOUTS = ["roundabout", "circular"]; // junction=* values kept whole when split_roundabouts is false

/** A split way: nodes (original list, closed if nodes[0] == nodes.at(-1)), cuts (indices of the cuts in nodes, ends
 * included for an open way; in nodes.slice(0, -1) for a closed way) and parts (ids of the parts, in node order). */
export class Split {
  constructor(nodes, cuts, parts) {
    this.nodes = nodes;
    this.cuts = [...cuts].sort((a, b) => a - b);
    this.parts = parts;
    this.closed = nodes[0] === nodes.at(-1);
  }

  /** Nodes of each part, in the order of parts. */
  arcs() {
    const { nodes, cuts: c } = this;
    if (!this.closed) return c.slice(0, -1).map((i, k) => nodes.slice(i, c[k + 1] + 1));
    const ring = nodes.slice(0, -1);
    return c.map((i, k) => {
      const j = c[(k + 1) % c.length];
      return j > i ? ring.slice(i, j + 1) : [...ring.slice(i), ...ring.slice(0, j + 1)];
    });
  }

  /** Parts travelled from entry to exit (nodes of the way), in travel order. null = unknown (end of the relation, or
   * neighbouring way missing): from / to the end of the way for an open way, a single part for a closed way; all the parts
   * if both are unknown. */
  traversed(entry, exit) {
    const e = this.nodes.includes(entry) ? entry : null;
    const x = this.nodes.includes(exit) ? exit : null;
    if (e === null && x === null) return [...this.parts];
    return this.closed ? this.traversedClosed(e, x) : this.traversedOpen(e, x);
  }

  traversedOpen(entry, exit) {
    const last = this.nodes.length - 1;
    let px = exit !== null ? this.nodes.indexOf(exit) : null;
    const pe = entry !== null ? this.nodes.indexOf(entry) : px ? 0 : last;
    if (px === null) px = pe < last ? last : 0;
    const [lo, hi] = pe < px ? [pe, px] : [px, pe];
    const spans = this.parts.map((p, k) => [p, this.cuts[k], this.cuts[k + 1]]);
    let parts = spans.filter(([, i, j]) => i < hi && j > lo).map(([p]) => p);
    if (!parts.length) parts = [spans.find(([, i, j]) => i <= lo && lo <= j)[0]];
    return pe <= px ? parts : parts.reverse();
  }

  traversedClosed(entry, exit) {
    const arcs = this.arcs(), n = this.parts.length;
    if (entry === null) return [this.parts[arcs.findIndex((arc) => arc.slice(1).includes(exit))]]; // the part reaching the exit
    const k = arcs.findIndex((arc) => arc.slice(0, -1).includes(entry));
    if (exit === null) return [this.parts[k]];
    const out = [];
    for (let step = 0; step <= n; step++) { // n + 1 steps: a full turn is possible (U-turn on the roundabout)
      const arc = arcs[(k + step) % n];
      out.push(this.parts[(k + step) % n]);
      const start = step === 0 ? arc.indexOf(entry) : 0;
      if (arc.slice(start + 1).includes(exit)) break;
    }
    return out;
  }
}

/** Node where the route passes from way prev to way next (exit of one = entry of the other: computed once for both,
 * otherwise two ways touching at several nodes could be cut at two different places and leave a gap). If there are several,
 * the one ending both ways, else one of them (real junction), else the first in the order of prev. null if they do not touch. */
export function linkNode(obj, prev, next) {
  const a = obj.get(prev).nodes, b = obj.get(next).nodes, inB = new Set(b);
  const ends = (n) => (n === a[0] || n === a.at(-1) ? 1 : 0) + (n === b[0] || n === b.at(-1) ? 1 : 0);
  return maxBy(a.filter((n) => inB.has(n)), ends) ?? null;
}

/** [[member index, way, entry, exit]] of the ways travelled by the route relation rel: entry and exit = node shared with the
 * previous / next way; at the ends of the relation, first / last stop_position if it is on the way; null otherwise. */
function passages(obj, rel) {
  const ways = [];
  rel.members.forEach(([ref, role], i) => {
    if (ref[0] === "w" && ROUTE_ROLES.includes(role) && obj.has(ref) && obj.get(ref).nodes) ways.push([i, ref]);
  });
  const stops = rel.members.filter(([, role]) => role.startsWith("stop")).map(([ref]) => ref);
  const links = ways.slice(1).map(([, b], k) => linkNode(obj, ways[k][1], b));
  return ways.map(([i, w], k) => {
    const nodes = obj.get(w).nodes;
    const entry = k ? links[k - 1] : stops.length && nodes.includes(stops[0]) ? stops[0] : null;
    const exit = k + 1 < ways.length ? links[k] : stops.length && nodes.includes(stops.at(-1)) ? stops.at(-1) : null;
    return [i, w, entry, exit];
  });
}

/** Map way -> Set of nodes where to cut it: inner entries / exits (open way) or all entries / exits (closed way). */
function cutNodes(obj, routes) {
  const cuts = new Map();
  for (const key of routes) {
    for (const [, w, entry, exit] of passages(obj, obj.get(key))) {
      const { nodes, tags } = obj.get(w);
      const closed = nodes[0] === nodes.at(-1);
      if (!settings.split_roundabouts && ROUNDABOUTS.includes(tags.junction)) continue;
      if (!closed && new Set(nodes).size !== nodes.length) continue; // way passing twice through a node: ambiguous
      const inner = new Set(closed ? nodes : nodes.slice(1, -1));
      if (!cuts.has(w)) cuts.set(w, new Set());
      for (const n of [entry, exit]) if (inner.has(n)) cuts.get(w).add(n);
    }
  }
  return cuts;
}

/** Map way -> Split of the ways to split (at least two parts). */
function planSplits(obj, cuts) {
  const splits = new Map();
  for (const [w, nodesCut] of cuts) {
    const nodes = obj.get(w).nodes;
    let idx;
    if (nodes[0] === nodes.at(-1)) {
      idx = new Set([...nodesCut].map((n) => nodes.indexOf(n)));
      if (idx.size < 2) continue; // a single cut on a closed way: nothing to split
    } else {
      idx = new Set([0, nodes.length - 1, ...[...nodesCut].map((n) => nodes.indexOf(n))]);
      if (idx.size < 3) continue;
    }
    const split = new Split(nodes, idx, []);
    const arcs = split.arcs();
    const keep = maxBy(arcs.keys(), (k) => arcs[k].length);
    split.parts = arcs.map((_, k) => (k === keep ? w : newKey("w")));
    splits.set(w, split);
  }
  return splits;
}

/** Members of rel where every split way is replaced by its travelled parts (route relation, routePassages: Map member index
 * -> [entry, exit]) or by all its parts (other relation). */
function rewriteMembers(rel, splits, routePassages) {
  return rel.members.flatMap(([ref, role], i) => {
    if (!splits.has(ref)) return [[ref, role]];
    const parts = routePassages.has(i) ? splits.get(ref).traversed(...routePassages.get(i)) : splits.get(ref).parts;
    return parts.map((p) => [p, role]);
  });
}

/** Split the ways of the route relations of obj where the routes enter or leave them, and update our relations and the
 * existing OSM relations containing them. Returns [split ways, of which closed ways, existing relations updated]. */
export async function splitWays(obj, parentRelations = readParents) {
  const routes = [...obj.modified].filter(([k, o]) => k[0] === "r" && o.tags.type === "route").map(([k]) => k);
  const splits = planSplits(obj, cutNodes(obj, routes));
  if (!splits.size) return [0, 0, 0];

  const parents = await parentRelations([...splits.keys()]);
  const existing = Object.entries(parents).filter(([k]) => !obj.modified.has(k));
  // entries / exits computed on the original ways, before writing the parts
  const routePassages = new Map();
  for (const [k, rel] of [...routes.map((k) => [k, obj.get(k)]), ...existing]) {
    if ((rel.tags.type ?? "route") === "route") routePassages.set(k, new Map(passages(obj, rel).map(([i, , e, x]) => [i, [e, x]])));
  }

  for (const [w, split] of splits) {
    const { tags, version } = obj.get(w);
    const arcs = split.arcs();
    split.parts.forEach((p, k) => obj.set(p, { ...(p === w && version ? { version } : {}), nodes: arcs[k], tags: { ...tags } }));
  }
  const none = new Map();
  for (const k of routes) obj.set(k, { ...obj.get(k), members: rewriteMembers(obj.get(k), splits, routePassages.get(k)) });
  for (const [k, rel] of existing) obj.set(k, { ...rel, members: rewriteMembers(rel, splits, routePassages.get(k) ?? none) });

  return [splits.size, [...splits.values()].filter((s) => s.closed).length, existing.length];
}
