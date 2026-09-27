# NOMAD → OSM

Génère un fichier `.osm` (PTv2) par ligne de car Nomad (réseau Nomad, exploitant Keolis) à partir du GTFS,
à relire et envoyer depuis JOSM.

## Prérequis

```bash
sudo apt install osmium-tool docker.io
pip install geopandas pandas requests
```

## 1. Données

- **GTFS Nomad** : dézipper dans `gtfs_nomad/` (`stops.txt`, `routes.txt`, `trips.txt`, `stop_times.txt`, `shapes.txt`…).
- **Extrait OSM** : télécharger les deux ex-régions sur Geofabrik puis les fusionner en `normandy-latest.osm.pbf` :

```bash
wget -O basse-normandie-260925.osm.pbf https://download.geofabrik.de/europe/france/basse-normandie-latest.osm.pbf
wget -O haute-normandie-260925.osm.pbf https://download.geofabrik.de/europe/france/haute-normandie-latest.osm.pbf
python merge_documents.py
```

(Les noms des fichiers d'entrée sont définis dans `INPUT_PBFS`, en haut de `merge_documents.py`.)

## 2. Serveur Valhalla (map-matching)

Première fois : création du conteneur, qui construit les tuiles (long) :

```bash
cp normandy-latest.osm.pbf valhalla_data/
docker run -d --name valhalla_nomad -p 8002:8002 \
  -v "$PWD/valhalla_data:/custom_files" \
  -e serve_tiles=True -e build_admins=True -e server_threads=8 \
  ghcr.io/nilsnolde/docker-valhalla/valhalla:latest
docker logs -f valhalla_nomad   # attendre la fin de la construction des tuiles
```

Ensuite (après un redémarrage du PC par exemple) :

```bash
docker start valhalla_nomad
curl localhost:8002/status      # doit répondre
```

Pour qu'il redémarre automatiquement : `docker update --restart unless-stopped valhalla_nomad`.

Après une mise à jour de l'extrait OSM, supprimer le conteneur (`docker rm -f valhalla_nomad`) et le contenu
de `valhalla_data/` sauf le nouveau PBF, puis recréer le conteneur.

## 3. Génération des lignes

```bash
python mapping.py            # toutes les lignes
python mapping.py 301 305    # seulement certaines lignes
```

Les fichiers sont écrits dans `output_osm/ligne_nomad_<ligne>.osm`.

Au premier lancement, les arrêts OSM existants sont extraits dans `osm_bus_stops.geojsonseq`. Supprimer ce
fichier après une mise à jour de `normandy-latest.osm.pbf` pour le régénérer.

Le script affiche pour chaque ligne les arrêts trop loin du tracé (> 40 m) et les trous entre voies à corriger.

## 4. Relecture dans JOSM

1. Ouvrir `output_osm/ligne_nomad_<ligne>.osm` (avec le greffon **PT Assistant**).
2. Télécharger les données autour de la ligne pour avoir le contexte.
3. Corriger les signalements : trous entre voies, voies à découper aux extrémités, arrêts mal placés,
   quais existants complétés (réseau/exploitant ajoutés en `a;b` s'ils appartiennent déjà à un autre réseau).
4. Valider puis envoyer.
