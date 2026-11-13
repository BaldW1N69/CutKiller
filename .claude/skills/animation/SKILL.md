---
name: animation
description: Use when a video needs motion design or a specific animation — animated title, logo animation/reveal, kinetic typography, animated price tag or badge, lower third, counter, CTA button, arrows/highlights, particles, animated subtitles, custom transition, "une animation qui…", "fais apparaître…", "anime le logo". Decides whether a CutKiller preset is enough or whether Claude must take over and write the animation code itself, then renders and composites it with CutKiller.
---

# Animations : quand les préréglages suffisent, et quand c'est à toi de prendre le relais

CutKiller fournit le moteur (rendu à fond transparent, compositing, gravure de texte). **Toi, Claude, tu écris l'animation dès que la demande est spécifique** : forme, mouvement, timing, style de marque, idée originale. Tu ne réponds jamais « ce n'est pas possible » à une animation 2D : tu la codes.

## 1. Choisir le chemin (du plus simple au plus libre)

| La demande | Chemin |
|---|---|
| Correspond à un préréglage (titre pop, slide, typewriter, typo cinétique, lower third, compteur, bouton CTA, barre de progression, logo, confettis, cercle, flèche) | `cutkiller animate <préréglage> clé=valeur` (`--list` pour les paramètres) |
| Sous-titres animés mot à mot | `cutkiller captions` (styles tiktok, bold, karaoke, minimal) |
| Effet de **texte** précis (texte qui suit un trajet, rotation, lettres décalées, karaoké, flou animé) | **Tu écris un script ASS** (balises libass `\move \t \fad \frz \fscx \blur \k \clip \p`) → `cutkiller text vidéo --ass anim.ass` (MCP : `cutkiller_text_ass`) |
| Tout autre motion design 2D : forme sur mesure, mascotte en formes simples, étiquette, badge, graphique animé, particules, logo animé autrement, habillage de marque | **Tu écris un script Python `frame(t, ctx)`** → `cutkiller animate script.py` (MCP : `cutkiller_animate_code`) → `cutkiller overlay` |
| Transition sur mesure entre deux plans | **Tu écris un shader GLSL** au format gl-transitions → `--transition glsl:ma_transition.glsl` |
| Très complexe : dizaines de calques synchronisés, 3D, scènes multiples, data viz longue | Remotion si Node est disponible (skills `remotion:*`) : rendu ProRes 4444 ou séquence PNG avec alpha, puis `cutkiller overlay`. Sinon découpe en plusieurs scripts `frame` plus simples. |

Hors de portée sans IA générative : détourer une personne, morphing de visages, animer une photo réaliste. Dis-le clairement et propose une alternative graphique.

## 2. Méthode pour une animation sur mesure

1. **Storyboard en secondes avant de coder**, en 3 à 6 lignes : `0.0–0.4 s` l'étiquette tombe avec rebond ; `0.4–1.5 s` balancier amorti ; `1.5 s` reflet ; `3.2–3.5 s` fondu de sortie. Fixe la taille (identique à la vidéo : `--like vidéo.mp4`), la durée, la position et la zone libre (pas sous un sous-titre, pas sur un visage).
2. **Écris le script** (modèle ci-dessous). Coordonnées en fractions 0..1, tailles en fraction de la hauteur, easing partout (`out_back` pour un pop, `out` pour une arrivée, `in` pour un départ, `out_bounce`/`out_elastic` avec parcimonie).
3. **Regarde les images clés AVANT le rendu complet** : `cutkiller animate script.py --like vidéo.mp4 --preview 0.2,0.6,1.5,3.0` puis lis les PNG (MCP : `cutkiller_animate_code` les renvoie directement en image). Vérifie : rien ne déborde, lisible sur mobile, mouvement cohérent d'une image à l'autre, fond bien transparent (gris = transparent dans l'aperçu).
4. **Corrige, regarde de nouveau.** Deux ou trois itérations sont normales.
5. **Rends** en `.mov` (ProRes 4444 avec alpha, accepté par tous les logiciels de montage) ou `.webm` (léger).
6. **Incruste** : `cutkiller overlay vidéo.mp4 --add "anim.mov@2.5?pos=0.5,0.4"` (MCP : `cutkiller_overlay`).
7. **Vérifie le résultat final** sur 2 à 4 images (`cutkiller_look`, ou `ffmpeg -ss T -i sortie.mp4 -frames:v 1 f.png` puis lire l'image).
8. **Livre aussi le script** (`.py` / `.ass` / `.glsl`) : l'utilisateur peut le réutiliser ou le modifier.

## 3. Modèle de script `frame(t, ctx)`

```python
"""Badge « NOUVEAU » qui tourne en arrivant puis pulse."""
import math

DURATION = 3.0                      # secondes (option --duration prioritaire)

def frame(t, ctx):
    img = ctx.blank()               # image RGBA transparente ctx.w × ctx.h
    enter = ctx.prog(t, 0, 0.6, "out_back")        # 0→1 entre 0 et 0,6 s
    alpha = ctx.in_out(t, DURATION, 0.15, 0.3)     # fondu d'entrée/sortie
    pulse = 1 + 0.04 * math.sin(t * 6) if t > 0.6 else 1
    img = ctx.circle(img, (0.8, 0.2), 0.09 * enter * pulse, color="#FF2D55", outline=None, alpha=alpha)
    img = ctx.text(img, "NOUVEAU", (0.8, 0.2), size=0.03, scale=enter * pulse,
                   rotate=(1 - enter) * 180, color="white", alpha=alpha)
    return img                      # PIL.Image RGBA (ou ndarray H×W×4 uint8)
```

Outils de `ctx` : `blank()`, `text(img, txt, (x, y), size=, color=, alpha=, scale=, rotate=, stroke=, shadow=, anchor=)` (réduit tout seul un texte trop large), `measure()` / `fit()`, `rect(img, (x0, y0, x1, y1), color=, radius=)`, `circle(img, (x, y), r, color=, outline=, width=, start=, end=)` (arcs = tracé progressif), `line()`, `polygon()`, `paste(img, "logo.png", (x, y), scale=, rotate=)`, `glow()`, `prog(t, a, b, easing)`, `in_out()`, `ease()`, `rgba()`, et `ctx.params` (valeurs `clé=valeur` de la ligne de commande). Pillow et numpy sont disponibles dans le script.

Règles du script :
- **Déterministe** : même `t`, même image. Pour l'aléatoire, utiliser `random.Random(seed)` recréé à chaque image. Pas d'état global modifié entre deux images.
- **Rapide** : opérations Pillow/numpy vectorisées, pas de boucle Python pixel par pixel. Viser moins de 50 ms par image en 1080×1920.
- **Couleurs et polices** : celles de la marque si l'utilisateur les donne (`--font marque.ttf`). Sinon couleurs vives, avec contour ou ombre pour rester lisible sur n'importe quel fond.
- **Zones sûres en vertical** : rien d'important dans les 10 % du haut, ni dans les 20 % du bas (interface TikTok/Reels), ni sur le bord droit (boutons).

## 4. Modèle ASS (effets de texte précis)

```
[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: T,Arial,110,&H00FFFFFF,&H0000E6FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,6,0,5,60,60,0,1

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
Dialogue: 0,0:00:00.00,0:00:02.50,T,,0,0,0,,{\move(-300,900,540,900,0,400)\t(400,600,\fscx120\fscy120)\t(600,800,\fscx100\fscy100)\fad(0,250)}PROMO
```
Couleurs ASS au format `&HAABBGGRR` (bleu-vert-rouge), temps des balises en millisecondes depuis le début de la ligne.

## 5. Modèle de transition GLSL (format gl-transitions)

```glsl
// Volet en diagonale avec bord lumineux
uniform float softness; // = 0.08
vec4 transition(vec2 uv) {
  float d = (uv.x + uv.y) * 0.5;
  float m = smoothstep(progress - softness, progress + softness, d);
  vec4 c = mix(getToColor(uv), getFromColor(uv), m);
  float edge = 1.0 - abs(d - progress) / softness;
  return c + vec4(vec3(max(edge, 0.0) * 0.6), 0.0);
}
```
Puis `cutkiller transitions preview glsl:volet.glsl` pour voir le résultat, et `--transition glsl:volet.glsl` au montage.

## 6. Avant de livrer

- Images clés regardées, puis résultat final regardé : pas seulement « le rendu a réussi ».
- Durée, taille et cadence identiques à la vidéo cible ; l'animation n'empiète ni sur les sous-titres ni sur d'autres textes au même instant.
- Message à l'utilisateur : chemin de la vidéo finale, chemin du script, ce que fait l'animation (une phrase), et comment la modifier (couleur, texte, timing).
