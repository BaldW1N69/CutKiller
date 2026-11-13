# CutKiller

Montage vidéo piloté par l'**écoute** : CutKiller analyse l'audio de ta vidéo pour couper les blancs et les hésitations, caler les coupes sur le rythme, puis ajoute une musique de fond et des SFX trouvés dans des banques de sons libres de droits, avec les crédits prêts à coller en description.

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

Pour la transcription (sous-titres, suppression des « euh ») :

```bash
pip install -e ".[transcribe]"
```

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
- **SFX positionnés** : `source@cuts` (chaque coupe), `source@1.5,8` (instants précis), `source@beats:4` (un beat sur 4 de la musique). `--sfx-offset` décale le SFX avant la coupe, `--sfx-spacing` évite d'en mettre trop.
- **Normalisation finale** à `--target-lufs` (−14 par défaut)
- `source` peut être un fichier local ou une requête texte cherchée dans les banques

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
  edit/               liste de coupes, rendu jump cuts, mixage (ducking, SFX, loudnorm)
  sounds/             banques de sons, cache, crédits
  cli.py              commandes listen / cut / mix / auto / sounds
```
