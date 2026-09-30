# Presets

Presets nommés et versionnés, chargés par `PresetRegistry` (`@cutkiller/style`) :

```
presets/<kind>/<nom>@<x.y.z>.json      kind ∈ motion | transition | captions | sfx
```

Une EDL référence un preset par `nom@x` (dernière version x.*.*), `nom@x.y` ou `nom@x.y.z`. Une modification incompatible impose une nouvelle version majeure, pour que les EDL existantes se rendent à l'identique. Les premiers presets (`zoom-punch`, `whip-pan`, `glitch-cut`, `smooth-slide`) arrivent en phase 3.
