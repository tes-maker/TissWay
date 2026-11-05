// Tell apart the route relations sharing the same termini in a .osm file (JOSM): the via tag, and the same stops in the title,
// "Bus 117: FLERS Gare → FLERS Les Landes → VIRE Les Vallées → CAEN Gare Routière", as every title (naming.stopLabel).
//
// Relations are grouped by name, without any via already present, so it can be run again. In each group of several relations, each
// one gets as few stops as possible, taken from its intermediate stops (platforms), that set it apart from the others. A relation
// whose stops are all served by another one keeps its name without via: the other relation gets the extra stops.
//
// Two platforms of the same name more than HOMONYM_M apart are different stops. The town of a stop comes from Nominatim.

import { dist } from "./geo.js";
import { lookup } from "./lookup.js";
import { stopLabel, tripLabel } from "./naming.js";
import { parseXml, serializeXml } from "./osm.js";
import { counter, maxBy } from "./util.js";

const HOMONYM_M = 1000;
const ARROWS = /\s*(?:=>|->|→|⇒)\s*/;
const PLATFORM_ROLES = ["platform", "platform_entry_only", "platform_exit_only"];
const STOP_ROLES = ["stop", "stop_entry_only", "stop_exit_only"];
const SEP = "\u0001";

/** [what precedes the stops, from, to] of a route name, null if it has not this form. An old " via …" is left out. */
function nameParts(name) {
  const at = name.lastIndexOf(": ");
  const stops = name.slice(at < 0 ? 0 : at + 2).split(" via ")[0].split(ARROWS);
  return stops.length < 2 ? null : [at < 0 ? "" : name.slice(0, at + 2), stops[0], stops.at(-1)];
}

const tagsOf = (el) => Object.fromEntries(el.children.filter((c) => c.name === "tag").map((t) => [t.attrs.k, t.attrs.v]));

function setTag(el, k, v) {
  const tag = el.children.find((c) => c.name === "tag" && c.attrs.k === k);
  if (tag) tag.attrs.v = v;
  else el.children.push({ name: "tag", attrs: { k, v }, children: [] });
}

/** Position of an element of the file: a node, or the first node of a way. null if it is not in the file. */
function positionOf(ref, elements) {
  const el = elements.get(ref);
  if (el?.name === "node" && el.attrs.lat) return [Number(el.attrs.lat), Number(el.attrs.lon)];
  const nd = el?.children.find((c) => c.name === "nd");
  return nd ? positionOf(`node/${nd.attrs.ref}`, elements) : null;
}

/** Stops of the relation in order (platforms, else stop_positions), without consecutive repeats; null if one of these members
 * is not in the file (incomplete existing relation) or if there are none. key(name, ref) identifies a stop. */
function routeStops(rel, objs, key) {
  for (const roles of [PLATFORM_ROLES, STOP_ROLES]) {
    const members = rel.children.filter((m) => m.name === "member" && roles.includes(m.attrs.role)).map((m) => `${m.attrs.type}/${m.attrs.ref}`);
    if (members.some((m) => !objs.has(m))) return null;
    const keys = members.map((m) => ("name" in objs.get(m) ? key(objs.get(m).name, m) : null));
    const out = keys.filter((k, i) => k && (i === 0 || k !== keys[i - 1]));
    if (out.length) return out;
  }
  return null;
}

/** For each relation (ordered list of stops), the intermediate stops to name after "via". Each relation must stand apart from
 * every other relation it has at least one more stop than: the stops setting it apart from the most relations at once are
 * picked greedily (on ties, the least frequent in the group, then the first on the way). */
export function chooseVias(stops) {
  const middles = stops.map((s) => s.slice(1, -1));
  const sets = stops.map((s) => new Set(s));
  const freq = counter(middles.flatMap((m) => [...new Set(m)]));
  return middles.map((mid, i) => {
    const todo = new Map();
    stops.forEach((_, j) => {
      const diff = new Set(mid.filter((k) => !sets[j].has(k)));
      if (j !== i && diff.size) todo.set(j, diff);
    });
    const chosen = new Set();
    while (todo.size) {
      const pick = maxBy(new Set(mid), (k) => [[...todo.values()].filter((d) => d.has(k)).length, -freq.get(k), -mid.indexOf(k)]);
      chosen.add(pick);
      for (const [j, d] of todo) if (d.has(pick)) todo.delete(j);
    }
    return [...new Set(mid)].filter((k) => chosen.has(k));
  });
}

/** Rename the relations of a root element of parseXml in place; returns {changes: [[old, new]], warnings}. */
export async function addVias(root, prefix = "") {
  const elements = root.children.filter((e) => ["node", "way", "relation"].includes(e.name));
  const objs = new Map(elements.map((e) => [`${e.name}/${e.attrs.id}`, tagsOf(e)]));
  const byRef = new Map(elements.map((e) => [`${e.name}/${e.attrs.id}`, e]));
  const groups = new Map();
  for (const rel of elements.filter((e) => e.name === "relation")) {
    const { type, name } = tagsOf(rel);
    if (type !== "route" || !name || !name.startsWith(prefix)) continue;
    const parts = nameParts(name);
    if (!parts) continue;
    const base = `${parts[0]}${tripLabel(parts[1], parts[2])}`;
    if (!groups.has(base)) groups.set(base, { parts, rels: [] });
    groups.get(base).rels.push(rel);
  }

  const changes = [], warnings = [];
  for (const [base, { parts, rels }] of groups) {
    if (rels.length < 2) continue; // name already unique: any "via" is kept
    // "name<SEP>n": the n-th place of the group with this name, more than HOMONYM_M from the others
    const places = new Map(), officials = new Map();
    const key = (name, ref) => {
      const pos = positionOf(ref, byRef);
      if (!places.has(name)) places.set(name, []);
      const list = places.get(name);
      let i = pos ? list.findIndex((p) => dist(p, pos) <= HOMONYM_M) : 0;
      if (i < 0 || !list.length) i = list.push(pos ?? null) - 1;
      const k = `${name}${SEP}${i}`;
      officials.set(k, objs.get(ref).official_name);
      return k;
    };
    const stops = rels.map((r) => routeStops(r, objs, key));
    if (stops.includes(null)) {
      warnings.push(`skipped, stops missing from the file (download the whole relation): ${base}`);
      continue;
    }
    const vias = chooseVias(stops);
    const finalNames = [];
    for (const [i, rel] of rels.entries()) {
      const labels = await Promise.all(vias[i].map(async (k) => {
        const [name, place] = k.split(SEP);
        const pos = places.get(name)[Number(place)];
        return stopLabel({ name, official_name: officials.get(k), places: pos ? await lookup.placesAt(pos[0], pos[1]) : [] });
      }));
      const name = `${parts[0]}${tripLabel(parts[1], parts[2], labels)}`;
      finalNames.push(name);
      const { name: old, via: oldVia = "" } = tagsOf(rel);
      const via = vias[i].map((k) => k.split(SEP)[0]).join(";"); // the names of the platforms
      if (name !== old || via !== oldVia) {
        setTag(rel, "name", name);
        if (via) setTag(rel, "via", via);
        else rel.children = rel.children.filter((c) => !(c.name === "tag" && c.attrs.k === "via"));
        if (rel.attrs.action !== "delete") rel.attrs.action = "modify";
        changes.push([old, name]);
      }
    }
    for (const [name, n] of counter(finalNames)) {
      if (n > 1) warnings.push(`${n} relations keep the same name (same stops): ${name} [${rels.filter((_, i) => finalNames[i] === name).map((r) => r.attrs.id).join(", ")}]`);
    }
  }
  return { changes, warnings };
}

/** {xml, changes, warnings} of an .osm text. */
export async function renameInFile(text, prefix = "") {
  const root = parseXml(text);
  const { changes, warnings } = await addVias(root, prefix);
  return { xml: serializeXml(root), changes, warnings };
}
