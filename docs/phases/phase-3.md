# Phase 3 — Animation et motion

## Livré

### Courbes (`@cutkiller/core/ease`)

- **Cubic-bezier CSS** résolue exactement (Newton + bissection) et **ressorts amortis** (raideur, amortissement, masse) évalués en temps réel, pas en progression normalisée : un ressort garde la même physique quelle que soit la durée.
- Mesures utilisées par la QA : dépassement réel d'une courbe (`easeOvershoot`) et forme (`easeShape` : décélérée, accélérée ou symétrique).
- Courbes nommées ajoutées : `ease-in-out-cubic`, `ease-in-out-expo`.

### EDL 1.1

- **Keyframes** : rôle (`entry`, `exit`, `micro`, `move`), preset d'origine (`nom@x.y.z`) et raison (`why`, ex. « « toujours » (score 1.7) »).
- **Transitions** (`transitions[]`) : posées sur une coupe, preset versionné, durée en frames, raison.
- **Flou de mouvement** paramétré dans `output.motionBlur` (seuil 12 px/frame, obturateur 180°).
- Le validateur refuse une transition hors coupe, plus longue que l'un des deux plans, ou qui en chevauche une autre, et des keyframes hors de leur clip.

### Bibliothèque de presets ([`presets/`](../../presets))

Six presets nommés et versionnés : `zoom-punch`, `pop-in`, `fade-out`, `whip-pan`, `smooth-slide`, `glitch-cut`. Une EDL les référence par `nom@majeure`, donc une évolution compatible s'applique d'elle-même et une rupture impose une nouvelle majeure.

### Passe `motion`

- **Punch-ins animés sur l'emphase** : un nouveau worker `prosody` mesure l'énergie (dB) et la hauteur (demi-tons, YIN) de chaque mot. Le score d'emphase combine ces deux mesures, normalisées par rapport au locuteur sur ±6 s, et un a priori lexical : intensifs, nombres et mots longs ajoutent des points, mots-outils et mots très courts en retirent.
- Le punch-in (`zoom-punch`, ressort de 200 ms, ≈5 % de rebond) démarre 2 frames avant le mot. Il est réservé aux plans larges, à un niveau toujours différent du punch-in précédent et du prochain cadrage serré, et espacé d'au moins 2 s (court) ou 4 s (long).
- **Transitions aux ruptures** : posées seulement sur un jump cut qui a retiré ≥ 0,8 s (court) ou ≥ 1,2 s (long) de rush, ou sur un changement de source, avec un espacement minimal de 5 s / 12 s.
- **Même caméra** : whip-pan (et glitch-cut en court), parce qu'un slide entre deux prises du même plan se lit comme une erreur.
- **Changement de source** : smooth-slide.

### Rendu

- **`MotionTimeline`** : une description unique de ce qui est à l'écran à chaque frame (calques, image vivante ou figée, position animée). Le rendu et la QA la partagent, donc ils jugent le même mouvement.
- **Marge de décodage** : un clip animé est décodé à l'échelle maximale qu'il atteindra (≤ 1,5×), si bien qu'un punch-in de 113 % ne ré-agrandit pas une image déjà mise à l'échelle.
- **Flou de mouvement** par sur-échantillonnage temporel : au-delà de 12 px/frame (déplacement maximal d'un coin du calque), la frame est la moyenne exacte de n sous-images sur la durée de l'obturateur, avec n = ⌈v·180/360/3 px⌉ et au plus 32. Exemple : pic mesuré de 691 px/frame au milieu d'un whip-pan.
- **Glitch** déterministe (graine par frame) : séparation RVB et bandes décalées, avec l'intensité maximale sur la coupe.
- **Journal de rendu** `<vidéo>.render-log.json` : vitesse et nombre de sous-images pour chaque frame.

### QA

- `motion.durations` : 150–300 ms pour les micro-animations, 200–500 ms pour les transitions, à ±½ frame.
- `motion.overshoot` : 3–8 % sur les entrées et micro-animations à ressort, aucun dépassement ailleurs.
- `motion.blur` : vitesses recalculées par la `MotionTimeline` et comparées au journal de rendu (frame trop rapide sans flou, ou sous-échantillonnée).
- `motion.presets` : chaque animation vient d'un preset existant, et chaque preset de la bibliothèque respecte lui-même les règles.
- `montage.punch-ins` : élargi aux punch-ins animés, qui doivent rester dans 105–115 %, ne jamais avoir deux fois de suite le même niveau et être ancrés sur un mot.

## Tests

```sh
pnpm check && pnpm typecheck && pnpm test
(cd workers && uv run ruff check . && uv run pytest)
```

**69 tests TypeScript et 14 tests Python verts**, y compris les tests de précision au mot qui chargent les modèles. Lint, format, typecheck et schémas sont à jour.

Tests propres à la phase :
- courbes : solveur bezier comparé à des valeurs de référence, dépassement d'un ressort comparé à la formule analytique exp(−ζπ/√(1−ζ²)), forme des courbes ;
- passe `motion` : choix du mot, alternance des niveaux, espacement, preset selon la source ;
- QA : des violations volontaires pour chaque règle, notamment :
  - courbe linéaire ;
  - entrée qui accélère ou sortie avec rebond ;
  - durée de 500 ou 800 ms ;
  - dépassement de 10 % ;
  - animation qui ne suit plus son preset ;
  - punch-in sans mot ;
  - frame rapide rendue sans flou ;
- **rendu au pixel** : sur la frame centrale d'un whip-pan, l'énergie de gradient de l'image floutée est < 0,6× celle du même rendu sans flou ;
- worker `prosody` : sur trois « mots » tonals, le plus fort ressort de > 15 dB et la hauteur est mesurée à ±0,5 demi-ton.

## Score qualité (boucle sur rushes réels)

Mêmes rushes qu'en phase 2 (entretien Global Lives Project CC BY 3.0, musique CC0), rendus en `--draft`.

| Rendu | Motion | Score | Couverture |
|---|---|---|---|
| Long 16:9, 180 s de rush | 8 punch-ins animés (« tous », « tiers », « toujours »…), 3 whip-pans, 46 frames floutées (pic 691 px/frame) | **100/100** | 51 % |
| Court 9:16, 60 s de rush | 4 punch-ins animés, 1 whip-pan, 19 frames floutées (pic 389 px/frame) | **100/100** | 51 % |

La couverture passe de 31 % à 51 % : la catégorie motion est entièrement évaluée. Le reste correspond aux sous-titres, à l'audio (loudness, ducking, SFX) et à l'image (recadrage, étalonnage), soit les phases 4 à 6. Rendu à 26–27 fps en draft sur 4 cœurs CPU.

Corrigé pendant la boucle :
- un **smooth-slide entre deux prises de la même caméra** se lisait comme une erreur de montage. Les transitions sont désormais choisies selon le cas (même source : whip-pan/glitch ; changement de source : slide) ;
- la mesure de flou d'abord retenue (variation totale) ne baissait pas avec le flou. Elle est remplacée par l'énergie de gradient.

### Ce qu'un monteur pro critiquerait encore

1. **Emphase sans le sens** : le score est prosodique et lexical. Un punch-in tombe sur « heures » ou « part » parce que le mot est plus fort, pas parce qu'il porte l'idée. Pour viser la chute d'une phrase ou le mot-clé du propos, il faudrait un score sémantique (LLM local ou TF-IDF sur le transcript).
2. **Recadrage 9:16 au centre** : sur l'entretien, le visage est coupé en deux pendant tout le court. C'est le défaut le plus visible, et il relève de la phase 6 (suivi du sujet).
3. **Transitions rares et uniformes** : 3 whip-pans tous vers la gauche sur 2 min 30. La direction devrait suivre le regard ou le mouvement dans l'image, et le glitch n'est jamais sorti sur ce rush (une seule rupture assez longue en court).
4. **Pas de son sur le mouvement** : un whip-pan sans « whoosh » paraît muet. Les SFX synchronisés arrivent en phase 5.
5. **Image molle sous le zoom** : agrandir de 106–113 % une source 640×360 reste flou, marge de décodage ou pas. Il faudrait des rushes 1080p+ ou un upscaler (phase 6).

## Limites connues

- **Flou de mouvement** : il ne couvre que le mouvement des calques (transformations animées), pas le mouvement interne des images. C'est conforme à la règle (déplacement > 12 px/frame imputable au montage), mais un recadrage dynamique en phase 6 devra passer par la même `MotionTimeline` pour être flouté.
- **Coût du flou** : jusqu'à 32 sous-images par frame rapide. C'est négligeable ici (≈1 % des frames), mais une vidéo pleine de transitions ralentirait nettement le rendu CPU.
- **Pop-in et fade-out** : présents dans la bibliothèque et validés par la QA, mais sans élément à faire apparaître avant les sous-titres (phase 4).
- **Emphase** : la normalisation suppose un seul locuteur sur la fenêtre de ±6 s. Avec un intervieweur à voix plus forte, ses mots seraient sur-scorés (pas de diarisation).
- **Seuil de vitesse** : mesuré sur les coins du calque, donc conservateur pour les rotations. Une vitesse au centre de l'image donnerait moins de frames floutées.
