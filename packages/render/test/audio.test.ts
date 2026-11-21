import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEdl } from "@cutkiller/core";
import { generateFixtures } from "@cutkiller/fixtures";
import { measureLoudness, readWavF32 } from "@cutkiller/media";
import { PresetRegistry } from "@cutkiller/style";
import { describe, expect, it } from "vitest";
import { audioMixArgs, duckEnvelope } from "../src";
import { renderAudio } from "../src/audio";

const rms = (s: Float32Array, a: number, b: number) => {
  let acc = 0;
  for (let i = a * 2; i < b * 2; i++) acc += (s[i] as number) ** 2;
  return 10 * Math.log10(acc / ((b - a) * 2) + 1e-20);
};

describe("mix audio", () => {
  it("fondu de fin posé avant la fin réelle de l'audio quand le flux audio est plus court que la vidéo", () => {
    const parsed = parseEdl({
      version: "1.5.0",
      output: { format: "long", width: 640, height: 360, fps: 30, video: { bitrateMbps: 8 }, audio: {} },
      sources: { a: { path: "/r/a.mp4", durationS: 60.008 } },
      video: [{ id: "main", clips: [{ id: "c1", source: "a", in: 58, out: 60.008, at: 0 }] }],
    });
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
    const conformed = new Map([["/r/a.mp4", "/w/a.wav"]]);
    const fade = (durations?: Map<string, number>) =>
      audioMixArgs(parsed.edl, "/", "/w/out.wav", "voice", conformed, new Map(), durations)
        .join(" ")
        .match(/atrim=start=0:duration=([\d.]+).*afade=t=out:st=([\d.]+)/)
        ?.slice(1)
        .map(Number);
    // Unknown duration: trimmed to the clip, fade before its out point (the end
    // of the timeline too: the speech stops mid-word there).
    // The clip lasts 60 frames (2 s); default cut fade 8 ms.
    expect(fade()).toEqual([2, 1.992]);
    // Audio stream ending 10 ms before the clip's out point: piece and fade end with it.
    const [len, st] = fade(new Map([["/w/a.wav", 59.99]])) ?? [];
    expect(len).toBeCloseTo(1.99, 6);
    expect(st).toBeCloseTo(1.982, 6);
  });

  it("enveloppe de ducking : rampes en cosinus, palier à la profondeur, rien hors des zones", () => {
    const edl = parseEdl({
      version: "1.3.0",
      output: { format: "long", width: 1920, height: 1080, fps: 30, video: { bitrateMbps: 20 }, audio: {} },
      sources: { a: { path: "a.mp4", durationS: 10 }, m: { path: "m.wav", durationS: 10 } },
      video: [{ id: "main", clips: [{ id: "A", source: "a", in: 0, out: 4, at: 0 }] }],
      audio: [
        {
          id: "music1",
          clips: [
            {
              id: "m1",
              source: "m",
              in: 0,
              out: 4,
              at: 0,
              duck: [{ fromFrame: 30, toFrame: 60, depthDb: -15, attackMs: 200, releaseMs: 400 }],
            },
          ],
        },
      ],
    });
    if (!edl.ok) throw new Error("edl");
    const env = duckEnvelope(edl.edl) as Float32Array;
    const db = (t: number) => 20 * Math.log10(env[Math.round(t * 48_000)] as number);
    expect(db(0.5)).toBeCloseTo(0, 6); // before the attack
    expect(db(0.9)).toBeCloseTo(-7.5, 1); // mid-attack (raised cosine: half the depth)
    expect(db(1.0)).toBeCloseTo(-15, 3); // speech starts fully ducked
    expect(db(1.5)).toBeCloseTo(-15, 3);
    expect(db(2.2)).toBeCloseTo(-7.5, 1); // mid-release
    expect(db(2.5)).toBeCloseTo(0, 6);
    for (let t = 0.8; t < 1.0; t += 0.01) expect(db(t + 0.01)).toBeLessThanOrEqual(db(t) + 1e-9);
  });

  it("voix + musique baissée + SFX : -14 LUFS, true peak sous le plafond, stems à la bonne longueur", async () => {
    const fx = await generateFixtures();
    const dir = await mkdtemp(join(tmpdir(), "ck-mix-"));
    const edl = parseEdl({
      version: "1.3.0",
      output: {
        format: "long",
        width: 640,
        height: 360,
        fps: 30,
        video: { bitrateMbps: 8 },
        audio: { targetLufs: -14, truePeakDbtp: -1.5, musicBedLu: -6 },
      },
      sources: {
        v: { path: fx.speechVideo, durationS: 8 },
        m: { path: fx.music, durationS: 8 },
      },
      video: [{ id: "main", clips: [{ id: "A", source: "v", in: 0, out: 6, at: 0 }] }],
      audio: [
        {
          id: "music1",
          clips: [
            {
              id: "m1",
              source: "m",
              in: 0,
              out: 6,
              at: 0,
              duck: [{ fromFrame: 60, toFrame: 120, depthDb: -15, attackMs: 150, releaseMs: 300 }],
            },
          ],
        },
        {
          id: "sfx1",
          clips: [{ id: "fx1", asset: "whoosh@1", in: 0, out: 0.5, at: 150, syncTo: "transition:t" }],
        },
      ],
    });
    if (!edl.ok) throw new Error(JSON.stringify(edl.diagnostics));
    const out = join(dir, "mix.wav");
    const log = await renderAudio(edl.edl, fx.dir, out, dir, await PresetRegistry.load(), join(dir, "v"));
    const l = await measureLoudness(out);
    expect(Math.abs(l.integrated + 14)).toBeLessThanOrEqual(0.3);
    expect(l.truePeak).toBeLessThanOrEqual(-1.5 + 0.05);
    expect(log.sfx).toBe(1);
    // Music bed set 6 LU under the voice, then ducked by 15 dB between 2 s and 4 s.
    const wet = (await readWavF32(join(dir, "v.music.wav"))).samples;
    const dry = (await readWavF32(join(dir, "v.music-dry.wav"))).samples;
    const r = 48_000;
    expect(rms(wet, 2.5 * r, 3.5 * r) - rms(dry, 2.5 * r, 3.5 * r)).toBeCloseTo(-15, 1);
    expect(rms(wet, 0.2 * r, 1.5 * r) - rms(dry, 0.2 * r, 1.5 * r)).toBeCloseTo(0, 3);
    for (const stem of ["v.voice.wav", "v.music.wav", "v.sfx.wav", "mix.wav"])
      expect((await readWavF32(join(dir, stem))).samples.length, stem).toBe(6 * r * 2);
  });
});
