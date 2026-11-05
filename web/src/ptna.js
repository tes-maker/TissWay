// Update or generate the PTNA route list (CSV format of the OSM wiki) of a network from the GTFS.
//
// The input is the text of the wiki page (or only its <pre>…</pre> block). Everything that is not a CSV line (titles "=",
// texts "-", comments "#") is copied as is. For each CSV line of the network, found by its GTFS route_id (8th field):
// - the comment (3rd field) gets the termini of the GTFS variants, like the route_master names; when route_long_name reads
//   "A <> B via X", the termini follow the order A, B and "via X" is appended; route_long_name when the route has no trip;
// - the type (2nd field) follows the GTFS route_type; the GTFS feed is filled in when empty;
// - the operator (6th field) only comes from the operator option, else settings.operators: PTNA compares it with the operator of the OSM relations, and the
//   agency of a GTFS is often not the real operator. Existing values are kept;
// - the ref (1st field) is kept, since it must stay the one of the OSM tags: differences with route_short_name are reported,
//   and refGtfs replaces them;
// - a CSV line without route_id gets the one of the only GTFS route of that number not listed yet;
// - a line whose route_id is no longer in the GTFS is commented out ("#");
// - GTFS routes missing from the file are inserted at their place among the listed routes of the same sub-section
//   (settings.ptna.sections), or of the same mode; if there are none, they go to a "new routes" section to sort out.
// CSV lines of other networks (different route_id prefix) are left unchanged.
//
// Without input, the complete list of the network is generated: one "==" section per mode, split into "===" sub-sections
// according to settings.ptna.sections, in a complete wiki page described by settings.ptna.pages.
//
// The wiki texts are in English (TEXT); the PTNA options of the Settings page can replace them (settings.ptna.text).

import { feedCodeOf } from "./detect.js";
import { listIn, log } from "./util.js";
import { splitCsvLine, lineVariants, osmRoute, stopSequences } from "./gtfs.js";
import { lookup } from "./lookup.js";
import { agencyNetworks, cleanStopName, fixAccents, masterEndpointsLabel, operatorOf, routeLabel, unaccent, words } from "./naming.js";
import { activeFeed, settings } from "./settings.js";
import { compare, counter, sortedBy } from "./util.js";

const MODES = ["tram", "subway", "train", "bus", "coach", "ferry", "aerialway", "funicular", "trolleybus", "monorail"];

const TEXT = {
  modes: { tram: "Tram lines", subway: "Subway lines", train: "Train lines", bus: "Bus lines", coach: "Coach lines", ferry: "Ferry lines",
    aerialway: "Aerialways", funicular: "Funiculars", trolleybus: "Trolleybus lines", monorail: "Monorails" },
  other: "Other lines",
  new: "New lines (GTFS of {date:%Y-%m-%d}, to sort out)",
  csv_intro: "This page follows the CSV format of PTNA. For more information, see [[Public Transport Network Analysis/Syntax of CSV data]].",
  tool: "# This data is entered for the tool: PTNA - Public Transport Network Analysis (https://ptna.openstreetmap.de)",
  overview: "= Overview of the {title}",
  default_title: "{network} network",
  overview_link: "- An overview of the {link} is available in the OSM wiki.",
  page_link: "- Configuration file for this analysis: {link}.",
  config_link: "- Configuration file of [/en/config.php?network={ptna} PTNA]",
  platform_suffix: "[\\s-]+(?:platform|bay|stand|stop)\\s*\\w{1,2}$",
};

// termini of a variant kept in the comment if it makes at least this share of the trips of the route (leaves out school or
// depot trips: "A1 / A2 / A3 ↔ B" is unreadable)
const MIN_VARIANT_SHARE = 0.1;
const MAX_VARIANTS = 4;
const [REF, TYPE, COMMENT, , , OPERATOR, FEED, ROUTE_ID] = [0, 1, 2, 3, 4, 5, 6, 7];
const MIN_FIELDS = 9; // ref;type;comment;from;to;operator;gtfs_feed;route_id;release_date

function text() {
  const custom = settings.ptna.text || {};
  return { ...TEXT, ...custom, modes: { ...TEXT.modes, ...custom.modes } };
}

/** "{title}" and "{date:%d/%m/%Y}" of a wiki text. */
function fill(template, values) {
  return template.replace(/\{(\w+)(?::([^}]*))?\}/g, (_, name, format) => {
    if (!format) return values[name];
    const d = values[name], pad = (n) => String(n).padStart(2, "0");
    return format.replace("%Y", d.getFullYear()).replace("%m", pad(d.getMonth() + 1)).replace("%d", pad(d.getDate()));
  });
}

const sections = () => settings.ptna.sections || {};
const pageSettings = (network) => settings.ptna.pages?.[network] || {};
const ptnaType = (routeType, fallback = "bus") => osmRoute(routeType) || fallback;

/** Map network name -> its GTFS routes, with network and operator (agencies with the same network tag merged). */
export async function loadNetworks(feed) {
  const agency = await feed.agency();
  const networks = agencyNetworks(agency);
  const names = new Map(agency.map((a) => [a.agency_id, a.agency_name]));
  const out = new Map();
  for (const r of await feed.routes()) {
    const network = networks[r.agency_id]?.network ?? (r.agency_id || "GTFS");
    listIn(out, network).push({ ...r, network, operator: "", agency_name: names.get(r.agency_id) ?? "" });
  }
  return out;
}

/** Map route_id -> "LOCALITY Stop ↔ LOCALITY Stop" from the termini of its variants (same name as the route_master). */
async function endpointLabels(feed, routes) {
  const ids = new Set(routes.map((r) => r.route_id));
  const selected = (await feed.trips()).filter((t) => ids.has(t.route_id));
  const trips = stopSequences(selected, await feed.stopTimes(selected.map((t) => t.trip_id)));
  const stops = new Map((await feed.stops()).map((s) => [s.stop_id, s]));
  const lang = await feed.language();
  const termini = new Set(trips.flatMap((t) => [t.stop_seq[0], t.stop_seq.at(-1)]));
  const accents = settings.fix_accents ? await lookup.accents([...termini].flatMap((id) => words(stops.get(id)?.stop_name || "")), lang) : new Map();
  const suffix = new RegExp(text().platform_suffix, "i");
  const spellings = new Map(); // same stop spelt differently ("Presqu'île" / "Presqu'Île"): first spelling

  const label = async (stopId) => {
    const s = stops.get(stopId);
    const clean = s && fixAccents(cleanStopName(s.stop_name), accents).replace(suffix, "");
    const name = s ? routeLabel(await lookup.placesAt(s.lat, s.lon, lang), clean) : stopId;
    const key = unaccent(name).toLowerCase();
    if (!spellings.has(key)) spellings.set(key, name);
    return spellings.get(key);
  };

  const byRoute = new Map();
  for (const t of trips) {
    listIn(byRoute, t.route_id).push(t);
  }
  const labels = new Map();
  for (const [routeId, routeTrips] of byRoute) {
    const counts = counter(routeTrips.map((t) => t.stop_seq.join("\u0001")));
    const count = (seq) => counts.get(seq.join("\u0001"));
    const variants = lineVariants(routeTrips).map((v) => v.seq);
    let main = variants.filter((seq) => count(seq) >= MIN_VARIANT_SHARE * routeTrips.length);
    if (!main.length) main = variants.slice(0, 1);
    main = sortedBy(main, (seq) => -count(seq)).slice(0, MAX_VARIANTS);
    if (main.length) labels.set(routeId, masterEndpointsLabel(await Promise.all(main.map(async (seq) => [await label(seq[0]), await label(seq.at(-1))]))));
  }
  return labels;
}

/** Final comment from a GTFS route_long_name "A <> B via X": termini in the order A then B, "via X" appended; without
 * computed termini, the route_long_name with "↔". */
export function withLongName(label, longName) {
  const name = cleanStopName(longName);
  if (!label) return name.replace(/\s*<>\s*/g, " ↔ ");
  const m = /^(.+?)\s*<>\s*(.+?)(\s+via\s+.+)?$/i.exec(name);
  if (!m) return label;
  const [, a, b, via] = m;
  const sides = label.split(" ↔ ");
  const norm = (x) => unaccent(x).toLowerCase().replace(/[\s'-]+/g, " ");
  let out = label;
  if (sides.length === 2) {
    const [left, right] = sides.map(norm);
    if ((right.includes(norm(a)) && !left.includes(norm(a))) || (left.includes(norm(b)) && !right.includes(norm(b)))) out = `${sides[1]} ↔ ${sides[0]}`;
  }
  return out + (via || "");
}

function isCsvLine(line) {
  const s = line.trim();
  return Boolean(s) && s.includes(";") && !"=-#@+<".includes(s[0]);
}

export function parseFields(line) {
  const fields = splitCsvLine(line.trim(), ";");
  while (fields.length < MIN_FIELDS) fields.push("");
  return fields;
}

/** Fields -> PTNA CSV line: comment always quoted (as on the wiki), the others only if they contain ; or ". */
export function formatFields(fields) {
  return fields.map((v, i) => ((i === COMMENT && v) || v.includes(";") || v.includes('"') ? `"${v.replace(/"/g, '""')}"` : v)).join(";");
}

/** Natural sort of route numbers: 6 < 6A < 6B < 7 < 12 < 137 < 137A < 138 < NAV < T1. */
export function refKey(route) {
  const [, num, rest] = /^(\d*)(.*)$/s.exec(route.route_short_name);
  return num ? [0, Number(num), rest] : [1, 0, rest];
}

/** [[mode title, sub-section title or null], [mode order, sub-section rank]] of a GTFS route. */
function sectionOf(route, network) {
  const mode = ptnaType(route.route_type);
  const title = text().modes[mode] ?? mode;
  const rules = sections()[network] || [];
  let rank = rules.findIndex(([, rx]) => new RegExp(`^(?:${rx})$`, "i").test(route.route_short_name));
  if (rank < 0) rank = rules.length;
  const order = MODES.includes(mode) ? MODES.indexOf(mode) : MODES.length;
  return [[title, rank < rules.length ? rules[rank][0] : null], [order, rank]];
}

const gtfsFields = (r) => [r.route_short_name, ptnaType(r.route_type), r.label, "", "", r.operator, activeFeed(), r.route_id, ""];

/** CSV lines grouped: "== mode" then "=== sub-section" (titles of level level and level + 1). */
function render(routes, network, level = 2) {
  const groups = new Map();
  for (const r of routes) {
    const [[mode, sub], rank] = sectionOf(r, network);
    const key = rank.join(":");
    if (!groups.has(key)) groups.set(key, { mode, sub, rank, routes: [] });
    groups.get(key).routes.push(r);
  }
  const renamed = pageSettings(network).modes || {};
  const out = [];
  let lastMode = null, subs = new Set();
  for (const g of sortedBy(groups.values(), (x) => x.rank)) {
    if (g.mode !== lastMode) {
      if (lastMode) out.push("-");
      out.push(`${"=".repeat(level)} ${renamed[g.mode] ?? g.mode}`);
      lastMode = g.mode;
      subs = new Set([...groups.values()].filter((x) => x.mode === g.mode).map((x) => x.sub));
    }
    if (!(subs.size === 1 && subs.has(null))) out.push(`${"=".repeat(level + 1)} ${g.sub || text().other}`);
    out.push(...sortedBy(g.routes, refKey).map((r) => formatFields(gtfsFields(r))));
  }
  return out.length ? [...out, "-"] : out;
}

/** [updated lines of the file, report messages]. */
export function update(lines, routes, network, refGtfs = false, forceOperator = false) {
  const byId = new Map(routes.map((r) => [r.route_id, r]));
  const prefixes = new Set([...byId.keys()].map((i) => i.split(":")[0]));
  const parsed = lines.map((line) => [line, isCsvLine(line) ? parseFields(line) : null]);
  const listed = new Set(parsed.filter(([, f]) => f && byId.has(f[ROUTE_ID])).map(([, f]) => f[ROUTE_ID]));
  const out = [], report = [], positions = new Map();

  for (const [line, fields] of parsed) {
    if (!fields) {
      out.push(line);
      continue;
    }
    let rid = fields[ROUTE_ID];
    if (!rid) {
      const candidates = [...byId].filter(([i, r]) => r.route_short_name === fields[REF] && !listed.has(i)).map(([i]) => i);
      if (candidates.length !== 1) {
        out.push(line);
        continue;
      }
      rid = fields[ROUTE_ID] = candidates[0];
      listed.add(rid);
      report.push(`${fields[REF]}: route_id added (${rid})`);
    }
    if (!byId.has(rid)) {
      if (prefixes.has(rid.split(":")[0])) {
        out.push(`# ${line.trim()}`);
        report.push(`${fields[REF]}: ${rid} not in the GTFS any more, line commented out`);
      } else out.push(line);
      continue;
    }
    const route = byId.get(rid);
    positions.set(rid, out.length);
    const fresh = [...fields];
    fresh[TYPE] = ptnaType(route.route_type, fields[TYPE]);
    fresh[COMMENT] = route.label || fields[COMMENT];
    fresh[OPERATOR] = forceOperator || !fields[OPERATOR] ? route.operator : fields[OPERATOR];
    if (fresh[OPERATOR] !== fields[OPERATOR]) report.push(`${fresh[REF]}: operator '${fields[OPERATOR]}' -> '${fresh[OPERATOR]}'`);
    fresh[FEED] = fields[FEED] || activeFeed();
    if (fields[REF] !== route.route_short_name) {
      if (refGtfs || !fields[REF]) {
        fresh[REF] = route.route_short_name;
        report.push(`${fields[REF] || "(empty)"} -> ${fresh[REF]}: ref replaced (${rid})`);
      } else report.push(`${fields[REF]}: ref differs from the GTFS '${route.route_short_name}' (${rid}), kept`);
    }
    if (fresh[COMMENT] !== fields[COMMENT]) report.push(`${fresh[REF]}: '${fields[COMMENT]}' -> '${fresh[COMMENT]}'`);
    if (fresh[TYPE] !== fields[TYPE]) report.push(`${fresh[REF]}: type ${fields[TYPE]} -> ${fresh[TYPE]}`);
    out.push(fresh.some((v, i) => v !== fields[i]) ? formatFields(fresh) : line);
  }

  // new routes: among the listed routes of the same sub-section (or of the same mode)
  const placed = new Map(); // rank of the sub-section -> [[sort key, position in out]]
  for (const [rid, pos] of positions) {
    const key = sectionOf(byId.get(rid), network)[1].join(":");
    listIn(placed, key).push([refKey(byId.get(rid)), pos]);
  }
  const inserts = [], unplaced = [];
  for (const [i, r] of byId) {
    if (listed.has(i)) continue;
    const [[mode, sub], rank] = sectionOf(r, network);
    const same = placed.get(rank.join(":"));
    if (!same) {
      unplaced.push(r);
      continue;
    }
    const before = same.filter(([k]) => compare(k, refKey(r)) < 0).map(([, pos]) => pos);
    const pos = before.length ? Math.max(...before) + 1 : Math.min(...same.map(([, p]) => p));
    inserts.push([pos, refKey(r), r]);
    report.push(`${r.route_short_name}: new line (${r.route_id}), section '${sub || mode}'`);
  }
  inserts.sort((a, b) => compare(b[0], a[0]) || compare(b[1], a[1]));
  for (const [pos, , r] of inserts) out.splice(pos, 0, formatFields(gtfsFields(r)));
  if (unplaced.length) {
    const section = [`== ${fill(text().new, { date: new Date() })}`, ...render(unplaced, network, 3)];
    report.push(...unplaced.map((r) => `${r.route_short_name}: new line (${r.route_id}), to sort out`));
    let end = out.length;
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i].trim().toLowerCase() === "</pre>") {
        end = i;
        break;
      }
    }
    out.splice(end, 0, ...section);
  }
  return [out, report];
}

/** [complete PTNA wiki page of the network, report]. */
export function generate(title, network, routes) {
  const t = text(), page = pageSettings(network);
  const ptna = page.ptna_id || (settings.ptna.id_prefix || "") + unaccent(title).replace(/[^A-Za-z0-9]/g, "");
  const intro = [];
  if (page.overview) intro.push(fill(t.overview_link, { link: page.overview }), "-");
  if (page.page) intro.push(fill(t.page_link, { link: page.page }), "-");
  intro.push(fill(t.config_link, { ptna }), "-");
  const heading = page.title || fill(t.default_title, { network: title });
  const out = [t.csv_intro, "", "<pre>", "#", t.tool, "#", "", fill(t.overview, { title: heading }), "", ...intro, "", "", ...render(routes, network)];
  const categories = page.categories ?? settings.ptna.categories ?? ["PTNA"];
  out.push("", "</pre>", "", categories.map((c) => `[[Category:${c}]]`).join(""));
  return [out, [`${routes.length} lines generated`]];
}

/** [lines, report] of the PTNA list of network: inputLines updated, or a new page if null. */
export async function buildList(feed, network, { inputLines = null, title = null, operator = null, refGtfs = false } = {}) {
  const routes = (await loadNetworks(feed)).get(network);
  if (!routes) throw new Error(`Unknown network "${network}"`);
  const labels = await endpointLabels(feed, routes);
  if (settings.feed === "auto") {
    settings.feed = await feedCodeOf(feed);
    if (!settings.feed) log.warn("No GTFS feed code found in OSM for this feed: the gtfs-feed field stays empty. Set its code from the OSM wiki's List of GTFS feeds in Settings.");
  }
  const forced = operator || operatorOf(network);
  const final = routes.map((r) => ({ ...r, operator: forced || r.operator, label: withLongName(labels.get(r.route_id) ?? null, r.route_long_name) }));
  if (inputLines) return update(inputLines, final, network, refGtfs, Boolean(forced));
  return generate(title || network, network, final);
}
