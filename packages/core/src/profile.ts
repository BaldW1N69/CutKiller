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
    /** Burn captions into the video. */
    enabled: z.boolean().default(true),
    /** Caption style preset (`presets/captions/`). */
    style: z.string().default("subtitle-clean@1"),
    /** Short-form screens: 1–3 words. Unset: limited by lines and characters only. */
    wordsPerScreen: Range.optional(),
    maxLines: z.number().int().positive().default(2),
    maxCharsPerLine: z.number().int().positive().default(32),
    /**
     * Long form: after a comma, start a new caption once this share of the
     * caption's capacity (lines × characters) is used. Short form breaks at every comma.
     */
    commaBreakFill: z.number().min(0).max(1).default(0.4),
    /** A pause at least this long between two words starts a new caption. */
    pauseBreakMs: z.number().nonnegative().default(400),
    /** Longest a caption stays on screen. */
    maxDurationS: z.number().positive().default(6),
    /** How long a caption lingers after its last word when nothing follows. */
    holdMs: z.number().nonnegative().default(500),
    /** Shortest a caption is shown, if the next one allows it. */
    minDurationMs: z.number().nonnegative().default(700),
    /**
     * Vertical placement: `y` is the caption block's centre (`anchor: center`) or
     * bottom edge (`anchor: bottom`), as a fraction of the frame height. The block
     * is kept inside the safe zone in any case.
     */
    placement: z
      .object({
        anchor: z.enum(["center", "bottom"]).default("bottom"),
        y: z.number().min(0).max(1).default(0.9),
      })
      .default({ anchor: "bottom", y: 0.9 }),
    /**
     * Areas covered by each target platform's interface, as fractions of the frame
     * (top, bottom, left, right). Captions must stay inside the intersection of
     * every listed platform's safe area. Versioned with the profile: platforms move
     * their buttons.
     */
    safeZones: z
      .record(
        z.string(),
        z.object({
          top: z.number().min(0).max(0.5),
          bottom: z.number().min(0).max(0.5),
          left: z.number().min(0).max(0.5),
          right: z.number().min(0).max(0.5),
        }),
      )
      .default({ "title-safe": { top: 0.05, bottom: 0.05, left: 0.05, right: 0.05 } }),
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
    /** True-peak target of the rendered mix: under the delivery limit, with room for the AAC encoder's overshoot. */
    renderTruePeakDbtp: z.number().max(0).default(-1.5),
    /** Music loudness relative to the dialogue before ducking, in LU. */
    musicBedLu: z.number().default(-6),
    /** Dialogue compressor (threshold relative to the dialogue's integrated loudness). */
    voiceCompression: z
      .object({
        thresholdLu: z.number().default(4),
        ratio: z.number().min(1).max(20).default(3),
        attackMs: z.number().positive().default(10),
        releaseMs: z.number().positive().default(150),
      })
      .default({ thresholdLu: 4, ratio: 3, attackMs: 10, releaseMs: 150 }),
    duck: z
      .object({
        /** How far the music goes down under speech. */
        depthDb: z.number().max(0).default(-15),
        /** Ramps (raised cosine): down before speech starts, back up after it ends. */
        attackMs: z.number().positive().default(120),
        releaseMs: z.number().positive().default(350),
        /** Pauses shorter than this keep the music down: no pumping between sentences. */
        mergeGapMs: z.number().nonnegative().default(700),
        /** Extra time kept down after the last word. */
        holdMs: z.number().nonnegative().default(150),
      })
      .default({ depthDb: -15, attackMs: 120, releaseMs: 350, mergeGapMs: 700, holdMs: 150 }),
    sfx: z
      .object({
        /** SFX preset per transition type (push = whip-pan, slide, glitch). */
        transitions: z.record(z.string(), z.string()).default({}),
        /** SFX on animated punch-ins (none if unset). */
        punchIn: z.string().optional(),
        gainDb: z.number().default(-10),
      })
      .default({ transitions: {}, gainDb: -10 }),
  }),
});

export type StyleProfile = z.infer<typeof StyleProfileSchema>;
export type StyleProfileInput = z.input<typeof StyleProfileSchema>;

export function profileJsonSchema(): unknown {
  return z.toJSONSchema(StyleProfileSchema, { io: "input", target: "draft-2020-12" });
}
