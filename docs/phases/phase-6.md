# Phase 6 — Image : recadrage 9:16 et étalonnage

## Livré

### EDL 1.4

- **`reframe`** sur un clip : axe (`x` pour 16:9 → 9:16, `y` pour 9:16 → 16:9) et clés `{ frame, value, ease }`, position du centre du cadre dans la source (0–1). Jamais d'interpolation linéaire.
- **`color`** sur un clip : `exposureEv`, `balance` (gains par canal), `look` (preset `look/`).
- **Validateur** : refuse une clé de recadrage hors du plan, une position hors de la source et un recadrage en interpolation linéaire.
- **Géométrie partagée** (`clipFraming`, `@cutkiller/core`) : bande de source décodée, pixels de sortie par pixel de source, décalage du cadre à chaque frame. Le décodeur, le compositeur, l'analyse de mouvement (flou) et la QA lisent la même.

### Analyse : visages et peau (worker `subjects`)

- **Détecteur YuNet** (OpenCV, modèle MIT de 230 Ko, sha256 épinglé) à 5 images/s : boîtes, confiance et 5 points du visage.
- **Couleur de peau** : médiane des joues et du nez, entre les yeux et au-dessus de la bouche (points du visage). Barbe, cheveux, lunettes, reflets et un sous-titre posé dessus restent hors de la mesure.
- **Échantillonnage à l'instant juste** : le filtre `fps` de FFmpeg garde la dernière image de chaque intervalle. En `round=near`, un échantillon voyait l'image de 67 ms plus tard (erreur de 4 % de la largeur sur un visage en mouvement) ; en `round=up`, c'est la dernière image à l'instant de l'échantillon ou avant (erreur ≤ 0,4 %).

### Passe `reframe` : caméra virtuelle

Pour chaque plan dont le rush n'a pas le format de sortie :
- le visage suivi (le même d'un échantillon à l'autre), filtré par une médiane glissante de 0,8 s ;
- **zone morte** de 10 % du cadre : la caméra ne bouge pas tant que le visage y reste, ni pour un regard de côté de moins de 0,5 s ;
- quand le sujet se déplace, la caméra glisse vers sa nouvelle position. Le montage connaissant la suite, le glissement est **posé sur le déplacement du sujet** (même milieu, même durée) au lieu de le poursuivre en retard ;
- **accélération bornée** : un glissement est allongé jusqu'à ce que l'accélération du cadre reste sous 3 px/frame². La courbe `ease-in-out` est choisie parce que c'est la courbe nommée qui a le pic d'accélération le plus bas (4,4 D/T², contre 12,7 pour `ease-in-out-cubic`) ;
- un glissement tardif démarre plus tôt pour finir sur la coupe. À chaque coupe, le cadre repart du visage.

### Passe `color` : égalisation sur la peau

- La peau de chaque **source** est mesurée sur les passages conservés. Elle est ramenée sur la **référence** du montage (médiane des sources, pondérée par la durée) par une exposition et une balance en lumière linéaire.
  - La balance garde la luminance de la peau : `balance × 2^EV` donne exactement les gains voulus.
  - Une dominante est corrigée sur les trois canaux ou pas du tout, jamais sur un seul (sinon la teinte tourne).
- **Même correction pour tous les plans d'une source** : la correction plan par plan faisait varier l'exposition jusqu'à 0,37 EV entre deux jump-cuts du même rush, donc un scintillement.
- **Raccord isolé** : un plan dont la peau s'écarte de plus de ΔE 4 de celle de sa source (lumière qui change, tête tournée vers la fenêtre) reçoit sa propre correction.
- **Plancher d'exposition** : une peau de référence plus sombre que L\* 25 est relevée, dans la limite de 1,5 EV.
  - En dessous de L\* 25, une peau est sous-exposée quelle que soit la carnation : c'est un visage à contre-jour. Le seuil est volontairement bas pour ne pas « éclaircir » une peau foncée correctement exposée.
  - Sur l'entretien filmé devant une fenêtre : +0,51 EV (court) et +0,53 EV (long).
- **Épaulement des hautes lumières** : au-delà d'un gain de 1, les valeurs linéaires au-dessus de 0,5 sont compressées en douceur jusqu'au blanc, sans écrêtage. La pente est continue au genou.
- **Look `clean@1`** : courbe en S douce, noirs relevés de 1 %, saturation +6 % sans virage de teinte. La LUT est générée, aucun fichier n'est livré.

### Rendu

- **Recadrage au décodage** : seule la bande de la source que le cadre parcourt est extraite, en pixels entiers. Le compositeur la fait glisser frame par frame et le flou de mouvement en tient compte.
- **Une seule LUT 3D par étalonnage** : exposition, balance, épaulement et look sont cuits dans une LUT 33³ par combinaison distincte (`lut3d`, interpolation tétraédrique). Elle est appliquée **avant la mise à l'échelle** quand la zone recadrée a moins de pixels que la sortie.

### QA (2 nouvelles règles : les 25 règles ont leur contrôle)

- **`image.reframe`** :
  - **trajectoire de la caméra** (géométrie partagée) : accélération ≤ 3 px/frame² ;
  - **sur le rendu** (YuNet indépendant, 5 échantillons/s, hors coupes et transitions) : partout où le rush montre un visage, le rendu le montre, avec au moins 95 % de sa boîte dans l'image et son centre à moins de 25 % de la largeur du milieu.
- **`image.color`** : un même look sur tous les plans, et la peau de chaque plan, mesurée sur le rendu, à ΔL\* ≤ 6 et Δa\*b\* ≤ 6 (CIELAB) de la référence du montage.

### Corrigé en route

- **QA des frames dupliquées** : pour un plan recadré, la source était décodée à la taille de la bande (plus large que la sortie) puis lue à la taille de la sortie, donc découpée de travers. Résultat : 210 fausses frames dupliquées sur le court. La taille décodée est maintenant celle du décodeur, avec un test de non-régression.

## Tests

```sh
pnpm check && pnpm typecheck && pnpm test
(cd workers && uv run ruff check . && uv run pytest)
```

**124 tests TypeScript et 21 tests Python verts.** Lint, format, typecheck et schémas sont à jour.

Tests propres à la phase (fixtures avec un vrai visage : portrait NASA du domaine public, composé par FFmpeg) :
- **reframe (12)** :
  - caméra immobile dans la zone morte, regard de côté ignoré ;
  - glissement centré sur le déplacement du sujet, épouse un déplacement lent, ralenti par la borne d'accélération (au-delà de `moveS`), avancé pour finir sur la coupe ;
  - même visage suivi quand un second apparaît ; pic d'accélération des courbes ;
  - passe complète 16:9 → 9:16 : clés dans le plan, géométrie (bande en pixels entiers, décalage qui ramène le centre du cadre au milieu), accélération sous la borne ;
  - validateur (clé hors plan ou hors source, recadrage linéaire).
- **color (7)** :
  - conversions sRGB, linéaire et CIELAB sur des valeurs de référence ;
  - épaulement continu, monotone, blanc atteint exactement ;
  - LUT cuite : identité, +1 EV qui double les gris en linéaire sans écrêter le blanc, look appliqué après les gains ;
  - seconde caméra (un diaph sous, bleue) ramenée à **ΔE < 0,5** de la référence, même correction pour tous ses plans ;
  - écart sous le seuil ignoré, plancher L\* 25, raccord isolé d'un plan dont la lumière change, look seul sans visage.
- **QA image (6, rendus réels)** :
  - le worker voit le visage à ≤ 1 % de la vérité terrain sur toute la durée, y compris en mouvement ;
  - recadrage suivi : **règle passée**, visage à 0,2 % du centre en médiane et 4 % au plus, pic d'accélération 2,3 px/frame². Les statistiques de source de la QA décodent la même image que le rendu ;
  - caméra fixe pendant que le sujet traverse : **refusée** (26 échantillons sur 39, visage absent ou décentré) ;
  - caméra à l'accélération excessive : **refusée** ;
  - deux caméras non étalonnées : **refusées** (ΔL\* 19,3, Δa\*b\* 15,4) ; après la passe `color` : **acceptées** (ΔL\* 0,9, Δa\*b\* 0,7).
- **Python (3)** : patch de peau robuste (un sous-titre posé dessus est ignoré), échantillon à l'instant juste sur le visage en mouvement.

## Score qualité

Mêmes rushes qu'aux phases précédentes (entretien Global Lives Project CC BY 3.0, musique CC0) et voix synthétique. Rendus en `--draft`.

| Rendu | Recadrage (médiane / max du décentrage) | Peau (L\*, ΔL\* max, Δa\*b\* max) | Étalonnage | Score | Couverture |
|---|---|---|---|---|---|
| Voix synthétique 16:9 | non applicable (16:9 → 16:9) | pas de visage : look seul | look `clean@1` | **100/100** | 86 % |
| Long 16:9, 180 s de rush | non applicable | L\* 24,2 ; 1,3 ; 4,0 sur 50 plans | +0,53 EV, 1 plan raccordé isolément | **99,8/100** | 92 % |
| Court 9:16, 60 s de rush | 3,4 % / 15,9 % sur 252 échantillons, visage toujours dans le cadre | L\* 24,3 ; 1,3 ; 3,3 sur 23 plans | +0,51 EV | **99,8/100** | 98 % |

- **La catégorie image passe entièrement** sur les trois rendus. La couverture du court atteint 98 % : seuls les J/L cuts restent non évalués (aucun n'est généré sur une caméra unique).
- **Raccord isolé** : sur le long, un plan de 0,5 s avait une peau moins saturée dès la source. La QA le refusait (Δa\*b\* 6,8). Raccordé isolément, l'écart maximal tombe à 4,0.
- **Vitesse** : 20 à 21 fps en 1080p sur 4 cœurs CPU, contre 22 en phase 5. La LUT cuite unique et l'étalonnage avant la mise à l'échelle ont limité le surcoût (14 fps avec des filtres séparés).
- **Seuls écarts restants**, hors image et déjà connus :
  - synchro de quelques mots mal alignés à la source (phase 4) ;
  - une répétition que Whisper n'avait pas écrite à l'analyse (phase 2).

### Ce qu'un monteur pro critiquerait encore

1. **Un très gros plan permanent en 9:16** : recadré dans un plan serré 16:9, le visage occupe 75 à 85 % de la largeur et le front est coupé. Un monteur alternerait avec un plan plus large (fond flouté, split-screen, B-roll) au lieu de rester 53 s collé au visage.
2. **Pas d'espace dans la direction du regard** : le visage est centré même quand l'interviewé regarde hors champ, vers la gauche. Un cadreur laisserait de l'air de ce côté. L'orientation de la tête est pourtant lisible dans les points du visage.
3. **Un contre-jour seulement relevé globalement** : +0,5 EV éclaircit le visage (L\* 19 → 24), mais il reste sombre devant une fenêtre brûlée. Un étalonneur relèverait le visage seul, avec un masque qui le suit (power window).
4. **Un look unique et générique** : `clean@1` reste neutre. Il n'y a ni look par ambiance (chaud, contrasté, désaturé), ni grain, ni vignettage.
5. **Des sous-titres posés sur la bouche** : le bloc est fixé à 66 % de la hauteur et tombe sur le menton dans ce cadre serré. La position du visage est connue et pourrait servir à le placer dessous.

## Limites connues

- **Mouvement de caméra validé sur fixture seulement** : sur l'entretien réel, le sujet reste dans la zone morte et la caméra ne bouge jamais. Le glissement n'est éprouvé que sur le visage synthétique en mouvement : décentrage maximal de 4 %, accélération de 2,3 px/frame².
- **Un seul sujet** : la caméra suit le plus grand visage, en continuité d'un échantillon à l'autre. Sans détection du locuteur actif, une interview à deux dans le même plan ne bascule pas d'un visage à l'autre.
- **Sans visage, pas de recadrage intelligent** : un plan sans visage (produit, paysage, dos) garde un cadre centré. Il n'y a pas de suivi du corps ni d'objet.
- **Indépendance partielle de la QA** : la détection est refaite sur le rendu, mais avec le même modèle (YuNet) que l'analyse. Une erreur systématique du détecteur passerait inaperçue.
- **Unités de la borne d'accélération** : `maxAccelPx` est exprimée en pixels de sortie par frame². Elle est donc plus stricte en physique à 60 fps ou en basse résolution.
- **Tolérance de peau** : la QA accepte Δa\*b\* ≤ 6. C'est plus large que l'exigence d'un étalonneur (ΔE 2 à 3), car la mesure sur le rendu varie déjà de 3 à 4 avec l'orientation de la tête dans une même prise. Un plan de moins de 0,6 s (moins de 3 échantillons) n'est pas raccordé isolément.
- **Plancher d'exposition** : L\* 25 est un compromis. Plus bas, un contre-jour reste sombre ; plus haut, on risquerait d'éclaircir une peau très foncée correctement exposée. Il n'a été mesuré que sur une carnation.
