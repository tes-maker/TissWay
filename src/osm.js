// OSM objects and the .osm file for JOSM.
//
// Objects are kept in a Store under keys "n123" / "w123" / "r123" (type + id):
// - node: {version, tags, lat, lon}
// - way: {version, tags, nodes: ["n1", "n2", ...]}
// - relation: {version, tags, members: [["w123", "role"], ...]}
// Objects created by the tool have a negative id ("n-12") and no version.

import { overpass } from "./net.js";
import { CODE_IN_ID } from "./platforms.js";
import { settings } from "./settings.js";

const MEMBER_TYPES = { n: "node", w: "way", r: "relation" };
const KIND = { node: "n", way: "w", relation: "r" };
let lastId = 0;

/** Key of a new object of kind "n", "w" or "r", unique within the output file. */
export const newKey = (kind) => `${kind}-${++lastId}`;
export const isNew = (key) => key[1] === "-";

/** What was read from OSM (base, never changed) under what the tool creates or changes (modified, what the output
 * file contains). */
export class Store {
  constructor(base = {}, modified = {}) {
    this.base = new Map(Object.entries(base));
    this.modified = new Map(Object.entries(modified));
  }

  get(key) {
    return this.modified.get(key) ?? this.base.get(key);
  }

  has(key) {
    return this.modified.has(key) || this.base.has(key);
  }

  set(key, value) {
    this.modified.set(key, value);
  }

  /** Object to change: copied from the base into the modified layer on its first change. */
  edit(key) {
    if (!this.modified.has(key)) this.modified.set(key, structuredClone(this.base.get(key)));
    return this.modified.get(key);
  }
}

// --- reading from Overpass --------------------------------------------------------------------------------

/** {key: object} of Overpass JSON elements. The center of a way (out center) is kept but not written out. */
export function fromOverpass(elements) {
  const out = {};
  for (const e of elements) {
    const o = { version: String(e.version ?? ""), tags: e.tags || {} };
    if (e.type === "node") Object.assign(o, { lat: e.lat, lon: e.lon });
    if (e.type === "way") o.nodes = (e.nodes || []).map((n) => `n${n}`);
    if (e.type === "relation") o.members = (e.members || []).map((m) => [`${KIND[m.type]}${m.ref}`, m.role || ""]);
    if (e.center) o.center = [e.center.lat, e.center.lon];
    out[`${KIND[e.type]}${e.id}`] = o;
  }
  return out;
}

const BATCH = 2000; // ids per Overpass query
const numericIds = (keys, kind) => [...keys].filter((k) => k[0] === kind && !isNew(k)).map((k) => k.slice(1));

async function inBatches(ids, query) {
  const out = {};
  for (let i = 0; i < ids.length; i += BATCH) Object.assign(out, fromOverpass(await overpass(query(ids.slice(i, i + BATCH).join(",")))));
  return out;
}

/** The ways with these keys and all their nodes. */
export const readWays = (keys) => inBatches(numericIds(keys, "w"), (ids) => `way(id:${ids})->.w;.w out meta;node(w.w);out meta;`);

/** The nodes with these keys. */
const readNodes = (keys) => inBatches(numericIds(keys, "n"), (ids) => `node(id:${ids});out meta;`);

/** Relations containing these ways. */
export const parentRelations = (keys) => inBatches(numericIds(keys, "w"), (ids) => `way(id:${ids});rel(bw);out meta;`);

const bboxText = (b) => b.map((x) => x.toFixed(6)).join(",");

/** OSM bus stops and platforms in a bbox (ways with their center), for stops.matchStops. */
export const platformsIn = (box) => {
  const b = bboxText(box);
  return overpass(`(node[highway=bus_stop](${b});node[public_transport=platform](${b});way[public_transport=platform](${b}););out meta center;`)
    .then(fromOverpass);
};

/** Route relations of these modes with a member in a bbox, and their route masters. */
export const routesIn = (box, modes) => {
  const b = bboxText(box), rx = modes.filter((m) => /^\w+$/.test(m)).join("|");
  return overpass(`relation[route~"^(${rx})$"](${b})->.r;relation(br.r)[route_master~"^(${rx})$"]->.m;(.r;.m;);out meta;`)
    .then(fromOverpass);
};

/** Tags of the relations carrying a feed code over a whole feed: only their tags, the area can be large. */
export const relationsWithFeedCode = (box) => overpass(`relation[~"^gtfs:route_id:"~"."](${bboxText(box)});out tags;`).then(fromOverpass);

/** Nodes of the modified ways that were not read yet (a platform drawn as a way, for instance). */
export async function completeWayNodes(obj) {
  const missing = new Set();
  for (const [key, o] of obj.modified) {
    if (key[0] === "w") for (const n of o.nodes) if (!obj.has(n)) missing.add(n);
  }
  for (const [key, node] of Object.entries(await readNodes(missing))) obj.base.set(key, node);
}

// --- XML --------------------------------------------------------------------------------------------------

const escapeXml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
  .replace(/\n/g, "&#10;").replace(/\t/g, "&#9;");
const unescapeXml = (s) => s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (_, e) => {
  if (e[0] !== "#") return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[e];
  return String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
});

const tagValues = (...values) => [...new Set(values.flatMap((v) => (v || "").split(";").map((x) => x.trim()).filter(Boolean)))];
const networkSuffix = (network) => network.trim().replace(/\s+/g, "_").replace(/[^\p{L}\p{N}_.-]/gu, "");

/** Stop ids exported for a platform: the stop of the first network, the one of the tags without suffix (ref=chuo02, ref:FR:Atoumod=FR:14118:ZE:chuo02:...), taken from
 * these tags if needed. The id of another network is left out, its ref:*:<network> holds it (network names do not matter: ref:Nomad can be the ref of Nomad Car), unless
 * nothing else remains. An id that no ref tells about is of another feed, and stays. Without any ref to tell, the last id of a feed. */
function exportedStopIds(t) {
  const code = (id) => CODE_IN_ID.exec(id)?.[1];
  const refKeys = Object.keys(t).filter((k) => k.startsWith("ref:"));
  const bases = new Set([...settings.stop_ref_tags.filter((k) => !k.startsWith("gtfs:")), ...refKeys.filter((k) => refKeys.some((o) => o.startsWith(`${k}:`)))]);
  const suffixed = Object.keys(t).filter((k) => !bases.has(k) && (k.startsWith("ref:") || [...bases].some((base) => k.startsWith(`${base}:`))));
  const ownIds = tagValues(...[...bases].map((k) => t[k]), ...refKeys.flatMap((k) => tagValues(t[k]).filter((v) => t.ref && code(v) === t.ref)));
  const first = new Set([...tagValues(t.ref), ...ownIds]);
  const others = new Set(tagValues(...suffixed.map((k) => t[k])));
  const isFirst = (id) => first.has(id) || first.has(code(id));
  const isOther = (id) => !isFirst(id) && (others.has(id) || others.has(code(id)));
  const feedKeys = Object.keys(t).filter((k) => /^gtfs:stop_id:(?!\d+$).+/.test(k));
  const ofFeed = (ids) => ids.filter(isFirst).at(-1) ?? ids.filter((id) => !isOther(id)).at(-1) ?? ids.at(-1);
  const ids = tagValues(t["gtfs:stop_id"], ...feedKeys.map((k) => ofFeed(tagValues(t[k]))));
  const kept = ids.filter((id) => !isOther(id));
  if (!kept.some(isFirst) && ownIds.length) kept.push(ownIds[0]);
  return kept.length ? kept : ids;
}

/** Compact network and GTFS stop ids on exported platforms, without changing the in-memory tags used during processing. */
function outputPlatformTags(tags) {
  const out = { ...tags };
  const numberedNetworks = Object.keys(out).filter((k) => /^network:\d+$/.test(k)).sort((a, b) => Number(a.slice(8)) - Number(b.slice(8)));
  const networks = tagValues(out.network, ...numberedNetworks.map((k) => out[k]));

  if (numberedNetworks.length) {
    out.network = networks.join(";");
    numberedNetworks.forEach((k) => delete out[k]);
  }

  for (const key of ["network:wikidata", "network:wikipedia"]) {
    const numbered = Object.keys(out).filter((k) => k.startsWith(`${key}:`) && /^\d+$/.test(k.slice(key.length + 1)));
    const named = networks.slice(1).map((network) => `${key}:${networkSuffix(network)}`).filter((k) => k in out);
    const values = tagValues(out[key], ...numbered.sort((a, b) => Number(a.slice(key.length + 1)) - Number(b.slice(key.length + 1))).map((k) => out[k]),
      ...named.map((k) => out[k]));
    if (values.length) out[key] = values.join(";");
    for (const k of [...numbered, ...named]) delete out[k];
  }

  const feedStopIds = Object.keys(out).filter((k) => /^gtfs:stop_id:(?!\d+$).+/.test(k));
  const stopIds = exportedStopIds(out);
  if (stopIds.length) out["gtfs:stop_id"] = stopIds.join(";");
  for (const k of feedStopIds) delete out[k];

  // The stop code of a network that does not own the platform is not exported, it only serves while the priority can still change.
  const secondaryCode = (k) => /^gtfs:stop_code:[^:]+:./.test(k) || networks.slice(1).some((n) => k === `gtfs:stop_code:${networkSuffix(n)}`);
  for (const k of Object.keys(out).filter(secondaryCode)) delete out[k];
  return out;
}

/** Modified objects (and the nodes of their ways) as a JOSM .osm file. */
export function writeOsm(obj) {
  const keys = new Set(obj.modified.keys());
  for (const [key, o] of obj.modified) if (key[0] === "w") for (const n of o.nodes) keys.add(n);
  const order = (k) => "nwr".indexOf(k[0]);
  const sorted = [...keys].filter((k) => obj.has(k)).sort((a, b) => order(a) - order(b) || (a < b ? -1 : a > b ? 1 : 0));

  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<osm version="0.6" generator="tissway" upload="true">'];
  for (const key of sorted) {
    const o = obj.get(key);
    let attrs = `id="${key.slice(1)}"`;
    if (o.version) attrs += ` version="${o.version}"`;
    if (obj.modified.has(key)) attrs += ' action="modify"';
    if (key[0] === "n") attrs += ` lat="${o.lat.toFixed(7)}" lon="${o.lon.toFixed(7)}"`;
    const body = [];
    for (const n of o.nodes || []) body.push(`    <nd ref="${n.slice(1)}" />`);
    for (const [ref, role] of o.members || []) {
      body.push(`    <member type="${MEMBER_TYPES[ref[0]]}" ref="${ref.slice(1)}" role="${escapeXml(role)}" />`);
    }
    const tags = o.tags.public_transport === "platform" ? outputPlatformTags(o.tags) : o.tags;
    for (const [k, v] of Object.entries(tags)) body.push(`    <tag k="${escapeXml(k)}" v="${escapeXml(v)}" />`);
    const tag = MEMBER_TYPES[key[0]];
    lines.push(...(body.length ? [`  <${tag} ${attrs}>`, ...body, `  </${tag}>`] : [`  <${tag} ${attrs} />`]));
  }
  lines.push("</osm>", "");
  return lines.join("\n");
}

const XML_TAG = /<(\/?)([\w:-]+)((?:\s+[\w:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
const XML_ATTR = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** Root element of an .osm file as {name, attrs: {}, children: []} (enough for the flat format of OSM XML). */
export function parseXml(text) {
  const root = { name: "", attrs: {}, children: [] }, stack = [root];
  for (const m of text.matchAll(XML_TAG)) {
    if (m[1]) {
      stack.pop();
      continue;
    }
    const attrs = {};
    for (const a of m[3].matchAll(XML_ATTR)) attrs[a[1]] = unescapeXml(a[2] ?? a[3] ?? "");
    const el = { name: m[2], attrs, children: [] };
    stack.at(-1).children.push(el);
    if (!m[4]) stack.push(el);
  }
  if (!root.children[0]) throw new Error("Ce fichier ne contient pas de données OSM XML.");
  return root.children[0];
}

/** Text of an element tree of parseXml. */
export function serializeXml(root) {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>'];
  const write = (el, indent) => {
    const attrs = Object.entries(el.attrs).map(([k, v]) => ` ${k}="${escapeXml(v)}"`).join("");
    if (!el.children.length) return void lines.push(`${indent}<${el.name}${attrs} />`);
    lines.push(`${indent}<${el.name}${attrs}>`);
    for (const c of el.children) write(c, `${indent}  `);
    lines.push(`${indent}</${el.name}>`);
  };
  write(root, "");
  return `${lines.join("\n")}\n`;
}
