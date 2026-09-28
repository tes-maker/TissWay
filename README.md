# Atoumod → OSM

Génère les relations PTv2 des lignes de bus/car de toute la billettique régionale Atoumod (Nomad, Twisto,
Astuce, Ficibus...) à partir du GTFS, dans un fichier `.osm` à relire et envoyer depuis JOSM.

Le réseau (`network`, + `network:wikidata` quand vérifié sur OSM) est déduit de l'`agency` GTFS de chaque
ligne. Aucun `operator` n'est mis : l'exploitant réel d'une ligne (souvent un sous-traitant) n'est pas fiable
dans le GTFS et n'est donc pas inventé — à compléter à la main dans JOSM si besoin.

## Prérequis

```bash
sudo apt install osmium-tool docker.io
pip install geopandas pandas requests
pip install pytest   # pour les tests (facultatif)
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
python mapping.py -r nomad -l 301,305   # idem avec l'option -l/--ligne (espaces ou virgules)
```

Un numéro de ligne inconnu (sur le réseau choisi) arrête le script en listant les lignes disponibles.

Le nom du réseau (`-r`/`--reseau`) est celui du tag `network` généré (voir plus bas), insensible à la casse
(ex. `nomad`, `Twisto`, `Astuce`). En cas d'erreur, le script liste les réseaux disponibles dans le GTFS.

Toutes les lignes d'une exécution sont écrites dans un seul fichier : `output_osm/<réseau>[_<lignes>].osm`
(ex. `nomad.osm`, `nomad_301_305.osm`, `atoumod.osm` sans `-r`). Un seul fichier évite les conflits entre
lignes sur les objets partagés (ronds-points découpés, quais, stop_positions) : l'envoyer en une fois.

Les ronds-points d'un seul tenant (voie fermée `junction=roundabout`) sont découpés à chaque entrée/sortie
des lignes, pour qu'une ligne ne garde que les morceaux qu'elle parcourt au lieu du tour complet. Le morceau
le plus long garde l'id d'origine ; les relations OSM existantes qui contenaient le rond-point (autres
lignes, itinéraires vélo, associatedStreet...) reçoivent tous les morceaux, dans le sens giratoire, pour ne
pas y créer de trou.

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

1. Ouvrir `output_osm/<réseau>[_<lignes>].osm` (avec le greffon **PT Assistant**).
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
  Un même `stop_id` GTFS n'est posé que sur **un seul quai** : quand le GTFS n'a qu'un arrêt pour les deux
  sens, les deux quais sont dans les relations mais seul celui qui porte déjà le `stop_id` dans OSM (cherché
  jusqu'à 100 m, coordonnées GTFS approximatives), sinon le plus proche de l'arrêt GTFS, reçoit
  `gtfs:stop_id`, `ref:FR:Atoumod`, `ref` et `wheelchair` ; l'autre n'a que `name` et `network`. Si le
  `stop_id` est déjà sur un quai OSM non retenu, il n'est posé nulle part et le script le signale.
- **Stop_position** (sur la voie) : seulement `public_transport=stop_position`, `bus=yes`, `name` — pas de
  `network` (une stop_position est partagée par toutes les lignes qui passent par cette voie, quel que soit
  leur réseau).

## Quais Nomad seuls (`nomad_platforms.py`)

Script indépendant qui complète les quais OSM existants avec les arrêts GTFS Nomad Car, sans créer de
relations : chaque arrêt est associé au quai OSM le plus proche (≤ 30 m, un quai par arrêt), qui reçoit
`gtfs:stop_id:FR-NOR-Nomad`, `gtfs:stop_name:FR-NOR-Nomad`, `route_ref` (+ `bus`/`wheelchair` s'ils
manquent).

```bash
python nomad_platforms.py   # -> output_osm/nomad_platforms.osm + nomad_platforms_non_trouves.csv
```

## Organisation du code

`mapping.py` n'est que la ligne de commande ; le traitement est dans le paquet `atoumod/`, un module par
étape :

| Module | Rôle |
|---|---|
| `config.py` | chemins, seuils de distance (`MAX_*_M`), réseaux connus (`NETWORKS`) : les réglages sont ici |
| `pipeline.py` | enchaînement complet (`run`) : sélection des lignes → écriture du `.osm` |
| `gtfs.py` | lecture du GTFS, variantes de chaque ligne |
| `stops.py` | arrêts GTFS ↔ quais OSM candidats, arrêt d'en face (codes `2702282A` / `2702282B`) |
| `matching.py` | map-matching des tracés par Valhalla |
| `osm.py` | lecture du PBF (osmium), objets modifiés, écriture du `.osm` |
| `roundabouts.py` | découpage des ronds-points d'un seul tenant |
| `platforms.py` | stop_position et quai de chaque arrêt : côté de la route, arrêt d'en face, un seul quai par `stop_id` |
| `naming.py` | réseau d'une agence, libellés « VILLE Arrêt », noms des relations |
| `build.py` | relations `route` / `route_master` d'une ligne |
| `geo.py` | géométrie locale (distances, côté droit/gauche) |

Tous les objets OSM passent par `obj = ChainMap(modifiés, PBF)` : ce qui est créé ou modifié est dans
`obj.maps[0]` (et sera écrit), le PBF lu reste intact en dessous. Détails en tête de `atoumod/osm.py`.

### Tests

```bash
python -m pytest
```

Les tests (`tests/`) couvrent les règles les plus fragiles sur de petites données construites à la main,
sans réseau ni PBF : libellés « VILLE Arrêt », côté de la route et sens de parcours, arrêt d'en face,
un seul quai par `stop_id`, découpage des ronds-points. Ajouter un cas de test à chaque erreur trouvée
à la relecture dans JOSM.
