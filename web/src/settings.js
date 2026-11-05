// Every setting, its default and its description. This list is the single source: the defaults come from it and the
// Settings page of the site is generated from it, so a new setting only has to be added here.
//
// Modules read settings.<name> when they run, so that a change on the page, or in a test, takes effect everywhere. "auto"
// values are replaced during a run by what is detected from the online services (see detect.js). A number has a unit, shown on the page.

const AUTO = "auto";
const capitalized = (s) => s[0].toUpperCase() + s.slice(1);
const NAMED_MODES = ["bus", "coach", "trolleybus", "tram", "train", "subway", "ferry", "monorail", "funicular", "aerialway"];
export const SECTIONS = ["thresholds", "services", "prefixes"];

export const SCHEMA = [
  { group: "API keys and servers", intro: "Stored in this browser only, and only sent to the service they belong to.", items: [
    { key: "services.mobility_token", label: "Mobility Database token", type: "secret", value: "", help: "Optional: the GTFS archive itself is public. Gives the feed's name and its producer's URL as a fallback." },
    { key: "services.valhalla_url", label: "Valhalla server", type: "url", value: "https://valhalla1.openstreetmap.de", help: "Map-matching." },
    { key: "services.valhalla_key", label: "Valhalla API key", type: "secret", value: "", help: "Optional, sent as ?api_key= (private or commercial servers)." },
    { key: "services.valhalla_interval_ms", label: "Delay between Valhalla calls", type: "number", unit: "ms", value: 1100, min: 0, help: "The public FOSSGIS server asks for at most one request per second." },
    { key: "services.overpass_url", label: "Overpass server", type: "url", value: "https://overpass-api.de/api/interpreter", help: "Ways, platforms and relations of OpenStreetMap." },
    { key: "services.nominatim_url", label: "Nominatim server", type: "url", value: "https://nominatim.openstreetmap.org", help: "Town of a stop, country of the feed." },
    { key: "services.lookup_interval_ms", label: "Delay between Nominatim and Wiktionary calls", type: "number", unit: "ms", value: 1100, min: 0, help: "Their usage policies ask for at most one request per second." },
    { key: "services.retry_ms", label: "First wait after an overloaded server", type: "number", unit: "ms", value: 2000, min: 1, help: "Doubled at each new attempt." },
  ] },
  { group: "Network and tagging", intro: "Nothing to fill in by default: these are read from OpenStreetMap and Wikidata during a run.", items: [
    { key: "network_auto", label: "Find the network tags automatically", type: "boolean", value: true, help: "network from the OSM relations of the lines; network:wikidata and network:wikipedia from those relations, else from Wikidata when a single entry is confirmed by its website, or by its type and country." },
    { key: "networks", label: "Network overrides", type: "json", value: {}, help: 'agency_id or agency_name -> tags, for what cannot be found: {"My agency": {"network": "MVV", "network:wikidata": "Q..."}}' },
    { key: "feed", label: "Suffix of the gtfs:* tags", type: "text", value: AUTO, help: '"auto": the code OSM relations already use with the route_ids of this feed (gtfs:route_id:<code>). Empty: no suffix.' },
    { key: "stop_ref_tags", label: "Extra tags holding the stop_id", type: "list", value: [], help: "Comma-separated, on top of the ref:* tags detected in OSM." },
    { key: "ref_from_stop_id", label: "Platform ref from a NeTEx stop_id", type: "select", options: [AUTO, "yes", "no"], value: AUTO, help: 'Without stop_code, ref = the code of "FR:<id>:ZE:<code>:...". "auto": when OSM platforms already follow this.' },
    { key: "stop_owners", label: "Networks owning their stops", type: "list", value: [], help: "Comma-separated, first in priority first. Their code goes in ref on a shared stop, the others in ref:<network>. Empty: the network already in place, or the one with fewer stops in the feed. Also set by the window shown before the download." },
    { key: "network_merges", label: "Merged network names", type: "json", value: {}, help: 'Name -> the name replacing it, false to keep it apart: {"Nomad Car": "Nomad", "TER Express": false}. Also set by the window shown before the download, which asks when two names are very close.' },
    { key: "modes", label: "Modes generated", type: "list", value: ["bus", "coach", "trolleybus"], help: "Comma-separated OSM route=* values." },
    { key: "colour", label: "Line colour (colour)", type: "colour", value: "", help: "#RRGGBB, on every line generated. Empty: route_color of the GTFS." },
    { key: "colour_text", label: "Text colour (colour:text)", type: "colour", value: "", help: "#RRGGBB, on every line generated. Empty: route_text_color of the GTFS." },
    { key: "driving_side", label: "Driving side", type: "select", options: [AUTO, "right", "left"], value: AUTO, help: 'Platforms are on the kerb side. "auto": from the country of the stops (Nominatim, Wikidata).' },
  ] },
  { group: "Operator", intro: "Never taken from the GTFS: its agency is often not the real operator. Stop_positions stay without one, it goes on their platform.", items: [
    { key: "operator", label: "Operator of the line", type: "text", value: "", help: 'Set on the route and route_master relations of the line converted and on its platforms, in place of what its network had. On a shared stop, the operators follow the ref priorities: the first network holding ref comes first (operator=A;B, in the order of network=A;B), and an operator already there stays with the network that owned the stop. Kept for the next conversions: change or empty it for a line with another operator. Empty: operators already mapped are left as they are.' },
  ] },
  { group: "Names", items: [
    { key: "fix_accents", label: "Restore dropped accents", type: "boolean", value: true, help: "From the spelling of nearby OSM platforms, else from Wiktionary in the language of the feed. Every change is listed in the log." },
  ] },
  { group: "Start of the line names", intro: 'What comes before the ref in the names of the relations, by mode of the GTFS line: "Car Nomad" gives "Car Nomad 12: A → B". Empty: the default.', items:
    NAMED_MODES.map((mode) => ({ key: `prefixes.${mode}`, label: capitalized(mode), type: "text", value: capitalized(mode), help: `Lines with route=${mode}.` })) },
  { group: "Relations and ways", items: [
    { key: "update_existing", label: "Update existing relations", type: "boolean", value: true, help: "Off: always create new relations, even when the line is already in OSM." },
    { key: "existing_min_similarity", label: "Minimum similarity with an existing relation", type: "number", unit: "0 to 1", value: 0.4, min: 0, max: 1, step: 0.05, help: "Below this, a variant is not paired with an existing relation." },
    { key: "reuse_traces", label: "Keep good traces", type: "boolean", value: true, help: "A relation of the line that can be travelled from end to end and serves the stops in order keeps its ways. Off: every trace is computed again." },
    { key: "stop_position_own", label: "A stop_position closer to the opposite stop is not reused", type: "boolean", value: true, help: "Checked for every stop, even on a good trace or a relation with nothing else to do: compared along the road, a stop_position closer to the stop across the road is left to it, and this stop gets its own. Stops facing each other, within 2 m along the road, still share one. Off: only what is clearly the stop_position of the other stop is left to it." },
    { key: "split_roundabouts", label: "Split roundabouts", type: "boolean", value: true, help: "Off: relations contain the whole roundabout way." },
  ] },
  { group: "Distances", items: [
    { key: "thresholds.platform_m", label: "Stop -> platform", type: "number", unit: "m", value: 30, min: 0, help: "Existing OSM platform taken on either side of the road." },
    { key: "thresholds.platform_far_m", label: "Stop -> platform, extended reach", type: "number", unit: "m", value: 60, min: 0, help: "For rough GTFS coordinates: only on the kerb side, next to the travelled way, with no other stop clearly closer." },
    { key: "thresholds.platform_same_name_m", label: "Extended reach, same name", type: "number", unit: "m", value: 100, min: 0, help: "Same, when the platform has the name of the stop." },
    { key: "thresholds.platform_road_m", label: "Far platform -> travelled way", type: "number", unit: "m", value: 25, min: 0, help: "A platform found with the extended reach must be this close to the way." },
    { key: "thresholds.side_way_m", label: "Side judged on a neighbouring way", type: "number", unit: "m", value: 5, min: 0, help: "The way of the stop is used, unless a neighbouring way is closer to the platform by more than this." },
    { key: "thresholds.holder_m", label: "Stop -> platform with its stop_id", type: "number", unit: "m", value: 100, min: 0, help: "Reach for an OSM platform already carrying the stop_id." },
    { key: "thresholds.stop_position_m", label: "Stop -> travelled way", type: "number", unit: "m", value: 40, min: 0, help: "Further away, the stop_position is reported as far." },
    { key: "thresholds.stop_position_reuse_m", label: "Existing stop_position, reuse", type: "number", unit: "m", value: 30, min: 0, help: "Projection of the stop -> existing stop_position that may be reused." },
    { key: "thresholds.terminus_m", label: "First and last stop: search for a stop_position", type: "number", unit: "m", value: 80, min: 0, help: "Reach at the ends of a line, independent of the others: an existing stop_position is looked for this far, also on the road just beyond the trace, rather than creating a duplicate. Beyond the usual reuse reach, it must have the name of the stop or none, and be closer to this stop than to the next one." },
    { key: "thresholds.stop_position_shared_m", label: "Existing stop_position, always shared", type: "number", unit: "m", value: 10, min: 0, help: "This close, it is reused even if closer to the stop across the road." },
    { key: "thresholds.duplicate_stop_m", label: "Duplicate stops", type: "number", unit: "m", value: 5, min: 0, help: "Two GTFS stops this close are the same physical platform (aggregated feeds)." },
    { key: "thresholds.opposite_stop_m", label: "Opposite stop", type: "number", unit: "m", value: 30, min: 0, help: "For stops without sibling information." },
    { key: "thresholds.sibling_m", label: "Other platform of the same stop", type: "number", unit: "m", value: 100, min: 0, help: "parent_station, or codes 12A / 12B." },
    { key: "thresholds.trace_m", label: "Longest trace sent to Valhalla", type: "number", unit: "m", value: 150000, min: 1000, help: "Valhalla rejects traces over 200 km: longer shapes are matched in chunks." },
    { key: "thresholds.trace_points", label: "Most points per trace", type: "number", unit: "points", value: 10000, min: 2, help: "Same, for the number of shape points." },
    { key: "thresholds.max_far_stops", label: "Share of far stops tolerated", type: "number", unit: "0 to 1", value: 0.2, min: 0, max: 1, step: 0.05, help: "Beyond this, the GTFS shape is considered wrong and the variant is routed through its stops." },
  ] },
  { group: "PTNA list", items: [
    { key: "ptna", label: "PTNA options", type: "json", value: {}, help: 'Optional: "id_prefix", "categories", "sections", "pages", and "text" to translate the wiki texts (see ptna.js).' },
  ] },
];

export const ITEMS = SCHEMA.flatMap((g) => g.items);

const clone = (v) => (typeof v === "object" ? structuredClone(v) : v);
const parts = (key) => {
  const [a, b] = key.split(".");
  return b ? [a, b] : [null, a];
};

export const settings = Object.fromEntries(SECTIONS.map((section) => [section, {}]));

function setValue(key, value) {
  const [section, name] = parts(key);
  (section ? settings[section] : settings)[name] = value;
}

/** Back to the defaults, then apply overrides {"feed": "X", "thresholds": {"platform_m": 12}} or {"thresholds.platform_m": 12}.
 * An unknown key is an error: no silent typo. */
export function configure(overrides = {}) {
  for (const item of ITEMS) setValue(item.key, clone(item.value));
  const known = new Set(ITEMS.map((i) => i.key));
  const apply = (key, value) => {
    if (!known.has(key)) throw new Error(`Unknown setting: "${key}"`);
    setValue(key, value);
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (SECTIONS.includes(key)) for (const [k, v] of Object.entries(value)) apply(`${key}.${k}`, v);
    else apply(key, value);
  }
  return settings;
}

/** Suffix of the gtfs:* tags in force: "" as long as "auto" has not been resolved. */
export const activeFeed = () => (settings.feed === AUTO ? "" : settings.feed);

configure();
