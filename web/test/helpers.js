// Shared by the tests: settings reset before each test, a ZIP writer, approx assertion.
import assert from "node:assert/strict";
import { beforeEach } from "node:test";
import { deflateRawSync } from "node:zlib";
import { configure } from "../src/settings.js";
import { log } from "../src/util.js";

log.sink = () => {}; // silent journal
beforeEach(() => configure());

export const approx = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b} (± ${tol})`);

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** Blob of a ZIP archive {name: text}, deflated. */
export function makeZip(files) {
  const locals = [], central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text), data = deflateRawSync(raw), n = Buffer.from(name);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(8, 8);
    head.writeUInt32LE(crc32(raw), 14);
    head.writeUInt32LE(data.length, 18);
    head.writeUInt32LE(raw.length, 22);
    head.writeUInt16LE(n.length, 26);
    locals.push(head, n, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(8, 10);
    c.writeUInt32LE(crc32(raw), 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(raw.length, 24);
    c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Blob([...locals, cd, end]);
}

// --- what PTNA checks on a route relation (bin/ptna-routes.pl, osm-ToniE/ptna) ------------------------------------------------

/** TagNameMatchesOtherName of PTNA: its relaxed comparison of from / via / to with a part of the name, or with a platform name. */
export function ptnaMatches(tagName, otherName) {
  const clean = (s) => s.replace(/\s*\(.*?\)/, "");
  const a = clean(tagName), b = clean(otherName);
  if (a === b) return true;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const fits = (x, y) => [`^${esc(x)}\\.$`, `^${esc(x)}[ /,-]\\s*\\S`, `\\S\\s*[ /,-]${esc(x)}$`, `\\S\\s*[ /,-]${esc(x)}[ /,-]\\s*\\S`].some((r) => new RegExp(r).test(y));
  return fits(a, b) || fits(b, a);
}

/** Messages PTNA would give on a route relation {tags, members}, with its relaxed comparison of names (--check-name-relaxed reads "→"; its strict
 * --check-name wants "=>", a note accepted for the titles of this project). nameOf(key): name of a platform. */
export function ptnaProblems({ tags, members }, nameOf) {
  const out = [];
  for (const k of ["name", "ref", "network", "from", "to", "public_transport:version"]) if (!tags[k]) out.push(`${k} is not set`);
  if (tags["public_transport:version"] !== "2") out.push("not PTv2");
  const m = /^(.*):\s*(.*)$/.exec(tags.name || "");
  const stops = m ? m[2].split(/\s*(?:=>|->|→|⇒)\s*/) : [];
  if (stops.length < 2) return [...out, `'name' is not of the form '... ref ...: from → to': ${tags.name}`];
  if (!m[1].includes(tags.ref)) out.push("'ref' is not part of 'name'");
  if (!ptnaMatches(tags.from, stops[0])) out.push(`from-part '${stops[0]}' does not match from '${tags.from}'`);
  if (!ptnaMatches(tags.to, stops.at(-1))) out.push(`to-part '${stops.at(-1)}' does not match to '${tags.to}'`);
  const vias = stops.slice(1, -1), values = tags.via ? tags.via.split(";") : [];
  if (vias.length !== values.length) out.push(`${vias.length} via-part(s) in 'name', ${values.length} in 'via'`);
  vias.forEach((v, i) => { if (values[i] && !ptnaMatches(values[i], v)) out.push(`via-part '${v}' does not match '${values[i]}'`); });
  const platforms = members.filter(([, role]) => role === "platform").map(([key]) => nameOf(key));
  if (platforms[0] && !ptnaMatches(tags.from, platforms[0])) out.push(`from '${tags.from}' does not match the first platform '${platforms[0]}'`);
  if (platforms.at(-1) && !ptnaMatches(tags.to, platforms.at(-1))) out.push(`to '${tags.to}' does not match the last platform '${platforms.at(-1)}'`);
  for (const v of values) if (!platforms.includes(v)) out.push(`via '${v}' matches no platform`);
  const keys = Object.keys(tags).filter((k) => k.startsWith("gtfs:"));
  const suffixed = keys.filter((k) => /:[A-Z][A-Z][a-zA-Z0-9_.-]+$/.test(k));
  if (suffixed.length && suffixed.length < keys.length) out.push(`mixed GTFS keys: ${keys}`);
  const roles = members.map(([, role]) => role), firstWay = roles.indexOf("");
  if (firstWay >= 0 && roles.slice(firstWay).some((r) => r !== "")) out.push("stop or platform after a way");
  return out;
}
