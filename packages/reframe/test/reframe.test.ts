import {
  type Analysis,
  clipEnd,
  clipFraming,
  type EdlInput,
  parseEdl,
  type Subjects,
  validateEdl,
} from "@cutkiller/core";
import { loadProfile } from "@cutkiller/style";
import { beforeAll, describe, expect, it } from "vitest";
import { easePeakAcceleration, planCamera, reframePass, subjectTrack } from "../src";

let short: Awaited<ReturnType<typeof loadProfile>>;
beforeAll(async () => {
  short = await loadProfile("short");
});

const settings = {
  deadZone: 0.1,
  minDriftS: 0.5,
  smoothingS: 0.8,
  moveS: [0.4, 2] as [number, number],
};

/** Subject positions sampled at 5/s over `duration` seconds. */
const track = (duration: number, at: (t: number) => number) =>
  Array.from({ length: Math.round(duration * 5) + 1 }, (_, i) => ({ t: i / 5, value: at(i / 5) }));

/** A face of the given centre on every sample (5/s), in a 1920×1080 source. */
function subjectsOf(duration: number, centre: (t: number) => number): Subjects {
  return {
    width: 1920,
    height: 1080,
    sampleFps: 5,
    samples: track(duration, centre).map(({ t, value }) => ({
      t,
      faces: [{ x: value - 0.06, y: 0.3, w: 0.12, h: 0.25, score: 0.9, rgb: [0.7, 0.5, 0.4] }],
      rgb: [0.5, 0.5, 0.5],
    })),
  };
}

function plan(duration: number, centre: (t: number) => number) {
  const edl = parseEdl({
    version: "1.4.0",
    output: { format: "short", width: 1080, height: 1920, fps: 30, video: { bitrateMbps: 16 }, audio: {} },
    sources: { a: { path: "a.mp4", durationS: duration, width: 1920, height: 1080 } },
    video: [{ id: "main", clips: [{ id: "c1", source: "a", in: 0, out: duration, at: 0 }] }],
  } satisfies EdlInput);
  if (!edl.ok) throw new Error(JSON.stringify(edl.diagnostics));
  const analysis: Analysis = {
    sources: { a: { path: "a.mp4", durationS: duration, hasVideo: true, hasAudio: false } },
    subjects: { a: subjectsOf(duration, centre) },
  };
  return reframePass.run(edl.edl, { analysis, profile: short });
}

describe("caméra virtuelle", () => {
  it("reste immobile tant que le sujet bouge dans la zone morte", () => {
    const keys = planCamera(
      track(6, (t) => 0.5 + 0.02 * Math.sin(t * 3)),
      0.316,
      6,
      settings,
    );
    expect(keys).toHaveLength(1);
    expect(keys?.[0]?.value).toBeCloseTo(0.5, 1);
  });

  it("ignore un regard de côté plus court que minDriftS", () => {
    const keys = planCamera(
      track(6, (t) => (t >= 2 && t < 2.3 ? 0.7 : 0.5)),
      0.316,
      6,
      settings,
    );
    expect(keys).toHaveLength(1);
  });

  it("suit un déplacement : tenue, glissement posé sur celui du sujet, tenue", () => {
    const keys = planCamera(
      track(8, (t) => (t < 3 ? 0.3 : 0.7)),
      0.316,
      8,
      settings,
    );
    expect(keys?.map((k) => k.value)).toEqual([0.3, 0.3, 0.7]);
    const [, start, end] = keys ?? [];
    // The subject jumps between the samples at 2.8 and 3.0 s: the glide is centred on
    // its midpoint (2.9 s), not started after the drift is confirmed (3.5 s).
    expect(((start?.t ?? 0) + (end?.t ?? 0)) / 2).toBeCloseTo(2.9, 6);
    expect((end?.t ?? 0) - (start?.t ?? 0)).toBeCloseTo(settings.moveS[0], 6);
  });

  it("épouse la durée d'un déplacement lent du sujet", () => {
    // Smoothstep from 0.3 to 0.7 between 2 and 3.6 s.
    const keys = planCamera(
      track(8, (t) => {
        const p = Math.min(1, Math.max(0, (t - 2) / 1.6));
        return 0.3 + 0.4 * p * p * (3 - 2 * p);
      }),
      0.316,
      8,
      settings,
    );
    const [, start, end] = keys ?? [];
    expect(start?.t).toBeGreaterThan(1.7);
    expect(start?.t).toBeLessThan(2.3);
    expect(end?.t).toBeGreaterThan(3.3);
    expect(end?.t).toBeLessThan(3.9);
  });

  it("ralentit un mouvement jusqu'à respecter l'accélération maximale, au-delà de moveS", () => {
    const keys = planCamera(
      track(8, (t) => (t < 3 ? 0.3 : 0.7)),
      0.316,
      8,
      { ...settings, minMoveS: (d) => d * 6 },
    );
    const [, start, end] = keys ?? [];
    expect((end?.t ?? 0) - (start?.t ?? 0)).toBeCloseTo(0.4 * 6, 6);
    expect(((start?.t ?? 0) + (end?.t ?? 0)) / 2).toBeCloseTo(2.9, 6);
  });

  it("avance un déplacement tardif pour qu'il finisse sur la coupe", () => {
    const keys = planCamera(
      track(4, (t) => (t < 3.3 ? 0.3 : 0.7)),
      0.316,
      4,
      { ...settings, minMoveS: () => 2 },
    );
    const [, start, end] = keys ?? [];
    expect(end?.value).toBe(0.7);
    expect(end?.t).toBeCloseTo(4, 6);
    expect(start?.t).toBeCloseTo(2, 6);
  });

  it("ne cadre rien quand le sujet n'est jamais vu", () => {
    expect(
      planCamera(
        track(3, () => Number.NaN),
        0.316,
        3,
        settings,
      ),
    ).toBeUndefined();
  });

  it("garde le même visage d'un échantillon à l'autre", () => {
    const subjects = subjectsOf(2, () => 0.3);
    // A second, larger face appears on the right: the tracked subject stays the first one.
    for (const s of subjects.samples.slice(3))
      s.faces.push({ x: 0.7, y: 0.3, w: 0.13, h: 0.26, score: 0.9, rgb: [0.6, 0.5, 0.4] });
    const values = subjectTrack(subjects, "x", 0, 2).map((p) => p.value);
    for (const v of values) expect(v).toBeCloseTo(0.3, 6);
  });

  it("classe ease-in-out comme la courbe la plus douce", () => {
    expect(easePeakAcceleration("ease-in-out")).toBeCloseTo(4.44, 1);
    expect(easePeakAcceleration("ease-in-out-cubic")).toBeGreaterThan(12);
    expect(easePeakAcceleration({ spring: { stiffness: 100, damping: 10, mass: 1 } })).toBe(
      Number.POSITIVE_INFINITY,
    );
  });
});

describe("passe reframe et géométrie du cadrage", () => {
  it("recadre un rush 16:9 en 9:16 sur le visage, clés dans le plan, sans à-coup", () => {
    const { edl, diagnostics } = plan(8, (t) => (t < 3 ? 0.3 : 0.7));
    expect(validateEdl(edl).filter((d) => d.level === "error")).toEqual([]);
    expect(diagnostics.find((d) => d.code === "reframe.summary")?.message).toMatch(/^1 plan/);
    const clip = edl.video[0]?.clips[0];
    if (!clip?.reframe) throw new Error("plan non recadré");
    expect(clip.reframe.axis).toBe("x");
    expect(clip.reframe.keys[0]?.value).toBeCloseTo(0.3, 2);
    expect(clip.reframe.keys.at(-1)?.value).toBeCloseTo(0.7, 2);

    const framing = clipFraming(edl, clip);
    if (!framing) throw new Error("pas de géométrie");
    // Crop of 1080 source rows (9:16 → 607.5 px wide), band covering both positions, whole pixels.
    expect(framing.band.h).toBe(1080);
    expect(Number.isInteger(framing.band.x) && Number.isInteger(framing.band.w)).toBe(true);
    expect(framing.outPerSrc).toBeCloseTo(1920 / 1080, 6);
    expect(framing.centreAt(0) / 1920).toBeCloseTo(0.3, 2);
    // The shift brings the crop centre to mid-picture: band middle + shift / scale = centre.
    for (const f of [0, 100, 150, 239]) {
      const mid = framing.band.x + framing.band.w / 2;
      expect(mid - framing.shiftAt(f)[0] / framing.outPerSrc).toBeCloseTo(framing.centreAt(f), 6);
    }
    // Camera acceleration in output pixels stays under the QA bound.
    let peak = 0;
    for (let f = 1; f < clipEnd(clip, 30) - 1; f++)
      peak = Math.max(
        peak,
        Math.abs(framing.shiftAt(f + 1)[0] - 2 * framing.shiftAt(f)[0] + framing.shiftAt(f - 1)[0]),
      );
    expect(peak).toBeGreaterThan(0.5);
    expect(peak).toBeLessThanOrEqual(short.reframe.maxAccelPx);
  });

  it("garde le cadre centré quand le sujet est hors champ ou le rush au bon format", () => {
    const { edl } = plan(3, () => Number.NaN);
    expect(edl.video[0]?.clips[0]?.reframe).toBeUndefined();
  });

  it("le validateur refuse une clé hors du plan ou hors de la source", () => {
    const { edl } = plan(8, (t) => (t < 3 ? 0.3 : 0.7));
    const clip = edl.video[0]?.clips[0];
    if (!clip?.reframe) throw new Error("plan non recadré");
    const broken = structuredClone(edl);
    const keys = broken.video[0]?.clips[0]?.reframe?.keys ?? [];
    keys.push({ frame: 400, value: 1.2, ease: "linear" });
    const codes = validateEdl(broken).map((d) => d.code);
    expect(codes).toContain("reframe.range");
    expect(codes).toContain("motion.linear");
  });
});
