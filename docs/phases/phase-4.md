# Phase 4 — Sous-titres

## Livré

### EDL 1.2

- **`captions[]`** : un sous-titre par écran, avec son style (preset `captions/`), ses frames et ses mots.
  - Chaque mot porte son attaque sur la timeline (`fromFrame`), sa ligne et une référence au transcript (`source`, `wordId`).
  - Le mot passe à la couleur active à son attaque et la garde jusqu'au mot suivant (karaoké).
- **`output.captions`** : zone sûre et placement, remplis depuis le profil et modifiables dans l'EDL. L'EDL suffit donc au rendu.
- **Validateur** : refuse les sous-titres qui se chevauchent, les mots hors de leur sous-titre ou dans le désordre, et les lignes incohérentes.

### Profils et presets

- **Profil `short`** :
  - écrans de 1 à 3 mots sur une ligne de 16 caractères, coupés à chaque pause de 250 ms et à chaque virgule ;
  - bloc centré à 66 % de la hauteur.
  - Zones sûres TikTok, Reels et Shorts versionnées dans le profil : la QA prend leur intersection (marges de 14 % en haut, 25 % en bas, 5,6 % à gauche, 18,6 % à droite).
- **Profil `long`** :
  - 2 lignes de 32 caractères au plus ;
  - nouvel écran après un point, après une pause de 500 ms ou après une virgule une fois l'écran rempli à 40 %.
  - Zone de titrage à 5 % des bords (title-safe).
- **Styles** :
  - `karaoke-pop@1` : Poppins ExtraBold en capitales, sans ponctuation, contour noir épais, mot actif jaune, entrée en pop (ressort de 200 ms) ;
  - `subtitle-clean@1` : Poppins SemiBold, ponctuation conservée, entrée en fondu de 160 ms.
  - Les deux entrées sont des presets `motion/` versionnés, qui suivent donc les règles de motion de la phase 3.
- **Police** : Poppins sous licence OFL, commitée avec sa licence dans `assets/fonts/`.

### Passe `captions`

- **Mots sur la timeline** : uniquement les mots conservés par le montage (`why.wordIds` des clips), convertis du temps source en frames. Un mot à cheval sur un zoom-cut n'apparaît qu'une fois.
- **Découpage** : un écran se ferme à une pause, une ponctuation forte, ou quand le mot suivant ne tient plus (mots, lignes, caractères, durée).
- **Mots-outils** : un écran ne finit jamais sur un mot-outil (« de », « je », « la »…) s'il peut le passer au suivant. Une ligne non plus : plutôt que « …aujourd'hui, je / vais vous montrer », l'écran se termine après « aujourd'hui, ».
- **Coupure des lignes** : la plus équilibrée, la ligne du bas pouvant être la plus longue, comme en sous-titrage.
- **Tenue** : un écran reste affiché jusqu'au suivant. Sans suite, il reste 250 ms (court) ou 500 ms (long) après le dernier mot. Les trous de moins de 250 ms sont refermés.
- **Export** : `render` écrit aussi `final.srt`, avec les mêmes écrans.

### Rendu

- **Mise en page partagée par le rendu et la QA** :
  - lignes centrées ;
  - police réduite si une ligne déborde ;
  - bloc ramené dans la zone sûre, **rebond de l'animation d'entrée compris**.
- **Rastérisation** : le sous-titre est rendu une fois par mot actif, car l'ombre floue est coûteuse avec Cairo.
- **Flou de mouvement** : l'entrée en pop est floutée au-delà de 12 px/frame, comme le reste. Quand seul le sous-titre bouge, seule sa zone est moyennée, ce qui évite de redessiner l'image entière.
- **Glitch** : les sous-titres passent au-dessus de l'image glitchée et ne sont pas déformés.

### QA (4 règles, 20 points)

- **`captions.sync`** : le texte des sous-titres est aligné de force (wav2vec2) sur le dialogue rendu. L'écart entre l'attaque mesurée et `fromFrame` doit être ≤ 1 frame au p95 et ≤ 3 frames au maximum. Chaque mot du montage doit apparaître dans les sous-titres.
  - Les frontières sont affinées avec le **plancher de bruit du rush** : le rendu, privé de ses pauses, a un plancher bien plus haut qui resserrerait artificiellement les mots.
  - Un mot que l'aligneur ne place pas avec confiance sur le rendu (score < 0,2) est compté à part comme « non mesurable ».
- **`captions.density`** : 1 à 3 mots par écran en court ; en long, au plus 2 lignes de 32 caractères.
- **`captions.safe-zones`** : chaque bloc, au plus grand rebond de son entrée, doit rester dans l'intersection des zones **du profil**. Une EDL retouchée qui sort de la zone est signalée.
- **`captions.contrast`** : deux vérifications.
  - Couleurs du style : texte et mot actif contre le contour, ratio WCAG ≥ 4,5:1, et contour assez épais pour isoler le texte du fond.
  - **Pixels encodés** : sur 12 écrans du rendu, des masques recalculés séparent lettres et contour, puis le contraste est mesuré entre leurs couleurs moyennes.

### Corrigé en amont (analyse, phase 2)

La règle de synchro a révélé un **mot manquant dans le montage**. Dans « il n'y a plus euh, d'autres étapes », la seconde passe de détection des « euh » avait étiré l'hésitation sur 0,69 s, et il ne restait que 20 ms au mot « d'autres ». Le montage le coupait.

Correctif : quand ce découpage laisse un mot trop court pour ses lettres (moins de 25 ms par lettre), l'hésitation et le mot sont réalignés ensemble sur leur intervalle commun. Cela concerne 3 cas sur le rush long.

Autres corrections révélées pendant la boucle :
- **Nombres** : « 14 », « 207 » ou « 12h15 » n'ont aucune lettre pour le modèle CTC, si bien que le son « quatorze » était absorbé par les mots voisins. Ils sont maintenant écrits en toutes lettres avant l'alignement (« douze heures quinze »). Le cache de transcription passe en version 7.
- **Coupes sur les beats** : la QA estimait la plage atteignable autour de la coupe, le planificateur à partir du début du passage. Les deux calculent maintenant la même plage, en frames entières. Ce désaccord faisait signaler à tort une coupe à 1,2 frame du beat.
- **Fin de rush** : un passage arrondi en frames entières pouvait dépasser de 12 ms la fin de la source, et l'EDL était refusée.
- **Frames dupliquées** : sous un punch-in animé, la source est maintenant comparée sur le centre effectivement montré. Sinon, le mouvement des bords masquait une image répétée et la QA signalait une fausse frame dupliquée.
- **Essai abandonné** : réaligner seuls, entre voisins fiables, les mots alignés avec peu de confiance. Mesuré sur les rushes réels, cela **dégradait** la synchro (long : 13 mots au-delà de 3 frames au lieu de 7). L'essai a été annulé.

## Tests

```sh
pnpm check && pnpm typecheck && pnpm test
(cd workers && uv run ruff check . && uv run pytest)
```

**89 tests TypeScript et 18 tests Python verts** (dont les tests de précision au mot qui chargent les modèles). Lint, format, typecheck et schémas à jour.

Tests propres à la phase :
- **captions (13 tests)** :
  - mots sur la timeline (zoom-cut, jump cut) ;
  - découpage court (1 à 3 mots, virgules, mots-outils) et long (2 lignes de 32 caractères, coupure équilibrée, nouvel écran plutôt qu'un « je » en fin de ligne, tenue, absence de chevauchement) ;
  - casse et ponctuation selon le style ;
  - safe zone avec le rebond, et police réduite pour un mot trop long ;
  - mot actif, entrée et vitesse ;
  - dessin au pixel (blanc, jaune, contour, fond intact) ;
  - SRT et validateur.
- **QA (5 tests)** :
  - densité ;
  - safe zones contre le profil quand l'EDL a été retouchée ;
  - ratio WCAG de référence ;
  - **contraste mesuré sur un rendu encodé** : bon style > 8:1, style gris refusé à la fois sur le style et sur les pixels ;
  - logique de synchro : p95/max, mots non mesurables, mot oublié.
- **Rendu** : un sous-titre posé sur un glitch garde ses pixels jaunes (même nombre à ±15 % qu'après le glitch).
- **Bout en bout sur la voix synthétique** : les 4 règles sous-titres passent, un SRT est écrit, et chaque surlignage est à ≤ 1 frame (p95) et ≤ 3 frames (max) du **début réel** du mot dans la vérité terrain.
- **Python** : nombres en toutes lettres, mot découpé invraisemblable.

## Score qualité

Mêmes rushes qu'aux phases 2 et 3 (entretien Global Lives Project CC BY 3.0, musique CC0) et voix synthétique avec vérité terrain. Rendus en `--draft`.

| Rendu | Sous-titres | Synchro (p95 / max, en frames) | Score | Couverture |
|---|---|---|---|---|
| Voix synthétique 16:9 | 6 écrans, 26 mots | 0,55 / 0,55 (aligneur) ; **0,68 / 0,74 contre la vérité terrain** | **100/100** | 65 % |
| Long 16:9, 180 s de rush | 63 écrans, 457 mots | 0,80 / 16,2 ; 405 mots mesurés, 52 non mesurables | **99,8/100** | 71 % |
| Court 9:16, 60 s de rush | 71 écrans, 146 mots | 0,85 / 3,8 ; 129 mesurés, 17 non mesurables | **99,7/100** | 71 % |

Sur les rushes réels, les quatre règles sous-titres passent toutes, sauf le maximum de synchro.
- Densité, safe zones et contraste : 100 %. Contraste mesuré le plus faible : 15,6:1.
- Synchro : le p95 tient dans 1 frame partout, mais **6 mots sur 405 (long) et 2 sur 129 (court) dépassent 3 frames**. La règle est donc en échec, avec un score de 98,6 %.
- Ce sont des mots que l'alignement du **rush** place mal : mots courts (« à », « là ») et passages où Whisper a mal transcrit, comme « 207 » ou « il n'y a ». Le sous-titre suit fidèlement cet alignement.

Couverture : 71 % (+20 points avec les sous-titres). Il reste l'audio (phase 5) et l'image (phase 6). Le rendu brouillon tourne à 23–24 fps en 1080×1920 sur 4 cœurs CPU, comme avant les sous-titres grâce au cache et au flou limité à la zone.

### Ce qu'un monteur pro critiquerait encore

1. **Rythme haché en court** : 71 écrans pour 53 s, dont des écrans d'un seul mot (« MAIS ») qui clignotent. Un monteur regrouperait davantage aux pauses brèves et réserverait l'écran d'un mot aux chutes.
2. **Aucune hiérarchie visuelle** : tous les mots ont la même taille, seul le mot prononcé change de couleur. Les styles « pro » grossissent ou colorent les mots-clés (l'emphase de la phase 3 pourrait les désigner).
3. **Les fautes d'ASR passent à l'écran**, par exemple « CLASSE A ÉTOILE ». Sans script fourni (alignement script → transcript prévu) ni relecture, une coquille par minute environ reste visible.
4. **Le placement ignore le visage** : en 9:16 le bloc est centré sur l'image, alors que le visage est coupé à droite par le recadrage centré (phase 6). En 16:9, rien n'empêche un sous-titre de couvrir un élément important au bas de l'image.
5. **Pas de sortie animée** : un écran disparaît d'un coup au suivant, ce qui est correct en sous-titrage classique mais un peu sec en format court.

## Limites connues

- **Synchro au maximum de 3 frames** : non atteinte sur environ 1,5 % des mots réels, quand l'alignement du rush est faible.
  - La QA mesure avec le même aligneur (wav2vec2) que l'analyse, sur un autre contexte audio. Les deux mesures ne sont donc pas indépendantes, et un biais commun aux deux échapperait au contrôle. La seule mesure absolue est la vérité terrain de la voix synthétique : 0,74 frame au maximum.
  - Environ 11 % des mots réels (« non mesurables ») ne sont pas évalués, faute d'alignement sûr sur le rendu.
- **Variance de Whisper** : d'une analyse à l'autre, le premier passage peut écrire ou non une répétition (« je peux plus, je peux plus »). Le faux départ est alors coupé ou laissé, et `montage.fillers` le signale. Ce point relève de la phase 2, il n'est pas causé par les sous-titres.
- **Zones sûres des plateformes** : les valeurs sont des relevés publics de 2026, prudents mais non officiels. Elles sont versionnées dans le profil pour pouvoir être mises à jour.
- **Polices** : seule Poppins (OFL) est fournie. Pour un autre style, il faut ajouter le fichier de police et un preset.
- **SRT seulement** : pas d'export ASS/VTT, ni d'import de sous-titres existants.
- **Pas de test au pixel pour la correction des frames dupliquées** sous un punch-in : la mire de test bouge sur toute l'image. Le correctif est vérifié sur le rendu court réel (1 fausse alerte avant, 0 après).
