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
      "--min-score",
      "90",
    );
    expect(run.status, run.stderr).toBe(0);
    const report = JSON.parse(await readFile(join(dir, "quality.json"), "utf8"));
    expect(report.score).toBeGreaterThanOrEqual(90);
    const edl = JSON.parse(await readFile(join(dir, "edit.edl.json"), "utf8"));
    expect(edl.video[0].clips).toHaveLength(3);
    expect(edl.audio[0].clips[0].source).toBe("music-120bpm");
    // The EDL on disk is the contract: a hand-edited copy must still validate.
    expect(cli("validate", join(dir, "edit.edl.json")).status).toBe(0);
  });

  it("validate rejects a broken EDL with readable diagnostics", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ck-cli-"));
    const path = join(dir, "bad.json");
    await (await import("node:fs/promises")).writeFile(path, JSON.stringify({ version: "1.0.0" }));
    const run = cli("validate", path);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/output/);
  });
});
