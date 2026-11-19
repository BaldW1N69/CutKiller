/**
 * Synthetic French speech with word-level ground truth: each token is spoken by
 * espeak-ng on its own, trimmed to its audible part and laid out with controlled
 * gaps, so every word boundary, pause and hesitation is known to the sample.
 * espeak-ng (GPL-3.0) is a test-time tool only; nothing it produces is shipped.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeMono, ffmpeg } from "@cutkiller/media";

export const RATE = 48_000;

export interface TruthWord {
  text: string;
  start: number;
  end: number;
  filler: boolean;
}

export interface SpeechTruth {
  words: TruthWord[];
  durationS: number;
}

/** Script: words, and `pause:<ms>` gaps. Default gap between words is 60 ms. */
export const SCRIPT = [
  "Bonjour",
  "à",
  "tous",
  "pause:250",
  "aujourd'hui",
  "pause:120",
  "euh",
  "pause:150",
  "je",
  "vais",
  "vous",
  "montrer",
  "comment",
  "monter",
  "une",
  "vidéo",
  "pause:900",
  "euh",
  "pause:500",
  "donc",
  "c'est",
  "parti",
  "pause:700",
  "première",
  "étape",
  "pause:200",
  "on",
  "coupe",
  "les",
  "silences",
  "pause:400",
  "et",
  "on",
  "garde",
  "le",
  "rythme",
];

const FILLERS = new Set(["euh", "heu", "hum", "bah", "ben"]);
const WORD_GAP_MS = 60;
const LEAD_S = 0.8;
const TAIL_S = 0.8;

async function speak(text: string, dir: string, i: number): Promise<Float32Array> {
  const wav = join(dir, `w${i}.wav`);
  const res = spawnSync("espeak-ng", ["-v", "fr", "-s", "165", "-w", wav, text]);
  if (res.status !== 0) throw new Error(`espeak-ng a échoué : ${res.stderr}`);
  const pcm = await decodeMono(wav, RATE);
  // Trim to the audible part: first/last sample above -40 dBFS.
  const th = 0.01;
  let a = 0;
  let b = pcm.length - 1;
  while (a < b && Math.abs(pcm[a] as number) < th) a++;
  while (b > a && Math.abs(pcm[b] as number) < th) b--;
  return pcm.subarray(a, b + 1);
}

export async function generateSpeech(
  dir: string,
): Promise<{ wav: string; video: string; truth: SpeechTruth }> {
  const wav = join(dir, "speech-fr.wav");
  const video = join(dir, "speech-fr.mp4");
  const truthPath = join(dir, "speech-fr.truth.json");
  if (existsSync(wav) && existsSync(video) && existsSync(truthPath)) {
    return { wav, video, truth: JSON.parse(await readFile(truthPath, "utf8")) as SpeechTruth };
  }
  const tmp = join(dir, "speech-parts");
  await mkdir(tmp, { recursive: true });
  const chunks: Float32Array[] = [];
  const words: TruthWord[] = [];
  let cursor = Math.round(LEAD_S * RATE);
  chunks.push(new Float32Array(cursor));
  let pendingGap = 0;
  for (const [i, token] of SCRIPT.entries()) {
    if (token.startsWith("pause:")) {
      pendingGap = Math.round((Number(token.slice(6)) / 1000) * RATE);
      continue;
    }
    if (words.length > 0) {
      const gap = pendingGap || Math.round((WORD_GAP_MS / 1000) * RATE);
      chunks.push(new Float32Array(gap));
      cursor += gap;
    }
    pendingGap = 0;
    const pcm = await speak(token, tmp, i);
    words.push({
      text: token,
      start: cursor / RATE,
      end: (cursor + pcm.length) / RATE,
      filler: FILLERS.has(token),
    });
    chunks.push(pcm);
    cursor += pcm.length;
  }
  const tail = Math.round(TAIL_S * RATE);
  chunks.push(new Float32Array(tail));
  cursor += tail;

  const all = new Float32Array(cursor);
  let o = 0;
  for (const c of chunks) {
    all.set(c, o);
    o += c.length;
  }
  const raw = join(tmp, "speech.f32");
  await writeFile(raw, Buffer.from(all.buffer));
  await ffmpeg([
    "-v",
    "error",
    "-f",
    "f32le",
    "-ar",
    String(RATE),
    "-ac",
    "1",
    "-i",
    raw,
    "-c:a",
    "pcm_s16le",
    "-y",
    wav,
  ]);
  const durationS = cursor / RATE;
  await ffmpeg([
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=1920x1080:rate=30:duration=${durationS}`,
    "-i",
    wav,
    "-vf",
    "noise=alls=10:allf=t,format=yuv420p",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-shortest",
    "-y",
    video,
  ]);
  const truth: SpeechTruth = { words, durationS };
  await writeFile(truthPath, `${JSON.stringify(truth, null, 1)}\n`);
  return { wav, video, truth };
}
