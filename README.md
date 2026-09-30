# CutKiller

Montage automatique de rushes pour YouTube (16:9) et Shorts / TikTok / Reels (9:16), piloté par une **EDL JSON éditable à la main** et vérifié par des **règles de qualité mesurables**.

> Statut : **phase 1 (fondations) livrée**. Le pipeline tourne de bout en bout (analyse → EDL → rendu → quality-check), mais le montage lui-même (coupes, motion, sous-titres, audio, image) arrive à partir de la phase 2. Voir [`docs/AUDIT.md`](docs/AUDIT.md) pour l'architecture et le plan.

## Prérequis

- Node 22+, pnpm 10 (`corepack enable`)
- FFmpeg 6+ (`apt install ffmpeg` / `brew install ffmpeg`)
- uv (workers Python d'analyse) : `curl -LsSf https://astral.sh/uv/install.sh | sh`

```sh
pnpm install
(cd workers && uv sync)
```

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

## Architecture

| Étape | Module | Rôle |
|---|---|---|
| Analyse | `@cutkiller/analyze` + `workers/` (Python) | Probe des rushes ; transcription, beats, suivi du sujet à partir de la phase 2 |
| Planification | `cut → reframe → color → motion → captions → audio` | Passes pures `EDL → EDL`, dans cet ordre fixe |
| EDL | `@cutkiller/core` | Schéma, validateur, temps en frames entières ([référence](docs/EDL.md), [JSON Schema](schema/edl-1.schema.json)) |
| Rendu | `@cutkiller/render` | Décodage FFmpeg par clip → compositeur Cairo → encodage FFmpeg CFR ; mix audio FFmpeg |
| QA | `@cutkiller/qa` | `quality-check` : 25 règles, score /100 sur les règles évaluées, taux de couverture |

## Développement

```sh
pnpm check        # lint + format (Biome)
pnpm typecheck
pnpm test         # unitaires + intégration FFmpeg + bout en bout
pnpm schema       # régénère schema/*.json (vérifié en CI)
(cd workers && uv run pytest && uv run ruff check .)
```

Les médias de test sont synthétiques, générés par FFmpeg à la volée (`pnpm fixtures`) ; aucun binaire n'est commité.

## Licence

Apache-2.0. Licences des sources et dépendances : [`LICENSES.md`](LICENSES.md).
