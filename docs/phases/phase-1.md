# Phase 1 — Fondations

## Livré

- **Monorepo** pnpm + TypeScript strict, avec les modules `core`, `media`, `style`, `analyze`, `cut`, `reframe`, `color`, `motion`, `captions`, `audio`, `render`, `qa` et `cli`. Les passes des phases suivantes sont en place sous forme d'identités typées.
- **EDL v1** : schéma zod, JSON Schema exporté, validateur sémantique (trous, chevauchements, sources, J/L, interpolation linéaire interdite) et temps quantifié à la frame. Voir [`docs/EDL.md`](../EDL.md).
- **Profils de style** `short` / `long`, qui portent tous les seuils de `<standards_qualite>`, et registre de presets versionnés (`nom@majeur`).
- **Rendu minimal de bout en bout** :
  - décodage FFmpeg par clip, avec conform VFR→CFR et recadrage cover/contain ;
  - compositeur Cairo ;
  - encodage H.264/H.265 en CFR avec débit garanti (CBR), en BT.709 ;
  - mix audio avec J/L cuts et micro-fondus de coupe ;
  - `render-log.json`.
- **quality-check** : les 25 règles sont déclarées et pondérées (20 points par catégorie), et le score est calculé sur les règles évaluées, avec le taux de couverture. Contrôles livrés :
  - format d'export (codec, fps, CFR, résolution, nombre de frames) ;
  - débit ;
  - frames noires et frames dupliquées non expliquées par la source ;
  - clics aux coupes ;
  - interpolation linéaire ;
  - longueur des J/L cuts.
- **Workers Python** : protocole JSON stdin/stdout (uv, pytest, ruff).
- **CI** GitHub Actions : lint, typecheck, fraîcheur des schémas, tests TS et Python, démo `auto` bloquée sous 90/100.

## Tests

```sh
pnpm check && pnpm typecheck && pnpm test
(cd workers && uv run pytest)
```

Résultat : 32 tests TS verts (unitaires + intégration FFmpeg + bout en bout CLI) et 3 tests Python verts.

Chaque contrôle QA est testé sur une vidéo volontairement cassée :
- frames noires injectées ;
- frames figées (`freezeframes`) ;
- coupe sans fondu (clic) ;
- fichier VFR ;
- débit de 4 Mbps.

## Score qualité

Démo `auto` sur rushes synthétiques (9:16 + VFR + image fixe + musique) : **100/100, pour une couverture de 13 %** des règles. Il n'y a aucune violation. Les 87 % restants ne sont pas encore évalués : leurs contrôles arrivent avec leurs phases.

## Limites connues

- **Aucun montage réel pour l'instant** : les rushes sont mis bout à bout. Coupes, motion, sous-titres, loudness et recadrage arrivent avec les phases 2 à 6.
- **Vitesse de rendu** sur 4 cœurs CPU en 1080×1920 : ~8 fps en preset `medium`, ~17 fps en `--draft`. L'encodeur x264 est le goulot. Un rendu parallèle par segments est prévu si nécessaire.
- **Matrice couleur en entrée** : les sources sans métadonnées colorimétriques sont décodées avec la matrice par défaut de FFmpeg (BT.601). La gestion couleur complète arrive en phase 6.
- **H.265** : le débit minimum n'est garanti qu'en H.264 (CBR avec filler). En H.265, x265 vise le débit sans le garantir.
- **Keyframes** : validées mais pas encore rendues (phase 3). Le moteur de rendu émet un avertissement.
