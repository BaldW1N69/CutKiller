# CutKiller

Montage vidéo piloté par l'**écoute** : CutKiller analyse l'audio de ta vidéo pour couper les blancs et les hésitations, caler les coupes sur le rythme, ajoute **plus de 280 transitions** (et tes propres packs), un **sound design calé sur chaque transition**, des **animations** (préréglages, ou écrites sur mesure par Claude en Python ou en HTML), du grain argentique et des looks rétro, des sous-titres animés, puis une musique de fond et des SFX trouvés dans des banques de sons libres de droits, avec les crédits prêts à coller en description.

```bash
cutkiller auto video.mp4 --music "lofi chill" --sfx "whoosh@cuts"
```

```
1/4 Écoute…   13.0 s → 10.0 s, 3 coupes
2/4 Sons…     ♪ music « lofi chill » → Lofi House (openverse, by-sa)
              ♪ sfx   « whoosh »     → whoosh_soft (local)
3/4 Coupe…
4/4 Mixage…   Export : video_cutkiller.mp4   (-14 LUFS, prêt pour YouTube/TikTok)
              Crédits : video_cutkiller.credits.txt
```

## Installation

Prérequis : Python ≥ 3.10 et [ffmpeg](https://ffmpeg.org/download.html) dans le `PATH`.

```bash
pip install -e .
```

Options :

```bash
pip install -e ".[transcribe]"   # transcription : sous-titres, suppression des « euh »
pip install -e ".[gl]"           # 214 transitions GL (3D, glitch, light leaks…)
pip install -e ".[mcp]"          # serveur MCP (pour piloter CutKiller depuis Claude)
pip install -e ".[html]"         # animations HTML/CSS/JS (puis : playwright install chromium)
pip install -e ".[all]"          # tout
```

Vérifier l'installation (ffmpeg, OpenGL, options, banques de sons) :

```bash
cutkiller doctor
```

Les transitions GL utilisent OpenGL 3.3 : la carte graphique sur Windows/macOS/Linux, ou le rendu logiciel Mesa sur un serveur sans écran (`apt install libegl1 libgl1-mesa-dri`).

## Écoute : `cutkiller listen`

```bash
cutkiller listen video.mp4 --beats --transcribe
```

| Analyse | Ce que ça apporte au montage |
|---|---|
| **Silences / parole** | Seuil adaptatif (bruit de fond vs voix) : marche sans réglage sur micro-cravate comme sur prise bruitée |
| **Loudness EBU R128** | LUFS intégrés, true peak, plage dynamique, comparés à la cible (−14 LUFS YouTube/TikTok) |
| **Diagnostic qualité** | Alertes : audio trop faible/fort, saturation, true peak > −1 dBTP, bruit de fond élevé |
| **Tempo, beats, onsets** | BPM et grille de beats (numpy pur, sans librosa) pour couper ou placer des SFX en rythme |
| **Transcription** | Mots horodatés (faster-whisper), fichier `.srt` découpé pour shorts, détection des hésitations FR/EN |

Sorties : un résumé dans le terminal, `video.listen.json` (tous les horodatages) et `video.srt` si transcription.

## Coupe : `cutkiller cut`

```bash
cutkiller cut video.mp4                       # jump cuts sur les silences
cutkiller cut video.mp4 --remove-fillers      # + coupe les euh / um
cutkiller cut video.mp4 --dry-run             # affiche les segments sans rendre
```

- `--padding 0.08` : respiration gardée autour de la parole (évite les coupes sèches)
- `--min-silence 0.35` : un silence plus court est conservé (rythme naturel)
- `--threshold -40` : force le seuil en dBFS au lieu du mode automatique
- `--snap-to-onsets` : cale les coupes sur les attaques sonores
- Micro-fondus de 12 ms à chaque coupe : pas de clic audible
- `--punch-in 1.15` : **jump cut fix**. Le cadrage alterne entre plan normal et plan resserré à chaque coupe, ce qui transforme les sauts d'image en changements de plan volontaires. Le zoom s'étale sur 3 images à cheval sur la coupe (`--punch-ramp`, 0 = coupe sèche) et se centre un peu au-dessus du milieu, sur le visage (`--punch-focus 0.5,0.4`). Motif libre : `--punch-pattern 1,1.15,1,1.3` (zoom avant pour appuyer une phrase, retour au large pour expliquer). Garde au moins 10 % d'écart, sinon ça ressemble à un bug, et pas plus de 135 %. Un plan voisin d'une transition reste non recadré.

## Mixage : `cutkiller mix`

```bash
cutkiller mix video.mp4 --music "epic cinematic" --sfx "pop@2.5,8" --sfx "hit@beats:4"
cutkiller mix video.mp4 --music ma_musique.mp3 --music-volume -18 --music-start 12
```

- **Ducking automatique** : la musique baisse dès que tu parles (compresseur sidechain), remonte dans les blancs
- **Boucle et fondus** : un morceau trop court est bouclé ; fondu d'entrée et de sortie
- **SFX positionnés** : `source@cuts` (chaque coupe), `source@transitions` (seulement les coupes avec transition), `source@1.5,8` (instants précis), `source@beats:4` (un beat sur 4 de la musique). `--sfx-offset` décale le SFX avant la coupe, `--sfx-spacing` évite d'en mettre trop.
- **Calage sur l'impact** : `--sfx-align peak` cale le maximum du son sur la position (whoosh, riser), `onset` son attaque (clic, impact) ; par défaut `start` (début du fichier + `--sfx-offset`).
- **Normalisation finale** à `--target-lufs` (−14 par défaut)
- `source` peut être un fichier local ou une requête texte cherchée dans les banques

### Sound design automatique : `--sfx-kit`

```bash
cutkiller montage a.mp4 b.mp4 c.mp4 d.mp4 --music "cinematic" --transition "fx:whip_left|fx:flash|fx:zoom_punch|fade" \
  --transition-every 2 --sfx-kit cinematic
cutkiller auto interview.mp4 --transition "random:dynamic" --transition-every 3 --sfx-kit minimal
```

Chaque événement reçoit **le son qui lui correspond**, et c'est le **pic** (ou l'attaque) du son, mesuré dans le fichier, qui tombe sur la coupe :

| Événement | Rôle | Calage |
|---|---|---|
| plan d'ouverture | `focus` (autofocus) | attaque au début du plan |
| whip, pull-out, zoom, slide, spin | `whoosh` (deep whoosh) | pic sur la coupe |
| flash, glare, light leak, film burn | `flash` (déclic d'obturateur) | sur le pic de lumière |
| glitch, aberration chromatique, datamosh | `glitch` | attaque sur la coupe |
| secousse caméra, rebond | `impact` | attaque sur la coupe |
| grille, tuiles, mosaïque, pixels | `sparkle` (scintillement) | attaque sur la coupe |
| coupe sèche (montage) | `click` | attaque sur la coupe |
| premier gros raccord après 3 s | `riser` (build-up) | sommet sur la coupe |
| dernier plan | `ambience` (pluie, ville) | nappe bouclée en fondu, −24 dB |
| fondu, dissolution, volet doux | aucun | |

`cinematic` = tout le tableau ; `minimal` = seulement le son des transitions (et jamais de clic sur les coupes de parole avec `auto`). Les sons viennent d'abord de **ton dossier** (`CUTKILLER_SOUNDS_DIR` : par exemple le pack d'un créateur, « Whoosh Cinematic.wav », « Camera Focus.mp3 », « Jolt Build Up.wav »), puis des banques libres de droits. `--kit-sound whoosh=sons/w.wav` force un son, `--kit-volume -3` règle tout le kit.

## Utiliser CutKiller depuis Claude (skills + serveur MCP)

Deux skills et un serveur MCP font de CutKiller la base de tout montage demandé à Claude :

| Composant | Rôle |
|---|---|
| Skill `montage` | Se déclenche sur « montage, pub, vidéo, reel… » : cadrage, écoute, recette, structure de pub, vérifications, livraison avec crédits |
| Skill `animation` | Décide si un préréglage suffit ou si **Claude prend le relais** : il écrit lui-même l'animation (script Python, ASS ou GLSL), regarde les images clés, puis rend et incruste |
| Serveur MCP (19 outils) | Tourne **sur ta machine** : Claude lit et écrit tes vraies vidéos. `cutkiller_animate_code` et `cutkiller_look` renvoient des images, donc Claude voit ce qu'il produit |

**Dans ce dépôt, rien à installer côté Claude.** Les skills sont dans `.claude/skills/` et le serveur MCP dans `.mcp.json` : Claude Code les charge à l'ouverture du dossier (il demande d'approuver le serveur MCP la première fois). Il faut seulement CutKiller lui-même :

```bash
pip install -e ".[all]"
```

**Dans tous tes projets** (pas seulement ce dépôt) : installe le plugin. Le dépôt déclare déjà sa marketplace dans `.claude/settings.json`, donc après avoir ouvert et approuvé le dossier une fois, il suffit de :

```bash
claude plugin install cutkiller@cutkiller
```

Sans passer par le dossier : `claude plugin marketplace add BaldW1N69/CutKiller` d'abord. Pour tester sans installer : `claude --plugin-dir .`. Le serveur MCP est lancé par `python -m cutkiller.mcp_server` : sur macOS/Linux où seul `python3` existe, utilise `claude mcp add cutkiller -- python3 -m cutkiller.mcp_server`.

**Claude Desktop** (serveur MCP seul) : ajoute dans `claude_desktop_config.json`

```json
{
  "mcpServers": {
    "cutkiller": { "command": "python", "args": ["-m", "cutkiller.mcp_server"] }
  }
}
```

Les scripts d'animation écrits par Claude via MCP sont enregistrés dans `~/CutKiller/animations` (modifiable avec `CUTKILLER_ANIM_DIR`). Les rendus longs renvoient un `job_id` après ~40 s, à suivre avec `cutkiller_job`.

## Texte incrusté : `cutkiller text`

```bash
cutkiller text video.mp4 --text "SOLDES −50 %@0-3:center:yellow:9%" --text "Code PUB10\nlivraison offerte@5-" --box
cutkiller text video.mp4 --srt sous-titres.srt --srt-position center
```

Format : `texte@début-fin[:position[:couleur[:taille%]]]` (fin vide = jusqu'à la fin ; position `top|center|bottom`). Marges de sécurité réseaux sociaux, fondu d'entrée/sortie, fond semi-transparent avec `--box`. Rendu par libass : fonctionne identiquement sous Windows, macOS et Linux.

`--font` accepte un nom de police installée **ou un fichier** `.ttf`/`.otf` non installé, par exemple une police gratuite de [Fontshare](https://www.fontshare.com) : `--font Satoshi-Bold.otf` (idem pour `captions`).

## Animations : `cutkiller animate`

```bash
cutkiller animate --list
cutkiller animate kinetic text="Le *secret* d'une peau parfaite" --like video.mp4 -o accroche.mov
cutkiller animate counter to=12500 suffix=" clients" label="en 2026" -o chiffre.mov
cutkiller animate cta text="Commander" --preview 0.5,1.5      # images clés PNG, sans rendu
```

12 préréglages : `title`, `slide`, `typewriter`, `kinetic` (mot par mot, `*mot*` en surbrillance), `lower_third`, `counter`, `cta` (bouton qui pulse), `progress`, `logo`, `confetti`, `circle_highlight`, `arrow`. Le texte trop large est réduit automatiquement.

**Animation sur mesure** : un script Python avec une fonction `frame(t, ctx)` qui renvoie une image RGBA. C'est ce que Claude écrit quand il prend le relais (voir `.claude/skills/animation/SKILL.md`).

```python
DURATION = 3.0
def frame(t, ctx):
    img = ctx.blank()
    p = ctx.prog(t, 0, 0.6, "out_back")
    return ctx.text(img, "NOUVEAU", (0.5, 0.5), size=0.08, scale=p, rotate=(1 - p) * 90, color="yellow")
```

```bash
cutkiller animate mon_anim.py --like video.mp4 --preview 0.3,1,2   # vérifier
cutkiller animate mon_anim.py --like video.mp4 -o mon_anim.mov     # rendre
```

**Animation HTML** (CSS, JS, canvas, SVG, WebGL) : le format de la plupart des prompts de motion design pour Claude (démos d'interface, vidéos de lancement, typo cinétique, graphiques). CutKiller ouvre la page dans un Chromium sans écran et **pilote son horloge image par image** : rendu exact, sans saccade, fond transparent.

```bash
cutkiller animate lancement.html --like video.mp4 --preview 0.5,1.5,3   # images clés
cutkiller animate lancement.html --like video.mp4 -o lancement.mov      # ProRes 4444 avec alpha
```

Temps : la page définit `window.cutkillerSeek(t)` (le plus fiable), ou utilise simplement des animations CSS, `requestAnimationFrame`, `performance.now()` : tout suit le temps de la vidéo. Durée : `--duration`, `<meta name="duration" content="3">`, `window.DURATION`, sinon la fin des animations CSS. `window.CUTKILLER = {width, height, fps, duration, params}` est fourni avant le chargement. Prérequis : `pip install -e ".[html]"` puis `playwright install chromium` (ou `CUTKILLER_CHROMIUM=/chemin/vers/chrome`).

Des exemples avec leurs prompts : [Prompt Motion](https://prompt-motion.com) (galerie de 230+ animations faites avec Claude). Les prompts appartiennent à leurs créateurs : sers-t'en comme d'un brief, une entrée à la fois, et crédite l'auteur.

Sortie : `.mov` ProRes 4444 avec transparence (par défaut, accepté par Premiere, DaVinci, Final Cut, CapCut), `.webm` VP9 avec transparence (léger), `.mp4` (fond noir), `.png` (une image).

## Look, grain, pellicule, rétro : `cutkiller texture`

```bash
cutkiller texture video.mp4 --look cinematic                                  # look complet
cutkiller texture video.mp4 --look night --letterbox 2.39                     # + bandes cinéma
cutkiller texture video.mp4 --grain 0.3 --vignette 0.4                       # grain argentique procédural
cutkiller texture video.mp4 --grain-file grain16mm.mov --grain-mode softlight # vrai grain scanné, bouclé
cutkiller texture video.mp4 --dither bayer --colors 16 --pixel 3              # look rétro tramé
```

| Option | Effet |
|---|---|
| `--look` | `cinematic` (teal & orange, noirs profonds, netteté, lueur, grain léger), `night` (vert-orange, lueur forte : le look « CapCut » nuit/pluie), `film` (chaud, grain), `noir` (N&B contrasté), `retro` (tramé) ; les autres options le modifient |
| `--grade` | étalonnage : `teal_orange`, `green_orange`, `warm`, `cold`, `bleach`, `bw` |
| `--contrast`, `--sharpen`, `--glow` 0..1 | noirs profonds, netteté (le « 4K » des applis), lueur des hautes lumières (« luminescence ») |
| `--letterbox 2.39` | bandes cinéma (pour du 16:9 ; sur du vertical il ne reste qu'une bande) |
| `--grain 0..1` | grain sur la luminance, renouvelé à chaque image (0.25 discret, 0.5 marqué) |
| `--grain-file` | pellicule scannée (Super 8, 16 mm, poussières, rayures, burns), bouclée sur toute la vidéo. Fond gris 50 % → `--grain-mode overlay`/`softlight` ; fond noir → `screen`. `--grain-opacity` |
| `--dither` | palette réduite + trame : `bayer` (trame ordonnée, rétro), `floyd_steinberg`, `sierra2_4a`, `heckbert` ; `--colors 2..256`, `--pixel N` = gros pixels |
| `--vignette 0..1` | assombrit les bords |

Ordre : étalonnage → contraste → netteté → lueur → dither → grain → scan → vignettage → bandes. Le son est copié tel quel. À faire avant `text`/`captions` pour garder le texte net.

## Incrustation : `cutkiller overlay`

```bash
cutkiller overlay video.mp4 --add "accroche.mov@0.3" --add "logo.png@0?pos=top-right&scale=0.18" \
  --add "lightleak.mp4@4.5?mode=screen" --add "fondvert.mp4@6?mode=green&pos=bottom&scale=0.5"
```

Format d'un calque : `SOURCE@DÉBUT[-FIN]?pos=…&scale=…&mode=…&opacity=…`
- `pos` : `center`, `top`, `bottom-right`… ou `x,y` (0..1).
- `scale` : largeur relative à la vidéo.
- `mode` : `alpha` (transparence), `green` (fond vert), `screen` (fond noir : light leaks, flares, particules).

## Sous-titres animés : `cutkiller captions`

```bash
cutkiller listen video.mp4 --transcribe
cutkiller captions video.mp4 --style tiktok          # tiktok | bold | karaoke | minimal
```

Groupes de 1 à 4 mots ; le mot prononcé change de couleur et « pop ». Les hésitations sont retirées. Placement par défaut dans le tiers bas, zone habituelle des sous-titres TikTok. Pour un effet de texte très précis, `cutkiller text video.mp4 --ass mon_effet.ass` grave un script ASS écrit à la main (balises libass `\move`, `\t`, `\fad`, `\k`…).

## Transitions

```bash
cutkiller cut video.mp4 --transition fade
cutkiller auto video.mp4 --transition "random:dynamic" --transition-every 3 --sfx "whoosh@transitions"
cutkiller transitions list --tag glitch          # catalogue filtrable
cutkiller transitions preview gl:Cube            # aperçu vidéo
cutkiller transitions gallery ./galerie          # toutes les transitions + page index.html
```

| Famille | Nombre | Moteur | Exemples |
|---|---|---|---|
| `xfade:` | 58 | ffmpeg natif, le plus rapide | fade, dissolve, wipes, slides, circleopen, pixelize, zoomin, radial… |
| `gl:` | 214 | shaders [gl-transitions](https://gl-transitions.com) (MIT) | Cube, WhipPan, CameraShake, GlitchMemories, FilmBurn, LensFlare, BookFlip, Ripple, Swirl… |
| `fx:` | 15 | CPU (numpy), sans OpenGL | zoom_punch, whip_left, shake, glitch, flash, spin, light_leak, rgb_split… |
| `pack:` | illimité | tes vidéos de transition | fond vert, canal alpha (.mov/.webm) ou fond noir (light leaks, encre) |
| `luma:` | illimité | tes masques en niveaux de gris | n'importe quelle forme de volet (`?softness=0.2&invert=true`) |
| `glsl:` | illimité | tes shaders au format gl-transitions | `glsl:mon_effet.glsl` |
| `xfade:custom` | illimité | expression ffmpeg | `xfade:custom?expr=if(gt(X,W*P),A,B)` |

**Choisir les transitions**
- Une seule : `--transition gl:WhipPan`
- Avec paramètres : `--transition "gl:WhipPan?direction=0,1&blur=0.6"` (voir `cutkiller transitions info gl:WhipPan`)
- Au hasard dans un thème : `random`, `random:glitch`, `random:3d`, `random:zoom`, `random:clean`… (`cutkiller transitions tags`)
- Au hasard dans une liste : `"fade|gl:Cube|fx:zoom_punch"` ; `--seed 42` rend le tirage reproductible
- Fréquence : `--transition-every 3` (une coupe sur trois), `--transition-min-gap 5` (au moins 5 s d'écart)
- Durée : `--transition-duration 0.4` ; un `pack:` garde sa propre durée

**Comment c'est assemblé**
- Comme dans un logiciel de montage, la transition est centrée sur la coupe et utilise les images situées juste avant et juste après le passage gardé. La vidéo n'est pas raccourcie et la parole n'est pas recouverte. Sans ces images, CutKiller chevauche les deux plans, et la vidéo raccourcit d'autant.
- Tout est calculé à l'image près : aucune dérive, même avec des centaines de coupes.
- Pour un `pack:`, la coupe est cachée à l'instant où le pack couvre le plus l'écran. Le mode de détourage est choisi tout seul : fond vert, canal alpha ou fond noir. On peut l'imposer avec `?mode=green|alpha|screen`.
- Son : `--audio-fade` règle le fondu croisé à chaque coupe. `--jl 0.3` donne un L-cut (le son du plan A déborde sur l'image B), `--jl -0.3` un J-cut (le son de B arrive avant son image).

## Montage multi-clips : `cutkiller montage`

```bash
cutkiller montage rush/*.mp4 photos/*.jpg --size 1080x1920 --music "upbeat" \
  --beats-per-clip 4 --transition "random:dynamic" --sfx "whoosh@transitions"
```

- Chaque coupe tombe sur un temps de la musique. Un clip trop court décale une coupe, et la suivante se recale sur la grille.
- Extraits pris au centre de chaque rush, ce qui laisse des images libres de chaque côté pour les transitions.
- Photos animées avec un zoom lent (effet Ken Burns).
- Format libre : vertical `1080x1920`, horizontal `1920x1080`, carré… `--fit crop|pad|stretch` choisit comment adapter chaque source.
- `--keep-audio` garde le son des clips, avec la musique baissée dessous.

## Banques de sons : `cutkiller sounds`

```bash
cutkiller sounds providers                                   # état des banques
cutkiller sounds search "whoosh" --kind sfx --max-duration 3
cutkiller sounds search "lofi" --kind music --min-duration 60
cutkiller sounds get "applause" --pick 2 --dest ./sons
```

| Banque | Contenu | Configuration |
|---|---|---|
| **Local** | Ton dossier de sons (packs achetés, enregistrements) | `CUTKILLER_SOUNDS_DIR=/chemin/vers/sons` |
| **Openverse** | Agrège Freesound, Jamendo, ccMixter, Wikimedia… | aucune clé |
| **Freesound** | Plus de 600 000 SFX | `FREESOUND_API_KEY` ([clé gratuite](https://freesound.org/apiv2/apply)) |
| **Jamendo** | Musique d'artistes indépendants | `JAMENDO_CLIENT_ID` ([client_id gratuit](https://devportal.jamendo.com)) |

Ordre de recherche : local → Openverse → Freesound → Jamendo. Les fichiers téléchargés sont mis en cache (`~/.cache/cutkiller/sounds`). Si un fichier est refusé par son serveur, CutKiller passe automatiquement au résultat suivant.

### Licences

Par défaut, seules les licences **compatibles avec une vidéo monétisée** sont proposées : CC0, domaine public, CC-BY, CC-BY-SA. Les licences **NC** (pas d'usage commercial) et **ND** (pas de modification ; caler une musique sur une vidéo compte comme une modification) sont exclues. `--allow-nc` les inclut, marquées `[licence restreinte]`, pour un usage personnel.

Chaque export écrit un fichier `.credits.txt` avec les attributions exigées par les licences CC-BY. Copie-le en description.

> Ce n'est pas un avis juridique : vérifie la licence sur la page source (lien dans les crédits) avant une utilisation commerciale importante.

## Développement

```bash
pip install -e ".[dev,html]"
pytest                 # tests hors réseau (médias de test générés à la volée ; tests HTML ignorés sans Chromium)
pytest -m network      # + appel réel à Openverse
```

```
cutkiller/
  media.py            ffprobe / ffmpeg, décodage audio → numpy
  listen/             silences, loudness, beats, transcription, rapport
  edit/               coupes, timeline (transitions, raccords audio), montage, mixage, texte, sous-titres animés, incrustation, textures
  transitions/        registre + moteurs xfade / gl / fx, aperçus et galerie
  sounds/             banques de sons, cache, crédits, kits de sound design (kit.py)
  animate/            moteur d'animation (frame(t, ctx) → vidéo à alpha) + 12 préréglages + pages HTML (html.py)
  mcp_server.py       serveur MCP (19 outils, rendus en jobs, aperçus renvoyés en images)
  cli.py              commandes listen / cut / mix / auto / montage / text / captions / animate / texture / overlay / transitions / sounds / doctor
.claude/skills/       skills Claude : montage (recettes, pub, vérifications) et animation (relais : Claude code l'animation)
.claude/settings.json déclare la marketplace du plugin
.claude-plugin/       manifeste du plugin + marketplace
.mcp.json             déclaration du serveur MCP du plugin
```

## Crédits

Les transitions `gl:` viennent de [gl-transitions](https://github.com/gl-transitions/gl-transitions) (licence MIT, 2 shaders sous licence BSD, voir `cutkiller/transitions/GL_TRANSITIONS_LICENSE` et `cutkiller transitions info <nom>` pour l'auteur de chacune).
