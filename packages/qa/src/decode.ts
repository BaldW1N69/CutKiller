import { spawn } from "node:child_process";
import {
  animationIndex,
  clipEnd,
  clipFrames,
  type Edl,
  maxAnimatedScale,
  sortedClips,
  type VideoClip,
} from "@cutkiller/core";
import { ffmpegBin, mediaInput, waitFor } from "@cutkiller/media";
import { decoderChain } from "@cutkiller/render";

/** Streams decoded frames of a given byte size to `onFrame`, one at a time. */
export async function streamFrames(
  args: string[],
  frameSize: number,
  onFrame: (frame: Buffer, index: number) => void,
): Promise<number> {
  const child = spawn(ffmpegBin(), ["-hide_banner", "-nostdin", "-v", "error", ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const done = waitFor(child, "décodage QA");
  // Chunks (64 KB) are only joined once a whole frame is there: joining at every
  // chunk copied each frame dozens of times.
  let chunks: Buffer[] = [];
  let length = 0;
  let index = 0;
  for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
    chunks.push(chunk);
    length += chunk.length;
    if (length < frameSize) continue;
    let pending = Buffer.concat(chunks, length);
    while (pending.length >= frameSize) {
      onFrame(pending.subarray(0, frameSize), index++);
      pending = pending.subarray(frameSize);
    }
    chunks = pending.length > 0 ? [pending] : [];
    length = pending.length;
  }
  await done;
  return index;
}

/** Mean absolute luma difference (0–255) between two gray frames. */
export function meanAbsDiff(a: Buffer, b: Buffer): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs((a[i] as number) - (b[i] as number));
  return sum / a.length;
}

/**
 * Per-frame luma difference with the previous frame of a video file (index 0 →
 * Infinity); `means`, when given, receives each frame's mean luma (0–255).
 */
export async function frameDiffs(
  path: string,
  width: number,
  height: number,
  means?: number[],
): Promise<number[]> {
  const diffs: number[] = [];
  let prev: Buffer | null = null;
  await streamFrames(
    [...mediaInput(path), "-map", "0:v:0", "-vf", "format=gray", "-f", "rawvideo", "-"],
    width * height,
    (f) => {
      // One pass for both measures; frames are fresh memory (no copy needed).
      let diff = 0;
      let sum = 0;
      const p = prev;
      if (p)
        for (let i = 0; i < f.length; i++) {
          const v = f[i] as number;
          sum += v;
          diff += Math.abs(v - (p[i] as number));
        }
      else for (let i = 0; i < f.length; i++) sum += f[i] as number;
      diffs.push(p ? diff / f.length : Number.POSITIVE_INFINITY);
      means?.push(sum / f.length);
      prev = f;
    },
  );
  return diffs;
}

export interface FrameStats {
  /** Luma MAD with the previous frame (index 0 → Infinity). */
  diffs: number[];
  /** Frame is black: at least 98 % of pixels at or under the threshold. */
  black: boolean[];
  /** See clipMotion: computed only when a repeated picture needs it. */
  motion?: number[];
}

/** Denoised motion (see clipMotion) under which a source frame shows the same picture. */
export const STATIC_MOTION = 0.25;

/** The source of a clip decoded like the renderer does, restricted to what the render shows. */
function clipDecode(edl: Edl, clip: VideoClip, baseDir: string) {
  // Decoded size: the output's, or wider/taller for a moving framing (the band it pans over).
  const { input, vf: fit, duration, width: dw, height: dh } = decoderChain(edl, clip, baseDir);
  // A clip that zooms in (animated punch-in) only shows its centre: compare the
  // source on that same centre, or motion at the edges would hide repeated pictures.
  const zoom = maxAnimatedScale(animationIndex(edl), clip.id, edl.output.fps);
  const width = Math.round(dw / zoom / 2) * 2;
  const height = Math.round(dh / zoom / 2) * 2;
  const vf = zoom > 1 ? `${fit},crop=${width}:${height}` : fit;
  const n = clipFrames(clip, edl.output.fps);
  const decode = (filters: string, size: number, onFrame: (f: Buffer) => void) =>
    streamFrames(
      [...input, "-t", duration.toFixed(6), "-an", "-vf", `${filters},format=gray`, "-f", "rawvideo", "-"],
      size,
      onFrame,
    );
  return { vf, width, height, n, decode };
}

/** Same measures on a clip's source, conformed exactly like the renderer does. */
export async function clipFrameStats(
  edl: Edl,
  clip: VideoClip,
  baseDir: string,
  blackThreshold: number,
): Promise<FrameStats> {
  const { vf, width, height, n, decode } = clipDecode(edl, clip, baseDir);
  const stats: FrameStats = { diffs: [], black: [] };
  const limit = Math.round(16 + blackThreshold * 219); // limited-range luma, as blackdetect sees it
  let prev: Buffer | null = null;
  await decode(vf, width * height, (f) => {
    stats.diffs.push(prev ? meanAbsDiff(prev, f) : Number.POSITIVE_INFINITY);
    let dark = 0;
    for (let i = 0; i < f.length; i++) if ((f[i] as number) <= limit) dark++;
    stats.black.push(dark / f.length >= 0.98);
    prev = Buffer.from(f);
  });
  return { diffs: stats.diffs.slice(0, n), black: stats.black.slice(0, n) };
}

/**
 * Picture motion of a clip's source, frame to frame: luma MAD at a quarter of the
 * size after a strong denoise, so sensor grain (which an encoder at the target
 * bitrate cannot keep) does not count as motion (index 0 → Infinity). The area
 * downscale averages grain first: same separation as denoising at full size.
 */
export async function clipMotion(edl: Edl, clip: VideoClip, baseDir: string): Promise<number[]> {
  const { vf, width, height, n, decode } = clipDecode(edl, clip, baseDir);
  const sw = Math.max(2, Math.round(width / 8) * 2);
  const sh = Math.max(2, Math.round(height / 8) * 2);
  const motion: number[] = [];
  let prev: Buffer | null = null;
  await decode(`${vf},scale=${sw}:${sh}:flags=area,hqdn3d=20:20:10:10`, sw * sh, (f) => {
    motion.push(prev ? meanAbsDiff(prev, f) : Number.POSITIVE_INFINITY);
    prev = Buffer.from(f);
  });
  return motion.slice(0, n);
}

/** Topmost clip visible at an output frame (overlay tracks win over the main track). */
export function clipAt(edl: Edl, frame: number): VideoClip | undefined {
  const fps = edl.output.fps;
  for (let t = edl.video.length - 1; t >= 0; t--) {
    const clip = sortedClips(edl.video[t]?.clips ?? []).find((c) => c.at <= frame && frame < clipEnd(c, fps));
    if (clip) return clip;
  }
  return undefined;
}
