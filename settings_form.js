// The Settings page, generated from SCHEMA (src/settings.js). Only what differs from the defaults is kept, in this browser.

import { ITEMS, SCHEMA, SECTIONS, configure } from "./src/settings.js";

const STORE = "tissway.settings";
const fieldOf = new Map(); // key -> {read, write, row, error}
let overrides = {};
let onChange = () => {};

export const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const itemOf = (key) => ITEMS.find((i) => i.key === key);

function load() {
  try {
    // a setting that does not exist any more must not cost the others, API keys included
    overrides = Object.fromEntries(Object.entries(JSON.parse(localStorage.getItem(STORE)) || {}).filter(([k]) => itemOf(k)));
    configure(overrides);
  } catch {
    overrides = {};
    configure();
  }
}

function save() {
  try {
    localStorage.setItem(STORE, JSON.stringify(overrides));
  } catch { /* storage unavailable: kept until the page is closed */ }
}

/** Number of settings changed from their default. */
export const modifiedCount = () => Object.keys(overrides).length;

/** Back to the settings of the page, dropping what a run detected ("auto" values). */
export const applySettings = () => configure(overrides);

/** The field of a key follows its length: wider first, then on more lines once it has the whole row. */
function fitSecret(input) {
  if (input.dataset.secret === undefined) return;
  input.style.width = `min(100%, ${Math.max(24, input.value.length * 1.15 + 3)}ch)`;
  input.style.height = "auto";
  if (input.scrollHeight) input.style.height = `${input.scrollHeight + 2}px`; // 0 while the page is hidden
}

/** To call when the Settings page is shown: a hidden field cannot be measured. */
export const fitSecrets = () => document.querySelectorAll("[data-secret]").forEach(fitSecret);
addEventListener("resize", fitSecrets);

function parseValue(item, input) {
  switch (item.type) {
    case "secret": return input.value.replace(/\s+/g, ""); // a key has no space; a paste may bring line breaks
    case "boolean": return input.checked;
    case "number": {
      const n = Number(input.value);
      if (input.value.trim() === "" || !Number.isFinite(n)) throw new Error("Enter a number.");
      if ((item.min !== undefined && n < item.min) || (item.max !== undefined && n > item.max)) {
        throw new Error(`Between ${item.min ?? "-∞"} and ${item.max ?? "∞"}.`);
      }
      return n;
    }
    case "list": return input.value.split(",").map((x) => x.trim()).filter(Boolean);
    case "json": {
      const v = JSON.parse(input.value.trim() || "{}");
      if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("Enter a JSON object.");
      return v;
    }
    case "colour": {
      const colour = input.value.trim();
      if (colour && !/^#?[0-9A-Fa-f]{6}$/.test(colour)) throw new Error("Enter a colour as #RRGGBB, or nothing.");
      return colour && `#${colour.replace("#", "").toUpperCase()}`;
    }
    case "url": {
      const url = input.value.trim();
      if (!/^https?:\/\/[^\s]+$/.test(url)) throw new Error("Enter an http(s) URL.");
      return url;
    }
    default: return input.value.trim();
  }
}

function showValue(item, input, value) {
  if (item.type === "boolean") input.checked = value;
  else if (item.type === "list") input.value = value.join(", ");
  else if (item.type === "json") input.value = Object.keys(value).length ? JSON.stringify(value, null, 2) : "";
  else input.value = value;
}

function makeInput(item) {
  const id = `setting-${item.key}`;
  const common = { id, name: item.key };
  switch (item.type) {
    case "boolean": return el("input", { ...common, type: "checkbox", role: "switch" });
    case "select": return el("select", common, ...item.options.map((o) => new Option(o, o)));
    case "json": return el("textarea", { ...common, rows: 5, spellcheck: false, placeholder: "{}" });
    case "number": return el("input", { ...common, type: "number", step: item.step ?? "any", ...(item.min !== undefined ? { min: item.min } : {}), ...(item.max !== undefined ? { max: item.max } : {}) });
    case "secret": {
      // a password field keeps to one line: a text area, masked, takes the longest tokens
      const area = el("textarea", { ...common, rows: 1, autocomplete: "off", spellcheck: false, autocapitalize: "off", wrap: "soft" });
      area.dataset.secret = "";
      area.classList.add("secret");
      area.addEventListener("input", () => fitSecret(area));
      area.addEventListener("keydown", (e) => { if (e.key === "Enter") e.preventDefault(); });
      return area;
    }
    case "url": return el("input", { ...common, type: "url", spellcheck: false });
    default: return el("input", { ...common, type: "text", spellcheck: false });
  }
}

/** Reflect one setting: its value, its "modified" mark and its reset link. */
function refresh(key) {
  const item = itemOf(key), f = fieldOf.get(key);
  const value = key in overrides ? overrides[key] : item.value;
  showValue(item, f.input, value);
  fitSecret(f.input);
  f.error.textContent = "";
  f.mark.hidden = !(key in overrides);
  f.reset.hidden = !(key in overrides);
}

function change(key) {
  const item = itemOf(key), f = fieldOf.get(key);
  let value;
  try {
    value = parseValue(item, f.input);
  } catch (e) {
    f.error.textContent = e.message;
    return;
  }
  if (same(value, item.value)) delete overrides[key];
  else overrides[key] = value;
  save();
  configure(overrides);
  f.error.textContent = "";
  f.mark.hidden = !(key in overrides);
  f.reset.hidden = !(key in overrides);
  onChange(key);
}

function resetOne(key) {
  delete overrides[key];
  save();
  configure(overrides);
  refresh(key);
  onChange(key);
}

function makeRow(item) {
  const input = makeInput(item);
  const mark = el("span", { className: "modified", textContent: "Changed", hidden: true });
  const reset = el("button", { type: "button", className: "link", hidden: true, textContent: "Reset to default" });
  const error = el("div", { className: "setting-error", role: "alert" });
  const shown = item.type === "boolean" ? (item.value ? "on" : "off")
    : item.type === "json" || item.type === "list" ? JSON.stringify(item.value)
      : `${item.value}${item.unit && !item.unit.includes(" ") ? ` ${item.unit}` : ""}`;
  const help = [item.help, item.type === "secret" || shown === "" || shown === "{}" || shown === "[]" ? "" : `Default: ${shown}.`].filter(Boolean).join(" ");
  const title = el("label", { className: "setting-label", htmlFor: input.id }, item.label, mark);
  const about = el("div", {}, title, el("p", { className: "setting-help", textContent: help }));
  const reveal = el("label", { className: "check reveal" }, el("input", { type: "checkbox", role: "switch" }), "Show");
  reveal.firstChild.addEventListener("change", (e) => input.classList.toggle("shown", e.target.checked));
  const control = item.type === "secret" ? el("div", { className: "setting-control" }, input, reveal, error, reset)
    : item.type === "boolean"
    ? el("div", { className: "setting-control setting-toggle" }, input, reset)
    : el("div", { className: "setting-control" }, item.unit ? el("div", { className: "with-unit" }, input, el("span", { className: "unit", textContent: item.unit })) : input, error, reset);
  const row = el("div", { className: `setting${item.type === "json" || item.type === "secret" ? " wide" : ""}` }, about, control);
  row.dataset.search = `${item.key} ${item.label} ${item.help ?? ""}`.toLowerCase();
  input.addEventListener("change", () => change(item.key));
  reset.addEventListener("click", () => resetOne(item.key));
  fieldOf.set(item.key, { input, mark, reset, error, row });
  return row;
}

function filter(text) {
  const words = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  for (const card of document.querySelectorAll(".settings-group")) {
    let visible = 0;
    for (const row of card.querySelectorAll(".setting")) {
      row.hidden = !words.every((w) => row.dataset.search.includes(w));
      if (!row.hidden) visible++;
    }
    card.hidden = !visible;
  }
}

/** The settings as a file, without the secrets. */
function exportSettings() {
  const clean = Object.fromEntries(Object.entries(overrides).filter(([k]) => itemOf(k)?.type !== "secret"));
  const a = el("a", { href: URL.createObjectURL(new Blob([`${JSON.stringify(clean, null, 2)}\n`], { type: "application/json" })), download: "tissway-settings.json" });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function importSettings(file, status) {
  try {
    const data = JSON.parse(await file.text());
    configure(data); // refuses an unknown key
    overrides = { ...data };
    for (const section of SECTIONS) {
      for (const [k, v] of Object.entries(overrides[section] || {})) overrides[`${section}.${k}`] = v;
      delete overrides[section];
    }
    save();
    configure(overrides);
    for (const item of ITEMS) refresh(item.key);
    status("good", `Imported ${Object.keys(overrides).length} setting(s).`);
    onChange();
  } catch (e) {
    configure(overrides);
    status("error", `Not imported: ${e.message}`);
  }
}

/** Change a setting from elsewhere on the site: same value, same memory as on the Settings page. */
export function setOption(key, value) {
  const f = fieldOf.get(key);
  showValue(itemOf(key), f.input, value);
  change(key);
}

/** Build the page. changed(key) is called after each change. */
export function initSettings(changed) {
  onChange = changed;
  load();
  const form = document.getElementById("settings-form");
  form.replaceChildren(...SCHEMA.map((group) => el("section", { className: "card settings-group" },
    el("header", {}, el("h2", { textContent: group.group }), ...(group.intro ? [el("p", { textContent: group.intro })] : [])),
    ...group.items.map(makeRow))));
  for (const item of ITEMS) refresh(item.key);

  const message = document.getElementById("settings-status");
  const status = (kind, text) => {
    message.className = `status ${kind}`;
    message.textContent = text;
  };
  document.getElementById("settings-search").addEventListener("input", (e) => filter(e.target.value));
  document.getElementById("settings-export").addEventListener("click", exportSettings);
  document.getElementById("settings-import").addEventListener("change", (e) => {
    if (e.target.files[0]) importSettings(e.target.files[0], status);
    e.target.value = "";
  });
  document.getElementById("settings-reset").addEventListener("click", () => {
    if (!confirm("Reset every setting to its default, API keys included?")) return;
    overrides = {};
    save();
    configure();
    for (const item of ITEMS) refresh(item.key);
    status("good", "All settings are back to their defaults.");
    onChange();
  });
  return { status };
}
