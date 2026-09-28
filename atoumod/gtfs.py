"""Lecture du GTFS et choix des variantes (séquences d'arrêts) à cartographier pour chaque ligne."""

from collections import Counter

import pandas as pd

from .config import GTFS_DIR, MIN_VARIANT_SHARE


def read_gtfs(*names):
    """Fichiers GTFS (sans extension) lus en DataFrames de chaînes."""
    return tuple(pd.read_csv(f"{GTFS_DIR}/{name}.txt", encoding="utf-8-sig", dtype=str) for name in names)


def ref_sort_key(ref):
    """Tri des numéros de ligne : numérique si possible ("2" < "10"), sinon alphabétique après."""
    return (0, int(ref)) if ref.isdigit() else (1, ref)


def line_variants(trips):
    """Par direction : séquences d'arrêts non incluses dans une autre et assez fréquentes."""
    for direction_id, dir_trips in trips.groupby(trips["direction_id"].fillna("0")):
        counts = Counter(dir_trips["stop_seq"])
        full = [(seq, n) for seq, n in counts.most_common()
                if not any(len(o) > len(seq) and set(seq) <= set(o) for o in counts)]
        for seq, _ in [(s, n) for s, n in full if n / len(dir_trips) >= MIN_VARIANT_SHARE] or full[:1]:
            seq_trips = dir_trips[dir_trips["stop_seq"] == seq]
            shape_id = seq_trips["shape_id"].mode()[0]
            yield direction_id, seq, shape_id, seq_trips[seq_trips["shape_id"] == shape_id]["trip_id"].iloc[0]
