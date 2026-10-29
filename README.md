# Argile Sculpt

Prototype de sculpture numérique façon ZBrush, en JavaScript + WebGPU, sans dépendance.

## Lancer

- `node build.js` assemble `dist/argile-standalone.html` (à ouvrir dans Safari 26 / Chrome / Edge) et `dist/argile.html` (version artefact).
- `node test/core.test.js` et `node test/gp.test.js` lancent les tests (Node 20+).

## Version en ligne

**https://grandiosian.github.io/argile/** — à chaque push sur `main`, GitHub Actions lance les tests, reconstruit l'app et republie ce site.

## Tablette Android (Wacom MovinkPad Pro 14) et PWA

`node build.js` produit aussi `dist/pwa/`, la version publiée. Ouvrez l'URL ci-dessus dans Chrome sur la tablette, puis menu ⋮ > « Installer l'application ».
L'app s'ouvre alors en plein écran, fonctionne hors ligne et garde sa sauvegarde automatique.

Entrées : stylet = outil (pression avec courbe réglable, bout gomme, bouton latéral configurable) ;
doigts = navigation (1 doigt tourne, 2 doigts zooment/déplacent, tap 2 doigts annule, tap 3 doigts rétablit) ;
la paume est ignorée tant que le stylet touche ou survole l'écran. Barre rapide à gauche : Smooth / ZSub / Masque / Gomme
à maintenir du doigt pendant que le stylet travaille, ou à toucher pour verrouiller.

## Architecture

| Fichier | Rôle |
|---|---|
| `src/core.js` | Maillages indexés, arêtes O(n), BVH avec refit incrémental, raycast, point le plus proche, subdivision de Loop multirésolution (détails stockés en repère local), DynaMesh (voxels + flood fill + surface nets + projection), primitives, OBJ |
| `src/sculpt.js` | Moteur de brosses CPU (Standard, Clay, ClayBuildup, Move, Inflate, Pinch, Flatten, DamStandard, Smooth, Mask, Polypaint), alphas, masques, polygroupes, visibilité, annulation par sommets |
| `src/gp.js` | Dessin 3D façon Grease Pencil : calques, traits (x, y, z, rayon), lissage, gomme par points ou traits entiers, conversion en tubes fermés (transport parallèle), lots GPU |
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
