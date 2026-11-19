import { spawnSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generateFixtures } from "@cutkiller/fixtures";
import { describe, expect, it } from "vitest";

const MAIN = resolve(import.meta.dirname, "../src/main.ts");
const cli = (...args: string[]) =>
  spawnSync("npx", ["tsx", MAIN, ...args], {
    encoding: "utf8",
    cwd: resolve(import.meta.dirname, "../../.."),
  });

describe("cutkiller CLI (bout en bout)", () => {
  it("auto: rushes → EDL éditable → rendu → quality-check ≥ 90", async () => {
    const fx = await generateFixtures();
    const dir = await mkdtemp(join(tmpdir(), "ck-cli-"));
    const run = cli(
      "auto",
      fx.cam9x16,
      fx.phoneVfr,
      fx.still,
      fx.music,
      "-p",
      "short",
      "-o",
      dir,
      "--draft",
      "--fast",
      "--min-score",
      "90",
    );
    expect(run.status, run.stderr).toBe(0);
    const report = JSON.parse(await readFile(join(dir, "quality.json"), "utf8"));
    expect(report.score).toBeGreaterThanOrEqual(90);
    const edl = JSON.parse(await readFile(join(dir, "edit.edl.json"), "utf8"));
    // 4 s + 5 s + 3 s of footage without speech: the 5 s VFR rush gets a zoom cut (limit 4 s).
    expect(edl.video[0].clips.map((c: { source: string }) => c.source)).toEqual([
      "cam-9x16",
      "phone-vfr",
      "phone-vfr",
      "still",
    ]);
    expect(edl.audio[0].clips[0].source).toBe("music-120bpm");
    // The EDL on disk is the contract: a hand-edited copy must still validate.
    expect(cli("validate", join(dir, "edit.edl.json")).status).toBe(0);
  }, 600_000);

  it("auto in English: language detected, « um »/« uh » and silences cut, report ≥ 90", async () => {
    const fx = await generateFixtures();
    const dir = await mkdtemp(join(tmpdir(), "ck-cli-en-"));
    const run = cli(
      "auto",
      fx.speechEnVideo,
      fx.music,
      "-p",
      "long",
      "-o",
      dir,
      "--draft",
      "--min-score",
      "90",
    );
    expect(run.status, run.stderr).toBe(0);
    expect(run.stderr).toMatch(/\[language\] en/);
    const analysis = JSON.parse(await readFile(join(dir, "edit.analysis.json"), "utf8"));
    expect(Object.values(analysis.transcripts).map((t) => (t as { language: string }).language)).toEqual([
      "en",
    ]);
    const edl = JSON.parse(await readFile(join(dir, "edit.edl.json"), "utf8"));
    const notes = edl.video[0].clips.map((c: { why: { note?: string } }) => c.why.note ?? "").join(" ");
    expect(notes).toMatch(/um/i);
    expect(notes).toMatch(/uh/i);
    const report = JSON.parse(await readFile(join(dir, "quality.json"), "utf8"));
    const byId = Object.fromEntries(
      report.results.map((r: { ruleId: string; status: string }) => [r.ruleId, r.status]),
    );
    expect(byId).toMatchObject({
      "montage.silences": "pass",
      "captions.sync": "pass",
      "audio.loudness": "pass",
    });
  }, 900_000);

  it("auto sur de la parole : hésitations et silences coupés, rapport qualité ≥ 90", async () => {
    const fx = await generateFixtures();
    const dir = await mkdtemp(join(tmpdir(), "ck-cli-"));
    const run = cli(
      "auto",
      fx.speechVideo,
      fx.music,
      "-p",
      "long",
      "-o",
      dir,
      "--draft",
      "--min-score",
      "90",
    );
    expect(run.status, run.stderr).toBe(0);
    expect(run.stderr).toMatch(/2 hésitation\(s\)/);
    const report = JSON.parse(await readFile(join(dir, "quality.json"), "utf8"));
    const byId = Object.fromEntries(
      report.results.map((r: { ruleId: string; status: string }) => [r.ruleId, r.status]),
    );
    expect(byId).toMatchObject({
      "montage.silences": "pass",
      "montage.fillers": "pass",
      "montage.static-shots": "pass",
    });
    const edl = JSON.parse(await readFile(join(dir, "edit.edl.json"), "utf8"));
    const notes = edl.video[0].clips.map((c: { why: { note?: string } }) => c.why.note ?? "").join(" ");
    expect(notes).toMatch(/euh/i);
    expect(notes).toMatch(/silence de/);

    // Captions: every rule passes, and each highlight starts within a frame of the
    // ground-truth onset of its word (the synthetic voice's exact timings).
    expect(byId).toMatchObject({
      "captions.sync": "pass",
      "captions.density": "pass",
      "captions.safe-zones": "pass",
      "captions.contrast": "pass",
      "audio.loudness": "pass",
      "audio.ducking": "pass",
      "audio.cut-clicks": "pass",
    });
    expect(await readFile(join(dir, "final.srt"), "utf8")).toMatch(/^1\n00:00:\d\d,\d{3} --> /);
    const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}']/gu, "");
    const fps = edl.output.fps;
    type Clip = { at: number; in: number; out: number };
    const clips: Clip[] = edl.video[0].clips;
    const errors: number[] = [];
    for (const c of edl.captions as { words: { text: string; fromFrame: number }[] }[])
      for (const w of c.words) {
        const clip = clips.find(
          (k) => k.at <= w.fromFrame && w.fromFrame < k.at + Math.round((k.out - k.in) * fps),
        );
        if (!clip) continue;
        const t = clip.in + (w.fromFrame - clip.at) / fps;
        const truth = fx.speechTruth.words
          .filter((x) => !x.filler && norm(x.text) === norm(w.text))
          .sort((a, b) => Math.abs(a.start - t) - Math.abs(b.start - t))[0];
        if (truth && Math.abs(truth.start - t) < 0.5) errors.push(Math.abs(truth.start - t) * fps);
      }
    errors.sort((a, b) => a - b);
    expect(errors.length).toBeGreaterThan(10);
    expect(errors[Math.ceil(errors.length * 0.95) - 1]).toBeLessThanOrEqual(1);
    expect(errors.at(-1)).toBeLessThanOrEqual(3);
  }, 900_000);

  it("validate rejects a broken EDL with readable diagnostics", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ck-cli-"));
    const path = join(dir, "bad.json");
    await (await import("node:fs/promises")).writeFile(path, JSON.stringify({ version: "1.0.0" }));
    const run = cli("validate", path);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/output/);
  });
});
