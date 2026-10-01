# EDL v1 — référence

L'EDL (*edit decision list*) est le contrat entre la planification et le rendu. Elle se modifie à la main entre `cutkiller plan` et `cutkiller render`, et `cutkiller validate` la vérifie. Le schéma machine est dans [`schema/edl-1.schema.json`](../schema/edl-1.schema.json), généré depuis `packages/core/src/edl.ts`.

## Unités

| Champ | Unité | Pourquoi |
|---|---|---|
| `at`, `frame`, `audioSplitFrames` | frames entières à `output.fps` | Coupes à la frame près, sortie en CFR |
| `in`, `out` (sources) | secondes (3 décimales) | Les rushes peuvent être en VFR ou dans un autre fps |
| `cutFadeMs`, `fadeInMs`, `fadeOutMs` | millisecondes | — |

Un clip dure `round((out - in) × fps)` frames. Le moteur de rendu consomme exactement ce nombre de frames, et l'audio s'arrête au même point quantifié (`in + frames / fps`) : ainsi, l'audio et l'image ne dérivent pas d'une coupe à l'autre.

## Pistes

- `video[0]` est la **piste principale** : elle doit être continue, du début à la fin et sans trou (un trou donnerait des frames noires). Les pistes suivantes sont des calques superposés.
- `audio[]` contient les pistes additionnelles (musique, SFX). L'audio des clips vidéo de la piste principale est mixé automatiquement.

## J-cut / L-cut

`audioSplitFrames` décale le **point de montage audio** situé au début du clip, par rapport à sa coupe image :

- **négatif (J-cut)** : l'audio du clip commence avant son image, sous les dernières frames du clip précédent ;
- **positif (L-cut)** : l'audio du clip précédent se prolonge sous les premières frames de ce clip.

Un J/L cut exige un clip précédent contigu. Les sources doivent aussi contenir assez de matière avant ou après les points in/out (sinon `source.range`). La plage admise (4 à 12 frames) vient du profil de style et est contrôlée par `quality-check`.

## Cadrage statique

`transform: { scale, x, y }` sur un clip : `scale` > 1 resserre le cadre (punch-in / zoom-cut), `x` et `y` décalent le centre du cadrage d'une fraction de l'image (-0,5 à 0,5). Le recadrage est appliqué **au décodage** (crop dans la source puis mise à l'échelle), donc un punch-in à 110 % garde la pleine résolution de la source au lieu d'agrandir une image déjà réduite.

## Zoom-cuts

Deux clips consécutifs de la même source dont les points se touchent (`out` du premier = `in` du second, à 2 ms près) forment un **zoom-cut** : l'image change (en général de cadrage), l'audio continue sans aucune coupe ni fondu. C'est ce que la passe `cut` utilise pour qu'aucun plan ne reste statique au-delà de la limite du profil.

## Animations

`keyframes[]` : `{ target: "<clipId>.<propriété>", keys: [{ frame, value, ease? }], role?, preset?, why? }`.

**Valeurs** :
- `frame` est une frame de la timeline ;
- `scale` multiplie le cadrage statique du clip (1 = inchangé) ;
- `x` / `y` déplacent l'image d'une fraction de la largeur ou de la hauteur de sortie ;
- `opacity` va de 0 à 1 ;
- `rotation` est en degrés.

Avant la première clé et après la dernière, la valeur la plus proche est tenue.

**Courbes** : le champ `ease` d'une clé décrit la courbe qui y mène depuis la clé précédente :

- un nom : `ease-out`, `ease-in`, `ease-in-out`, `ease-out-cubic`, `ease-in-out-expo`, `ease-out-back`… ;
- `{ "cubicBezier": [x1, y1, x2, y2] }` (convention CSS) ;
- `{ "spring": { "stiffness", "damping", "mass" } }` : ressort amorti évalué en temps réel, posé exactement sur la valeur cible à la fin du segment. Son dépassement vaut `exp(-ζπ/√(1-ζ²))` ;
- `"hold"`.

**Toute interpolation linéaire sur `x`, `y`, `scale` ou `opacity` est refusée par le validateur**, y compris un `ease` absent ou un `cubicBezier` équivalent au linéaire.

**Rôles**, contrôlés par `quality-check` :

| Rôle | Durée | Forme de courbe | Dépassement |
|---|---|---|---|
| `entry` | 150–300 ms | décélérée (ease-out) | 0, ou entre 3 et 8 % |
| `exit` | 150–300 ms | accélérée (ease-in) | aucun |
| `micro` (punch-in…) | 150–300 ms | libre | 0, ou entre 3 et 8 % |
| `move` (mouvement long) | non contrôlée | libre | aucun |

Une animation peut aussi porter `preset` (`zoom-punch@1`…) : la QA vérifie alors qu'elle correspond toujours à son preset.

Le moteur de rendu décode un clip qui zoome avec la marge nécessaire (jusqu'à ×1,5), pour que le punch-in reste net.

## Transitions

`transitions[]` : `{ id, atFrame, preset, durationFrames, why? }`. `atFrame` est une coupe de la piste principale ; la géométrie vient du preset :

| Type | Fenêtre | Ce qui se passe |
|---|---|---|
| `push` (whip-pan) | à cheval sur la coupe | Les deux images se déplacent ensemble. Avant la coupe, le plan entrant montre sa première image figée ; après, le plan sortant garde sa dernière image figée. Le flou de mouvement masque ces images figées |
| `slide` (smooth-slide) | à partir de la coupe | Le plan entrant glisse par-dessus la dernière image du plan sortant |
| `glitch` (glitch-cut) | à cheval sur la coupe | Séparation RVB et bandes décalées, déterministes (graine fixe), au maximum sur la coupe |

L'audio n'est pas modifié par une transition : la coupe son reste à `atFrame`.

## Flou de mouvement

`output.motionBlur: { thresholdPxPerFrame, shutterAngle, stepPx, maxSamples }`. Pour chaque frame, le moteur de rendu calcule la vitesse à l'écran : le plus grand déplacement d'un coin de calque entre t−½ et t+½.

Au-delà du seuil (12 px/frame par défaut, réglable dans le profil), la frame devient la moyenne exacte de *n* sous-échantillons répartis sur l'obturateur (180° par défaut). *n* est choisi pour espacer les échantillons de `stepPx` pixels au plus, dans la limite de `maxSamples`.

Le journal de rendu (`<vidéo>.render-log.json`, champ `motion`) liste la vitesse et le nombre d'échantillons de chaque frame en mouvement : c'est ce que vérifie la règle `motion.blur`.

## Traçabilité

Chaque clip porte un champ `why: { kind, note?, wordIds? }` qui explique pourquoi il existe, pour qu'un humain puisse auditer et corriger les décisions automatiques :

- `kind` : `speech` (passage de parole conservé), `zoom-cut` (changement de cadrage sur audio continu), `assemble` ;
- `wordIds` : indices des mots du transcript (`<edl>.analysis.json`) contenus dans le clip ;
- `note` : ce qui a été coupé juste avant, par exemple `coupé avant : « euh, » (filler), silence de 685 ms`.

## Diagnostics du validateur

| Code | Sens |
|---|---|
| `schema.*` | Structure ou type invalide (avec le chemin du champ) |
| `id.duplicate` | Identifiant de clip réutilisé |
| `source.unknown` / `source.range` | Source absente / point hors de la durée de la source |
| `clip.empty` | `out ≤ in` ou clip plus court qu'une frame |
| `track.overlap` / `track.gap` | Chevauchement sur une piste / trou sur la piste principale |
| `split.orphan` / `split.range` | J/L cut sans clip précédent contigu / plus long que le clip |
| `keyframes.target` / `keyframes.order` | Cible inconnue / frames non croissantes |
| `motion.linear` | Interpolation linéaire sur une propriété spatiale |
