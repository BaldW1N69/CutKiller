import { z } from "zod";

const Range = z.tuple([z.number(), z.number()]).refine(([a, b]) => a <= b, "intervalle [min, max]");

/**
 * Style profile: every threshold of the quality standards lives here, never in code.
 * Defaults are the values of <standards_qualite>; profiles/*.yaml override them.
 */
export const StyleProfileSchema = z.object({
  id: z.string(),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  description: z.string().optional(),
  format: z.object({
    kind: z.enum(["short", "long"]),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.union([z.literal(30), z.literal(60)]),
  }),
  export: z.object({
    codec: z.enum(["h264", "h265"]).default("h264"),
    /** Minimum average video bitrate per output frame rate. */
    minBitrateMbps: z.object({ "30": z.number().positive(), "60": z.number().positive() }),
    /** Encoder target as a multiple of the minimum, so VBR undershoot stays above it. */
    targetBitrateFactor: z.number().min(1).default(1.25),
    allowedFps: z.array(z.number().int()).default([30, 60]),
    blackPixelThreshold: z.number().min(0).max(1).default(0.1),
  }),
  montage: z.object({
    maxSilenceMs: z.number().positive().default(350),
    wordMarginMs: Range.default([80, 120]),
    jlCutFrames: Range.default([4, 12]),
    beatToleranceFrames: z.number().int().nonnegative().default(1),
    maxStaticShotS: z.number().positive(),
    punchInScale: Range.default([1.05, 1.15]),
    /** Framings used by zoom cuts, alternated with the wide shot (1.0); consecutive punch-ins never repeat a level. */
    zoomCutLevels: z.array(z.number().min(1)).min(2).default([1.08, 1.12, 1.06, 1.1]),
    /** Shortest clip a zoom cut may create. */
    minShotS: z.number().positive().default(1.2),
    /** Always removed: pure hesitations. */
    fillerWords: z
      .array(z.string())
      .default(["euh", "heu", "euhm", "hum", "hmm", "mmh", "bah", "ben", "beh"]),
    /** Removed only when isolated by pauses (otherwise they carry meaning). */
    contextualFillers: z
      .array(z.string())
      .default(["donc", "bon", "alors", "voilà", "enfin", "genre", "en fait", "du coup"]),
    /** Pause around a contextual filler that marks it as a hesitation. */
    contextualPauseMs: z.number().nonnegative().default(250),
    /** Longest phrase checked for false starts (« il y a plus… il y a plus d'autres »). */
    repetitionMaxWords: z.number().int().nonnegative().default(4),
  }),
  motion: z.object({
    microDurationMs: Range.default([150, 300]),
    transitionDurationMs: Range.default([200, 500]),
    motionBlurThresholdPxPerFrame: z.number().positive().default(12),
    overshoot: Range.default([0.03, 0.08]),
    /** Animated punch-in levels (framing relative to the wide shot), cycled, never repeating the previous punch. */
    punchLevels: z.array(z.number().min(1)).min(2).default([1.06, 1.1, 1.13]),
    punchPreset: z.string().default("zoom-punch@1"),
    punchMinSpacingS: z.number().nonnegative().default(3),
    /** Minimum emphasis score (≈ standard deviations above the speaker's local level) for a punch-in. */
    emphasisMinScore: z.number().default(1.2),
    emphasisWords: z
      .array(z.string())
      .default([
        "vraiment",
        "jamais",
        "toujours",
        "énorme",
        "énormes",
        "énormément",
        "incroyable",
        "majeur",
        "majeure",
        "absolument",
        "totalement",
        "complètement",
        "extrêmement",
        "surtout",
        "exactement",
        "impossible",
        "essentiel",
        "essentielle",
        "important",
        "importante",
        "seul",
        "seule",
        "tous",
        "toutes",
        "rien",
        "personne",
        "beaucoup",
        "énorme",
        "fou",
        "folle",
        "dingue",
        "génial",
        "parfait",
        "pire",
        "meilleur",
      ]),
    stopWords: z
      .array(z.string())
      .default([
        "le",
        "la",
        "les",
        "l'",
        "un",
        "une",
        "des",
        "du",
        "de",
        "d'",
        "à",
        "au",
        "aux",
        "et",
        "ou",
        "mais",
        "donc",
        "or",
        "ni",
        "car",
        "que",
        "qu'",
        "qui",
        "quoi",
        "dont",
        "où",
        "ce",
        "c'est",
        "ça",
        "cela",
        "il",
        "elle",
        "ils",
        "elles",
        "on",
        "je",
        "j'",
        "tu",
        "nous",
        "vous",
        "me",
        "te",
        "se",
        "s'",
        "en",
        "y",
        "ne",
        "n'",
        "pas",
        "est",
        "sont",
        "a",
        "ai",
        "as",
        "avait",
        "être",
        "avoir",
        "pour",
        "par",
        "sur",
        "dans",
        "avec",
        "sans",
        "sous",
        "chez",
        "mon",
        "ma",
        "mes",
        "ton",
        "ta",
        "tes",
        "son",
        "sa",
        "ses",
        "notre",
        "nos",
        "votre",
        "vos",
        "leur",
        "leurs",
        "cette",
        "ces",
        "cet",
        "si",
        "comme",
        "alors",
        "bon",
        "voilà",
      ]),
    transitions: z
      .object({
        /**
         * Presets used in turn at a section break within one camera: the picture is
         * the same set, so it must travel (whip pan) rather than slide over itself.
         */
        sameSource: z.array(z.string()).default(["whip-pan@1"]),
        /** Presets used in turn when the next shot comes from another source (B-roll, new scene). */
        crossSource: z.array(z.string()).default(["smooth-slide@1"]),
        minSpacingS: z.number().nonnegative().default(10),
        /** Only at jump cuts that removed at least this much of the rush (a change of topic). */
        minRemovedS: z.number().nonnegative().default(1.2),
      })
      .default({
        sameSource: ["whip-pan@1"],
        crossSource: ["smooth-slide@1"],
        minSpacingS: 10,
        minRemovedS: 1.2,
      }),
  }),
  captions: z.object({
    wordsPerScreen: Range.optional(),
    maxLines: z.number().int().positive().optional(),
    maxCharsPerLine: z.number().int().positive().optional(),
    maxSyncErrorFrames: z.object({ p95: z.number().nonnegative(), max: z.number().nonnegative() }).default({
      p95: 1,
      max: 3,
    }),
    minContrast: z.number().positive().default(4.5),
  }),
  audio: z.object({
    integratedLufs: z.number().default(-14),
    lufsTolerance: z.number().nonnegative().default(1),
    truePeakDbtp: z.number().default(-1),
    duckingDb: Range.default([-18, -12]),
    cutFadeMs: Range.default([5, 10]),
    sfxToleranceFrames: z.number().int().nonnegative().default(1),
  }),
});

export type StyleProfile = z.infer<typeof StyleProfileSchema>;
export type StyleProfileInput = z.input<typeof StyleProfileSchema>;

export function profileJsonSchema(): unknown {
  return z.toJSONSchema(StyleProfileSchema, { io: "input", target: "draft-2020-12" });
}
