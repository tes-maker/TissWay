// OSM objects and the .osm file for JOSM.
//
// Objects are kept in a Store under keys "n123" / "w123" / "r123" (type + id):
// - node: {version, tags, lat, lon}
// - way: {version, tags, nodes: ["n1", "n2", ...]}
// - relation: {version, tags, members: [["w123", "role"], ...]}
// Objects created by the tool have a negative id ("n-12") and no version.

import { overpass } from "./net.js";
import { CODE_IN_ID, NETWORK_KEYS, numberedNetworks, refKeyFor } from "./platforms.js";
import { settings } from "./settings.js";
import { sameTags, setList, splitTag, unique } from "./util.js";

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
    this.originals = new Map(); // what OSM has of objects read apart from the base (existing relations)
  }

  /** The object of OSM that key was read as, undefined for a new one. */
  original(key) {
    return this.originals.get(key) ?? this.base.get(key);
  }

  /** New value of an object read apart from the base: original is what OSM has, to tell whether anything changed. */
  update(key, original, value) {
    this.originals.set(key, original);
    this.modified.set(key, value);
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
const GTFS_ID_KEY = /^gtfs:(?:shape|trip|route|stop)_id(?::|$)/;

/** A GTFS id with its first part repeated, as some imports left them in OSM: "NOMAD:NOMAD:2686$1072220$1618" -> "NOMAD:2686$1072220$1618". Only a
 * part starting with a letter, at the start: "FR:14118:14118:X" may be what the feed says. */
export const cleanGtfsId = (id) => id.replace(/^([A-Za-z][\w-]*)(?::\1)+(?=:)/, "$1");

/** Tags with their GTFS ids corrected (cleanGtfsId), each id once: the same object if there is nothing to correct. */
export function cleanGtfsIds(tags) {
  let out = tags;
  for (const [k, v] of Object.entries(tags)) {
    if (!GTFS_ID_KEY.test(k)) continue;
    const ids = v.split(";").map((id) => id.trim());
    const cleaned = ids.map(cleanGtfsId);
    if (cleaned.every((id, i) => id === ids[i])) continue;
    if (out === tags) out = { ...tags };
    out[k] = unique(cleaned).join(";");
  }
  return out;
}

/** The objects of an Overpass answer, their GTFS ids corrected as soon as they are read, so that they compare with the feed. Such an object has
 * correctedIds set: it has to go in the file even when nothing else changes on it. Its osmTags are the tags as mapped. */
export function fromOverpass(elements) {
  const out = {};
  for (const e of elements) {
    const tags = cleanGtfsIds(e.tags || {});
    const o = { version: String(e.version ?? ""), tags, ...(tags !== e.tags && e.tags ? { correctedIds: true, osmTags: e.tags } : {}) };
    if (e.type === "node") Object.assign(o, { lat: e.lat, lon: e.lon });
    if (e.type === "way") o.nodes = (e.nodes || []).map((n) => `n${n}`);
    if (e.type === "relation") o.members = (e.members || []).map((m) => [`${KIND[m.type]}${m.ref}`, m.role || ""]);
    if (e.center) o.center = [e.center.lat, e.center.lon];
    out[`${KIND[e.type]}${e.id}`] = o;
  }
  return out;
}

const NOT_ROADS = new Set(["footway", "path", "pedestrian", "platform", "steps", "cycleway", "corridor", "bridleway"]);
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

/** The nodes and ways with these keys, ways with their center. */
export async function readObjects(keys) {
  const list = [...keys];
  return { ...(await readNodes(list)), ...(await inBatches(numericIds(list, "w"), (ids) => `way(id:${ids});out meta center;`)) };
}

/** Those of these nodes that are on a road: a highway=* other than for people on foot. */
export async function onRoad(keys) {
  const ways = await inBatches(numericIds(keys, "n"), (ids) => `node(id:${ids});way(bn)[highway];out body;`);
  const road = Object.values(ways).filter((w) => w.nodes && !NOT_ROADS.has(w.tags.highway));
  const wanted = new Set(keys);
  return new Set(road.flatMap((w) => w.nodes).filter((n) => wanted.has(n)));
}

/** Every relation with one of these nodes or ways as a member, whatever its mode, and their route_masters. */
export async function relationsOfStops(keys) {
  const read = (kind, member, type) => inBatches(numericIds(keys, kind), (ids) => `${type}(id:${ids});relation(${member})->.r;.r out body;relation(br.r)[route_master]->.m;.m out body;`);
  return { ...(await read("n", "bn", "node")), ...(await read("w", "bw", "way")) };
}

/** Relations containing these ways. */
export const parentRelations = (keys) => inBatches(numericIds(keys, "w"), (ids) => `way(id:${ids});rel(bw);out meta;`);

const bboxText = (b) => b.map((x) => x.toFixed(6)).join(",");

/** OSM bus stops and platforms in a bbox (ways with their center), for stops.matchStops. */
export const platformsIn = (box) => {
  const b = bboxText(box);
  return overpass(`(node[highway=bus_stop](${b});node[public_transport=platform](${b});way[public_transport=platform](${b}););out meta center;`)
    .then(fromOverpass);
};

/** The stop_positions within radius metres of these points [lat, lon], the roads they are on, and the nodes of these roads. */
export const stopPositionsAround = (points, radius) => {
  const around = points.map(([lat, lon]) => `node[public_transport=stop_position](around:${radius},${lat},${lon});`).join("");
  return overpass(`(${around})->.s;.s out meta;way(bn.s)[highway]->.w;.w out meta;node(w.w);out meta;`).then(fromOverpass);
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

const tagValues = (...values) => unique(values.flatMap((v) => splitTag(v)));

/** The ref tags of a platform, whatever the names of its networks (ref:Nomad can be the ref of Nomad Car): bases are the tags holding a stop id without suffix
 * (ref:FR:Atoumod when ref:FR:Atoumod:Nomad exists), suffixed the tags of the other networks. */
function refTags(t) {
  const refKeys = Object.keys(t).filter((k) => k.startsWith("ref:"));
  const bases = new Set([...settings.stop_ref_tags.filter((k) => !k.startsWith("gtfs:")), ...refKeys.filter((k) => refKeys.some((o) => o.startsWith(`${k}:`)))]);
  const suffixed = Object.keys(t).filter((k) => !bases.has(k) && (k.startsWith("ref:") || [...bases].some((base) => k.startsWith(`${base}:`))));
  return { refKeys, bases, suffixed };
}

/** Stop ids exported for a platform: the stop of the first network, the one of the tags without suffix (ref=chuo02, ref:FR:Atoumod=FR:14118:ZE:chuo02:...), taken from
 * these tags if needed. The id of another network is left out, its ref:*:<network> holds it (network names do not matter: ref:Nomad can be the ref of Nomad Car), unless
 * nothing else remains. An id that no ref tells about is of another feed, and stays. Without any ref to tell, the last id of a feed. */
function exportedStopIds(t) {
  const code = (id) => CODE_IN_ID.exec(id)?.[1];
  const { refKeys, bases, suffixed } = refTags(t);
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
  const numberedKeys = numberedNetworks(out);
  const networks = tagValues(out.network, ...numberedKeys.map((k) => out[k]));

  if (numberedKeys.length) {
    out.network = networks.join(";");
    numberedKeys.forEach((k) => delete out[k]);
  }

  for (const key of NETWORK_KEYS.slice(1)) {
    const numbered = Object.keys(out).filter((k) => k.startsWith(`${key}:`) && /^\d+$/.test(k.slice(key.length + 1)));
    const named = networks.slice(1).map((network) => refKeyFor(key, network)).filter((k) => k in out);
    const values = tagValues(out[key], ...numbered.sort((a, b) => Number(a.slice(key.length + 1)) - Number(b.slice(key.length + 1))).map((k) => out[k]),
      ...named.map((k) => out[k]));
    if (values.length) out[key] = values.join(";");
    for (const k of [...numbered, ...named]) delete out[k];
  }

  const feedStopIds = Object.keys(out).filter((k) => /^gtfs:stop_id:(?!\d+$).+/.test(k));
  const stopIds = exportedStopIds(out);
  if (stopIds.length) out["gtfs:stop_id"] = stopIds.join(";");
  for (const k of feedStopIds) delete out[k];
  return out;
}

/** Without the stop codes that repeat a ref or belong to a network that does not own the stop. In memory they serve while the priority can still change, a file never
 * has them, on any object: no gtfs:stop_code:<feed>:<network>, gtfs:stop_code:<network> or numbered key, and no gtfs:stop_code[:<feed>] value that is a ref of the platform. */
function withoutSecondaryStopCodes(tags) {
  const out = { ...tags };
  const networks = tagValues(tags.network, ...Object.keys(tags).filter((k) => /^network:\d+$/.test(k)).map((k) => tags[k])).slice(1);
  const secondary = (k) => /^gtfs:stop_code:(?:[^:]+:.|\d+$)/.test(k) || networks.some((n) => k === refKeyFor("gtfs:stop_code", n));
  const codes = Object.keys(out).filter((k) => k.startsWith("gtfs:stop_code"));
  for (const k of codes.filter(secondary)) delete out[k];
  const refs = new Set(tagValues(tags.ref, ...refTags(tags).suffixed.map((k) => tags[k])));
  for (const k of codes.filter((c) => c in out)) {
    setList(out, k, tagValues(out[k]).filter((v) => !refs.has(v)));
  }
  return out;
}

/** The tags of an object in a file. */
const outputTags = (tags) => withoutSecondaryStopCodes(tags.public_transport === "platform" ? outputPlatformTags(tags) : tags);

const sameList = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Does the object o, as a file writes it, differ from what OSM has (original)? A new object does, and one whose GTFS ids were corrected when read (see fromOverpass). */
export function differsFromOsm(o, original) {
  if (!original || original.correctedIds) return true;
  return !sameTags(outputTags(o.tags ?? {}), original.tags ?? {}) || o.lat !== original.lat || o.lon !== original.lon || !sameList(o.nodes, original.nodes) || !sameList(o.members, original.members);
}

/** Does this file change anything in OSM? */
export const changesOsm = (obj) => [...obj.modified].some(([key, o]) => differsFromOsm(o, obj.original(key)));

/** Modified objects (and the nodes of their ways) as a JOSM .osm file. Only what differs from OSM is marked action="modify", the only objects JOSM uploads.
 * asIs: the tags are written exactly as they are in obj, without the form of a file, and every modified object is marked. */
export function writeOsm(obj, { asIs = false } = {}) {
  const keys = new Set(obj.modified.keys());
  for (const [key, o] of obj.modified) if (key[0] === "w") for (const n of o.nodes) keys.add(n);
  const order = (k) => "nwr".indexOf(k[0]);
  const sorted = [...keys].filter((k) => obj.has(k)).sort((a, b) => order(a) - order(b) || (a < b ? -1 : a > b ? 1 : 0));

  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<osm version="0.6" generator="tissway" upload="true">'];
  for (const key of sorted) {
    const o = obj.get(key);
    const tags = asIs ? o.tags : outputTags(o.tags);
    let attrs = `id="${key.slice(1)}"`;
    if (o.version) attrs += ` version="${o.version}"`;
    if (asIs ? obj.modified.has(key) : differsFromOsm(o, obj.original(key))) attrs += ' action="modify"'; // also a node of a way whose tags change here: it has to be uploaded too
    if (key[0] === "n") attrs += ` lat="${o.lat.toFixed(7)}" lon="${o.lon.toFixed(7)}"`;
    const body = [];
    for (const n of o.nodes || []) body.push(`    <nd ref="${n.slice(1)}" />`);
    for (const [ref, role] of o.members || []) {
      body.push(`    <member type="${MEMBER_TYPES[ref[0]]}" ref="${ref.slice(1)}" role="${escapeXml(role)}" />`);
    }
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
