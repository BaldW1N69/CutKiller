# CutKiller

Montage automatique de rushes pour YouTube (16:9) et Shorts / TikTok / Reels (9:16), piloté par une **EDL JSON éditable à la main** et vérifié par des **règles de qualité mesurables**.

> Statut : **phase 5 (audio) livrée**. Le pipeline tourne de bout en bout : transcription au mot (français), suppression des silences, hésitations et faux départs, zoom-cuts, calage sur les beats, punch-ins animés et transitions avec flou de mouvement, sous-titres karaoké dans les safe zones avec export SRT, mix audio à -14 LUFS (true peak ≤ -1 dBTP) avec musique sous la voix, ducking sans pompage et effets sonores procéduraux synchronisés, rendu et quality-check. L'image (recadrage 9:16 et étalonnage) arrive en phase 6. Voir [`docs/AUDIT.md`](docs/AUDIT.md) pour l'architecture et le plan, et [`docs/phases/`](docs/phases) pour les rapports de phase.

## Prérequis

- Node 22+, pnpm 10 (`corepack enable`)
- FFmpeg 6+ (`apt install ffmpeg` / `brew install ffmpeg`)
- uv (workers Python d'analyse) : `curl -LsSf https://astral.sh/uv/install.sh | sh`

```sh
pnpm install
(cd workers && uv sync)
```

Au premier lancement, les modèles sont téléchargés dans `~/.cache/cutkiller` : Whisper `large-v3-turbo` (~1,6 Go) et wav2vec2 français (~1,3 Go). Sur CPU, compter environ 1× le temps réel pour l'analyse d'un rush. Les résultats sont mis en cache par contenu dans `.cache/analysis`.

## Utilisation

```sh
# Tout en une commande : EDL + rendu + rapport qualité dans out/
pnpm cutkiller auto rushes/*.mp4 musique.wav -p short -o out --min-score 90

# Pas à pas, en retouchant l'EDL entre deux étapes
pnpm cutkiller plan rushes/*.mp4 -p long -o out/edit.edl.json
pnpm cutkiller validate out/edit.edl.json
pnpm cutkiller render out/edit.edl.json -o out/final.mp4 [--draft]
pnpm cutkiller check out/final.mp4 --edl out/edit.edl.json -p long --md out/quality.md
```

- `-p short|long` ou chemin vers un profil `.yaml` : tous les réglages de style vivent dans [`profiles/`](profiles).
- `--draft` : encodage rapide (x264 `veryfast`) pour itérer ; le rendu final utilise le preset de l'EDL (`medium` par défaut).
- `--fast` : sans analyse de la parole ni des beats (assemblage + zoom-cuts uniquement).
- `plan` écrit aussi `<edl>.analysis.json` (transcript au mot, VAD, beats), que `check` réutilise.

## Architecture

| Étape | Module | Rôle |
|---|---|---|
| Analyse | `@cutkiller/analyze` + `workers/` (Python) | Probe des rushes ; transcription, beats, suivi du sujet à partir de la phase 2 |
| Planification | `cut → reframe → color → motion → captions → audio` | Passes pures `EDL → EDL`, dans cet ordre fixe |
| EDL | `@cutkiller/core` | Schéma, validateur, temps en frames entières ([référence](docs/EDL.md), [JSON Schema](schema/edl-1.schema.json)) |
| Motion | `@cutkiller/motion` + [`presets/`](presets) | Punch-ins sur l'emphase, transitions, timeline d'animation partagée par le rendu et la QA |
| Audio | `@cutkiller/audio` + [`presets/sfx/`](presets) | Ducking sur la parole, effets sonores synthétisés et calés à l'impact |
| Sous-titres | `@cutkiller/captions` | Mots sur la timeline, découpage, mise en page dans les safe zones, rendu karaoké, export SRT |
| Rendu | `@cutkiller/render` | Décodage FFmpeg par clip → compositeur Cairo (animations, flou de mouvement, glitch, sous-titres) → encodage FFmpeg CFR ; mix audio par stems (voix compressée, musique placée et baissée, effets), loudness EBU R128 + limiteur |
| QA | `@cutkiller/qa` | `quality-check` : 25 règles, score /100 sur les règles évaluées, taux de couverture |

## Développement

```sh
pnpm check        # lint + format (Biome)
pnpm typecheck
pnpm test         # unitaires + intégration FFmpeg + bout en bout
pnpm schema       # régénère schema/*.json (vérifié en CI)
(cd workers && uv run pytest && uv run ruff check .)
```

Les médias de test sont générés à la volée : mires FFmpeg et voix française espeak-ng avec vérité terrain au mot (`pnpm fixtures`, nécessite `espeak-ng`). Les rushes réels de la boucle qualité (licences libres) se téléchargent avec `pnpm rushes`. Aucun média de test n'est commité (seules les polices OFL de `assets/fonts/` le sont, avec leur licence).

## Licence

Apache-2.0. Licences des sources et dépendances : [`LICENSES.md`](LICENSES.md).
