// PTNA route lists.
import assert from "node:assert/strict";
import { test } from "node:test";
import "./helpers.js";
import * as ptna from "../src/ptna.js";
import { settings } from "../src/settings.js";

const route = ([route_id, route_short_name, route_type, operator, label]) => ({ route_id, route_short_name, route_type, operator, label });
const routes = (...rows) => rows.map(route);

test("fields round trip", () => {
  const line = '12;bus;"A ↔ B";;;Op;FEED;R12;';
  assert.equal(ptna.formatFields(ptna.parseFields(line)), line);
});

test("withLongName orders the termini and keeps via", () => {
  assert.equal(ptna.withLongName("CAEN Gare ↔ FALAISE Mairie", "Falaise <> Caen via Bretteville"), "FALAISE Mairie ↔ CAEN Gare via Bretteville");
  assert.equal(ptna.withLongName(null, "A <> B"), "A ↔ B");
});

test("refKey natural order", () => {
  const refs = ["T1", "12", "6B", "137A", "6", "NAV", "7", "137"];
  const key = (r) => ptna.refKey({ route_short_name: r });
  const sorted = refs.sort((a, b) => {
    const [x, y] = [key(a), key(b)];
    return x[0] - y[0] || x[1] - y[1] || (x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0);
  });
  assert.deepEqual(sorted, ["6", "6B", "7", "12", "137", "137A", "NAV", "T1"]);
});

test("update", () => {
  settings.feed = "FEED";
  const lines = ["== Lignes de bus", '1;bus;"old";;;Op;FEED;X:1;', "9;bus;;;;Op;FEED;X:9;", "</pre>"];
  const [out, report] = ptna.update(lines, routes(["X:1", "1", "3", "Op", "A ↔ B"], ["X:2", "2", "3", "Op", "C ↔ D"]), "Net");
  assert.deepEqual(out, ["== Lignes de bus", '1;bus;"A ↔ B";;;Op;FEED;X:1;', '2;bus;"C ↔ D";;;Op;FEED;X:2;', "# 9;bus;;;;Op;FEED;X:9;", "</pre>"]);
  assert.ok(report.some((r) => r.includes("X:9")));
});

test("generate in English", () => {
  settings.ptna = { id_prefix: "DE-", categories: ["PTNA"] };
  const [out] = ptna.generate("VBN", "VBN", routes(["X:1", "1", "3", "Op", "A ↔ B"]));
  assert.ok(out.includes("= Overview of the VBN network") && out.includes("== Bus lines"));
  assert.ok(out.includes("- Configuration file of [/en/config.php?network=DE-VBN PTNA]"));
});

test("options replace the texts, dates included", () => {
  settings.ptna = { text: { overview: "= Aperçu du {title}", modes: { bus: "Lignes de bus" }, new: "Nouvelles ({date:%d/%m/%Y})" } };
  const [out] = ptna.generate("Nomad", "Nomad", routes(["X:1", "1", "3", "Op", "A ↔ B"]));
  assert.ok(out.includes("= Aperçu du Nomad network") && out.includes("== Lignes de bus"));
  const [updated] = ptna.update(["</pre>"], routes(["X:1", "1", "3", "Op", "A ↔ B"]), "Nomad");
  assert.match(updated[0], /^== Nouvelles \(\d\d\/\d\d\/\d{4}\)$/);
});
