import { type EdlInput, parseEdl, validateEdl } from "@cutkiller/core";
import { RULES } from "@cutkiller/qa";
import { describe, expect, it } from "vitest";
import { setOut, VARIANTS } from "../src/calibrate";

describe("banc de calibration", () => {
  it("vise chacune des 33 règles par au moins un défaut, avec un témoin propre", () => {
    const targeted = new Set(VARIANTS.filter((v) => v.expect !== "pass").map((v) => v.rule));
    for (const rule of RULES) expect(targeted.has(rule.id), rule.id).toBe(true);
    expect(VARIANTS.filter((v) => v.rule === "control")).toHaveLength(1);
    expect(new Set(VARIANTS.map((v) => v.id)).size).toBe(VARIANTS.length);
  });

  it("rallonge un plan en décalant toute la suite de la timeline", () => {
    const input: EdlInput = {
      version: "1.4.0",
      output: { format: "short", width: 1080, height: 1920, fps: 30, video: { bitrateMbps: 20 }, audio: {} },
      sources: { a: { path: "a.mp4", durationS: 20 }, m: { path: "m.wav", durationS: 20 } },
      video: [
        {
          id: "main",
          clips: [
            { id: "c1", source: "a", in: 0, out: 2, at: 0 },
            {
              id: "c2",
              source: "a",
              in: 3,
              out: 5,
              at: 60,
              reframe: { axis: "x", keys: [{ frame: 60, value: 0.5 }] },
            },
          ],
        },
      ],
      audio: [
        {
          id: "music",
          clips: [
            {
              id: "m1",
              source: "m",
              in: 0,
              out: 4,
              at: 0,
              duck: [{ fromFrame: 10, toFrame: 70, depthDb: -15, attackMs: 100, releaseMs: 300 }],
            },
          ],
        },
      ],
      keyframes: [
        {
          target: "c2.scale",
          role: "micro",
          keys: [
            { frame: 70, value: 1 },
            { frame: 76, value: 1.1, ease: "ease-out-cubic" },
          ],
        },
      ],
      transitions: [{ id: "t1", atFrame: 60, preset: "whip-pan@1", durationFrames: 9 }],
      captions: [
        {
          id: "k1",
          style: "karaoke-pop@1",
          fromFrame: 50,
          toFrame: 80,
          words: [
            { text: "un", fromFrame: 50, toFrame: 62, line: 0 },
            { text: "deux", fromFrame: 62, toFrame: 80, line: 0 },
          ],
        },
      ],
    };
    input.audio?.push({
      id: "sfx",
      clips: [{ id: "fx", asset: "whoosh@1", in: 0, out: 0.5, at: 52, syncTo: "transition:t1" }],
    });
    const r = parseEdl(input);
    if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
    const edl = r.edl;
    setOut(edl, edl.video[0]?.clips[0] as never, 2.5);
    const c2 = edl.video[0]?.clips[1];
    expect(c2?.at).toBe(75);
    expect(c2?.reframe?.keys[0]?.frame).toBe(75);
    expect(edl.transitions[0]?.atFrame).toBe(75);
    expect(edl.keyframes[0]?.keys.map((k) => k.frame)).toEqual([85, 91]);
    expect(edl.audio[0]?.clips[0]?.duck[0]).toMatchObject({ fromFrame: 10, toFrame: 85 });
    // The whoosh starts before the cut but follows its transition.
    expect(edl.audio[1]?.clips[0]?.at).toBe(67);
    // A caption straddling the old cut keeps its start and stretches; its later word moves.
    expect(edl.captions[0]).toMatchObject({ fromFrame: 50, toFrame: 95 });
    expect(edl.captions[0]?.words.map((w) => w.fromFrame)).toEqual([50, 77]);
    expect(validateEdl(edl).filter((d) => d.level === "error")).toEqual([]);
  });
});
