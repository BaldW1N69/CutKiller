/**
 * Every rule of <standards_qualite>, with its weight in the /100 score (20 points
 * per category) and the phase that implements its check. A rule without a check
 * yet is reported "non évaluée" and excluded from the score; the report shows the
 * evaluated weight as coverage.
 */
import { type StyleProfile, tr } from "@cutkiller/core";

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
  titleEn: string;
  titleFr: string;
  weight: number;
  phase: number;
  measuredOn: MeasuredOn;
}

export const RULES: readonly Rule[] = [
  {
    id: "montage.silences",
    category: "montage",
    titleFr: "Silences > 350 ms supprimés, marges 80–120 ms",
    titleEn: "Silences > 350 ms removed, 80–120 ms margins",
    weight: 4,
    phase: 2,
    measuredOn: "rendu + EDL",
  },
  {
    id: "montage.fillers",
    category: "montage",
    titleFr: "Hésitations et respirations fortes supprimées",
    titleEn: "Hesitations and loud breaths removed",
    weight: 4,
    phase: 2,
    measuredOn: "rendu",
  },
  {
    id: "montage.beat-cuts",
    category: "montage",
    titleFr: "Coupes libres calées sur les beats (±1 frame)",
    titleEn: "Free cuts on the beat (±1 frame)",
    weight: 3,
    phase: 2,
    measuredOn: "EDL",
  },
  {
    id: "montage.jl-cuts",
    category: "montage",
    titleFr: "J/L cuts de 4 à 12 frames",
    titleEn: "J/L cuts of 4 to 12 frames",
    weight: 2,
    phase: 1,
    measuredOn: "EDL",
  },
  {
    id: "montage.static-shots",
    category: "montage",
    titleFr: "Aucun plan statique trop long",
    titleEn: "No static shot too long",
    weight: 4,
    phase: 2,
    measuredOn: "EDL",
  },
  {
    id: "montage.punch-ins",
    category: "montage",
    titleFr: "Punch-ins 105–115 %, jamais deux fois au même niveau",
    titleEn: "Punch-ins 105–115 %, never twice at the same level",
    weight: 3,
    phase: 2,
    measuredOn: "EDL",
  },
  {
    id: "motion.no-linear",
    category: "motion",
    titleFr: "Aucune interpolation linéaire (position, échelle, opacité)",
    titleEn: "No linear interpolation (position, scale, opacity)",
    weight: 6,
    phase: 1,
    measuredOn: "presets + EDL",
  },
  {
    id: "motion.durations",
    category: "motion",
    titleFr: "Micro-animations 150–300 ms, transitions 200–500 ms",
    titleEn: "Micro-animations 150–300 ms, transitions 200–500 ms",
    weight: 4,
    phase: 3,
    measuredOn: "presets + EDL",
  },
  {
    id: "motion.blur",
    category: "motion",
    titleFr: "Motion blur au-delà du seuil de vitesse",
    titleEn: "Motion blur above the speed threshold",
    weight: 4,
    phase: 3,
    measuredOn: "journal de rendu",
  },
  {
    id: "motion.overshoot",
    category: "motion",
    titleFr: "Overshoot des pop-ins entre 3 et 8 %",
    titleEn: "Pop-in overshoot between 3 and 8 %",
    weight: 2,
    phase: 3,
    measuredOn: "presets + EDL",
  },
  {
    id: "motion.presets",
    category: "motion",
    titleFr: "Presets nommés, versionnés et conformes",
    titleEn: "Named, versioned and compliant presets",
    weight: 4,
    phase: 3,
    measuredOn: "presets + EDL",
  },
  {
    id: "captions.sync",
    category: "captions",
    titleFr: "Sous-titres synchronisés au mot",
    titleEn: "Captions synced to the word",
    weight: 7,
    phase: 4,
    measuredOn: "rendu",
  },
  {
    id: "captions.density",
    category: "captions",
    titleFr: "Mots par écran / lignes / caractères",
    titleEn: "Words per screen / lines / characters",
    weight: 4,
    phase: 4,
    measuredOn: "EDL",
  },
  {
    id: "captions.safe-zones",
    category: "captions",
    titleFr: "Safe zones des plateformes respectées",
    titleEn: "Platform safe zones respected",
    weight: 5,
    phase: 4,
    measuredOn: "EDL",
  },
  {
    id: "captions.contrast",
    category: "captions",
    titleFr: "Contraste WCAG ≥ 4,5:1",
    titleEn: "WCAG contrast ≥ 4.5:1",
    weight: 4,
    phase: 4,
    measuredOn: "rendu + EDL",
  },
  {
    id: "audio.loudness",
    category: "audio",
    titleFr: "-14 LUFS ±1, true peak ≤ -1 dBTP",
    titleEn: "-14 LUFS ±1, true peak ≤ -1 dBTP",
    weight: 7,
    phase: 5,
    measuredOn: "rendu",
  },
  {
    id: "audio.ducking",
    category: "audio",
    titleFr: "Ducking de la musique -12 à -18 dB, sans pompage",
    titleEn: "Music ducked -12 to -18 dB, no pumping",
    weight: 5,
    phase: 5,
    measuredOn: "rendu",
  },
  {
    id: "audio.sfx-sync",
    category: "audio",
    titleFr: "SFX synchronisés (±1 frame)",
    titleEn: "SFX in sync (±1 frame)",
    weight: 4,
    phase: 5,
    measuredOn: "rendu + EDL",
  },
  {
    id: "audio.cut-clicks",
    category: "audio",
    titleFr: "Aucun clic aux coupes (fondus 5–10 ms)",
    titleEn: "No clicks at cuts (5–10 ms fades)",
    weight: 4,
    phase: 1,
    measuredOn: "rendu + EDL",
  },
  {
    id: "image.reframe",
    category: "image",
    titleFr: "Recadrage 9:16 qui suit le sujet sans saccade",
    titleEn: "9:16 reframing follows the subject smoothly",
    weight: 5,
    phase: 6,
    measuredOn: "rendu + EDL",
  },
  {
    id: "image.color",
    category: "image",
    titleFr: "Étalonnage cohérent entre plans",
    titleEn: "Consistent grading between shots",
    weight: 5,
    phase: 6,
    measuredOn: "rendu",
  },
  {
    id: "image.sharpness",
    category: "image",
    titleFr: "Netteté : aucune image agrandie au-delà de la limite",
    titleEn: "Sharpness: no picture enlarged beyond the limit",
    weight: 2,
    phase: 8,
    measuredOn: "EDL",
  },
  {
    id: "image.export-format",
    category: "image",
    titleFr: "H.264/H.265, 30 ou 60 fps constants, bonne résolution",
    titleEn: "H.264/H.265, constant 30 or 60 fps, right resolution",
    weight: 2,
    phase: 1,
    measuredOn: "rendu",
  },
  {
    id: "image.bitrate",
    category: "image",
    titleFr: "Débit vidéo au-dessus du minimum",
    titleEn: "Video bitrate above the minimum",
    weight: 2,
    phase: 1,
    measuredOn: "rendu",
  },
  {
    id: "image.black-frames",
    category: "image",
    titleFr: "Aucune frame noire non prévue",
    titleEn: "No unplanned black frames",
    weight: 2,
    phase: 1,
    measuredOn: "rendu",
  },
  {
    id: "image.duplicate-frames",
    category: "image",
    titleFr: "Aucune frame dupliquée non prévue",
    titleEn: "No unplanned duplicate frames",
    weight: 2,
    phase: 1,
    measuredOn: "rendu",
  },
];

/** Rule title in the current locale. */
export const ruleTitle = (r: Rule): string => tr(r.titleEn, r.titleFr);

const MEASURED_ON_EN: Record<MeasuredOn, string> = {
  rendu: "render",
  "rendu + EDL": "render + EDL",
  EDL: "EDL",
  "journal de rendu": "render log",
  "presets + EDL": "presets + EDL",
};

/** Where a check measures, in the current locale. */
export const measuredOnLabel = (m: MeasuredOn): string => tr(MEASURED_ON_EN[m], m);

export const RULES_BY_ID = new Map(RULES.map((r) => [r.id, r]));

const pct = (v: number) => `${Math.round(v * 100)} %`;
const range = ([a, b]: readonly [number, number], unit = "") => `${a}–${b}${unit}`;

/** The rule's pass condition with the profile's own values. */
export function ruleThreshold(id: string, p: StyleProfile): string {
  const m = p.montage;
  switch (id) {
    case "montage.silences":
      return tr(
        `pause ≤ ${m.maxSilenceMs} ms; margins ${range(m.wordMarginMs, " ms")}`,
        `pause ≤ ${m.maxSilenceMs} ms ; marges ${range(m.wordMarginMs, " ms")}`,
      );
    case "montage.fillers":
      return tr("no audible hesitation or repetition", "aucune hésitation ni répétition audible");
    case "montage.beat-cuts":
      return tr(
        `free cut within ±${m.beatToleranceFrames} frame of a beat`,
        `coupe libre à ±${m.beatToleranceFrames} frame d'un beat`,
      );
    case "montage.jl-cuts":
      return `${range(m.jlCutFrames, " frames")}`;
    case "montage.static-shots":
      return tr(`static shot ≤ ${m.maxStaticShotS} s`, `plan statique ≤ ${m.maxStaticShotS} s`);
    case "montage.punch-ins":
      return tr(
        `${range(m.punchInScale.map((v) => Math.round(v * 100)) as [number, number], " %")}, never twice the same level`,
        `${range(m.punchInScale.map((v) => Math.round(v * 100)) as [number, number], " %")}, jamais 2× le même niveau`,
      );
    case "motion.no-linear":
      return tr(
        "no linear segment (position, scale, opacity)",
        "aucun segment linéaire (position, échelle, opacité)",
      );
    case "motion.durations":
      return tr(
        `micro ${range(p.motion.microDurationMs, " ms")}; transitions ${range(p.motion.transitionDurationMs, " ms")}; dissolves ${range(p.motion.dissolveDurationMs, " ms")}`,
        `micro ${range(p.motion.microDurationMs, " ms")} ; transitions ${range(p.motion.transitionDurationMs, " ms")} ; fondus ${range(p.motion.dissolveDurationMs, " ms")}`,
      );
    case "motion.blur":
      return tr(
        `blur above ${p.motion.motionBlurThresholdPxPerFrame} px/frame`,
        `flou au-delà de ${p.motion.motionBlurThresholdPxPerFrame} px/frame`,
      );
    case "motion.overshoot":
      return tr(
        `overshoot ${pct(p.motion.overshoot[0])}–${pct(p.motion.overshoot[1])} (entrances, micro)`,
        `rebond ${pct(p.motion.overshoot[0])}–${pct(p.motion.overshoot[1])} (entrées, micro)`,
      );
    case "motion.presets":
      return tr("named, versioned, compliant", "nommés, versionnés, conformes aux règles");
    case "captions.sync":
      return tr(
        `p95 offset ≤ ${p.captions.maxSyncErrorFrames.p95} frame, max ≤ ${p.captions.maxSyncErrorFrames.max}`,
        `écart p95 ≤ ${p.captions.maxSyncErrorFrames.p95} frame, max ≤ ${p.captions.maxSyncErrorFrames.max}`,
      );
    case "captions.density":
      return p.captions.wordsPerScreen
        ? tr(
            `${range(p.captions.wordsPerScreen, " words")} per screen`,
            `${range(p.captions.wordsPerScreen, " mots")} par écran`,
          )
        : tr(
            `≤ ${p.captions.maxLines} lines × ${p.captions.maxCharsPerLine} chars`,
            `≤ ${p.captions.maxLines} lignes × ${p.captions.maxCharsPerLine} car.`,
          );
    case "captions.safe-zones":
      return tr(
        `inside ${Object.keys(p.captions.safeZones).join(" ∩ ")}`,
        `dans ${Object.keys(p.captions.safeZones).join(" ∩ ")}`,
      );
    case "captions.contrast":
      return `≥ ${p.captions.minContrast}:1`;
    case "audio.loudness":
      return `${p.audio.integratedLufs} ±${p.audio.lufsTolerance} LUFS ; TP ≤ ${p.audio.truePeakDbtp} dBTP`;
    case "audio.ducking":
      return tr(
        `music ${p.audio.duckingDb[1]} to ${p.audio.duckingDb[0]} dB under the voice, no pumping`,
        `musique ${p.audio.duckingDb[1]} à ${p.audio.duckingDb[0]} dB sous la voix, sans pompage`,
      );
    case "audio.sfx-sync":
      return tr(
        `impact within ±${p.audio.sfxToleranceFrames} frame`,
        `impact à ±${p.audio.sfxToleranceFrames} frame`,
      );
    case "audio.cut-clicks":
      return tr(
        `fades ${range(p.audio.cutFadeMs, " ms")}, no click`,
        `fondus ${range(p.audio.cutFadeMs, " ms")}, aucun clic`,
      );
    case "image.reframe":
      return tr(
        `face ≥ ${pct(p.reframe.minFaceInFrame)} in frame, centre ≤ ${pct(p.reframe.maxFaceOffset)}; acceleration ≤ ${p.reframe.maxAccelPx} px/frame²`,
        `visage ≥ ${pct(p.reframe.minFaceInFrame)} dans l'image, centre ≤ ${pct(p.reframe.maxFaceOffset)} ; accélération ≤ ${p.reframe.maxAccelPx} px/frame²`,
      );
    case "image.color":
      return tr(
        `skin ΔL* ≤ ${p.color.maxSkinDeltaL}, Δa*b* ≤ ${p.color.maxSkinDeltaAb}; one look`,
        `peau ΔL* ≤ ${p.color.maxSkinDeltaL}, Δa*b* ≤ ${p.color.maxSkinDeltaAb} ; un seul look`,
      );
    case "image.sharpness":
      return tr(`enlargement ≤ ×${p.export.maxUpscale}`, `agrandissement ≤ ×${p.export.maxUpscale}`);
    case "image.export-format":
      return tr(
        `H.264/H.265, ${p.export.allowedFps.join(" or ")} fps CFR`,
        `H.264/H.265, ${p.export.allowedFps.join(" ou ")} fps CFR`,
      );
    case "image.bitrate":
      return `≥ ${p.export.minBitrateMbps["30"]} Mbps (≤ 30 fps), ${p.export.minBitrateMbps["60"]} (60 fps)`;
    case "image.black-frames":
      return tr("no unplanned black frame", "aucune frame noire non prévue");
    case "image.duplicate-frames":
      return tr("no frozen picture while the source moves", "aucune image figée quand la source bouge");
    default:
      return "";
  }
}
