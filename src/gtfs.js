// GTFS reading and normalisation, and choice of the variants (stop sequences) to map for each route.
//
// Any feed that follows the GTFS reference is accepted (files may sit in a sub-folder of the archive). Values
// are strings with "" for missing ones, and the optional files and columns are added with their GTFS default:
// - agency.txt may be missing (single unnamed agency), routes.agency_id may be empty (single-agency feed);
// - shapes.txt, trips.shape_id and trips.direction_id may be missing (variants are then routed through stops);
// - stops without a name inherit their parent station's name; only boarding locations with coordinates are kept.
//
// Big tables are never loaded whole: scan() streams a file row by row and the caller keeps what it needs.

import { entryStream, zipEntries } from "./zip.js";
import { counter, listIn, mostCommon, setIn, sortedBy } from "./util.js";

const REQUIRED = ["routes", "trips", "stops", "stop_times"];
const OPTIONAL_COLUMNS = {
  agency: ["agency_id", "agency_name"],
  routes: ["agency_id", "route_short_name", "route_long_name", "route_type", "route_color", "route_text_color"],
  trips: ["direction_id", "shape_id"],
  stops: ["stop_code", "stop_name", "location_type", "parent_station", "wheelchair_boarding", "platform_code"],
};
const TRIP_COLUMNS = ["route_id", "trip_id", "direction_id", "shape_id"];

/** Fields of a CSV line. Quotes are handled, spaces after a separator ignored. */
export function splitCsvLine(line, sep = ",") {
  if (!line.includes('"')) return line.split(sep).map((v) => v.trimStart());
  const out = [];
  let i = 0;
  while (i <= line.length) {
    while (line[i] === " ") i++;
    if (line[i] !== '"') {
      let end = line.indexOf(sep, i);
      if (end < 0) end = line.length;
      out.push(line.slice(i, end));
      i = end + 1;
      continue;
    }
    let value = "";
    i++;
    for (;;) {
      const q = line.indexOf('"', i);
      if (q < 0) {
        value += line.slice(i);
        i = line.length;
        break;
      }
      value += line.slice(i, q);
      i = q + 1;
      if (line[i] !== '"') break;
      value += '"';
      i++;
    }
    const end = line.indexOf(sep, i);
    out.push(value + (end < 0 ? line.slice(i) : line.slice(i, end)));
    i = end < 0 ? line.length + 1 : end + 1;
  }
  return out;
}

const oddQuotes = (line) => {
  let odd = false;
  for (let i = line.indexOf('"'); i >= 0; i = line.indexOf('"', i + 1)) odd = !odd;
  return odd;
};

/** Call onLine(line) for each line of a text stream (a line break inside quotes does not end a line). */
async function eachLine(textStream, onLine) {
  const reader = textStream.getReader();
  let rest = "", open = "";
  const emit = (raw) => {
    const line = open ? `${open}\n${raw}` : raw;
    if (raw.includes('"') && oddQuotes(line)) open = line;
    else {
      open = "";
      onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const parts = (rest + value).split("\n");
    rest = parts.pop();
    for (const part of parts) emit(part);
  }
  if (rest || open) emit(rest);
}

export class GTFSError extends Error {}

export class Feed {
  constructor(blob, entries) {
    this.blob = blob;
    this.files = new Map(entries.map((e) => [e.name.split("/").pop(), e]));
    this.cache = {};
    this.agenciesOfStops = null;
  }

  /** Feed of a ZIP Blob. GTFSError if a required file is missing. */
  static async open(blob) {
    const feed = new Feed(blob, await zipEntries(blob));
    const missing = REQUIRED.filter((name) => !feed.has(name));
    if (missing.length) throw new GTFSError(`Incomplete GTFS archive, missing files: ${missing.join(", ")}`);
    return feed;
  }

  has(name) {
    return this.files.has(`${name}.txt`);
  }

  /** Parsed rows of a table: onHeader(names) once, then onFields(values) for each row. */
  async eachRow(name, onHeader, onFields) {
    const entry = this.files.get(`${name}.txt`);
    if (!entry) throw new GTFSError(`${name}.txt is missing from the GTFS archive`);
    const stream = (await entryStream(this.blob, entry)).pipeThrough(new TextDecoderStream()); // drops the BOM
    let started = false;
    await eachLine(stream, (line) => {
      if (!line) return;
      const fields = splitCsvLine(line);
      if (started) return onFields(fields);
      started = true;
      onHeader(fields.map((f) => f.trim()));
    });
  }

  /** Stream a table: onRow(values) for each row, values in the order of columns ("" if missing). */
  async scan(name, columns, onRow) {
    let indices;
    await this.eachRow(name, (header) => { indices = columns.map((c) => header.indexOf(c)); },
      (fields) => onRow(indices.map((i) => (i < 0 ? "" : fields[i] ?? ""))));
  }

  /** Whole table as objects, restricted to columns if given; missing optional columns added empty. */
  async read(name, columns = null) {
    const rows = [];
    let indices;
    await this.eachRow(name, (header) => {
      const wanted = new Set([...(columns || header), ...(OPTIONAL_COLUMNS[name] || [])]);
      indices = [...wanted].map((c) => [c, header.indexOf(c)]);
    }, (fields) => {
      const row = {};
      for (const [c, i] of indices) row[c] = i < 0 ? "" : fields[i] ?? "";
      rows.push(row);
    });
    return rows;
  }

  /** Language of the feed in lower case ("fr"), "" if it does not say. */
  language() {
    return this.once("language", async () => {
      const info = this.has("feed_info") ? (await this.read("feed_info", ["feed_lang"]))[0]?.feed_lang : "";
      const lang = info || (await this.agency())[0]?.agency_lang || "";
      return /^[a-z]{2,3}\b/i.test(lang) ? lang.slice(0, /^[a-z]{3}\b/i.test(lang) ? 3 : 2).toLowerCase() : "";
    });
  }

  once(key, load) {
    return (this.cache[key] ??= load());
  }

  agency() {
    return this.once("agency", async () =>
      this.has("agency") ? this.read("agency") : [{ agency_id: "", agency_name: "" }]);
  }

  routes() {
    return this.once("routes", async () => {
      const [routes, agency] = await Promise.all([this.read("routes"), this.agency()]);
      for (const r of routes) {
        if (agency.length === 1 && !r.agency_id) r.agency_id = agency[0].agency_id; // optional in single-agency feeds
        r.mode = osmRoute(r.route_type);
      }
      return routes;
    });
  }

  trips() {
    return this.once("trips", async () => {
      const trips = await this.read("trips", TRIP_COLUMNS);
      if (!this.has("shapes")) for (const t of trips) t.shape_id = "";
      return trips;
    });
  }

  /** Boarding stops (location_type 0) with coordinates, with number lat / lon. */
  stops() {
    return this.once("stops", async () => {
      const all = await this.read("stops");
      const names = new Map(all.map((s) => [s.stop_id, s.stop_name]));
      const out = [];
      for (const s of all) {
        if (!s.stop_name) s.stop_name = names.get(s.parent_station) || "";
        if ((s.location_type === "" || s.location_type === "0") && s.stop_lat !== "" && s.stop_lon !== "") {
          s.lat = Number(s.stop_lat);
          s.lon = Number(s.stop_lon);
          out.push(s);
        }
      }
      return out;
    });
  }

  /** Stop times {trip_id, stop_id, stop_sequence} of these trips. The first call also indexes the agencies
   * serving each stop (stopAgencies), which needs the same pass over the file. */
  async stopTimes(tripIds) {
    const wanted = new Set(tripIds), out = [];
    let tripAgency = null, agencies = null;
    if (!this.agenciesOfStops) {
      const agencyOf = new Map((await this.routes()).map((r) => [r.route_id, r.agency_id]));
      tripAgency = new Map((await this.trips()).map((t) => [t.trip_id, agencyOf.get(t.route_id)]));
      agencies = new Map();
    }
    await this.scan("stop_times", ["trip_id", "stop_id", "stop_sequence", "arrival_time", "departure_time"], ([trip_id, stop_id, sequence, arrival, departure]) => {
      if (!stop_id) return; // flexible trips (location_id) have no stop
      if (agencies) {
        const agency = tripAgency.get(trip_id);
        if (agency !== undefined) {
          setIn(agencies, stop_id).add(agency);
        }
      }
      if (wanted.has(trip_id)) out.push({ trip_id, stop_id, stop_sequence: Number(sequence), arrival, departure });
    });
    if (agencies) this.agenciesOfStops = agencies;
    return out;
  }

  /** stop_id -> Set of the agency_ids of the routes serving it. */
  async stopAgencies() {
    if (!this.agenciesOfStops) await this.stopTimes([]);
    return this.agenciesOfStops;
  }

  /** shape_id -> [[lat, lon]] in sequence order, for the shape_ids found in shapes.txt. */
  async shapes(shapeIds) {
    const wanted = new Set(shapeIds), points = new Map();
    if (!wanted.size || !this.has("shapes")) return new Map();
    const columns = ["shape_id", "shape_pt_lat", "shape_pt_lon", "shape_pt_sequence"];
    await this.scan("shapes", columns, ([id, lat, lon, sequence]) => {
      if (!wanted.has(id)) return;
      listIn(points, id).push([Number(sequence), Number(lat), Number(lon)]);
    });
    return new Map([...points].map(([id, pts]) => [id, pts.sort((a, b) => a[0] - b[0]).map((p) => [p[1], p[2]])]));
  }
}

/** OSM route=* value of a GTFS route_type (basic or extended types), null if unknown. */
export function osmRoute(routeType) {
  const t = /^\s*\d+\s*$/.test(routeType) ? Number(routeType) : NaN;
  const basic = { 0: "tram", 1: "subway", 2: "train", 3: "bus", 4: "ferry", 5: "tram", 6: "aerialway", 7: "funicular",
    11: "trolleybus", 12: "monorail" };
  if (basic[t]) return basic[t];
  const ranges = [[100, 199, "train"], [200, 299, "coach"], [400, 499, "subway"], [700, 799, "bus"], [800, 899, "trolleybus"],
    [900, 999, "tram"], [1000, 1099, "ferry"], [1200, 1299, "ferry"], [1300, 1399, "aerialway"], [1400, 1499, "funicular"]];
  return ranges.find(([lo, hi]) => lo <= t && t <= hi)?.[2] ?? null;
}

const seconds = (time) => {
  const m = /^\s*(\d+):(\d\d)(?::(\d\d))?/.exec(time || "");
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] || 0) : null;
};

/** trips with a stop_seq array (the stop_ids of each trip, in order) and, when the feed gives the times, duration_s. Trips without
 * stop times are dropped. */
export function stopSequences(trips, stopTimes) {
  const byTrip = new Map();
  for (const st of stopTimes) {
    listIn(byTrip, st.trip_id).push(st);
  }
  const out = [];
  for (const t of trips) {
    const times = byTrip.get(t.trip_id);
    if (!times) continue;
    times.sort((a, b) => a.stop_sequence - b.stop_sequence);
    const start = seconds(times[0].departure ?? times[0].arrival), end = seconds(times.at(-1).arrival ?? times.at(-1).departure);
    out.push({ ...t, stop_seq: times.map((s) => s.stop_id), ...(start !== null && end > start ? { duration_s: end - start } : {}) });
  }
  return out;
}

/** Sort key of route numbers: numeric when possible ("2" < "10"), then alphabetical. */
export const refSortKey = (ref) => (/^\d+$/.test(ref) ? [0, Number(ref), ""] : [1, 0, ref]);

/** seq is a run of consecutive stops of the longer sequence other (PTNA's "part of the itinerary"). */
export function isSubRoute(seq, other) {
  if (seq.length >= other.length) return false;
  for (let i = 0; i <= other.length - seq.length; i++) {
    if (seq.every((s, j) => other[i + j] === s)) return true;
  }
  return false;
}

const SEP = "\u0001";

/** duration=* value (HH:MM, as the wiki asks) of a number of seconds. */
function formatDuration(s) {
  const minutes = Math.round(s / 60);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** {direction, seq, shape_id, trip_id, trips (their number), duration} of each distinct stop sequence per direction (all services, short turns
 * included), most frequent first, except those contained as such in a longer sequence of the same direction.
 * shape_id is the most frequent one of the sequence ("" if none), duration the median of its trips, when known. When its trips follow several
 * shapes, shape_ids and trip_ids list them, with one sample trip for each. */
export function lineVariants(trips) {
  const directions = new Map();
  for (const t of trips) {
    const d = t.direction_id || "0";
    listIn(directions, d).push(t);
  }
  const out = [];
  for (const direction of [...directions.keys()].sort()) {
    const dirTrips = directions.get(direction);
    const keys = counter(dirTrips.map((t) => t.stop_seq.join(SEP)));
    const sequences = new Map(dirTrips.map((t) => [t.stop_seq.join(SEP), t.stop_seq]));
    for (const [key] of mostCommon(keys)) {
      const seq = sequences.get(key);
      if (seq.length < 2 || [...sequences.values()].some((o) => isSubRoute(seq, o))) continue;
      const seqTrips = dirTrips.filter((t) => t.stop_seq.join(SEP) === key);
      const [shape_id] = sortedBy(counter(seqTrips.map((t) => t.shape_id)), ([id, n]) => [-n, id])[0];
      const durations = seqTrips.map((t) => t.duration_s).filter(Boolean).sort((a, b) => a - b);
      const shapes = sortedBy(counter(seqTrips.map((t) => t.shape_id)), ([id, n]) => [-n, id]).map(([id]) => id).filter(Boolean);
      const sampleOf = (id) => seqTrips.find((t) => t.shape_id === id).trip_id;
      out.push({ direction, seq, shape_id, trip_id: sampleOf(shape_id), trips: seqTrips.length,
        ...(shapes.length > 1 ? { shape_ids: shapes, trip_ids: shapes.map(sampleOf) } : {}),
        ...(durations.length ? { duration: formatDuration(durations[durations.length >> 1]) } : {}) });
    }
  }
  return out;
}

