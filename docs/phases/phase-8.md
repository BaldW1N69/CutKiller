# Phase 8 — Profils cinématiques (talking head et B-roll), issus d'une étude de tutoriels

## Livré

### Étude
- 24 vidéos et 9 articles, avec les techniques retenues et la part intégrée ou non : [`docs/research/cinematic.md`](../research/cinematic.md).
- Les vidéos sont lues en transcription, en résumé ou en description. Aucune n'a été téléchargée : YouTube bloque les robots et ce blocage n'a pas été contourné.
- Instagram n'est pas lisible sans compte : les Reels sont étudiés à travers des tutoriels YouTube consacrés aux Reels.

### Profils `cinematic` (16:9) et `cinematic-short` (9:16)
- Mêmes 25 règles QA, mesurées de la même façon : seuls les seuils changent, dans le YAML.
- Plans plus longs :
  - plan statique jusqu'à 10 s / 6 s (8 / 4 pour `long` / `short`) ;
  - plan minimal de 2 s / 1,5 s.
- Pauses jusqu'à 500 / 400 ms et marges de mots plus larges : on laisse respirer.
- **Poussée lente** (`push-in@1`, 900 ms, ease-in-out, sans rebond) au lieu du punch-in à ressort :
  - réservée aux phrases fortes : emphase ≥ 1,8 / 1,6 σ ;
  - espacée de 10 / 6 s ;
  - niveaux 104–107 %.
  - `montage.punch-ins` compte désormais aussi les animations d'échelle de rôle `move`.
- **Fondus** au lieu des whip-pans et glitchs :
  - `cross-dissolve@1` au changement de source ;
  - `dip-to-black@1` à une rupture dans la même caméra (≥ 2,5 / 1,5 s retirées, espacées de 20 / 10 s).
  - Aucun whoosh sur un fondu.
- Ducking plus lent (attaque 250 ms, relâche 600 ms) et musique un peu plus présente.
- Débit cible ×1,5 au lieu de ×1,25, pour préserver le grain.

### Moteur
- **Transition `dissolve`** (`via: direct | black`) dans la timeline d'animation partagée par le rendu et la QA. Opacité seule, sans mouvement.
  - Le dip tient 15 % de sa durée au noir autour de la coupe.
  - `image.black-frames` ignore ce noir voulu, et seulement dans la fenêtre du dip.
- **Look `film-print@1`** :
  - courbe en S +14 %, noirs à 2 % ;
  - *split toning* : ombres froides, hautes lumières chaudes, à luminance constante, poids en cloche nuls au noir et au blanc (pas de blanc teinté).
  - `clean@1` est inchangé : teintes nulles par défaut.
- **Texture film** (EDL 1.5, `output.texture`), peinte sous les sous-titres :
  - **grain** gaussien en *overlay* ;
  - **vignette** radiale ;
  - **letterbox** 2,39:1.
  - Le grain ne change qu'avec une nouvelle image source : une image répétée par le décodeur garde son grain, et `image.duplicate-frames` la détecte toujours.
  - La zone sûre des sous-titres inclut les bandes (+2 %) : les sous-titres restent sur l'image.
- **Sous-titres** :
  - `cinema-subtitle@1` (16:9, 2 lignes × 38 caractères) et `cinema-caption@1` (9:16, 2–4 mots) : casse normale, blanc cassé, contour fin, fondu.
  - Un écran sous le minimum de mots du profil rejoint son voisin le plus proche (pause < 1 s), quitte à être recoupé au plus large silence.

### Corrigé grâce aux rushes réels
- **Un écran d'un seul mot** (8 sur 52) dans un profil à 2–4 mots : regroupement ajouté.
- **Un clic en fin de vidéo** : seule la coupe entre deux plans contigus était fondue, et le dernier plan s'arrêtait au milieu d'un mot.
  - Chaque morceau de voix fond désormais à ses deux bords, sauf continuité exacte (zoom-cut).
  - Le fondu s'arrête aussi là où s'arrête un flux audio plus court que la vidéo (rush : audio 60,000 s, vidéo 60,008 s).

## Tests

- **143 tests TS** au vert (132 en phase 7), **22 tests Python** inchangés ; typecheck et Biome propres.
- Nouveaux tests :
  - **fondus** : opacité monotone, sans mouvement, noir sur la coupe ;
  - **look** : ombres plus froides, hautes lumières plus chaudes, luminance conservée, noir et blanc neutres ;
  - **texture sur un vrai rendu** : bandes noires, coins assombris, centre inchangé en moyenne, grain mesuré (écart-type de la différence > 2 niveaux sur un gris moyen) ;
  - **QA** : le dip au noir ne compte pas comme frames noires ; aucune frame dupliquée avec le grain ;
  - **profils** : seuils plus calmes que `long` / `short`, normes de livraison identiques, chaque preset référencé existe ;
  - **sous-titres** : regroupement d'un mot isolé, zone sûre hors letterbox ;
  - **audio** : fondu de fin posé avant la fin réelle du flux.

## Score qualité

Rushes réels sous licence libre (Global Lives Project, CC BY 3.0, entretien 640×360 à 23,976 fps ; musique CC0), commande `cutkiller auto`.

| Rendu | Score | Couverture | Écarts restants |
|---|---|---|---|
| `cinematic-short`, 60 s de rush | **99,7/100** (98,8 avant les deux correctifs) | 90 % | 1 répétition « ça, » non retirée ; « là » en retard de 6,8 frames (p95 1,4) ; 1 écran d'un mot isolé par plus de 1 s |
| `cinematic`, 180 s de rush | **99,9/100** | 80 % | 1 « euh » non transcrit par Whisper à la source ; 3 mots mal alignés (« a », « je », « 207 », 7–11 frames) |

- Le rendu `cinematic` a été produit avant le correctif audio. `audio.cut-clicks` n'y relevait aucun clic.
- Couverture plus faible qu'en phase 7 (92–98 %), sans que ce soit une régression : avec une seule caméra et peu de chutes longues, ni dissolve ni dip n'a été posé sur ces rushes, et le 16:9 n'est pas recadré.
  - Les fondus ne sont donc vérifiés que sur les tests, pas sur un rush réel.
- Les écarts restants sont ceux des phases 2 et 4 (aligneur, Whisper), et non des profils cinématiques.

### Ce qu'un monteur pro critiquerait encore

1. **Un « cinématique » surtout cosmétique sur un talking head** : sans B-roll ni plans de coupe, grain, look et letterbox habillent un entretien sans changer sa narration. Le montage B-roll calé sur la musique reste à faire.
2. **Des fondus sans poignées** : le plan sortant fige sa dernière image pendant la seconde moitié du fondu, au lieu de continuer sur la matière du rush.
3. **Des fondus et dips courts (500 ms)** : la règle `motion.presets` contrôle chaque preset de la bibliothèque contre la plage du profil actif (200–500 ms). Un fondu de cinéma de 0,8–1,5 s demandera que cette vérification ne porte que sur les presets utilisés.
4. **Un seul look pour toutes les scènes** : pas de teintes sélectives (verts → jaune, bleus → cyan), pas de halation ni d'instabilité de cadre. C'est propre, mais générique.
5. **Une source basse définition** : un 640×360 recadré en 9:16 est mou. Le grain n'y change rien, et aucune règle ne mesure la netteté.

## Limites connues

- **Pas de sortie 24 fps** : sur des rushes en 30 fps, la conversion saccade. Le profil reste en 30 fps tant que les rushes ne sont pas en 24/25 fps.
- **Pas de rampe de vitesse ni de ralenti** : le moteur ne remappe pas le temps.
- **Pas de riser → impact ni de room tone** : seuls les whooshes, le glitch et le tick existent en SFX synthétisés.
- **Grain** : une texture d'overlay de 389 px, répétée. Son échelle ne suit pas la résolution de sortie, et l'encodeur H.264 en lisse une partie au débit cible.
- **Étude** : 6 des 24 vidéos ne sont connues que par leur description et leurs chapitres, et aucun Reel n'a été vu directement. Les techniques retenues sont celles que plusieurs sources confirment.
