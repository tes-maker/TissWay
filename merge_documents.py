import shutil
import subprocess
import sys
from pathlib import Path

# --- CONFIGURATION ---
INPUT_PBFS = [
    "basse-normandie-260926.osm.pbf",
    "haute-normandie-260926.osm.pbf",
]
OUTPUT_PBF = "normandy-latest.osm.pbf"


def merge_pbfs(inputs, output):
    """Fusionne plusieurs fichiers PBF avec osmium (les objets en double sur la frontière sont dédoublonnés)."""
    if shutil.which("osmium") is None:
        sys.exit("Erreur : osmium-tool est introuvable (sudo apt install osmium-tool).")

    for path in inputs:
        if not Path(path).is_file():
            sys.exit(f"Erreur : fichier introuvable : {path}")

    print(f"Fusion de {', '.join(inputs)} -> {output}...")
    subprocess.run(
        ["osmium", "merge", *inputs, "-o", output, "--overwrite"],
        check=True,
    )
    size_mb = Path(output).stat().st_size / 1_000_000
    print(f"Terminé : {output} ({size_mb:.1f} Mo)")


if __name__ == "__main__":
    merge_pbfs(INPUT_PBFS, OUTPUT_PBF)
