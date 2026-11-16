# CutKiller — Base de connaissances montage

Mémoire de référence de l'agent de montage. Chaque règle est formulée pour être **appliquée par une machine** (heuristique, seuil, ordre d'opérations) et rattachée à sa source.

---

## 0. Hiérarchie de décision (à appliquer à chaque coupe)

**Règle de Six — Walter Murch** (*In the Blink of an Eye*) [S9]

| Rang | Critère | Poids | Question à se poser |
|---|---|---|---|
| 1 | Émotion | 51 % | Que ressent le spectateur à cette coupe ? Est-ce voulu à ce moment ? |
| 2 | Histoire | 23 % | La coupe fait-elle avancer le récit / la compréhension ? |
| 3 | Rythme | 10 % | Tombe-t-elle au bon moment « musical » (ni en avance, ni en retard) ? |
| 4 | Trace du regard | 7 % | Le point d'attention du plan entrant est-il là où l'œil se trouve déjà ? |
| 5 | Planéité (règle des 180°) | 5 % | La ligne d'action est-elle respectée ? |
| 6 | Continuité 3D | 4 % | Positions des personnages cohérentes dans l'espace ? |

- Satisfaire les critères hauts **masque** les défauts des critères bas, jamais l'inverse. En cas de conflit : sacrifier par le bas.
- Émotion, histoire et rythme sont liés : trouver l'émotion juste mène généralement au bon rythme.

**Principe transversal :** toute décision de montage a un sens ; aucune coupe n'est aléatoire. [S5] Chaque coupe de l'EDL doit porter un champ `reason`.

---

## 1. Pourquoi une coupe fonctionne [S9]

- **La coupe = un clignement.** On cligne quand une pensée est complète. Couper au moment où l'idée du plan est formulée (dans une interview : souvent juste après une phrase complète, ou sur un clignement réel du sujet).
- **Anti-pattern « Dragnet »** : couper mécaniquement après chaque réplique. Laisser respirer les nuances (hésitations signifiantes, réactions).
- **Règle des 30°** (« bees and hive ») : un plan trop semblable au précédent dérange plus qu'un saut franc. Entre deux plans d'un même sujet : changer d'angle ≥ 30° **ou** de valeur de plan. Sinon c'est un jump cut (acceptable seulement en style dynamique, cf. §5).
- **Juxtaposition / effet Koulechov** : deux images côte à côte créent un troisième sens. Utilisable comme outil, pas seulement comme accident.
- **Juger uniquement ce qui est à l'écran** — comme le spectateur — pas les intentions du tournage.
- **Retour public** : quand une scène « ne marche pas », le problème est souvent qu'une information nécessaire manque *avant* cette scène.

---

## 2. Structure narrative

### 2.1 Audio d'abord [S1, S3]
- Construire le montage sur **l'audio** : voix off / interview / musique / SFX posés avant les images. L'image vient habiller le squelette sonore.
- Le son révèle immédiatement les longueurs et le rythme. Test : écouter sans image ; si l'histoire tient, le montage tient.
- ✅ Cohérent avec l'approche video-use : transcription mot à mot = surface de travail principale.

### 2.2 Ordre de travail [S1]
1. **Dérushage (spotting)** : jeter le rebut, garder l'utilisable.
2. **Assembly edit** : clips dans l'ordre début/milieu/fin, sans polish, + voix + musique temporaire.
3. Visionner d'une traite → repérer trous, longueurs, plans manquants, plans inutiles.
4. Affiner seulement ensuite (pas d'étalonnage ni de SFX avant que la structure tienne).
5. **Kill your darlings** : supprimer tout plan qui ne sert pas l'histoire, même beau.

### 2.3 Monter une interview [S3]
1. Nettoyer : couper hésitations, silences, bruits de bouche, répétitions.
2. Recoller les fragments en phrases fluides ; **la coupe ne doit plus s'entendre**.
3. Autorisé : réordonner les phrases, fusionner deux réponses à la même question. **Interdit : déformer le propos.**
4. **Temps cinématographique** : réintroduire volontairement de l'espace entre les phrases pour créer l'émotion (le temps du film ≠ temps réel).
5. Combler les trous par des **plans de coupe** : chercher dans les rushes les silences, regards, gestes — souvent pendant que l'intervieweur pose ses questions. Ralentis jusqu'à 20 % (avec flux optique) et recadrages (si source 4K → sortie 1080p) possibles.

### 2.4 Grammaire des plans — triptyque [S2]
- **Large** : établit le lieu, laisse respirer, contexte.
- **Moyen** : l'action, les interactions, les gestes.
- **Serré** : le détail qui porte l'émotion (regard, main, objet).
- Séquence type d'ouverture de scène : Large → Moyen → Serré. Heuristique d'analyse : classer chaque plan par valeur (large/moyen/serré) pour pouvoir varier.

### 2.5 Montage parallèle / alterné [S4, S10]
- **Parallèle** : rapprochement symbolique de deux séquences sans lien réel (métaphore : travailleurs ↔ moutons).
- **Alterné** : actions simultanées qui convergent vers un dénouement commun. **La fréquence des coupes augmente jusqu'à la collision.** Le spectateur sait ce que le personnage ignore → suspense.
- Montrer plutôt que dire.

---

## 3. Rythme, tempo, respiration

### 3.1 Les 4 facteurs du rythme (cumulatifs) [S5]
1. **Fréquence des coupes** (durée des plans).
2. **Mouvement dans le cadre** (action rapide vs calme ; aucun mouvement).
3. **Distance au sujet** : un sujet rapide en plan très large paraît plus lent qu'un petit mouvement en très gros plan.
4. **Mouvement de caméra** (fixe, pano, zoom, whip pan, crash zoom).
- \+ musique et espace laissé autour des coupes.
- Ils s'additionnent : coupes rapides + whip pans + plans serrés = séquence très rapide.

→ **Implémentation** : pour chaque plan, estimer `motion_score` (flux optique / différence d'images), `shot_scale` (large/moyen/serré), `camera_motion`. Le tempo perçu ≈ f(1/durée, motion, échelle, mouvement caméra).

### 3.2 Concevoir le tempo [S5, S6, S7]
- Partir de la **destination émotionnelle** de la scène, puis choisir le tempo (lent / moyen / rapide).
- Questions par scène : un tempo global ? lequel ? change-t-il ? quand ? **pourquoi** ? — Un changement de tempo sans raison narrative = amateur.
- Le rythme est une **courbe en montagnes russes** à dessiner sur tout le film : montées lentes, chutes rapides.
- **Variation obligatoire** : tout rapide → saturation ; tout lent → ennui. Le cerveau récompense la nouveauté.
- **Respiration** : tension → relâchement. Alterner segments rapides et lents (à l'échelle du plan ou du segment entier).
- **Durées de plan non uniformes** : même en montage rapide, des durées toutes identiques rendent la vidéo plate. Varier.
- **Schéma « 3 coupes rapides + 1 plan long »** : très efficace pour une entrée / un moment fort ; placer le moment fort sur le drop de la musique.
- Si le footage a déjà beaucoup de mouvement → **ne pas** couper vite (désorientation). Plans statiques → on peut couper plus vite ou ajouter du mouvement artificiel (zoom/punch-in).
- Le **silence** fait partie du rythme : couper la musique pour souligner un moment.
- **Test 1,25×** : relire la vidéo en 1,25×. Si elle paraît meilleure → l'original est trop lent. Si elle paraît chaotique → l'original est trop rapide.
- Parfois couper **2 images plus tôt** suffit à améliorer le rythme.

### 3.3 Repères quantitatifs [S7, S10]
- Durée moyenne de plan (ASL) au cinéma : ~12 s (1930) → ~2,5 s aujourd'hui.
- Promo ≤ 30 s : supprimer presque tout l'espace mort.
- Long format (doc, film, trailer complet) : savoir **compresser** vs **laisser respirer** pour l'émotion.
- En cas de doute, **mieux vaut trop rapide que trop lent** ; mais l'incompréhension est le 2e pire défaut.
- Le rythme perçu dépend aussi de la **vitesse de livraison de l'information** ; laisser quelques questions ouvertes accélère la sensation.
- Style dynamique (réseaux) : « il se passe quelque chose toutes les 2–3 s » (coupe, zoom, texte, SFX).
- Style documentaire : plans de **4–8 s**, respiration, pas de surstimulation, illustration de chaque affirmation.

### 3.4 Contraste rythmique [S8]
- Établir d'abord un **rythme régulier** (durées de plans constantes), puis le **rompre** pour créer l'emphase au point de rupture.
- Plus le contraste est grand, plus l'emphase est forte → proportionner l'ampleur du contraste à l'importance du moment.
- Ne pas en abuser : uniquement là où il y a un point à souligner.
- Exemple de structure : 2 plans « anxiété » → 1 plan « liberté » (motif ×2), puis 4 plans réguliers, puis accélération, puis les plans les plus courts → le **plan le plus long** sur la fin de la musique.
- Astuce analyse : monter sur **une seule piste vidéo** pour lire le rythme visuellement.

### 3.5 Couper avec la musique [S1, S6, S10]
- Couper sur chaque temps devient vite répétitif. Mieux : **beat accents** — faire tomber une **action** (geste, pas, haussement de sourcil) sur le temps fort.
- Monter selon l'émotion de l'histoire, pas seulement selon les beats.
- Coupes lentes ↔ musique lente ; coupes rapides ↔ musique rapide.
- Style rythmique (pub, clip) : coupe sur le kick, transition sur la snare, mouvement caméra sur le drop.

### 3.6 Flux entre les plans [S1, S10]
- **Trace du regard** : où sont les yeux du spectateur à la fin du plan A ? Placer l'élément d'intérêt du plan B au même endroit.
- **Raccord mouvement** : sortie de champ gauche→droite puis entrée droite→gauche = rapide mais fluide. Couper au début ou à la fin d'un geste, **jamais au milieu** (style invisible).
- **Le son masque la coupe** : un SFX ou une ambiance qui chevauche deux plans les colle (J-cut / L-cut).
- **Contraste / surprise** : un arrêt sur image, un silence soudain, une coupe inattendue → pic d'attention. Un seul bien placé suffit ; doit servir l'histoire.

---

## 4. Habillage cinéma (finition) [S3]
- Base : rendre les couleurs naturelles (LUT constructeur si log), ajuster la peau sur la **skin line** du vectorscope (masque visage).
- Format cinéma 2,35:1 : barres noires sur un **calque d'effet / adjustment layer** au-dessus (jamais sur les clips) → permet de recadrer les plans dessous. En 1920×1080 : ~13 % haut + 13 % bas.
- Look : contraste (LUT), **grain**, noirs légèrement relevés (aspect pellicule/vintage).
- Ralentis à 20 % avec interpolation par flux optique pour les plans de coupe quasi statiques.

---

## 5. Les 9 styles de montage — choisir le langage [S10]

| Style | Principe | Codes clés | Usage |
|---|---|---|---|
| Invisible | Le spectateur ne sent pas la coupe | Continuité, 180°, raccord dans l'axe ; coupe sur début/fin de geste ; le son masque la coupe | Fiction, interviews, corporate, doc factuel |
| Dynamique | Le montage se voit et stimule | Un événement toutes les 2–3 s ; zooms, SFX, textes ; sous-titres colorés, flèches, B-roll | YouTube/TikTok/Reels |
| Rythmique | La musique dirige | Sync kick/snare/drop ; patterns ABAB ; esthétique > narration | Pubs, clips, trailers |
| Parallèle | Deux actions entrelacées | Fréquence de coupe ↑ jusqu'à la convergence | Suspense, avant/après |
| Documentaire | Le discours guide l'image | Illustration constante ; plans 4–8 s ; crédibilité > esthétique | Explicatif, enquête |
| Expérimental | Briser les règles | Jump cuts, collisions, temps fluide, dialectique (Eisenstein) | Art, clips d'avant-garde |
| Seamless | Transitions invisibles entre lieux | Match de mouvement, whip pan (couper dans le flou), obstruction, speed ramp | Shorts, pubs |
| VFX | Réel + éléments ajoutés | Tracking caméra, intégration 2D/3D, grading stylisé | Pubs, gaming |
| IA augmenté | Humain + machine | Génération visuelle, voix synthétique, dérush/silences auto | Gain de temps, l'humain garde la direction |

→ **Implémentation** : le style est un **paramètre de projet** demandé à l'utilisateur ; il règle les seuils (durée de plan cible, padding des coupes, densité d'overlays, tolérance aux jump cuts).

---

## 6. DaVinci Resolve — workflow de base [S11, S12, S13]

### 6.1 Pages (ordre = chronologie de post-prod)
Media (import) → Cut (dérush/montage rapide) → Edit (montage) → Fusion (VFX) → Color (étalonnage) → Fairlight (audio) → Deliver (export).

### 6.2 Projet
- Sauvegarde automatique.
- Réglages (roue dentée) : résolution + fréquence d'images **identiques à la source**. À l'import d'un clip différent → « Change » pour aligner le projet sur le rush.
- Plusieurs timelines avec des réglages différents possibles dans un même projet (décocher « utiliser les paramètres du projet »).

### 6.3 Montage (page Edit)
- Media Pool : glisser-déposer ; organiser en **bins** (Vidéos, Musique…).
- Double-clic → viewer source ; `I` / `O` pour points d'entrée/sortie avant de poser sur la timeline.
- Pistes V (bleu) / A (vert) ; la piste du dessus est prioritaire (B-roll en V2 au-dessus de l'A-cam en V1, sans détruire le dessous).
- Agrandir les pistes audio pour **couper sur les formes d'onde**.
- **Linked Selection** activé : coupe audio+vidéo ensemble ; désactivé pour supprimer seulement l'audio d'un B-roll.
- `B` = Blade (rasoir), `A` = sélection, `Ctrl/Cmd+Z` = annuler. Trim en tirant les bords (contour blanc = longueur totale disponible du clip).
- Inspector : zoom, position, rotation, opacité, mode de fusion ; vitesse (inverser, arrêt sur image ❄, % de vitesse).
- Titres : Effects → Titles → « Text » simple (les presets sont souvent gadget).
- Transitions : Effects → Video Transitions (fondu enchaîné) à déposer sur un bord ou entre deux clips.

### 6.4 Audio (repères)
- Musique sous voix (talking head) : **≤ −25 dB** au plus fort.
- Voix sur les vu-mètres : viser **−10 à −5 dB** de façon constante.
- Corriger les passages trop faibles par **keyframes de volume** (2 ancres de chaque côté), plutôt que gain global.
- AI Dialogue Leveler : disponible mais aléatoire ; le manuel est plus précis.
- Fondus : poignées blanches en début/fin de clip.
- 🔗 Complément video-use : master final à **−14 LUFS intégré, true peak ≤ −1 dBTP** (loudnorm 2 passes), musique −12 à −15 dB sous la parole.

### 6.5 Couleur (débutant)
- Color Wheels : température, Color Boost (modéré), Shadows ↑, Highlights ↓. Pas d'excès.

### 6.6 Export (Deliver)
- Définir In/Out sur la timeline (`I` premier frame, `O` dernier).
- Préréglage **H.265 Master** (bon ratio qualité/poids) ou YouTube / H.264 MP4.
- Résolution et fréquence = celles de la timeline.
- Add to Render Queue → Render All.

> *Section détaillée Edit/Fusion/Color/Fairlight/Deliver issue du cours complet de Casey Faris : voir §7.*

---

## 7. DaVinci Resolve — cours complet (Casey Faris) [S14]

> Source : analyse vidéo automatique (vidIQ) du cours de 5 h, pas une transcription. Les valeurs chiffrées marquées ⚠ sont plausibles mais à vérifier en pratique.

### 7.1 Media `[13:20–28:45]`
- Glisser un dossier dans la **liste des bins** (arborescence de gauche) recrée l'arborescence en bins ; dans le Media Pool, les fichiers arrivent en vrac.
- **Smart Bins** : filtres dynamiques sur les métadonnées (scène, prise, codec, résolution).
- Métadonnées : Scene / Take / Angle / Keywords (panneau Metadata > All Groups).
- **Synchro son double système** : sélectionner vidéo + son externe → clic droit > Auto Sync Audio > Based on Waveform.

### 7.2 Edit `[28:45–1:30:48]`
- Ordre : assemblage (I/O + commandes d'édition) → empilement (plan large continu en V1, inserts en V2) → trim → J/L cuts et fondus audio → keyframes avec easing.
- **Trims** :
  - Sélection `A` : laisse un trou.
  - **Ripple** (Trim `T`) : décale la suite, la timeline reste sans trou.
  - **Slip** (`T`, moitié haute du clip) : change le contenu, garde durée et position.
  - **Slide** (`T`, moitié basse) : déplace le clip en raccourcissant ses voisins.
  - **J/L cut** : `Alt` + glisser le bord audio indépendamment de la vidéo.
  - Supprimer une coupe inutile : clic droit > Delete Through Edit.
- **Raccourcis** : `J/K/L` (lecture arrière / stop / avant, `L`×2 = vitesse ×2), `I/O`, `B` lame, `Ctrl+\` couper à la tête de lecture, `Ctrl+Shift+[` / `]` ripple trim début/fin jusqu'à la tête de lecture, `N` magnétisme, `M` marqueur, `Ctrl+R` retime, `Ctrl+F` plein écran.
- **Commandes d'édition** : Insert `F9`, Overwrite `F10`, Replace `F11`, Place on Top `F12`, Append at End `Shift+F12`.
- **Fondu audio sur une coupe** : 12 ou 24 images.
- **Inspector** : Transform, Cropping (adoucissement), Composite (modes, opacité), Stabilisation (Perspective / Similarity / Translation, Camera Lock), Retime (speed points pour les rampes de vitesse).
- **Easing** : Curve Editor → aplatir les tangentes → courbe ease-out. Jamais linéaire (cohérent avec la règle de video-use).

### 7.3 Cut `[1:30:48–1:45:20]`
- Double timeline (vue globale + vue zoomée), **Smart Insert** sur la coupe la plus proche.
- **Multicam** : Sync Clips by Audio → Save Sync → Sync Bin → touches `1`–`9` pour choisir l'angle → Place on Top.

### 7.4 Fusion `[1:45:50–2:50:31]`
- Graphe de nœuds de gauche à droite : `MediaIn1 → … → MediaOut1`.
- Entrées des nœuds : jaune = arrière-plan (fixe résolution et fréquence), vert = premier plan, bleu = masque.
- Nœuds clés : Merge, Blur, ColorCorrector, BrightnessContrast, FastNoise, masques Polygon / Rectangle / Ellipse, Tracker (Match Move).
- Raccourcis : `Shift+Espace` ajouter un outil, `F2` renommer, `1` / `2` afficher le nœud dans le viewer gauche / droit, `Ctrl+P` bypass.
- Piège : un masque Polygon s'anime tout seul pendant qu'on fait défiler la timeline. Clic droit > Remove Polyline pour l'empêcher.

### 7.5 Color `[2:50:31–4:17:11]`
- **Gestion couleur** : DaVinci YRGB Color Managed, Automatic désactivé, traitement DaVinci Wide Gamut Intermediate, sortie Rec.709 Gamma 2.4. Taguer l'espace couleur d'entrée par caméra (profil log) plutôt que d'empiler des LUT.
- **Ordre type des nœuds (clip)** : exposition/offset → balance des blancs → contraste/pivot → secondaires **en parallèle** (visage, yeux…). Nœud série `Alt+S`, parallèle `Alt+P`.
- **Nœuds timeline** : look global appliqué à tous les plans (look, émulation pellicule, grain).
- **Roues primaires** : Lift = noirs, Gamma = tons moyens, Gain = blancs, Offset = décalage global. Les roues Log ont des bornes réglables.
- **Courbes** : S-curve pour le contraste ; Hue vs Hue / Hue vs Sat ; Lum vs Sat pour désaturer les noirs profonds (moins de bruit chromatique).
- **Secondaires** : qualifieur HSL + Matte Finesse ; fenêtres de forme + Tracker (avant/arrière).
- **Scopes** : waveform de 0 à 1023 (ni noirs bouchés ni blancs écrêtés) ; parade RGB équilibrée = neutre ; vectorscope : peau sur la skin line, saturation naturelle d'environ 50 % vers les cibles ⚠.
- **Raccord plan à plan** : Grab Still sur le plan de référence (« héros ») → Play Still (volet de comparaison) → aligner les scopes. Clic molette sur une still = copier tout l'étalonnage.

### 7.6 Fairlight `[4:17:11–4:53:18]`
- **Chaîne** : clips → pistes → bus (dialogues, effets, musique) → Bus 1 (sortie principale).
- **Dialogues sur pistes mono** (Clip Attributes > Audio pour séparer un clip double mono).
- Modes : Range `R` (sélection de plage), Focus (hybride) ; grouper des pistes `Ctrl+G`.
- **Compresseur voix** ⚠ : seuil −20 à −14 dB, ratio 2:1 à 4:1, réduction de gain visée 2–4 dB, makeup +2 à +4 dB.
- **EQ** paramétrique 4 à 6 bandes ; passe-bas pour un son « à travers une porte ».
- Automation : `Alt+clic` ajoute un point sur la ligne d'automation.
- Outils IA de Resolve Studio : Voice Isolation, Dialogue Leveler, Music Editor.

### 7.7 Deliver `[4:53:18–5:10:00]`

| Cible | Conteneur / codec | Audio |
|---|---|---|
| Web / YouTube | MP4 ou MOV, H.265 (ou H.264) | AAC 320 kbps, 48 kHz |
| Master / archive | MOV ProRes 422 HQ (4444 si alpha) | PCM 24 bits ou 32 bits flottant |
| Échange avec Avid / autre logiciel | MXF DNxHR HQX | PCM 24 bits |

- Modes de rendu : *Single clip* (master) ou *Individual clips* (un fichier par clip).
- **Astuce YouTube** ⚠ : exporter du 1080p en UHD 3840×2160 pour obtenir l'encodage VP9/AV1 à plus haut débit.
- **Stems audio** : Output Track = « All Timeline Tracks » → une piste séparée par piste de timeline dans le fichier.

### 7.8 Ce que CutKiller peut automatiser (API de script Resolve)
- Import, bins, métadonnées, création de timeline, pose de clips, marqueurs, couleurs de clips, versions d'étalonnage, file de rendu : **oui** (API officielle).
- Trims fins (ripple / slip / slide), transitions, keyframes, nœuds Color/Fusion détaillés, mixage Fairlight : **limités ou absents** dans l'API. Stratégie : calculer la coupe hors de Resolve (EDL/FCPXML généré par CutKiller), l'importer, et laisser l'étalonnage et le mixage fins à l'humain ou à des presets (LUT, PowerGrade, presets Fairlight).

---

## 8. Règles de production (video-use) — correctness non négociable

1. Sous-titres appliqués **en dernier** (après overlays).
2. Extraction par segment → concat sans réencodage (`-c copy`).
3. Fondu audio **30 ms** à chaque bord de segment.
4. Overlays : `setpts=PTS-STARTPTS+T/TB`.
5. SRT master en temps de sortie : `out = word.start − seg.start + seg.offset`.
6. **Jamais couper dans un mot** ; caler sur les frontières de mots.
7. **Padding** des coupes : 30–200 ms (ex. 50 ms avant, 80 ms après).
8. Transcription mot à mot verbatim (garder les « euh »).
9. Cache des transcriptions.
10. Confirmer la stratégie avant d'exécuter.
11. Auto-contrôle du rendu à chaque point de coupe (±1,5 s) + mesure EBU R128.

Silences : ≥ 400 ms = coupe propre ; 150–400 ms = utilisable avec vérification ; < 150 ms = dangereux.

---

## 9. Outils de référence

- **video-use** (browser-use) : pipeline transcription → EDL JSON → rendu ffmpeg → auto-évaluation. Base méthodologique.
- **LosslessCut** (mifi) : coupe sans perte, smart cut, détection silences/noirs/scènes, import/export EDL CMX 3600, XML Resolve, FCPXML, OTIO ; API HTTP + CLI. Base pour la coupe rapide et l'interop Resolve.
- **DaVinci Resolve** : finition (étalonnage, Fairlight, export). Pilotable par script Python (API Resolve) ou via Filmit (`dv_*`). Pont CutKiller : `resolve/cutkiller_bridge.py`.
- **X-Raym DaVinci-Resolve-Scripts** (Lua) : exemples d'API — marqueurs (export CSV/chapitres YouTube, import), couleurs de clips depuis CSV, versions d'étalonnage par piste, découpe de clips. API utilisée : `GetProjectManager`, `GetItemListInTrack`, `SetClipColor`, `AddMarker`, `GetMarkers`, `AddVersion`/`LoadVersionByName`.
- **Limite connue** : le pilotage *externe* (script lancé hors de Resolve) est réservé à Resolve Studio ; la version gratuite n'exécute les scripts que depuis Workspace > Scripts ou la console.

---

## Sources

- [S1] Tim Runia — *The ONLY 5 Editing Secrets You Need to Tell Any Story* — https://www.youtube.com/watch?v=dhpazqW_OaU
- [S2] Pile et Face — *L'Art de raconter une histoire en 3 plans* — https://www.youtube.com/watch?v=9VGUZWfXEvY
- [S3] Secrets de monteur pro — *La Méthode de Montage qui rend Tout CINÉMATOGRAPHIQUE* — https://www.youtube.com/watch?v=2WXvm1kOq0Y
- [S4] Secrets de monteur pro — *Le montage parallèle* — https://www.youtube.com/watch?v=Pa61ydkcet4
- [S5] Inside The Edit — *Pacing in Film Editing* — https://www.youtube.com/watch?v=CdyTIng0M8Q
- [S6] Abhay PS Rajawat — *How to Control PACING* (en hindi) — https://www.youtube.com/watch?v=eraB3u3e7aM
- [S7] Film Editing Pro — *Video Editing Pacing Tips* — https://www.youtube.com/watch?v=IG683SXcal4
- [S8] Austen Menges — *Best Video Editing Rhythm Exercise* — https://www.youtube.com/watch?v=8FWsDeF3aU8
- [S9] StudioBinder — *Walter Murch and In the Blink of an Eye* — https://www.youtube.com/watch?v=PKYeClvvlTw
- [S10] Split Editor — *Les 9 Styles de Montage Vidéo Expliqués* — https://www.youtube.com/watch?v=BmT1nV4VG-w
- [S11] Ben Claremont — *DaVinci Resolve 21 Beginners Tutorial* — https://www.youtube.com/watch?v=aCTJ7MjpAOw
- [S12] Les Tutos DaVinci Resolve — *Apprendre le montage de A à Z* — https://www.youtube.com/watch?v=TjvsozBVVbI
- [S13] video-use — SKILL.md (browser-use/video-use)
- [S14] Casey Faris — *Introduction to DaVinci Resolve — Full Course* — https://www.youtube.com/watch?v=MCDVcQIA3UM
