// Names: network of a GTFS agency, stop labels used in relation names, relation names.
//
// Titles of the lines (tripTitle): route "Bus 12: VILLE Arret → VILLE Arret", "Bus 12: VILLE Arret → VILLE Arret → VILLE Arret" for variants sharing their termini; route_master
// "Bus 12: VILLE Arret ↔ VILLE Arret" ("A1 / A2 ↔ B" when several origins share a terminus). The stops are labelled by routeLabel. The stops themselves get name = "Arret" and official_name = "VILLE - Arret" (stopNames).

import { settings } from "./settings.js";
import { counter, mostCommon } from "./util.js";

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

const ELISION = /(?<![\p{L}\p{N}])(c|d|j|l|m|n|s|t|qu|jusqu|lorsqu|puisqu)\s*(['\u2019])\s*(?=\p{L})/giu;
const SAINT_HYPHEN = /(?<![\p{L}\p{N}])(saint|sainte|st|ste)(?: -(?=\S)|- )(?=\p{L})/giu;
/** Between two digits and without a space, ":" and "," belong to a number: "12:30", "1,5". */
const unlessNumber = (spaced) => (match, at, text) => (match.length === 1 && /\d/.test(text[at - 1] ?? "") && /\d/.test(text[at + 1] ?? "") ? match : spaced);

/** Stop name as written on OSM objects, whatever the punctuation of the source: " - " between two parts ("A -B", "A\u2013 B", "A -- B", "A : B"), a word
 * hyphen left alone ("Saint-Malo", "Saint- Malo" repaired), "A, B", "A (B)", "L'Église" and "Av. de", single spaces, no separator at either end. A ";"
 * would make it a list in OSM: it becomes ",". "/" is left as it is: "PACY S/ EURE", "Mairie/Eglise" and "A / B" do not follow one rule. Run again on
 * its own result, it changes nothing. */
export function cleanStopName(name) {
  const source = String(name).trim();
  const cleaned = source.normalize("NFC")
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[\u2010\u2011]/g, "-")
    .replace(ELISION, "$1$2")
    .replace(/\s*:\s*/g, unlessNumber(" - "))
    .replace(/\s*[\u2012-\u2015\u2212]+\s*/g, " - ")
    .replace(/\s*-(?:\s*-)+\s*/g, " - ")
    .replace(SAINT_HYPHEN, "$1-")
    .replace(/ -(?=\S)|(?<=\S)- /g, " - ")
    .replace(/\s*;+\s*/g, ", ")
    .replace(/\s*,[\s,]*/g, unlessNumber(", "))
    .replace(/\(\s*\)|\[\s*\]/g, "")
    .replace(/([([])\s+/g, "$1")
    .replace(/\s+([)\]])/g, "$1")
    .replace(/(?<=[\p{L}\p{N}])([([])/gu, " $1")
    .replace(/([)\]])(?=[\p{L}\p{N}])/gu, "$1 ")
    .replace(/\s+\.(?=\s|$)/g, ".")
    .replace(/(\p{L}{2,})\.(?=\p{L}{2,})/gu, "$1. ")
    .replace(/(?:,? +- +,? *)+/g, " - ")
    .replace(/\s+/g, " ")
    .replace(/^[\s,:-]+|[\s,:-]+$/g, "");
  return cleaned || source;
}

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
  const prefix = new RegExp(`^(?:${starts.join("|")})(?![\\p{L}\\p{N}])[ :,\u2013\u2014-]*`, "iu").exec(unaccent(name));
  return prefix ? name.slice(prefix[0].length) : name;
}

const LINK = new RegExp(`^${LINK_WORDS}$`);
/** Upper-case words of a place or a stop name, "St" and "Ste" read as "Saint" and "Sainte". */
const tokens = (text) => unaccent(text).toUpperCase().split(/[^\p{L}\p{N}']+/u).filter(Boolean)
  .map((w) => ({ ST: "SAINT", STE: "SAINTE" }[w] ?? w));

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

/** Does the stop name say its whole town, anywhere ("Hauts de Mondeville", "Clinique Les Damps")? A part of it does not count: "Norrey Calvaire" in Saint-Manvieu-Norrey, "Saint-Pierre-sur-Dives" in
 * Saint-Pierre-en-Auge are former communes, which do not replace the commune nouvelle. */
function saysTown(town, name) {
  if (withoutTown(town, name) !== null) return true;
  const inName = tokens(name), all = tokens(town);
  const inTown = /^(?:LE|LA|LES|L')$/.test(all[0]) ? all.slice(1) : all;
  for (let i = 0; i + inTown.length <= inName.length; i++) if (inTown.every((w, k) => inName[i + k] === w)) return true;
  return false;
}

/** Does the name begin with a place in capitals, maybe not the one the position gives: a former commune, or just over the boundary?
 * "CAEN Chemin Vert", "LE THEIL-SUR-HUISNE - École", "VENDEUVRES morieres", "MEZIDON-CANON: college", "COURTONNE LES 2 EGLISES: le bourg". */
const CAPITALS_FIRST = /^\p{Lu}[\p{Lu}'\u2019.\d/ -]{2,}?\s*:|^\p{Lu}[\p{Lu}'\u2019.\d/ -]{2,}?\s[-\u2013\u2014]\s|^\p{Lu}[\p{Lu}'\u2019.-]{2,}(?: \p{Lu}[\p{Lu}'\u2019.-]*)*\s+(?:\p{Lu}[\p{Ll}'\u2019]|\p{Ll})/u;

const TAG_LIMIT = 255; // characters in an OSM tag value
const CAPITALS_THEN_SEPARATOR = /^(\p{Lu}[\p{Lu}'\u2019.\d/ -]{2,}?)(?:\s*:|\s[-\u2013\u2014])\s*/u;
const CAPITALS_THEN_WORDS = /^(\p{Lu}[\p{Lu}'\u2019.-]{2,}(?: \p{Lu}[\p{Lu}'\u2019.-]*)*)\s+(?=\p{Lu}[\p{Ll}'\u2019]|\p{Ll})/u;

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

/** The place in capitals a name begins with and what follows it, null if it does not: "CAEN - Gare", "CAEN Chemin Vert", "MEZIDON-CANON: college". */
function capitalsFirst(name) {
  if (!CAPITALS_FIRST.test(name)) return null;
  const m = CAPITALS_THEN_SEPARATOR.exec(name) ?? CAPITALS_THEN_WORDS.exec(name);
  const rest = m && name.slice(m[0].length).trim();
  return rest ? { place: m[1], rest } : null;
}

/** Comparison key of the stop itself, whatever a place in capitals before it: "MONDEVILLE - Charlotte Corday" is the stop "Charlotte Corday". */
export function stopKey(name) {
  const m = CAPITALS_THEN_SEPARATOR.exec(name || "");
  return nameKey(m && name.slice(m[0].length) ? name.slice(m[0].length) : name);
}

/** {name, official_name} of a stop: {name: "Charlotte Corday", official_name: "MONDEVILLE - Charlotte Corday"}, whether the town is in the name
 * given or not. A town that cannot be taken out ("Hauts de Mondeville"), a name that is only the town, or no known town: no official_name, it
 * would say nothing more. Capitals at the start that are not the town of the position are taken out when isPlace(capitals) confirms a place:
 * a former commune, or just over the boundary; "CHU Côte de Nacre" stays whole. The prefix of a commune nouvelle is the commune nouvelle: the commune déléguée a name says is part of
 * the name of the stop ("Brouay Mairie" in Thue et Mue: official_name "THUE ET MUE - Brouay Mairie"), also in capitals when isDelegated(capitals, commune) confirms it. */
export async function stopNames(places, name, isPlace = async () => false, isDelegated = async () => false) {
  const named = (town, rest) => {
    const stop = cleanStopName(rest.replace(/^\(([^()]*)\)$/, "$1")); // "CAEN (Gare)"
    return { name: stop, official_name: `${upperTown(town)} - ${stop}` };
  };
  const towns = toList(places);
  for (const town of towns) {
    const rest = withoutTown(town, name);
    if (rest !== null) return rest ? named(town, rest) : { name };
  }
  if (CAPITALS_FIRST.test(name)) {
    const other = capitalsFirst(name);
    if (!other) return { name };
    if (towns.length && (await isDelegated(other.place, towns[0]))) return named(towns[0], `${other.place} ${other.rest}`);
    return (await isPlace(other.place)) ? named(other.place, other.rest) : { name };
  }
  if (!towns.length || towns.some((t) => saysTown(t, name))) return { name };
  return named(towns[0], name);
}

/** Title of a route relation or a route_master. A ":" in a stop name would be read as the end of the "<Prefix> <ref>:" part (settings.prefixes). OSM takes 255
 * characters in a tag: alternatives are tried from the most complete. */
export function routeName(mode, ref, ...labels) {
  return routeTitle(modePrefix(mode), ref, ...labels);
}

/** What comes before the ref in the names of the relations of a mode. */
export const modePrefix = (mode) => settings.prefixes[mode] || mode[0].toUpperCase() + mode.slice(1);

/** A stop as every title shows it, "VILLE Arret": its first, last and via stops alike. places: the names of its place, see routeLabel. */
export const stopLabel = ({ name, official_name, places = [] }) => routeLabel(places, official_name ?? name);

/** Title of a route relation, whatever writes it (a line generated, a network corrected, the "via" tool): "Bus 12: VILLE Arret → VILLE Arret → VILLE Arret", from the labels
 * of its stops (stopLabel). Too long for OSM, without its vias. */
export const tripTitle = (prefix, ref, from, to, vias = []) => routeTitle(prefix, ref, tripLabel(from, to, vias), tripLabel(from, to));

/** The same, with what comes before the ref. */
export function routeTitle(prefix, ref, ...labels) {
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
