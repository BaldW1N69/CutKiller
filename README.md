# CutKiller

Montage vidéo piloté par l'**écoute** : CutKiller analyse l'audio de ta vidéo pour couper les blancs et les hésitations, caler les coupes sur le rythme, ajoute **plus de 280 transitions** (et tes propres packs), puis une musique de fond et des SFX trouvés dans des banques de sons libres de droits, avec les crédits prêts à coller en description.

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
pip install -e ".[all]"          # tout
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

## Mixage : `cutkiller mix`

```bash
cutkiller mix video.mp4 --music "epic cinematic" --sfx "pop@2.5,8" --sfx "hit@beats:4"
cutkiller mix video.mp4 --music ma_musique.mp3 --music-volume -18 --music-start 12
```

- **Ducking automatique** : la musique baisse dès que tu parles (compresseur sidechain), remonte dans les blancs
- **Boucle et fondus** : un morceau trop court est bouclé ; fondu d'entrée et de sortie
- **SFX positionnés** : `source@cuts` (chaque coupe), `source@transitions` (seulement les coupes avec transition), `source@1.5,8` (instants précis), `source@beats:4` (un beat sur 4 de la musique). `--sfx-offset` décale le SFX avant la coupe, `--sfx-spacing` évite d'en mettre trop.
- **Normalisation finale** à `--target-lufs` (−14 par défaut)
- `source` peut être un fichier local ou une requête texte cherchée dans les banques

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
pip install -e ".[dev]"
pytest                 # tests hors réseau (médias de test générés à la volée)
pytest -m network      # + appel réel à Openverse
```

```
cutkiller/
  media.py            ffprobe / ffmpeg, décodage audio → numpy
  listen/             silences, loudness, beats, transcription, rapport
  edit/               coupes, timeline (transitions, raccords audio), montage, mixage
  transitions/        registre + moteurs xfade / gl / fx, aperçus et galerie
  sounds/             banques de sons, cache, crédits
  cli.py              commandes listen / cut / mix / auto / sounds
```

## Crédits

Les transitions `gl:` viennent de [gl-transitions](https://github.com/gl-transitions/gl-transitions) (licence MIT, 2 shaders sous licence BSD, voir `cutkiller/transitions/GL_TRANSITIONS_LICENSE` et `cutkiller transitions info <nom>` pour l'auteur de chacune).
