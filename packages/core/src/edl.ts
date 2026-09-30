import { z } from "zod";
import { EaseSchema } from "./ease";

export const EDL_VERSION = "1.0.0";

const Id = z.string().regex(/^[A-Za-z0-9_.-]+$/, "identifiant alphanumérique");
const Seconds = z.number().nonnegative();
const Frame = z.number().int().nonnegative();

export const SourceSchema = z.object({
  path: z.string().min(1),
  hash: z.string().optional(),
  durationS: z.number().positive().optional(),
  fps: z.number().positive().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  hasAudio: z.boolean().optional(),
  /** Still image: the renderer holds one frame, repeated frames are expected. */
  still: z.boolean().optional(),
});

/** Why a clip exists: kept so a human can audit and override automatic decisions. */
export const ReasonSchema = z.object({
  kind: z.string(),
  note: z.string().optional(),
  wordIds: z.array(z.number().int()).optional(),
});

export const VideoClipSchema = z.object({
  id: Id,
  source: Id,
  /** Source in/out in seconds. The clip lasts round((out - in) * fps) output frames. */
  in: Seconds,
  out: Seconds,
  /** Timeline position (output frames). */
  at: Frame,
  /**
   * Audio edit point relative to this clip's video start, in frames.
   * Negative = J-cut (this clip's audio starts early), positive = L-cut
   * (the previous clip's audio lingers over this clip's first frames).
   */
  audioSplitFrames: z.number().int().default(0),
  fit: z.enum(["cover", "contain"]).default("cover"),
  gainDb: z.number().default(0),
  why: ReasonSchema.optional(),
});

export const AudioClipSchema = z.object({
  id: Id,
  source: Id,
  in: Seconds,
  out: Seconds,
  at: Frame,
  gainDb: z.number().default(0),
  fadeInMs: z.number().nonnegative().default(0),
  fadeOutMs: z.number().nonnegative().default(0),
  why: ReasonSchema.optional(),
});

export const KeyframeSchema = z.object({
  frame: Frame,
  value: z.number(),
  /** Curve used to reach this key from the previous one. */
  ease: EaseSchema.optional(),
});

export const KeyframeTrackSchema = z.object({
  /** `<clipId>.<property>`, e.g. `c001.scale`. */
  target: z.string().regex(/^[A-Za-z0-9_.-]+\.(x|y|scale|opacity|rotation)$/),
  keys: z.array(KeyframeSchema).min(2),
});

export const OutputSchema = z.object({
  format: z.enum(["short", "long"]),
  width: z.number().int().positive().multipleOf(2),
  height: z.number().int().positive().multipleOf(2),
  fps: z.number().int().positive(),
  video: z.object({
    codec: z.enum(["h264", "h265"]).default("h264"),
    bitrateMbps: z.number().positive(),
    /** Encoder speed/quality trade-off; `veryfast` for drafts, `medium` or slower for delivery. */
    preset: z
      .enum(["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower"])
      .default("medium"),
  }),
  audio: z.object({
    sampleRate: z.number().int().positive().default(48_000),
    bitrateKbps: z.number().int().positive().default(192),
    /** Micro-fade applied at every audio edit point to avoid clicks. */
    cutFadeMs: z.number().nonnegative().default(8),
  }),
});

export const EdlSchema = z.object({
  $schema: z.string().optional(),
  version: z.string().regex(/^1\.\d+\.\d+$/, "version d'EDL 1.x.y"),
  meta: z
    .object({
      title: z.string().optional(),
      generator: z.string().optional(),
      profile: z.string().optional(),
    })
    .default({}),
  output: OutputSchema,
  sources: z.record(Id, SourceSchema),
  /** First track is the main (continuous) track; the following ones are overlays. */
  video: z.array(z.object({ id: Id, clips: z.array(VideoClipSchema) })).min(1),
  audio: z.array(z.object({ id: Id, clips: z.array(AudioClipSchema) })).default([]),
  keyframes: z.array(KeyframeTrackSchema).default([]),
  markers: z.object({ beats: z.array(Frame).optional() }).default({}),
});

export type Edl = z.infer<typeof EdlSchema>;
export type EdlInput = z.input<typeof EdlSchema>;
export type VideoClip = z.infer<typeof VideoClipSchema>;
export type AudioClip = z.infer<typeof AudioClipSchema>;
export type Source = z.infer<typeof SourceSchema>;
export type Output = z.infer<typeof OutputSchema>;
export type KeyframeTrack = z.infer<typeof KeyframeTrackSchema>;

export const SPATIAL_PROPERTIES = new Set(["x", "y", "scale", "opacity"]);

export function edlJsonSchema(): unknown {
  return z.toJSONSchema(EdlSchema, { io: "input", target: "draft-2020-12" });
}
