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
    /**
     * Sharpness: largest enlargement of a source picture (output pixels per source
     * pixel, punch-ins included). A 1080p rush reframed to 9:16 is ×1.78, ×2.1 with
     * a 120 % punch-in; a 720p one ×2.67: the detail is not there to show.
     */
    maxUpscale: z.number().min(1).default(2.2),
  }),
  /**
   * Moving framing when the rush and the output differ in aspect (16:9 → 9:16):
   * a virtual camera that holds still while the subject stays in the dead zone and
   * glides to it when it leaves.
   */
  reframe: z
    .object({
      enabled: z.boolean().default(true),
      /** The subject may drift this far from the crop centre (fraction of the crop) before the camera moves. */
      deadZone: z.number().min(0).max(0.5).default(0.1),
      /** …for at least this long (a glance or a nod does not move the camera). */
      minDriftS: z.number().nonnegative().default(0.5),
      /** Subject positions are median-filtered over this window first. */
      smoothingS: z.number().positive().default(0.8),
      /** Camera moves: as long as the subject's own move, within bounds (the acceleration bound wins). */
      moveS: Range.default([0.4, 2]),
      /** Camera ease: ease-in-out has the lowest peak acceleration of the named curves. */
      ease: z.string().default("ease-in-out"),
      /** QA: share of the face box that must be inside the frame. */
      minFaceInFrame: z.number().min(0).max(1).default(0.95),
      /** QA: largest distance of the face centre from the frame centre (fraction of the frame). */
      maxFaceOffset: z.number().min(0).max(0.5).default(0.25),
      /** QA: largest acceleration of the crop centre, px/frame² (output pixels): no jolt. */
      maxAccelPx: z.number().positive().default(3),
    })
    .default({
      enabled: true,
      deadZone: 0.1,
      minDriftS: 0.5,
      smoothingS: 0.8,
      moveS: [0.4, 2],
      ease: "ease-in-out",
      minFaceInFrame: 0.95,
      maxFaceOffset: 0.25,
      maxAccelPx: 3,
    }),
  /** Grading: every shot's skin tone matched to the edit's reference, then a look LUT. */
  color: z
    .object({
      enabled: z.boolean().default(true),
      /** Look preset (`presets/look/`). */
      look: z.string().default("clean@1"),
      maxExposureEv: z.number().positive().default(1.5),
      /** Largest white-balance gain change per channel (fraction). */
      maxBalance: z.number().positive().default(0.3),
      /** Corrections smaller than this are left out (EV, and fraction for balance). */
      minCorrection: z.number().nonnegative().default(0.04),
      /**
       * Skin lightness floor (CIE L*): a darker reference skin is under-exposed whatever
       * the skin type (backlit face) and is lifted, up to maxExposureEv.
       */
      minSkinLightness: z.number().min(0).max(100).default(25),
      /** A shot whose own skin is further than this (CIE ΔE76) from its source's is matched on its own. */
      shotMatchDeltaE: z.number().positive().default(4),
      /** QA: largest skin difference between a shot and the edit's reference, CIELAB lightness and chroma. */
      maxSkinDeltaL: z.number().positive().default(6),
      maxSkinDeltaAb: z.number().positive().default(6),
      /**
       * Scene-adaptive look: each source's tonal range (median p5–p95 luma span over
       * the kept samples) is brought `strength` of the way to `targetRange` by the
       * look's S-curve, within ±max. Off by default.
       */
      sceneContrast: z
        .object({
          enabled: z.boolean().default(false),
          targetRange: z.number().min(0.2).max(1).default(0.72),
          strength: z.number().min(0).max(1).default(0.5),
          max: z.number().min(0).max(0.3).default(0.12),
        })
        .default({ enabled: false, targetRange: 0.72, strength: 0.5, max: 0.12 }),
    })
    .default({
      enabled: true,
      look: "clean@1",
      maxExposureEv: 1.5,
      maxBalance: 0.3,
      minCorrection: 0.04,
      minSkinLightness: 25,
      shotMatchDeltaE: 4,
      maxSkinDeltaL: 6,
      maxSkinDeltaAb: 6,
      sceneContrast: { enabled: false, targetRange: 0.72, strength: 0.5, max: 0.12 },
    }),
  /**
   * Film texture of the render (copied into the EDL's output): grain strength,
   * vignette, letterbox aspect ratio. Off by default.
   */
  texture: z
    .object({
      grain: z.number().min(0).max(0.3).default(0),
      vignette: z.number().min(0).max(1).default(0),
      /** Halation: warm glow bleeding around the brightest areas (0–1). */
      halation: z.number().min(0).max(1).default(0),
      letterbox: z.number().min(1).max(4).optional(),
    })
    .default({ grain: 0, vignette: 0, halation: 0 }),
  /**
   * B-roll (sources with role broll, or video without speech): cutaways over the
   * speech, on an overlay track (the voice goes on underneath), first over the
   * jump cuts they hide, then over long stretches; without any speech, a montage
   * cut every `beatsPerShot` beats of the music. Off by default.
   */
  broll: z
    .object({
      enabled: z.boolean().default(false),
      /** Length of a cutaway or of a montage shot. */
      shotS: Range.default([2, 4]),
      /** Least time on the speaker between two cutaways. */
      minSpacingS: z.number().nonnegative().default(6),
      /** The speaker opens and closes the edit: no cutaway in the first / last seconds. */
      headS: z.number().nonnegative().default(3),
      tailS: z.number().nonnegative().default(2),
      /** Largest share of the speech covered by cutaways. */
      maxShare: z.number().min(0).max(1).default(0.4),
      /** Montage without speech: one shot every N beats (N = 4: a bar in 4/4). */
      beatsPerShot: z.number().int().positive().default(4),
      /** Seconds skipped at the head of each B-roll rush (camera settling). */
      skipHeadS: z.number().nonnegative().default(0.5),
    })
    .default({
      enabled: false,
      shotS: [2, 4],
      minSpacingS: 6,
      headS: 3,
      tailS: 2,
      maxShare: 0.4,
      beatsPerShot: 4,
      skipHeadS: 0.5,
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
    /**
     * Dissolves (cross-dissolve, dip to black) are not moves: their time is the
     * time a change of place or of chapter takes to read, longer than a whip pan.
     */
    dissolveDurationMs: Range.default([400, 1500]),
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
