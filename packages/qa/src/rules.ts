/**
 * Every rule of <standards_qualite>, with its weight in the /100 score (20 points
 * per category) and the phase that implements its check. A rule without a check
 * yet is reported "non évaluée" and excluded from the score; the report shows the
 * evaluated weight as coverage.
 */
import type { StyleProfile } from "@cutkiller/core";

export type Category = "montage" | "motion" | "captions" | "audio" | "image";

/**
 * What a check reads: the delivered file (or the stems the render wrote next to
 * it), the EDL that drove the render, the render log, the preset library.
 * "rendu" is an independent measurement; the others verify the plan the renderer
 * executed exactly (shared code), not the pixels.
 */
export type MeasuredOn = "rendu" | "rendu + EDL" | "EDL" | "journal de rendu" | "presets + EDL";

export interface Rule {
  id: string;
  category: Category;
  title: string;
  weight: number;
  phase: number;
  measuredOn: MeasuredOn;
}

export const RULES: readonly Rule[] = [
  {
    id: "montage.silences",
    category: "montage",
    title: "Silences > 350 ms supprimés, marges 80–120 ms",
    weight: 4,
    phase: 2,
    measuredOn: "rendu + EDL",
  },
  {
    id: "montage.fillers",
    category: "montage",
    title: "Hésitations et respirations fortes supprimées",
    weight: 4,
    phase: 2,
    measuredOn: "rendu",
  },
  {
    id: "montage.beat-cuts",
    category: "montage",
    title: "Coupes libres calées sur les beats (±1 frame)",
    weight: 3,
    phase: 2,
    measuredOn: "EDL",
  },
  {
    id: "montage.jl-cuts",
    category: "montage",
    title: "J/L cuts de 4 à 12 frames",
    weight: 2,
    phase: 1,
    measuredOn: "EDL",
  },
  {
    id: "montage.static-shots",
    category: "montage",
    title: "Aucun plan statique trop long",
    weight: 4,
    phase: 2,
    measuredOn: "EDL",
  },
  {
    id: "montage.punch-ins",
    category: "montage",
    title: "Punch-ins 105–115 %, jamais deux fois au même niveau",
    weight: 3,
    phase: 2,
    measuredOn: "EDL",
  },
  {
    id: "motion.no-linear",
    category: "motion",
    title: "Aucune interpolation linéaire (position, échelle, opacité)",
    weight: 6,
    phase: 1,
    measuredOn: "presets + EDL",
  },
  {
    id: "motion.durations",
    category: "motion",
    title: "Micro-animations 150–300 ms, transitions 200–500 ms",
    weight: 4,
    phase: 3,
    measuredOn: "presets + EDL",
  },
  {
    id: "motion.blur",
    category: "motion",
    title: "Motion blur au-delà du seuil de vitesse",
    weight: 4,
    phase: 3,
    measuredOn: "journal de rendu",
  },
  {
    id: "motion.overshoot",
    category: "motion",
    title: "Overshoot des pop-ins entre 3 et 8 %",
    weight: 2,
    phase: 3,
    measuredOn: "presets + EDL",
  },
  {
    id: "motion.presets",
    category: "motion",
    title: "Presets nommés, versionnés et conformes",
    weight: 4,
    phase: 3,
    measuredOn: "presets + EDL",
  },
  {
    id: "captions.sync",
    category: "captions",
    title: "Sous-titres synchronisés au mot",
    weight: 7,
    phase: 4,
    measuredOn: "rendu",
  },
  {
    id: "captions.density",
    category: "captions",
    title: "Mots par écran / lignes / caractères",
    weight: 4,
    phase: 4,
    measuredOn: "EDL",
  },
  {
    id: "captions.safe-zones",
    category: "captions",
    title: "Safe zones des plateformes respectées",
    weight: 5,
    phase: 4,
    measuredOn: "EDL",
  },
  {
    id: "captions.contrast",
    category: "captions",
    title: "Contraste WCAG ≥ 4,5:1",
    weight: 4,
    phase: 4,
    measuredOn: "rendu + EDL",
  },
  {
    id: "audio.loudness",
    category: "audio",
    title: "-14 LUFS ±1, true peak ≤ -1 dBTP",
    weight: 7,
    phase: 5,
    measuredOn: "rendu",
  },
  {
    id: "audio.ducking",
    category: "audio",
    title: "Ducking de la musique -12 à -18 dB, sans pompage",
    weight: 5,
    phase: 5,
    measuredOn: "rendu",
  },
  {
    id: "audio.sfx-sync",
    category: "audio",
    title: "SFX synchronisés (±1 frame)",
    weight: 4,
    phase: 5,
    measuredOn: "rendu + EDL",
  },
  {
    id: "audio.cut-clicks",
    category: "audio",
    title: "Aucun clic aux coupes (fondus 5–10 ms)",
    weight: 4,
    phase: 1,
    measuredOn: "rendu + EDL",
  },
  {
    id: "image.reframe",
    category: "image",
    title: "Recadrage 9:16 qui suit le sujet sans saccade",
    weight: 5,
    phase: 6,
    measuredOn: "rendu + EDL",
  },
  {
    id: "image.color",
    category: "image",
    title: "Étalonnage cohérent entre plans",
    weight: 5,
    phase: 6,
    measuredOn: "rendu",
  },
  {
    id: "image.sharpness",
    category: "image",
    title: "Netteté : aucune image agrandie au-delà de la limite",
    weight: 2,
    phase: 8,
    measuredOn: "EDL",
  },
  {
    id: "image.export-format",
    category: "image",
    title: "H.264/H.265, 30 ou 60 fps constants, bonne résolution",
    weight: 2,
    phase: 1,
    measuredOn: "rendu",
  },
  {
    id: "image.bitrate",
    category: "image",
    title: "Débit vidéo au-dessus du minimum",
    weight: 2,
    phase: 1,
    measuredOn: "rendu",
  },
  {
    id: "image.black-frames",
    category: "image",
    title: "Aucune frame noire non prévue",
    weight: 2,
    phase: 1,
    measuredOn: "rendu",
  },
  {
    id: "image.duplicate-frames",
    category: "image",
    title: "Aucune frame dupliquée non prévue",
    weight: 2,
    phase: 1,
    measuredOn: "rendu",
  },
];

export const RULES_BY_ID = new Map(RULES.map((r) => [r.id, r]));

const pct = (v: number) => `${Math.round(v * 100)} %`;
const range = ([a, b]: readonly [number, number], unit = "") => `${a}–${b}${unit}`;

/** The rule's pass condition with the profile's own values. */
export function ruleThreshold(id: string, p: StyleProfile): string {
  const m = p.montage;
  switch (id) {
    case "montage.silences":
      return `pause ≤ ${m.maxSilenceMs} ms ; marges ${range(m.wordMarginMs, " ms")}`;
    case "montage.fillers":
      return "aucune hésitation ni répétition audible";
    case "montage.beat-cuts":
      return `coupe libre à ±${m.beatToleranceFrames} frame d'un beat`;
    case "montage.jl-cuts":
      return `${range(m.jlCutFrames, " frames")}`;
    case "montage.static-shots":
      return `plan statique ≤ ${m.maxStaticShotS} s`;
    case "montage.punch-ins":
      return `${range(m.punchInScale.map((v) => Math.round(v * 100)) as [number, number], " %")}, jamais 2× le même niveau`;
    case "motion.no-linear":
      return "aucun segment linéaire (position, échelle, opacité)";
    case "motion.durations":
      return `micro ${range(p.motion.microDurationMs, " ms")} ; transitions ${range(p.motion.transitionDurationMs, " ms")} ; fondus ${range(p.motion.dissolveDurationMs, " ms")}`;
    case "motion.blur":
      return `flou au-delà de ${p.motion.motionBlurThresholdPxPerFrame} px/frame`;
    case "motion.overshoot":
      return `rebond ${pct(p.motion.overshoot[0])}–${pct(p.motion.overshoot[1])} (entrées, micro)`;
    case "motion.presets":
      return "nommés, versionnés, conformes aux règles";
    case "captions.sync":
      return `écart p95 ≤ ${p.captions.maxSyncErrorFrames.p95} frame, max ≤ ${p.captions.maxSyncErrorFrames.max}`;
    case "captions.density":
      return p.captions.wordsPerScreen
        ? `${range(p.captions.wordsPerScreen, " mots")} par écran`
        : `≤ ${p.captions.maxLines} lignes × ${p.captions.maxCharsPerLine} car.`;
    case "captions.safe-zones":
      return `dans ${Object.keys(p.captions.safeZones).join(" ∩ ")}`;
    case "captions.contrast":
      return `≥ ${p.captions.minContrast}:1`;
    case "audio.loudness":
      return `${p.audio.integratedLufs} ±${p.audio.lufsTolerance} LUFS ; TP ≤ ${p.audio.truePeakDbtp} dBTP`;
    case "audio.ducking":
      return `musique ${p.audio.duckingDb[1]} à ${p.audio.duckingDb[0]} dB sous la voix, sans pompage`;
    case "audio.sfx-sync":
      return `impact à ±${p.audio.sfxToleranceFrames} frame`;
    case "audio.cut-clicks":
      return `fondus ${range(p.audio.cutFadeMs, " ms")}, aucun clic`;
    case "image.reframe":
      return `visage ≥ ${pct(p.reframe.minFaceInFrame)} dans l'image, centre ≤ ${pct(p.reframe.maxFaceOffset)} ; accélération ≤ ${p.reframe.maxAccelPx} px/frame²`;
    case "image.color":
      return `peau ΔL* ≤ ${p.color.maxSkinDeltaL}, Δa*b* ≤ ${p.color.maxSkinDeltaAb} ; un seul look`;
    case "image.sharpness":
      return `agrandissement ≤ ×${p.export.maxUpscale}`;
    case "image.export-format":
      return `H.264/H.265, ${p.export.allowedFps.join(" ou ")} fps CFR`;
    case "image.bitrate":
      return `≥ ${p.export.minBitrateMbps["30"]} Mbps (≤ 30 fps), ${p.export.minBitrateMbps["60"]} (60 fps)`;
    case "image.black-frames":
      return "aucune frame noire non prévue";
    case "image.duplicate-frames":
      return "aucune image figée quand la source bouge";
    default:
      return "";
  }
}
