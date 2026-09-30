/**
 * Every rule of <standards_qualite>, with its weight in the /100 score (20 points
 * per category) and the phase that implements its check. A rule without a check
 * yet is reported "non évaluée" and excluded from the score; the report shows the
 * evaluated weight as coverage.
 */
export type Category = "montage" | "motion" | "captions" | "audio" | "image";

export interface Rule {
  id: string;
  category: Category;
  title: string;
  weight: number;
  phase: number;
}

export const RULES: readonly Rule[] = [
  {
    id: "montage.silences",
    category: "montage",
    title: "Silences > 350 ms supprimés, marges 80–120 ms",
    weight: 4,
    phase: 2,
  },
  {
    id: "montage.fillers",
    category: "montage",
    title: "Hésitations et respirations fortes supprimées",
    weight: 4,
    phase: 2,
  },
  {
    id: "montage.beat-cuts",
    category: "montage",
    title: "Coupes libres calées sur les beats (±1 frame)",
    weight: 3,
    phase: 2,
  },
  { id: "montage.jl-cuts", category: "montage", title: "J/L cuts de 4 à 12 frames", weight: 2, phase: 1 },
  {
    id: "montage.static-shots",
    category: "montage",
    title: "Aucun plan statique trop long",
    weight: 4,
    phase: 2,
  },
  {
    id: "montage.punch-ins",
    category: "montage",
    title: "Punch-ins 105–115 %, jamais deux fois au même niveau",
    weight: 3,
    phase: 3,
  },
  {
    id: "motion.no-linear",
    category: "motion",
    title: "Aucune interpolation linéaire (position, échelle, opacité)",
    weight: 6,
    phase: 1,
  },
  {
    id: "motion.durations",
    category: "motion",
    title: "Micro-animations 150–300 ms, transitions 200–500 ms",
    weight: 4,
    phase: 3,
  },
  {
    id: "motion.blur",
    category: "motion",
    title: "Motion blur au-delà du seuil de vitesse",
    weight: 4,
    phase: 3,
  },
  {
    id: "motion.overshoot",
    category: "motion",
    title: "Overshoot des pop-ins entre 3 et 8 %",
    weight: 2,
    phase: 3,
  },
  {
    id: "motion.presets",
    category: "motion",
    title: "Presets nommés, versionnés et conformes",
    weight: 4,
    phase: 3,
  },
  {
    id: "captions.sync",
    category: "captions",
    title: "Sous-titres synchronisés au mot",
    weight: 7,
    phase: 4,
  },
  {
    id: "captions.density",
    category: "captions",
    title: "Mots par écran / lignes / caractères",
    weight: 4,
    phase: 4,
  },
  {
    id: "captions.safe-zones",
    category: "captions",
    title: "Safe zones des plateformes respectées",
    weight: 5,
    phase: 4,
  },
  { id: "captions.contrast", category: "captions", title: "Contraste WCAG ≥ 4,5:1", weight: 4, phase: 4 },
  { id: "audio.loudness", category: "audio", title: "-14 LUFS ±1, true peak ≤ -1 dBTP", weight: 7, phase: 5 },
  {
    id: "audio.ducking",
    category: "audio",
    title: "Ducking de la musique -12 à -18 dB, sans pompage",
    weight: 5,
    phase: 5,
  },
  { id: "audio.sfx-sync", category: "audio", title: "SFX synchronisés (±1 frame)", weight: 4, phase: 5 },
  {
    id: "audio.cut-clicks",
    category: "audio",
    title: "Aucun clic aux coupes (fondus 5–10 ms)",
    weight: 4,
    phase: 1,
  },
  {
    id: "image.reframe",
    category: "image",
    title: "Recadrage 9:16 qui suit le sujet sans saccade",
    weight: 6,
    phase: 6,
  },
  { id: "image.color", category: "image", title: "Étalonnage cohérent entre plans", weight: 5, phase: 6 },
  {
    id: "image.export-format",
    category: "image",
    title: "H.264/H.265, 30 ou 60 fps constants, bonne résolution",
    weight: 3,
    phase: 1,
  },
  { id: "image.bitrate", category: "image", title: "Débit vidéo au-dessus du minimum", weight: 2, phase: 1 },
  {
    id: "image.black-frames",
    category: "image",
    title: "Aucune frame noire non prévue",
    weight: 2,
    phase: 1,
  },
  {
    id: "image.duplicate-frames",
    category: "image",
    title: "Aucune frame dupliquée non prévue",
    weight: 2,
    phase: 1,
  },
];

export const RULES_BY_ID = new Map(RULES.map((r) => [r.id, r]));
