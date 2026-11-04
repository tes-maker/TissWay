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
  ["Saint-Manvieu-Norrey", "Norrey Calvaire", "Norrey Calvaire"],
  ["Colomby-Anguerny", "Anguerny - Coursanne", "Anguerny - Coursanne"],
  ["Feuguerolles-Bully", "Bully", "Bully"],
  ["Carentan-les-Marais", "Carentan", "CARENTAN-LES-MARAIS"],
  ["Cherbourg-en-Cotentin", "CHERBOURG-GARE", "CHERBOURG-GARE"],
  ["Saint-Pierre-en-Auge", "Saint-Pierre-sur-Dives", "Saint-Pierre-sur-Dives"],
  ["Saint-Aubin-lès-Elbeuf", "Elbeuf - Saint-Aubin", "Elbeuf - Saint-Aubin"],
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

for (const [places, name, renamed] of [
  ["Caen", "Gare", "CAEN - Gare"],
  ["Caen", "Caen Gare", "CAEN - Gare"],
  ["Caen", "CAEN - Gare", "CAEN - Gare"],
  ["Caen", "Gare - Caen", "CAEN - Gare"],
  ["Caen", "Gare (Caen)", "CAEN - Gare"],
  ["Caen", "Gare, Caen", "CAEN - Gare"],
  ["Caen", "Caen", "CAEN"],
  ["Tilly-sur-Seulles", "TILLY-SUR - SEULLES - College", "TILLY-SUR-SEULLES - College"],
  ["Fleury-sur-Orne", "Fleury Mairie", "FLEURY-SUR-ORNE - Mairie"],
  ["Saint-Malo", "St-Malo Gare", "SAINT-MALO - Gare"],
  ["Condé-sur-Noireau", "Condé-sur-Noireau Hôpital", "CONDE-SUR-NOIREAU - Hôpital"],
  [["Garcelles-Secqueville", "Le Castelet"], "Le Castelet Mairie", "LE CASTELET - Mairie"],
  ["Hérouville-Saint-Clair", "CAEN Chemin Vert", "CAEN Chemin Vert"], // another town: left alone
  ["Gaillon", "Mairie Gaillon", "GAILLON - Mairie"],
  ["Mondeville", "Hauts de Mondeville", "Hauts de Mondeville"], // it cannot be taken out: "Hauts de"
  ["Saint-Manvieu-Norrey", "Norrey Calvaire", "Norrey Calvaire"],
  [[], "Gare", "Gare"],
]) {
  test(`townedName: ${name} in ${places}`, () => {
    const once = naming.townedName(places, name);
    assert.equal(once, renamed);
    assert.equal(naming.townedName(places, once), renamed); // run again on its result: no change
  });
}

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
