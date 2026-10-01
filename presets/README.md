# Presets

Presets nommés et versionnés, chargés par `PresetRegistry` (`@cutkiller/style`) :

```
presets/<kind>/<nom>@<x.y.z>.json      kind ∈ motion | transition | captions | sfx
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

La QA (`motion.presets`, `motion.durations`, `motion.no-linear`, `motion.overshoot`) vérifie que chaque animation de l'EDL vient d'un preset existant et respecte les plages du cahier des charges.
