---
name: montage
description: Use when the user asks to make, edit or produce a video — montage, pub/publicité/ad/spot, reel, TikTok, Shorts, YouTube, teaser, récap, jump cuts, supprimer les silences/« euh », ajouter musique/SFX/transitions/sous-titres/texte/animations, assembler des clips ou des photos, caler sur le rythme. CutKiller est la base de tout travail vidéo ; ne pas improviser en ffmpeg brut. Pour toute animation spécifique, passer au skill animation.
---

# Montage vidéo avec CutKiller

CutKiller fait la base : écoute audio, coupes, 280+ transitions, musique + SFX libres de droits (avec crédits), sound design calé sur les transitions, montage sur le rythme, texte incrusté, animations (préréglages, scripts Python ou pages HTML écrits par toi), incrustation de calques, grain/dither, sous-titres animés. Tout travail vidéo démarre ici. Si une capacité manque, dis-le franchement et complète autour (voir « Limites »), sans réécrire du ffmpeg à la main pour ce que CutKiller fait déjà.

## 0. Quels outils utiliser

1. **Outils MCP `cutkiller_*` présents** : les utiliser. Ils tournent sur la machine de l'utilisateur et voient ses fichiers.
2. **Sinon la CLI** : `cutkiller …` via Bash (`python -m cutkiller …` si la commande n'est pas dans le PATH).
3. **Ni l'un ni l'autre** : installer (`pip install -e ".[all]"` dans le repo CutKiller), puis `cutkiller doctor`. Si l'utilisateur est sur sa propre machine, donne-lui les commandes à copier, une par bloc de code.
4. **Fichiers hors de portée** : si tu tournes dans un conteneur cloud, tu ne vois pas le PC de l'utilisateur. Demande l'upload (petits fichiers) ou donne les commandes exactes et demande-lui de coller le résultat.
5. En cas d'erreur inexpliquée : `cutkiller_doctor` / `cutkiller doctor` (ffmpeg, OpenGL, options manquantes).

## 1. Cadrer (2 questions maximum, seulement si l'info manque)

Plateforme/format, durée, ton, ressources (rushs, photos, logo, texte à afficher, musique imposée). Défauts : vertical `1080x1920` pour TikTok/Reels/Shorts, `1920x1080` pour YouTube, 15–30 s pour une pub, −14 LUFS. Ne demande pas ce que tu peux décider.

## 2. Écouter avant de monter

`cutkiller_listen` / `cutkiller listen <fichier> [--beats] [--transcribe]` sur chaque source avec parole. Lis : part de silence (→ coupe utile ?), loudness (trop faible → `auto`/`mix` normalisent), saturation (non réparable : prévenir), bruit de fond. `--transcribe` active les sous-titres `.srt` et la coupe des « euh » (nécessite `faster-whisper`).

## 3. Choisir la recette

| Demande | Commande |
|---|---|
| Une vidéo face caméra / tuto / podcast à nettoyer | `auto video.mp4 --music "lofi chill" --transition "random:clean" --transition-every 3` (+ `--remove-fillers` si transcription dispo) |
| Plusieurs rushs et/ou photos → vidéo rythmée (pub, récap, reel) | `montage a.mp4 b.mp4 p.jpg --size 1080x1920 --music "upbeat" --beats-per-clip 2 --transition "random:dynamic" --sfx "whoosh@transitions"` |
| Seulement couper les blancs | `cut video.mp4` (`--dry-run` pour valider les segments avant un long rendu) |
| Seulement musique + SFX + loudness | `mix video.mp4 --music "…" --sfx "pop@2.5,8"` |
| Accroche, prix, appel à l'action, sous-titres | `text video.mp4 --text "SOLDES −50 %@0-3:center:yellow:9%" --text "Code PUB10@5-" --box` ; `--srt sous-titres.srt` |
| Sous-titres animés mot à mot (style TikTok) | `listen video.mp4 --transcribe` puis `captions video.mp4 --style tiktok` |
| Titre, compteur, bouton CTA, lower third, logo, flèche… animés | `animate <préréglage> clé=valeur --like video.mp4 -o anim.mov` puis `overlay video.mp4 --add "anim.mov@2"` |
| **Animation spécifique** (forme, mouvement, style de marque, idée originale) | **Skill `animation` : tu écris le code de l'animation toi-même**, tu regardes les images clés, puis tu incrustes avec `overlay` |
| Logo, image, light leak, vidéo fond vert par-dessus | `overlay video.mp4 --add "logo.png@0-3?pos=top-right&scale=0.2"` ; `--add "leak.mp4@4?mode=screen"` |
| Look pellicule / rétro (grain, Super 8, dither, vignettage) | `texture video.mp4 --grain 0.3 --vignette 0.4` ; vrai grain scanné : `--grain-file grain16mm.mov --grain-mode softlight` ; rétro : `--dither bayer --colors 16 --pixel 3` |
| Choisir une transition | `transitions list --tag glitch`, `transitions preview gl:Cube` |
| Choisir un son | `sounds search "whoosh" --kind sfx --max-duration 3` |

Ordre quand tu combines : **montage/auto → overlay (animations, logo) → texture (grain, dither) → captions/text** (le texte se grave en dernier, sur l'image finale, sans grain par-dessus). Ne superpose pas deux textes au même endroit au même instant : titre au centre, sous-titres dans le tiers bas (défaut de `captions`).

Réglages de transition : durée 0,2–0,4 s ; en face caméra, une transition toutes les 3 coupes au plus (`--transition-every 3`), jamais de 3D ni de glitch sur de la parole ; en pub, `random:dynamic` + `whoosh@transitions` ; en contenu posé, `fade` ou `random:clean`. `--seed N` rend un tirage aléatoire reproductible (utile pour refaire le même rendu).

## 3 bis. Sound design : un son par événement, calé sur son impact

`--sfx-kit` remplace le « même whoosh partout » : chaque événement reçoit le son qui lui correspond, et c'est le **pic** du son (ou son attaque) qui tombe sur la coupe, quelle que soit la longueur du fichier.

| Événement | Son | Calage |
|---|---|---|
| Plan d'ouverture (plan d'ensemble) | `focus` : bip/moteur d'autofocus | au début du plan |
| Whip, zoom, slide, spin | `whoosh` | pic du souffle sur la coupe |
| Flash blanc, arrêt sur image | `flash` : déclic d'appareil photo | attaque sur la coupe |
| Glitch, aberration chromatique | `glitch` | attaque sur la coupe |
| Coupe sèche sur le temps | `click` | attaque sur la coupe |
| Montée vers le premier gros raccord (après 3 s) | `riser` / build-up | sommet sur la coupe |
| Dernier plan, fin calme | `ambience` (pluie, ville, room tone) | nappe en fondu, très bas |
| Fondu, dissolution, volet doux | aucun | un whoosh sur un fondu sonne faux |

- **Montage rythmé, pub, reel cinématique** : `montage … --transition "fx:whip_left|fx:flash|fx:zoom_punch|fade" --transition-every 2 --sfx-kit cinematic` (des coupes sèches restent entre les transitions, elles reçoivent un clic).
- **Face caméra** : `auto … --sfx-kit minimal` (seulement le son des transitions ; jamais de clic sur les coupes de parole).
- **Pack de l'utilisateur** (ex. pack « SFX » d'un créateur, Freesound) : `CUTKILLER_SOUNDS_DIR=dossier`. Les fichiers sont trouvés par leur nom (« Whoosh Cinematic.wav », « Camera Focus.mp3 », « Jolt Build Up.wav », « Click 10.wav ») avant toute banque en ligne. Pour forcer un fichier : `--kit-sound whoosh=sons/w.wav` ; `--kit-volume -3` baisse tout le kit.
- `--sfx` reste disponible pour un son ponctuel ; ajoute `--sfx-align peak` (whoosh, riser) ou `onset` (clic, impact) pour le caler sur son impact plutôt que sur son début.
- Couple toujours le visuel et le son : un flash blanc sans déclic, ou un whoosh sans mouvement à l'image, se remarque.

## 4. Pubs : structure à respecter

1. **Accroche (0–3 s)** : plan le plus fort + texte court (≤ 7 mots) qui promet un bénéfice — `animate kinetic text="Le *secret* pour…"` ou `animate title`.
2. **Problème → solution / bénéfice** : 1 idée par plan, 2–3 s par clip (`--beats-per-clip 2` nerveux, `4` posé).
3. **Preuve** : chiffre, avis, avant/après, produit en situation.
4. **Appel à l'action (3 dernières secondes)** : `animate cta text="Commander"` (bouton qui pulse) ou texte plus gros (`:9%`), couleur contrastée, `--box` si le fond est chargé. Une seule action demandée. Chiffre clé : `animate counter to=12500 suffix=" clients"`.

Texte : 1 message par écran, lisible sans le son, hors du bas de l'écran (les marges de sécurité sont déjà gérées par `text`). Musique à −16 dB, qui baisse sous la voix (ducking activé par défaut).

## 5. Ressources manquantes

CutKiller ne **génère** ni images, ni clips, ni voix, ni musique originale : il assemble. Si l'utilisateur n'a pas de rushs et que des outils de génération sont connectés dans la session (vidéo, musique, voix off), génère les éléments avec eux, puis assemble avec CutKiller. Sinon demande les rushs/photos. Ne fabrique jamais d'images de produit ou d'avis clients pour une pub.

## 6. Vérifier avant de livrer

- Relance `listen` sur la sortie : durée attendue, loudness ≈ −14 LUFS, true peak < −1 dBTP.
- Regarde 2 à 4 images du résultat (`cutkiller_look`, ou `ffmpeg -ss 2 -i sortie.mp4 -frames:v 1 f.png` puis lire l'image) : texte lisible et dans le cadre, pas de chevauchement, animations au bon endroit.
- Rendu > ~40 s : l'outil renvoie un `job_id` → `cutkiller_job`. Ne relance pas le rendu en doublon.

## 7. Livrer

Donne : le **chemin du fichier**, la durée avant/après, ce qui a été fait (une ligne), et le **contenu du fichier `.credits.txt`** à coller en description (obligatoire pour les licences CC-BY / CC-BY-SA). Signale toute licence NC/ND : interdite en vidéo monétisée. Si un son n'a pas pu être téléchargé, dis lequel et ce qui l'a remplacé.

## Ressources gratuites à proposer quand il en manque

| Besoin | Où | Comment l'utiliser |
|---|---|---|
| SFX (500 000+ sons, CC0/CC-BY) | freesound.org | déjà branché : clé gratuite `FREESOUND_API_KEY`, ou fichiers téléchargés dans `CUTKILLER_SOUNDS_DIR` |
| Vrai grain Super 8 / 16 mm, burns, light leaks, poussières | packs de grain scanné (ex. Film Looks, pack gratuit) | `texture --grain-file` (fond gris → `softlight`/`overlay`, fond noir → `screen`) ; light leak ponctuel : `overlay --add "leak.mov@3?mode=screen"` |
| Look rétro tramé / ASCII | Ditherboy (navigateur) | ou directement `texture --dither bayer --pixel 3` |
| Polices gratuites avec associations | fontshare.com (Satoshi, Clash Display, General Sans… licence gratuite d'ITF, y compris en commercial) | télécharger le `.otf`, puis `text --font Satoshi-Bold.otf`, `captions --font …`, `animate --font …` |
| Modèles 3D | Sketchfab | CutKiller ne fait pas de 3D : rendu dans Blender (ou three.js dans une animation HTML), puis `overlay` |
| Exemples de motion design avec leurs prompts | prompt-motion.com | skill `animation`, § 3 bis (une entrée à la fois, créateur crédité) |

Vérifie toujours la licence de chaque ressource avant une vidéo commerciale, et ajoute les attributions demandées.

## Limites à annoncer (ne pas promettre)

- Pas de détourage de sujet, de morphing de visages ni de suivi d'objet (nécessitent de l'IA). Toute animation **2D** reste faisable : skill `animation`.
- Pas de timeline manuelle multipiste : l'ordre des plans = l'ordre des fichiers donnés.
- Transitions `gl:` : nécessitent `moderngl` + OpenGL ; sans carte graphique le rendu est logiciel et lent. Sans elles, 73 transitions restent disponibles (`xfade:` et `fx:`).
- Banques de sons : Openverse sans clé ; Freesound et Jamendo demandent une clé gratuite ; un dossier local (`CUTKILLER_SOUNDS_DIR`) passe en premier.
