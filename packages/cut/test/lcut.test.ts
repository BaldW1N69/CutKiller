import { mainAudioSpans, parseEdl } from "@cutkiller/core";
import { loadProfile } from "@cutkiller/style";
import { describe, expect, it } from "vitest";
import { sourceChangeLCuts } from "../src";

const word = (text: string, start: number, end: number) => ({ text, start, end, timing: "forced" as const });

async function setup(bWords: ReturnType<typeof word>[]) {
  const profile = await loadProfile("long");
  const r = parseEdl({
    version: "1.4.0",
    output: { format: "long", width: 1920, height: 1080, fps: 30, video: { bitrateMbps: 12 }, audio: {} },
    sources: { a: { path: "a.mp4", durationS: 20 }, b: { path: "b.mp4", durationS: 20 } },
    video: [{ id: "main", clips: [] }],
  });
  if (!r.ok) throw new Error("bad EDL");
  const clips = [
    { id: "a1", source: "a", in: 1, out: 4, at: 0 },
    { id: "b1", source: "b", in: 2, out: 5, at: 90 },
  ];
  const ctx = { profile, analysis: { transcripts: { b: { language: "fr", words: bWords } } } } as never;
  return { edl: r.edl, clips, ctx };
}

describe("L-cuts at changes of rush", () => {
  it("brings the next rush's picture in 6 frames early, sound untouched", async () => {
    const { edl, clips, ctx } = await setup([word("bonjour", 2.1, 2.5)]);
    const original = parseEdl({ ...edl, video: [{ id: "main", clips: structuredClone(clips) }] });
    if (!original.ok) throw new Error("bad EDL");
    const before = mainAudioSpans(original.edl);
    expect(sourceChangeLCuts(clips, edl, ctx, 30, false)).toBe(1);
    expect(clips[1]).toMatchObject({ at: 84, in: 1.8, audioSplitFrames: 6 });
    expect(clips[0]?.out).toBe(3.8);
    const parsed = parseEdl({ ...edl, video: [{ id: "main", clips }] });
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
    const after = mainAudioSpans(parsed.edl);
    for (const [i, s] of after.entries()) {
      expect(s.startFrame).toBe(before[i]?.startFrame);
      expect(s.endFrame).toBe(before[i]?.endFrame);
      expect(s.sourceIn).toBeCloseTo(before[i]?.sourceIn as number, 6);
    }
  });

  it("does not show lips moving without sound: speech in the frames shown early → shorter or none", async () => {
    // A word ends at 1.85 s: only 4 frames (1.867 s → 2 s) are free of speech.
    const { edl, clips, ctx } = await setup([word("euh", 1.6, 1.85), word("bonjour", 2.1, 2.5)]);
    expect(sourceChangeLCuts(clips, edl, ctx, 30, false)).toBe(1);
    expect(clips[1]?.audioSplitFrames).toBe(4);
    const tight = await setup([word("euh", 1.7, 1.95)]);
    expect(sourceChangeLCuts(tight.clips, tight.edl, tight.ctx, 30, false)).toBe(0);
  });

  it("never on a jump cut, nor on an edit cut to music", async () => {
    const { edl, clips, ctx } = await setup([]);
    expect(sourceChangeLCuts(clips, edl, ctx, 30, true)).toBe(0);
    const same = [clips[0], { ...clips[1], source: "a" }] as typeof clips;
    expect(sourceChangeLCuts(same, edl, ctx, 30, false)).toBe(0);
  });
});
