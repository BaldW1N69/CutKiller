import { type Analysis, type EdlInput, parseEdl, type Word } from "@cutkiller/core";
import { loadProfile, PresetRegistry } from "@cutkiller/style";
import { beforeAll, describe, expect, it } from "vitest";
import { audioPass, envelopePeak, SFX_PREROLL_S, SfxParamsSchema, sfxTiming, synthesize } from "../src";

let registry: PresetRegistry;
let short: Awaited<ReturnType<typeof loadProfile>>;
beforeAll(async () => {
  registry = await PresetRegistry.load();
  short = await loadProfile("short");
});

describe("effets sonores procéduraux", () => {
  const rate = 48_000;
  const sfx = () => registry.all().filter((p) => p.kind === "sfx");

  it("chaque preset sonne au même endroit à chaque rendu, impact là où il est annoncé", () => {
    expect(
      sfx()
        .map((p) => p.name)
        .sort(),
    ).toEqual(["glitch-burst", "impact-boom", "punch-tick", "riser", "whoosh", "whoosh-soft"]);
    for (const preset of sfx()) {
      const params = SfxParamsSchema.parse(preset.params);
      const a = synthesize(params, rate);
      const b = synthesize(params, rate);
      expect(a.samples).toEqual(b.samples);
      // Loudest instant (5 ms RMS) within 5 ms of the declared hit.
      const peak = envelopePeak(a.samples, rate);
      expect(Math.abs(peak - a.hitSample) / rate, preset.name).toBeLessThan(0.005);
      // Silent preroll, faded tail, peak at -1 dBFS.
      const pre = Math.round(SFX_PREROLL_S * rate);
      expect(Math.max(...a.samples.subarray(0, pre * 2).map(Math.abs))).toBe(0);
      expect(Math.abs(a.samples.at(-1) as number)).toBeLessThan(1e-6);
      let max = 0;
      for (const v of a.samples) max = Math.max(max, Math.abs(v));
      expect(20 * Math.log10(max)).toBeCloseTo(-1, 3);
      expect(a.samples.length / 2 / rate).toBeCloseTo(sfxTiming(params).lengthS, 3);
    }
  });
});

describe("passe audio", () => {
  const words = (spec: [string, number, number][]): Word[] =>
    spec.map(([text, start, end]) => ({ text, start, end, timing: "forced" }));

  function edlWithSpeech(ws: Word[], extra: Partial<EdlInput> = {}) {
    const edl = parseEdl({
      version: "1.3.0",
      output: { format: "short", width: 1080, height: 1920, fps: 30, video: { bitrateMbps: 20 }, audio: {} },
      sources: { a: { path: "a.mp4", durationS: 20 }, m: { path: "m.wav", durationS: 30, hasAudio: true } },
      video: [
        {
          id: "main",
          clips: [
            {
              id: "A",
              source: "a",
              in: 0,
              out: 10,
              at: 0,
              why: { kind: "speech", wordIds: ws.map((_, i) => i) },
            },
          ],
        },
      ],
      audio: [{ id: "music1", clips: [{ id: "m1", source: "m", in: 0, out: 10, at: 0 }] }],
      ...extra,
    });
    if (!edl.ok) throw new Error(JSON.stringify(edl.diagnostics));
    const analysis: Analysis = {
      sources: {},
      transcripts: { a: { language: "fr", model: "t", durationS: 20, words: ws } },
    };
    return { edl: edl.edl, analysis };
  }

  it("baisse la musique sous la parole et fusionne les pauses courtes", () => {
    // Two phrases 0.3 s apart (merged), then a 3 s pause, then a third phrase.
    const ws = words([
      ["un", 1, 1.4],
      ["deux", 1.7, 2.2],
      ["trois", 5.2, 5.8],
    ]);
    const { edl, analysis } = edlWithSpeech(ws);
    const out = audioPass.run(edl, { analysis, profile: short, presets: registry }).edl;
    const duck = out.audio[0]?.clips[0]?.duck ?? [];
    const hold = Math.round((short.audio.duck.holdMs / 1000) * 30);
    expect(duck.map((d) => [d.fromFrame, d.toFrame])).toEqual([
      [30, 66 + hold],
      [156, 174 + hold],
    ]);
    expect(duck[0]).toMatchObject({ depthDb: -15, attackMs: 100, releaseMs: 300 });
    expect(out.output.audio).toMatchObject({ targetLufs: -14, truePeakDbtp: -1.5, musicBedLu: -5 });
  });

  it("cale l'impact de chaque SFX exactement sur sa transition ou son punch-in", () => {
    const { edl, analysis } = edlWithSpeech([], {
      video: [
        {
          id: "main",
          clips: [
            { id: "A", source: "a", in: 0, out: 3, at: 0 },
            { id: "B", source: "a", in: 4, out: 7, at: 90 },
          ],
        },
      ],
      transitions: [{ id: "t1", atFrame: 90, preset: "whip-pan@1", durationFrames: 9 }],
      keyframes: [
        {
          target: "B.scale",
          role: "micro",
          preset: "zoom-punch@1",
          keys: [
            { frame: 92, value: 1 },
            { frame: 98, value: 1.1, ease: { spring: { stiffness: 1310, damping: 50, mass: 1 } } },
          ],
          why: { kind: "emphasis", wordIds: [0] },
        },
      ],
    });
    const out = audioPass.run(edl, { analysis, profile: short, presets: registry }).edl;
    const fx = out.audio.filter((t) => t.id.startsWith("sfx")).flatMap((t) => t.clips);
    expect(fx.map((c) => [c.asset, c.syncTo])).toEqual([
      ["whoosh@1.0.0", "transition:t1"],
      ["punch-tick@1.0.0", "keyframes:B.scale"],
    ]);
    // The whoosh (0.5 s, ends on frame 97) overlaps the punch 2 frames after the cut: second track.
    expect(out.audio.filter((t) => t.id.startsWith("sfx")).map((t) => t.id)).toEqual(["sfx1", "sfx2"]);
    for (const [c, frame] of [
      [fx[0], 90],
      [fx[1], 92],
    ] as const) {
      const { hitS } = sfxTiming(SfxParamsSchema.parse(registry.resolve(c?.asset as string).params));
      expect((c?.at as number) + (hitS - (c?.in as number)) * 30).toBeCloseTo(frame, 3);
      expect(c?.in).toBeGreaterThanOrEqual(0);
      expect(c?.in).toBeLessThan(SFX_PREROLL_S); // only silence is trimmed
    }
  });

  it("pose un riser puis un impact sur chaque changement de section éditoriale", () => {
    const { edl, analysis } = edlWithSpeech([], {
      video: [
        {
          id: "main",
          clips: [
            { id: "s01-001", source: "a", in: 0, out: 3, at: 0 },
            { id: "s01-002", source: "a", in: 3, out: 5, at: 90 },
            { id: "s02-001", source: "a", in: 12, out: 15, at: 150 },
          ],
        },
      ],
    });
    const out = audioPass.run(edl, { analysis, profile: short, presets: registry }).edl;
    const fx = out.audio.filter((t) => t.id.startsWith("sfx")).flatMap((t) => t.clips);
    expect(fx.map((c) => [c.asset, c.syncTo])).toEqual([
      ["riser@1.0.0", "cut:s02-001"],
      ["impact-boom@1.0.0", "cut:s02-001"],
    ]);
    for (const c of fx) {
      const { hitS } = sfxTiming(SfxParamsSchema.parse(registry.resolve(c.asset as string).params));
      expect(c.at + (hitS - c.in) * 30).toBeCloseTo(150, 3);
    }
  });

  it("refuse un clip audio sans source ni asset", () => {
    const { edl } = edlWithSpeech([]);
    const r = parseEdl({ ...edl, audio: [{ id: "x", clips: [{ id: "x1", in: 0, out: 1, at: 0 }] }] });
    expect(r.ok).toBe(false);
    expect(r.diagnostics.map((d) => d.code)).toContain("audio.source");
  });
});
