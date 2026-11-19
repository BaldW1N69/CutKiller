# CutKiller

> [English](README.md) · [Feuille de route](ROADMAP.md)

Montage automatique de rushes pour YouTube (16:9) et Shorts / TikTok / Reels (9:16), piloté par une **EDL JSON éditable à la main** et vérifié par des **règles de qualité mesurables**.

> Statut : **phases 0 à 8 livrées** (phase 8 : profils cinématiques). Le pipeline tourne de bout en bout : transcription au mot (français), suppression des silences, hésitations et faux départs, zoom-cuts, calage sur les beats, punch-ins animés et transitions avec flou de mouvement, sous-titres karaoké dans les safe zones avec export SRT, mix audio à -14 LUFS (true peak ≤ -1 dBTP) avec ducking et effets sonores synchronisés, recadrage 9:16 qui suit le visage comme une caméra posée, étalonnage qui égalise la peau d'un plan à l'autre sous un look commun, rendu et quality-check sur les 26 règles. La QA est calibrée : un défaut injecté par règle sur un montage propre, détection et fausses alertes mesurées ([rapport](docs/phases/phase-7.md)) ; la synchro peut être vérifiée contre une annotation humaine. Voir [`docs/AUDIT.md`](docs/AUDIT.md) pour l'architecture et le plan, et [`docs/phases/`](docs/phases) pour les rapports de phase.

## En une commande (Docker)

```sh
docker run --rm -v "$PWD:/work" -v cutkiller-models:/models \
  ghcr.io/baldw1n69/cutkiller auto interview.mp4 musique.mp3 -p short -o out
```

Langue détectée automatiquement (français, anglais, espagnol, allemand, italien, portugais, néerlandais ; `--lang` pour la forcer). `cutkiller doctor` vérifie l'installation. `cutkiller mcp` lance le serveur MCP (Claude, Cursor, Codex…). `cutkiller export out/edit.edl.json -o edit.xml` (ou `.otio`) ouvre le montage dans Premiere Pro, DaVinci Resolve ou Final Cut.

## Prérequis

- Node 22+, pnpm 10 (`corepack enable`)
- FFmpeg 6+ (`apt install ffmpeg` / `brew install ffmpeg`)
- uv (workers Python d'analyse) : `curl -LsSf https://astral.sh/uv/install.sh | sh`

```sh
pnpm install
(cd workers && uv sync)
```

Au premier lancement, les modèles sont téléchargés dans `~/.cache/cutkiller` : Whisper `large-v3-turbo` (~1,6 Go), wav2vec2 français (~1,3 Go) et le détecteur de visages YuNet (230 Ko). Sur CPU, compter environ 1× le temps réel pour l'analyse d'un rush. Les résultats sont mis en cache par contenu dans `.cache/analysis`.

## Utilisation

```sh
# Tout en une commande : EDL + rendu + rapport qualité dans out/
pnpm cutkiller auto rushes/*.mp4 musique.wav -p short -o out --min-score 90

# Cinéma : entretien + plans d'illustration (B-roll) + musique, style néon
pnpm cutkiller auto interview.mp4 musique.wav --broll rue.mp4 --broll mains.mp4 -p cinematic --look neon-80s -o out
pnpm cutkiller looks   # styles : film-print, bleach-grit, neon-80s, teal-orange, noir, clean

# Comparer un rendu à une vidéo de référence (rythme, image, son)
pnpm cutkiller reference reference.mp4 --against out/final.mp4

# Pas à pas, en retouchant l'EDL entre deux étapes
pnpm cutkiller plan rushes/*.mp4 -p long -o out/edit.edl.json
pnpm cutkiller validate out/edit.edl.json
pnpm cutkiller render out/edit.edl.json -o out/final.mp4 [--draft]
pnpm cutkiller check out/final.mp4 --edl out/edit.edl.json -p long --md out/quality.md --json out/quality.json

# Vérité terrain humaine : mots surlignés à corriger à l'oreille dans Audacity, puis contrôle contre l'annotation
pnpm cutkiller annotate out/edit.edl.json -o out/labels.txt
pnpm cutkiller check out/final.mp4 --edl out/edit.edl.json -p long --truth out/labels.txt

# Calibration de la QA : un défaut injecté par règle sur un montage propre (≈ 45 min)
pnpm cutkiller calibrate -o out/calibration
```

- `-p short|long|cinematic|cinematic-short` ou chemin vers un profil `.yaml` : tous les réglages de style vivent dans [`profiles/`](profiles). Les profils `cinematic` (16:9) et `cinematic-short` (9:16) suivent l'[étude de 24 tutoriels et 9 articles](docs/research/cinematic.md) : plans plus longs, poussées lentes au lieu des punch-ins, fondus, look « tirage film », grain, vignette et letterbox 2,39:1, sous-titres sobres. Les 26 règles QA sont les mêmes pour tous les profils, seuls les seuils changent. B-roll : `--broll plan.mp4` (répétable) pour des plans de coupe sur la parole, ou un montage calé sur la musique s'il n'y a pas de parole.
- `--draft` : encodage rapide (x264 `veryfast`) pour itérer ; le rendu final utilise le preset de l'EDL (`medium` par défaut).
- `--fast` : sans analyse de la parole ni des beats (assemblage + zoom-cuts uniquement).
- `plan` écrit aussi `<edl>.analysis.json` (transcript au mot, VAD, beats, visages), que `check` réutilise.
- Le rapport (`--json`, schéma [`schema/report-1.schema.json`](schema/report-1.schema.json)) donne pour chaque règle le seuil du profil, ce que la mesure lit (rendu, EDL, journal de rendu), les écarts avec leur timecode et la durée du contrôle.

## Architecture

| Étape | Module | Rôle |
|---|---|---|
| Analyse | `@cutkiller/analyze` + `workers/` (Python) | Probe des rushes ; transcription au mot, VAD, prosodie, beats, visages et couleur de peau (YuNet / OpenCV) |
| Planification | `cut → broll → reframe → color → motion → captions → audio` | Passes pures `EDL → EDL`, dans cet ordre fixe |
| EDL | `@cutkiller/core` | Schéma, validateur, temps en frames entières ([référence](docs/EDL.md), [JSON Schema](schema/edl-1.schema.json)) |
| Image | `@cutkiller/reframe`, `@cutkiller/color` + [`presets/look/`](presets) | Caméra virtuelle 9:16 sur le visage (zone morte, glissements anticipés, accélération bornée) ; peau égalisée par source, plancher d'exposition, look en LUT générée |
| Motion | `@cutkiller/motion` + [`presets/`](presets) | Punch-ins sur l'emphase, transitions, timeline d'animation partagée par le rendu et la QA |
| Audio | `@cutkiller/audio` + [`presets/sfx/`](presets) | Ducking sur la parole, effets sonores synthétisés et calés à l'impact |
| Sous-titres | `@cutkiller/captions` | Mots sur la timeline, découpage, mise en page dans les safe zones, rendu karaoké, export SRT |
| Rendu | `@cutkiller/render` | Décodage FFmpeg par clip (bande recadrée, étalonnage cuit en une LUT 3D) → compositeur Cairo (animations, flou de mouvement, glitch, sous-titres) → encodage FFmpeg CFR ; mix audio par stems (voix compressée, musique placée et baissée, effets), loudness EBU R128 + limiteur |
| QA | `@cutkiller/qa` | `quality-check` : 26 règles, toutes contrôlées ; score /100 sur les règles applicables au rendu, taux de couverture |

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
