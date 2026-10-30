# Argile Sculpt

Prototype de sculpture numérique façon ZBrush, en JavaScript + WebGPU, sans dépendance.

## Lancer

- `node build.js` assemble `dist/argile-standalone.html` (à ouvrir dans Safari 26 / Chrome / Edge) et `dist/argile.html` (version artefact).
- `node test/core.test.js`, `node test/gp.test.js`, `node test/curves.test.js`, `node test/samples.test.js` et `node test/surface.test.js` lancent les tests (Node 20+).

## Version en ligne

**https://grandiosian.github.io/argile/** — à chaque push sur `main`, GitHub Actions lance les tests, reconstruit l'app et republie ce site.

## Tablette Android (Wacom MovinkPad Pro 14) et PWA

`node build.js` produit aussi `dist/pwa/`, la version publiée. Ouvrez l'URL ci-dessus dans Chrome sur la tablette, puis menu ⋮ > « Installer l'application ».
L'app s'ouvre alors en plein écran, fonctionne hors ligne et garde sa sauvegarde automatique.

Entrées : stylet = outil (pression avec courbe réglable, bout gomme, bouton latéral configurable) ;
doigts = navigation (1 doigt tourne, 2 doigts zooment/déplacent, tap 2 doigts annule, tap 3 doigts rétablit) ;
la paume est ignorée tant que le stylet touche ou survole l'écran. Barre rapide à gauche : Smooth / ZSub / Masque / Gomme
à maintenir du doigt pendant que le stylet travaille, ou à toucher pour verrouiller.

## Espace Courbes (formes et cylindres de Bézier)

- **Forme (1)** : contour fermé à main levée → solide à plat (épaisseur, arrondi des bords, bombé, ancrage sur le plan).
- **Courbe (2)** : tracé ouvert à main levée → cylindre extrudé le long de la courbe.
- **Plume (3)** : points de Bézier précis ; clic = point anguleux, glisser = point lisse, toucher le premier point ferme la forme.
- **Éditer (4)** : glisser points et poignées, double-clic sur la courbe pour ajouter un point, double-clic ou Alt+clic sur un point pour le rendre lisse ou anguleux, Suppr pour effacer.
- Profils : cercle, carré, carré arrondi, triangle, hexagone, étoile, demi-rond, losange, ou n'importe quelle forme dessinée ; rayon, largeur, effilement début/fin, torsion, rotation, densité, extrémités bouchées.
- Aperçu 3D avant création, puis « Créer le SubTool » (Ctrl+Entrée). Les traits du Dessin 3D peuvent être convertis en courbes éditables.

## Espace Modèles (M) — modèles paramétriques

Unités réelles conservées à l'export OBJ : bijoux en millimètres, figures en centimètres, bâtiments en mètres.

- **Bijoux** : chevalière (taille FR, plateau ovale/rond/carré/coussin/octogone, bombé, évasement, monogramme gravé ou en relief, inversé pour cachet) ; chevalière à clapet (cavité, couvercle articulé, charnière à jeu réglable, goupille, ouverture) ; collier (maille forçat/ronde/allongée, longueur, chute en V, fermoir, bélière, pendentif cœur/goutte/médaille/losange/étoile) ; boucle d'oreille (créole, pendante à crochet, puce à collet avec poussette, paire) ; bracelet à clapet (jonc ovale, charnière, fermoir à languette, ouverture).
- **Figures** : humanoïde (taille, canon en têtes, corpulence, silhouette, pose, ébauche du visage) ; animal (chien, chat, cheval, ours, lapin, oiseau, poisson, proportions réglables). Polygroupes par partie du corps.
- **Bâtiments** : bâtiment simple (niveaux, fenêtres et appuis, porte, corniches, toit deux pans/quatre pans/terrasse, cheminée) ; arche (plein cintre, brisée ou surbaissée, claveaux, clé saillante, mur) ; voûte néo-gothique (croisée d'ogives quadripartite, voûtains, nervures, clés, piliers fasciculés).

Aperçu 3D à chaque réglage, puis « Nouvelle scène » ou « Ajouter à la scène » : chaque pièce devient un SubTool sculptable (annulable).

**Modélisation surfacique** : la chevalière (mode par défaut) est une cage de quads paramétrique — sections autour de l'anneau, plateau plan, épaules, boucles de maintien pour des arêtes nettes — lissée par subdivision Catmull-Clark. Le rayon intérieur est corrigé pour tomber sur la taille demandée, le monogramme est gravé par déplacement des sommets, et le maillage reste tout en quads (le polyframe masque les diagonales).

## Espace ZSpheres (Z)

Squelette de sphères éditable, habillé d'une peau adaptative en quads (méthode B-Mesh : tubes à section carrée, enveloppe convexe aux embranchements, anneaux de maintien, puis Catmull-Clark). Départs : humanoïde, chien, chat, cheval, ours, lapin ou sphère seule ; les figures de l'espace Modèles s'ouvrent aussi en ZSpheres (« Éditer les ZSpheres »).

- **Ajouter (1)** : glisser depuis une sphère crée une sphère enfant ; cliquer sur un lien en insère une.
- **Déplacer (2)**, **Échelle (3)**, **Supprimer (4)** (ou Alt+clic) ; symétrie X ; rayon de la sphère sélectionnée réglable.
- **A** : aperçu de la peau ; subdivisions 1–4 ; densité des liens. Un polygroupe par partie du corps.

## Architecture

| Fichier | Rôle |
|---|---|
| `src/core.js` | Maillages indexés, arêtes O(n), BVH avec refit incrémental, raycast, point le plus proche, subdivision de Loop multirésolution (détails stockés en repère local), DynaMesh (voxels + flood fill + surface nets réutilisables + projection), primitives, OBJ |
| `src/sculpt.js` | Moteur de brosses CPU (Standard, Clay, ClayBuildup, Move, Inflate, Pinch, Flatten, DamStandard, Smooth, Mask, Polypaint), alphas, masques, polygroupes, visibilité, annulation par sommets |
| `src/gp.js` | Dessin 3D façon Grease Pencil : calques, traits (x, y, z, rayon), lissage, gomme par points ou traits entiers, conversion en tubes fermés (transport parallèle), lots GPU |
| `src/curves.js` | Courbes de Bézier 3D : ajustement sur un tracé (Schneider) avec détection des coins, édition (insertion de Casteljau, poignées alignées), plan moyen (ACP), profils, balayage à repères par transport parallèle, forme → solide par champ signé 2D (remplissage + distance euclidienne exacte) et surface nets |
| `src/sdf.js` | Modélisation par champs de distance : primitives (sphère, ellipsoïde, boîte, cône arrondi, cylindre, tore), unions lissées avec élagage par boîtes englobantes, transformations, étiquettes de polygroupes, mailleur par blocs (seule la bande autour de la surface est évaluée) ; maillages explicites (anneaux, cylindres, fusion, miroir) |
| `src/surface.js` | Modélisation surfacique : maillages polygonaux, Catmull-Clark avec héritage des polygroupes, orientation cohérente, enveloppe convexe 3D, peau adaptative des ZSpheres, conversion en triangles avec drapeaux de diagonales de quads |
| `src/samples.js` | Catalogue des modèles paramétriques (bijoux, figures, bâtiments) |
| `src/io.js` | ZIP (écriture stockée, lecture stockée/deflate), format de projet binaire, sauvegarde auto IndexedDB |
| `src/renderer.js` | Caméra trackball, rendu WebGPU : traits 3D en rubans + capuchons ronds (test de profondeur ou premier plan) ; draw non indexé qui lit sommets, normales, couleurs, masque et polygroupes dans des storage buffers ; matcaps procéduraux ; polyframe par barycentriques ; envoi GPU par blocs de 1024 sommets |
| `src/app.js` | Interface, entrées souris/stylet (pression, coalesced events, lazy mouse), symétrie, SubTools, transformations, pile d'annulation |

## Mesures (Chromium, CPU)

- Dab de brosse sur 1,3 M faces : ~1,3 ms (≈1 600 sommets touchés).
- Raycast BVH : < 0,05 ms.
- DynaMesh résolution 64 d'une sphère : ~0,2 s.

## Feuille de route

1. **Sculptris Pro** (topologie dynamique) : subdivision/fusion d'arêtes locale sous la brosse — nécessite une structure half-edge mutable et une reconstruction partielle du BVH.
2. **ZRemesher** : retopologie quad guidée par champs de directions (QuadriFlow / Instant Meshes) — le plus gros chantier ; piste réaliste via WebAssembly.
3. Gizmo 3D, masque lasso/rectangle, brosses Trim/Planar/Snake Hook, calques de sculpt, reprojection de détails entre SubTools, cavité/occlusion dans le shader.
4. Passage du cœur en Web Worker ou WASM pour les opérations longues ; empaquetage natif (Tauri) si besoin d'une vraie app Mac.
