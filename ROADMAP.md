# CutKiller — Plan pour devenir la référence open source du montage vidéo par IA

> Rédigé le 19/11/2026. **Deadline du premier livrable : samedi 21/11/2026, même heure (J+2).** Point d'étape à ce moment-là.

## Avancement (mis à jour le 19/11, 23 h 30, heure de Paris)

| Sprint | État | Preuve |
|---|---|---|
| 0 · Consolidation | ✅ fait | Base `lucid-knuth` fusionnée sur la branche de travail ; CI GitHub verte ; 168 tests TS + 27 tests Python |
| 1 · Multilingue | ✅ fait | Langue détectée automatiquement ; en, fr, es, de, it, pt, nl ; test e2e anglais **99,8/100** |
| 1 · Docker | ✅ fait | Image Ubuntu 24.04 (FFmpeg 6.1) : build + `doctor` + rendu validés dans GitHub Actions ; montage anglais dans l'image : 99,8/100 |
| 1 · `doctor` | ✅ fait | `cutkiller doctor` (FFmpeg, workers, canvas, modèles, GPU, mémoire) |
| 1 · CLI bilingue | ✅ fait | Anglais par défaut, `CUTKILLER_LANG=fr` ; aide, logs, notes, 26 règles, messages QA et validateur ; tests dans les deux langues |
| 2 · MCP | ✅ fait | 9 outils, test e2e avec le client MCP officiel |
| 2 · Export pro | ✅ fait | `.otio` validé par opentimelineio 0.18, `.xml` (Premiere/Resolve/FCP) validé par xmllint ; import réel dans les logiciels **à tester par toi** |
| 2 · Plugin Claude Code | ✅ fait | Skill `video-editing` + config MCP |
| 2 · Sons libres (Openverse) | ⏳ backlog | — |
| 3 · Vitrine | ✅ fait | README anglais + GIF avant/après réel (interview CC BY, 97,8/100), CONTRIBUTING, CoC, SECURITY, templates, CHANGELOG ; site de docs (MkDocs, référence des règles générée depuis le code), benchmark vs auto-editor ([docs/BENCHMARK.md](docs/BENCHMARK.md)) |
| 4 · Release v1.0.0 | ⏳ | — |

---

## 1. Verdict honnête : on est loin de la perfection

**Non, CutKiller n'est pas aujourd'hui le meilleur projet de montage IA.** Pour un visiteur GitHub, il n'existe même pas encore.

| Constat | Preuve | Gravité |
|---|---|---|
| `main` est vide | `README.md` = `# CutKiller` (11 octets) + licence CC0. Un visiteur ne voit rien. | Bloquant |
| Le travail est éclaté sur **7 branches non fusionnées** | ~60 000 lignes réparties sur 3 architectures incompatibles (voir §2) | Bloquant |
| Aucune release, aucune démo visuelle | Pas de tag, pas de GIF avant/après, pas d'image Docker | Critique |
| Docs et CLI uniquement en français | Limite l'audience à ~5 % des développeurs GitHub | Critique |
| Transcription alignée pour le français seulement | wav2vec2 français ; pas d'anglais, la langue n°1 du marché | Critique |
| Installation lourde | Node 22 + pnpm + uv + FFmpeg + ~3 Go de modèles | Fort |
| Licences incohérentes | CC0 sur `main` et sur la branche Python, Apache-2.0 sur la branche TS | Moyen |

**Ce qui va bien** (mesuré le 19/11 dans un conteneur Linux propre) :
- branche TS `lucid-knuth` : typecheck propre, **141 tests verts / 7 rouges**. Les 7 échecs ont tous la même cause, `espeak-ng` absent du conteneur (génération des voix de test) : c'est l'environnement, pas le code ;
- branche Python `modest-faraday` : **129 tests verts**, 0 échec.

**La concurrence (étoiles GitHub au 19/11/2026) :**

| Projet | ⭐ | Ce qu'il fait |
|---|---|---|
| heygen-com/hyperframes | ~87 000 | Éditeur vidéo IA open source (adossé à HeyGen) |
| palmier-io/palmier-pro | ~14 800 | Éditeur macOS pensé pour l'IA |
| nexu-io/openmotion | ~12 800 | Alternative open source à Claude Motion / CapCut |
| openfilm/openfilm | ~8 500 | Transforme un agent de code en agent vidéo |
| WyattBlue/auto-editor | ~6 000 | Coupe automatique des silences (la référence historique) |
| FireRed-OpenStoryline | ~3 700 | Agent de montage |
| pireel/pireel | ~1 500 | Sous-titres, coupes, B-roll, export Premiere/DaVinci |

Ces projets ont des équipes, des démos et des années d'avance en notoriété. Battre hyperframes en étoiles en 2 jours est impossible, et je ne le promets pas.

**En revanche, CutKiller a un atout que personne n'a** (branche `lucid-knuth`, PR n°1) : **chaque montage est vérifié par 26 règles qualité mesurables** (loudness -14 LUFS, true peak, safe zones des sous-titres, synchro au mot, jump cuts, cadrage visage…). La QA est calibrée : un défaut injecté par règle, détection et fausses alertes mesurées. Score réel : 97,5 à 99,9/100 sur des rushes sous licence libre. Les concurrents génèrent ou coupent ; aucun ne **prouve** la qualité de ce qu'il livre.

## 2. Inventaire des 7 branches

| Branche | Stack | Contenu clé | Verdict |
|---|---|---|---|
| `lucid-knuth-x7govk` (PR n°1) | TypeScript monorepo + workers Python | EDL JSON + schéma, 13 paquets, 26 règles QA calibrées, recadrage 9:16 qui suit le visage, étalonnage peau, karaoké, B-roll, 6 looks, CI, 165 tests | **Base retenue** : la plus rigoureuse |
| `modest-faraday-g7t55z` | Python | 287 transitions (xfade + GL), sound design calé sur les transitions, banques de sons libres + crédits, presets plateformes, benchmark | Donneuse de fonctionnalités |
| `modest-maxwell-06gzvd` / `zen-clarke-hamzq9` | Python | Ancêtres de faraday : **serveur MCP, plugin Claude**, animations HTML, `doctor` | Donneuses (MCP, plugin) |
| `wonderful-ritchie-z6ewah` | Python | Pont DaVinci Resolve, base de connaissances montage | Donneuse (export NLE, connaissances) |
| `jolly-dirac-mo7uxs` | Python + Remotion | Reels 9:16 calés sur la musique, motion design, générateur de musique | Donneuse (mode « musique ») |
| `cool-rubin-n1f0oy` | Markdown | Grille de review vidéo (rétention YouTube) | Donneuse (critique automatique) |

## 3. Positionnement cible

> **CutKiller : le monteur open source qui se note lui-même.**
> Rushes bruts → vidéo prête à publier (YouTube, Shorts, TikTok, Reels), en local et gratuitement, pilotable par n'importe quel agent IA (MCP), et chaque rendu est livré avec un rapport qualité chiffré.

Pourquoi ce créneau :
- **Monter des vraies images**, pas générer des vidéos IA : c'est le besoin quotidien des créateurs (talking-head, interview, vlog, podcast).
- **Une qualité vérifiable** : c'est le seul différenciateur défendable face aux gros projets.
- **Pensé pour les agents** : EDL JSON éditable + MCP. Claude, Codex ou Cursor montent, lisent le rapport, corrigent et relancent.
- **Une sortie pro** : export vers Premiere, DaVinci Resolve et Final Cut pour finir à la main.

## 4. Décisions structurantes (à valider, ma recommandation en premier)

1. **Base technique = `lucid-knuth`** (TS + workers Python). C'est la plus testée et la seule avec une QA mesurée. Les 6 autres branches deviennent des sources de fonctionnalités à porter, puis sont archivées.
   *Alternative rejetée* : repartir de la branche Python. L'installation serait plus simple, mais on perdrait 26 règles QA et 165 tests, irrécupérables en 2 jours.
2. **Licence unique Apache-2.0**. CC0 n'est pas une licence approuvée par l'OSI pour du code et n'a pas de clause brevets ; les entreprises l'évitent.
3. **Anglais en langue principale** (README, CLI, docs), avec `README.fr.md` et une CLI bilingue.
4. **Une seule commande pour tout le monde** : `docker run ghcr.io/baldw1n69/cutkiller auto video.mp4`. Docker embarque FFmpeg, Node, Python et les modèles.

## 5. Plan 48 h — 4 sprints, livrables vérifiables

### Sprint 0 · H0 → H4 : consolidation
- [ ] Ma branche de travail repart de `lucid-knuth` ; tests au vert localement (état initial mesuré).
- [ ] Matrice de portage : chaque fonctionnalité des 6 autres branches → « porter maintenant », « backlog » ou « abandonner ».
- [ ] Licence Apache-2.0 unifiée, `LICENSES.md` complété (modèles, polices, GL transitions MIT).
- **Preuve** : CI verte sur la branche, matrice dans `docs/CONSOLIDATION.md`.

### Sprint 1 · H4 → H16 : installable par tout le monde, dans toutes les langues
- [ ] **Multilingue** : Whisper détecte la langue ; un aligneur par langue (en, fr, es, de, pt, it au minimum) ; règles de découpe des hésitations par langue (« euh »/« um »/« eh »…).
- [ ] **Image Docker** publiée sur GHCR par GitHub Actions (aucun identifiant requis de ta part). Variantes CPU, et GPU CUDA si le temps le permet.
- [ ] **Modèles adaptés à la machine** : `--model tiny|small|large`, choix automatique selon CPU/GPU/RAM ; premier lancement < 500 Mo en mode léger.
- [ ] `cutkiller doctor` : diagnostic FFmpeg, GPU, modèles, avec la commande de correction.
- [ ] CLI bilingue (en par défaut, fr si `LANG=fr`).
- **Preuve** : `docker run … auto demo_en.mp4` sur une machine vierge, rapport QA ≥ 97/100 en anglais **et** en français.

### Sprint 2 · H16 → H32 : natif pour les agents, compatible pros
- [ ] **Serveur MCP** (SDK TypeScript officiel) : `analyze`, `plan`, `edit_edl`, `render`, `check`, `explain_report`. Installation en une ligne dans Claude Code, Claude Desktop, Cursor, Codex.
- [ ] **Skill / plugin Claude Code** (porté de `modest-maxwell`) : boucle « monter → lire le rapport → corriger l'EDL → re-rendre ».
- [ ] **Export NLE** : OpenTimelineIO + FCPXML (Premiere, DaVinci Resolve, Final Cut). Coupes, sous-titres SRT et marqueurs conservés.
- [ ] **Portages** depuis les branches Python : sons et musiques libres (Openverse/Freesound) avec crédits automatiques ; catalogue de transitions xfade FFmpeg ; presets plateformes.
- **Preuve** : test e2e qui pilote le serveur MCP depuis un client MCP ; fichiers OTIO/FCPXML relus et validés par la bibliothèque OTIO.

### Sprint 3 · H32 → H44 : la vitrine (ce qui fait les étoiles)
- [ ] **README de niveau top-repo** : GIF avant/après en haut, une commande, tableau des fonctionnalités, comparatif honnête avec auto-editor, badges CI/licence/release.
- [ ] **Démos reproductibles** générées par CutKiller lui-même sur des rushes libres : interview → Short, vlog → YouTube, musique → reel. Script `pnpm demo`.
- [ ] **Benchmark public** CutKiller vs auto-editor sur les mêmes rushes : temps, score QA, durée retirée.
- [ ] **Hygiène open source** : CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, modèles d'issues et de PR, CHANGELOG, labels `good first issue`, topics GitHub, image de partage social.
- [ ] **Site de docs** (GitHub Pages) : guide de démarrage, référence EDL, référence des 26 règles QA, cookbook agents.
- [ ] CI : matrice Linux + macOS, smoke test Windows.

### Sprint 4 · H44 → H48 : release et recette
- [ ] Recette sur machine vierge : Docker + installation native, 3 rushes réels (FR, EN, musique seule).
- [ ] **Release v1.0.0** : tag, notes de version, image Docker versionnée.
- [ ] Rapport de point d'étape : ce qui est livré, mesures, ce qui a glissé et pourquoi.

## 6. Définition de « réussi » au 21/11 (critères mesurables)

| # | Critère | Mesure |
|---|---|---|
| 1 | Un seul produit cohérent sur `main` | 0 branche orpheline active ; PR de consolidation fusionnée |
| 2 | Utilisable par n'importe qui | `docker run` fonctionne sur une machine vierge en < 5 min (hors téléchargement des modèles) |
| 3 | International | Rapport QA ≥ 97/100 sur un rush anglais et un rush français |
| 4 | Natif agents | Serveur MCP testé en e2e ; installation documentée en 1 ligne |
| 5 | Compatible pros | Export OTIO/FCPXML validé par OTIO |
| 6 | Fiable | CI verte Linux + macOS ; nombre de tests ≥ 165 |
| 7 | Vitrine | README anglais avec GIF, docs en ligne, release v1.0.0 |

## 7. Après J+2 : feuille de route produit

| Version | Contenu | Pourquoi |
|---|---|---|
| v1.1 | J/L cuts et match cuts générés, riser → impact, room tone, rampes de vitesse, B-roll choisi sur le mouvement et la netteté | Les 5 critiques « monteur pro » du rapport de phase 8 |
| v1.2 | **Interface web locale** : timeline, aperçu, accepter/refuser chaque coupe, régler les sous-titres, re-rendre | « Tout le monde » = aussi les non-développeurs |
| v1.3 | **Clips viraux** : vidéo longue/podcast → N Shorts, moments choisis par LLM et notés (hook, rétention, d'après la grille de `cool-rubin`) | Le marché d'OpusClip et ViralCutter |
| v1.4 | Mode musique / motion design (porté de `jolly-dirac`), multicam podcast | Couvrir les reels musicaux |
| v2.0 | App desktop (Tauri), plugin Premiere/Resolve natif, SDK Python, option GPU cloud | Distribution grand public |

En continu : vidéos de démo sur les réseaux, showcase communautaire, présets partagés, triage des issues sous 48 h.

## 8. Risques et parades

| Risque | Parade |
|---|---|
| Je ne peux pas tester Premiere/Resolve/Final Cut en interface graphique | Validation OTIO automatique ; je te demanderai un test d'import manuel de 2 min |
| Machine sans GPU ici : performances GPU non mesurées | CPU mesuré ; GPU marqué « expérimental » tant qu'il n'est pas vérifié |
| YouTube/TikTok bloquent les robots : pas de vidéos de référence | Rushes sous licence libre (Global Lives, Pexels, Internet Archive) |
| Publication npm/PyPI/Docker Hub impossible sans tes identifiants | GHCR via GitHub Actions (aucun identifiant) ; npm/PyPI plus tard, si tu le souhaites |
| 48 h trop justes pour tout | Ordre d'impact fixe : consolidation → Docker + anglais → MCP → vitrine. Ce qui glisse est annoncé au point d'étape, pas caché |
| Les étoiles ne se décrètent pas | Je livre ce qui rend un repo « starrable » (démo, une commande, docs) ; la diffusion (Reddit, X, HN, Product Hunt) relève de toi, je prépare les textes |

## 9. Ambitions — file de travail permanente

Objectifs volontairement hors de portée en 48 h. Chaque session de travail prend le **premier chantier ouvert** de cette liste (ordre d'impact), le livre avec une mesure, coche, et passe au suivant. Rien n'est coché sans preuve (test, mesure, CI).

| # | Axe | Objectif chiffré | Aujourd'hui | État |
|---|---|---|---|---|
| A1 | Jugement éditorial | Vidéo longue → 10 Shorts classés par accroche et rétention prédite ; structure narrative réécrite par IA (Claude, optionnel) et vérifiée par la QA | `cutkiller shorts` (3 Shorts réels tirés d'une interview de 3 min : 97,2–97,9/100) ; `--target` (version courte) ; Claude via `--ai` (testé avec client simulé, pas de clé ici) | 🟡 avancé : reste la mesure de rétention réelle et un test avec clé API |
| A2 | Vitesse | 60 s de rushes en < 60 s sur portable CPU, < 10 s sur GPU | ~10 min (4 cœurs) ; chronos par étape, GPU auto-détecté (non testé : pas de GPU ici), `pnpm bench` | 🟡 mesure en cours |
| A3 | Montage de pro | J/L cuts et match cuts générés, rampes de vitesse, riser → impact, room tone, débruitage voix | Débruitage voix fait (bruit -6,1 dB, voix -0,13 dB) | 🟡 1/6 |
| A4 | Interface | App web locale (timeline, aperçu, accepter/refuser chaque coupe) → app desktop, installeur 1 clic | CLI + MCP | ⏳ |
| A5 | Benchmark public | « CutBench » : 100 rushes libres annotés, classement public des outils | `pnpm bench` (2 rushes, chronos + score par commit) | 🟡 amorcé |
| A6 | Qualité perçue | Test à l'aveugle sur 20 vidéos : ≥ 50 % préfèrent CutKiller à un monteur humain | Jamais mesuré | ⏳ |
| A7 | Règles QA | 50 règles : VMAF, accessibilité, rythme de rétention, accroche < 3 s | 26 | ⏳ |
| A8 | Formats | Podcast multicam, tutoriel écran (zoom sur le curseur), vlog, gaming, pub produit | Interview, B-roll, musique | ⏳ |
| A9 | Langues | 30 langues avec alignement et hésitations | 16 (en, fr testées de bout en bout ; les 9 ajoutées restent à valider sur voix réelle) | 🟡 16/30 |
| A10 | Plateformes | CI Linux + macOS + Windows ; GPU NVIDIA et Apple Silicon testés | CI macOS + Windows ajoutée (install, doctor, montage rapide) | 🟡 en validation |
| A11 | Intégrations | Plugins natifs Premiere / Resolve, publication YouTube / TikTok, B-roll Pexels | Export OTIO / XML | ⏳ |
| A12 | Adoption | 10 000 étoiles, 100 contributeurs en 6 mois, listes « awesome » | 0 | ⏳ (diffusion) |
