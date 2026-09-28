"""Atoumod -> OSM : relations PTv2 des lignes de bus/car du GTFS régional Atoumod, à relire dans JOSM.

Organisation (dans l'ordre du traitement, voir pipeline.run) :
- config      chemins, seuils de distance, réseaux connus
- gtfs        lecture du GTFS, variantes de chaque ligne
- stops       arrêts GTFS <-> quais OSM candidats, arrêt d'en face (codes A/B)
- matching    map-matching des tracés par Valhalla
- osm         lecture du PBF (osmium), objets modifiés (ChainMap), écriture du .osm
- roundabouts découpage des ronds-points d'un seul tenant
- platforms   stop_position et quai de chaque arrêt, côté de la route, tags GTFS des quais
- naming      réseau d'une agence, libellés « VILLE Arrêt », noms des relations
- build       relations route / route_master d'une ligne
- geo         géométrie locale (distances, côté droit/gauche)
- pipeline    enchaînement complet
"""
