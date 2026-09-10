# Carto Guidage

Application web pour mesures terrain sur deux points, avec carte GPS,
import Excel, itinéraires calibrés en durée, affichage des zones
réglementaires (ZTD / AZD / ZND) et sauvegarde locale.

## Mise en ligne sur GitHub Pages

1. Créez un dépôt GitHub (ex. `carto-guidage`).
2. Déposez-y les 3 fichiers `index.html`, `style.css`, `app.js`, ainsi que
   le sous-dossier **`zones/`** (contenant `ztd.geojson`, `azd.geojson`,
   `znd.geojson`) en conservant cette arborescence.
3. Dans **Settings → Pages**, activez GitHub Pages sur la branche `main`, dossier `/root`.
4. L'application sera accessible à `https://<votre-compte>.github.io/carto-guidage/`.
5. Sur iPhone, ouvrez ce lien dans Safari, puis **Partager → Sur l'écran d'accueil**
   pour l'utiliser comme une app.

## ⚠️ Important — clé API Google Directions

Le code de l'application est **public** une fois sur GitHub Pages : n'importe qui
peut voir le code source, y compris la clé API si elle était codée en dur.

Dans cette version, la clé se saisit **dans l'application elle-même** (menu →
section 3) et reste stockée uniquement sur votre iPhone (`localStorage`) — elle
n'apparaît jamais dans le code du dépôt. C'est la solution la plus simple.

Pour éviter tout usage frauduleux si la clé venait à fuiter (capture d'écran,
etc.), **restreignez-la** dans la console Google Cloud :
- **Restrictions d'application** → « Référents HTTP » → ajoutez
  `https://<votre-compte>.github.io/*`
- **Restrictions d'API** → limitez-la uniquement à « Directions API »
- Définissez un plafond de quota/budget quotidien dans la console Google Cloud

## Format du fichier Excel attendu

Une ligne par point, deux lignes consécutives formant une paire (point 1 puis
point 2 du même trajet à mesurer). Les noms de colonnes sont libres : vous les
sélectionnez dans l'application après l'import (nom du point / latitude /
longitude).

## Fonctionnement du calcul d'itinéraire

1. L'application calcule d'abord le trajet routier direct entre les deux
   points via Google Directions.
2. Si sa durée hors trafic est **inférieure à 15 min**, elle ajoute
   automatiquement un point de passage (détour) perpendiculaire au trajet
   direct, avec une distance croissante, jusqu'à tomber dans la fourchette
   15–20 min (bornes réglables dans le menu).
3. Si le trajet direct dépasse déjà 20 min, il est conservé tel quel (pas de
   raccourci automatique).
4. L'itinéraire retenu (avec ses éventuels points de détour) est à la fois
   affiché sur la carte de l'app et transmis à Google Maps lors du guidage,
   afin que le trajet réel corresponde à la durée calculée.

**Limite à connaître** : une fois le guidage lancé dans Google Maps, si vous
vous écartez de l'itinéraire proposé, Google Maps recalculera le chemin le
plus rapide et la contrainte de durée ne sera plus respectée. C'est une limite
de l'application tierce, pas de ce projet.

## Zones réglementaires (ZTD / AZD / ZND)

Le menu (section « 3. Zones réglementaires ») propose :
- Un **sélecteur de ville** (Paris, Béthune, Nantes — d'autres villes pourront être
  ajoutées de la même façon)
- Trois cases à cocher pour superposer sur la carte les contours de la ville
  sélectionnée : **ZTD** (turquoise), **AZD** (corail), **ZND** (bleu)

Changer de ville désactive et décoche automatiquement les zones affichées de
l'ancienne ville, pour éviter de superposer des contours de villes différentes
par erreur.

Chaque zone se charge à la demande (au premier affichage) depuis son fichier
`.geojson` dans `zones/`, nommé `<ville>_<type>.geojson` (ex. `paris_ztd.geojson`,
`bethune_azd.geojson`, `nantes_znd.geojson`), puis reste en mémoire pour les
bascules suivantes. Une légende apparaît en haut à droite de la carte tant
qu'au moins une zone est active, précisant la ville et le type.

Pour ajouter une nouvelle ville : générez ses 3 fichiers `.geojson` au format
`<ville>_ztd.geojson` / `<ville>_azd.geojson` / `<ville>_znd.geojson`, déposez-les
dans `zones/`, puis ajoutez une `<option>` correspondante dans le menu déroulant
« Ville » du fichier `index.html`.

## Sauvegarde des données

- Sauvegarde automatique sur l'appareil à chaque action (statuts, itinéraires,
  import).
- Bouton **Exporter (JSON)** : télécharge un fichier de secours (à conserver,
  par ex. dans vos mails ou un cloud), utile en cas de changement d'appareil
  ou de nettoyage du navigateur.
- Bouton **Importer (JSON)** : restaure une sauvegarde précédente.
