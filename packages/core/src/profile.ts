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
  }),
  motion: z.object({
    microDurationMs: Range.default([150, 300]),
    transitionDurationMs: Range.default([200, 500]),
    motionBlurThresholdPxPerFrame: z.number().positive().default(12),
    overshoot: Range.default([0.03, 0.08]),
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
