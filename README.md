# tissway web

Turns a GTFS feed into OpenStreetMap public transport relations (PTv2), in the browser: pick a feed, a network and some
lines, download a `.osm` file, review it in JOSM, upload it.

**No server, no dependency, no build step.** The JavaScript you read here is exactly what runs in the browser, so the
browser's debugger works directly on it. Host this folder anywhere static (GitHub Pages, Netlify, an S3 bucket…).

```bash
npm start     # http://localhost:8000 (modules cannot load from file://; any static server works)
npm test      # node --test, no install needed. Node >= 20.
```

## What it does

| Convert to | Result |
|---|---|
| Route relations | `.osm` of one line, the only unit of conversion: a `route` per variant, a `route_master`, stop_positions, platforms and split ways. Lines already in OSM are updated in place. |
| Platforms | `.osm` completing the existing platforms of a network with its GTFS stops, and a CSV of the stops without a platform. |
| PTNA list | The PTNA wiki page of a network, generated or updated from the current page. |
| (drop an `.osm` file instead of a feed) | Adds "via …" to relations sharing a name in that file. |

Nothing is ever uploaded to OSM: the file goes through a human, in JOSM.

## No local data

The site ships no list of networks, feeds or words. What it needs is asked online during a run, and shown under "Found online
for this run":

| Information | Where it comes from |
|---|---|
| `network` | The OSM relations carrying the GTFS `route_id`, else those with the ref of a line whose network starts the agency's name ("Nomad" for "Nomad Car"). Else the agency's name. |
| `network:wikidata`, `network:wikipedia` | The OSM relations of that network when at least 3 agree. Else Wikidata, only for an exact label that is confirmed by the agency's website, or that is a public transport system of the right country, and only when a single entry remains. Reported as a warning, to check. |
| Suffix of the `gtfs:*` tags | The code OSM relations already use with the route_ids of this feed, around the lines, else over the feed's area. If none is found it stays empty, with a warning: PTNA then needs it from the wiki's List of GTFS feeds. |
| Tags holding the stop_id (`ref:FR:Atoumod`) | `ref:*` tags of nearby platforms whose values are mostly GTFS stop_ids. |
| Platform `ref` from a NeTEx stop_id | On when at least 3 nearby platforms already follow this. |
| Driving side | Country of the stops (Nominatim), then its driving side (Wikidata). |
| Town of the termini, for the titles, or of every stop when renaming them | Nominatim, in the language of the feed. |
| Accents | The spelling of OSM platforms of the same name, else Wiktionary (see limits below). |

Any of this can be overridden on the Settings page. A service that fails is reported in the log and the run goes on without it.

## Tags, the OSM wiki and PTNA

The tags follow [Public transport](https://wiki.openstreetmap.org/wiki/Public_transport) and what
[PTNA](https://ptna.openstreetmap.de) checks. `ptnaProblems` in `test/helpers.js` reproduces its checks of names, `from`, `to`, `via`
and GTFS keys, and `test/pipeline.test.js` runs them on generated relations.

- **route**: `name` = `Bus 12: VILLE Arret → VILLE Arret`, `Bus 12: VILLE Arret → X → Y → VILLE Arret` for variants sharing their termini, `ref`, `from`, `to`,
  `network`, `public_transport:version=2`, `colour`, `duration` (median of the trips, from the GTFS). `via=X;Y` when variants share their
  termini, `roundtrip=yes` when the first and last platform are the same.
- **route_master**: `name` = `Bus 12: VILLE Arret ↔ VILLE Arret`, the two termini most trips use, and the tags common to its routes.
- **several values**: `gtfs:route_id`, `gtfs:shape_id` and `gtfs:trip_id:sample` hold every id that applies, separated by `;`: the shapes of a variant
  with one sample trip each, the route_ids a route_master already holds that are still in the feed. Within OSM's 255 characters.
- **GTFS keys**: all with the feed code as a suffix, the mix being an error for PTNA. Keys left without it on an updated relation are removed.
- **platform**: `public_transport=platform`, `highway=bus_stop` (`highway=platform` on a way, `bus_stop` being for nodes only), `bus=yes`.
  An existing `route_ref` gets the line, none is created from a partial selection.
- **one physical stop, several networks**: one platform, where each network has its own ids. `gtfs:stop_id:<feed>=a;b` lists one stop per network, never
  `gtfs:stop_id:2`. A second stop of the same network is the one across the road: the one on the good side stays, the other is removed.
- **network-specific metadata**: `network:wikidata`, `network:wikipedia` and `gtfs:stop_code:<feed>` use the network name for a secondary value
  (`network:wikidata:Nomad`, `gtfs:stop_code:<feed>:Nomad`), not a numbered suffix.
- **shared stops**: `ref` and the tags holding a stop_id belong to the network owning the stop, the first one (`network=Twisto`, `ref=hipp02`).
  The others use their name, never a number: `ref:Nomad=14CAE21B`, `ref:FR:Atoumod:Nomad=…`. Numbered refs found on a stop are renamed.
  A ref is one value for one physical stop: never `a;b`, one per network on a platform, and on one platform only. Two stops face to face on a
  single OSM platform leave it to the nearest; the other one is reported, a platform is missing on its side. A code already on another platform
  is not copied, and is reported too.
  The owner is the network in place; a network with fewer stops in the feed (local rather than regional) takes over, unless the
  "Networks owning their stops" setting names them.
- **stop_position**: `public_transport=stop_position`, `bus=yes`, on the way.
- **PTNA list**: `operator` stays empty unless you give one, since PTNA compares it with the OSM relations.

**Left out on purpose:** `operator` is only taken from relations already in OSM (a GTFS agency is often not the real operator);
`interval` and `opening_hours` need a calendar reading that could be wrong; `gtfs:release_date` is not given reliably by feeds.

**Stop names**, two choices on the converter: the official name of the GTFS, or `TOWN - Stop`, written on platforms, stop_positions, `from` and `to`.
A town already in a stop name is recognised at its start, at its end or in brackets, with or without accents, whole or in part ("Norrey Calvaire"),
so it is never written twice. The title of a line is `VILLE Arret` either way.

**What PTNA says of these titles.** They follow its relaxed comparison (`check-name-relaxed`) when `from`, `via` and `to` are found in the title. It
gives notes, which are not errors, on: its strict `check-name`, which only reads `=>`; a stop name that the title rewrites ("Avranches - Gare" as
"AVRANCHES Gare").

**Traces already in OSM** are kept when they are good ("Keep good traces" in Settings): a relation of the line keeps its ways if they join up, none is
travelled against its oneway, and they serve the stops of the variant in order, from the first to the last. Otherwise the variant is matched with Valhalla
(tick Network calls in the log for the reason). The stops of the relation always come from the GTFS.

## Online services

Everything is called from the browser, so these must allow cross-origin requests. All of them do today.

| Service | Used for | Key |
|---|---|---|
| [Mobility Database](https://mobilitydatabase.org) | The GTFS archive. `files.mobilitydatabase.org/<id>/latest.zip` is public; with a token, the API also gives the feed's name and its producer URL as a fallback. | Optional |
| [Valhalla](https://github.com/valhalla/valhalla), `valhalla1.openstreetmap.de` by default | Map-matching, one request per second at most. | Optional (`?api_key=`) |
| [Overpass](https://wiki.openstreetmap.org/wiki/Overpass_API), `overpass-api.de` by default | The ways, platforms and relations of OSM, with their versions. | None |
| [Nominatim](https://nominatim.org) | Towns and countries, one request per second at most. | None |
| [Wikidata](https://www.wikidata.org) | Driving sides, network entries, Wikipedia pages. | None |
| [Wiktionary](https://www.wiktionary.org) | Spelling, in the language of the feed. | None |

Keys stay in the browser's `localStorage` and are only sent to their own service. They are never written to the log, nor to the
settings export. Answers about towns and words are kept in the browser, as the services' policies require; "Clear cached data" on
the Settings page removes them, along with the downloaded feeds.

These public servers are shared and free. A busy Overpass answers in tens of seconds or with 502 errors: requests are retried
automatically, and one line can take a few minutes. Lines are converted one at a time, to review each one and spare these servers. A PTNA list of a
large network asks Nominatim for each terminus, a few minutes the first time.

## Finding your way in the code

```text
GTFS ──► variants ──► map-matching ──► stops on the ground ──► relations ──► split ways ──► .osm
gtfs.js              matching.js       stops.js, platforms.js  build.js      splitting.js   osm.js
                                                               existing.js
```

| File | Role |
|---|---|
| `app.js`, `index.html`, `style.css` | The page. No GTFS or OSM logic here. |
| `src/pipeline.js` | The steps of a run, in order. **Start here.** |
| `src/net.js` | Every network call: throttling, retries, journal. |
| `src/zip.js`, `src/gtfs.js` | Streaming ZIP and CSV reading, variants. |
| `src/reuse.js` | Is the trace already in OSM good? Then it is kept. |
| `src/matching.js` | Valhalla: shape, or route through the stops when the shape is wrong. |
| `src/stops.js`, `src/platforms.js` | Candidate platforms, kerb side, stop_position placement. The rules are listed at the top of `platforms.js`. |
| `src/build.js`, `src/existing.js` | Relations of a line; pairing with the existing ones. |
| `src/splitting.js` | Ways split where routes enter or leave them. |
| `src/osm.js` | `Store` (what was read / what changed), Overpass queries, `.osm` reading and writing. |
| `src/settings.js` | Every setting, its default and its description. The Settings page is generated from this list. |
| `src/detect.js` | What is read from OSM about a feed: tag suffix, stop_id tags, network. |
| `src/lookup.js` | Nominatim, Wikidata and Wiktionary, and the checks made before believing them. |
| `settings_form.js` | The Settings page. |
| `src/platform_tags.js`, `src/ptna.js`, `src/via.js` | The other outputs. |

## Debugging

1. Open the **Activity log** under the converter and tick **Network calls**: one line per call with its status and duration. **Copy** gives you the log to paste in a
   bug report.
2. In the browser console, `tissway.last` holds everything computed by the last run. For example:

   ```js
   tissway.last.lines                     // [[route, variants]]: variants with their ways and source
   tissway.last.stops.platforms.get(id)   // candidate platforms of a stop_id
   tissway.last.obj.get("w123")           // an object as it will be written
   [...tissway.last.obj.modified.keys()]  // everything in the output file
   tissway.settings                       // the settings in force, "auto" values resolved
   ```

3. Put a breakpoint anywhere in `src/`: there is no bundling and no minification.
4. To reproduce a bug without a browser, every module of `src/` also runs in Node. `test/pipeline.test.js` is a whole run on a small
   invented network with the services mocked: copy it and describe your case.

The warnings are worth reading. They are not always bugs: "gap" means that Valhalla returned two consecutive ways with no common
node (an imprecise GTFS shape, or OSM edited since its tiles were built), to fix in JOSM.

## Settings

The **Settings** page lists every value of `src/settings.js`, with its description and its default. Only what you change is kept, in
this browser. **Export** gives a JSON file, without the API keys, that **Import** reads back, to share the settings of a feed:

```json
{
  "networks": { "<agency_id or agency_name>": { "network": "VBN", "network:wikidata": "Q..." } },
  "thresholds.platform_m": 25
}
```

An unknown key is an error. To add a setting, add it to the list in `src/settings.js`: the page follows.

## Known limits

- Accents: a word with a Wiktionary page of its own is left alone, since it cannot be told from its accented form ("marche" /
  "marché"), and Wiktionary also has pages for words of other languages and for proper names. So "Ecole" or "Eglise" stay as they are
  unless a nearby OSM platform spells them. What comes from Wiktionary is reported as a warning, to check.
- A network only found under another name in OSM, with none of the lines mapped yet, keeps the agency's name: use the network overrides.
- PTNA lists run without OSM, so with the tag suffix set by hand and the agency's name as network. Their wiki texts are in English
  unless the PTNA options say otherwise.
- Stops, platforms and relations are read around the selected lines: a platform carrying the stop_id further than 300 m from every stop
  of the selection is not seen.
- A way changed in OSM after the Valhalla tiles were built can leave a gap, reported in the log.
- ZIP64 archives (over 4 GB) are not read.
- A GTFS hosted without CORS headers cannot be downloaded by the page: download it yourself and choose the file.

## Look

Light and dark themes, chosen in the header, else following the system (`theme.js`). The colours are the variables at the top of
`style.css`; the logo takes `--logo`, `tissway.svg` only giving its shape. All the text is in D-DIN, from `d-din/`.

## Contributing

Keep it boring: plain ES modules, no dependency, no build, no data files. One behaviour, one test in `test/` (`node --test`). Modules
take their settings from `settings.js`, reach the network through `net.js` and report through `log`, so that they stay testable.
