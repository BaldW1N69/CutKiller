import { spawn } from "node:child_process";
import { clipEnd, clipFrames, type Edl, sortedClips, type VideoClip } from "@cutkiller/core";
import { ffmpegBin, waitFor } from "@cutkiller/media";
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
  let pending: Buffer = Buffer.alloc(0);
  let index = 0;
  for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    while (pending.length >= frameSize) {
      onFrame(pending.subarray(0, frameSize), index++);
      pending = pending.subarray(frameSize);
    }
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

/** Per-frame luma difference with the previous frame of a video file (index 0 → Infinity). */
export async function frameDiffs(path: string, width: number, height: number): Promise<number[]> {
  const diffs: number[] = [];
  let prev: Buffer | null = null;
  await streamFrames(
    ["-i", path, "-map", "0:v:0", "-vf", "format=gray", "-f", "rawvideo", "-"],
    width * height,
    (f) => {
      diffs.push(prev ? meanAbsDiff(prev, f) : Number.POSITIVE_INFINITY);
      prev = Buffer.from(f);
    },
  );
  return diffs;
}

export interface FrameStats {
  /** Luma MAD with the previous frame (index 0 → Infinity). */
  diffs: number[];
  /** Frame is black: at least 98 % of pixels at or under the threshold. */
  black: boolean[];
}

/** Same measures on a clip's source, conformed exactly like the renderer does. */
export async function clipFrameStats(
  edl: Edl,
  clip: VideoClip,
  baseDir: string,
  blackThreshold: number,
): Promise<FrameStats> {
  const { input, vf, duration } = decoderChain(edl, clip, baseDir);
  const { width, height } = edl.output;
  const stats: FrameStats = { diffs: [], black: [] };
  const limit = Math.round(16 + blackThreshold * 219); // limited-range luma, as blackdetect sees it
  let prev: Buffer | null = null;
  const args = [
    ...input,
    "-t",
    duration.toFixed(6),
    "-an",
    "-vf",
    `${vf},format=gray`,
    "-f",
    "rawvideo",
    "-",
  ];
  await streamFrames(args, width * height, (f) => {
    stats.diffs.push(prev ? meanAbsDiff(prev, f) : Number.POSITIVE_INFINITY);
    let dark = 0;
    for (let i = 0; i < f.length; i++) if ((f[i] as number) <= limit) dark++;
    stats.black.push(dark / f.length >= 0.98);
    prev = Buffer.from(f);
  });
  const n = clipFrames(clip, edl.output.fps);
  return { diffs: stats.diffs.slice(0, n), black: stats.black.slice(0, n) };
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
