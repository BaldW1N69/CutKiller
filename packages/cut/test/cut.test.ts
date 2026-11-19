import { type Analysis, EdlSchema, parseEdl, type Word } from "@cutkiller/core";
import { loadProfile } from "@cutkiller/style";
import { beforeAll, describe, expect, it } from "vitest";
import {
  buildRuns,
  classifyWords,
  cutPass,
  planClips,
  resolveOverlaps,
  snapJumpCuts,
  type Token,
} from "../src";

let profile: Awaited<ReturnType<typeof loadProfile>>;
beforeAll(async () => {
  profile = await loadProfile("long");
});

/** Words from "text@start-end" specs, all force-aligned. */
const W = (...specs: string[]): Word[] =>
  specs.map((s) => {
    const [text, times] = s.split("@") as [string, string];
    const [a, b] = times.split("-").map(Number) as [number, number];
    return { text, start: a, end: b, timing: "forced" };
  });

const removed = (tokens: Token[]) =>
  tokens.filter((t) => t.removed).map((t) => `${t.word.text}:${t.removed}`);

describe("classifyWords", () => {
  it("always removes hesitations", () => {
    const t = classifyWords(W("je@0-0.2", "euh@0.3-0.5", "pense@0.6-0.9", "Hum,@1-1.2"), profile);
    expect(removed(t)).toEqual(["euh:filler", "Hum,:filler"]);
  });

  it("removes « donc » only when pauses isolate it", () => {
    const isolated = classifyWords(W("parti.@0-0.5", "donc@1.0-1.2", "ensuite@1.6-2"), profile);
    expect(removed(isolated)).toEqual(["donc:contextual-filler"]);
    const meaningful = classifyWords(
      W("il@0-0.2", "pleut@0.25-0.5", "donc@0.55-0.7", "je@0.75-0.8", "reste@0.85-1.2"),
      profile,
    );
    expect(removed(meaningful)).toEqual([]);
  });

  it("handles multi-word contextual fillers", () => {
    const t = classifyWords(
      W("bon.@0-0.3", "en@0.8-0.9", "fait@0.92-1.1", "euh@1.2-1.4", "oui@1.8-2"),
      profile,
    );
    expect(removed(t)).toEqual([
      "bon.:contextual-filler",
      "en:contextual-filler",
      "fait:contextual-filler",
      "euh:filler",
    ]);
  });

  it("cuts the first take of a false start, keeps emphasis", () => {
    const falseStart = classifyWords(
      W(
        "il@0-0.1",
        "n'y@0.12-0.3",
        "a@0.32-0.4",
        "plus@0.42-0.6",
        "il@1.2-1.3",
        "n'y@1.32-1.5",
        "a@1.52-1.6",
        "plus@1.62-1.8",
        "rien@1.85-2.1",
      ),
      profile,
    );
    expect(removed(falseStart)).toEqual(["il:repeat", "n'y:repeat", "a:repeat", "plus:repeat"]);
    const stutter = classifyWords(W("la…@0-0.2", "la@0.5-0.6", "particularité@0.65-1.3"), profile);
    expect(removed(stutter)).toEqual(["la…:repeat"]);
    const emphasis = classifyWords(W("très@0-0.2", "très@0.25-0.45", "bien@0.5-0.8"), profile);
    expect(removed(emphasis)).toEqual([]);
  });
});

describe("runs and margins", () => {
  it("keeps natural pauses, cuts long silences with 80–120 ms margins", () => {
    const tokens = classifyWords(W("a@1-1.5", "b@1.8-2.2", "c@3.5-4", "d@4.05-4.4"), profile);
    const runs = buildRuns(tokens, 10, profile);
    expect(runs.map((r) => r.words.map((t) => t.word.text).join(""))).toEqual(["ab", "cd"]);
    expect(runs[0]?.head).toBeCloseTo(0.1, 6);
    expect(runs[0]?.tail).toBeCloseTo(0.1, 6);
    expect(runs[1]?.silenceBeforeS).toBeCloseTo(1.3, 6);
  });

  it("never lets a margin bleed into removed speech", () => {
    const tokens = classifyWords(W("avant@0-0.5", "euh@0.55-0.8", "après@0.84-1.2"), profile);
    const runs = buildRuns(tokens, 5, profile);
    expect(runs).toHaveLength(2);
    expect(runs[0]!.tail).toBeCloseTo(0.04, 6); // 50 ms to « euh » minus 10 ms guard
    expect(runs[1]!.head).toBeCloseTo(0.03, 6);
  });

  it("moves margins to land a jump cut on a reachable beat", () => {
    const tokens = classifyWords(W("a@1-2", "b@3-4"), profile);
    const runs = buildRuns(tokens, 10, profile);
    // Default first clip: 0.9 → 2.1 = 36 frames. A beat at frame 37.5 is reachable (+40 ms max).
    snapJumpCuts(runs, 30, 0, [37.5]);
    const frames = Math.round(
      (runs[0]!.words[0]!.word.start - runs[0]!.head) * -30 + (2 + runs[0]!.tail) * 30,
    );
    expect(frames).toBe(37);
    expect(runs[0]!.head).toBeLessThanOrEqual(0.12 + 1e-9);
    expect(runs[0]!.tail).toBeLessThanOrEqual(0.12 + 1e-9);
  });
});

describe("planClips", () => {
  it("splits long runs with zoom cuts, on beats when there is music, alternating framing", () => {
    const words = Array.from(
      { length: 40 },
      (_, i) => `w${i}@${(i * 0.5).toFixed(2)}-${(i * 0.5 + 0.4).toFixed(2)}`,
    );
    const tokens = classifyWords(W(...words), profile);
    const beats = Array.from({ length: 30 }, (_, i) => 20 + i * 19.5);
    const { clips } = planClips({
      tokens,
      durationS: 30,
      profile,
      fps: 30,
      startFrame: 0,
      beatFrames: beats,
      framingIndex: 0,
    });
    expect(clips.length).toBeGreaterThan(2);
    let at = 0;
    for (const [k, c] of clips.entries()) {
      expect(c.frames).toBeLessThanOrEqual(8 * 30);
      if (k > 0) expect(Math.min(...beats.map((b) => Math.abs(b - at)))).toBeLessThanOrEqual(0.5);
      at += c.frames;
    }
    // Contiguous source times: the audio plays through the zoom cuts.
    for (let k = 1; k < clips.length; k++) expect(clips[k]!.in).toBeCloseTo(clips[k - 1]!.out, 9);
    expect(clips.map((c) => c.scale)).toEqual(clips.map((_, k) => (k % 2 === 0 ? 1 : c(k))));
    function c(k: number) {
      return profile.montage.zoomCutLevels[Math.floor(k / 2) % profile.montage.zoomCutLevels.length];
    }
  });

  it("never reaches past the end of the rush once rounded to whole frames", () => {
    // Last word ends 50 ms before the end: 5.625 s of material (margin cut short)
    // would round up to 169 frames (5.633 s), 8 ms past the source.
    const tokens = classifyWords(W("fin@174.5-179.975"), profile);
    const { clips } = planClips({
      tokens,
      durationS: 180.025,
      profile,
      fps: 30,
      startFrame: 0,
      beatFrames: [],
      framingIndex: 0,
    });
    const last = clips.at(-1)!;
    const frames = clips.reduce((n, k) => n + k.frames, 0);
    expect(clips[0]!.in + frames / 30).toBeLessThanOrEqual(180.025);
    expect(Math.round((last.out - last.in) * 30)).toBe(last.frames);
  });
});

describe("cutPass", () => {
  it("replaces a transcribed rush by its useful parts and documents why", () => {
    const words = W(
      "Bonjour@1-1.5",
      "euh@1.8-2.1",
      "je@2.4-2.6",
      "commence@2.65-3.2",
      "maintenant.@3.25-3.9",
      "Merci@6-6.4",
    );
    const analysis: Analysis = {
      sources: { r: { path: "/r.mp4", durationS: 8, hasVideo: true, hasAudio: true, fps: 30 } },
      transcripts: { r: { language: "fr", model: "t", durationS: 8, words } },
      vad: { r: { durationS: 8, speech: [{ start: 0.95, end: 6.5 }], noiseFloorDb: -60, peakDb: -10 } },
    };
    const edl = EdlSchema.parse({
      version: "1.0.0",
      output: { format: "long", width: 1920, height: 1080, fps: 30, video: { bitrateMbps: 20 }, audio: {} },
      sources: { r: { path: "r.mp4", durationS: 8 } },
      video: [{ id: "main", clips: [{ id: "c001", source: "r", in: 0, out: 8, at: 0 }] }],
    });
    const { edl: out, diagnostics } = cutPass.run(edl, { analysis, profile });
    expect(parseEdl(out).ok).toBe(true);
    const clips = out.video[0]!.clips;
    expect(clips.map((c) => c.why?.wordIds)).toEqual([[0], [2, 3, 4], [5]]);
    expect(clips[1]!.why?.note).toContain("euh");
    expect(clips[2]!.why?.note).toContain("silence de 2100 ms");
    expect(clips.map((c) => c.transform.scale)).toEqual([1, 1.08, 1]);
    expect(diagnostics.find((d) => d.code === "cut.summary")?.message).toContain("1 hésitation");
  });

  it("ignores words the VAD never heard (ASR hallucinations)", () => {
    const words = W("Bonjour@1-1.5", "Sous-titres@5-5.5", "Amara.org@5.6-6");
    const analysis: Analysis = {
      sources: { r: { path: "/r.mp4", durationS: 8, hasVideo: true, hasAudio: true } },
      transcripts: { r: { language: "fr", model: "t", durationS: 8, words } },
      vad: { r: { durationS: 8, speech: [{ start: 0.95, end: 1.6 }], noiseFloorDb: -60, peakDb: -10 } },
    };
    const edl = EdlSchema.parse({
      version: "1.0.0",
      output: { format: "long", width: 1920, height: 1080, fps: 30, video: { bitrateMbps: 20 }, audio: {} },
      sources: { r: { path: "r.mp4", durationS: 8 } },
      video: [{ id: "main", clips: [{ id: "c001", source: "r", in: 0, out: 8, at: 0 }] }],
    });
    const { edl: out, diagnostics } = cutPass.run(edl, { analysis, profile });
    expect(out.video[0]!.clips).toHaveLength(1);
    expect(diagnostics.some((d) => d.code === "cut.hallucination")).toBe(true);
  });
});

describe("resolveOverlaps", () => {
  it("pushes removed material off kept words, drops it when swallowed", () => {
    const tokens = classifyWords(W("avec@0-0.5", "euh@0.45-0.8", "une@0.75-1.0", "idée@1.05-1.4"), profile);
    const out = resolveOverlaps(tokens);
    const euh = out.find((t) => t.word.text === "euh")!;
    expect(euh.word.start).toBeCloseTo(0.512, 6);
    expect(euh.word.end).toBeCloseTo(0.738, 6);
    for (let k = 1; k < out.length; k++) expect(out[k]!.word.start).toBeGreaterThan(out[k - 1]!.word.end);
    const swallowed = resolveOverlaps(classifyWords(W("depuis@0-0.6", "euh@0.3-0.59"), profile));
    expect(swallowed.map((t) => t.word.text)).toEqual(["depuis"]);
  });
});
