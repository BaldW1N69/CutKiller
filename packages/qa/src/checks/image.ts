import { CaptionTimeline } from "@cutkiller/captions";
import {
  animationIndex,
  clipFrames,
  clipUpscale,
  type Edl,
  edlDurationFrames,
  maxAnimatedScale,
  type StyleProfile,
  tr,
  type VideoClip,
} from "@cutkiller/core";
import { ffmpeg, ffprobe, isVariableFrameRate, parseRate } from "@cutkiller/media";
import { MotionTimeline, resolveTransitions } from "@cutkiller/motion";
import type { PresetRegistry } from "@cutkiller/style";
import { clipAt, clipFrameStats, clipMotion, type FrameStats, frameDiffs, STATIC_MOTION } from "../decode";
import { type CheckResult, graded, notEvaluated, pass, type Violation } from "../report";

export interface VideoContext {
  /** Presets of the EDL's transitions and captions (to know where the render animates). */
  registry?: PresetRegistry;
  video: string;
  edl?: Edl;
  baseDir: string;
  profile: StyleProfile;
}

const CODECS = new Set(["h264", "hevc"]);

export async function checkExportFormat(ctx: VideoContext): Promise<CheckResult[]> {
  const info = await ffprobe(ctx.video);
  const v = info.streams.find((s) => s.codec_type === "video");
  if (!v) return [graded("image.export-format", 1, [{ message: tr("no video stream", "aucun flux vidéo") }])];
  const fps = parseRate(v.avg_frame_rate) ?? 0;
  const rFps = parseRate(v.r_frame_rate) ?? 0;
  const violations: Violation[] = [];
  if (!CODECS.has(v.codec_name ?? ""))
    violations.push({ message: `codec ${v.codec_name} (attendu H.264/H.265)` });
  const roundFps = Math.round(fps);
  if (!ctx.profile.export.allowedFps.includes(roundFps) || Math.abs(fps - roundFps) > 1e-3)
    violations.push({
      message: `${fps.toFixed(3)} fps (attendu ${ctx.profile.export.allowedFps.join(" ou ")})`,
    });
  const vfr = Math.abs(fps - rFps) > 1e-3 || (await isVariableFrameRate(ctx.video, 36_000));
  if (vfr)
    violations.push({
      message: tr(
        "variable frame rate (VFR): the export must be CFR",
        "cadence variable (VFR) : l'export doit être en CFR",
      ),
    });
  if (ctx.edl) {
    const { width, height } = ctx.edl.output;
    if (v.width !== width || v.height !== height)
      violations.push({
        message: tr(
          `resolution ${v.width}x${v.height} (EDL: ${width}x${height})`,
          `résolution ${v.width}x${v.height} (EDL : ${width}x${height})`,
        ),
      });
    const expected = edlDurationFrames(ctx.edl);
    const frames = Number(v.nb_frames);
    if (Number.isFinite(frames) && frames !== expected)
      violations.push({ message: `${frames} frames rendues pour ${expected} attendues` });
  }
  const measured = {
    codec: v.codec_name,
    fps,
    width: v.width,
    height: v.height,
    frames: Number(v.nb_frames),
  };
  return [
    violations.length === 0
      ? pass("image.export-format", measured)
      : { ...graded("image.export-format", violations.length, violations, measured) },
  ];
}

export async function checkBitrate(ctx: VideoContext): Promise<CheckResult> {
  const info = await ffprobe(ctx.video);
  const v = info.streams.find((s) => s.codec_type === "video");
  const fps = Math.round(parseRate(v?.avg_frame_rate) ?? 30);
  const min = fps > 31 ? ctx.profile.export.minBitrateMbps["60"] : ctx.profile.export.minBitrateMbps["30"];
  const mbps = Number(v?.bit_rate ?? info.format.bit_rate ?? 0) / 1e6;
  const measured = { mbps: Math.round(mbps * 100) / 100, minMbps: min };
  if (mbps >= min) return pass("image.bitrate", measured);
  return graded("image.bitrate", 1, [{ message: `${measured.mbps} Mbps < ${min} Mbps` }], measured);
}

/** Frames entirely black in the render, unless the source itself is black there. */
export async function checkBlackFrames(ctx: VideoContext): Promise<CheckResult> {
  const th = ctx.profile.export.blackPixelThreshold;
  const { stderr } = await ffmpeg([
    "-i",
    ctx.video,
    "-map",
    "0:v:0",
    "-vf",
    `blackdetect=d=0:pix_th=${th}:pic_th=0.98`,
    "-an",
    "-f",
    "null",
    "-",
  ]);
  const info = await ffprobe(ctx.video);
  const fps = parseRate(info.streams.find((s) => s.codec_type === "video")?.avg_frame_rate) ?? 30;
  const blackFrames: number[] = [];
  for (const m of stderr.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)) {
    const start = Math.round(Number(m[1]) * fps);
    const end = Math.round(Number(m[2]) * fps);
    for (let f = start; f < Math.max(end, start + 1); f++) blackFrames.push(f);
  }
  // A dip to black is black by construction around its cut.
  const dips = ctx.edl && ctx.registry ? dipWindows(ctx.edl, ctx.registry) : [];
  const unplanned = blackFrames.filter((f) => !dips.some(([a, b]) => f >= a && f < b));
  const unexpected = ctx.edl ? await filterUnexplained(ctx, unplanned, (d) => d.black) : unplanned;
  const total =
    Number(info.streams.find((s) => s.codec_type === "video")?.nb_frames) || blackFrames.length || 1;
  return graded(
    "image.black-frames",
    total,
    runs(unexpected).map(([a, b]) => ({ message: `${b - a + 1} frame(s) noire(s)`, frame: a })),
    {
      blackFrames: blackFrames.length,
      dipFrames: blackFrames.length - unplanned.length,
      unexpected: unexpected.length,
    },
  );
}

/** Timeline windows [start, end) of the dip-to-black transitions. */
function dipWindows(edl: Edl, registry: PresetRegistry): [number, number][] {
  return resolveTransitions(edl, registry).flatMap((t) =>
    t.params.type === "dissolve" && t.params.via === "black" ? [t.window] : [],
  );
}

/** Luma MAD under which two consecutive frames count as the same picture. */
export const DUPLICATE_MAD = 0.3;
/**
 * Where the render animates, a stricter bound: a frozen frame re-encoded measures
 * ≤ 0.01, while a small legitimate change (a short word appearing, a transition
 * over a plain background) can stay under DUPLICATE_MAD.
 */
export const FROZEN_MAD = 0.05;
/** Render motion (px/frame) from which consecutive frames must differ. */
export const MOVING_PX = 2;

/**
 * Repeated pictures in the render while the source moves or the render animates
 * (held/duplicated frames): a still source, or one whose only change is grain,
 * legitimately renders as near-identical frames, unless a camera move, punch-in,
 * transition, caption appearing or leaving is due at that frame.
 */
export async function checkDuplicateFrames(ctx: VideoContext): Promise<CheckResult> {
  const info = await ffprobe(ctx.video);
  const v = info.streams.find((s) => s.codec_type === "video");
  const means: number[] = [];
  const diffs = await frameDiffs(ctx.video, v?.width ?? 0, v?.height ?? 0, means);
  // Black frames are image.black-frames' finding, not repeated pictures as well.
  const limit = 16 + ctx.profile.export.blackPixelThreshold * 219;
  const dups = diffs.flatMap((d, i) => (d < DUPLICATE_MAD && (means[i] ?? 255) > limit ? [i] : []));
  // Where the render itself animates (camera, punch-in, transition, caption pop or
  // highlight), the picture must change whatever the source does.
  const animated = ctx.edl && ctx.registry ? animatedFrames(ctx.edl, ctx.registry) : new Set<number>();
  const unexpected = ctx.edl
    ? [
        ...(await filterUnexplained(
          ctx,
          dups.filter((f) => !animated.has(f)),
          (d) => d.duplicate,
        )),
        ...dups.filter((f) => animated.has(f) && (diffs[f] as number) < FROZEN_MAD),
      ].sort((a, b) => a - b)
    : dups;
  return graded(
    "image.duplicate-frames",
    diffs.length,
    runs(unexpected).map(([a, b]) => ({
      message: tr(`${b - a + 1} duplicated frame(s)`, `${b - a + 1} frame(s) dupliquée(s)`),
      frame: a,
    })),
    {
      duplicates: dups.length,
      unexpected: unexpected.length,
      thresholdMad: DUPLICATE_MAD,
      frozenMad: FROZEN_MAD,
      staticMotion: STATIC_MOTION,
      animatedFrames: animated.size,
    },
  );
}

/** Frames whose picture differs from the previous one by construction of the render. */
export function animatedFrames(edl: Edl, registry: PresetRegistry): Set<number> {
  const out = new Set<number>();
  const motion = new MotionTimeline(edl, resolveTransitions(edl, registry));
  const captions = new CaptionTimeline(edl, registry);
  const total = edlDurationFrames(edl);
  // Displacement from frame f − 1 to frame f (velocity at f − ½); sub-pixel motion,
  // like the tail of a spring, does not change the picture: MOVING_PX at least.
  for (let f = 1; f < total; f++)
    if (motion.velocityAt(f - 0.5) > MOVING_PX || captions.velocityAt(f - 0.5) > MOVING_PX) out.add(f);
  // A caption appearing or leaving (a highlight moving to the next word changes too
  // few pixels to tell from encoder noise: not counted).
  for (const c of edl.captions) {
    out.add(c.fromFrame);
    out.add(c.toFrame);
  }
  out.delete(0);
  return out;
}

interface SourceFrameFacts {
  duplicate: boolean;
  black: boolean;
}

/**
 * Keeps only the frames whose defect the source does not have: a still image, a
 * static screen recording or black footage legitimately produce these pictures.
 * A defect on the first frame of a clip is always the render's fault.
 */
async function filterUnexplained(
  ctx: VideoContext,
  frames: number[],
  pick: (facts: SourceFrameFacts) => boolean,
): Promise<number[]> {
  const edl = ctx.edl as Edl;
  const cache = new Map<string, FrameStats>();
  // Source stats of the clips concerned, decoded 4 at a time.
  const clips = [
    ...new Map(frames.flatMap((f) => clipAt(edl, f) ?? []).map((c) => [c.id, c])).values(),
  ].filter((c) => !edl.sources[c.source]?.still);
  for (let k = 0; k < clips.length; k += 4)
    await Promise.all(
      clips.slice(k, k + 4).map(async (c) => {
        cache.set(c.id, await clipFrameStats(edl, c, ctx.baseDir, ctx.profile.export.blackPixelThreshold));
      }),
    );
  const out: number[] = [];
  for (const f of frames) {
    const clip = clipAt(edl, f);
    if (!clip) {
      out.push(f);
      continue;
    }
    const facts = await sourceFacts(ctx, clip, f - clip.at, cache);
    if (!pick(facts)) out.push(f);
  }
  return out;
}

async function sourceFacts(
  ctx: VideoContext,
  clip: VideoClip,
  local: number,
  cache: Map<string, FrameStats>,
): Promise<SourceFrameFacts> {
  const edl = ctx.edl as Edl;
  if (edl.sources[clip.source]?.still) return { duplicate: local > 0, black: false };
  let stats = cache.get(clip.id);
  if (!stats) {
    stats = await clipFrameStats(edl, clip, ctx.baseDir, ctx.profile.export.blackPixelThreshold);
    cache.set(clip.id, stats);
  }
  const d = stats.diffs[local];
  const black = stats.black[local] === true;
  // A repeated picture is the source's own when it repeats there too, or when the
  // source does not move (only its grain changes: the encoder flattens it). The
  // motion decode is only paid for when the first answer is not enough.
  if (local === 0) return { duplicate: false, black };
  if (d !== undefined && d < DUPLICATE_MAD) return { duplicate: true, black };
  stats.motion ??= await clipMotion(edl, clip, ctx.baseDir);
  const m = stats.motion[local];
  return { duplicate: m !== undefined && m < STATIC_MOTION, black };
}

function runs(frames: number[]): [number, number][] {
  const out: [number, number][] = [];
  for (const f of [...frames].sort((a, b) => a - b)) {
    const last = out.at(-1);
    if (last && f === last[1] + 1) last[1] = f;
    else out.push([f, f]);
  }
  return out;
}

/**
 * image.sharpness — no picture enlarged beyond the profile's limit: for every clip
 * of every track, output pixels per source pixel at its framing and its largest
 * animated scale (punch-in, push-in), from the sources' probed size. Scored by
 * duration: the share of the timeline shown at a sharp enough enlargement.
 */
export function checkSharpness(edl: Edl, profile: StyleProfile): CheckResult {
  const max = profile.export.maxUpscale;
  const fps = edl.output.fps;
  const index = animationIndex(edl);
  const violations: Violation[] = [];
  let total = 0;
  let soft = 0;
  let worst = 0;
  for (const clip of edl.video.flatMap((t) => t.clips)) {
    const up = clipUpscale(edl, clip, maxAnimatedScale(index, clip.id, fps));
    if (up === undefined) continue;
    const frames = clipFrames(clip, fps);
    total += frames;
    worst = Math.max(worst, up);
    if (up > max + 1e-6) {
      soft += frames;
      const src = edl.sources[clip.source];
      violations.push({
        message: tr(
          `${clip.id}: picture enlarged ×${up.toFixed(2)} (source ${src?.width}×${src?.height} → ${edl.output.width}×${edl.output.height}), max ×${max}`,
          `${clip.id} : image agrandie ×${up.toFixed(2)} (source ${src?.width}×${src?.height} → ${edl.output.width}×${edl.output.height}), max ×${max}`,
        ),
        frame: clip.at,
      });
    }
  }
  if (total === 0)
    return notEvaluated("image.sharpness", tr("source size unknown", "taille des sources inconnue"));
  return {
    ruleId: "image.sharpness",
    status: violations.length === 0 ? "pass" : "fail",
    score: (total - soft) / total,
    violations,
    measured: {
      maxUpscale: Math.round(worst * 100) / 100,
      limit: max,
      softShare: Math.round((soft / total) * 1000) / 1000,
    },
  };
}
