import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Edl, type EdlInput, parseEdl, type StyleProfile } from "@cutkiller/core";
import { type Fixtures, generateFixtures } from "@cutkiller/fixtures";
import { ffmpeg } from "@cutkiller/media";
import { render } from "@cutkiller/render";
import { loadProfile } from "@cutkiller/style";
import { beforeAll, describe, expect, it } from "vitest";
import { buildReport, type CheckResult, graded, notEvaluated, pass, qualityCheck, RULES } from "../src";
import { checkJlCuts, checkNoLinear } from "../src/checks/edl";

const edlOf = (input: EdlInput): Edl => {
  const r = parseEdl(input);
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
  return r.edl;
};

function twoClipEdl(fx: Fixtures, cutFadeMs: number): Edl {
  return edlOf({
    version: "1.0.0",
    output: {
      format: "short",
      width: 540,
      height: 960,
      fps: 30,
      video: { bitrateMbps: 20, preset: "veryfast" },
      audio: { cutFadeMs },
    },
    sources: { a: { path: fx.cam16x9, durationS: 6 }, b: { path: fx.cam9x16, durationS: 4 } },
    // In points chosen so the two sine waves are far from a zero crossing at the edit.
    video: [
      {
        id: "main",
        clips: [
          { id: "c1", source: "a", in: 0.5037, out: 2.5037, at: 0 },
          { id: "c2", source: "b", in: 1.0012, out: 3.0012, at: 60 },
        ],
      },
    ],
  });
}

describe("score", () => {
  it("weights 25 rules to 100 points, 20 per category", () => {
    expect(RULES).toHaveLength(25);
    expect(RULES.reduce((s, r) => s + r.weight, 0)).toBe(100);
    for (const cat of ["montage", "motion", "captions", "audio", "image"])
      expect(RULES.filter((r) => r.category === cat).reduce((s, r) => s + r.weight, 0)).toBe(20);
  });

  it("scores only evaluated rules and reports coverage", () => {
    const results: CheckResult[] = [
      pass("image.export-format"), // weight 3
      graded("image.bitrate", 1, [{ message: "trop bas" }]), // weight 2, score 0
      graded("audio.cut-clicks", 4, [{ message: "clic" }]), // weight 4, score 0.75
      notEvaluated("motion.no-linear", "aucune animation"),
    ];
    const report = buildReport({ video: "v.mp4", profile: "short@1.0.0" }, results);
    expect(report.coverage).toBe(9);
    expect(report.score).toBe(66.6); // 100 × (3 + 0 + 4 × 0.75) / 9 = 66.67, floored
    expect(report.categories.image.score).toBe(60);
    expect(report.categories.motion.score).toBeNull();
    expect(report.results.find((r) => r.ruleId === "captions.sync")?.status).toBe("not-evaluated");
  });
});

describe("EDL checks", () => {
  const base: EdlInput = {
    version: "1.0.0",
    output: { format: "short", width: 1080, height: 1920, fps: 30, video: { bitrateMbps: 20 }, audio: {} },
    sources: { a: { path: "a.mp4", durationS: 10 } },
    video: [
      {
        id: "main",
        clips: [
          { id: "c1", source: "a", in: 1, out: 2, at: 0 },
          { id: "c2", source: "a", in: 3, out: 4, at: 30, audioSplitFrames: 6 },
          { id: "c3", source: "a", in: 5, out: 6, at: 60, audioSplitFrames: -2 },
        ],
      },
    ],
  };

  it("measures J/L cut lengths against the profile", async () => {
    const profile = await loadProfile("short");
    const r = checkJlCuts(edlOf(base), profile);
    expect(r).toMatchObject({ status: "fail", score: 0.5 });
    expect(r.violations[0]?.message).toContain("c3");
  });

  it("counts linear keyframe segments (schema-valid EDL built by hand)", () => {
    const edl = edlOf(base);
    edl.keyframes = [
      {
        target: "c1.scale",
        keys: [
          { frame: 0, value: 1 },
          { frame: 5, value: 1.1, ease: "ease-out" },
          { frame: 9, value: 1 },
        ],
      },
      {
        target: "c1.rotation",
        keys: [
          { frame: 0, value: 0 },
          { frame: 5, value: 10 },
        ],
      },
    ];
    expect(checkNoLinear(edl)).toMatchObject({ status: "fail", score: 0.5 });
  });
});

describe("quality-check sur des rendus réels", () => {
  let fx: Fixtures;
  let profile: StyleProfile;
  let dir: string;
  let good: string;
  let edl: Edl;

  beforeAll(async () => {
    fx = await generateFixtures();
    profile = await loadProfile("short");
    dir = await mkdtemp(join(tmpdir(), "ck-qa-"));
    edl = twoClipEdl(fx, 8);
    good = join(dir, "good.mp4");
    await render(edl, { baseDir: fx.dir, outPath: good });
  });

  it("passes a clean render on every applicable rule", async () => {
    const report = await qualityCheck({ video: good, edl, profile, baseDir: fx.dir });
    const evaluated = report.results.filter((r) => r.status !== "not-evaluated");
    expect(evaluated.map((r) => r.ruleId).sort()).toEqual(
      [
        "audio.cut-clicks",
        "audio.loudness",
        "image.black-frames",
        "image.bitrate",
        "image.duplicate-frames",
        "image.export-format",
        "montage.static-shots",
        // The preset library itself is checked even when the EDL animates nothing.
        "motion.presets",
      ].sort(),
    );
    expect(evaluated.filter((r) => r.status === "fail")).toEqual([]);
    expect(report.score).toBe(100);
  });

  it("finds black and frozen frames the source does not have", async () => {
    const broken = join(dir, "broken.mp4");
    await ffmpeg([
      "-v",
      "error",
      "-i",
      good,
      "-filter_complex",
      "[0:v]drawbox=c=black:t=fill:enable='between(n,30,32)',split[a][b];[a][b]freezeframes=first=90:last=94:replace=89[v]",
      "-map",
      "[v]",
      "-map",
      "0:a",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-b:v",
      "20M",
      "-minrate",
      "20M",
      "-maxrate",
      "20M",
      "-bufsize",
      "40M",
      "-x264-params",
      "nal-hrd=cbr",
      "-c:a",
      "copy",
      "-y",
      broken,
    ]);
    const report = await qualityCheck({ video: broken, edl, profile, baseDir: fx.dir });
    const black = report.results.find((r) => r.ruleId === "image.black-frames");
    const dup = report.results.find((r) => r.ruleId === "image.duplicate-frames");
    expect(black?.status).toBe("fail");
    expect(black?.violations[0]).toMatchObject({ frame: 30 });
    expect(dup?.status).toBe("fail");
    expect(dup?.violations.map((v) => v.frame)).toContain(90);
    expect(report.score).toBeLessThan(100);
  });

  it("hears a click when an edit has no micro-fade", async () => {
    const hard = twoClipEdl(fx, 0);
    const video = join(dir, "hard-cut.mp4");
    await render(hard, { baseDir: fx.dir, outPath: video });
    const report = await qualityCheck({ video, edl: hard, profile, baseDir: fx.dir });
    const clicks = report.results.find((r) => r.ruleId === "audio.cut-clicks");
    expect(clicks?.status).toBe("fail");
    expect(clicks?.measured).toMatchObject({ clicks: 1 });
  });

  it("rejects VFR and off-rate exports", async () => {
    const report = await qualityCheck({ video: fx.phoneVfr, profile });
    const format = report.results.find((r) => r.ruleId === "image.export-format");
    expect(format?.status).toBe("fail");
    expect(format?.violations.map((v) => v.message).join(" ")).toMatch(/VFR/);
  });

  it("rejects an export under the minimum bitrate", async () => {
    const low = join(dir, "low.mp4");
    await ffmpeg([
      "-v",
      "error",
      "-i",
      good,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-b:v",
      "4M",
      "-c:a",
      "copy",
      "-y",
      low,
    ]);
    const report = await qualityCheck({ video: low, profile });
    const bitrate = report.results.find((r) => r.ruleId === "image.bitrate");
    expect(bitrate?.status).toBe("fail");
    expect(bitrate?.violations[0]?.message).toMatch(/< 16 Mbps/);
  });
});
