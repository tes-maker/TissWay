// What the site would otherwise keep in a local database, asked from worldwide services: towns and countries (Nominatim),
// driving side and network entries (Wikidata), spellings (Wiktionary). A failure here is never fatal: it is reported, and
// the run goes on without the information. An object, so that tests can replace its functions.

import { cachedJson } from "./net.js";
import { nameKey, unaccent } from "./naming.js";
import { settings } from "./settings.js";
import { log } from "./util.js";

const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
const WIKIDATA_SPARQL = "https://query.wikidata.org/sparql";
const PUBLIC_TRANSPORT = "wd:Q178512"; // what a network must be an instance of, directly or not
const PLACE_REACH = 0.3; // degrees around a stop where a place named in its name can be
const BATCH = 25; // words per Wiktionary query (two titles each, the API takes 50)
const isAscii = (s) => /^[\x00-\x7f]*$/.test(s);

/** Result of fn, or fallback with a warning if the service fails. Cancelling is not a failure. */
async function soft(what, fallback, fn) {
  try {
    return await fn();
  } catch (e) {
    if (e.name === "AbortError") throw e;
    log.warn(`${what} not available (${e.message})`);
    return fallback;
  }
}

const sparql = (query) => cachedJson(`${WIKIDATA_SPARQL}?format=json&query=${encodeURIComponent(query)}`).then((d) => d.results.bindings);
const lookupDelay = () => settings.services.lookup_interval_ms;

/** Registrable part of a URL's host: "https://www.twisto.fr/x" -> "twisto.fr". */
export function siteOf(url) {
  try {
    return new URL(url).hostname.split(".").slice(-2).join(".");
  } catch {
    return "";
  }
}

export const lookup = {
  /** Nominatim address of a position, {} if unknown. */
  reverse(lat, lon, lang) {
    const params = new URLSearchParams({ format: "jsonv2", lat: lat.toFixed(4), lon: lon.toFixed(4), zoom: 12, addressdetails: 1, ...(lang ? { "accept-language": lang } : {}) });
    return soft("Nominatim", {}, async () => (await cachedJson(`${settings.services.nominatim_url}/reverse?${params}`, lookupDelay())).address || {});
  },

  /** Every name of the place at a position, most precise first: a stop may use any of them. */
  async placesAt(lat, lon, lang) {
    const a = await lookup.reverse(lat, lon, lang);
    return [...new Set([a.village, a.town, a.city, a.municipality].filter(Boolean))];
  },

  /** Is there a town or a village of this name around a position? Unknown counts as no. */
  placeNear(name, lat, lon) {
    const viewbox = [lon - PLACE_REACH, lat + PLACE_REACH, lon + PLACE_REACH, lat - PLACE_REACH].map((v) => v.toFixed(1)).join(",");
    const params = new URLSearchParams({ format: "jsonv2", q: name, featureType: "settlement", limit: 1, bounded: 1, viewbox });
    return soft("Nominatim", false, async () => (await cachedJson(`${settings.services.nominatim_url}/search?${params}`, lookupDelay())).length > 0);
  },

  /** ISO code ("fr") of the country at a position, null if unknown. */
  countryAt: async (lat, lon) => (await lookup.reverse(lat, lon)).country_code || null,

  /** "left" or "right" in a country (ISO code), null if unknown. */
  drivingSide(country) {
    const query = `SELECT ?sideLabel WHERE { ?c wdt:P297 "${country.toUpperCase().replace(/[^A-Z]/g, "")}"; wdt:P1622 ?side. SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } }`;
    return soft("Wikidata", null, async () => {
      const side = (await sparql(query))[0]?.sideLabel?.value;
      return side === "left" || side === "right" ? side : null;
    });
  },

  /** Map ascii word -> accented spelling, for the words without a dictionary page of their own, written with or without a
   * capital, that have an accented common word. Words with their own page are left alone ("marche" / "marché" cannot be told
   * apart; "Normandie" must not become the Dutch "Normandië"). Proper names are never accented from here. */
  accents(words, lang) {
    const out = new Map();
    if (!lang || lang === "en") return Promise.resolve(out);
    const api = `https://${lang}.wiktionary.org/w/api.php?format=json&origin=*&action=query`;
    const todo = [...new Set(words.map((w) => w.toLowerCase()))].filter((w) => w.length > 2 && isAscii(w)).sort();
    return soft("Wiktionary", out, async () => {
      const unknown = [];
      for (let i = 0; i < todo.length; i += BATCH) {
        const batch = todo.slice(i, i + BATCH);
        const titles = batch.flatMap((w) => [w, w[0].toUpperCase() + w.slice(1)]).join("|");
        const { query } = await cachedJson(`${api}&titles=${encodeURIComponent(titles)}`, lookupDelay());
        const found = new Set(Object.values(query.pages).filter((p) => !("missing" in p)).map((p) => p.title.toLowerCase()));
        unknown.push(...batch.filter((w) => !found.has(w)));
      }
      for (const word of unknown) {
        const { query } = await cachedJson(`${api}&list=search&srlimit=8&srprop=&srnamespace=0&srsearch=${encodeURIComponent(word)}`, lookupDelay());
        const hit = query.search.map((h) => h.title).find((t) => !isAscii(t) && t === t.toLowerCase() && unaccent(t) === word);
        if (hit) out.set(word, hit);
      }
      return out;
    });
  },

  /** QID of the network called name, or null. An exact label is required, then its website must be the agency's, or it must be
   * a public transport system of the right country. Several candidates left: null, nothing is guessed. */
  wikidataNetwork(name, agencyUrl, country, lang) {
    return soft("Wikidata", null, async () => {
      const params = new URLSearchParams({ action: "wbsearchentities", search: name, language: lang || "en", uselang: lang || "en", type: "item", limit: 10, format: "json", origin: "*" });
      const { search } = await cachedJson(`${WIKIDATA_API}?${params}`);
      const ids = search.filter((s) => nameKey(s.label) === nameKey(name)).map((s) => s.id);
      if (!ids.length) return null;
      const rows = await sparql(`SELECT ?i ?site ?code ?transit WHERE { VALUES ?i { ${ids.map((i) => `wd:${i}`).join(" ")} } OPTIONAL { ?i wdt:P856 ?site } OPTIONAL { ?i wdt:P17/wdt:P297 ?code } BIND(EXISTS { ?i wdt:P31/wdt:P279* ${PUBLIC_TRANSPORT} } AS ?transit) }`);
      const site = siteOf(agencyUrl);
      const confirmed = new Set();
      for (const r of rows) {
        const sameSite = site && r.site && siteOf(r.site.value) === site;
        const sameCountry = !r.code || !country || r.code.value.toLowerCase() === country;
        if (sameSite || (r.transit?.value === "true" && sameCountry)) confirmed.add(r.i.value.split("/").pop());
      }
      return confirmed.size === 1 ? [...confirmed][0] : null;
    });
  },

  /** network:wikipedia value ("fr:Nomad (réseau)") of a Wikidata entry, in the language of the feed if it exists there. */
  wikipediaOf(qid, lang) {
    const params = new URLSearchParams({ action: "wbgetentities", ids: qid, props: "sitelinks", format: "json", origin: "*" });
    return soft("Wikidata", null, async () => {
      const links = (await cachedJson(`${WIKIDATA_API}?${params}`)).entities?.[qid]?.sitelinks || {};
      const wikis = Object.keys(links).filter((k) => /^[a-z]+wiki$/.test(k) && k !== "commonswiki");
      const key = wikis.find((k) => k === `${lang}wiki`) ?? wikis[0];
      return key ? `${key.slice(0, -4)}:${links[key].title}` : null;
    });
  },
};
