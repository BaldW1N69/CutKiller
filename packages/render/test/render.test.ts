import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EdlInput, parseEdl } from "@cutkiller/core";
import { generateFixtures } from "@cutkiller/fixtures";
import { decodeMono, ffmpeg, ffprobe, parseRate } from "@cutkiller/media";
import { beforeAll, describe, expect, it } from "vitest";
import { type RenderLog, render } from "../src";

/** Dominant frequency of a mono signal window, from its zero-crossing rate. */
export function zeroCrossingHz(samples: Float32Array, fromS: number, toS: number, rate = 48_000): number {
  let crossings = 0;
  const a = Math.round(fromS * rate);
  const b = Math.round(toS * rate);
  for (let i = a + 1; i < b; i++)
    if ((samples[i - 1] as number) < 0 !== (samples[i] as number) < 0) crossings++;
  return crossings / 2 / (toS - fromS);
}

describe("render (intégration FFmpeg)", () => {
  let log: RenderLog;
  let out: string;

  beforeAll(async () => {
    const fx = await generateFixtures();
    const edl: EdlInput = {
      version: "1.0.0",
      output: {
        format: "short",
        width: 540,
        height: 960,
        fps: 30,
        video: { bitrateMbps: 6, preset: "veryfast" },
        audio: {},
      },
      sources: {
        a: { path: fx.cam16x9, durationS: 6 },
        b: { path: fx.cam9x16, durationS: 4 },
        v: { path: fx.phoneVfr, durationS: 5 },
        s: { path: fx.still, still: true, hasAudio: false },
      },
      video: [
        {
          id: "main",
          clips: [
            { id: "c1", source: "a", in: 0.5, out: 2.5, at: 0 },
            { id: "c2", source: "b", in: 1, out: 3, at: 60, audioSplitFrames: -6 },
            { id: "c3", source: "v", in: 1, out: 2, at: 120 },
            { id: "c4", source: "s", in: 0, out: 1, at: 150 },
          ],
        },
      ],
    };
    const parsed = parseEdl(edl);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
    out = join(await mkdtemp(join(tmpdir(), "ck-render-")), "out.mp4");
    log = await render(parsed.edl, { baseDir: fx.dir, outPath: out });
  });

  it("writes exactly the timeline's frames, constant rate, without holding any frame", async () => {
    expect(log.frames).toBe(180);
    expect(log.heldFrames).toBe(0);
    expect(log.warnings).toEqual([]);
    const info = await ffprobe(out);
    const v = info.streams.find((s) => s.codec_type === "video");
    const a = info.streams.find((s) => s.codec_type === "audio");
    expect(v).toMatchObject({
      codec_name: "h264",
      width: 540,
      height: 960,
      nb_frames: "180",
      pix_fmt: "yuv420p",
    });
    expect(parseRate(v?.avg_frame_rate)).toBe(30);
    expect(parseRate(v?.r_frame_rate)).toBe(30);
    expect(Number(a?.duration)).toBeCloseTo(6, 1);
  });

  it("places each clip's audio on the timeline, J-cut included", async () => {
    const pcm = await decodeMono(out);
    // c1 (220 Hz) until the J-cut edit point at frame 54, then c2's audio (330 Hz) under c1's last frames.
    expect(zeroCrossingHz(pcm, 0.5, 1.7)).toBeCloseTo(220, -1);
    expect(zeroCrossingHz(pcm, 1.83, 1.98)).toBeCloseTo(330, -1);
    expect(zeroCrossingHz(pcm, 2.2, 3.8)).toBeCloseTo(330, -1);
    // c3: phone VFR footage (440 Hz), conformed to CFR.
    expect(zeroCrossingHz(pcm, 4.1, 4.9)).toBeCloseTo(440, -1);
    // c4: still image, no audio.
    expect(zeroCrossingHz(pcm, 5.2, 5.9)).toBe(0);
  });
});

describe("synchro audio/vidéo avec des flux décalés", () => {
  it("garde le flash et le bip ensemble quand la vidéo démarre après l'audio", async () => {
    const fx = await generateFixtures();
    const parsed = parseEdl({
      version: "1.0.0",
      output: {
        format: "long",
        width: 320,
        height: 180,
        fps: 30,
        video: { bitrateMbps: 4, preset: "veryfast" },
        audio: {},
      },
      sources: { o: { path: fx.avOffset, durationS: 5 } },
      // Clip 1 starts before the video stream exists (0.2 s < 1 s); clip 2 contains the flash + beep at 2.0 s.
      video: [
        {
          id: "main",
          clips: [
            { id: "a", source: "o", in: 0.2, out: 0.7, at: 0 },
            { id: "b", source: "o", in: 1.5, out: 3.5, at: 15 },
          ],
        },
      ],
    });
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
    const out = join(await mkdtemp(join(tmpdir(), "ck-av-")), "av.mp4");
    const log = await render(parsed.edl, { baseDir: fx.dir, outPath: out });
    expect(log.frames).toBe(75);

    // Flash: brightest frame. Expected at 15 + (2.0 - 1.5) × 30 = 30.
    const { stdout } = await ffmpeg(["-v", "error", "-i", out, "-vf", "format=gray", "-f", "rawvideo", "-"]);
    const size = 320 * 180;
    const means = Array.from({ length: stdout.length / size }, (_, f) => {
      let s = 0;
      for (let i = f * size; i < (f + 1) * size; i++) s += stdout[i] as number;
      return s / size;
    });
    const flash = means.indexOf(Math.max(...means));
    expect(flash).toBe(30);

    // Beep: first loud sample, expected at 1.0 s (frame 30) on the output timeline.
    const pcm = await decodeMono(out);
    const onset = pcm.findIndex((v) => Math.abs(v) > 0.2) / 48_000;
    expect(Math.abs(onset - flash / 30)).toBeLessThanOrEqual(1 / 30);
  });
});

describe("animations, transitions et flou de mouvement", () => {
  /**
   * Mean squared horizontal luma gradient of one frame. Blur spreads a step over
   * n pixels: the summed |gradient| stays the same, its energy drops by n.
   */
  async function edgeEnergy(video: string, frame: number, w: number, h: number): Promise<number> {
    const { stdout } = await ffmpeg([
      "-v",
      "error",
      "-i",
      video,
      "-vf",
      `select='eq(n,${frame})',format=gray`,
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-",
    ]);
    let sum = 0;
    for (let y = 0; y < h; y++)
      for (let x = 1; x < w; x++)
        sum += ((stdout[y * w + x] as number) - (stdout[y * w + x - 1] as number)) ** 2;
    return sum / (w * h);
  }

  async function renderDemo(shutterAngle: number) {
    const fx = await generateFixtures();
    const parsed = parseEdl({
      version: "1.1.0",
      output: {
        format: "short",
        width: 270,
        height: 480,
        fps: 30,
        video: { bitrateMbps: 6, preset: "veryfast" },
        audio: {},
        motionBlur: { shutterAngle },
      },
      sources: { a: { path: fx.cam16x9, durationS: 6 }, b: { path: fx.cam9x16, durationS: 4 } },
      video: [
        {
          id: "main",
          clips: [
            { id: "c1", source: "a", in: 0, out: 2, at: 0 },
            { id: "c2", source: "b", in: 0, out: 2, at: 60 },
            { id: "c3", source: "a", in: 3, out: 4, at: 120 },
          ],
        },
      ],
      keyframes: [
        {
          target: "c1.scale",
          role: "micro",
          preset: "zoom-punch@1",
          keys: [
            { frame: 20, value: 1 },
            { frame: 26, value: 1.1, ease: { spring: { stiffness: 1310, damping: 50, mass: 1 } } },
          ],
          why: { kind: "emphasis", wordIds: [0] },
        },
      ],
      transitions: [
        { id: "t1", atFrame: 60, preset: "whip-pan@1", durationFrames: 9 },
        { id: "t2", atFrame: 120, preset: "glitch-cut@1", durationFrames: 6 },
      ],
    });
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
    const out = join(await mkdtemp(join(tmpdir(), "ck-motion-")), "m.mp4");
    const log = await render(parsed.edl, { baseDir: fx.dir, outPath: out });
    return { out, log };
  }

  it("rend les presets, floute les frames rapides et glitche la coupe", async () => {
    const blurred = await renderDemo(180);
    expect(blurred.log.frames).toBe(150);
    expect(blurred.log.motion.glitchFrames).toBe(6);
    const whip = blurred.log.motion.frames.find(([f]) => f === 60);
    expect(whip?.[1]).toBeGreaterThan(50);
    expect(whip?.[2]).toBeGreaterThanOrEqual(8);
    const punch = blurred.log.motion.frames.filter(([f]) => f >= 20 && f <= 26);
    expect(punch.some(([, v, n]) => v > 12 && n >= 2)).toBe(true);

    const sharp = await renderDemo(0);
    expect(sharp.log.motion.blurredFrames).toBe(0);
    // Same picture, same motion: only the blur differs. It must smear the vertical edges.
    const withBlur = await edgeEnergy(blurred.out, 60, 270, 480);
    const without = await edgeEnergy(sharp.out, 60, 270, 480);
    expect(withBlur).toBeLessThan(without * 0.6);
    // A frame that does not move is identical in both renders' sharpness.
    const still = await edgeEnergy(blurred.out, 40, 270, 480);
    expect(still).toBeGreaterThan(without * 0.6);
  });
});
