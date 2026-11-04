// Names: network of a GTFS agency, stop labels used in relation names, relation names.
//
// Titles of the lines: route "Bus 12: VILLE Arret → VILLE Arret", "Bus 12: VILLE Arret → X → VILLE Arret" for variants sharing their termini; route_master
// "Bus 12: VILLE Arret ↔ VILLE Arret" ("A1 / A2 ↔ B" when several origins share a terminus). The stops are labelled by routeLabel; settings.stop_names = "town" renames the stops themselves (townedName).

import { settings } from "./settings.js";
import { counter, mostCommon } from "./util.js";

const MODE_LABELS = { bus: "Bus", coach: "Coach", trolleybus: "Trolleybus", tram: "Tram", train: "Train", subway: "Subway",
  ferry: "Ferry", monorail: "Monorail", funicular: "Funicular", aerialway: "Aerialway" };

export const unaccent = (s) => s.normalize("NFKD").replace(/\p{M}/gu, "");

export const slug = (s) => unaccent(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** Comparison key of a stop name: case, accents and punctuation ignored. */
export const nameKey = (name) => unaccent(name || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

// --- accents ---------------------------------------------------------------------------------------------

const isUpper = (s) => s === s.toUpperCase() && s !== s.toLowerCase();

/** spelling with the case of word: ("EGLISE", "église") -> "ÉGLISE", ("Ecole", "école") -> "École". */
function withCaseOf(word, spelling) {
  if (isUpper(word) && word.length > 1) return spelling.toUpperCase();
  return word[0] === word[0].toUpperCase() ? spelling[0].toUpperCase() + spelling.slice(1) : spelling;
}

export const words = (name) => name.match(/\p{L}+/gu) || [];

/** name with the words of accents (Map lower-case ascii word -> spelling) replaced, keeping the case of each word. */
export function fixAccents(name, accents) {
  return name.replace(/\p{L}+/gu, (w) => {
    const spelling = accents.get(w.toLowerCase());
    return spelling ? withCaseOf(w, spelling) : w;
  });
}

/** name with the accents of other, when they are the same words apart from accents and case ("Gare Routiere", "GARE ROUTIÈRE"
 * -> "Gare Routière"). Otherwise name, unchanged. */
export function accentsFrom(name, other) {
  if (!other || unaccent(name).toLowerCase() !== unaccent(other).toLowerCase()) return name;
  const theirs = words(other);
  let i = 0;
  return name.replace(/\p{L}+/gu, (w) => {
    const spelling = theirs[i++].toLowerCase();
    return unaccent(w) === w && spelling !== w.toLowerCase() ? withCaseOf(w, spelling) : w;
  });
}

/** Stop name as written on OSM objects: trimmed, single spaces. */
export const cleanStopName = (name) => String(name).trim().split(/\s+/).join(" ");

// --- networks ---------------------------------------------------------------------------------------------

/** agency_id -> network tags: settings.networks (by agency_id or agency_name) when configured, else derived from
 * agency_name ("Twisto (Caen la mer)" -> {network: "Twisto"}), never with an unverified operator or wikidata. */
export function agencyNetworks(agency) {
  const out = {};
  for (const { agency_id, agency_name } of agency) {
    const configured = settings.networks[agency_id] || settings.networks[agency_name];
    const derived = agency_name.split(" (")[0].trim() || agency_id || "GTFS";
    out[agency_id] = configured ? { ...configured } : { network: derived };
  }
  return out;
}

// --- localities -------------------------------------------------------------------------------------------

const LINK_WORDS = "(?:SUR|EN|LES?|LA|DE|DU|DES|AUX?)";
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const townWords = (ville) => ville.split(/[- ]+/).map((w) => (w === "SAINT" || w === "SAINTE" ? "(?:STE?|SAINTE?)" : escapeRegex(w)));
const upperTown = (town) => unaccent(town).toUpperCase();
const toList = (places) => [].concat(places || []).filter(Boolean);

/** name without the locality ville (upper case, unaccented) or its beginning when it repeats it ("Avranches - X", "St-Malo X", "Fleury X"
 * in Fleury-sur-Orne...). */
function stripLocality(ville, name) {
  const words = townWords(ville);
  const starts = [words.join("[ -]+")];
  for (let n = words.length - 1; n > 0; n--) {
    // beginning of the commune ("Fleury Mairie"), but not "Saint" alone or ending with a link word
    if (new RegExp(`^${LINK_WORDS}$`).test(words[n - 1]) || (n === 1 && words[0].startsWith("(?:"))) continue;
    // followed by a space or ":" (not "CONDE-SUR-NOIREAU"), then neither "/", a link word nor the rest of the commune ("PACY S/ EURE",
    // "Mont aux Malades", "NOTRE DAME D'ESTREES"). "[ :-]" in the negative lookahead makes [ :-]* consume every separator.
    starts.push(`${words.slice(0, n).join("[ -]+")}(?=$|[ :][ :-]*(?![ :-]|/|S/|D'|(?:${LINK_WORDS}|${words[n]})\\b))`);
  }
  const prefix = new RegExp(`^(?:${starts.join("|")})(?![\\p{L}\\p{N}])[ :\u2013\u2014-]*`, "iu").exec(unaccent(name));
  return prefix ? name.slice(prefix[0].length) : name;
}

const LINK = new RegExp(`^${LINK_WORDS}$`);
/** Upper-case words of a place or a stop name, "St" and "Ste" read as "Saint" and "Sainte". */
const tokens = (text) => unaccent(text).toUpperCase().split(/[^\p{L}\p{N}']+/u).filter(Boolean)
  .map((w) => ({ ST: "SAINT", STE: "SAINTE" }[w] ?? w));
const isSaint = (w) => w === "SAINT" || w === "SAINTE";

/** name without its town when it can be taken out: "Caen - Gare", "Gare - Caen", "Gare (Caen)", "Gare, Caen", "Mairie Gaillon". null if not
 * ("Hauts de Thaon" needs it). */
function withoutTown(town, name) {
  const ville = upperTown(town);
  const start = stripLocality(ville, name);
  if (start !== name) return start;
  const words = townWords(ville).join("[ -]+");
  const folded = unaccent(name);
  const end = new RegExp(`(?:\\s*(?:[,/\u2013\u2014-]\\s*|\\()|\\s+)${words}\\)?\\s*$`, "iu").exec(folded);
  if (!end) return null;
  const before = tokens(folded.slice(0, end.index));
  return before.length && LINK.test(before.at(-1)) ? null : name.slice(0, end.index);
}

/** Does the stop name say its town, in any form the feeds use? The whole town anywhere ("Hauts de Mondeville", "Clinique Les Damps"), or at
 * its start a proper part of it ("Norrey Calvaire" in Saint-Manvieu-Norrey, "CHERBOURG-GARE", "Saint-Pierre-sur-Dives" in
 * Saint-Pierre-en-Auge), but not a word that only looks like it ("Mont aux Malades" in Mont-Saint-Aignan, "Saint-Clair" elsewhere). */
function saysTown(town, name) {
  if (withoutTown(town, name) !== null) return true;
  const inName = tokens(name), all = tokens(town);
  const inTown = /^(?:LE|LA|LES|L')$/.test(all[0]) ? all.slice(1) : all;
  for (let i = 0; i + inTown.length <= inName.length; i++) if (inTown.every((w, k) => inName[i + k] === w)) return true;
  if (!inName.length || LINK.test(inName[1] ?? "")) return false;
  if (isSaint(inTown[0]) && inName[0] === inTown[0] && inName[1] === inTown[1]) return true;
  return inName[0].length > 3 && inTown.includes(inName[0]) && !LINK.test(inName[0]) && !isSaint(inName[0]);
}

/** Does the name begin with a place in capitals, maybe not the one the position gives: a former commune, or just over the boundary?
 * "CAEN Chemin Vert", "LE THEIL-SUR-HUISNE - École", "VENDEUVRES morieres", "MEZIDON-CANON: college", "COURTONNE LES 2 EGLISES: le bourg". */
const CAPITALS_FIRST = /^\p{Lu}[\p{Lu}'\u2019.\d/ -]{2,}?\s*:|^\p{Lu}[\p{Lu}'\u2019./ -]{2,}?\s[-\u2013\u2014]\s|^\p{Lu}[\p{Lu}'\u2019.-]{2,}(?: \p{Lu}[\p{Lu}'\u2019.-]*)*\s+(?:\p{Lu}[\p{Ll}'\u2019]|\p{Ll})/u;

const TAG_LIMIT = 255; // characters in an OSM tag value
const CAPITALS_THEN_SEPARATOR = /^(\p{Lu}[\p{Lu}'\u2019.\d/ -]{2,}?)(?:\s*:|\s[-\u2013\u2014])\s*/u;

/** Stop in the title of a line, "VILLE Arret", places being the names of the place of the stop, most precise first. A town the stop name says
 * already is moved first, never repeated; when it cannot be taken out ("Hauts de Mondeville") or the name begins with another place in
 * capitals, the name stays as it is, without its separator. */
export function routeLabel(places, name) {
  const towns = toList(places);
  for (const town of towns) {
    const rest = withoutTown(town, name);
    if (rest !== null) return rest ? `${upperTown(town)} ${rest}` : upperTown(town);
  }
  if (CAPITALS_FIRST.test(name)) return name.replace(CAPITALS_THEN_SEPARATOR, "$1 ");
  if (!towns.length || towns.some((t) => saysTown(t, name))) return name;
  return `${upperTown(towns[0])} ${name}`;
}

/** The name of a stop in the form "CAEN - Gare" (settings.stop_names = "town"), its town moved first if it says it elsewhere. A name saying its
 * town in a way that cannot be taken out stays as it is. Run again on its own result, it changes nothing. */
export function townedName(places, name) {
  const towns = toList(places);
  for (const town of towns) {
    const rest = withoutTown(town, name);
    if (rest !== null) return rest ? `${upperTown(town)} - ${rest}` : upperTown(town);
  }
  if (!towns.length || CAPITALS_FIRST.test(name) || towns.some((t) => saysTown(t, name))) return name;
  return `${upperTown(towns[0])} - ${name}`;
}

/** Title of a route relation or a route_master. A ":" in a stop name would be read as the end of the "<Mode> <ref>:" part. OSM takes 255
 * characters in a tag: alternatives are tried from the most complete. */
export function routeName(mode, ref, ...labels) {
  const prefix = MODE_LABELS[mode] || mode[0].toUpperCase() + mode.slice(1);
  const titles = labels.map((label) => {
    const text = label.replace(/\s*:\s*/g, " - ");
    return ref ? `${prefix} ${ref}: ${text}` : `${prefix}: ${text}`;
  });
  return titles.find((title) => title.length <= TAG_LIMIT) ?? titles.at(-1).slice(0, TAG_LIMIT);
}

/** What follows the "Bus 12:" of a route relation: "A → B", "A → X → Y → B". */
export const tripLabel = (from, to, vias = []) => [from, ...vias, to].join(" → ");

/** Termini of a route_master, from [origin, terminus, trips] of its variants: the terminus most trips use, and the one most of them use with it,
 * "A ↔ B", however many branches the line has. A loop has one: "A". */
export function masterLabel(endpoints) {
  const trips = new Map();
  for (const [from, to, n = 1] of endpoints) {
    trips.set(from, (trips.get(from) || 0) + n);
    if (to !== from) trips.set(to, (trips.get(to) || 0) + n);
  }
  const hub = mostCommon(trips)[0][0];
  const other = new Map();
  for (const [from, to, n = 1] of endpoints) {
    if (from === hub && to !== hub) other.set(to, (other.get(to) || 0) + n);
    if (to === hub && from !== hub) other.set(from, (other.get(from) || 0) + n);
  }
  const second = mostCommon(other)[0]?.[0] ?? mostCommon(trips)[1]?.[0];
  return second ? `${second} ↔ ${hub}` : hub;
}

/** Termini of a line for the PTNA comment, from the [origin, terminus] of its main variants: "A ↔ B", or "A1 / A2 ↔ B" when several origins share
 * the terminus B. */
export function masterEndpointsLabel(endpoints) {
  const names = endpoints.flat();
  const hub = mostCommon(counter(names))[0][0];
  const others = [...new Set(names.filter((n) => n !== hub))];
  return others.length ? `${others.join(" / ")} ↔ ${hub}` : hub;
}
