# Licences — CutKiller

Ce fichier recense la licence de chaque source auditée, de chaque fichier tiers copié dans ce repo et de chaque dépendance. **Règle** : aucun code n'est copié avant que sa licence soit inscrite ici. Tout fichier copié conserve son en-tête de copyright d'origine.

Colonne « Vérifiée » : ✅ = lue dans le fichier de licence de la source (2026-09-30) ; 🔎 = connue, à re-vérifier au moment de l'ajout de la dépendance.

## 1. Licence du projet

| Élément | Licence | Note |
|---|---|---|
| CutKiller (ce repo) | **Apache-2.0** (fichier `LICENSE`, depuis la phase 1 ; CC0 auparavant) | Compatible avec l'inclusion de code MIT, à condition de conserver les notices ; octroie une licence de brevet |

## 2. Sources auditées (phase 0)

| Source | Version auditée | Licence | Vérifiée | Code dépendant de CapCut/ByteDance ? |
|---|---|---|---|---|
| OpenCut (réécriture, zip `OpenCut-main`) | snapshot fourni le 2026-09-30 | MIT, © 2026 OpenCut | ✅ | Non |
| opencut-classic (`github.com/opencut-app/opencut-classic`) | commit `cf5e79e` (2026-05-17) | MIT, © 2025-2026 OpenCut | ✅ | Non |
| claude-code-video-toolkit (zip, présenté comme « CapCut AI toolkit ») | v0.20.1 | MIT, © 2024 Digital Samba | ✅ | Non (grep `capcut|bytedance|jianying|douyin` : 0 résultat) |

Le toolkit s'appuie sur des API propriétaires : ElevenLabs, Ideogram, et du GPU cloud via Modal ou RunPod. **Aucune de ces briques n'est reprise.**

## 3. Code tiers copié ou prévu dans ce repo

*Aucun fichier copié à ce stade.* Fichiers candidats, validés dans l'audit :

| Fichier source | Destination prévue | Licence | Phase |
|---|---|---|---|
| opencut-classic `apps/web/src/subtitles/srt.ts` | `packages/captions/src/io/srt.ts` | MIT © 2025-2026 OpenCut | 4 |
| opencut-classic `apps/web/src/subtitles/ass.ts` (parseur) | `packages/captions/src/io/ass.ts` | MIT © 2025-2026 OpenCut | 4 |
| toolkit `templates/concept-explainer-short/gen_captions.py` (fonction `align`) | `workers/cutkiller_workers/script_align.py` | MIT © 2024 Digital Samba | 2 |

Idées **réimplémentées sans copie**, attribuées par courtoisie :
- `MediaTime` à 120 000 ticks/s (opencut-classic `rust/crates/time`) ;
- l'épinglage FFmpeg par sha256 (OpenCut `crates/media/setup`) ;
- le test render-baseline A/B (toolkit `tests/render-baseline`).

Phase 3 (motion) : aucun code tiers. Le solveur cubic-bezier suit la définition CSS (W3C *CSS Easing Functions*) et les ressorts suivent l'équation de l'oscillateur amorti. Les transitions (whip-pan, smooth-slide, glitch-cut) et le flou de mouvement sont écrits pour ce dépôt. Les transitions du toolkit, qui dépendent de Remotion, n'ont pas été reprises.

## 4. Dépendances prévues

| Dépendance | Usage | Licence | Mode | Vérifiée |
|---|---|---|---|---|
| FFmpeg (build Ubuntu 24.04, 6.1.1) | décodage, encodage x264/x265, loudnorm, ebur128, lut3d, blackdetect | GPL-2.0+ (build avec x264/x265) | exécutable externe, non lié, non redistribué | 🔎 |
| canvas (node-canvas) 3.2.3 | compositeur 2D | MIT ; binaires précompilés embarquant Cairo (LGPL-2.1 / MPL-1.1), Pango (LGPL-2.1) et leurs dépendances, liés dynamiquement | npm | ✅ (npm) |
| zod 4 | schémas EDL / profils | MIT | npm | ✅ (npm) |
| yaml 2 | lecture des profils | ISC | npm | ✅ (npm) |
| typescript 7, vitest 5, tsx, @biomejs/biome | build, tests, lint | Apache-2.0 / MIT / MIT / MIT-Apache-2.0 | dev | 🔎 |
| pytest, ruff, uv | tests et lint des workers | MIT / MIT / MIT-Apache-2.0 | dev | 🔎 |
| faster-whisper 1.2 + CTranslate2 4.8 | transcription au mot | MIT / MIT | pip | 🔎 |
| Poids Whisper `large-v3-turbo` (OpenAI, conversion Systran) | modèle ASR | MIT | téléchargés à l'exécution depuis HuggingFace, non commités | 🔎 |
| torch 2.14 (CPU) / torchaudio 2.11 | inférence, alignement forcé CTC (`forced_align`) | BSD-3-Clause / BSD-2-Clause | pip | 🔎 |
| transformers | chargement du modèle wav2vec2 | Apache-2.0 | pip | 🔎 |
| `jonatasgrosman/wav2vec2-large-xlsr-53-french` | modèle d'alignement FR | Apache-2.0 | téléchargé à l'exécution | ✅ (carte du modèle, phase 2) |
| silero-vad 6 | détection de parole | MIT | pip (modèle inclus) | 🔎 |
| librosa 0.11, soundfile, numpy | beats, onsets | ISC / BSD-3-Clause / BSD-3-Clause | pip | 🔎 |
| MediaPipe (+ modèles BlazeFace / Pose) | suivi du sujet | Apache-2.0 | pip, modèles depuis storage.googleapis.com | 🔎 |
| OpenCV (headless) | lecture de frames, statistiques | Apache-2.0 | pip | 🔎 |
| espeak-ng | génération de fixtures de test uniquement | GPL-3.0 | outil de dev, non redistribué | 🔎 |
| OpenTimelineIO (optionnel) | export vers Resolve / Premiere | Apache-2.0 | pip | 🔎 |

Assets :
- polices sous **SIL OFL 1.1** uniquement (Inter, Montserrat…) ;
- SFX **générés procéduralement** par le repo ;
- LUT **générées** par le repo, aucun pack commercial.

## 5. Médias de test (jamais commités)

Téléchargés dans `.cache/rushes` par `pnpm rushes`, d'après [`fixtures/rushes.json`](fixtures/rushes.json). Aucune vidéo produite à partir d'eux n'est publiée ; toute publication devrait reprendre l'attribution.

| Média | Licence | Attribution |
|---|---|---|
| Entretien « Pierre Vallee, Trois-Rivières » (Global Lives Project), extraits de 60 et 180 s | CC BY 3.0 | Global Lives Project — K. Vanderborght, D. Fabrega, M. Dietlin, R. Leeuwenkroon, M. Ploska, C. Genest |
| « Thunder (hip-hop instrumental) » — Cely Grande | CC0 1.0 | — |
| Voix synthétique française (espeak-ng) et mires FFmpeg | générées par le repo | — |

Des témoignages de Wikimania Paris 2026 sous CC BY 4.0 (Wikimedia France) avaient été retenus, mais `upload.wikimedia.org` refuse les téléchargements depuis l'IP de sortie de l'environnement cloud (HTTP 429).

## 6. Écartés pour raison de licence

| Brique | Licence | Motif |
|---|---|---|
| Remotion (`remotion`, `@remotion/*`) | Remotion License (source-available) | Gratuit seulement pour les particuliers et les structures de ≤ 3 salariés ; interdiction de revendre un dérivé. **Ce n'est pas de l'open source au sens OSI.** Les templates et transitions du toolkit en dépendent |
| essentia | AGPL-3.0 | Contamination réseau/distribution |
| madmom (modèles) | CC BY-NC-SA 4.0 | Usage non commercial uniquement |
| torchaudio `MMS_FA` (poids) | CC BY-NC 4.0 | Usage non commercial uniquement |
| CrisperWhisper | CC BY-NC 4.0 | Usage non commercial uniquement |
| aubio | GPL-3.0 | Évitable : librosa couvre le besoin |
| Toute API, SDK ou asset CapCut / ByteDance | propriétaire | Interdit par les contraintes du projet |
