import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateFixtures } from "@cutkiller/fixtures";
import { decodeMono, ffmpeg } from "@cutkiller/media";
import { describe, expect, it } from "vitest";
import { voiceCleanupFilters } from "../src/audio";

const RATE = 48_000;
const rmsDb = (pcm: Float32Array, a: number, b: number) => {
  let s = 0;
  const i0 = Math.floor(a * RATE);
  const i1 = Math.floor(b * RATE);
  for (let i = i0; i < i1; i++) s += (pcm[i] as number) ** 2;
  return 10 * Math.log10(s / Math.max(1, i1 - i0) + 1e-20);
};

describe("dialogue cleanup", () => {
  it("removes hiss in the pauses without touching the voice", async () => {
    const fx = await generateFixtures();
    const dir = await mkdtemp(join(tmpdir(), "ck-clean-"));
    const noisy = join(dir, "noisy.wav");
    const clean = join(dir, "clean.wav");
    // Speech + steady pink noise at about -40 dBFS, like a room with ventilation.
    await ffmpeg([
      "-v",
      "error",
      "-i",
      fx.speechWav,
      "-f",
      "lavfi",
      "-i",
      `anoisesrc=color=pink:amplitude=0.02:sample_rate=${RATE}:seed=7`,
      "-filter_complex",
      "[0:a]aresample=48000[v];[v][1:a]amix=inputs=2:duration=first:normalize=0[m]",
      "-map",
      "[m]",
      "-ac",
      "1",
      "-c:a",
      "pcm_f32le",
      "-y",
      noisy,
    ]);
    await ffmpeg([
      "-v",
      "error",
      "-i",
      noisy,
      "-af",
      voiceCleanupFilters({ highpassHz: 80, denoiseDb: 10 }).join(","),
      "-c:a",
      "pcm_f32le",
      "-y",
      clean,
    ]);
    const before = await decodeMono(noisy, RATE);
    const after = await decodeMono(clean, RATE);
    // The longest pause of the script (900 ms after « vidéo »), away from its edges.
    const words = fx.speechTruth.words;
    const k = words.findIndex((w) => w.text === "vidéo");
    const pause: [number, number] = [(words[k]?.end ?? 0) + 0.15, (words[k + 1]?.start ?? 0) - 0.15];
    const speech: [number, number] = [words[k - 3]?.start ?? 0, words[k]?.end ?? 0];
    const noiseDrop = rmsDb(before, ...pause) - rmsDb(after, ...pause);
    const voiceDrop = rmsDb(before, ...speech) - rmsDb(after, ...speech);
    expect(noiseDrop, `noise down by ${noiseDrop.toFixed(1)} dB`).toBeGreaterThan(5);
    expect(Math.abs(voiceDrop), `voice changed by ${voiceDrop.toFixed(1)} dB`).toBeLessThan(1.5);
  });

  it("each stage can be turned off", () => {
    expect(voiceCleanupFilters({ highpassHz: 0, denoiseDb: 0 })).toEqual([]);
    expect(voiceCleanupFilters({ highpassHz: 80, denoiseDb: 0 })).toEqual(["highpass=f=80:poles=2"]);
  });
});
