// Calls to the online services: retries, API keys kept out of the journal, Mobility Database fallbacks.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import "./helpers.js";
import { downloadGtfs, feedUrls, overpass, request, services, valhallaPost } from "../src/net.js";
import { log } from "../src/util.js";

const realFetch = globalThis.fetch;
const defaults = { ...services };
let calls;

/** Replace fetch: handler(url, init) gives the Response. */
const mock = (handler) => {
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  calls = [];
  Object.assign(services, defaults, { retry_ms: 1, valhalla_interval_ms: 0 });
});
afterEach(() => {
  globalThis.fetch = realFetch;
  log.sink = () => {};
});

test("an overloaded server is called again", async () => {
  const answers = [new Response("", { status: 502 }), new Response("", { status: 429 }), json({ ok: 1 })];
  mock(() => answers.shift());
  assert.equal((await request("https://x.test/a")).status, 200);
  assert.equal(calls.length, 3);
});

test("a refused request is not retried", async () => {
  mock(() => new Response("", { status: 404 }));
  assert.equal((await request("https://x.test/a")).status, 404);
  assert.equal(calls.length, 1);
});

test("an unreachable server ends with a readable error", async () => {
  mock(() => { throw new TypeError("Failed to fetch"); });
  await assert.rejects(request("https://x.test/a"), /unreachable/);
  assert.equal(calls.length, 7);
});

test("cancelling stops at once", async () => {
  const controller = new AbortController();
  services.signal = controller.signal;
  controller.abort();
  mock(() => { throw new DOMException("stop", "AbortError"); });
  await assert.rejects(request("https://x.test/a"), { name: "AbortError" });
  assert.equal(calls.length, 1);
});

test("the Valhalla key goes in the URL but never in the journal", async () => {
  const lines = [];
  log.sink = (_, m) => lines.push(m);
  services.valhalla_key = "s3cret";
  mock(() => json({ edges: [] }));
  await valhallaPost("trace_attributes", {});
  assert.ok(calls[0].url.endsWith("/trace_attributes?api_key=s3cret"));
  assert.ok(lines.length && !lines.join().includes("s3cret"));
});

test("Valhalla's own error message is reported", async () => {
  mock(() => json({ error: "No suitable edges near location" }, 400));
  await assert.rejects(valhallaPost("route", {}), /No suitable edges/);
});

test("Overpass error remark is reported", async () => {
  mock(() => json({ elements: [], remark: "runtime error: Query timed out" }));
  await assert.rejects(overpass("node(1);out;"), /timed out/);
});

test("Mobility Database: public file without a key, nothing sent to the API", async () => {
  mock(() => assert.fail("no call expected"));
  assert.deepEqual(await feedUrls("tdg-81942"), { urls: ["https://files.mobilitydatabase.org/tdg-81942/latest.zip"], name: "" });
  await assert.rejects(feedUrls("../etc"), /Invalid/);
});

test("Mobility Database: the token is exchanged, then the hosted dataset comes first", async () => {
  services.mobility_token = "refresh";
  mock((url, init) => {
    if (url.endsWith("/tokens")) {
      assert.deepEqual(JSON.parse(init.body), { refresh_token: "refresh" });
      return json({ access_token: "access" });
    }
    assert.equal(init.headers.Authorization, "Bearer access");
    return json({ provider: "Atoumod", latest_dataset: { hosted_url: "https://files.test/a.zip" }, source_info: { producer_url: "https://prod.test/b.zip" } });
  });
  const { urls, name } = await feedUrls("tdg-81942");
  assert.deepEqual(urls, ["https://files.test/a.zip", "https://files.mobilitydatabase.org/tdg-81942/latest.zip", "https://prod.test/b.zip"]);
  assert.equal(name, "Atoumod");
});

test("Mobility Database: a token that cannot be exchanged is used as it is; an API failure falls back on the public file", async () => {
  services.mobility_token = "direct";
  mock((url, init) => {
    if (url.endsWith("/tokens")) return new Response("", { status: 400 });
    assert.equal(init.headers.Authorization, "Bearer direct");
    return new Response("", { status: 401 });
  });
  assert.deepEqual((await feedUrls("tdg-81942")).urls, ["https://files.mobilitydatabase.org/tdg-81942/latest.zip"]);
});

test("downloadGtfs reports its progress and returns the archive", async () => {
  mock(() => new Response("abcdef", { headers: { "Content-Length": "6" } }));
  const seen = [];
  const blob = await downloadGtfs("https://x.test/g.zip", { onProgress: (r, t) => seen.push([r, t]) });
  assert.equal(await blob.text(), "abcdef");
  assert.deepEqual(seen.at(-1), [6, 6]);
});
