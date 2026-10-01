import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Ease, type EdlInput, parseEdl } from "@cutkiller/core";
import { MotionTimeline, resolveTransitions } from "@cutkiller/motion";
import { loadProfile, PresetRegistry } from "@cutkiller/style";
import { beforeAll, describe, expect, it } from "vitest";
import {
  checkDurations,
  checkMotionBlur,
  checkOvershoot,
  checkPresets,
  checkPunchIns,
} from "../src/checks/motion";

let registry: PresetRegistry;
let profile: Awaited<ReturnType<typeof loadProfile>>;
beforeAll(async () => {
  registry = await PresetRegistry.load();
  profile = await loadProfile("short");
});

const spring: Ease = { spring: { stiffness: 1310, damping: 50, mass: 1 } };
const input = (extra: Partial<EdlInput> = {}): EdlInput => ({
  version: "1.1.0",
  output: { format: "short", width: 1080, height: 1920, fps: 30, video: { bitrateMbps: 20 }, audio: {} },
  sources: { a: { path: "a.mp4", durationS: 10 }, b: { path: "b.mp4", durationS: 10 } },
  video: [
    {
      id: "main",
      clips: [
        { id: "A", source: "a", in: 0, out: 2, at: 0 },
        { id: "B", source: "b", in: 0, out: 2, at: 60 },
      ],
    },
  ],
  ...extra,
});
const edlOf = (i: EdlInput) => {
  const r = parseEdl(i);
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
  return r.edl;
};
const punch = (from: number, to: number, ease: Ease = spring, extra = {}) => ({
  target: "A.scale",
  role: "micro" as const,
  preset: "zoom-punch@1",
  keys: [
    { frame: from, value: 1 },
    { frame: to, value: 1.1, ease },
  ],
  why: { kind: "emphasis", wordIds: [3] },
  ...extra,
});

describe("bibliothèque de presets", () => {
  it("les presets du repo respectent toutes les règles", () => {
    const r = checkPresets(edlOf(input()), registry, profile);
    expect(r.violations).toEqual([]);
    expect(r.measured).toMatchObject({ presets: 8 });
  });

  it("signale durée, linéarité, forme et dépassement hors règles", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ck-presets-"));
    await mkdir(join(dir, "motion"));
    await mkdir(join(dir, "transition"));
    const put = (kind: string, name: string, params: unknown) =>
      writeFile(
        join(dir, kind, `${name}@1.0.0.json`),
        JSON.stringify({ name, version: "1.0.0", kind, params }),
      );
    await put("motion", "bad-entry", {
      property: "scale",
      role: "entry",
      durationMs: 250,
      ease: "ease-in-cubic",
    });
    await put("motion", "bad-bounce", {
      property: "scale",
      role: "micro",
      durationMs: 200,
      ease: "ease-out-back",
    });
    await put("transition", "slow-linear", {
      type: "push",
      durationMs: 800,
      direction: "left",
      ease: "linear",
    });
    const bad = await PresetRegistry.load(dir);
    const messages = checkPresets(edlOf(input()), bad, profile)
      .violations.map((v) => v.message)
      .join("\n");
    expect(messages).toMatch(/bad-entry@1.0.0 : une entrée doit décélérer/);
    expect(messages).toMatch(/bad-bounce@1.0.0 : dépassement de (9\.[5-9]|10\.\d) %/);
    expect(messages).toMatch(/slow-linear@1.0.0 : 800 ms/);
    expect(messages).toMatch(/slow-linear@1.0.0 : courbe linéaire/);
  });
});

describe("animations de l'EDL", () => {
  it("durées : micro 150–300 ms, transitions 200–500 ms", () => {
    const ok = edlOf(
      input({
        keyframes: [punch(10, 16)],
        transitions: [{ id: "t", atFrame: 60, preset: "whip-pan@1", durationFrames: 9 }],
      }),
    );
    expect(checkDurations(ok, profile).status).toBe("pass");
    const slow = edlOf(input({ keyframes: [punch(10, 25)] }));
    expect(checkDurations(slow, profile).violations[0]?.message).toBe("A.scale : 500 ms");
    expect(checkPresets(slow, registry, profile).violations[0]?.message).toMatch(/ne suit plus zoom-punch@1/);
  });

  it("dépassement : léger rebond toléré en micro, interdit en sortie", () => {
    expect(checkOvershoot(edlOf(input({ keyframes: [punch(10, 16)] })), registry, profile).status).toBe(
      "pass",
    );
    const exit = edlOf(input({ keyframes: [punch(10, 16, spring, { role: "exit" })] }));
    const messages = checkOvershoot(exit, registry, profile)
      .violations.map((v) => v.message)
      .join("\n");
    expect(messages).toMatch(/aucun autorisé/);
    expect(messages).toMatch(/une sortie doit accélérer/);
  });

  it("punch-ins animés : ancrés sur un mot d'emphase", () => {
    const anchored = edlOf(input({ keyframes: [punch(10, 16)] }));
    expect(checkPunchIns(anchored, profile).status).toBe("pass");
    const loose = edlOf(input({ keyframes: [punch(10, 16, spring, { why: undefined })] }));
    expect(checkPunchIns(loose, profile).violations[0]?.message).toMatch(/sans mot d'emphase/);
  });
});

describe("flou de mouvement (journal de rendu)", () => {
  it("chaque frame plus rapide que le seuil doit avoir été rendue en plusieurs échantillons", async () => {
    const edl = edlOf(
      input({ transitions: [{ id: "t", atFrame: 60, preset: "whip-pan@1", durationFrames: 9 }] }),
    );
    const tl = new MotionTimeline(edl, resolveTransitions(edl, registry));
    const fast = Array.from({ length: 120 }, (_, f) => [f, tl.velocityAt(f)] as const).filter(
      ([, v]) => v > 12,
    );
    const dir = await mkdtemp(join(tmpdir(), "ck-blur-"));
    const video = join(dir, "v.mp4");
    const log = (samples: (f: number) => number) =>
      writeFile(
        `${video}.render-log.json`,
        JSON.stringify({
          frames: 120,
          motion: { frames: fast.map(([f, v]) => [f, v, samples(f)]), blurredFrames: 0, glitchFrames: 0 },
        }),
      );
    await log(() => 8);
    expect(checkMotionBlur(video, edl, registry, profile)).toMatchObject({
      status: "pass",
      measured: { fastFrames: fast.length },
    });
    await log((f) => (f === 60 ? 1 : 8));
    const r = checkMotionBlur(video, edl, registry, profile);
    expect(r.status).toBe("fail");
    expect(r.violations[0]?.frame).toBe(60);
    expect(checkMotionBlur(join(dir, "absent.mp4"), edl, registry, profile).status).toBe("not-evaluated");
  });
});
