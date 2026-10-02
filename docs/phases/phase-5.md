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

TESTS_COUNT

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

SCORE

## Limites connues

LIMITS
