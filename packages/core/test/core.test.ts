import { describe, expect, it } from "vitest";
import {
  type EdlInput,
  edlJsonSchema,
  framesToSeconds,
  identityPass,
  isLinearEase,
  mainAudioSpans,
  parseEdl,
  runPasses,
  StyleProfileSchema,
  secondsToFrames,
} from "../src";

const base = (patch: Partial<EdlInput> = {}): EdlInput => ({
  version: "1.0.0",
  output: { format: "short", width: 1080, height: 1920, fps: 30, video: { bitrateMbps: 20 }, audio: {} },
  sources: { a: { path: "a.mp4", durationS: 10 }, b: { path: "b.mp4", durationS: 10 } },
  video: [
    {
      id: "main",
      clips: [
        { id: "c1", source: "a", in: 1, out: 3, at: 0 },
        { id: "c2", source: "b", in: 2, out: 4, at: 60 },
      ],
    },
  ],
  ...patch,
});

/** Mutable access to a clip of the main track of a test EDL. */
function mainClip(edl: EdlInput, i: number): { at: number; audioSplitFrames?: number } {
  const clip = edl.video[0]?.clips[i];
  if (!clip) throw new Error(`clip ${i} absent`);
  return clip;
}

const codes = (input: unknown) => parseEdl(input).diagnostics.map((d) => d.code);

describe("time", () => {
  it("converts frames and seconds without drift", () => {
    expect(secondsToFrames(2, 30)).toBe(60);
    expect(secondsToFrames(1 / 60, 30)).toBe(1); // half a frame rounds up
    expect(framesToSeconds(1, 30)).toBeCloseTo(1 / 30, 12);
    let t = 0;
    for (let i = 0; i < 10_000; i++) t += framesToSeconds(1, 30);
    expect(secondsToFrames(t, 30)).toBe(10_000);
  });
});

describe("ease", () => {
  it("detects linear curves whatever their spelling", () => {
    expect(isLinearEase(undefined)).toBe(true);
    expect(isLinearEase("linear")).toBe(true);
    expect(isLinearEase({ cubicBezier: [0.3, 0.3, 0.7, 0.7] })).toBe(true);
    expect(isLinearEase("ease-out")).toBe(false);
    expect(isLinearEase({ cubicBezier: [0.16, 1, 0.3, 1] })).toBe(false);
    expect(isLinearEase({ spring: { stiffness: 200, damping: 20, mass: 1 } })).toBe(false);
    expect(isLinearEase("hold")).toBe(false);
  });
});

describe("EDL validation", () => {
  it("accepts a valid EDL and applies defaults", () => {
    const r = parseEdl(base());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.edl.video[0]?.clips[0]?.audioSplitFrames).toBe(0);
      expect(r.edl.output.audio.cutFadeMs).toBe(8);
      expect(r.edl.output.video.preset).toBe("medium");
    }
  });

  it("rejects schema errors with a path", () => {
    const r = parseEdl({ ...base(), version: "2.0.0" });
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]?.path).toBe("version");
  });

  it("rejects gaps on the main track (they would render black frames)", () => {
    const edl = base();
    mainClip(edl, 1).at = 65;
    expect(codes(edl)).toContain("track.gap");
  });

  it("rejects overlaps, unknown sources, empty clips and out-of-range points", () => {
    expect(
      codes(
        base({
          video: [
            {
              id: "m",
              clips: [
                { id: "x", source: "a", in: 0, out: 2, at: 0 },
                { id: "y", source: "a", in: 0, out: 2, at: 30 },
              ],
            },
          ],
        }),
      ),
    ).toContain("track.overlap");
    expect(
      codes(base({ video: [{ id: "m", clips: [{ id: "x", source: "zz", in: 0, out: 2, at: 0 }] }] })),
    ).toContain("source.unknown");
    expect(
      codes(base({ video: [{ id: "m", clips: [{ id: "x", source: "a", in: 2, out: 2, at: 0 }] }] })),
    ).toContain("clip.empty");
    expect(
      codes(base({ video: [{ id: "m", clips: [{ id: "x", source: "a", in: 8, out: 11, at: 0 }] }] })),
    ).toContain("source.range");
    expect(
      codes(
        base({
          video: [
            {
              id: "m",
              clips: [
                { id: "x", source: "a", in: 0, out: 1, at: 0 },
                { id: "x", source: "a", in: 1, out: 2, at: 30 },
              ],
            },
          ],
        }),
      ),
    ).toContain("id.duplicate");
  });

  it("forbids linear interpolation on position, scale and opacity", () => {
    const keyframes = [
      {
        target: "c1.scale",
        keys: [
          { frame: 0, value: 1 },
          { frame: 6, value: 1.1 },
        ],
      },
      {
        target: "c1.opacity",
        keys: [
          { frame: 0, value: 0 },
          { frame: 6, value: 1, ease: "linear" as const },
        ],
      },
      {
        target: "c1.x",
        keys: [
          { frame: 0, value: 0 },
          { frame: 6, value: 10, ease: "ease-out" as const },
        ],
      },
    ];
    const diags = parseEdl(base({ keyframes })).diagnostics.filter((d) => d.code === "motion.linear");
    expect(diags.map((d) => d.path)).toEqual(["keyframes.0.keys.1", "keyframes.1.keys.1"]);
  });

  it("requires a contiguous previous clip for a J/L cut and keeps audio inside the source", () => {
    const orphan = base();
    mainClip(orphan, 0).audioSplitFrames = -6;
    expect(codes(orphan)).toContain("split.orphan");
    const outOfSource = base({
      video: [
        {
          id: "m",
          clips: [
            { id: "x", source: "a", in: 0, out: 2, at: 0 },
            { id: "y", source: "b", in: 0, out: 2, at: 60, audioSplitFrames: -6 },
          ],
        },
      ],
    });
    expect(codes(outOfSource)).toContain("source.range");
  });
});

describe("J/L cuts", () => {
  it("moves the audio edit point, not the picture", () => {
    const edl = base();
    mainClip(edl, 1).audioSplitFrames = -6;
    const r = parseEdl(edl);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [a, b] = mainAudioSpans(r.edl);
    expect(a).toMatchObject({ startFrame: 0, endFrame: 54, cutAtStart: false, cutAtEnd: true });
    expect(b).toMatchObject({ startFrame: 54, endFrame: 120, cutAtStart: true, cutAtEnd: false });
    expect(a?.sourceOut).toBeCloseTo(3 - 6 / 30, 6);
    expect(b?.sourceIn).toBeCloseTo(2 - 6 / 30, 6);
  });
});

describe("passes", () => {
  const profile = StyleProfileSchema.parse({
    id: "t",
    version: "1.0.0",
    format: { kind: "short", width: 1080, height: 1920, fps: 30 },
    export: { minBitrateMbps: { "30": 16, "60": 24 } },
    montage: { maxStaticShotS: 4 },
    motion: {},
    captions: {},
    audio: {},
  });

  it("runs passes in the fixed order and rejects a pass that breaks the EDL", () => {
    const r = parseEdl(base());
    if (!r.ok) throw new Error("fixture");
    const order: string[] = [];
    const spy = (id: "audio" | "cut") => ({
      id,
      run: (edl: typeof r.edl) => {
        order.push(id);
        return { edl, diagnostics: [] };
      },
    });
    runPasses(r.edl, [spy("audio"), spy("cut"), identityPass("motion")], {
      analysis: { sources: {} },
      profile,
    });
    expect(order).toEqual(["cut", "audio"]);
    const breaker = {
      id: "cut" as const,
      run: (edl: typeof r.edl) => ({ edl: { ...edl, sources: {} }, diagnostics: [] }),
    };
    expect(() => runPasses(r.edl, [breaker], { analysis: { sources: {} }, profile })).toThrow(/EDL invalide/);
  });

  it("exports a JSON Schema", () => {
    const schema = edlJsonSchema() as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining(["version", "output", "sources", "video"]),
    );
  });
});
