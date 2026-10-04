"""TissWay: OpenStreetMap public transport relations (PTv2) from any GTFS feed, to review in JOSM.

Modules, in processing order (see pipeline.run):
- config         settings and TOML profiles
- gtfs           GTFS reading and normalisation, variants of each route
- stops          GTFS stops <-> candidate OSM platforms, opposite and rival stops
- matching       map-matching of the variants with Valhalla (shape, or routing through the stops)
- osm            reading of the extract (osmium), modified objects (ChainMap), .osm output
- platforms      stop_position and platform of each stop, kerb side, GTFS tags of the platforms
- build          route / route_master relations of a line
- existing       existing OSM relations of a line, updated in place
- splitting      ways split where routes enter or leave them (streets, roundabouts, termini)
- naming         network of an agency, stop labels, relation names
- geo            local geometry (distances, kerb side)
- pipeline       full run
Tools: platform_tags (platforms of a network), via (add-via), ptna (PTNA lists), extracts (OSM
extracts), valhalla (local server), cli (command line).
"""

__version__ = "1.0.0"
