import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SfxParamsSchema, synthesize } from "@cutkiller/audio";
import { type EdlInput, parseEdl } from "@cutkiller/core";
import { ffmpeg, writeWavF32 } from "@cutkiller/media";
import { loadProfile, PresetRegistry } from "@cutkiller/style";
import { beforeAll, describe, expect, it } from "vitest";
import { checkDucking, checkLoudness, checkSfxSync } from "../src/checks/audio";

let profile: Awaited<ReturnType<typeof loadProfile>>;
let registry: PresetRegistry;
beforeAll(async () => {
  profile = await loadProfile("long");
  registry = await PresetRegistry.load();
});

const RATE = 48_000;
const edlOf = (extra: Partial<EdlInput> = {}) => {
  const r = parseEdl({
    version: "1.3.0",
    output: { format: "long", width: 640, height: 360, fps: 30, video: { bitrateMbps: 8 }, audio: {} },
    sources: { a: { path: "a.mp4", durationS: 10 }, m: { path: "m.wav", durationS: 10 } },
    video: [{ id: "main", clips: [{ id: "A", source: "a", in: 0, out: 6, at: 0 }] }],
    audio: [{ id: "music1", clips: [{ id: "m1", source: "m", in: 0, out: 6, at: 0 }] }],
    ...extra,
  });
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
  return r.edl;
};

describe("loudness", () => {
  it("-14 LUFS ±1 et true peak ≤ -1 dBTP, mesurés sur le fichier livré", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ck-lufs-"));
    const tone = async (name: string, filter: string) => {
      const path = join(dir, name);
      await ffmpeg([
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        `sine=f=440:d=5:r=48000,${filter}`,
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-y",
        path,
      ]);
      return path;
    };
    // FFmpeg's sine (amplitude 1/8, mono) reads -21.8 LUFS: +7.8 dB brings it to -14.
    const ok = await checkLoudness(await tone("ok.m4a", "volume=7.8dB"), profile);
    expect(ok.status, JSON.stringify(ok)).toBe("pass");
    const loud = await checkLoudness(await tone("loud.m4a", "volume=19dB"), profile);
    expect(loud.status).toBe("fail");
    expect(loud.violations.map((v) => v.message).join(" ")).toMatch(/LUFS.*true peak|true peak/s);
  });
});

describe("ducking", () => {
  /** Stereo noise at -20 dBFS, with a gain (dB) per sample. */
  function stem(seconds: number, gainDb: (t: number) => number): Float32Array {
    const n = seconds * RATE;
    const out = new Float32Array(n * 2);
    let seed = 1;
    for (let i = 0; i < n; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const v = ((seed / 0x7fffffff) * 2 - 1) * 0.17 * 10 ** (gainDb(i / RATE) / 20);
      out[i * 2] = v;
      out[i * 2 + 1] = v;
    }
    return out;
  }
  const speech = { durationS: 6, speech: [{ start: 2, end: 4 }], noiseFloorDb: -60, peakDb: -10 };
  const ramp = (depth: number, smooth: boolean) => (t: number) => {
    if (t < 1.85 || t > 4.3) return 0;
    if (t >= 2 && t <= 4) return depth;
    if (!smooth) return depth;
    const x = t < 2 ? (t - 1.85) / 0.15 : 1 - (t - 4) / 0.3;
    return depth * (0.5 - 0.5 * Math.cos(Math.PI * x));
  };

  async function verdict(gain: (t: number) => number) {
    const dir = await mkdtemp(join(tmpdir(), "ck-duck-"));
    const video = join(dir, "v.mp4");
    await writeWavF32(`${video}.music-dry.wav`, { rate: RATE, channels: 2, samples: stem(6, () => 0) });
    await writeWavF32(`${video}.music.wav`, { rate: RATE, channels: 2, samples: stem(6, gain) });
    return checkDucking(video, edlOf(), profile, speech);
  }

  it("-15 dB sous la parole avec des rampes douces : conforme", async () => {
    const r = await verdict(ramp(-15, true));
    expect(r.status, JSON.stringify(r.violations)).toBe("pass");
    expect(r.measured).toMatchObject({ medianDepthDb: -15, steepSteps: 0, pumps: 0 });
  });

  it("trop peu baissée, ou baissée d'un coup : refusé", async () => {
    const shallow = await verdict(ramp(-6, true));
    expect(shallow.violations[0]?.message).toMatch(/-6\.0 dB sous la parole/);
    const step = await verdict(ramp(-15, false));
    expect(step.violations.map((v) => v.message).join(" ")).toMatch(/variation\(s\) brusque\(s\)/);
  });
});

describe("synchro des SFX", () => {
  it("impact mesuré sur le stem des effets, à ±1 frame de sa transition", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ck-sfx-"));
    const video = join(dir, "v.mp4");
    const whoosh = synthesize(SfxParamsSchema.parse(registry.resolve("whoosh@1").params), RATE);
    const at = 60;
    const place = (shiftFrames: number) => {
      const out = new Float32Array(6 * RATE * 2);
      out.set(whoosh.samples, Math.round(((at + shiftFrames) / 30) * RATE) * 2);
      return out;
    };
    // Clip placed so that its hit lands on frame 60 + 0.27 s * 30 = 68.1.
    const edl = edlOf({
      transitions: [],
      audio: [
        {
          id: "sfx1",
          clips: [{ id: "fx1", asset: "whoosh@1", in: 0, out: 0.5, at, syncTo: "keyframes:A.scale" }],
        },
      ],
      keyframes: [
        {
          target: "A.scale",
          role: "micro",
          keys: [
            { frame: 68, value: 1 },
            { frame: 74, value: 1.1, ease: "ease-out-cubic" },
          ],
        },
      ],
    });
    await writeWavF32(`${video}.sfx.wav`, { rate: RATE, channels: 2, samples: place(0) });
    expect((await checkSfxSync(video, edl, profile)).status).toBe("pass");
    await writeWavF32(`${video}.sfx.wav`, { rate: RATE, channels: 2, samples: place(3) });
    const late = await checkSfxSync(video, edl, profile);
    expect(late.status).toBe("fail");
    expect(late.violations[0]?.message).toMatch(/impact à \+3\.\d frame\(s\) de keyframes:A\.scale/);
  });
});
