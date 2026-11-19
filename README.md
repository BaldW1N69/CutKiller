# CutKiller

Montage et motion design calés sur la musique, en 3 étapes inspectables :

```
musique ──► analyse audio (beats, temps forts, énergie, drop) ─┐
vidéos  ──► analyse vidéo (plans, mouvement, luminosité)  ─────┼─► plan JSON ─► rendu (ffmpeg | Remotion)
```

Deux modes :

| Mode | Usage | Moteur |
|---|---|---|
| `cut` | découpe des rushes existants au rythme de la musique | ffmpeg (rapide) ou Remotion (effets + titre) |
| `motion` | génère un motion design (aquarelle, titre, accents) synchronisé sur les temps | Remotion |

## Installation

```bash
make setup        # venv Python + npm ci dans studio/
make test         # 8 tests sur médias synthétiques à vérité terrain connue
make demo         # génère musique/rushes de démo et rend les deux modes dans out/
```

Prérequis : Python ≥ 3.10, Node ≥ 20, ffmpeg. Pour Remotion, un Chrome headless est détecté automatiquement
(sinon `CUTKILLER_BROWSER=/chemin/vers/chrome`).

## Utilisation

```bash
# Découper des rushes sur une musique (9:16, 30 s à partir de 0:45)
cutkiller cut musique.mp3 rush1.mp4 rush2.mp4 --aspect 9:16 --start 45 --duration 30 -o out.mp4

# Motion design : révélation du titre sur le 1er temps fort, zoom avant sur le temps fort suivant
cutkiller motion musique.mp3 --title "Opus Flow" --subtitle "on the beat" \
  --palette "#FFEDD3,#FEB649,#895834" -o motion.mp4

# Pas à pas (chaque étape écrit un JSON modifiable à la main)
cutkiller analyze-audio musique.mp3 -o beats.json --click verif.wav   # verif.wav : musique + clics
cutkiller analyze-video rush*.mp4 -o rushes.json
cutkiller plan-cut beats.json rushes.json --audio musique.mp3 -o plan.json
cutkiller preview plan.json -o planche.png      # images clés avant le rendu complet
cutkiller render plan.json -o out.mp4 --engine ffmpeg
```

Options utiles de `cut` : `--density auto|beat|half|bar`, `--order energy|chronological`,
`--offset N` (couper N images avant le temps), `--title`, `--grid auto|fixed|tracked|dynamic`, `--bpm` (indice).

## Ce qui améliore le pipeline « naïf » (librosa `beat_track` + coupes)

**Audio** (`cutkiller/audio.py`)
- **Grille de tempo globale** quand le morceau est stable : retrouve les temps des intros calmes que le tracker
  de librosa supprime, et ne bascule jamais sur le contretemps.
- **Calage pondéré sur les basses** (grosse caisse/basse) : évite de se caler sur les accords à contretemps.
- **Mode `tracked`** activé automatiquement si la grille dérive (musique jouée live) : suit le tempo par fenêtres
  sans pouvoir sauter d'un demi-temps.
- **Correction d'octave** : un 72 BPM n'est plus lu comme 144.
- **Premiers temps de mesure** déduits des attaques graves ; **sections** basse/moyenne/haute énergie ; **drop**.

**Montage** (`cutkiller/plan.py`)
- **Densité adaptative** : une coupe par mesure quand c'est calme, tous les 2 temps en énergie moyenne,
  à chaque temps sur le drop.
- **Choix des plans** : mouvement du plan ↔ énergie de la musique, jamais à cheval sur une coupe d'origine,
  plans noirs écartés, pas de réutilisation ni de répétition immédiate. Mode chronologique pour garder l'histoire.

**Motion design** (`studio/src/MotionDesign.tsx`)
- Durées exprimées **en temps musicaux** : le même design est aérien à 72 BPM et percutant à 128 BPM.
- Révélation aquarelle et pinceau sec qui se termine **sur** le temps fort ; titre qui finit net (flou à 0).

**Rendu** (`cutkiller/render.py`)
- ffmpeg : segments encodés **en parallèle et mis en cache**, puis assemblés sans réencodage.
  Après une retouche du plan, seuls les clips modifiés sont réencodés (≈1,5 s au lieu de 30 s).
- Exactitude à l'image près vérifiée par les tests ; polices embarquées (rendus hors ligne et reproductibles).

## Limites connues

- Les premiers temps de mesure sont estimés par heuristique : fiable sur de la musique avec grosse caisse,
  moins sur de l'ambient ou du classique. `--bpm`, `--meter` et `--grid` permettent de corriger.
- Le style aquarelle est en SVG (déterministe). p5.brush donnerait des textures plus riches, mais il faut le
  rendre déterministe image par image avant de l'intégrer.
