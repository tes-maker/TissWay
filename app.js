// The page: reads the form, calls src/, shows the log and the files to download. No logic about GTFS or OSM here.
// In the browser console, window.tissway gives access to the settings, the feed and everything computed by the last run.

import { applySettings, fitSecrets, initSettings, modifiedCount, setOption } from "./settings_form.js";
import { Feed } from "./src/gtfs.js";
import { agencyNetworks, slug } from "./src/naming.js";
import { clearCaches, downloadGtfs, feedUrls, services } from "./src/net.js";
import { runRoutes } from "./src/pipeline.js";
import { writeOsm } from "./src/osm.js";
import { runPlatforms } from "./src/platform_tags.js";
import { applyPriority, listRefs, removeRef, restoreRef, sharedPlatforms } from "./src/ref_review.js";
import { buildList, loadNetworks, refKey } from "./src/ptna.js";
import { settings } from "./src/settings.js";
import { log, sortedBy } from "./src/util.js";
import { renameInFile } from "./src/via.js";

const $ = (id) => document.getElementById(id);
const FEED_STORE = "tissway.feed";

const state = { feed: null, viaFile: null, loading: false, routes: [], networks: new Map(), line: null, controller: null, urls: [], warnings: 0 };
window.tissway = { state, settings, services, log };

// --- log --------------------------------------------------------------------------------------------------

log.sink = (level, message) => {
  const journal = $("journal");
  const atEnd = journal.scrollHeight - journal.scrollTop - journal.clientHeight < 40;
  journal.append(Object.assign(document.createElement("li"), { className: level, textContent: message }));
  if (atEnd) journal.scrollTop = journal.scrollHeight;
  if (level === "warn" || level === "error") {
    state.warnings++;
    showWarningCount();
  }
};

function showWarningCount() {
  $("warning-count").textContent = state.warnings;
  $("warning-count").hidden = !state.warnings;
}

// --- running a task ---------------------------------------------------------------------------------------

function showError(message) {
  $("error").textContent = message;
  $("error").hidden = !message;
}

/** The parts of the box that depend on what is loaded and on what is running. */
function refresh() {
  const busy = Boolean(state.controller), ready = Boolean(state.feed || state.viaFile);
  $("source").hidden = ready || state.loading;
  $("gtfs-load").disabled = busy;
  $("chip").hidden = !ready;
  $("chip-change").disabled = busy;
  $("loading").hidden = !state.loading;
  $("options").hidden = !state.feed;
  $("via").hidden = !state.viaFile;
  $("action").hidden = !ready || busy;
  $("working").hidden = !busy || state.loading;
  refreshConvert();
}

/** Run fn with the Cancel button and the log; every error ends up in the log and on the page, nothing is swallowed. */
async function task(fn) {
  if (state.controller) return;
  applySettings(); // what a previous run detected does not carry over
  state.controller = new AbortController();
  services.signal = state.controller.signal;
  showError("");
  refresh();
  const started = Date.now();
  try {
    await fn();
    log.info(`Done in ${Math.round((Date.now() - started) / 1000)} s`);
  } catch (e) {
    if (e.name === "AbortError") log.warn("Cancelled");
    else {
      log.sink("error", e.message);
      log.debug(e.stack || "");
      console.error(e);
      showError(e.message);
    }
  } finally {
    $("progress").textContent = "";
    state.controller = null;
    services.signal = null;
    refresh();
  }
}

const progress = (message) => { $("progress").textContent = message; };
const el = (tag, props = {}) => Object.assign(document.createElement(tag), props);

/** Show the files to download, and what the run found. */
function showResult({ files, preview = null, summary = {}, detected = [], warningsBefore = 0 }) {
  for (const url of state.urls) URL.revokeObjectURL(url);
  state.urls = [];
  $("downloads").replaceChildren(...files.map(({ name, text, type }) => {
    const a = el("a", { className: "download", href: URL.createObjectURL(new Blob([text], { type })), download: name, textContent: `Download ${name} (${Math.max(1, Math.round(text.length / 1024))} KB)` });
    state.urls.push(a.href);
    return a;
  }));
  $("summary").textContent = Object.entries(summary).map(([k, v]) => `${v} ${v === 1 ? k.replace(/s$/, "") : k}`).join(" · ");
  const warnings = state.warnings - warningsBefore;
  $("show-warnings").textContent = `${warnings} warning${warnings > 1 ? "s" : ""} to check`;
  $("show-warnings").hidden = !warnings;
  $("detected").replaceChildren(...detected.flatMap(([k, v]) => [el("dt", { textContent: k }), el("dd", { textContent: v })]));
  $("detected-box").hidden = !detected.length;
  $("preview-box").hidden = preview === null;
  $("preview").value = preview ?? "";
  $("show-refs").hidden = !state.review;
  $("result").hidden = false;
  $("result").focus({ preventScroll: true });
  $("result").scrollIntoView({ block: "nearest" });
}

/** The window before the download, when the file has shared stops or refs that were corrected or are to check. */
function offerReview(review, show) {
  state.review = review;
  state.showReviewed = show;
  show();
  if (review.order.length > 1 || review.corrected.length || review.toCheck.length || listRefs(review).some((r) => r.reason)) openReview();
}

function fillList(id, items) {
  $(id).replaceChildren(...items.map((text) => el("li", { textContent: text })));
  $(`${id}-box`).hidden = !items.length;
  $(`${id}-count`).textContent = items.length;
}

function showReview() {
  const { order, corrected, toCheck } = state.review;
  $("ref-priority").hidden = order.length < 2;
  $("ref-order").replaceChildren(...order.map((network, i) => {
    const li = el("li");
    const move = (label, step, disabled) => {
      const button = el("button", { type: "button", className: "small", textContent: label, disabled, ariaLabel: `${network}: ${step < 0 ? "up" : "down"}` });
      button.addEventListener("click", () => moveNetwork(i, step));
      return button;
    };
    li.append(el("span", { textContent: network }), move("↑", -1, i === 0), move("↓", 1, i === order.length - 1));
    return li;
  }));
  fillList("ref-corrected", corrected);
  fillList("ref-check", toCheck);
  showShared();
  showRefRows();
}

function showShared() {
  fillList("ref-shared", sharedPlatforms(state.review).map(({ key, name, refs }) => `${name} (${key}): ${refs.map(([k, v]) => `${k}=${v}`).join(", ") || "no ref"}`));
}

const MAX_REF_ROWS = 200; // the Platforms format can give thousands of refs: the search narrows them

function refRow(row, label, action) {
  const li = el("li");
  const text = el("span", { textContent: `${row.name} (${row.platform}): ${row.tag}=${row.value}` });
  if (row.reason) text.append(el("small", { textContent: row.reason }));
  const button = el("button", { type: "button", className: "small", textContent: label, ariaLabel: `${label} ${row.tag}=${row.value} of ${row.name}` });
  button.addEventListener("click", () => {
    action(state.review, row);
    state.reviewChanged = true;
    showShared();
    showRefRows();
  });
  li.append(text, button);
  return li;
}

/** The obsolete refs proposed, or all of them, and those removed. */
function showRefRows() {
  const rows = listRefs(state.review), proposed = rows.filter((r) => r.reason);
  const words = $("ref-search").value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = ($("ref-show-all").checked ? rows : proposed).filter((r) => words.every((w) => `${r.name} ${r.platform} ${r.tag} ${r.value}`.toLowerCase().includes(w)));
  $("ref-obsolete-box").hidden = !rows.length && !state.review.removed.length;
  $("ref-obsolete-count").textContent = proposed.length;
  $("ref-remove-all").hidden = !proposed.length;
  $("ref-obsolete-hint").textContent = [proposed.length ? "Proposed from the GTFS, nothing is removed until you ask." : "The GTFS shows no obsolete ref. Those of other networks cannot be judged: show every ref to remove one by hand.",
    shown.length > MAX_REF_ROWS ? `First ${MAX_REF_ROWS} of ${shown.length}: search to narrow them.` : ""].filter(Boolean).join(" ");
  $("ref-rows").replaceChildren(...shown.slice(0, MAX_REF_ROWS).map((row) => refRow(row, "Remove", removeRef)));
  $("ref-removed").replaceChildren(...state.review.removed.map((row) => {
    const li = refRow(row, "Restore", restoreRef);
    li.classList.add("removed");
    return li;
  }));
}

function moveNetwork(i, step) {
  const order = [...state.review.order];
  [order[i], order[i + step]] = [order[i + step], order[i]];
  applyPriority(state.review, order);
  state.reviewMoved = true;
  state.reviewChanged = true;
  showReview();
}

function openReview() {
  showReview();
  $("ref-dialog").showModal();
}

/** The window is closed: the file follows what it shows, and the order chosen is kept for the next conversions. */
function closeReview() {
  if (state.reviewMoved) {
    const { order } = state.review;
    setOption("stop_owners", order); // resets what the run detected: the review has kept what it needs
    log.info(`Ref priority: ${order.join(" > ")}`);
  }
  if (state.reviewChanged) state.showReviewed();
  state.reviewMoved = state.reviewChanged = false;
}

function hideResult() {
  state.review = null;
  $("result").hidden = true;
  showError("");
}

// --- GTFS -------------------------------------------------------------------------------------------------

const mb = (n) => `${(n / 1e6).toFixed(0)} MB`;

async function downloadFeed(id) {
  const { urls, name } = await feedUrls(id);
  if (name) log.info(name);
  const bar = $("gtfs-progress");
  bar.removeAttribute("value");
  let lastError;
  for (const url of urls) {
    try {
      return await downloadGtfs(url, {
        onProgress: (received, total) => {
          if (total) Object.assign(bar, { value: received, max: total });
          $("gtfs-status").textContent = `Downloading: ${mb(received)}${total ? ` of ${mb(total)}` : ""}`;
        },
      });
    } catch (e) {
      if (e.name === "AbortError") throw e;
      lastError = e;
      log.warn(`${url}: ${e.message}`);
    }
  }
  throw new Error(`Feed not available (${lastError?.message}). Download the .zip yourself and choose it as a file.`);
}

/** Load a GTFS feed from a file or from its Mobility Database ID. */
async function loadGtfs(file, id) {
  reset();
  state.loading = true;
  $("gtfs-status").textContent = "Loading the feed…";
  refresh();
  try {
    const blob = file || (await downloadFeed(id));
    state.feed = await Feed.open(blob);
    window.tissway.feed = state.feed;
    await showNetworks();
    const n = state.routes.length;
    $("chip-name").textContent = file ? file.name : id;
    $("chip-info").textContent = `${mb(blob.size)} · ${n} line${n === 1 ? "" : "s"} · ${state.networks.size} network${state.networks.size === 1 ? "" : "s"}`;
    log.info(`Feed loaded: ${n} ${settings.modes.join("/")} line(s), ${state.networks.size} network(s)`);
  } finally {
    state.loading = false;
  }
}

function loadById() {
  const id = $("gtfs-id").value.trim();
  if (!id) {
    showError("Enter a Mobility Database ID, or choose a file.");
    return;
  }
  try {
    localStorage.setItem(FEED_STORE, id);
  } catch { /* storage unavailable */ }
  task(() => loadGtfs(null, id));
}

/** A file was chosen or dropped: a GTFS archive is loaded at once, an .osm file goes to the "via" tool. */
function takeFile(file) {
  if (!file || state.controller) return;
  if (/\.(osm|xml)$/i.test(file.name)) {
    reset();
    state.viaFile = file;
    $("chip-name").textContent = file.name;
    $("chip-info").textContent = "Adds “via …” to route relations sharing a name";
    refresh();
  } else if (/\.zip$/i.test(file.name)) task(() => loadGtfs(file));
  else showError(`${file.name}: choose a GTFS .zip or an .osm file.`);
}

/** Back to the start: nothing loaded, nothing shown. */
function reset() {
  state.feed = null;
  state.viaFile = null;
  state.line = null;
  $("file-input").value = "";
  $("line-filter").value = "";
  hideResult();
  refresh();
}

/** Networks of the GTFS with at least one line of settings.modes, in the select. */
async function showNetworks() {
  const select = $("network");
  const previous = select.value;
  select.replaceChildren();
  state.routes = [];
  state.networks = new Map();
  if (state.feed) {
    const networks = agencyNetworks(await state.feed.agency());
    state.routes = (await state.feed.routes()).filter((r) => settings.modes.includes(r.mode));
    for (const r of state.routes) {
      const name = networks[r.agency_id]?.network ?? (r.agency_id || "GTFS");
      r.networkName = name;
      state.networks.set(name, (state.networks.get(name) || 0) + 1);
    }
  }
  const names = [...state.networks.keys()].sort((a, b) => a.localeCompare(b));
  for (const name of names) select.add(new Option(`${name} (${state.networks.get(name)} line${state.networks.get(name) > 1 ? "s" : ""})`, name));
  if (!names.length) select.add(new Option("No line for these modes", ""));
  if (names.includes(previous)) select.value = previous;
  select.disabled = !names.length;
  showLines();
}

const networkRoutes = () => state.routes.filter((r) => r.networkName === $("network").value);

function visibleRoutes() {
  const words = $("line-filter").value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return networkRoutes().filter((r) => {
    const text = `${r.route_short_name} ${r.route_long_name}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

const HEX = /^[0-9A-Fa-f]{6}$/;

function lineRow(r) {
  const label = el("label", { className: "line" });
  const badge = el("b", { className: "badge", textContent: r.route_short_name || "—" });
  if (HEX.test(r.route_color)) {
    badge.style.background = `#${r.route_color}`;
    badge.style.borderColor = `#${r.route_color}`;
    badge.style.color = HEX.test(r.route_text_color) ? `#${r.route_text_color}` : "#000";
  }
  label.append(el("input", { type: "checkbox", role: "switch", value: r.route_id, checked: r.route_id === state.line }), badge, el("span", { textContent: r.route_long_name }));
  return label;
}

function showLines() {
  $("lines").replaceChildren(...sortedBy(visibleRoutes(), refKey).map(lineRow));
  refreshConvert();
}

const checkedLine = () => networkRoutes().find((r) => r.route_id === state.line);
const format = () => document.querySelector("[name=format]:checked").value;

/** The label of the big button says what it will do, and why it cannot yet. */
function refreshConvert() {
  const button = $("convert");
  if (state.viaFile) {
    button.textContent = "Add “via” to the names";
    button.disabled = false;
    return;
  }
  const line = checkedLine();
  const labels = {
    routes: line ? `Convert line ${line.route_short_name || line.route_long_name} to .osm` : "Turn on a line",
    platforms: "Convert the platforms to .osm",
    ptna: "Create the PTNA list",
  };
  button.textContent = labels[format()];
  button.disabled = !$("network").value || (format() === "routes" && !line);
}

// --- exports ----------------------------------------------------------------------------------------------

const OSM_TYPE = "application/xml";
const selectedNetwork = () => {
  const network = $("network").value;
  if (!network) throw new Error("Choose a network first.");
  return network;
};

async function exportRoutes() {
  const network = selectedNetwork();
  const line = checkedLine();
  if (!line) throw new Error("Turn on a line.");
  const warningsBefore = state.warnings;
  const result = await runRoutes(state.feed, { network, ref: line.route_id, onProgress: progress });
  window.tissway.last = result.state;
  offerReview(result.review, () => showResult({ files: [{ name: result.filename, text: writeOsm(result.review.obj), type: OSM_TYPE }], summary: result.summary, detected: result.detected, warningsBefore }));
}

async function exportPlatforms() {
  const warningsBefore = state.warnings;
  const result = await runPlatforms(state.feed, { network: selectedNetwork(), max_m: Number($("platforms-distance").value) || 30, onProgress: progress });
  offerReview(result.review, () => showResult({ files: [{ name: result.filename, text: writeOsm(result.review.obj), type: OSM_TYPE }, { name: result.csvName, text: result.csv, type: "text/csv" }], summary: result.summary, detected: result.detected, warningsBefore }));
}

async function exportPtna() {
  const network = selectedNetwork();
  const warningsBefore = state.warnings;
  progress("Reading the feed, towns of the termini…");
  const input = $("ptna-input").value;
  const networks = await loadNetworks(state.feed);
  const [lines, report] = await buildList(state.feed, network, {
    inputLines: input.trim() ? input.split(/\r?\n/) : null,
    title: $("ptna-title").value.trim() || null,
    operator: $("ptna-operator").value.trim() || null,
    refGtfs: $("ptna-ref").checked,
  });
  log.info(`Network ${network}: ${networks.get(network).length} lines in the GTFS`);
  for (const message of report) log.info(`  ${message}`);
  if (!report.length) log.info("  no change");
  const text = `${lines.join("\n")}\n`;
  showResult({ files: [{ name: `ptna_${slug($("ptna-title").value.trim() || network)}.txt`, text, type: "text/plain" }], preview: text, summary: { lines: networks.get(network).length }, warningsBefore });
}

async function exportVia() {
  const file = state.viaFile;
  const warningsBefore = state.warnings;
  const { xml, changes, warnings } = await renameInFile(await file.text(), $("via-prefix").value);
  for (const [, name] of changes) log.info(name);
  for (const w of warnings) log.warn(w);
  log.info(`${changes.length} relation(s) renamed`);
  showResult({ files: [{ name: file.name.replace(/(\.\w+)?$/, "_renamed.osm"), text: xml, type: OSM_TYPE }], summary: { renamed: changes.length }, warningsBefore });
}

// --- events -----------------------------------------------------------------------------------------------

function selectView(name) {
  for (const b of document.querySelectorAll("[data-view]")) {
    if (b.dataset.view === name) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  }
  $("view-generate").hidden = name !== "generate";
  $("view-settings").hidden = name !== "settings";
  if (name === "settings") fitSecrets();
  scrollTo(0, 0);
}

/** The settings also on the converter. */
function showOptions() {
  $("split-roundabouts").checked = settings.split_roundabouts;
  document.querySelector(`[name=stop_names][value=${settings.stop_names}]`).checked = true;
}

function showSettingsCount() {
  $("settings-count").textContent = modifiedCount();
  $("settings-count").hidden = !modifiedCount();
}

const EXPORTS = { routes: exportRoutes, platforms: exportPlatforms, ptna: exportPtna };

function convert() {
  hideResult();
  task(state.viaFile ? exportVia : EXPORTS[format()]);
}

function wire() {
  for (const b of document.querySelectorAll("[data-view]")) b.addEventListener("click", () => selectView(b.dataset.view));
  $("gtfs-load").addEventListener("click", loadById);
  $("gtfs-id").addEventListener("keydown", (e) => { if (e.key === "Enter") loadById(); });
  $("file-input").addEventListener("change", (e) => takeFile(e.target.files[0]));
  $("chip-change").addEventListener("click", reset);
  $("convert").addEventListener("click", convert);
  $("cancel").addEventListener("click", () => state.controller?.abort());
  $("cancel-load").addEventListener("click", () => state.controller?.abort());
  $("again").addEventListener("click", () => {
    reset();
    scrollTo(0, 0);
  });
  $("show-warnings").addEventListener("click", () => {
    $("log-box").open = true;
    $("only-warnings").checked = true;
    $("journal").classList.add("only-warnings");
    $("log-box").scrollIntoView({ block: "nearest" });
  });

  const drop = $("drop");
  for (const type of ["dragenter", "dragover"]) {
    drop.addEventListener(type, (e) => {
      e.preventDefault();
      drop.classList.add("over");
    });
  }
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    takeFile(e.dataTransfer.files[0]);
  });
  // a file dropped next to the zone must not replace the page
  for (const type of ["dragover", "drop"]) addEventListener(type, (e) => e.preventDefault());

  $("network").addEventListener("change", () => {
    hideResult();
    state.line = null;
    $("line-filter").value = "";
    showLines();
  });
  $("line-filter").addEventListener("input", showLines);
  // one line at a time: turning one on turns the other off
  $("lines").addEventListener("change", (e) => {
    state.line = e.target.checked ? e.target.value : null;
    for (const box of $("lines").querySelectorAll("input")) box.checked = box.value === state.line;
    refreshConvert();
  });
  for (const radio of document.querySelectorAll("[name=format]")) {
    radio.addEventListener("change", () => {
      hideResult();
      for (const p of document.querySelectorAll("[data-panel]")) p.hidden = p.dataset.panel !== format();
      refreshConvert();
    });
  }

  $("show-refs").addEventListener("click", openReview);
  $("ref-dialog").addEventListener("close", closeReview);
  $("ref-show-all").addEventListener("change", showRefRows);
  $("ref-search").addEventListener("input", showRefRows);
  $("ref-remove-all").addEventListener("click", () => {
    for (const row of listRefs(state.review).filter((r) => r.reason)) removeRef(state.review, row);
    state.reviewChanged = true;
    showShared();
    showRefRows();
  });
  $("split-roundabouts").addEventListener("change", (e) => setOption("split_roundabouts", e.target.checked));
  for (const radio of document.querySelectorAll("[name=stop_names]")) radio.addEventListener("change", () => setOption("stop_names", radio.value));
  $("verbose").addEventListener("change", (e) => $("journal").classList.toggle("verbose", e.target.checked));
  $("only-warnings").addEventListener("change", (e) => $("journal").classList.toggle("only-warnings", e.target.checked));
  $("journal-clear").addEventListener("click", () => {
    $("journal").replaceChildren();
    state.warnings = 0;
    showWarningCount();
  });
  $("journal-copy").addEventListener("click", () => navigator.clipboard.writeText([...$("journal").children].map((li) => li.textContent).join("\n")));
  $("cache-clear").addEventListener("click", async () => {
    await clearCaches();
    settingsPage.status("good", "Downloaded feeds and kept answers cleared.");
  });
}

const settingsPage = initSettings((key) => {
  showSettingsCount();
  showOptions();
  settingsPage?.status("", "");
  if (!state.controller && (key === undefined || key === "modes" || key === "networks")) showNetworks();
});
try {
  $("gtfs-id").value = localStorage.getItem(FEED_STORE) || "";
} catch { /* storage unavailable */ }
window.tissway.settings = settings;
wire();
showSettingsCount();
showOptions();
refresh();
