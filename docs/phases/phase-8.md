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

### Réponse aux cinq critiques du monteur (deuxième passe)

1. **B-roll, plans de coupe et montage sur la musique** (passe `broll`, entre `cut` et `reframe`). Une source est B-roll si elle est marquée `--broll` (elle n'est alors pas transcrite) ou si c'est une vidéo sans parole.
   - **Avec de la parole** : plans de coupe sur une piste superposée, la voix continue dessous.
     - Placement : d'abord centrés sur les jump cuts, qu'ils masquent ; ensuite sur les zoom-cuts des longues tirades.
     - Durée : 2–4 s (1,5–3 s en vertical), début et fin calés sur un beat quand il y en a un à portée.
     - Le locuteur reste à l'écran les 3 premières et les 2 dernières secondes, et 6 s au moins entre deux plans de coupe. Les plans de coupe couvrent au plus 40 % du montage.
     - Chaque seconde de B-roll ne sert qu'une fois, en piochant tour à tour dans les rushes. En 9:16, les plans de coupe sont recadrés sur leur sujet.
     - Aucun punch-in ni aucune transition n'est posé sous un plan de coupe.
   - **Sans parole** : montage d'un plan tous les 4 temps (une mesure), dans la plage de durée, aussi long que la musique ; le son direct des plans reste à −20 dB sous elle.
   - QA :
     - `montage.static-shots` compte l'entrée et la sortie d'un plan de coupe comme des changements d'image ;
     - `montage.beat-cuts` traite les coupes entre plans sans parole comme libres, donc mesurées sur les beats.
2. **Fondus avec poignées** : le plan sortant continue après son point de sortie et le plan entrant commence avant son point d'entrée, avec la matière des rushes, décodée en plus par le moteur de rendu.
   - Faute de matière (rush qui s'arrête au point de sortie), l'image est tenue comme avant.
3. **Fondus de cinéma** : plage propre aux fondus (`motion.dissolveDurationMs`, 400–1 500 ms), distincte des transitions en mouvement (200–500 ms). `cross-dissolve@1` dure 1 s, `dip-to-black@1` 1,2 s.
4. **Look par scène, teintes sélectives, halation** :
   - `film-print@1` tourne les jaunes vers l'orange, les verts vers le jaune et les bleus vers le cyan (hue-vs-hue à luma et chroma constantes), en protégeant les tons chair : ΔE < 1 sur trois carnations ;
   - **contraste par scène** : la plage tonale de chaque source (luma p5–p95, mesurée par le worker `subjects` v3) est rapprochée de moitié d'une cible commune (0,72), dans ±0,12, sous le même look. `image.color` ne voit toujours qu'un look ;
   - **halation** : les hautes lumières (luma > 0,75) sont floutées et teintées rouge-orangé, puis ajoutées en `screen`, sous les sous-titres.
5. **Netteté mesurée et corrigée** :
   - nouvelle règle **`image.sharpness`** : agrandissement source → sortie de chaque plan, poussées et punch-ins compris, pondéré par la durée ;
     - limite ×2 en `cinematic*`, ×2,2 en `short` / `long` (un 1080p recadré en 9:16 avec un punch-in de 120 % passe, un 720p à ×2,67 non) ;
     - la catégorie image reste à 20 points : `image.reframe` passe de 6 à 5, `image.export-format` de 3 à 2, la netteté prend 2 ;
     - variante de calibration `sharpness` : rush 1080p remplacé par sa copie 640×360, **détecté**, sans fausse alerte, témoin propre accepté ;
   - accentuation CAS (contrast-adaptive sharpening) au décodage dès ×1,15, plus forte avec l'agrandissement ;
   - alerte au planning quand une source est trop petite pour le format ;
   - nouveaux rushes de test **HD** : le master ProRes 1080p de l'entretien et trois B-roll 1080p de la journée filmée (CC BY 3.0).

### Styles d'image et vidéos de référence (troisième passe)

- **Styles** (`--look <style>`, `--look list`) : chaque look de `presets/look/` apporte sa texture, et le reste du profil ne change pas.
  - `bleach-grit` (inspiré de l'image de *Fight Club*) : saturation −45 %, ombres vert-cyan, hautes lumières jaune sale, contraste dur, gros grain, vignette lourde.
  - `neon-80s` (inspiré de *Vice City* / Miami) : saturation +30 %, rouges vers le magenta, bleus vers le cyan, ombres violettes, hautes lumières roses, **bloom** néon, peau protégée.
  - `teal-orange` (blockbuster) et `noir` (noir et blanc contrasté).
  - Les noms restent génériques : *Fight Club* et *Vice City* sont des marques. Les descriptions disent de quoi chaque style s'inspire.
- **Bloom** : halo des hautes lumières dans leurs propres couleurs, calculé au quart de la résolution pour que les lumières fines (un tube néon) passent le seuil.
- **Vignette sans anneaux** : calque à opacité tramée. Le grain tramé atteint aussi les hautes lumières, pour qu'un ciel 8 bits étiré par un look ne montre pas ses paliers.
- **`cutkiller reference <réf.mp4> --against rendu.mp4`** : empreinte de style comparée, avec le réglage du profil à modifier pour chaque écart. Elle mesure :
  - le rythme : coupes par changement de plan, durée médiane d'un plan, coupes par minute, part de plans de moins d'1 s ;
  - l'image : luma, contraste p10–p90, saturation, chaleur, letterbox ;
  - le son : LUFS et LRA.
- **Vidéos de référence fournies** : je n'ai pas pu les analyser. YouTube et TikTok refusent les robots, et ce blocage n'a pas été contourné.
  - On en connaît le titre et l'auteur (oEmbed officiel) et deux résumés : *10 Editing Cuts* (Jonny Duncan) et *How to edit SO good…* (Learn By Leo).
  - La comparaison chiffrée demande les fichiers : `reference` les mesure dès qu'ils sont fournis.
- **Sortie à la cadence des rushes** (`format.matchSourceFps`, profils cinematic) : les masters 23,976 fps sortent en 24 fps, sans la saccade de pulldown d'une conversion en 30.
- **Corrigé grâce aux rushes réels** :
  - l'encodeur AAC dépassait de 2,6 dB le true peak du mix (+0,8 dBTP livré) : bande coupée à 18 kHz, contrôle après encodage, réencodage de l'audio seul si nécessaire ;
  - un rush de 20,02 s lisait une frame au-delà de sa fin ;
  - les plans du montage B-roll reprenaient l'identifiant de la musique ;
  - en 9:16, le montage B-roll prenait les rushes dans l'ordre et cadrait mal les scènes à plusieurs personnes. Il choisit maintenant les moments où le sujet tient dans le cadre.

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
