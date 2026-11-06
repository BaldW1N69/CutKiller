import {
  type Analysis,
  clipEnd,
  type EdlInput,
  parseEdl,
  type StyleProfile,
  sortedClips,
  validateEdl,
} from "@cutkiller/core";
import { loadProfile } from "@cutkiller/style";
import { beforeAll, describe, expect, it } from "vitest";
import { brollPass, isBroll } from "../src";

let cine: StyleProfile;
let long: StyleProfile;
beforeAll(async () => {
  cine = await loadProfile("cinematic");
  long = await loadProfile("long");
});

/** Music beats every 0.5 s (120 BPM) over 60 s. */
const beats = Array.from({ length: 120 }, (_, i) => 0.25 + i * 0.5);

/**
 * Speech: 6 takes of 5 s from rush `a`, each a jump cut after 1 s removed; B-roll
 * rushes `b` and `c` (20 s each) assembled after them; music under everything.
 */
function edit(withSpeech = true) {
  const takes = withSpeech
    ? Array.from({ length: 6 }, (_, k) => ({
        id: `a${k}`,
        source: "a",
        in: k * 6,
        out: k * 6 + 5,
        at: k * 150,
        why: { kind: "speech", wordIds: [k] },
      }))
    : [];
  const start = takes.length * 150;
  const input: EdlInput = {
    version: "1.5.0",
    output: { format: "long", width: 1920, height: 1080, fps: 30, video: { bitrateMbps: 20 }, audio: {} },
    sources: {
      a: { path: "a.mp4", durationS: 40, width: 1920, height: 1080 },
      b: { path: "b.mp4", durationS: 20, width: 1920, height: 1080, role: "broll" },
      c: { path: "c.mp4", durationS: 20, width: 1920, height: 1080 },
      m: { path: "m.wav", durationS: 60, hasAudio: true },
    },
    video: [
      {
        id: "main",
        clips: [
          ...takes,
          { id: "b", source: "b", in: 0, out: 20, at: start },
          { id: "c", source: "c", in: 0, out: 20, at: start + 600 },
        ],
      },
    ],
    audio: [{ id: "music", clips: [{ id: "m1", source: "m", in: 0, out: 60, at: 0, fadeOutMs: 1000 }] }],
  };
  const r = parseEdl(input);
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
  const analysis: Analysis = {
    sources: {
      a: { path: "a.mp4", durationS: 40, hasVideo: true, hasAudio: true },
      b: { path: "b.mp4", durationS: 20, hasVideo: true, hasAudio: true, role: "broll" },
      c: { path: "c.mp4", durationS: 20, hasVideo: true, hasAudio: true },
      m: { path: "m.wav", durationS: 60, hasVideo: false, hasAudio: true },
    },
    transcripts: {
      a: {
        language: "fr",
        model: "t",
        durationS: 40,
        words: [{ text: "bonjour", start: 0, end: 0.5, timing: "forced" }],
      },
      c: { language: "fr", model: "t", durationS: 20, words: [] },
    },
    beats: { m: { tempoBpm: 120, beats, durationS: 60 } },
  };
  return { edl: r.edl, analysis };
}

describe("B-roll", () => {
  it("reconnaît le B-roll : marqué, ou vidéo sans parole une fois la parole analysée", () => {
    const { edl, analysis } = edit();
    expect(isBroll(edl, analysis, "a")).toBe(false);
    expect(isBroll(edl, analysis, "b")).toBe(true);
    expect(isBroll(edl, analysis, "c")).toBe(true);
    // Without speech analysis (--fast), only marked sources are B-roll.
    expect(isBroll(edl, { ...analysis, transcripts: undefined }, "c")).toBe(false);
  });

  it("plans de coupe : sur les jump cuts, calés sur les beats, espacés, la parole reste sur la piste principale", () => {
    const { edl, analysis } = edit();
    const { edl: out, diagnostics } = brollPass.run(edl, { analysis, profile: cine });
    const main = sortedClips(out.video[0]?.clips ?? []);
    expect(main.map((c) => c.source)).toEqual(["a", "a", "a", "a", "a", "a"]);
    expect(clipEnd(main.at(-1) as never, 30)).toBe(900);
    const overlay = out.video[1];
    expect(overlay?.id).toBe("broll");
    const cuts = overlay?.clips ?? [];
    expect(cuts.length).toBeGreaterThanOrEqual(2);
    const beatFrames = beats.map((b) => Math.round(b * 30));
    let covered = 0;
    let last = Number.NEGATIVE_INFINITY;
    for (const c of cuts) {
      const len = Math.round((c.out - c.in) * 30);
      covered += len;
      expect(len).toBeGreaterThanOrEqual(60);
      expect(len).toBeLessThanOrEqual(120);
      expect(c.at).toBeGreaterThanOrEqual(90); // speaker first (3 s)
      expect(c.at + len).toBeLessThanOrEqual(900 - 60);
      expect(c.at - last).toBeGreaterThanOrEqual(180); // 6 s on the speaker between two
      last = c.at + len;
      // Each one covers a jump cut and starts and ends on a beat.
      expect(main.some((m) => m.at > c.at && m.at < c.at + len)).toBe(true);
      expect(beatFrames).toContain(c.at);
      expect(beatFrames).toContain(c.at + len);
      expect(["b", "c"]).toContain(c.source);
    }
    expect(covered / 900).toBeLessThanOrEqual(0.4);
    // Never the same B-roll twice.
    const used = cuts.map((c) => `${c.source}:${c.in}`);
    expect(new Set(used).size).toBe(used.length);
    expect(diagnostics[0]?.message).toMatch(/plan\(s\) de coupe .* jump cut\(s\) masqué\(s\)/);
  });

  it("sans parole : montage d'un plan tous les 4 temps, aussi long que la musique", () => {
    const { edl, analysis } = edit(false);
    // The music clip is « m001 », as assembled: the shots never reuse an id.
    edl.audio[0]?.clips.forEach((c) => {
      c.id = "m001";
    });
    const { edl: out } = brollPass.run(edl, { analysis, profile: cine });
    expect(validateEdl(out).filter((d) => d.level === "error")).toEqual([]);
    const main = sortedClips(out.video[0]?.clips ?? []);
    expect(out.video).toHaveLength(1);
    // 4 beats at 120 BPM = 2 s = 60 frames, on the bar lines (beat 0, 4, 8…).
    for (const c of main.slice(1, -1)) expect((c.at - Math.round((beats[0] as number) * 30)) % 60).toBe(0);
    expect(main.every((c) => c.gainDb === -20)).toBe(true);
    // 40 s of material minus the heads skipped, under 60 s of music.
    expect(clipEnd(main.at(-1) as never, 30) / 30).toBeGreaterThan(35);
    expect(out.audio[0]?.clips[0]?.out).toBeCloseTo(clipEnd(main.at(-1) as never, 30) / 30, 6);
  });

  it("ne touche à rien hors des profils cinématiques", () => {
    const { edl, analysis } = edit();
    expect(brollPass.run(edl, { analysis, profile: long }).edl).toBe(edl);
  });
});

describe("rush sans parole de durée non alignée sur les frames", () => {
  it("ne lit jamais au-delà de la fin du rush (20,02 s à 30 fps → 600 frames)", async () => {
    const { cutPass } = await import("../src");
    const { EdlSchema, validateEdl } = await import("@cutkiller/core");
    // The raw assembly (out point = the rush's own duration, not on a frame), as the cut pass gets it.
    const r = EdlSchema.safeParse({
      version: "1.5.0",
      output: { format: "short", width: 1080, height: 1920, fps: 30, video: { bitrateMbps: 20 }, audio: {} },
      sources: { b: { path: "b.mp4", durationS: 20.02, hasAudio: true } },
      video: [{ id: "main", clips: [{ id: "b", source: "b", in: 0, out: 20.02, at: 0 }] }],
    });
    if (!r.success) throw new Error(r.error.message);
    const profile = await loadProfile("cinematic-short");
    const { edl } = cutPass.run(r.data, { analysis: { sources: {} }, profile });
    expect(validateEdl(edl).filter((d) => d.level === "error")).toEqual([]);
    const clips = sortedClips(edl.video[0]?.clips ?? []);
    expect(clipEnd(clips.at(-1) as never, 30)).toBe(600);
  });
});
