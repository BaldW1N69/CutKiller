import { type Analysis, type EdlInput, parseEdl, type Word } from "@cutkiller/core";
import { loadProfile, PresetRegistry } from "@cutkiller/style";
import { beforeAll, describe, expect, it } from "vitest";
import { applyGlitch, emphasisScores, MotionTimeline, motionPass, resolveTransitions } from "../src";

let registry: PresetRegistry;
let profile: Awaited<ReturnType<typeof loadProfile>>;
beforeAll(async () => {
  registry = await PresetRegistry.load();
  profile = await loadProfile("short");
});

const base = (transitions: EdlInput["transitions"] = []): EdlInput => ({
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
  transitions,
});

const edlOf = (input: EdlInput) => {
  const r = parseEdl(input);
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
  return r.edl;
};

describe("MotionTimeline", () => {
  it("whip-pan : les deux plans bougent ensemble, image figée de l'autre côté de la coupe", () => {
    const edl = edlOf(base([{ id: "t", atFrame: 60, preset: "whip-pan@1", durationFrames: 9 }]));
    const tl = new MotionTimeline(edl, resolveTransitions(edl, registry));
    expect(tl.transitions[0]?.window).toEqual([56, 65]);
    const before = tl.layersAt(58);
    expect(before.map((l) => [l.clip.id, l.image])).toEqual([
      ["A", "live"],
      ["B", "first"],
    ]);
    const after = tl.layersAt(62);
    expect(after.map((l) => [l.clip.id, l.image])).toEqual([
      ["A", "last"],
      ["B", "live"],
    ]);
    // Continuity: the incoming picture always sits exactly one frame width right of the outgoing one.
    for (const t of [56, 58.3, 60, 63.7]) {
      const [a, b] = tl.layersAt(Math.floor(t)).map((l) => l.state(t));
      expect((b?.x ?? 0) - (a?.x ?? 0)).toBeCloseTo(1, 9);
    }
    expect(tl.velocityAt(60)).toBeGreaterThan(100);
    expect(tl.velocityAt(30)).toBe(0);
    expect(tl.layersAt(30).map((l) => l.clip.id)).toEqual(["A"]);
  });

  it("smooth-slide : le plan entrant glisse par-dessus le sortant figé, à partir de la coupe", () => {
    const edl = edlOf(base([{ id: "t", atFrame: 60, preset: "smooth-slide@1", durationFrames: 12 }]));
    const tl = new MotionTimeline(edl, resolveTransitions(edl, registry));
    expect(tl.layersAt(59).map((l) => l.clip.id)).toEqual(["A"]);
    const layers = tl.layersAt(60);
    expect(layers.map((l) => [l.clip.id, l.image])).toEqual([
      ["A", "last"],
      ["B", "live"],
    ]);
    expect(layers[1]?.state(60).x).toBeCloseTo(1, 6);
    expect(layers[1]?.state(72).x).toBeCloseTo(0, 6);
  });

  it("glitch-cut : intensité maximale sur la coupe, déterministe", () => {
    const edl = edlOf(base([{ id: "t", atFrame: 60, preset: "glitch-cut@1", durationFrames: 6 }]));
    const tl = new MotionTimeline(edl, resolveTransitions(edl, registry));
    expect(tl.glitchAt(50)).toBeUndefined();
    const peak = tl.glitchAt(59)?.intensity ?? 0;
    expect(peak).toBeGreaterThan(tl.glitchAt(57)?.intensity ?? 1);
    const frame = () => Buffer.from(Array.from({ length: 64 * 32 * 4 }, (_, i) => (i * 37) % 251));
    const a = frame();
    const b = frame();
    applyGlitch(a, 64, 32, 1, 42);
    applyGlitch(b, 64, 32, 1, 42);
    expect(a.equals(b)).toBe(true);
    expect(a.equals(frame())).toBe(false);
  });
});

describe("motionPass", () => {
  const w = (text: string, start: number): Word => ({ text, start, end: start + 0.3, timing: "forced" });

  it("place un punch-in sur le mot le plus marqué, à un niveau différent du punch précédent", () => {
    const words = [
      "Alors",
      "ce",
      "métier",
      "est",
      "vraiment",
      "unique",
      "et",
      "on",
      "le",
      "fait",
      "bien",
    ].map((t, i) => w(t, 0.2 + i * 0.4));
    const flat = { rmsDb: -20, pitchSt: 5 };
    const analysis: Analysis = {
      sources: {},
      transcripts: { a: { language: "fr", model: "t", durationS: 10, words } },
      prosody: {
        a: { words: words.map((x) => (x.text === "vraiment" ? { rmsDb: -12, pitchSt: 9 } : flat)) },
      },
    };
    const edl = edlOf({
      ...base(),
      video: [
        {
          id: "main",
          clips: [
            {
              id: "A",
              source: "a",
              in: 0,
              out: 5,
              at: 0,
              why: { kind: "speech", wordIds: words.map((_, i) => i) },
            },
            { id: "B", source: "b", in: 0, out: 2, at: 150, transform: { scale: 1.06 } },
          ],
        },
      ],
    });
    const scores = emphasisScores(analysis.transcripts!.a!, analysis.prosody!.a, profile);
    expect(scores.indexOf(Math.max(...scores))).toBe(4);
    const { edl: out } = motionPass.run(edl, { analysis, profile, presets: registry });
    expect(out.keyframes).toHaveLength(1);
    const track = out.keyframes[0]!;
    expect(track).toMatchObject({
      target: "A.scale",
      role: "micro",
      why: { kind: "emphasis", wordIds: [4] },
    });
    // « vraiment » starts at 1.8 s = frame 54; the punch starts 2 frames earlier and lasts 200 ms.
    expect(track.keys.map((k) => k.frame)).toEqual([52, 58]);
    // 1.06 is the next static punch: the animated one must use another level.
    expect(track.keys[1]?.value).toBe(1.1);
  });

  it("pose une transition à une rupture (changement de source), espacée, preset du profil", () => {
    const edl = edlOf(base());
    const { edl: out } = motionPass.run(edl, { analysis: { sources: {} }, profile, presets: registry });
    expect(out.transitions).toMatchObject([{ atFrame: 60, preset: "whip-pan@1.0.0", durationFrames: 9 }]);
    expect(parseEdl(out).ok).toBe(true);
  });

  it("format long : whip-pan dans une même caméra, slide seulement au changement de source", async () => {
    const long = await loadProfile("long");
    const edl = edlOf({
      ...base(),
      video: [
        {
          id: "main",
          clips: [
            { id: "A", source: "a", in: 0, out: 2, at: 0 },
            { id: "A2", source: "a", in: 4, out: 6, at: 60 },
            { id: "B", source: "b", in: 0, out: 10, at: 120 },
            { id: "C", source: "a", in: 7, out: 9, at: 420 },
          ],
        },
      ],
    });
    const { edl: out } = motionPass.run(edl, { analysis: { sources: {} }, profile: long, presets: registry });
    // Frame 60: same camera, 2 s removed → whip pan. Frame 120: too close (12 s spacing). Frame 420: new source → slide.
    expect(out.transitions.map((t) => [t.atFrame, t.preset])).toEqual([
      [60, "whip-pan@1.0.0"],
      [420, "smooth-slide@1.0.0"],
    ]);
  });
});
