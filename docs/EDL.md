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

`keyframes[]` : `{ target: "<clipId>.<x|y|scale|opacity|rotation>", keys: [{ frame, value, ease? }] }`. Le champ `ease` d'une clé décrit la courbe qui y mène depuis la clé précédente :

- un nom (`ease-out`, `ease-in`, `ease-in-out`, `ease-out-back`…) ;
- `{ "cubicBezier": [x1, y1, x2, y2] }` ;
- `{ "spring": { "stiffness", "damping", "mass" } }` ;
- `"hold"`.

**Toute interpolation linéaire sur `x`, `y`, `scale` ou `opacity` est refusée par le validateur**, y compris un `ease` absent ou un `cubicBezier` équivalent au linéaire. Le rendu des keyframes arrive en phase 3.

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
