// Every call to an online service goes through request(): throttling, retries and one journal line per call.
// API keys only ever leave the browser towards the service they belong to, and are never written to the journal.

import { settings } from "./settings.js";
import { log, unique } from "./util.js";

// Servers and keys are settings (see settings.js); signal is the AbortSignal of the running task (Cancel button).
export const services = settings.services;

const RETRY_STATUS = new Set([429, 502, 503, 504]);
const RETRIES = 6;
const nextSlot = new Map(); // origin -> time of its next allowed call

const sleep = (ms) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  services.signal?.addEventListener("abort", () => {
    clearTimeout(timer);
    reject(services.signal.reason);
  }, { once: true });
});

const redact = (url) => url.replace(/([?&]api_key=)[^&]*/, "$1***");

async function throttle(origin, interval) {
  if (!interval) return;
  const now = Date.now(), slot = Math.max(now, nextSlot.get(origin) || 0);
  nextSlot.set(origin, slot + interval);
  if (slot > now) await sleep(slot - now);
}

/** fetch with throttling (interval: ms between calls to this server) and retries on overload. */
export async function request(url, init = {}, interval = 0) {
  const label = `${init.method || "GET"} ${redact(url)}`;
  const headers = { ...init.headers };
  // Overpass refuses anonymous scripts; in a browser the User-Agent is the browser's own (and must not be set)
  if (typeof window === "undefined") headers["User-Agent"] = "tissway/1.0 (https://github.com/tes-maker/TissWay)";
  for (let attempt = 0; ; attempt++) {
    await throttle(new URL(url).origin, interval);
    const started = Date.now();
    let response;
    try {
      response = await fetch(url, { ...init, headers, signal: services.signal ?? undefined });
    } catch (e) {
      if (e.name === "AbortError" || attempt >= RETRIES) {
        if (e.name !== "AbortError") log.debug(`${label} -> ${e.message}`);
        throw e.name === "AbortError" ? e : new Error(`${label} : ${e.message} (server unreachable, or cross-origin request refused)`);
      }
      await sleep(services.retry_ms * 2 ** attempt);
      continue;
    }
    log.debug(`${label} -> ${response.status} (${Date.now() - started} ms)`);
    if (!RETRY_STATUS.has(response.status) || attempt >= RETRIES) return response;
    const wait = Number(response.headers.get("Retry-After")) * 1000 || services.retry_ms * 2 ** attempt;
    log.debug(`server overloaded, trying again in ${Math.round(wait / 1000)} s`);
    await sleep(Math.min(wait, 60_000));
  }
}

// --- answers worth keeping ---------------------------------------------------------------------------------

const LOOKUPS = "tissway-lookups";
const remembered = new Map();

/** JSON of a GET that does not change often (a town, a word): asked once, then kept in the browser, as the usage policies of
 * these services require. */
export function cachedJson(url, interval = 0) {
  if (remembered.has(url)) return remembered.get(url);
  const load = async () => {
    const cache = globalThis.caches ? await caches.open(LOOKUPS) : null;
    const hit = await cache?.match(url);
    if (hit) return hit.json();
    const response = await request(url, {}, interval);
    if (!response.ok) throw new Error(`answer ${response.status}`);
    const text = await response.text();
    const data = JSON.parse(text);
    await cache?.put(url, new Response(text));
    return data;
  };
  const answer = load();
  remembered.set(url, answer);
  answer.catch(() => remembered.delete(url));
  return answer;
}

/** Forget the kept answers and GTFS archives. */
export async function clearCaches() {
  remembered.clear();
  if (globalThis.caches) await Promise.all([caches.delete(LOOKUPS), caches.delete("tissway-gtfs")]);
}

// --- Valhalla ---------------------------------------------------------------------------------------------

function valhallaUrl(action) {
  const url = `${services.valhalla_url.replace(/\/+$/, "")}/${action}`;
  return services.valhalla_key ? `${url}?api_key=${encodeURIComponent(services.valhalla_key)}` : url;
}

export async function valhallaReady() {
  try {
    return (await request(valhallaUrl("status"))).ok;
  } catch (e) {
    if (e.name === "AbortError") throw e;
    return false;
  }
}

/** JSON answer of Valhalla; throws an Error with Valhalla's message if it refuses the request. */
export async function valhallaPost(action, payload) {
  const response = await request(valhallaUrl(action), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }, services.valhalla_interval_ms);
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Valhalla ${action}: invalid answer (${response.status})`);
  }
  if (data.error || !response.ok) throw new Error(`Valhalla ${action}: ${data.error || response.status}`);
  return data;
}

// --- Overpass ---------------------------------------------------------------------------------------------

/** Elements of an Overpass QL query (the [out:json] header is added). */
export async function overpass(query) {
  const response = await request(services.overpass_url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `data=${encodeURIComponent(`[out:json][timeout:180];${query}`)}`,
  });
  if (!response.ok) throw new Error(`Overpass answered ${response.status}`);
  const data = await response.json();
  if (data.remark && !data.elements?.length) throw new Error(`Overpass: ${data.remark}`);
  return data.elements;
}

// --- Mobility Database ------------------------------------------------------------------------------------

const MOBILITY_API = "https://api.mobilitydatabase.org/v1";
const MOBILITY_FILES = "https://files.mobilitydatabase.org";
const FEED_ID = /^(?:tdg|mdb)-[a-zA-Z0-9-]+$/;

/** Access token of a Mobility Database refresh token (a token that cannot be exchanged is used as it is). */
async function mobilityAccess(token) {
  const response = await request(`${MOBILITY_API}/tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: token }),
  });
  if (!response.ok) return token;
  return (await response.json()).access_token || token;
}

/** Download URLs of a feed, best first. Without a key, or if the API fails: the public latest.zip. */
export async function feedUrls(feedId) {
  if (!FEED_ID.test(feedId)) throw new Error(`Invalid Mobility Database id: "${feedId}" (expected: mdb-… or tdg-…)`);
  const urls = [`${MOBILITY_FILES}/${feedId}/latest.zip`];
  if (!services.mobility_token) return { urls, name: "" };
  try {
    const access = await mobilityAccess(services.mobility_token);
    const response = await request(`${MOBILITY_API}/feeds/${feedId}`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${access}` },
    });
    if (!response.ok) throw new Error(`answer ${response.status}`);
    const meta = await response.json();
    const found = [meta.latest_dataset?.hosted_url, ...urls, meta.source_info?.producer_url]
      .filter((u) => typeof u === "string" && u.startsWith("https://"));
    return { urls: unique(found), name: [meta.provider, meta.feed_name].filter(Boolean).join(" — ") };
  } catch (e) {
    if (e.name === "AbortError") throw e;
    log.warn(`Mobility Database API not available (${e.message}): trying the public file`);
    return { urls, name: "" };
  }
}

/** Blob of a GTFS archive, kept in the browser's cache and downloaded again only when the server has a newer
 * one. onProgress(received bytes, total bytes or 0). */
export async function downloadGtfs(url, { onProgress = () => {} } = {}) {
  const cache = globalThis.caches ? await caches.open("tissway-gtfs") : null;
  const cached = cache ? await cache.match(url) : null;
  if (cached) {
    const head = await request(url, { method: "HEAD" }).catch((e) => {
      if (e.name === "AbortError") throw e;
      return null;
    });
    const stale = head?.ok && (head.headers.get("Last-Modified") || "") !== (cached.headers.get("Last-Modified") || "");
    if (!stale) {
      log.info("GTFS already up to date in the browser cache");
      return cached.blob();
    }
  }
  const response = await request(url);
  if (!response.ok) throw new Error(`GTFS download: answer ${response.status}`);
  const total = Number(response.headers.get("Content-Length")) || 0;
  let received = 0;
  const counted = response.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      received += chunk.length;
      onProgress(received, total);
      controller.enqueue(chunk);
    },
  }));
  const blob = await new Response(counted).blob();
  try {
    await cache?.put(url, new Response(blob, {
      headers: { "Last-Modified": response.headers.get("Last-Modified") || "" },
    }));
  } catch (e) {
    log.debug(`GTFS not cached: ${e.message}`);
  }
  return blob;
}
