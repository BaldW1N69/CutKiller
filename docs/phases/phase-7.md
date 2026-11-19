# Phase 7 — QA consolidée : calibration, rapport, vérité terrain humaine

## Livré

### Calibration du quality-check (`cutkiller calibrate`)

Une règle ne vaut que si elle **attrape son défaut** (sensibilité), **laisse passer un montage propre** (spécificité) et **se tait sur les défauts des autres règles**. Le banc mesure ces trois points :

- **Base** : un talking head synthétique (`talking-head.mp4`, nouveau fixture). Le portrait NASA y bouge une fois sur le côté, sur la voix française de synthèse dont la vérité terrain au mot est connue, avec une musique.
  - Monté par le vrai pipeline en format court : jump-cuts, zoom-cuts, punch-ins animés (seuil d'emphase abaissé pour la voix de synthèse, qui est plate), transition et SFX, sous-titres karaoké, recadrage 9:16, étalonnage, mix.
  - Toutes les règles s'y appliquent, sauf les J/L cuts, testés à part.
- **Variantes** : 27 défauts, au moins un par règle, chacun défini **à partir du montage et jamais à partir du code des contrôles**. Exemples : pause coupée remise, « euh » réintroduit, coupe décalée du beat, punch-in à 125 %, ressort trop rebondissant, sous-titres en retard de 4 frames, fichier remonté de 8 dB, coupe en plein mot sans fondu, cadre figé loin du visage, un plan sur deux surexposé, frames noires ou figées insérées dans le fichier livré.
  - Chaque variante est **rendue puis contrôlée en entier** (25 règles).
  - Le verdict porte sur la règle visée. Les autres règles qui échouent sont classées en **conséquences réelles** (déclarées dans la variante : une pause remise rallonge aussi le plan) ou en **fausses alertes**.
- **Témoins** : le montage propre, une L-cut de 6 frames, un placement de sous-titres hors zone que le moteur doit ramener dans la zone sûre, et la synchro mesurée contre l'annotation.
- Sortie : `calibration.json` et `calibration.md`. Le tableau complet est reproduit plus bas.

### Rapport QA (format 1.0.0)

- **JSON versionné** avec son schéma (`schema/report-1.schema.json`, généré et vérifié en CI).
- Pour chaque règle :
  - le **seuil du profil** en clair (`-14 ±1 LUFS ; TP ≤ -1 dBTP`) ;
  - **ce que la mesure lit** :
    - `rendu` : mesure indépendante du fichier livré ou de ses stems ;
    - `rendu + EDL` ;
    - `EDL`, `presets + EDL` ou `journal de rendu` : vérification du plan que le moteur a exécuté avec le même code ;
  - les mesures ;
  - les écarts avec leur **timecode** (`00:03.05 (f95)`) ;
  - la **durée du contrôle**.
- Le Markdown ajoute un tableau par catégorie, une section **« Écarts à corriger »** qui liste tous les écarts avec leur timecode, et les règles non évaluées avec leur motif.

### Vérité terrain humaine (`annotate` + `check --truth`)

Pour la règle la plus difficile à mesurer, la synchro au mot, l'oracle peut devenir un humain :
1. `cutkiller annotate edit.edl.json -o labels.txt` exporte les mots surlignés à leurs instants, au format des pistes d'étiquettes Audacity.
2. Le monteur importe ces étiquettes sur l'audio du rendu. Il cale chacune sur le début réel du mot et ajoute une étiquette « euh » sur chaque hésitation entendue.
3. `check --truth labels.txt` mesure alors `captions.sync` (p95 / max) et `montage.fillers` **contre l'annotation**, au lieu de l'aligneur et de la retranscription.

### Corrigé grâce à la calibration

La calibration a révélé **trois faiblesses de la QA** (corrigées), un coût de calcul (réduit de moitié) et un constat sur l'encodeur :

1. **Fausses frames dupliquées sur une source sans mouvement.** Sur un plan où seul le grain change (photo fixe, trépied), l'encodeur à 16–20 Mbps lisse le grain et livre des images quasi identiques, alors que la source, elle, « bouge ».
   - La règle compare désormais le **mouvement de la source** mesuré après un débruitage fort (`hqdn3d`, au quart de la taille). Le grain d'une photo fixe y vaut au plus 0,17, contre 0,38 à 0,63 en médiane pour un vrai mouvement (rushes réels).
   - Une image figée n'est donc comptée que si la source bouge réellement (seuil 0,25).
2. **Gel pendant une animation invisible pour la QA.** La règle ne regardait que la source : un gel pendant un punch-in, un mouvement de caméra ou une transition passait si la source était fixe.
   - Sur les frames où le rendu lui-même bouge d'au moins 2 px/frame, mesuré d'une frame à la suivante sur la timeline d'animation partagée, un écart ≤ 0,05 compte comme une image figée.
   - Un vrai gel réencodé mesure ≤ 0,007, alors qu'un petit changement légitime (mot court qui apparaît, transition sur fond uni) mesure 0,17 à 0,30.
   - La fin d'un rebond de sous-titre, sous le pixel, n'est pas comptée : c'était une fausse alerte sur le rush réel.
3. **Doubles comptages** : des frames noires étaient aussi comptées comme frames dupliquées et comme « visage absent ». Elles relèvent désormais de la seule règle `image.black-frames`.
4. **Coût du décodage de la QA** :
   - `streamFrames` recollait le tampon à chaque bloc de 64 Ko, soit une copie quadratique de chaque frame ;
   - un seul passage calcule désormais l'écart et la luminance moyenne ;
   - la mesure de mouvement n'est calculée que si nécessaire, et les plans sont décodés par 4.
   - Résultat sur le rendu long (4 565 frames 1080p) : décodage du rendu 111 → 44 s, contrôle des doublons 249 → 122 s.
5. **Encodeur en CBR strict** (constat, non modifié). Juste après chaque image clé, les images suivantes sont affamées (`nal-hrd=cbr`) : sur un contenu très granuleux, le grain se fige environ 0,4 s.
   - L'ABR n'élimine que la moitié de ces gels.
   - Préserver ce grain demanderait environ 43 Mbps.
   - Voir les limites connues.

Le banc lui-même a aussi été corrigé :
- une coupe « en plein mot » tombait dans l'occlusion silencieuse du « d » d'« aujourd'hui » : elle est maintenant placée sur l'échantillon le plus fort du mot ;
- les SFX synchronisés ne suivaient pas leur événement lors d'un décalage de la timeline ;
- le placement des sous-titres à 92 % était **neutralisé par le moteur**, qui ramène le bloc dans la zone sûre : c'est devenu un témoin, et le vrai défaut retouche aussi la zone sûre de l'EDL.

## Tests

```sh
pnpm check && pnpm typecheck && pnpm test
(cd workers && uv run ruff check . && uv run pytest)
pnpm cutkiller calibrate -o out/calibration   # ≈ 45 min, hors CI
```

**132 tests TypeScript (+8) et 21 tests Python verts.** Lint, format, typecheck et schémas (dont le nouveau `report-1.schema.json`) sont à jour.

Tests propres à la phase :
- **rapport** :
  - un rapport construit suit son schéma JSON ;
  - timecodes (30 et 60 fps) ;
  - un seuil non vide pour chacune des 25 règles, lu dans le profil ;
  - sections Markdown « Écarts à corriger » et « Non évaluées ».
- **annotation** (4 tests) :
  - lecture et écriture des étiquettes Audacity (virgule décimale, lignes spectrales, commentaires) ;
  - export des mots surlignés ;
  - synchro conforme à 0,5 frame, puis refusée à 4,5 frames de retard ;
  - mot non annoté signalé sans compter comme erreur ;
  - « euh » annoté compté comme hésitation restée.
- **frames figées** (rendu réel, image fixe + punch-in animé) : l'image fixe qui se répète est acceptée, un gel de 4 frames pendant le zoom est refusé.
- **banc de calibration** :
  - chacune des 25 règles est visée par au moins un défaut ;
  - le décalage de timeline déplace plans, recadrage, transitions, animations, ducking, sous-titres et SFX synchronisés de façon cohérente (EDL toujours valide).

## Calibration

Campagne finale (`out/calibration/calibration.md`), sur le code livré :

- **27 défauts sur 27 détectés : les 25 règles attrapent leur défaut.**
- **5 témoins sur 5 acceptés** : montage propre (100/100), L-cut de 6 frames, placement hors zone ramené par le moteur, gel d'image sur un plan sans mouvement, synchro contre l'annotation.
- **0 fausse alerte.** 6 défauts font aussi échouer une autre règle, et c'est chaque fois une conséquence réelle du défaut. Exemples :
  - remettre une pause rallonge le plan et réintroduit le « euh » qui la suivait ;
  - déplacer une coupe la décale du beat ;
  - une animation allongée ne suit plus son preset.
- **Synchro contre l'annotation** : la vérité terrain de la voix, prise comme annotation humaine, donne un p95 de 0,68 frame et un max de 0,74 frame, sur les 21 mots reconnus parmi 26.
  - L'aligneur de la QA donne 0,55 frame au p95 : ses mesures sont cohérentes avec la vérité terrain.
  - Un retard de 4 frames est vu par les deux.

| Variante | Règle visée | Défaut injecté | Résultat | Mesure de la règle | Autres règles en échec | Score |
|---|---|---|---|---|---|---|
| `control` | toutes | montage propre, sans défaut injecté | ✅ accepté |  | — | 100 |
| `silences` | Silences > 350 ms supprimés, marges 80–120 ms | un silence coupé par le montage est remis dans la timeline | ✅ détecté | silence de 832 ms ; silence de 416 ms | _montage.fillers_ (« Euh, » (filler)) ; _montage.static-shots_ (plan statique de 4.6 s) ; _image.reframe_ (visage coupé par le cadre (94 % dans l'image) (2 échantillons)) | 98.3 |
| `fillers` | Hésitations et respirations fortes supprimées | une hésitation coupée (« euh ») est remise, entre deux pauses courtes | ✅ détecté | « euh, » (filler) | _montage.silences_ (marge après « Aujourd'hui, » de 333 ms) ; _montage.beat-cuts_ (coupe à 7.0 frame(s) du beat le plus proche) | 96.4 |
| `beat-cuts` | Coupes libres calées sur les beats (±1 frame) | une coupe posée sur un beat est retardée de 3 frames (pause plus longue) | ✅ détecté | coupe à 3.0 frame(s) du beat le plus proche ; coupe à 1.0 frame(s) du beat le plus proche | _montage.silences_ (marge après « Aujourd'hui, » de 200 ms) | 96.5 |
| `jl-ok` | J/L cuts de 4 à 12 frames | témoin : L-cut de 6 frames (dans la plage 4–12) | ✅ accepté | pass | _montage.silences_ (marge après « silence » de 289 ms) | 99.2 |
| `jl-short` | J/L cuts de 4 à 12 frames | L-cut de 2 frames (sous la plage 4–12) | ✅ détecté | c001-005 : décalage de 2 frames (attendu 4–12) | _montage.silences_ (marge après « silence » de 156 ms) | 97.2 |
| `static-shots` | Aucun plan statique trop long | les premiers plans gardent le même cadrage, sans animation, au-delà de la limite | ✅ détecté | plan statique de 6.4 s | — | 99.1 |
| `punch-ins` | Punch-ins 105–115 %, jamais deux fois au même niveau | un zoom-cut resserré à 125 % | ✅ détecté | c001-002 : punch-in à 125 % | — | 99.3 |
| `no-linear` | Aucune interpolation linéaire (position, échelle, opacité) | un punch-in animé passe en interpolation linéaire | ✅ détecté | motion.linear : interpolation linéaire interdite sur « scale » (clé 1) : utiliser un easing ou un spring | — | — |
| `durations` | Micro-animations 150–300 ms, transitions 200–500 ms | un punch-in animé dure 600 ms au lieu de 200 | ✅ détecté | c001-001.scale : 600 ms | _motion.presets_ (c001-001.scale : ne suit plus zoom-punch@1.0.0) | 98.6 |
| `blur` | Motion blur au-delà du seuil de vitesse | rendu sans flou de mouvement (seuil du moteur porté à 2 000 px/frame) | ✅ détecté | 39 px/frame sans flou ; 23 px/frame sans flou | — | 95.9 |
| `overshoot` | Overshoot des pop-ins entre 3 et 8 % | le ressort d'un punch-in rebondit de 16 % (amortissement 36 au lieu de 50) | ✅ détecté | c001-001.scale : dépassement de 16.5 % (attendu 0 ou 3.0 %–8.0 %) | — | 99.4 |
| `presets` | Presets nommés, versionnés et conformes | la bibliothèque reçoit un preset non conforme (zoom-punch@1.1.0 de 600 ms) | ✅ détecté | zoom-punch@1.1.0 : 600 ms (attendu 150–300 ms) | — | 99.7 |
| `captions-sync` | Sous-titres synchronisés au mot | tous les sous-titres arrivent 4 frames en retard | ✅ détecté | « BONJOUR » surligné en retard de 4.0 frame(s) ; « À » surligné en retard de 4.2 frame(s) | — | 92.8 |
| `captions-density` | Mots par écran / lignes / caractères | deux écrans fusionnés : plus de 3 mots à l'écran en format court | ✅ détecté | k001 : 4 mots à l'écran ; k001 : ligne de 26 caractères | — | 99.2 |
| `safe-zones-clamped` | Safe zones des plateformes respectées | témoin : placement demandé à 92 % de la hauteur, que le moteur ramène dans la zone sûre | ✅ accepté | pass | — | 100 |
| `safe-zones` | Safe zones des plateformes respectées | zone sûre de l'EDL retouchée (marge basse 2 %) et sous-titres à 92 % : sous l'interface des plateformes | ✅ détecté | k001 déborde : 387 px en bas ; k002 déborde : 387 px en bas | — | 94.8 |
| `contrast` | Contraste WCAG ≥ 4,5:1 | style de sous-titres gris clair à contour blanc | ✅ détecté | karaoke-pop@1.0.0 : texte/contour 1.88:1 ; karaoke-pop@1.0.0 : mot actif/contour 1.43:1 | — | 96 |
| `loudness` | -14 LUFS ±1, true peak ≤ -1 dBTP | fichier livré remonté de 8 dB (−6 LUFS, crêtes écrêtées) | ✅ détecté | -8.9 LUFS (cible -14 ±1) ; true peak 6.4 dBTP (max -1) | — | 92.8 |
| `ducking` | Ducking de la musique -12 à -18 dB, sans pompage | musique baissée de 4 dB seulement sous la voix | ✅ détecté | musique à -4.0 dB sous la parole (attendu -18–-12 dB) ; musique à -4.0 dB sous la parole (attendu -18–-12 dB) | — | 96.1 |
| `sfx-sync` | SFX synchronisés (±1 frame) | un effet sonore décalé de 3 frames après son événement | ✅ détecté | fx001 (punch-tick@1.0.0) : impact à +3.1 frame(s) de keyframes:c001-001.scale | — | 98.9 |
| `cut-fades` | Aucun clic aux coupes (fondus 5–10 ms) | fondus de coupe à 0 ms dans l'EDL | ✅ détecté | fondus de coupe de 0 ms (attendu 5–10 ms) | — | 99.6 |
| `cut-click` | Aucun clic aux coupes (fondus 5–10 ms) | une coupe au milieu d'un mot, sans fondu : clic audible | ✅ détecté | fondus de coupe de 0 ms (attendu 5–10 ms) ; clic (saut 0.202 vs 0.032) | _montage.silences_ (marge après « Aujourd'hui, » de -367 ms) ; _montage.beat-cuts_ (coupe à 1.0 frame(s) du beat le plus proche) | 97.3 |
| `reframe` | Recadrage 9:16 qui suit le sujet sans saccade | le cadre 9:16 reste figé sur le bord gauche du rush, loin du visage | ✅ détecté | visage du rush absent du cadre (2 échantillons) ; visage du rush absent du cadre (2 échantillons) | — | 94.4 |
| `color` | Étalonnage cohérent entre plans | un plan sur deux surexposé de 1,2 EV | ✅ détecté | peau de « c001-001 » loin de la référence : ΔL* 10.3, Δa*b* 0.9 ; peau de « c001-003 » loin de la référence : ΔL* 10.1, Δa*b* 0.3 | — | 97.4 |
| `export-format` | H.264/H.265, 30 ou 60 fps constants, bonne résolution | fichier livré réencodé en MPEG-4 Part 2 au lieu de H.264 | ✅ détecté | codec mpeg4 (attendu H.264/H.265) | — | 96.9 |
| `bitrate` | Débit vidéo au-dessus du minimum | export à 4 Mbps | ✅ détecté | 4.12 Mbps < 16 Mbps | — | 97.9 |
| `black-frames` | Aucune frame noire non prévue | 5 frames noires insérées au milieu d'un plan | ✅ détecté | 5 frame(s) noire(s) | — | 99.9 |
| `freeze-static` | Aucune frame dupliquée non prévue | témoin : 6 frames figées sur un plan où rien ne bouge (photo fixe, seul le grain change) : invisible | ✅ accepté | pass | — | 100 |
| `freeze-animated` | Aucune frame dupliquée non prévue | 5 frames figées pendant un punch-in animé | ✅ détecté | 5 frame(s) dupliquée(s) | — | 99.9 |
| `annotation-ok` | Sous-titres synchronisés au mot | témoin : synchro mesurée contre une annotation au mot (la vérité terrain de la voix) | ✅ accepté | p95 0.68 / max 0.74 frame(s) sur 21 mots | — | — |
| `annotation-late` | Sous-titres synchronisés au mot | sous-titres 4 frames en retard, mesurés contre l'annotation | ✅ détecté | « BONJOUR » surligné en retard de 3.8 frame(s) (annotation) ; « À » surligné en retard de 3.9 frame(s) (annotation) | — | — |

## Score qualité

| Rendu | Score | Couverture | Écarts restants | Durée du contrôle |
|---|---|---|---|---|
| Voix synthétique 16:9 | **100/100** | 86 % (pas de visage, de recadrage, d'animation ni de J/L) | — | 36 s (50 s avant) |
| Long 16:9, 180 s de rush | **99,8/100** | 92 % | synchro : 10 mots sur 406 au-delà de 3 frames, jusqu'à 20 (p95 0,9 frame) | 282 s (387 s avant) |
| Court 9:16, 60 s de rush | **99,8/100** | 98 % | synchro : 2 mots sur 130 (« LÀ ») à 3,6–3,8 frames (p95 1 frame) ; une répétition « j'ai… j'ai atteint » non retirée | 108 s (148 s avant) |

- Les écarts restants sont ceux des phases 2 et 4 : mots mal alignés à la source, répétition non transcrite par Whisper. La calibration montre que la QA ne les invente pas : elle détecte un retard de 4 frames et laisse passer une synchro exacte.
- Seule l'annotation humaine (`annotate` + `check --truth`) dira lequel, de l'aligneur ou du sous-titre, se trompe sur ces mots.
- Les rendus de la phase 6 n'ont pas bougé. Le court ne signale plus de fausse frame figée en fin de rebond de sous-titre : c'était l'une des fausses alertes trouvées pendant cette phase.

### Ce qu'un monteur pro critiquerait encore

1. **Une QA qui vérifie des règles, pas le goût** : 100/100 ne dit rien du rythme global, de l'arc narratif, du choix des meilleures prises ni de la pertinence des punch-ins. Le test A/B à l'aveugle reste à faire.
2. **Des seuils durs** : une coupe à 1,1 frame d'un beat est un échec, une à 0,9 frame une réussite. Un monteur raisonne en tolérance perçue ; une note graduée par la marge au seuil serait plus juste.
3. **Une calibration sur un seul cas** : un talking head synthétique en format court. Il manque une base 16:9 longue, une base multicam (J/L cuts, raccords d'étalonnage entre caméras) et une base B-roll.
4. **Les règles « EDL » font confiance au moteur** : 11 règles sur 25 relisent le plan exécuté. Pour la densité des sous-titres et les punch-ins, une mesure sur l'image (OCR, recalage d'échelle) rendrait la QA indépendante.
5. **Le rapport liste des écarts, sans dire comment les corriger** : un monteur voudrait « retimer ce mot », « recouper ici » en un clic, ce qui demanderait de relier les écarts aux champs de l'EDL.

## Limites connues

- **Calibration sur synthétique** : la base est un talking head synthétique, sur une seule carnation et une voix de synthèse. Les défauts y sont francs.
  - Les défauts subtils et ambigus d'un vrai montage (une hésitation à moitié coupée, une respiration, un recadrage « un peu serré ») ne sont pas calibrés.
  - Un défaut détecté sur le banc ne garantit pas la même sensibilité sur un rush réel.
- **Vérité terrain humaine non collectée** : l'outillage existe (`annotate`, `check --truth`), mais personne n'a encore annoté les rushes réels.
  - Les écarts de synchro restants sur le long et le court (10 mots sur 406 au-delà de 3 frames sur le long, jusqu'à 20 ; 2 sur 130 sur le court) ne peuvent donc pas être départagés entre une erreur de l'aligneur et une vraie erreur de sous-titre.
  - Il faut 10 à 15 min d'annotation par minute de rendu.
- **Test A/B à l'aveugle** (proposé à l'audit, non bloquant) **non réalisé** : il faut des spectateurs et un montage humain de référence des mêmes rushes.
  - Protocole prêt :
    - 3 spectateurs ou plus ;
    - paires aléatoires CutKiller / humain, sur des extraits de 20 à 30 s ;
    - deux questions : « lequel est monté par un pro ? » et une note de 1 à 5 ;
    - objectif : une identification à ≤ 60 %, proche du hasard.
  - C'est le seul indicateur de la promesse « indiscernable d'un monteur humain » ; les 25 règles sont nécessaires mais pas suffisantes.
- **Mesures qui ne lisent pas le fichier** : 11 règles sur 25 vérifient le plan (EDL, presets, journal de rendu) que le moteur exécute avec le même code. Le rapport l'indique pour chaque règle (« Mesuré sur »).
  - Un bug commun au moteur et à la QA y passerait inaperçu.
  - Le banc le réduit, car il compare un rendu réel à un défaut connu, mais ne l'élimine pas.
- **Effets de bord déclarés après observation** : les conséquences attendues de chaque défaut ont été déclarées après une première campagne, en vérifiant au cas par cas qu'elles sont réelles (exemple : une pause remise rallonge aussi le plan).
- **J/L cuts sur un monologue** : sur un jump-cut à un seul locuteur, toute J/L ≥ 4 frames déborde des marges de 80 à 120 ms, et la règle des silences le signale. C'est pourquoi le planificateur n'en pose pas sur une caméra unique. La règle n'est évaluée que sur un montage multicam ou avec B-roll.
- **Encodeur en CBR strict** : sur un rush très granuleux, le grain se fige environ 0,4 s après chaque image clé à 16–20 Mbps. Pour un contenu de ce type, mieux vaut monter le débit (`output.video.bitrateMbps`).
- **Durée** : une campagne de calibration prend 45 min, hors CI. Le contrôle QA d'un rendu de 2 min 30 prend environ 6 min sur 4 cœurs, dont 2 pour les frames dupliquées et 3 pour la retranscription et l'alignement.
