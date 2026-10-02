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
import { reframePass } from "@cutkiller/reframe";
import { render } from "@cutkiller/render";
import { loadProfile, PresetRegistry } from "@cutkiller/style";
import { beforeAll, describe, expect, it } from "vitest";
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
