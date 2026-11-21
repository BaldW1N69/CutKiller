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
  sceneLook,
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

function graded(
  skins: Record<string, Rgb>,
  durations: Record<string, number>,
  profile?: Awaited<ReturnType<typeof loadProfile>>,
  luma?: Record<string, [number, number, number]>,
) {
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
    subjects: Object.fromEntries(
      ids.map((s) => {
        const subjects = skinOf(skins[s] as Rgb, durations[s]);
        const l = luma?.[s];
        if (l) for (const x of subjects.samples) x.luma = l;
        return [s, subjects];
      }),
    ),
  };
  return colorPass.run(edl.edl, { analysis, profile: profile ?? short, presets: registry });
}

const lab = (rgb: Rgb) => srgbToLab(rgb);

describe("look film-print (split toning)", () => {
  const warm: Rgb = [0.78, 0.58, 0.48];
  const luma = ([r, g, b]: Rgb) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

  it("refroidit les ombres, réchauffe les hautes lumières, sans toucher la luminance", async () => {
    const look = LookParamsSchema.parse(registry.resolve("film-print@1").params);
    const flat = { ...look, contrast: 0, lift: 0 };
    const dark = applyLook(flat, [0.15, 0.15, 0.15]);
    const bright = applyLook(flat, [0.8, 0.8, 0.8]);
    expect(dark[2]).toBeGreaterThan(dark[0]);
    expect(bright[0]).toBeGreaterThan(bright[2]);
    expect(luma(dark)).toBeCloseTo(0.15, 3);
    expect(luma(bright)).toBeCloseTo(0.8, 3);
    // Black and white stay neutral: no coloured clipping at the ends (the lift
    // leaves black at 2 %, barely toned).
    for (const v of [0, 1]) {
      const flatEnd = applyLook(flat, [v, v, v]);
      expect(Math.max(...flatEnd) - Math.min(...flatEnd)).toBeLessThan(1e-9);
      const end = applyLook(look, [v, v, v]);
      expect(Math.max(...end) - Math.min(...end)).toBeLessThan(0.01);
    }
  });

  it("tourne les teintes : verts vers le jaune, bleus vers le cyan, peau intacte", () => {
    const look = LookParamsSchema.parse(registry.resolve("film-print@1").params);
    const neutral = {
      ...look,
      contrast: 0,
      lift: 0,
      shadowTint: [0, 0, 0],
      highlightTint: [0, 0, 0],
    } as typeof look;
    const hue = ([r, g, b]: Rgb) => {
      const max = Math.max(r, g, b);
      const d = max - Math.min(r, g, b);
      const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      return (h * 60 + 360) % 360;
    };
    const green: Rgb = [0.3, 0.55, 0.3];
    const blue: Rgb = [0.25, 0.35, 0.65];
    expect(hue(applyLook(neutral, green))).toBeLessThan(hue(green) - 6);
    expect(hue(applyLook(neutral, blue))).toBeLessThan(hue(blue) - 6);
    expect(luma(applyLook(neutral, green))).toBeCloseTo(luma(green), 6);
    for (const skin of [warm, [0.55, 0.38, 0.3] as Rgb, [0.92, 0.75, 0.66] as Rgb]) {
      const out = applyLook(neutral, skin);
      const [l0, a0, b0] = lab(skin);
      const [l1, a1, b1] = lab(out);
      expect(Math.hypot(l1 - l0, a1 - a0, b1 - b0)).toBeLessThan(1);
    }
  });

  it("adapte la courbe à chaque scène : plus de contraste à une scène plate, moins à une scène dure", async () => {
    const cine = await loadProfile("cinematic");
    const { edl, diagnostics } = graded({ a: warm, b: warm }, { a: 4, b: 4 }, cine, {
      a: [0.3, 0.45, 0.6],
      b: [0.05, 0.4, 0.95],
    });
    const contrast = (s: string) => edl.video[0]?.clips.find((c) => c.source === s)?.color?.contrast;
    expect(contrast("a")).toBeCloseTo(0.12, 3); // span 0.3: strength 0.5 × (0.72/0.3 − 1) = 0.7, capped
    expect(contrast("b")).toBeCloseTo(Math.round(500 * (0.72 / 0.9 - 1)) / 1000, 6); // span 0.9: −0.1
    expect(diagnostics.find((d) => d.code === "color.summary")?.message).toMatch(
      /contraste adapté sur 2 scène/,
    );
    // Same look everywhere: the scene adjustment is a parameter of it, not another look.
    expect(new Set(edl.video[0]?.clips.map((c) => c.color?.look))).toEqual(new Set(["film-print@1.0.0"]));
    const flat = sceneLook(LookParamsSchema.parse(registry.resolve("film-print@1").params), 0.12);
    expect(flat.contrast).toBeCloseTo(0.26, 6);
    expect(gradeKey({ exposureEv: 0, balance: [1, 1, 1], look: "x", contrast: 0.1 })).not.toBe(
      gradeKey({ exposureEv: 0, balance: [1, 1, 1], look: "x" }),
    );
    // Off in the other profiles.
    const plain = graded({ a: warm }, { a: 4 }, short, { a: [0.3, 0.45, 0.6] });
    expect(plain.edl.video[0]?.clips[0]?.color?.contrast).toBeUndefined();
  });

  it("laisse le look clean@1 identique (teintes par défaut nulles)", () => {
    const clean = LookParamsSchema.parse(registry.resolve("clean@1").params);
    expect(clean.shadowTint).toEqual([0, 0, 0]);
    const grey = applyLook(clean, [0.5, 0.5, 0.5]);
    expect(grey[0]).toBeCloseTo(grey[2], 9);
  });
});

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

describe("B-roll : raccord de peau par scène", () => {
  it("raccorde un plan de B-roll à sa scène, jamais à la peau du locuteur", async () => {
    const warm: Rgb = [0.78, 0.58, 0.48];
    const shade = warm.map((v) => linearToSrgb(srgbToLinear(v) * 0.4)) as Rgb;
    // Rush b: 0–6 s in the sun, 6–8 s in the shade; three shots.
    const b = skinOf(warm, 8);
    for (const x of b.samples) if (x.t >= 6) x.faces[0] = { ...(x.faces[0] as Face), rgb: shade };
    const edl = parseEdl({
      version: "1.5.0",
      output: { format: "short", width: 1080, height: 1920, fps: 30, video: { bitrateMbps: 16 }, audio: {} },
      sources: { b: { path: "b.mp4", durationS: 8, role: "broll" } },
      video: [
        {
          id: "main",
          clips: [
            { id: "s1", source: "b", in: 0, out: 2.5, at: 0, why: { kind: "broll" } },
            { id: "s2", source: "b", in: 3, out: 5.5, at: 75, why: { kind: "broll" } },
            { id: "s3", source: "b", in: 6, out: 8, at: 150, why: { kind: "broll" } },
          ],
        },
      ],
    } satisfies EdlInput);
    if (!edl.ok) throw new Error(JSON.stringify(edl.diagnostics));
    const analysis: Analysis = {
      sources: { b: { path: "b.mp4", durationS: 8, hasVideo: true, hasAudio: false, role: "broll" } },
      subjects: { b },
    };
    const out = colorPass.run(edl.edl, { analysis, profile: short, presets: registry }).edl;
    const ev = (id: string) => out.video[0]?.clips.find((c) => c.id === id)?.color?.exposureEv;
    expect(ev("s1")).toBe(0);
    expect(ev("s2")).toBe(0);
    // 0.4× linear = −1.32 EV: brought back to the scene.
    expect(ev("s3")).toBeCloseTo(1.32, 1);
  });
});
