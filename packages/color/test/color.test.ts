import { type Analysis, type EdlInput, type Face, parseEdl, type Subjects } from "@cutkiller/core";
import { loadProfile, PresetRegistry } from "@cutkiller/style";
import { beforeAll, describe, expect, it } from "vitest";
import {
  applyLook,
  colorPass,
  gradeCube,
  gradeKey,
  LookParamsSchema,
  lightnessToY,
  linearToSrgb,
  type Rgb,
  shoulder,
  srgbToLab,
  srgbToLinear,
} from "../src";

let short: Awaited<ReturnType<typeof loadProfile>>;
let registry: PresetRegistry;
beforeAll(async () => {
  short = await loadProfile("short");
  registry = await PresetRegistry.load();
});

/** Values of a .cube file (red fastest), as [r, g, b] rows. */
const cubeRows = (cube: string) =>
  cube
    .split("\n")
    .filter((l) => /^[\d.]+ [\d.]+ [\d.]+$/.test(l))
    .map((l) => l.split(" ").map(Number) as Rgb);

describe("colorimétrie", () => {
  it("convertit sRGB ↔ linéaire ↔ CIELAB", () => {
    for (const v of [0, 0.02, 0.2, 0.5, 0.9, 1]) expect(linearToSrgb(srgbToLinear(v))).toBeCloseTo(v, 9);
    const white = srgbToLab([1, 1, 1]);
    expect(white[0]).toBeCloseTo(100, 2);
    expect(Math.hypot(white[1], white[2])).toBeLessThan(0.05);
    expect(srgbToLab([0.5, 0.5, 0.5])[0]).toBeCloseTo(53.4, 1);
    // Pure red: L* 53.2, a* 80.1, b* 67.2 (reference values).
    const red = srgbToLab([1, 0, 0]);
    expect(red[0]).toBeCloseTo(53.2, 0);
    expect(red[1]).toBeCloseTo(80.1, 0);
    expect(red[2]).toBeCloseTo(67.2, 0);
    for (const l of [5, 25, 50, 90]) {
      const y = lightnessToY(l);
      expect(srgbToLab([linearToSrgb(y), linearToSrgb(y), linearToSrgb(y)])[0]).toBeCloseTo(l, 4);
    }
  });

  it("compresse les hautes lumières sans écrêter, identité sans gain", () => {
    for (const m of [0, 0.3, 0.8, 1]) expect(shoulder(m, 1)).toBe(m);
    const top = 2 ** 0.8;
    expect(shoulder(0.4, top)).toBe(0.4);
    expect(shoulder(top, top)).toBeCloseTo(1, 12);
    let prev = 0;
    for (let m = 0; m <= top; m += 0.001) {
      const v = shoulder(m, top);
      expect(v).toBeGreaterThanOrEqual(prev);
      expect(v).toBeLessThanOrEqual(1);
      prev = v;
    }
    // Same slope on both sides of the knee: no visible kink.
    const e = 1e-6;
    expect((shoulder(0.5 + e, top) - shoulder(0.5, top)) / e).toBeCloseTo(1, 4);
  });

  it("cuit l'étalonnage d'un plan dans une LUT : identité, exposition, look", () => {
    const identity = cubeRows(gradeCube(undefined, [1, 1, 1], "id"));
    expect(identity).toHaveLength(33 ** 3);
    const n = 33;
    for (const [i, row] of identity.entries()) {
      const expected = [i % n, Math.floor(i / n) % n, Math.floor(i / n / n)].map((k) => k / (n - 1));
      for (let c = 0; c < 3; c++) expect(row[c]).toBeCloseTo(expected[c] as number, 5);
    }
    // +1 EV: dark greys double in linear light, white stays white (shoulder, no clipping).
    const lifted = cubeRows(gradeCube(undefined, [2, 2, 2], "up"));
    const grey = (k: number) => lifted[k + k * n + k * n * n] as Rgb;
    const g = 8 / 32;
    expect(srgbToLinear(grey(8)[1])).toBeCloseTo(2 * srgbToLinear(g), 4);
    expect(grey(32)).toEqual([1, 1, 1]);
    expect(grey(28)[1]).toBeLessThan(1);
    // The look is applied after the gains.
    const look = LookParamsSchema.parse(registry.resolve("clean@1")?.params);
    const withLook = cubeRows(gradeCube(look, [1, 1, 1], "look"));
    const mid = withLook[16 + 16 * n + 16 * n * n] as Rgb;
    expect(mid[0]).toBeCloseTo(applyLook(look, [0.5, 0.5, 0.5])[0], 5);
    expect(gradeKey({ exposureEv: 0.5, balance: [1, 0.9, 1.1], look: "clean@1.0.0" })).toBe(
      "clean@1.0.0|0.5|1,0.9,1.1",
    );
  });
});

/** A source whose face has the given skin colour (display sRGB) on every sample. */
function skinOf(rgb: Rgb, duration = 4): Subjects {
  return {
    width: 1920,
    height: 1080,
    sampleFps: 5,
    samples: Array.from({ length: duration * 5 + 1 }, (_, i) => ({
      t: i / 5,
      faces: [{ x: 0.4, y: 0.3, w: 0.2, h: 0.3, score: 0.9, rgb }],
      rgb: [0.5, 0.5, 0.5] as Rgb,
    })),
  };
}

function graded(skins: Record<string, Rgb>, durations: Record<string, number>) {
  const ids = Object.keys(skins);
  let at = 0;
  const clips = ids.flatMap((s, k) =>
    [0, 1].map((j) => {
      const len = durations[s] as number;
      const clip = { id: `c${k}${j}`, source: s, in: j * (len / 2), out: (j + 1) * (len / 2), at };
      at += Math.round((len / 2) * 30);
      return clip;
    }),
  );
  const edl = parseEdl({
    version: "1.4.0",
    output: { format: "long", width: 1920, height: 1080, fps: 30, video: { bitrateMbps: 16 }, audio: {} },
    sources: Object.fromEntries(ids.map((s) => [s, { path: `${s}.mp4`, durationS: durations[s] }])),
    video: [{ id: "main", clips }],
  } satisfies EdlInput);
  if (!edl.ok) throw new Error(JSON.stringify(edl.diagnostics));
  const analysis: Analysis = {
    sources: Object.fromEntries(
      ids.map((s) => [
        s,
        { path: `${s}.mp4`, durationS: durations[s] as number, hasVideo: true, hasAudio: true },
      ]),
    ),
    subjects: Object.fromEntries(ids.map((s) => [s, skinOf(skins[s] as Rgb, durations[s])])),
  };
  return colorPass.run(edl.edl, { analysis, profile: short, presets: registry });
}

const lab = (rgb: Rgb) => srgbToLab(rgb);

describe("passe color", () => {
  const warm: Rgb = [0.78, 0.58, 0.48];

  it("ramène la peau d'une seconde caméra (sous-exposée, bleue) sur la référence", () => {
    // A stop under, and blue: linear gains 0.45 / 0.5 / 0.6 on the reference skin.
    const cold = warm.map((v, i) => linearToSrgb(srgbToLinear(v) * ([0.45, 0.5, 0.6][i] as number))) as Rgb;
    const { edl, diagnostics } = graded({ a: warm, b: cold }, { a: 6, b: 2 });
    const clips = edl.video[0]?.clips ?? [];
    // The longer source is the reference: untouched; every shot of b gets the same correction.
    for (const c of clips.filter((c) => c.source === "a")) {
      expect(c.color?.exposureEv).toBe(0);
      expect(c.color?.balance).toEqual([1, 1, 1]);
    }
    const b = clips.filter((c) => c.source === "b");
    expect(b[0]?.color).toEqual(b[1]?.color);
    const color = b[0]?.color;
    if (!color) throw new Error("pas d'étalonnage");
    expect(color.exposureEv).toBeGreaterThan(0.5);
    expect(color.balance[0]).toBeGreaterThan(1);
    expect(color.balance[2]).toBeLessThan(1);
    expect(color.look).toBe("clean@1.0.0");
    // Applying the grade (linear gains) brings b's skin within 0.5 ΔE of a's.
    const gains = color.balance.map((g) => g * 2 ** color.exposureEv);
    const fixed = cold.map((v, i) => linearToSrgb(srgbToLinear(v) * (gains[i] as number))) as Rgb;
    const [l1, a1, b1] = lab(fixed);
    const [l0, a0, b0] = lab(warm);
    expect(Math.hypot(l1 - l0, a1 - a0, b1 - b0)).toBeLessThan(0.5);
    expect(diagnostics.find((d) => d.code === "color.summary")?.message).toMatch(/^2 plan/);
  });

  it("ne corrige pas un écart sous le seuil et relève une référence sous-exposée", () => {
    const { edl } = graded({ a: warm, b: [0.775, 0.58, 0.48] }, { a: 4, b: 4 });
    for (const c of edl.video[0]?.clips ?? []) {
      expect(c.color?.exposureEv).toBe(0);
      expect(c.color?.balance).toEqual([1, 1, 1]);
    }
    // A backlit face (L* ≈ 19): every shot is lifted to L* 25, within maxExposureEv.
    const dark: Rgb = [0.29, 0.16, 0.14];
    expect(lab(dark)[0]).toBeLessThan(short.color.minSkinLightness);
    const lifted = graded({ a: dark }, { a: 4 }).edl.video[0]?.clips[0]?.color;
    const ev = lifted?.exposureEv ?? 0;
    expect(ev).toBeGreaterThan(0.3);
    expect(ev).toBeLessThanOrEqual(short.color.maxExposureEv);
    const after = dark.map((v) => linearToSrgb(srgbToLinear(v) * 2 ** ev)) as Rgb;
    expect(lab(after)[0]).toBeCloseTo(short.color.minSkinLightness, 0);
  });

  it("raccorde isolément un plan dont la peau s'écarte de sa source", () => {
    const { edl } = graded({ a: warm }, { a: 6 });
    const subjects = skinOf(warm, 6);
    // The light changes at 3.5 s: the last shot (3–6 s) sees a duller, darker skin.
    const dull: Rgb = [0.66, 0.52, 0.45];
    for (const x of subjects.samples) if (x.t >= 3.5) x.faces[0] = { ...(x.faces[0] as Face), rgb: dull };
    expect(Math.hypot(...lab(dull).map((v, i) => v - (lab(warm)[i] as number)))).toBeGreaterThan(
      short.color.shotMatchDeltaE,
    );
    const analysis: Analysis = {
      sources: { a: { path: "a.mp4", durationS: 6, hasVideo: true, hasAudio: true } },
      subjects: { a: subjects },
    };
    const { edl: out, diagnostics } = colorPass.run(edl, { analysis, profile: short, presets: registry });
    const [first, last] = out.video[0]?.clips ?? [];
    expect(first?.color?.exposureEv).toBe(0);
    expect(last?.color?.exposureEv).toBeGreaterThan(0.2);
    expect(diagnostics[0]?.message).toMatch(/1 plan\(s\) raccordé\(s\) isolément/);
  });

  it("applique seulement le look à une source sans visage", () => {
    const { edl } = graded({ a: warm }, { a: 4 });
    const noFace = structuredClone(edl);
    const analysis: Analysis = {
      sources: { a: { path: "a.mp4", durationS: 4, hasVideo: true, hasAudio: true } },
      subjects: { a: { width: 1920, height: 1080, sampleFps: 5, samples: [] } },
    };
    const out = colorPass.run(noFace, { analysis, profile: short, presets: registry }).edl;
    for (const c of out.video[0]?.clips ?? []) {
      expect(c.color?.why?.kind).toBe("look-only");
      expect(c.color?.exposureEv).toBe(0);
      expect(c.color?.look).toBe("clean@1.0.0");
    }
  });
});
