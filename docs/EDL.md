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

## Animations

`keyframes[]` : `{ target: "<clipId>.<x|y|scale|opacity|rotation>", keys: [{ frame, value, ease? }] }`. Le champ `ease` d'une clé décrit la courbe qui y mène depuis la clé précédente :

- un nom (`ease-out`, `ease-in`, `ease-in-out`, `ease-out-back`…) ;
- `{ "cubicBezier": [x1, y1, x2, y2] }` ;
- `{ "spring": { "stiffness", "damping", "mass" } }` ;
- `"hold"`.

**Toute interpolation linéaire sur `x`, `y`, `scale` ou `opacity` est refusée par le validateur**, y compris un `ease` absent ou un `cubicBezier` équivalent au linéaire. Le rendu des keyframes arrive en phase 3.

## Traçabilité

Chaque clip peut porter un champ `why: { kind, note?, wordIds? }` qui explique pourquoi il existe (mots conservés, beat, B-roll…). Les passes le renseignent à partir de la phase 2, pour qu'un humain puisse auditer et corriger les décisions automatiques.

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
