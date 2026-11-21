# Presets

Presets nommés et versionnés, chargés par `PresetRegistry` (`@cutkiller/style`) :

```
presets/<kind>/<nom>@<x.y.z>.json      kind ∈ motion | transition | captions | sfx | look
```

Une EDL référence un preset par `nom@x` (dernière version x.*.*), `nom@x.y` ou `nom@x.y.z`. Une modification incompatible impose une nouvelle version majeure, pour que les EDL existantes se rendent à l'identique.

| Preset | Kind | Rôle | Durée | Courbe |
|---|---|---|---|---|
| `zoom-punch@1` | motion | micro (punch-in sur l'emphase) | 200 ms | ressort, ≈5 % de rebond |
| `pop-in@1` | motion | entrée | 250 ms | ressort, ≈5 % de rebond |
| `fade-out@1` | motion | sortie | 200 ms | ease-in cubique |
| `whip-pan@1` | transition | push (même source) | 300 ms | ease-in-out expo |
| `smooth-slide@1` | transition | slide (changement de source) | 400 ms | ease-out cubique |
| `glitch-cut@1` | transition | RVB + bandes, déterministe | 200 ms | — |
| `caption-pop@1` | motion | entrée d'un sous-titre (échelle 0,8 → 1) | 200 ms | ressort, ≈5 % de rebond |
| `caption-fade@1` | motion | entrée d'un sous-titre (opacité 0 → 1) | 160 ms | ease-out cubique |
| `karaoke-pop@1` | captions | court : 1–3 mots, Poppins ExtraBold en capitales, mot actif jaune | — | entrée `caption-pop@1` |
| `subtitle-clean@1` | captions | long : 2 lignes × 32 caractères, Poppins SemiBold, mot actif jaune | — | entrée `caption-fade@1` |
| `whoosh@1` | sfx | whip-pan (court) : bruit filtré balayé 300 → 3 500 Hz, panoramique G → D | 450 ms | impact à 220 ms |
| `whoosh-soft@1` | sfx | transitions (long) : souffle plus grave et plus doux | 500 ms | impact à 250 ms |
| `glitch-burst@1` | sfx | glitch-cut : rafales numériques 4 bits | 300 ms | impact à 120 ms |
| `punch-tick@1` | sfx | punch-in : impact sourd 180 → 60 Hz avec clic | 160 ms | impact à 4 ms |
| `push-in@1` | motion | move (poussée lente sur l'emphase, profils cinematic) | 900 ms | ease-in-out, sans rebond |
| `cross-dissolve@1` | transition | dissolve direct (changement de source, cinematic) | 500 ms | ease-in-out |
| `dip-to-black@1` | transition | dissolve par le noir (rupture dans une caméra, cinematic), 15 % tenus au noir | 500 ms | ease-in-out |
| `cinema-subtitle@1` | captions | cinematic 16:9 : 2 lignes × 38 caractères, Poppins SemiBold blanc cassé, casse normale, sans karaoké | — | entrée `caption-fade@1` |
| `cinema-caption@1` | captions | cinematic 9:16 : 2–4 mots en casse normale, mot actif à peine plus chaud | — | entrée `caption-fade@1` |
| `film-print@1` | look | cinematic : S +14 % autour de 0,42, noirs à 2 %, ombres froides et hautes lumières chaudes à luminance constante | — | — |
| `clean@1` | look | étalonnage par défaut : courbe en S douce (+8 % autour de 0,45), noirs relevés de 1 %, saturation +6 %, sans virage de teinte ; LUT 33³ générée | — | — |

La QA (`motion.presets`, `motion.durations`, `motion.no-linear`, `motion.overshoot`) vérifie que chaque animation de l'EDL vient d'un preset existant et respecte les plages du cahier des charges.
