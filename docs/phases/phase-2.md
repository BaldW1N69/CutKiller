# Phase 2 — Montage

## Livré

### Analyse (workers Python)

- **`transcribe`** : faster-whisper `large-v3-turbo` au mot, avec un prompt disfluent pour que Whisper écrive les « euh ». Deux traitements suivent :
  - un alignement forcé CTC wav2vec2 français (Apache-2.0), puis un affinage des frontières sur l'énergie du signal ;
  - une seconde passe ciblée : les mots anormalement longs pour leur nombre de lettres sont re-transcrits localement (fenêtres regroupées par lots de 28 s). Une hésitation qui y apparaît est ré-alignée et séparée du mot.
- **`vad`** : Silero VAD, qui sert aussi à écarter les hallucinations de l'ASR sur la musique ou le silence.
- **`beats`** : librosa, avec des beats recalés à l'échantillon sur l'attaque réelle.
- **Convention temporelle unique** : t = 0 correspond au début du conteneur, y compris quand l'audio et la vidéo démarrent décalés.
- **Cache par contenu** (`.cache/analysis`) et analyse écrite à côté de l'EDL (`<edl>.analysis.json`).

### Passe `cut`

- **Hésitations** : retrait systématique des hésitations (liste dans le profil), retrait des marqueurs contextuels (« donc », « bon », « en fait »…) seulement quand des pauses les isolent, retrait de la première prise d'un faux départ (« il n'y a plus d'autres il n'y a plus d'autres états »).
- **Silences > 350 ms** coupés, pauses naturelles plus courtes conservées. Marges de 80–120 ms autour des mots, qui ne débordent jamais sur la matière retirée.
- **Coupes sur les beats** :
  - jump cuts : les marges sont ajustées dans leur plage pour atteindre le beat le plus proche ;
  - zoom-cuts : ils sont posés exactement sur le beat.
- **Zoom-cuts** (changement de cadrage sur audio continu, sans fondu) pour qu'aucun plan ne dépasse 4 s (court) ou 8 s (long). Les cadrages alternent large / serré (108, 112, 106, 110 %), et deux punch-ins consécutifs n'ont jamais le même niveau. Les plans sans parole (B-roll, image fixe) sont traités de la même façon.
- **Traçabilité** : chaque clip indique ses mots (`wordIds`) et ce qui a été coupé avant lui (`why.note`).

### Rendu

- **Cadrage statique par clip** (`transform`), appliqué au décodage, donc sans perte de résolution.
- **Correctif de synchro A/V** : l'audio de chaque source est converti une fois en WAV sur la timeline du conteneur, et la vidéo est recalée avec `fps=start_time=0`. Couvert par un test « flash + bip » sur des flux décalés d'une seconde.
- **Stem voix** (`<vidéo>.voice.wav`) exporté pour la QA.

### QA

Contrôles ajoutés :
- `montage.silences` : VAD indépendante sur le rendu, plus les marges ;
- `montage.fillers` : re-transcription du rendu ;
- `montage.beat-cuts` : fenêtre d'atteignabilité identique à celle du planificateur ;
- `montage.static-shots` ;
- `montage.punch-ins`.

## Tests

```sh
pnpm check && pnpm typecheck && pnpm test
(cd workers && uv run pytest)   # dont la précision au mot (marqueur `models`, ~3 Go de modèles)
```

## Mesures

| Mesure | Résultat |
|---|---|
| Écart de frontière au mot, voix française synthétique (vérité terrain à l'échantillon) | Whisper seul : médiane ~100 ms, p95 238 ms. Avec alignement forcé + affinage : **p95 9 ms, max 10 ms** |
| Beats (piste de clics à 120 BPM) | Erreur < 5 ms |
| Synchro A/V avec flux décalés d'1 s | Flash et bip à ±1 frame |

## Score qualité (boucle sur rushes réels)

Rushes : entretien brut en français (Global Lives Project, CC BY 3.0, 640×360 à 23,976 fps) et musique CC0 à 92 BPM (voir `fixtures/rushes.json`). Rendus en `--draft`.

| Rendu | Montage | Score | Couverture |
|---|---|---|---|
| Long 16:9, 180 s de rush | 8 hésitations + 1 faux départ retirés, 28,7 s coupées, 51 plans | **100/100** | 31 % |
| Court 9:16, 60 s de rush | 3 hésitations + 5 mots de faux départ retirés, 8,4 s coupées, 23 plans | **100/100** | 31 % |
| Fixture vocale synthétique + clics 120 BPM | 2 hésitations retirées, 5 plans | **100/100** | 31 % |

Les 69 % non évalués correspondent aux règles des phases 3 à 6 (motion, sous-titres, loudness et ducking, recadrage, étalonnage).

Corrigé pendant la boucle :
- désynchronisation audio/vidéo sur des flux décalés ;
- ponctuation isolée (« ») prise pour une hésitation ;
- hésitation découpée qui chevauchait le mot suivant (marges à 0 ms) ;
- coupes libres mal évaluées après un zoom-cut ;
- faux « clic » : un coup de grosse caisse sous une coupe calée sur le beat ;
- hésitation comptée deux fois par la passe de re-scan.

### Ce qu'un monteur pro critiquerait encore

1. **Rythme mécanique** : toutes les pauses > 350 ms sont coupées de la même façon, y compris les silences qui portent du sens (après une chute, avant une révélation). Il faudrait pouvoir garder une pause intentionnelle, repérée par la prosodie ou la ponctuation forte.
2. **Pas de distinction des voix** : les questions de l'intervieweur sont conservées comme le reste. Un monteur les coupe ou les garde volontairement, ce qui suppose une diarisation.
3. **Image** : des punch-ins de 106-112 % sur une source 640×360 agrandie donnent une image molle, et le pulldown 24→30 fps saccade sur les mouvements (phase 6 / fps d'export).
4. **Musique plate** : volume constant à -12 dB, sans ducking sous la voix ni fin sur une mesure (phase 5).
5. **Monotonie visuelle** : ni sous-titres, ni animation, ni B-roll. L'alternance large/serré est la seule variation (phases 3, 4 et 6).

## Limites connues

- **Précision au mot sur de la vraie parole** : elle n'est mesurée que sur la voix synthétique. Il faut 2-3 minutes annotées à la main pour chiffrer l'écart réel (probablement 20-40 ms au p95 d'après la littérature ; à confirmer).
- **Voyelles traînées** (« depuuuis ») : ce ne sont pas des « euh », elles ne sont donc pas coupées. Un monteur les raccourcirait parfois.
- **Coupes sur les beats** : un jump cut n'a qu'environ 80 ms de marge pour tomber sur un beat, donc la majorité des coupes de parole restent hors beat (exemptées par la règle reformulée). Seuls les zoom-cuts sont systématiquement calés.
- **J/L cuts** : disponibles dans l'EDL mais **pas générés automatiquement**. Sur une caméra unique, décaler l'audio de 4-12 frames montre des lèvres désynchronisées. Ils seront utilisés quand il y aura du B-roll ou du multicam.
- **Pulldown** : des rushes à 23,976 fps exportés en 30 fps répètent une image sur quatre (saccade). La QA les considère comme expliqués par la source, et un avertissement est émis au `plan`. Une interpolation de mouvement dégraderait l'image : la vraie solution est d'autoriser l'export au fps source.
- **Respirations fortes** : retirées quand elles tombent dans un silence > 350 ms, mais pas encore détectées ni atténuées à l'intérieur des pauses courtes (prévu en phase 5, avec l'audio).
- **Temps de calcul** sur CPU 4 cœurs : analyse ≈ 1,5 à 2× le temps réel, contrôle QA des hésitations ≈ 1× le temps réel.
