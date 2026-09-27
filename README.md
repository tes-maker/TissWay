# Atoumod → OSM

Génère un fichier `.osm` (PTv2) par ligne de bus/car de toute la billettique régionale Atoumod (Nomad, Twisto,
Astuce, Ficibus...) à partir du GTFS, à relire et envoyer depuis JOSM.

Le réseau (`network`, + `network:wikidata` quand vérifié sur OSM) est déduit de l'`agency` GTFS de chaque
ligne. Aucun `operator` n'est mis : l'exploitant réel d'une ligne (souvent un sous-traitant) n'est pas fiable
dans le GTFS et n'est donc pas inventé — à compléter à la main dans JOSM si besoin.

## Prérequis

```bash
sudo apt install osmium-tool docker.io
pip install geopandas pandas requests
```

## 1. Données

- **GTFS Atoumod** : dézipper dans `gtfs_atoumod/` (`agency.txt`, `stops.txt`, `routes.txt`, `trips.txt`,
  `stop_times.txt`, `shapes.txt`…). Seules les lignes de bus/car (`route_type=3`) sont traitées ; train, tram
  et bac (ferry) sont hors périmètre du script (voies + costing "bus" de Valhalla).
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
python mapping.py                    # toutes les lignes, tous réseaux
python mapping.py 301 305            # seulement certains numéros de ligne (tous réseaux confondus)
python mapping.py -r Twisto          # seulement les lignes du réseau Twisto
python mapping.py -r Twisto 1 2      # les lignes 1 et 2 du réseau Twisto
```

Le nom du réseau (`-r`/`--reseau`) est celui du tag `network` généré (voir plus bas), insensible à la casse
(ex. `nomad`, `Twisto`, `Astuce`). En cas d'erreur, le script liste les réseaux disponibles dans le GTFS.

Les fichiers sont écrits dans `output_osm/<réseau>_<ligne>.osm` (ex. `nomad_101.osm`, `twisto_1.osm`).

Au premier lancement, les arrêts OSM existants sont extraits dans `osm_bus_stops.geojsonseq`. Supprimer ce
fichier après une mise à jour de `normandy-latest.osm.pbf` pour le régénérer.

Le script affiche pour chaque ligne les arrêts trop loin du tracé (> 40 m) et les trous entre voies à corriger.

### Noms des arrêts, lignes et lignes maîtres

Les noms de ligne et de ligne maître reprennent le format déjà utilisé sur OSM pour Twisto (Caen la mer) :

- ligne (une variante/direction) : `Bus <ref> : VILLE Arrêt → VILLE Arrêt`
- ligne maître : `Bus <ref> : VILLE Arrêt ↔ VILLE Arrêt`, ou `VILLE Arrêt / VILLE Arrêt ↔ VILLE Arrêt` s'il y
  a plusieurs origines pour un même terminus (lignes à embranchements)

`VILLE` est la commune du code INSEE du stop_id, récupérée auprès de l'API officielle *Découpage
administratif* et mise en majuscules sans accent ; `Arrêt` est le nom GTFS, sans la commune (ou son début) s'il
la contient déjà (« Avranches - Gare » → `AVRANCHES Gare`, « Fleury Mairie » → `FLEURY-SUR-ORNE Mairie`). Les quais, les stop_positions et les tags `from`/`to` prennent
le nom GTFS officiel exact (le `name` des objets OSM existants est remplacé).

⚠️ Cette normalisation suppose la convention « VILLE - Arrêt » (celle de Nomad Car et de la plupart des
réseaux interurbains). Certains réseaux urbains (Twisto notamment) nomment leurs arrêts sans tiret, la ville
n'apparaissant que si elle diffère de la commune principale du réseau (ex. "Chemin Vert" à Caen, mais
"Mondeville Centre Commercial" hors Caen) : ces noms sont repris tels quels, sans déduire la commune
principale absente. À corriger à la main dans JOSM si besoin pour ces réseaux.

## 4. Relecture dans JOSM

1. Ouvrir `output_osm/<réseau>_<ligne>.osm` (avec le greffon **PT Assistant**).
2. Télécharger les données autour de la ligne pour avoir le contexte.
3. Corriger les signalements : trous entre voies, voies à découper aux extrémités, arrêts mal placés,
   quais existants complétés (s'il appartient déjà à un autre réseau, le nouveau est ajouté en `network:2`, `network:wikidata:2`,
   `network:wikipedia:2`…), `operator` à
   ajouter à la main si connu.
4. Valider puis envoyer.

## Tags posés

- **Quai** (`public_transport=platform` + `highway=bus_stop`) : `bus=yes`, `name`, `network`
  (+ `network:wikidata` si connu), `gtfs:stop_id`, `ref:FR:Atoumod` (`ref:FR:Atoumod:2` si le quai en a déjà un autre), et `ref`/`wheelchair` si présents dans
  le GTFS.
- **Stop_position** (sur la voie) : seulement `public_transport=stop_position`, `bus=yes`, `name` — pas de
  `network` (une stop_position est partagée par toutes les lignes qui passent par cette voie, quel que soit
  leur réseau).
