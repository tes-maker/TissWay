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
| (bottom of Settings) Correct a whole network | `.osm` putting the stops and relation names already mapped for a network in the form of this site, without changing a trace. |

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
| Town of every stop, for `official_name` and the titles | Nominatim, in the language of the feed. In France, always the commune: the commune nouvelle, never the commune déléguée in it nor the arrondissement. |
| Accents | The spelling of OSM platforms of the same name, else Wiktionary (see limits below). |

Any of this can be overridden on the Settings page. A service that fails is reported in the log and the run goes on without it.

## Tags, the OSM wiki and PTNA

The tags follow [Public transport](https://wiki.openstreetmap.org/wiki/Public_transport) and what
[PTNA](https://ptna.openstreetmap.de) checks. `ptnaProblems` in `test/helpers.js` reproduces its checks of names, `from`, `to`, `via`
and GTFS keys, and `test/pipeline.test.js` runs them on generated relations.

- **route**: `name` = `Bus 12: VILLE Arret → VILLE Arret`, `Bus 12: VILLE Arret → VILLE Arret → VILLE Arret` for variants sharing their termini, `ref`, `from`, `to`,
  `network`, `public_transport:version=2`, `colour`, `duration` (median of the trips, from the GTFS). `via=X;Y` when variants share their
  termini, `roundtrip=yes` when the first and last platform are the same.
- **route_master**: `name` = `Bus 12: VILLE Arret ↔ VILLE Arret`, the two termini most trips use, and the tags common to its routes.
- **several values**: `gtfs:route_id`, `gtfs:shape_id` and `gtfs:trip_id:sample` hold every id that applies, separated by `;`: the shapes of a variant
  with one sample trip each, the route_ids a route_master already holds that are still in the feed. Within OSM's 255 characters.
- **GTFS keys**: all with the feed code as a suffix, the mix being an error for PTNA. Keys left without it on an updated relation are removed.
- **platform**: `public_transport=platform`, `highway=bus_stop` (`highway=platform` on a way, `bus_stop` being for nodes only). `bus=yes` for a bus or a coach (iD reports a `highway=bus_stop` without it as incomplete; an existing `bus=no` stays). An `alt_name` is removed from the stops of the file (new line, "Correct a whole network").
  An existing `route_ref` gets the line, none is created from a partial selection.
- **one physical stop, several networks**: exported platforms combine `network` and its Wikidata/Wikipedia values in network order, separated by `;`.
  `gtfs:stop_id` is the ID of the stop of the first network, the one of `ref` and `ref:FR:Atoumod` without suffix, taken from them if needed. The IDs of the other
  networks are found in their `ref:*:<network>` tags (`ref:FR:Atoumod:Nomad`). IDs of other feeds stay. A platform read as `network=Twisto;Nomad Car` is two networks, and
  a ref under a shorter name (`ref:Nomad` for `Nomad Car`) stays under that name. A second stop of the same network is the one across the
  road: the one on the good side stays, the other is removed.
- **network-specific metadata**: `gtfs:stop_code:<feed>` is only exported for a code of the first network that no ref holds. On no exported object is there a code of another
  network or a repeated ref: no `gtfs:stop_code:<feed>:Nomad`, and no `gtfs:stop_code:<feed>` repeating `ref` or `ref:Nomad`. References keep their network-specific keys (`ref:Nomad`, `ref:FR:Atoumod:Nomad`).
- **wrong codes in the GTFS**: with "Take the stop refs from the GTFS" off, no `ref` nor `gtfs:stop_code` is written from `stop_code` or a NeTEx stop_id. Platforms keep their `ref`, new ones have none, and no `ref` is moved or proposed for removal because of these codes. The stop_id tags are still set.
- **shared stops**: `ref` and the tags holding a stop_id belong to the network owning the stop, the first one (`network=Twisto`, `ref=hipp02`).
  The others use their name, never a number: `ref:Nomad=14CAE21B`, `ref:FR:Atoumod:Nomad=…`. Numbered refs found on a stop are renamed.
  A ref is one value for one physical stop: never `a;b`, one per network on a platform, and on one platform only. Two stops face to face on a
  single OSM platform leave it to the nearest; the other one is reported, a platform is missing on its side. A code already on another platform
  is not copied, and is reported too.
  The owner is the network in place; a network with fewer stops in the feed (local rather than regional) takes over, unless the
  "Networks owning their stops" setting names them.
- **very close network names**: when the names of two networks of the file are the same or one starts or ends the other (`Nomad` and `Nomad Car`), the
  window before the download asks if they are one network. Yes: platforms and relations go under the shortest name, with the refs and metadata of the other
  in its place; two different refs are left as they are and reported. Nothing is merged without this answer, which is kept in the "Merged network names" setting.
- **stop_position**: `public_transport=stop_position`, `bus=yes`, on the way.
- **PTNA list**: `operator` stays empty unless you give one, since PTNA compares it with the OSM relations.
- **operator**: never taken from the GTFS (its agency is often not the real operator). The "Operator of the line" setting puts it on the relations of the line converted and on its platforms, not on
  stop_positions, and replaces what the network of the line had, as listed in the window before the download. On a shared stop, operators follow the ref priorities: `network=Twisto;Nomad`,
  `operator=RATP Dev Caen la mer;Keolis`. An operator already mapped belongs to the network owning the stop, and moves with it when the order changes. Without the setting, a line shares the operator its mapped relations agree on.

**Left out on purpose:** `interval` and `opening_hours` need a calendar reading that could be wrong; `gtfs:release_date` is not given reliably by feeds.

**Stop names.** The punctuation of a name is written one way, whatever the source: `A - B` (from `A -B`, `A– B`, `A : B`), `A, B`, `A (B)`, `L'Église`, with `Saint-Malo`, `12:30` and `1,5` left alone. Platforms get `name=Charlotte Corday` and `official_name=MONDEVILLE - Charlotte Corday`; stop_positions, `from` and `to` get the same `name`.
A town already in the name, from the GTFS or from OSM, is recognised at its start, at its end or in brackets, with or without accents, whole or in part ("Fleury Mairie"),
and taken out. Capitals naming another place near the stop ("CAEN Chemin Vert") are taken out too, once Nominatim confirms the place. A name needing its town ("Hauts de Mondeville")
stays whole, without `official_name`. The title of a line is `VILLE Arret`.

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
| [Découpage administratif](https://geo.api.gouv.fr/decoupage-administratif), France only | Are capitals at the start of a stop name a commune déléguée of its commune nouvelle? | None |
| [Wikidata](https://www.wikidata.org) | Driving sides, network entries, Wikipedia pages. | None |
| [Wiktionary](https://www.wiktionary.org) | Spelling, in the language of the feed. | None |

Keys stay in the browser's `localStorage` and are only sent to their own service. They are never written to the log, nor to the
settings export. Answers about towns and words are kept in the browser, as the services' policies require; "Clear cached data" on
the Settings page removes them, along with the downloaded feeds.

These public servers are shared and free. A busy Overpass answers in tens of seconds or with 502 errors: requests are retried
automatically, and one line can take a few minutes. Lines are converted one at a time, to review each one and spare these servers. A PTNA list of a
large network asks Nominatim for each terminus, a few minutes the first time.

## Finding your way in the code

### A conversion, step by step

`runRoutes` in `src/pipeline.js` runs these steps in order. **Start there.**

```text
GTFS ──► OSM stops ──► names ──► traces ──► ways ──► relations ──► split ways ──► .osm
```

| Step | What happens | Where |
|---|---|---|
| Read the feed | The lines of the selection and their variants: the distinct stop sequences. | `gtfs.js`, `zip.js` |
| OSM stops | Platforms read around the stops, candidates of each GTFS stop, conventions of the feed. | `stops.js`, `detect.js` |
| Names | Punctuation, accents, then `name`, `official_name` and the labels of the titles. | `naming.js`, `lookup.js` |
| Existing relations | Relations of the area, network tags, feed code. | `existing.js`, `detect.js` |
| Traces | A complete relation stays as it is, a good trace is kept, otherwise Valhalla matches the variant. | `reuse.js`, `matching.js` |
| Ways | The travelled ways, and the road just beyond a terminus holding its stop_position. | `osm.js`, `reuse.js` |
| Relations | stop_position and platform of each stop, trace cut down to the termini, `route` and `route_master`, new or updated. | `build.js`, `platforms.js`, `existing.js` |
| Platform tags | GTFS and network tags, one ref per network. | `platforms.js` |
| Split ways | Cut where routes enter or leave them, once for all the lines. | `splitting.js` |
| Review and file | The window on refs and networks, then the `.osm` text. | `ref_review.js`, `osm.js` |

### Every file

| File | Role |
|---|---|
| `app.js`, `index.html`, `style.css`, `theme.js` | The page. No GTFS or OSM logic here. |
| `settings_form.js` | The Settings page, generated from `src/settings.js`. |
| `serve.js` | Development server. |
| `src/pipeline.js` | The steps of a run, in order. |
| `src/gtfs.js`, `src/zip.js` | Streaming ZIP and CSV reading, variants. |
| `src/stops.js` | GTFS stops, their candidate platforms, their neighbours and rivals. |
| `src/naming.js` | Stop names, networks, titles of the relations. |
| `src/reuse.js` | Is the trace or the whole relation in OSM good? Then it is kept. The road beyond a terminus. |
| `src/matching.js` | Valhalla: shape, or route through the stops when the shape is wrong. |
| `src/platforms.js` | Kerb side, stop_position placement, tags of the platforms. The rules are listed at the top of the file. |
| `src/build.js` | The relations of a line. |
| `src/existing.js` | Pairing with the relations already in OSM, what is kept of their tags. |
| `src/splitting.js` | Ways split where routes enter or leave them. |
| `src/ref_review.js` | Refs and networks of shared platforms, the window before the download. |
| `src/osm.js` | `Store` (what was read / what changed), Overpass queries, `.osm` reading and writing, GTFS ids corrected on reading. |
| `src/detect.js` | What is read from OSM about a feed: tag suffix, stop_id tags, network. |
| `src/lookup.js` | Nominatim, Wikidata and Wiktionary, and the checks made before believing them. |
| `src/net.js` | Every network call: throttling, retries, journal. |
| `src/settings.js` | Every setting, its default and its description. |
| `src/geo.js`, `src/util.js` | Local geometry; small helpers and the logger. |
| `src/platform_tags.js` | Output: the Platforms format. |
| `src/ptna.js` | Output: the PTNA list. |
| `src/via.js` | Output: "via" added to an `.osm` file. |
| `src/network_fix.js` | Output: the correction of a whole network. |

### Where to change what

| To change | Look at |
|---|---|
| How a stop or a relation is named | `cleanStopName`, `stopNames`, `stopLabel`, `tripTitle` in `naming.js` |
| When a trace or a relation is left alone | `traceProblem`, `completeRelation` in `reuse.js` |
| Which platform or stop_position a stop gets | `choosePlatform`, `locateStop` in `platforms.js` |
| The tags of a platform | `stopTags`, `enrich` in `platforms.js`; `outputPlatformTags` in `osm.js` for what a file holds |
| The tags of a relation | `routeTags` and `build` in `build.js`; `mergeTags` in `existing.js` for what stays of the old ones |
| What is cut, and where | `betweenTermini` in `build.js`, `cutNodes` in `splitting.js` |
| A distance or an option | `src/settings.js`: the page follows |

### Rules to keep

- **Nothing is uploaded.** Every output is a file that goes through a human, in JOSM.
- **What is right in OSM stays.** A complete relation keeps its trace, a good trace is not recomputed, and a tag of another network is not overwritten.
- **A doubt is reported, not guessed.** A case that cannot be settled stays as it is, with a line in the log.
- **Only what changes goes in the file**, through `Store`: read objects are in its base, changed ones in `modified`.
- **An online service may fail.** The run goes on without it, with a warning; only cancelling stops it.

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

- Communes nouvelles: a stop called only "Mairie" gets `THUE ET MUE - Mairie`, whichever former commune it is in, like its neighbours: nothing is added to the name of the stop.
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
