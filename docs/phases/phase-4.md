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

Correctif : quand ce découpage laisse un mot trop court pour ses lettres (moins de 25 ms par lettre), l'hésitation et le mot sont réalignés ensemble sur leur intervalle commun. Cela concerne 3 cas sur le rush long, et le cache de transcription passe en version 6.

## Tests

TESTS_PLACEHOLDER

## Score qualité

SCORE_PLACEHOLDER

## Limites connues

LIMITS_PLACEHOLDER
