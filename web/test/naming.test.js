// Stop labels "LOCALITY Stop", relation names, networks, accents (Découpage administratif API mocked).
import assert from "node:assert/strict";
import { test } from "node:test";
import "./helpers.js";
import * as naming from "../src/naming.js";
import { configure, settings } from "../src/settings.js";

for (const [town, name, label] of [
  ["Louviers", "Châtel", "LOUVIERS Châtel"],
  ["Mont-Saint-Aignan", "Mont aux Malades", "MONT-SAINT-AIGNAN Mont aux Malades"], // "Mont" is not the town here
  ["Ajaccio", "Cours Napoléon", "AJACCIO Cours Napoléon"],
  ["Caen", "Caennais", "CAEN Caennais"], // a longer word is not the town
  // the town is already there: moved first, never twice
  ["Avranches", "Avranches - Gare", "AVRANCHES Gare"],
  ["Avranches", "Avranches", "AVRANCHES"],
  ["Avranches", "AVRANCHES Gare", "AVRANCHES Gare"],
  ["Caen", "CAEN - Gare", "CAEN Gare"],
  ["Caen", "Gare - Caen", "CAEN Gare"],
  ["Caen", "Gare (Caen)", "CAEN Gare"],
  ["Caen", "Gare, Caen", "CAEN Gare"],
  ["Fleury-sur-Orne", "Fleury Mairie", "FLEURY-SUR-ORNE Mairie"], // the beginning of the town
  ["Condé-sur-Noireau", "CONDE-SUR-NOIREAU - Place", "CONDE-SUR-NOIREAU Place"], // without its accent
  ["Saint-Malo", "St-Malo Gare", "SAINT-MALO Gare"], // St = Saint
  ["Le Havre", "Le-Havre Gare", "LE HAVRE Gare"],
  ["Tilly-sur-Seulles", "TILLY-SUR - SEULLES - College", "TILLY-SUR-SEULLES College"], // real name of the feed
  // real names of the feed: the town at their end, or a part of it, in any case
  ["Gaillon", "Mairie Gaillon", "GAILLON Mairie"],
  ["Alizay", "Poste Alizay", "ALIZAY Poste"],
  ["Les Damps", "Clinique Les Damps", "LES DAMPS Clinique"],
  ["Mondeville", "Hauts de Mondeville", "Hauts de Mondeville"], // it cannot be taken out
  ["Le Mont-Saint-Michel", "Mont-Saint-Michel", "Mont-Saint-Michel"],
  ["Saint-Manvieu-Norrey", "Norrey Calvaire", "SAINT-MANVIEU-NORREY Norrey Calvaire"],
  ["Colomby-Anguerny", "Anguerny - Coursanne", "COLOMBY-ANGUERNY Anguerny - Coursanne"],
  ["Feuguerolles-Bully", "Bully", "FEUGUEROLLES-BULLY Bully"],
  ["Carentan-les-Marais", "Carentan", "CARENTAN-LES-MARAIS"],
  ["Cherbourg-en-Cotentin", "CHERBOURG-GARE", "CHERBOURG-EN-COTENTIN CHERBOURG-GARE"],
  ["Saint-Pierre-en-Auge", "Saint-Pierre-sur-Dives", "SAINT-PIERRE-EN-AUGE Saint-Pierre-sur-Dives"],
  ["Saint-Aubin-lès-Elbeuf", "Elbeuf - Saint-Aubin", "SAINT-AUBIN-LES-ELBEUF Elbeuf - Saint-Aubin"],
  // another place in capitals: a former commune, or just over the boundary
  ["Hérouville-Saint-Clair", "CAEN Chemin Vert", "CAEN Chemin Vert"],
  ["Ifs", "ARGENTAN - Musiciens (Arrêt urbain)", "ARGENTAN Musiciens (Arrêt urbain)"],
  ["Val-au-Perche", "LE THEIL-SUR-HUISNE - École Primaire", "LE THEIL-SUR-HUISNE École Primaire"],
  ["Gasny", "LE MESNIL MILON - Ecole", "LE MESNIL MILON Ecole"],
  ["Pacy-sur-Eure", "PACY S/ EURE - Piscine", "PACY S/ EURE Piscine"],
  ["Mézidon Vallée d'Auge", "MEZIDON-CANON: college boris vian", "MEZIDON-CANON college boris vian"],
  ["Courtonne-les-Deux-Églises", "COURTONNE LES 2 EGLISES: le bourg", "COURTONNE LES 2 EGLISES le bourg"],
  ["Vendeuvre", "VENDEUVRES morieres - noyers", "VENDEUVRES morieres - noyers"],
  ["Vatteville-la-Rue", "VATTEVILLE-LA-R L'Angle", "VATTEVILLE-LA-R L'Angle"],
  // only looks like the town: it is still needed
  ["Caen", "Decaen", "CAEN Decaen"],
  ["Ifs", "Object'Ifs Sud", "IFS Object'Ifs Sud"],
  ["Hérouville-Saint-Clair", "Saint-Clair", "HEROUVILLE-SAINT-CLAIR Saint-Clair"],
  ["Oudalle", "4939 - Stockespace", "OUDALLE 4939 - Stockespace"],
  ["Argentan", "Rue de la République - Hôpital", "ARGENTAN Rue de la République - Hôpital"],
]) {
  test(`routeLabel: ${name} in ${town}`, () => assert.equal(naming.routeLabel(town, name), label));
}

test("routeLabel: unknown town keeps the GTFS name, any name of the place counts", () => {
  assert.equal(naming.routeLabel(null, "Inconnu"), "Inconnu");
  assert.equal(naming.routeLabel([], "Inconnu"), "Inconnu");
  assert.equal(naming.routeLabel(["Garcelles-Secqueville", "Le Castelet"], "Le Castelet - Mairie"), "LE CASTELET Mairie");
  assert.equal(naming.routeLabel(["Garcelles-Secqueville", "Le Castelet"], "Mairie"), "GARCELLES-SECQUEVILLE Mairie");
});

for (const [places, given, name, official] of [
  ["Mondeville", "Charlotte Corday", "Charlotte Corday", "MONDEVILLE - Charlotte Corday"],
  ["Mondeville", "MONDEVILLE - Charlotte Corday", "Charlotte Corday", "MONDEVILLE - Charlotte Corday"],
  ["Mondeville", "Mondeville Charlotte Corday", "Charlotte Corday", "MONDEVILLE - Charlotte Corday"],
  ["Caen", "Gare - Caen", "Gare", "CAEN - Gare"],
  ["Caen", "Gare (Caen)", "Gare", "CAEN - Gare"],
  ["Caen", "Gare, Caen", "Gare", "CAEN - Gare"],
  ["Tilly-sur-Seulles", "TILLY-SUR - SEULLES - College", "College", "TILLY-SUR-SEULLES - College"],
  ["Fleury-sur-Orne", "Fleury Mairie", "Mairie", "FLEURY-SUR-ORNE - Mairie"],
  ["Saint-Malo", "St-Malo Gare", "Gare", "SAINT-MALO - Gare"],
  ["Condé-sur-Noireau", "Condé-sur-Noireau Hôpital", "Hôpital", "CONDE-SUR-NOIREAU - Hôpital"],
  [["Garcelles-Secqueville", "Le Castelet"], "Le Castelet Mairie", "Mairie", "LE CASTELET - Mairie"],
  ["Gaillon", "Mairie Gaillon", "Mairie", "GAILLON - Mairie"],
  // only the town, or a town that cannot be taken out: official_name would say nothing more
  ["Caen", "Caen", "Caen", undefined],
  ["Mondeville", "Hauts de Mondeville", "Hauts de Mondeville", undefined],
  ["Saint-Manvieu-Norrey", "Norrey Calvaire", "Norrey Calvaire", "SAINT-MANVIEU-NORREY - Norrey Calvaire"],
  [[], "Gare", "Gare", undefined],
]) {
  test(`stopNames: ${given} in ${places}`, async () => {
    const names = await naming.stopNames(places, given);
    assert.deepEqual(names, official ? { name, official_name: official } : { name });
    if (official) assert.deepEqual(await naming.stopNames(places, official), names); // run again on its result: no change
  });
}

test("stopNames: capitals are taken out only when they name a place", async () => {
  const isPlace = async (place) => ["CAEN", "MEZIDON-CANON"].includes(place);
  assert.deepEqual(await naming.stopNames("Hérouville-Saint-Clair", "CAEN Chemin Vert", isPlace), { name: "Chemin Vert", official_name: "CAEN - Chemin Vert" });
  assert.deepEqual(await naming.stopNames("Hérouville-Saint-Clair", "CAEN - Chemin Vert", isPlace), { name: "Chemin Vert", official_name: "CAEN - Chemin Vert" });
  assert.deepEqual(await naming.stopNames("Saint-Pierre-en-Auge", "MEZIDON-CANON: college", isPlace), { name: "college", official_name: "MEZIDON-CANON - college" });
  assert.deepEqual(await naming.stopNames("Caen", "CHU Côte de Nacre", isPlace), { name: "CHU Côte de Nacre" });
  assert.deepEqual(await naming.stopNames("Hérouville-Saint-Clair", "CAEN Chemin Vert"), { name: "CAEN Chemin Vert" }); // nothing confirmed
});

test("stopNames in a commune nouvelle: its name first, the former commune stays in the name of the stop", async () => {
  const delegated = async (place, commune) => ({ BROUAY: "Thue et Mue", "MEZIDON-CANON": "Mézidon Vallée d'Auge" })[place] === commune;
  const near = async (place) => ["CAEN", "BROUAY", "MEZIDON-CANON"].includes(place);
  const check = async (town, name, stop, official) => assert.deepEqual(await naming.stopNames(town, name, near, delegated), official ? { name: stop, official_name: official } : { name: stop });
  await check("Thue et Mue", "Brouay Mairie", "Brouay Mairie", "THUE ET MUE - Brouay Mairie");
  await check("Thue et Mue", "THUE ET MUE - Brouay Mairie", "Brouay Mairie", "THUE ET MUE - Brouay Mairie"); // run again
  await check("Thue et Mue", "Bretteville-l'Orgueilleuse Gare", "Bretteville-l'Orgueilleuse Gare", "THUE ET MUE - Bretteville-l'Orgueilleuse Gare");
  await check("Thue et Mue", "Mairie", "Mairie", "THUE ET MUE - Mairie");
  await check("Thue et Mue", "BROUAY Mairie", "BROUAY Mairie", "THUE ET MUE - BROUAY Mairie");
  await check("Thue et Mue", "BROUAY - Mairie", "BROUAY Mairie", "THUE ET MUE - BROUAY Mairie");
  await check("Thue et Mue", "Thue et Mue - Brouay Mairie", "Brouay Mairie", "THUE ET MUE - Brouay Mairie");
  await check("Mézidon Vallée d'Auge", "MEZIDON-CANON - college", "MEZIDON-CANON college", "MEZIDON VALLEE D'AUGE - MEZIDON-CANON college");
  await check("Saint-Pierre-en-Auge", "Saint-Pierre-sur-Dives Mairie", "Saint-Pierre-sur-Dives Mairie", "SAINT-PIERRE-EN-AUGE - Saint-Pierre-sur-Dives Mairie");
  await check("Saint-Manvieu-Norrey", "Norrey Calvaire", "Norrey Calvaire", "SAINT-MANVIEU-NORREY - Norrey Calvaire");
  await check("Condé-en-Normandie", "Condé-sur-Noireau Hôpital", "Condé-sur-Noireau Hôpital", "CONDE-EN-NORMANDIE - Condé-sur-Noireau Hôpital");
  await check("Hérouville-Saint-Clair", "CAEN Chemin Vert", "Chemin Vert", "CAEN - Chemin Vert"); // another town, not a former commune of this one
  await check("Mondeville", "Hauts de Mondeville", "Hauts de Mondeville");
});

test("routeLabel in a commune nouvelle: the titles follow", () => {
  assert.equal(naming.routeLabel("Thue et Mue", "THUE ET MUE - Brouay Mairie"), "THUE ET MUE Brouay Mairie");
  assert.equal(naming.routeLabel("Thue et Mue", "Brouay Mairie"), "THUE ET MUE Brouay Mairie");
  assert.equal(naming.routeLabel("Mézidon Vallée d'Auge", "MEZIDON VALLEE D'AUGE - MEZIDON-CANON college"), "MEZIDON VALLEE D'AUGE MEZIDON-CANON college");
});

test("stopKey: a stop is the same with or without the place before it", () => {
  assert.equal(naming.stopKey("MONDEVILLE - Charlotte Corday"), naming.stopKey("Charlotte Corday"));
  assert.notEqual(naming.stopKey("Gare Routière"), naming.stopKey("Gare"));
});

for (const [given, clean] of [
  // parts of a name
  ["Gare -Nord", "Gare - Nord"],
  ["Gare- Nord", "Gare - Nord"],
  ["Gare   -   Nord", "Gare - Nord"],
  ["Gare -- Nord", "Gare - Nord"],
  ["Gare - - Nord", "Gare - Nord"],
  ["Gare – Nord", "Gare - Nord"],
  ["Gare—Nord", "Gare - Nord"],
  ["Gare : Nord", "Gare - Nord"],
  ["Gare:Nord", "Gare - Nord"],
  ["MEZIDON-CANON: college", "MEZIDON-CANON - college"],
  // word hyphens
  ["Saint-Malo", "Saint-Malo"],
  ["Saint‑Malo", "Saint-Malo"],
  ["Saint- Malo", "Saint-Malo"],
  ["St -Lô", "St-Lô"],
  ["St - Lô", "St - Lô"],
  ["Condé-sur-Noireau - Hôpital", "Condé-sur-Noireau - Hôpital"],
  // commas
  ["Gare ,Nord", "Gare, Nord"],
  ["Gare,Nord", "Gare, Nord"],
  ["Gare , , Nord", "Gare, Nord"],
  ["Gare, - Nord", "Gare - Nord"],
  ["Gare;Nord", "Gare, Nord"],
  // numbers
  ["PK 1,5", "PK 1,5"],
  ["Départ 12:30", "Départ 12:30"],
  // brackets
  ["Gare( Nord )", "Gare (Nord)"],
  ["(Nord)Gare", "(Nord) Gare"],
  ["Gare [ Quai 2 ]", "Gare [Quai 2]"],
  ["Gare ()", "Gare"],
  // apostrophes
  ["L ' Église", "L'Église"],
  ["Rue de l' Abbé", "Rue de l'Abbé"],
  ["Hôtel d’ Assemblée", "Hôtel d’Assemblée"],
  ["Jusqu ' au Port", "Jusqu'au Port"],
  ["St James' Park", "St James' Park"],
  // abbreviations
  ["Av.de la Gare", "Av. de la Gare"],
  ["Gare Av .", "Gare Av."],
  ["S.N.C.F", "S.N.C.F"],
  // slashes are left alone
  ["PACY S/ EURE", "PACY S/ EURE"],
  ["Mairie/Eglise", "Mairie/Eglise"],
  // ends, spaces, encodings
  ["  Gare  Nord  ", "Gare Nord"],
  ["- Gare -", "Gare"],
  ["Gare,", "Gare"],
  ["Gare - Nord", "Gare - Nord"],
  ["Ga​re", "Gare"],
  ["Hôpital", "Hôpital"],
  ["---", "---"],
]) {
  test(`cleanStopName: ${JSON.stringify(given)}`, () => {
    assert.equal(naming.cleanStopName(given), clean);
    assert.equal(naming.cleanStopName(clean), clean); // run again on its result: no change
  });
}

for (const [places, given, name, official] of [
  ["Mondeville", "MONDEVILLE -Charlotte Corday", "Charlotte Corday", "MONDEVILLE - Charlotte Corday"],
  ["Mondeville", "Mondeville– Charlotte Corday", "Charlotte Corday", "MONDEVILLE - Charlotte Corday"],
  ["Mondeville", "Charlotte Corday ,Mondeville", "Charlotte Corday", "MONDEVILLE - Charlotte Corday"],
  ["Mondeville", "MONDEVILLE,Charlotte Corday", "Charlotte Corday", "MONDEVILLE - Charlotte Corday"],
  ["Mondeville", "MONDEVILLE ( Charlotte Corday )", "Charlotte Corday", "MONDEVILLE - Charlotte Corday"],
  ["Mondeville", "Charlotte Corday( Mondeville )", "Charlotte Corday", "MONDEVILLE - Charlotte Corday"],
  ["Mondeville", "Mondeville : Charlotte Corday", "Charlotte Corday", "MONDEVILLE - Charlotte Corday"],
  ["Mondeville", "Charlotte  Corday -", "Charlotte Corday", undefined],
  ["Mondeville", "MONDEVILLE -", "MONDEVILLE", undefined],
]) {
  test(`stopNames after cleaning: ${given}`, async () => {
    const names = await naming.stopNames(places, naming.cleanStopName(given));
    if (official) assert.deepEqual(names, { name, official_name: official });
    else assert.equal(names.name, name);
  });
}

test("stopNames after cleaning: capitals with digits, then a separator, are still a place", async () => {
  const name = naming.cleanStopName("COURTONNE LES 2 EGLISES: le bourg");
  assert.equal(naming.routeLabel("Lisieux", name), "COURTONNE LES 2 EGLISES le bourg");
  assert.deepEqual(await naming.stopNames("Lisieux", name, async () => true), { name: "le bourg", official_name: "COURTONNE LES 2 EGLISES - le bourg" });
});

test("every title: VILLE Arret for the termini and the vias", () => {
  const label = (name, official_name, places = []) => naming.stopLabel({ name, official_name, places });
  assert.equal(label("Brouay Mairie", "THUE ET MUE - Brouay Mairie"), "THUE ET MUE Brouay Mairie");
  assert.equal(label("Mairie", undefined, ["Caen"]), "CAEN Mairie");
  assert.equal(label("Mairie"), "Mairie");
  assert.equal(naming.tripTitle("Bus", "12", "CAEN Gare", "VIRE Gare", ["CAEN Mairie", "FLERS Mairie"]), "Bus 12: CAEN Gare → CAEN Mairie → FLERS Mairie → VIRE Gare");
  assert.equal(naming.tripTitle("Bus", "12", "A", "B"), "Bus 12: A → B");
  assert.equal(naming.tripTitle("Bus", "12", "A", "B", ["V".repeat(300)]), "Bus 12: A → B"); // too long for OSM: without its vias
});

test("the start of the names follows the settings, empty being the default", () => {
  configure({ "prefixes.coach": "Car Nomad", "prefixes.bus": "" });
  assert.equal(naming.routeName("coach", "12", "A → B"), "Car Nomad 12: A → B");
  assert.equal(naming.routeName("coach", "", "A → B"), "Car Nomad: A → B");
  assert.equal(naming.routeName("bus", "12", "A → B"), "Bus 12: A → B");
  assert.equal(naming.routeName("trolleybus", "12", "A → B"), "Trolleybus 12: A → B");
  configure();
  assert.equal(naming.routeName("coach", "12", "A → B"), "Coach 12: A → B");
});

test("route names", () => {
  assert.equal(naming.routeName("bus", "12", naming.tripLabel("A", "B")), "Bus 12: A → B");
  assert.equal(naming.routeName("bus", "12", naming.tripLabel("A", "B", ["X", "Y"])), "Bus 12: A → X → Y → B");
  assert.equal(naming.routeName("coach", "", naming.tripLabel("A", "B")), "Coach: A → B");
  assert.equal(naming.routeName("bus", "1", naming.tripLabel("Gare: Nord", "B")), "Bus 1: Gare - Nord → B"); // ":" would end the "Bus 1:" part
  assert.equal(naming.routeName("bus", "12", "A ↔ B"), "Bus 12: A ↔ B");
  const long = naming.tripLabel("A", "B", ["x".repeat(300)]);
  assert.equal(naming.routeName("bus", "12", long, naming.tripLabel("A", "B")), "Bus 12: A → B"); // too long for OSM: without the via
  assert.ok(naming.routeName("bus", "12", long).length <= 255);
  // two termini, whatever the branches: those most trips use
  assert.equal(naming.masterLabel([["VIMONT", "CAEN", 2], ["CONTEVILLE", "CAEN", 40], ["MOULT", "CAEN", 5], ["CAEN", "CONTEVILLE", 38], ["CAEN", "MOULT", 4]]), "CONTEVILLE ↔ CAEN");
  assert.equal(naming.masterLabel([["A", "A", 3]]), "A"); // a loop
  assert.ok(["A ↔ B", "B ↔ A"].includes(naming.masterEndpointsLabel([["A", "B"], ["B", "A"]])));
  assert.equal(naming.masterEndpointsLabel([["A1", "B"], ["B", "A1"], ["A2", "B"]]), "A1 / A2 ↔ B");
});

test("slug and nameKey", () => {
  assert.equal(naming.slug("Nomad Car (Région)"), "nomad-car-region");
  assert.equal(naming.nameKey("Hôpital - Nord"), naming.nameKey("HOPITAL NORD"));
});

test("agencyNetworks", () => {
  settings.networks = { "ATOUMOD040:Network:040:LOC": { network: "Nomad", "network:wikidata": "Q98131290" }, "Bus Co": { network: "BC" } };
  const networks = naming.agencyNetworks([
    { agency_id: "ATOUMOD040:Network:040:LOC", agency_name: "Nomad Car (Région Normandie)" },
    { agency_id: "ATOUMOD036:Network:036:LOC", agency_name: "Astrobus (Lisieux Normandie)" },
    { agency_id: "X", agency_name: "Bus Co" },
    { agency_id: "", agency_name: "" },
  ]);
  assert.equal(networks["ATOUMOD040:Network:040:LOC"]["network:wikidata"], "Q98131290");
  assert.deepEqual(networks["ATOUMOD036:Network:036:LOC"], { network: "Astrobus" });
  assert.deepEqual(networks.X, { network: "BC" });
  assert.deepEqual(networks[""], { network: "GTFS" });
});

const ACCENTS = new Map([["routiere", "routière"], ["ecole", "école"], ["andre", "andré"], ["eglise", "église"]]);
for (const [name, fixed] of [["Gare Routiere", "Gare Routière"], ["EGLISE", "ÉGLISE"], ["Ecole Saint-Andre", "École Saint-André"],
  ["Lycée Léopold Sédar Senghor", "Lycée Léopold Sédar Senghor"], ["Clemenceau", "Clemenceau"], ["Rue de la Marche", "Rue de la Marche"]]) {
  test(`fixAccents: ${name}`, () => assert.equal(naming.fixAccents(name, ACCENTS), fixed));
}

test("accentsFrom takes the accents of the same words, keeping the case", () => {
  assert.equal(naming.accentsFrom("Gare Routiere", "GARE ROUTIÈRE"), "Gare Routière");
  assert.equal(naming.accentsFrom("EGLISE", "Église"), "ÉGLISE");
  assert.equal(naming.accentsFrom("Gare Routière", "gare routiere"), "Gare Routière"); // accents already there are kept
  assert.equal(naming.accentsFrom("Gare Nord", "Gare Sud"), "Gare Nord"); // other words: unchanged
});

test("cleanStopName trims", () => assert.equal(naming.cleanStopName("  Gare   Routiere "), "Gare Routiere"));
