import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWorker } from "@cutkiller/analyze";
import { colorPass } from "@cutkiller/color";
import {
  type Analysis,
  type Edl,
  type EdlInput,
  parseEdl,
  type StyleProfile,
  type Subjects,
} from "@cutkiller/core";
import { FACE_PAN, type Fixtures, facePanX, generateFixtures } from "@cutkiller/fixtures";
import { ffmpeg } from "@cutkiller/media";
import { reframePass } from "@cutkiller/reframe";
import { render } from "@cutkiller/render";
import { loadProfile, PresetRegistry } from "@cutkiller/style";
import { beforeAll, describe, expect, it } from "vitest";
import { checkBlackFrames, checkDuplicateFrames } from "../src/checks/image";
import { checkColor, checkReframe, renderSubjects } from "../src/checks/subject";
import { clipFrameStats, frameDiffs } from "../src/decode";

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;

const edlOf = (input: EdlInput): Edl => {
  const r = parseEdl(input);
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
  return r.edl;
};

let fx: Fixtures;
let profile: StyleProfile;
let registry: PresetRegistry;
let dir: string;
beforeAll(async () => {
  fx = await generateFixtures();
  profile = await loadProfile("short");
  registry = await PresetRegistry.load();
  dir = await mkdtemp(join(tmpdir(), "ck-image-"));
});

describe("recadrage 9:16 sur un visage réel (QA image.reframe)", () => {
  let analysis: Analysis;
  let base: Edl;

  beforeAll(async () => {
    const subjects = await runWorker<Subjects>("subjects", { path: fx.facePan });
    analysis = {
      sources: {
        a: { path: fx.facePan, durationS: FACE_PAN.durationS, hasVideo: true, hasAudio: true },
      },
      subjects: { a: subjects },
    };
    base = edlOf({
      version: "1.4.0",
      output: {
        format: "short",
        width: 540,
        height: 960,
        fps: 30,
        video: { bitrateMbps: 8, preset: "veryfast" },
        audio: {},
      },
      sources: {
        a: {
          path: fx.facePan,
          durationS: FACE_PAN.durationS,
          width: FACE_PAN.width,
          height: FACE_PAN.height,
        },
      },
      video: [{ id: "main", clips: [{ id: "c1", source: "a", in: 0, out: FACE_PAN.durationS, at: 0 }] }],
    });
  });

  it("le worker voit le visage là où la vérité terrain le place", () => {
    const samples = analysis.subjects?.a?.samples ?? [];
    expect(samples.length).toBe(FACE_PAN.durationS * 5);
    for (const s of samples) {
      const face = s.faces[0];
      expect(face, `t=${s.t}`).toBeDefined();
      if (face) expect(Math.abs(face.x + face.w / 2 - facePanX(s.t)), `t=${s.t}`).toBeLessThan(0.01);
    }
  });

  it("le cadre suit le visage : dans l'image, centré, caméra sans à-coup", async () => {
    const { edl } = reframePass.run(base, { analysis, profile });
    const keys = edl.video[0]?.clips[0]?.reframe?.keys ?? [];
    expect(keys.length).toBe(3);
    const out = join(dir, "reframed.mp4");
    await render(edl, { baseDir: fx.dir, outPath: out });
    const result = await checkReframe(out, edl, profile, analysis);
    expect(result.violations).toEqual([]);
    expect(result.status).toBe("pass");
    expect(result.measured?.samples).toBeGreaterThan(30);
    expect(result.measured?.faceOffsetP50).toBeLessThan(0.06);
    expect(result.measured?.peakAccelPx).toBeLessThanOrEqual(profile.reframe.maxAccelPx);
    const faces = await renderSubjects(out);
    expect(faces.samples.filter((s) => s.faces.length > 0).length).toBe(faces.samples.length);
    // The QA's source-side frame stats decode the band the crop pans over (wider
    // than the output): same picture changes as the render, frame for frame.
    const clip = edl.video[0]?.clips[0];
    if (!clip) throw new Error("pas de plan");
    const source = await clipFrameStats(edl, clip, fx.dir, 0.1);
    const rendered = await frameDiffs(out, 540, 960);
    expect(source.diffs).toHaveLength(FACE_PAN.durationS * 30);
    const ratio = median(source.diffs.slice(1)) / median(rendered.slice(1));
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(2);
  });

  it("refuse une caméra qui ne suit pas le sujet", async () => {
    const fixed = structuredClone(base);
    const clip = fixed.video[0]?.clips[0];
    if (!clip) throw new Error("pas de plan");
    clip.reframe = { axis: "x", keys: [{ frame: 0, value: FACE_PAN.from }] };
    const out = join(dir, "fixed.mp4");
    await render(fixed, { baseDir: fx.dir, outPath: out });
    const result = await checkReframe(out, fixed, profile, analysis);
    expect(result.status).toBe("fail");
    expect(result.violations.map((v) => v.message).join(" ")).toMatch(/absent du cadre|coupé|décentré/);
    // The violations start once the face has left: after the glide begins (2.5 s).
    expect(Math.min(...result.violations.map((v) => v.frame ?? 0))).toBeGreaterThan(2.5 * 30);
  });

  it("refuse une caméra qui donne des à-coups", async () => {
    const jolt = structuredClone(base);
    const clip = jolt.video[0]?.clips[0];
    if (!clip) throw new Error("pas de plan");
    clip.reframe = {
      axis: "x",
      keys: [
        { frame: 0, value: FACE_PAN.from },
        { frame: 80, value: FACE_PAN.from, ease: "ease-in-out-cubic" },
        { frame: 86, value: FACE_PAN.to, ease: "ease-in-out-cubic" },
      ],
    };
    const result = await checkReframe(join(dir, "reframed.mp4"), jolt, profile, analysis);
    expect(result.violations[0]?.message).toMatch(/à-coup/);
  });
});

describe("étalonnage entre deux caméras (QA image.color)", () => {
  let analysis: Analysis;
  let base: Edl;

  beforeAll(async () => {
    const [n, g] = await Promise.all([
      runWorker<Subjects>("subjects", { path: fx.faceNeutral }),
      runWorker<Subjects>("subjects", { path: fx.faceGraded }),
    ]);
    analysis = {
      sources: {
        n: { path: fx.faceNeutral, durationS: 4, hasVideo: true, hasAudio: true },
        g: { path: fx.faceGraded, durationS: 4, hasVideo: true, hasAudio: true },
      },
      subjects: { n, g },
    };
    base = edlOf({
      version: "1.4.0",
      output: {
        format: "long",
        width: 640,
        height: 360,
        fps: 30,
        video: { bitrateMbps: 8, preset: "veryfast" },
        audio: {},
      },
      sources: {
        n: { path: fx.faceNeutral, durationS: 4, width: 1280, height: 720 },
        g: { path: fx.faceGraded, durationS: 4, width: 1280, height: 720 },
      },
      video: [
        {
          id: "main",
          clips: [
            { id: "c1", source: "n", in: 0, out: 1.5, at: 0 },
            { id: "c2", source: "g", in: 0, out: 1.5, at: 45 },
            { id: "c3", source: "n", in: 1.5, out: 3, at: 90 },
            { id: "c4", source: "g", in: 1.5, out: 3, at: 135 },
          ],
        },
      ],
    });
  });

  it("refuse deux caméras non étalonnées", async () => {
    const out = join(dir, "raw.mp4");
    await render(base, { baseDir: fx.dir, outPath: out });
    const result = await checkColor(out, base, profile);
    expect(result.status).toBe("fail");
    expect(result.measured?.shots).toBe(4);
    expect(result.measured?.maxDeltaL).toBeGreaterThan(profile.color.maxSkinDeltaL);
  });

  it("égalise la peau d'une caméra sur l'autre, même look partout", async () => {
    const { edl } = colorPass.run(base, { analysis, profile, presets: registry });
    const g = edl.video[0]?.clips.find((c) => c.source === "g")?.color;
    expect(g?.exposureEv).toBeGreaterThan(0.5);
    expect(g?.balance[2]).toBeLessThan(1);
    const out = join(dir, "graded.mp4");
    await render(edl, { baseDir: fx.dir, outPath: out });
    const result = await checkColor(out, edl, profile);
    expect(result.violations).toEqual([]);
    expect(result.status).toBe("pass");
    expect(result.measured?.maxDeltaL).toBeLessThan(2);
    expect(result.measured?.maxDeltaAb).toBeLessThan(2);
  });
});

describe("frames figées (QA image.duplicate-frames)", () => {
  it("accepte une image fixe qui ne bouge pas, refuse un gel pendant un punch-in animé", async () => {
    const edl = edlOf({
      version: "1.4.0",
      output: {
        format: "short",
        width: 540,
        height: 960,
        fps: 30,
        video: { bitrateMbps: 8, preset: "veryfast" },
        audio: {},
      },
      sources: { s: { path: fx.still, still: true, hasAudio: false } },
      video: [{ id: "main", clips: [{ id: "c1", source: "s", in: 0, out: 3, at: 0 }] }],
      keyframes: [
        {
          target: "c1.scale",
          role: "micro",
          preset: "zoom-punch@1.0.0",
          keys: [
            { frame: 40, value: 1 },
            { frame: 46, value: 1.1, ease: { spring: { stiffness: 1310, damping: 50, mass: 1 } } },
          ],
          why: { kind: "emphasis", wordIds: [0] },
        },
      ],
    });
    const clean = join(dir, "still.mp4");
    await render(edl, { baseDir: fx.dir, outPath: clean });
    const ctx = { edl, baseDir: fx.dir, profile, registry };
    // A still picture repeats itself everywhere except during the zoom: that is expected.
    const ok = await checkDuplicateFrames({ ...ctx, video: clean });
    expect(ok.violations).toEqual([]);
    expect((ok.measured?.duplicates as number) > 50).toBe(true);
    const frozen = join(dir, "still-frozen.mp4");
    await ffmpeg([
      "-v",
      "error",
      "-i",
      clean,
      "-vf",
      "split[a][b];[a][b]freezeframes=first=41:last=44:replace=40,format=yuv420p",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "12",
      "-y",
      frozen,
    ]);
    const bad = await checkDuplicateFrames({ ...ctx, video: frozen });
    expect(bad.status).toBe("fail");
    // Frozen while the zoom moves by 2 px/frame or more (the last, sub-2-px frame of
    // the spring at this small output size is not required to change).
    expect(bad.violations).toEqual([{ message: "3 frame(s) dupliquée(s)", frame: 41 }]);
  });
});

describe("texture film et fondus (profils cinematic)", () => {
  const W = 320;
  const H = 180;
  /** Gray (luma) pixels of one frame of a render. */
  async function gray(video: string, frame: number): Promise<Buffer> {
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
    return stdout;
  }
  const mean = (px: Buffer, x0: number, y0: number, x1: number, y1: number) => {
    let s = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) s += px[y * W + x] as number;
    return s / ((x1 - x0) * (y1 - y0));
  };

  const input = (texture?: { grain: number; vignette: number; letterbox?: number }): EdlInput => ({
    version: "1.5.0",
    output: {
      format: "long",
      width: W,
      height: H,
      fps: 30,
      video: { bitrateMbps: 8, preset: "veryfast" },
      audio: {},
      ...(texture ? { texture } : {}),
    },
    sources: { a: { path: fx.cam16x9, durationS: 6 }, b: { path: fx.cam9x16, durationS: 4 } },
    video: [
      {
        id: "main",
        clips: [
          { id: "c1", source: "a", in: 0, out: 2, at: 0 },
          { id: "c2", source: "b", in: 0, out: 2, at: 60 },
          { id: "c3", source: "a", in: 3, out: 5, at: 120 },
        ],
      },
    ],
    transitions: [
      { id: "t1", atFrame: 60, preset: "cross-dissolve@1", durationFrames: 15 },
      { id: "t2", atFrame: 120, preset: "dip-to-black@1", durationFrames: 15 },
    ],
  });

  let plain: string;
  let film: string;
  let filmEdl: Edl;
  beforeAll(async () => {
    plain = join(dir, "plain.mp4");
    film = join(dir, "film.mp4");
    filmEdl = edlOf(input({ grain: 0.1, vignette: 0.6, letterbox: 2.39 }));
    await render(edlOf(input()), { baseDir: fx.dir, outPath: plain });
    await render(filmEdl, { baseDir: fx.dir, outPath: film });
  });

  it("letterbox noir, coins assombris, grain dans l'image, centre inchangé en moyenne", async () => {
    const [p, f] = await Promise.all([gray(plain, 30), gray(film, 30)]);
    // Bars: (180 − 320 / 2.39) / 2 ≈ 23 px, video black (16) after encoding.
    expect(mean(f, 0, 0, W, 20)).toBeLessThan(20);
    expect(mean(f, 0, H - 20, W, H)).toBeLessThan(20);
    expect(mean(p, 0, 0, W, 20)).toBeGreaterThan(mean(f, 0, 0, W, 20) + 10);
    // Vignette: corners of the picture darker, centre about the same.
    const corner = (px: Buffer) => mean(px, 0, 26, 30, 50);
    expect(corner(f)).toBeLessThan(corner(p) - 3);
    expect(Math.abs(mean(f, 140, 70, 180, 110) - mean(p, 140, 70, 180, 110))).toBeLessThan(4);
    // Grain: pixel-level differences on a flat mid-grey bar (overlay leaves pure
    // black and white untouched).
    let sq = 0;
    let sum = 0;
    for (let y = 40; y < 80; y++)
      for (let x = 62; x < 98; x++) {
        const d = (f[y * W + x] as number) - (p[y * W + x] as number);
        sq += d * d;
        sum += d;
      }
    // Standard deviation of the difference: the grain, not the vignette's offset.
    expect(Math.sqrt(sq / 1440 - (sum / 1440) ** 2)).toBeGreaterThan(2);
  });

  it("le fondu au noir est noir sur la coupe, sans être compté comme frames noires", async () => {
    const cut = await gray(film, 120);
    expect(mean(cut, 0, 0, W, H)).toBeLessThan(24);
    const ctx = { video: film, edl: filmEdl, baseDir: fx.dir, profile, registry };
    const black = await checkBlackFrames(ctx);
    expect(black.measured?.dipFrames).toBeGreaterThan(0);
    expect(black.violations).toEqual([]);
    const dups = await checkDuplicateFrames(ctx);
    expect(dups.violations).toEqual([]);
  });
});
