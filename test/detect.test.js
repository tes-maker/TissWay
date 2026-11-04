// Conventions of a feed read from OSM, and answers of the worldwide services checked before being believed.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import "./helpers.js";
import { detectFeed, detectRefFromStopId, detectStopRefTags, networkFromOsm } from "../src/detect.js";
import { lookup, siteOf } from "../src/lookup.js";
import { clearCaches, services } from "../src/net.js";
import { settings } from "../src/settings.js";
import { Stops } from "../src/stops.js";
import { log } from "../src/util.js";

const o = (tags) => ({ tags });

test("detectFeed: only route_ids prove a feed code", () => {
  const ids = new Set(["R1", "R2"]);
  assert.equal(detectFeed({
    a: o({ "gtfs:route_id:FR-NOR-Atoumod": "R1" }), b: o({ "gtfs:route_id:FR-NOR-Atoumod": "R2;Z" }), c: o({ "gtfs:route_id:Other": "ZZ" }), d: o({ "gtfs:route_id:2": "R1" }),
  }, ids), "FR-NOR-Atoumod");
  // real case: a platform carrying another feed's code, on the same stop_id
  assert.equal(detectFeed({ a: o({ "gtfs:stop_id:FR-NOR-Nomad61": "R1" }), b: o({ "gtfs:route_id": "R1" }) }, ids), "");
});

test("detectStopRefTags needs several platforms and at least half of the values", () => {
  const ids = new Set(["S1", "S2", "S3", "S4"]);
  const osm = {};
  ["S1", "S2", "S3"].forEach((v, i) => { osm[`a${i}`] = o({ "ref:FR:Atoumod": v }); });
  osm.b = o({ "ref:FR:STAN": "S1" }); // once: chance
  ["S1", "S2", "S3", "x", "y", "z", "t"].forEach((v, i) => { osm[`c${i}`] = o({ "ref:IFOPT": v }); }); // mostly other values
  ["S1", "S2", "S3"].forEach((v, i) => { osm[`d${i}`] = o({ ref: v }); }); // plain ref: not a stop_id tag
  ["S1", "S2", "S3"].forEach((v, i) => { osm[`e${i}`] = o({ "ref:FR:Atoumod:2": v }); }); // numbered: second value of the same tag
  ["S1", "S2", "S3"].forEach((v, i) => { osm[`f${i}`] = o({ "ref:FR:Atoumod:Nomad": v }); }); // same tag, for another network
  assert.deepEqual(detectStopRefTags(osm, ids), ["ref:FR:Atoumod"]);
});

test("detectRefFromStopId", () => {
  const make = (refs) => {
    const ids = refs.map((_, i) => `FR:1:ZE:CODE${i}:X`);
    return [new Stops(new Map(ids.map((id) => [id, { stop_code: "" }])), new Map(ids.map((id, i) => [id, [{ id: `n${i}` }]])), new Map(), new Map()),
      Object.fromEntries(refs.map((r, i) => [`n${i}`, o(r ? { ref: r } : {})]))];
  };
  assert.ok(detectRefFromStopId(...make(["CODE0", "CODE1", "CODE2"])));
  assert.ok(!detectRefFromStopId(...make(["CODE0", "CODE1", null])));
});

test("networkFromOsm: route_id first, then a name beginning the agency's, on a line of the agency", () => {
  const routes = [{ route_id: "R1", route_short_name: "122" }];
  const rel = (tags) => o({ type: "route", ...tags });
  assert.equal(networkFromOsm("Nomad Car", routes, { a: rel({ network: "Nomad", ref: "122" }) }), "Nomad");
  assert.equal(networkFromOsm("Nomad Car", routes, { a: rel({ network: "Car", ref: "122" }) }), null); // not its first words
  assert.equal(networkFromOsm("ArgentanBus", routes, { a: rel({ network: "Argentan bus", ref: "122" }) }), "Argentan bus"); // same words, spaced
  assert.equal(networkFromOsm("Nomad Car", routes, { a: rel({ network: "Nomad", ref: "9" }) }), null); // none of its lines
  assert.equal(networkFromOsm("Nomad Car", routes, { a: rel({ network: "Nomad", ref: "122" }), b: rel({ network: "Région", "gtfs:route_id:X": "R1" }) }), "Région");
});

test("siteOf", () => {
  assert.equal(siteOf("https://www.twisto.fr/lignes"), "twisto.fr");
  assert.equal(siteOf("not a url"), "");
});

// --- Wikidata, Wiktionary, Nominatim

const realFetch = globalThis.fetch;
let answers, lines;
const json = (body) => new Response(JSON.stringify(body));
beforeEach(() => {
  clearCaches();
  Object.assign(services, { lookup_interval_ms: 0, retry_ms: 1 });
  lines = [];
  log.sink = (level, m) => { if (level === "warn") lines.push(m); };
  globalThis.fetch = async (url) => answers(decodeURIComponent(String(url)));
});
afterEach(() => {
  globalThis.fetch = realFetch;
  log.sink = () => {};
});

const row = (id, { site, code, transit = false } = {}) => ({ i: { value: `http://www.wikidata.org/entity/${id}` }, ...(site ? { site: { value: site } } : {}), ...(code ? { code: { value: code } } : {}), transit: { value: String(transit) } });
const wikidata = (search, rows) => (u) => (u.includes("wbsearchentities") ? json({ search }) : json({ results: { bindings: rows } }));
const TWISTO = [{ id: "Q3537947", label: "Twisto" }, { id: "Q85115623", label: "Twisto" }];

test("wikidataNetwork: the fintech of the same name is rejected, the agency's website decides", async () => {
  answers = wikidata(TWISTO, [row("Q3537947", { site: "http://www.twisto.fr" }), row("Q85115623", { site: "http://www.twisto.cz", code: "CZ" })]);
  assert.equal(await lookup.wikidataNetwork("Twisto", "https://www.twisto.fr/", "fr", "fr"), "Q3537947");
});

test("wikidataNetwork: a public transport system of the right country is accepted, of another country not", async () => {
  answers = wikidata([{ id: "Q1", label: "Altobus" }], [row("Q1", { site: "http://www.altobus.com/", code: "FR", transit: true })]);
  assert.equal(await lookup.wikidataNetwork("Altobus", "https://alto.maxtrip.fr/", "fr", "fr"), "Q1");
  clearCaches();
  answers = wikidata([{ id: "Q1", label: "Altobus" }], [row("Q1", { code: "DE", transit: true })]);
  assert.equal(await lookup.wikidataNetwork("Altobus", "https://alto.maxtrip.fr/", "fr", "fr"), null);
});

test("wikidataNetwork: never guesses", async () => {
  answers = wikidata([{ id: "Q1", label: "Nomad" }], [row("Q1", { code: "FR" })]); // not transit, no matching site
  assert.equal(await lookup.wikidataNetwork("Nomad", "https://a.example", "fr", "fr"), null);
  clearCaches();
  answers = wikidata([{ id: "Q1", label: "Bus" }, { id: "Q2", label: "Bus" }], [row("Q1", { transit: true }), row("Q2", { transit: true })]); // two left
  assert.equal(await lookup.wikidataNetwork("Bus", "https://a.example", "fr", "fr"), null);
  clearCaches();
  answers = wikidata([{ id: "Q1", label: "Nomad Cars" }], []); // not the exact label: not even asked further
  assert.equal(await lookup.wikidataNetwork("Nomad", "https://a.example", "fr", "fr"), null);
});

test("wikipediaOf prefers the language of the feed", async () => {
  answers = () => json({ entities: { Q1: { sitelinks: { commonswiki: { title: "c" }, dewiki: { title: "D" }, frwiki: { title: "F (réseau)" } } } } });
  assert.equal(await lookup.wikipediaOf("Q1", "fr"), "fr:F (réseau)");
  assert.equal(await lookup.wikipediaOf("Q1", "es"), "de:D");
});

test("accents: words with a page are left alone, a word without accent candidate too", async () => {
  answers = (u) => {
    if (u.includes("titles=")) return json({ query: { pages: { 1: { title: "marche" }, 2: { title: "routiere", missing: "" }, 3: { title: "clemenceau", missing: "" } } } });
    return json({ query: { search: u.includes("routiere") ? [{ title: "Routiere" }, { title: "routière" }] : [{ title: "Clemenceau" }] } });
  };
  const out = await lookup.accents(["Marche", "ROUTIERE", "Clemenceau", "de", "Hôpital"], "fr");
  assert.deepEqual([...out], [["routiere", "routière"]]);
});

test("accents: a proper name is never accented from a foreign word", async () => {
  // real case: "Normandie" has no lower-case page, and the search finds the Dutch "Normandië"
  answers = (u) => {
    if (u.includes("titles=")) return json({ query: { pages: { 1: { title: "normandie", missing: "" }, 2: { title: "Normandie" } } } });
    return assert.fail("no search expected: the word has a page");
  };
  assert.equal((await lookup.accents(["Normandie"], "fr")).size, 0);
  clearCaches();
  answers = (u) => (u.includes("titles=") ? json({ query: { pages: { 1: { title: "foo", missing: "" } } } }) : json({ query: { search: [{ title: "Foö" }] } }));
  assert.equal((await lookup.accents(["foo"], "fr")).size, 0); // capitalised candidate: a name
});

test("accents: nothing asked for English or an unknown language", async () => {
  answers = () => assert.fail("no call expected");
  assert.equal((await lookup.accents(["cafe"], "en")).size, 0);
  assert.equal((await lookup.accents(["cafe"], "")).size, 0);
});

test("a service failing is reported and the run goes on; cancelling is not swallowed", async () => {
  services.retry_ms = 1;
  answers = () => new Response("", { status: 400 });
  assert.equal(await lookup.drivingSide("fr"), null);
  assert.deepEqual(await lookup.placesAt(49, 1), []);
  assert.equal(lines.length, 2);
  answers = () => { throw new DOMException("stop", "AbortError"); };
  clearCaches();
  await assert.rejects(lookup.placesAt(49, 1), { name: "AbortError" });
});

test("placesAt: most precise first, each once", async () => {
  answers = () => json({ address: { village: "V", city: "C", municipality: "C", country_code: "fr" } });
  assert.deepEqual(await lookup.placesAt(49, 1), ["V", "C"]);
  assert.equal(await lookup.countryAt(49, 1), "fr");
});

test("the settings are read when called", () => assert.equal(settings.services, services));
