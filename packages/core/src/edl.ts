import { z } from "zod";
import { EaseSchema } from "./ease";

export const EDL_VERSION = "1.5.0";

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
  /** B-roll: illustration footage, shown as cutaways over the speech or cut on the music. */
  role: z.enum(["broll"]).optional(),
});

/** Why a clip exists: kept so a human can audit and override automatic decisions. */
export const ReasonSchema = z.object({
  kind: z.string(),
  note: z.string().optional(),
  wordIds: z.array(z.number().int()).optional(),
});

export const KeyframeSchema = z.object({
  frame: Frame,
  value: z.number(),
  /** Curve used to reach this key from the previous one. */
  ease: EaseSchema.optional(),
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
  /**
   * Static framing: `scale` > 1 punches in on the fitted frame, `x`/`y` move the
   * framing centre by a fraction of the frame (-0.5…0.5). Applied at decode time,
   * so a punch-in keeps the source's full resolution.
   */
  transform: z
    .object({
      scale: z.number().min(1).max(4).default(1),
      x: z.number().min(-0.5).max(0.5).default(0),
      y: z.number().min(-0.5).max(0.5).default(0),
    })
    .default({ scale: 1, x: 0, y: 0 }),
  gainDb: z.number().default(0),
  /**
   * Moving framing (9:16 from 16:9, or the reverse): the crop's centre along
   * `axis`, as a fraction of the source's width (x) or height (y), keyed on
   * timeline frames with eased curves (holds, then smooth moves). The crop keeps
   * the output's aspect and the static `transform.scale`.
   */
  reframe: z
    .object({
      axis: z.enum(["x", "y"]),
      keys: z.array(KeyframeSchema).min(1),
      why: ReasonSchema.optional(),
    })
    .optional(),
  /**
   * Grading: exposure and white balance (linear-light gains) matching the shot to
   * the edit's reference skin tone, then the look LUT (preset `look/`).
   */
  color: z
    .object({
      exposureEv: z.number().min(-3).max(3).default(0),
      /** Per-channel linear gains (white balance), luminance-neutral. */
      balance: z
        .tuple([z.number().positive(), z.number().positive(), z.number().positive()])
        .default([1, 1, 1]),
      look: z.string().optional(),
      /**
       * Scene adjustment of the look's S-curve (added to its contrast): a flat scene
       * gets more, a contrasty one less, so that every scene reads with the same
       * tonal range under one look.
       */
      contrast: z.number().min(-0.3).max(0.3).optional(),
      why: ReasonSchema.optional(),
    })
    .optional(),
  why: ReasonSchema.optional(),
});

/** `name@major`, `name@major.minor` or `name@x.y.z`, resolved by the preset registry. */
export const PresetRefSchema = z
  .string()
  .regex(/^[a-z0-9-]+@\d+(\.\d+){0,2}$/, "référence de preset nom@version");

/**
 * Music ducking: from `fromFrame` to `toFrame` the clip plays `depthDb` lower,
 * reached by a raised-cosine ramp of `attackMs` ending at `fromFrame` and left by
 * a ramp of `releaseMs` starting at `toFrame` (no step, no pumping).
 */
export const DuckSchema = z.object({
  fromFrame: Frame,
  toFrame: Frame,
  depthDb: z.number().max(0),
  attackMs: z.number().nonnegative(),
  releaseMs: z.number().nonnegative(),
});

export const AudioClipSchema = z.object({
  id: Id,
  /** A source of the EDL… */
  source: Id.optional(),
  /** …or a generated sound effect (preset `sfx/`), whose `in`/`out` are within the synthesized sound. */
  asset: PresetRefSchema.optional(),
  in: Seconds,
  out: Seconds,
  at: Frame,
  gainDb: z.number().default(0),
  fadeInMs: z.number().nonnegative().default(0),
  fadeOutMs: z.number().nonnegative().default(0),
  duck: z.array(DuckSchema).default([]),
  /** Visual event a sound effect lands on: `transition:<id>` or `keyframes:<target>`. */
  syncTo: z.string().optional(),
  why: ReasonSchema.optional(),
});

/**
 * Animated property of a clip, on top of its static framing. Frames are timeline
 * frames. Values: `scale` multiplies the static framing (1 = unchanged), `x`/`y`
 * move the picture by a fraction of the output frame, `opacity` 0–1, `rotation`
 * in degrees. Before the first key and after the last, the nearest key's value holds.
 */
export const KeyframeTrackSchema = z.object({
  /** `<clipId>.<property>`, e.g. `c001.scale`. */
  target: z.string().regex(/^[A-Za-z0-9_.-]+\.(x|y|scale|opacity|rotation)$/),
  keys: z.array(KeyframeSchema).min(2),
  /** What the animation does, for the quality rules (entries ease out, exits ease in, micro 150–300 ms). */
  role: z.enum(["entry", "exit", "micro", "move"]).optional(),
  /** Preset this track was generated from. */
  preset: PresetRefSchema.optional(),
  why: ReasonSchema.optional(),
});

/** Transition at a cut of the main track; its geometry comes from the preset. */
export const TransitionSchema = z.object({
  id: Id,
  /** The cut: timeline frame where the incoming clip starts. */
  atFrame: Frame,
  preset: PresetRefSchema,
  durationFrames: z.number().int().positive(),
  why: ReasonSchema.optional(),
});

/** A word of a caption, on the timeline: shown highlighted from `fromFrame` until the next word starts. */
export const CaptionWordSchema = z.object({
  /** Text as displayed (case and punctuation already applied by the style). */
  text: z.string().min(1),
  /** First frame of the spoken word (its audio onset on the timeline). */
  fromFrame: Frame,
  /** Frame after the spoken word ends. */
  toFrame: Frame,
  /** Line of the caption the word sits on (0 = top line). */
  line: z.number().int().min(0).max(3).default(0),
  /** Transcript word it comes from, for traceability and QA. */
  source: Id.optional(),
  wordId: z.number().int().nonnegative().optional(),
});

/** One caption screen: a few words shown together, the spoken one highlighted (karaoke). */
export const CaptionSchema = z.object({
  id: Id,
  /** Caption style preset (`kind: captions`): font, colours, outline, entry animation. */
  style: PresetRefSchema,
  fromFrame: Frame,
  /** Frame after the caption disappears. */
  toFrame: Frame,
  words: z.array(CaptionWordSchema).min(1),
  why: ReasonSchema.optional(),
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
  /**
   * Motion blur: frames where something moves faster than the threshold are
   * rendered as the average of sub-frame samples spread over the shutter.
   */
  motionBlur: z
    .object({
      thresholdPxPerFrame: z.number().positive().default(12),
      shutterAngle: z.number().min(0).max(360).default(180),
      /** Spacing of samples along the motion, in pixels: lower is smoother and slower. */
      stepPx: z.number().positive().default(3),
      maxSamples: z.number().int().min(2).max(64).default(32),
    })
    .default({ thresholdPxPerFrame: 12, shutterAngle: 180, stepPx: 3, maxSamples: 32 }),
  /**
   * Film texture, drawn over the pictures and under the captions: grain (fine
   * luma noise blended in overlay, σ ≈ 55 × grain levels on mid-grey, renewed with
   * every new picture),
   * vignette (darkening of the corners, 0–1) and letterbox (black bars down to
   * this aspect ratio, e.g. 2.39). Unset or zero: none.
   */
  texture: z
    .object({
      grain: z.number().min(0).max(0.3).default(0),
      vignette: z.number().min(0).max(1).default(0),
      /** Halation: warm glow bleeding around the brightest areas (0–1). */
      halation: z.number().min(0).max(1).default(0),
      /** Bloom: wide glow of the highlights in their own colours, the neon look (0–1). */
      bloom: z.number().min(0).max(1).default(0),
      letterbox: z.number().min(1).max(4).optional(),
    })
    .optional(),
  /**
   * Where captions go: the area they must stay inside (fractions of the frame
   * hidden by the platforms' interface) and their vertical placement. Filled
   * from the profile, editable here.
   */
  captions: z
    .object({
      safeArea: z
        .object({
          top: z.number().min(0).max(0.5),
          bottom: z.number().min(0).max(0.5),
          left: z.number().min(0).max(0.5),
          right: z.number().min(0).max(0.5),
        })
        .default({ top: 0.05, bottom: 0.05, left: 0.05, right: 0.05 }),
      placement: z
        .object({
          anchor: z.enum(["center", "bottom"]).default("bottom"),
          y: z.number().min(0).max(1).default(0.9),
        })
        .default({ anchor: "bottom", y: 0.9 }),
    })
    .default({
      safeArea: { top: 0.05, bottom: 0.05, left: 0.05, right: 0.05 },
      placement: { anchor: "bottom", y: 0.9 },
    }),
  audio: z.object({
    sampleRate: z.number().int().positive().default(48_000),
    /** Integrated loudness of the final mix (EBU R128), LUFS. */
    targetLufs: z.number().default(-14),
    /** True-peak ceiling of the mix before encoding (kept under the delivery limit with a margin for the codec). */
    truePeakDbtp: z.number().max(0).default(-1.5),
    /**
     * Music bed level relative to the dialogue, in LU, before ducking: the
     * renderer measures both and sets the music so that its loudness sits this far
     * under the voice. Unset: the clips' own gains only.
     */
    musicBedLu: z.number().optional(),
    /**
     * Light compression of the dialogue before the mix, so that the final limiter
     * only catches stray peaks. `thresholdLu` is relative to the dialogue's own
     * integrated loudness (measured at render).
     */
    voiceCompression: z
      .object({
        thresholdLu: z.number(),
        ratio: z.number().min(1).max(20),
        attackMs: z.number().positive(),
        releaseMs: z.number().positive(),
      })
      .optional(),
    /** Dialogue cleanup before compression: high-pass (Hz, 0 = off) and adaptive denoising (dB, 0 = off). */
    voiceCleanup: z
      .object({ highpassHz: z.number().nonnegative().max(200), denoiseDb: z.number().min(0).max(40) })
      .optional(),
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
  transitions: z.array(TransitionSchema).default([]),
  /** Burnt-in captions, in timeline order, never overlapping. */
  captions: z.array(CaptionSchema).default([]),
  markers: z.object({ beats: z.array(Frame).optional() }).default({}),
});

export type Edl = z.infer<typeof EdlSchema>;
export type EdlInput = z.input<typeof EdlSchema>;
export type VideoClip = z.infer<typeof VideoClipSchema>;
export type AudioClip = z.infer<typeof AudioClipSchema>;
export type Duck = z.infer<typeof DuckSchema>;
export type Source = z.infer<typeof SourceSchema>;
export type Output = z.infer<typeof OutputSchema>;
export type KeyframeTrack = z.infer<typeof KeyframeTrackSchema>;
export type Transition = z.infer<typeof TransitionSchema>;
export type Caption = z.infer<typeof CaptionSchema>;
export type CaptionWord = z.infer<typeof CaptionWordSchema>;

export const SPATIAL_PROPERTIES = new Set(["x", "y", "scale", "opacity"]);

export function edlJsonSchema(): unknown {
  return z.toJSONSchema(EdlSchema, { io: "input", target: "draft-2020-12" });
}
