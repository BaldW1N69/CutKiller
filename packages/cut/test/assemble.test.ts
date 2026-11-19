import { parseEdl, validateEdl } from "@cutkiller/core";
import { loadProfile } from "@cutkiller/style";
import { describe, expect, it } from "vitest";
import { assembleEdl } from "../src";

describe("assembleEdl", () => {
  it("lays inputs end to end and puts music under the timeline", async () => {
    const profile = await loadProfile("short");
    const edl = assembleEdl(
      {
        sources: {
          a: { path: "/w/rushes/a.mp4", durationS: 2.5, hasVideo: true, hasAudio: true, fps: 30 },
          s: { path: "/w/rushes/s.png", durationS: 0, hasVideo: true, hasAudio: false, still: true },
          m: { path: "/w/music.wav", durationS: 60, hasVideo: false, hasAudio: true },
        },
      },
      profile,
      { edlDir: "/w/out" },
    );
    expect(validateEdl(edl)).toEqual([]);
    expect(parseEdl(edl).ok).toBe(true);
    expect(edl.video[0]?.clips.map((c) => [c.source, c.at])).toEqual([
      ["a", 0],
      ["s", 75],
    ]);
    expect(edl.sources.a?.path).toBe("../rushes/a.mp4");
    expect(edl.audio[0]?.clips[0]).toMatchObject({ source: "m", in: 0, out: 5.5, at: 0 });
    expect(edl.output).toMatchObject({ width: 1080, height: 1920, fps: 30, video: { bitrateMbps: 20 } });
    expect(edl.output.audio.cutFadeMs).toBe(7.5);
  });
});

describe("cadence de sortie", () => {
  it("suit les rushes en cinematic (23,976 → 24), reste au profil sinon", async () => {
    const { loadProfile } = await import("@cutkiller/style");
    const { outputFps } = await import("../src");
    const analysis = (fps: number) => ({
      sources: {
        a: { path: "a.mp4", durationS: 60, hasVideo: true, hasAudio: true, fps },
        b: {
          path: "b.mp4",
          durationS: 90,
          hasVideo: true,
          hasAudio: true,
          fps: 29.97,
          role: "broll" as const,
        },
      },
    });
    const cine = await loadProfile("cinematic");
    const short = await loadProfile("short");
    expect(outputFps(analysis(23.976), cine)).toBe(24);
    expect(outputFps(analysis(25), cine)).toBe(25);
    expect(outputFps(analysis(23.976), short)).toBe(30);
    // 12 fps is not an allowed rate: the profile's own.
    expect(outputFps(analysis(12), cine)).toBe(30);
  });
});
