// Settings.
import assert from "node:assert/strict";
import { test } from "node:test";
import "./helpers.js";
import { ITEMS, activeFeed, configure, settings } from "../src/settings.js";
import { services } from "../src/net.js";

test("overrides replace the defaults, and the next ones start from them again", () => {
  configure({ feed: "F", thresholds: { platform_m: 12 } });
  assert.equal(settings.feed, "F");
  assert.equal(settings.thresholds.platform_m, 12);
  assert.equal(settings.thresholds.holder_m, 100);
  configure();
  assert.equal(settings.feed, "auto");
  assert.equal(settings.thresholds.platform_m, 30);
});

test("an unknown key is an error", () => {
  assert.throws(() => configure({ feeed: "F" }), /feeed/);
  assert.throws(() => configure({ thresholds: { nope: 1 } }), /thresholds\.nope/);
});

test("every setting has a label, a description and a default usable by the form", () => {
  for (const item of ITEMS) {
    assert.ok(item.label && "value" in item && item.type, item.key);
    assert.ok(item.type === "secret" || item.help, item.key);
  }
});

test("every number says its unit", () => {
  for (const item of ITEMS.filter((i) => i.type === "number")) assert.ok(item.unit, item.key);
});

test("flat keys are accepted, services keep their object and their signal", () => {
  const signal = {};
  services.signal = signal;
  configure({ "thresholds.platform_m": 7, "services.overpass_url": "https://x.test" });
  assert.equal(settings.thresholds.platform_m, 7);
  assert.equal(services.overpass_url, "https://x.test");
  assert.equal(services.signal, signal);
  services.signal = null;
});

test("nothing is tied to a particular feed by default", () => {
  configure();
  assert.deepEqual(settings.networks, {});
  assert.deepEqual(settings.ptna, {});
  assert.equal(settings.feed, "auto");
  assert.equal(activeFeed(), "");
});
