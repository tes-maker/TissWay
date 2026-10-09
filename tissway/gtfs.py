"""GTFS reading and normalisation, and choice of the variants (stop sequences) to map for each route.

Any feed that follows the GTFS reference is accepted, from a directory or a .zip (files may sit in a
sub-folder of the archive). Every table is read as strings with missing values as "" (never NaN), and the
optional files and columns the rest of the code relies on are added with their GTFS default, so that no
other module has to care about what a given producer leaves out:

- agency.txt may be missing (single unnamed agency), routes.agency_id may be empty (single-agency feed);
- shapes.txt, trips.shape_id and trips.direction_id may be missing (variants are then routed through their
  stops, see matching.match_variant);
- stop_code, platform_code, parent_station, location_type, wheelchair_boarding may be missing;
- stops without a name inherit their parent station's name; only boarding locations (location_type 0) with
  coordinates are kept as stops.
"""

from __future__ import annotations

import io
import zipfile
from collections import Counter
from functools import cached_property
from pathlib import Path

import pandas as pd

from .config import settings

OPTIONAL_COLUMNS = {
    "agency": ["agency_id", "agency_name"],
    "routes": ["agency_id", "route_short_name", "route_long_name", "route_type", "route_color", "route_text_color"],
    "trips": ["direction_id", "shape_id"],
    "stops": ["stop_code", "stop_name", "location_type", "parent_station", "wheelchair_boarding", "platform_code"],
    "stop_times": [],
    "shapes": [],
}


CHUNK_ROWS = 200_000  # rows read at a time from a table filtered while it is read (Feed.read keep=)


class GTFSError(Exception):
    """The feed is missing or lacks a required file or column."""


def osm_route(route_type):
    """OSM route=* value of a GTFS route_type (basic or extended types), None if unknown."""
    try:
        t = int(route_type)
    except (TypeError, ValueError):
        return None
    basic = {0: "tram", 1: "subway", 2: "train", 3: "bus", 4: "ferry", 5: "tram", 6: "aerialway",
             7: "funicular", 11: "trolleybus", 12: "monorail"}
    if t in basic:
        return basic[t]
    ranges = [(100, 199, "train"), (200, 299, "coach"), (400, 499, "subway"), (700, 799, "bus"),
              (800, 899, "trolleybus"), (900, 999, "tram"), (1000, 1099, "ferry"), (1200, 1299, "ferry"),
              (1300, 1399, "aerialway"), (1400, 1499, "funicular")]
    return next((mode for lo, hi, mode in ranges if lo <= t <= hi), None)


class Feed:
    """A GTFS feed (directory or zip). Tables are read on first access and cached."""

    def __init__(self, source=None):
        self.source = Path(source or settings.gtfs)
        if not self.source.exists():
            raise GTFSError(f"GTFS feed not found: {self.source}")
        self._zip = zipfile.ZipFile(self.source) if zipfile.is_zipfile(self.source) else None

    def _locate(self, name):
        if self._zip:
            return next((n for n in self._zip.namelist() if Path(n).name == f"{name}.txt"), None)
        path = self.source / f"{name}.txt"
        return path if path.is_file() else None

    def has(self, name):
        return self._locate(name) is not None

    def read(self, name, columns=None, dtype=str, keep=None):
        """Table name as a DataFrame of strings ("" for missing values), restricted to columns if given;
        missing optional columns are added empty. dtype: column types (default: all strings). keep: function
        of a DataFrame returning the mask of the rows to keep; the file is then read in chunks, so that only
        the kept rows are ever held in memory (large shapes.txt)."""
        where = self._locate(name)
        if where is None:
            raise GTFSError(f"{name}.txt is missing from {self.source}")
        wanted = None if columns is None else set(columns)
        handle = io.TextIOWrapper(self._zip.open(where), encoding="utf-8-sig") if self._zip else where
        reader = pd.read_csv(handle, dtype=dtype, keep_default_na=False, na_filter=False, skipinitialspace=True,
                             encoding="utf-8-sig", usecols=None if wanted is None else (lambda c: c.strip() in wanted),
                             chunksize=None if keep is None else CHUNK_ROWS)
        if keep is None:
            df = reader
            df.columns = df.columns.str.strip()
        else:
            with reader:
                chunks = [c[keep(c)] for c in (c.rename(columns=str.strip) for c in reader)]
            df = pd.concat(chunks, ignore_index=True)
        for col in OPTIONAL_COLUMNS.get(name, []) + list(wanted or []):
            if col not in df:
                df[col] = ""
        return df

    @cached_property
    def agency(self):
        if not self.has("agency"):
            return pd.DataFrame({"agency_id": [""], "agency_name": [""]})
        return self.read("agency")

    @cached_property
    def routes(self):
        routes = self.read("routes")
        if len(self.agency) == 1:  # agency_id is optional in single-agency feeds
            routes["agency_id"] = routes["agency_id"].replace("", self.agency["agency_id"].iloc[0])
        routes["mode"] = routes["route_type"].map(osm_route)
        return routes

    @cached_property
    def trips(self):
        trips = self.read("trips")
        if not self.has("shapes"):
            trips["shape_id"] = ""
        return trips

    @cached_property
    def stops(self):
        """Boarding stops (location_type 0) with coordinates, with float lat / lon columns."""
        stops = self.read("stops")
        parent_name = stops.set_index("stop_id")["stop_name"]
        unnamed = stops["stop_name"] == ""
        stops.loc[unnamed, "stop_name"] = stops.loc[unnamed, "parent_station"].map(parent_name).fillna("")
        stops = stops[stops["location_type"].isin(["", "0"]) & (stops["stop_lat"] != "") & (stops["stop_lon"] != "")]
        stops = stops.copy()
        stops["lat"], stops["lon"] = stops["stop_lat"].astype(float), stops["stop_lon"].astype(float)
        return stops.reset_index(drop=True)

    @cached_property
    def _stop_times(self):
        """Every stop time, kept in memory with compact types: the ids as categories (a few distinct values
        repeated millions of times), stop_sequence as int32. A tenth of the memory of plain strings."""
        st = self.read("stop_times", ["trip_id", "stop_id", "stop_sequence"],
                       dtype={"trip_id": "category", "stop_id": "category", "stop_sequence": "int32"})
        return st[st["stop_id"] != ""]  # flexible trips (location_id) have no stop

    def stop_times(self, trip_ids=None):
        """stop_times (trip_id, stop_id as strings, stop_sequence as int) of trip_ids, or of every trip."""
        st = self._stop_times
        if trip_ids is not None:
            st = st[st["trip_id"].isin(set(trip_ids))]
        return st.astype({"trip_id": str, "stop_id": str, "stop_sequence": int})

    def shapes(self, shape_ids):
        """shape_id -> [(lat, lon)] in sequence order, for the shape_ids found in shapes.txt."""
        if not self.has("shapes"):
            return {}
        shape_ids = set(shape_ids)
        if not shape_ids:
            return {}
        df = self.read("shapes", ["shape_id", "shape_pt_lat", "shape_pt_lon", "shape_pt_sequence"],
                       keep=lambda c: c["shape_id"].isin(shape_ids))
        df["shape_pt_sequence"] = df["shape_pt_sequence"].astype(int)
        df = df.sort_values(["shape_id", "shape_pt_sequence"])
        return {sid: list(zip(g["shape_pt_lat"].astype(float), g["shape_pt_lon"].astype(float)))
                for sid, g in df.groupby("shape_id")}

    def stop_agencies(self):
        """stop_id -> agency_ids of the routes serving it."""
        trip_agency = self.trips.set_index("trip_id")["route_id"].map(self.routes.set_index("route_id")["agency_id"])
        st = self._stop_times[["trip_id", "stop_id"]]
        st = st.assign(agency=st["trip_id"].map(trip_agency)).dropna(subset=["agency"])
        st = st.drop_duplicates(["stop_id", "agency"])
        return st.groupby("stop_id", observed=True)["agency"].agg(frozenset).to_dict()


def stop_sequences(trips, stop_times):
    """trips with a stop_seq column: tuple of the stop_ids of each trip, in order. Trips without stop times
    are dropped."""
    seqs = stop_times.sort_values("stop_sequence").groupby("trip_id")["stop_id"].agg(tuple)
    trips = trips.assign(stop_seq=trips["trip_id"].map(seqs))
    return trips[trips["stop_seq"].notna()]


def ref_sort_key(ref):
    """Sort key of route numbers: numeric when possible ("2" < "10"), then alphabetical."""
    return (0, int(ref), "") if ref.isdigit() else (1, 0, ref)


def is_sub_route(seq, other):
    """seq is a run of consecutive stops of the longer sequence other (PTNA's "part of the itinerary")."""
    return len(seq) < len(other) and any(other[i:i + len(seq)] == seq for i in range(len(other) - len(seq) + 1))


def line_variants(trips):
    """(direction_id, stop sequence, shape_id, sample trip_id) of each distinct stop sequence per direction
    (all services, short turns included), most frequent first, except those contained as such in a longer
    sequence of the same direction. shape_id is the most frequent one of the sequence ("" if none)."""
    for direction_id, dir_trips in trips.groupby(trips["direction_id"].replace("", "0")):
        counts = Counter(dir_trips["stop_seq"])
        for seq, _ in counts.most_common():
            if len(seq) < 2 or any(is_sub_route(seq, o) for o in counts):
                continue
            seq_trips = dir_trips[dir_trips["stop_seq"] == seq]
            shape_id = seq_trips["shape_id"].mode()[0]
            yield direction_id, seq, shape_id, seq_trips[seq_trips["shape_id"] == shape_id]["trip_id"].iloc[0]
