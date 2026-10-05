# Shortcuts for the TissWay commands (see README.md).
#
#   make                                    tests, then every route of every network
#   make NETWORK=nomad                      every Nomad route        -> output_osm/nomad.osm
#   make NETWORK=nomad ROUTES="301 305"     Nomad routes 301 and 305 -> output_osm/nomad_301_305.osm
#   make clean                              delete generated files (keeps extracts, GTFS, Valhalla tiles)
#
# "make help" lists the other targets. PROFILE selects another TOML profile (default: ./tissway.toml).
# "make install" creates a virtual environment in .venv/, which the other targets then use.

VENV ?= .venv
PYTHON3 ?= python3
PYTHON ?= $(if $(wildcard $(VENV)/bin/python),$(VENV)/bin/python,$(PYTHON3))
NETWORK ?=
ROUTES ?=
PROFILE ?=
FEED ?=

GTFS2OSM = $(PYTHON) -m tissway $(if $(PROFILE),--profile $(PROFILE))
ROUTE_ARGS = $(if $(NETWORK),-n $(NETWORK)) $(if $(ROUTES),-l $(ROUTES))

.DEFAULT_GOAL := all
.PHONY: all routes platforms ptna test lint valhalla extracts install clean distclean help

all: test routes ## tests, then route generation (NETWORK=, ROUTES= optional)

routes: ## route relations -> output_osm/ (refreshes the extract and starts Valhalla as needed)
	$(GTFS2OSM) routes $(ROUTE_ARGS)

platforms: ## complete the OSM platforms of NETWORK with its GTFS stops (FEED= tag suffix)
	$(GTFS2OSM) platforms -n $(NETWORK) $(if $(FEED),--feed $(FEED))

ptna: ## generate the PTNA list of NETWORK -> output_osm/ptna_<network>.txt
	$(GTFS2OSM) ptna -n $(NETWORK)

test: ## run the tests (no network access, no extract, < 1 s)
	$(PYTHON) -m pytest -q

lint: ## static checks (ruff)
	$(PYTHON) -m ruff check tissway tests

valhalla: ## start Valhalla (rebuilds its tiles if the extract changed)
	$(GTFS2OSM) valhalla

extracts: ## download and merge the OSM extracts of the profile
	$(GTFS2OSM) extracts

install: ## create the virtual environment .venv/ and install tissway and the development tools in it
	$(PYTHON3) -m venv $(VENV)
	$(VENV)/bin/python -m pip install --upgrade pip
	$(VENV)/bin/python -m pip install -e ".[dev]"

clean: ## delete generated files (output_osm/, Python and pytest caches)
	rm -rf output_osm/*.osm output_osm/*.csv
	rm -rf .pytest_cache .ruff_cache *.egg-info
	find . -name __pycache__ -type d -not -path './valhalla_data/*' -prune -exec rm -rf {} +

distclean: clean ## clean + OSM stops and routes caches
	rm -f osm_bus_stops.geojsonseq osm_routes.opl

help: ## list the targets
	@grep -E '^[a-z]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  make %-10s %s\n", $$1, $$2}'
