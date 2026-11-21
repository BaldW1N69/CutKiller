# Phase 5 — Audio

## Livré

### EDL 1.3

- **Clips audio** :
  - une `source` (musique) ou un `asset` (effet synthétisé, preset `sfx/`) ;
  - `duck[]` : zones de ducking avec profondeur et rampes d'attaque et de relâchement ;
  - `syncTo` : l'événement visuel sur lequel tombe un effet (`transition:<id>`, `keyframes:<cible>`).
- **`output.audio`** : loudness cible, plafond de true peak, niveau de la musique sous la voix, compression de la voix. Ces valeurs sont remplies depuis le profil et l'EDL reste suffisante pour le rendu.
- **Validateur** : refuse un clip sans source ni asset (ou avec les deux) et une zone de ducking à l'envers.

### Passe `audio`

- **Ducking** : la parole du montage (les mots conservés, sur la timeline) devient des zones de ducking.
  - La musique descend de 15 dB par une rampe en cosinus surélevé qui s'achève **au premier mot**, et remonte après une tenue de 120 à 200 ms.
  - Les pauses plus courtes que 600 ms (court) ou 900 ms (long) sont fusionnées, ce qui évite de faire monter et descendre la musique entre deux phrases (pompage).
- **Effets sonores** :
  - un whoosh sur chaque whip-pan ou slide, des rafales sur chaque glitch-cut et un impact sourd sur chaque punch-in (court uniquement) ;
  - l'**impact** du son, son instant le plus fort, tombe exactement sur la coupe ou le début du punch-in ;
  - les effets qui se chevauchent passent sur une seconde piste.

### Effets sonores procéduraux (`presets/sfx/`)

Quatre sons sont **synthétisés au rendu** : `whoosh`, `whoosh-soft`, `glitch-burst` et `punch-tick`. Ce sont du bruit filtré dont la fréquence balaie la bande, des rafales réduites à 4 bits et un sinus qui glisse vers le grave avec un clic.
- Le dépôt ne contient aucun fichier audio, et un preset donne toujours exactement les mêmes échantillons.
- Chaque son a 50 ms de silence en tête : l'alignement à la frame n'en rogne jamais l'attaque.
- Chaque son finit par un fondu de 10 ms, donc jamais sur un clic.

### Mix (rendu)

1. FFmpeg rend trois stems sur la timeline : la voix (piste principale avec ses coupes), la musique et les effets.
2. **Compression de la voix** (3:1, seuil à 4 LU au-dessus de sa loudness mesurée) : quel que soit le niveau d'enregistrement, le limiteur final n'a plus que des pointes isolées à rattraper.
3. **Niveau de la musique** : la voix et la musique sont mesurées (EBU R128), puis la musique est placée 5 LU (court) ou 7 LU (long) sous la voix.
4. L'**enveloppe de ducking** est appliquée échantillon par échantillon, puis la voix, la musique et les effets sont additionnés.
5. **Loudness** :
   - gain vers -14 LUFS, puis limiteur à anticipation (latence compensée, sans décalage) ;
   - nouvelle mesure, puis correction, jusqu'à ±0,2 LU et un true peak ≤ -1,5 dBTP ;
   - la marge de 0,5 dB sous la limite de livraison (-1 dBTP) est laissée pour l'encodeur AAC.
6. `--keep-stems` écrit `voice`, `music`, `music-dry` (sans ducking) et `sfx`. Le journal de rendu détaille chaque étape : niveaux mesurés, gain, plafond du limiteur, loudness retirée par le limiteur, nombre de passes.

### QA (3 nouvelles règles, toutes les règles audio évaluées)

- **`audio.loudness`** : loudness intégrée et true peak mesurés sur le **fichier livré**, après l'encodage AAC.
- **`audio.ducking`** :
  - la parole est détectée par une VAD indépendante sur le stem voix ;
  - sous chaque passage parlé, la musique rendue doit être 12 à 18 dB sous la même musique sans ducking ;
  - le gain ne doit jamais varier de plus de 4 dB en 10 ms (pas de marche) ;
  - la musique ne doit jamais remonter moins de 300 ms entre deux baisses (pompage).
- **`audio.sfx-sync`** : l'instant le plus fort de chaque effet, mesuré sur le stem des effets, doit tomber à ±1 frame de son événement visuel. La règle recalcule cet événement depuis l'EDL, sans se fier à la position du clip.

## Tests

```sh
pnpm check && pnpm typecheck && pnpm test
(cd workers && uv run ruff check . && uv run pytest)
```

**99 tests TypeScript et 18 tests Python verts.** Lint, format, typecheck et schémas sont à jour.

Tests propres à la phase :
- **audio** :
  - chaque preset est déterministe, son impact mesuré tombe à moins de 5 ms de l'impact annoncé, avec préroll silencieux, fin à zéro et crête à -1 dBFS ;
  - le ducking fusionne les pauses courtes ;
  - l'impact des SFX tombe à 0,001 frame de la transition ou du punch-in, une seconde piste est créée si deux effets se chevauchent, et le préroll seul est rogné ;
  - le validateur refuse un clip sans source ni asset.
- **rendu** :
  - forme de l'enveloppe (moitié de la profondeur au milieu des rampes, palier exact, rampes monotones) ;
  - mix réel voix + musique + whoosh : -14 ±0,3 LUFS, true peak sous le plafond, ducking mesuré à -15 dB, musique intacte hors des zones, stems de la bonne longueur à l'échantillon près.
- **QA** :
  - sinus calibré conforme, puis trop fort refusé ;
  - ducking conforme ; trop peu profond ou en marche, refusé ;
  - SFX décalé de 3 frames refusé.
- **Bout en bout sur la voix synthétique** : loudness, ducking et clics passent.

## Score qualité

Mêmes rushes qu'aux phases précédentes, et voix synthétique. Rendus en `--draft`, avec mesures sur le fichier livré (AAC).

| Rendu | Loudness / true peak | Ducking (médiane, pompage) | SFX (écart max) | Limiteur | Score | Couverture |
|---|---|---|---|---|---|---|
| Voix synthétique 16:9 | -14,2 LUFS / -1,6 dBTP | -15 dB, 0 | 1 SFX, 0,03 frame | — | **100/100** | 81 % |
| Long 16:9 | -14,3 LUFS / -1,4 dBTP | -15 dB sur 23 passages, 0 | 3 SFX, 0,03 frame | 0,2 LU retiré | **99,8/100** | 87 % |
| Court 9:16 | -14,2 LUFS / -1,8 dBTP | -15 dB sur 8 passages, 0 | 5 SFX, 0,05 frame | 0,5 LU retiré | **99,7/100** | 87 % |

- **Toute la catégorie audio passe (20/20)** sur les trois rendus. La couverture passe de 71 % à 87 %. Il ne reste que l'image (recadrage, étalonnage : phase 6) et les J/L cuts, non générés sur une caméra unique.
- **Compression de la voix** : sans elle, le limiteur retirait 1,2 LU au court, c'est-à-dire qu'il écrasait les pointes de la voix. Avec elle, il ne retire plus que 0,5 LU.
- **Seuls écarts restants**, hors audio et déjà connus :
  - synchro de quelques mots mal alignés à la source (phase 4) ;
  - un « euh » ou une répétition que Whisper n'a pas écrits à l'analyse (phase 2). Comme en phase 4, la transcription varie d'une analyse à l'autre.

### Ce qu'un monteur pro critiquerait encore

1. **La musique ne respire jamais** : la parole étant continue après le montage, la musique reste sous la voix du début à la fin. Il manque une intro musicale avant le premier mot, des remontées sur les respirations du propos et une fin calée sur une mesure.
2. **Des effets sonores génériques** : un même whoosh synthétique pour toutes les transitions, et un impact identique sur chaque punch-in. Un monteur varie, et ne met pas d'effet sur chaque zoom (5 en 53 s, c'est déjà beaucoup).
3. **Une voix seulement compressée** : pas d'égalisation (coupe-bas sous 80 Hz, présence), pas de réduction de bruit ni de désessage. Le son d'un entretien filmé en intérieur reste « pièce ».
4. **Des respirations non traitées** : celles qui restent dans les pauses courtes ne sont pas atténuées. C'était annoncé en phase 2 et ce n'est pas fait.
5. **Une loudness à la cible, mais une musique au niveau calculé** : -5 / -7 LU sous la voix avant ducking, quel que soit le morceau. Une musique très dense ou très calme mériterait un réglage à l'oreille.

## Limites connues

- **Dépendance aux stems** : le ducking et la synchro des SFX se mesurent sur les stems écrits par le rendu (`--keep-stems`, utilisé par `auto`). Sans stems, ces deux règles sont « non évaluées ». L'écart de ducking compare deux sorties du même moteur (avec et sans enveloppe). Ce qui est vérifié de façon indépendante, c'est la présence de la parole (VAD), la profondeur et la douceur effectivement rendues.
- **Marge du true peak** : le rendu vise -1,5 dBTP pour une limite de -1. Mesuré après AAC : -1,4 à -1,8 dBTP. Avec un autre codec ou un débit audio plus faible, cette marge pourrait ne pas suffire. La QA le signalerait.
- **Limiteur** : `alimiter` de FFmpeg agit sur les échantillons, pas sur le true peak. La boucle de remesure compense, en 1 à 2 passes sur nos rendus et 5 au plus.
- **Ducking** : il est calé sur les mots du transcript, pas sur l'énergie réelle de la voix. Un rire ou une respiration hors transcript ne fait pas descendre la musique.
- **Effets sonores** : 4 sons procéduraux seulement, sans banque de sons réels. Un whoosh synthétique reste reconnaissable.
- **Durée** : le mix ajoute 4 à 6 mesures EBU R128 (FFmpeg) par rendu, soit environ 10 s sur un rendu de 2 min 30.
