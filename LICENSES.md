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
| opencut-classic `apps/web/src/subtitles/ass.ts` (parseur) | `packages/captions/src/io/ass.ts` | MIT © 2025-2026 OpenCut | import ASS, non planifié |
| toolkit `templates/concept-explainer-short/gen_captions.py` (fonction `align`) | `workers/cutkiller_workers/script_align.py` | MIT © 2024 Digital Samba | 2 |

Idées **réimplémentées sans copie**, attribuées par courtoisie :
- `MediaTime` à 120 000 ticks/s (opencut-classic `rust/crates/time`) ;
- l'épinglage FFmpeg par sha256 (OpenCut `crates/media/setup`) ;
- le test render-baseline A/B (toolkit `tests/render-baseline`).

Phase 5 (audio) : aucun code tiers et aucun fichier audio tiers.
- Les effets sonores sont **synthétisés** par le dépôt (`packages/audio/src/sfx.ts` : bruit pseudo-aléatoire, filtre à variables d'état, enveloppes) à partir des presets `presets/sfx/`.
- La mesure de loudness et le limiteur sont ceux de FFmpeg (`ebur128`, `alimiter`), utilisé comme exécutable externe, comme ailleurs.

Phase 7 (QA) : aucun code tiers. Le banc de calibration, le format de rapport et la lecture des étiquettes Audacity (format texte documenté, sans code repris) sont écrits pour ce dépôt.

Phase 6 (image) : aucun code tiers. La caméra virtuelle (filtre médian, zone morte, glissement posé sur le déplacement du sujet, borne d'accélération), l'égalisation sur la peau, l'épaulement des hautes lumières, la génération des LUT `.cube` et la conversion CIELAB (formules CIE publiques) sont écrits pour ce dépôt. MediaPipe, prévu à l'audit, n'a pas été retenu : YuNet (OpenCV) fournit visages et points du visage avec une seule dépendance déjà prévue, et un modèle MIT de 230 Ko.

Phase 4 (sous-titres) : aucun code tiers. L'export SRT (`packages/captions/src/srt.ts`) est un writer d'une vingtaine de lignes écrit pour ce dépôt : le parseur SRT d'opencut-classic, prévu à l'audit, n'a pas été nécessaire (pas d'import de sous-titres). Le découpage remplace `chunk()` du toolkit, réécrit comme prévu. Le ratio de contraste suit la définition WCAG 2.x (luminance relative sRGB).

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
| opencv-python-headless 5.0 | détection de visages (`FaceDetectorYN`) | Apache-2.0 ; la wheel embarque FFmpeg (LGPL-2.1+) et d'autres bibliothèques sous licences permissives | pip | ✅ (PyPI, phase 6) |
| Modèle YuNet `face_detection_yunet_2023mar.onnx` (opencv_zoo) | détecteur de visages et 5 points (yeux, nez, bouche) | **MIT**, © 2020 Shiqi Yu (`models/face_detection_yunet/LICENSE`) | téléchargé à l'exécution (sha256 épinglé), non commité | ✅ (fichier LICENSE, phase 6) |
| espeak-ng | génération de fixtures de test uniquement | GPL-3.0 | outil de dev, non redistribué | 🔎 |
| OpenTimelineIO (optionnel) | export vers Resolve / Premiere | Apache-2.0 | pip | 🔎 |

Assets :
- polices sous **SIL OFL 1.1** uniquement. Commitées dans `assets/fonts/`, avec leur `OFL.txt` (l'OFL autorise la redistribution avec le logiciel) :

  | Police | Fichiers | Source | Licence | sha256 |
  |---|---|---|---|---|
  | Poppins | `Poppins-ExtraBold.ttf`, `Poppins-SemiBold.ttf` | `github.com/google/fonts` (`ofl/poppins`) | SIL OFL 1.1, © 2020 The Poppins Project Authors | `f2ab17c1…f958e1`, `d3bf1bda…a0286` |

- SFX **générés procéduralement** par le repo ;
- LUT **générées** par le repo, aucun pack commercial.

## 5. Médias de test (jamais commités)

Téléchargés dans `.cache/rushes` par `pnpm rushes`, d'après [`fixtures/rushes.json`](fixtures/rushes.json). Aucune vidéo produite à partir d'eux n'est publiée ; toute publication devrait reprendre l'attribution.

| Média | Licence | Attribution |
|---|---|---|
| Entretien « Pierre Vallee, Trois-Rivières » (Global Lives Project), extraits de 60 et 180 s | CC BY 3.0 | Global Lives Project — K. Vanderborght, D. Fabrega, M. Dietlin, R. Leeuwenkroon, M. Ploska, C. Genest |
| « Thunder (hip-hop instrumental) » — Cely Grande | CC0 1.0 | — |
| Voix synthétique française (espeak-ng) et mires FFmpeg | générées par le repo | — |
| Portrait d'Eileen Collins (`astronaut.png` de scikit-image 0.24, sha256 épinglé), composé par FFmpeg dans les fixtures de visage | domaine public (NASA Great Images ; « no known copyright restrictions ») | NASA |

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
