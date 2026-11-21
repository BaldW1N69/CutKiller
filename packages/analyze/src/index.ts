import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type Activity,
  type Analysis,
  type BeatGrid,
  type Prosody,
  type Subjects,
  type Transcript,
  tr,
  type VoiceActivity,
} from "@cutkiller/core";
import { confinePath, probeSource } from "@cutkiller/media";
import { runWorker } from "./worker";

export { runWorker, workersDir } from "./worker";

export interface AnalyzeOptions {
  /** Run speech/beat analyzers (off: probe only). */
  deep?: boolean;
  /** Spoken language (ISO 639-1), or "auto" to let Whisper detect it per rush. */
  language?: string;
  whisperModel?: string;
  cacheDir?: string;
  log?: (message: string) => void;
  /** Screen recordings: also locate where the picture changes (screen zoom). */
  screen?: boolean;
  /** Inputs that are B-roll (resolved paths): probed and analysed for faces and colour, never transcribed. */
  broll?: ReadonlySet<string>;
}

/** Bump when an analyzer's output changes, to invalidate cached results. */
const ANALYZER_VERSION = {
  activity: "1",
  transcribe: "11",
  vad: "4",
  beats: "3",
  prosody: "1",
  subjects: "3",
} as const;

/**
 * Stage 1 of the pipeline. Every input is probed; with `deep`, rushes with speech
 * are transcribed word by word (forced alignment) and run through VAD, and
 * audio-only inputs (music) get a beat grid. Results are cached by content.
 */
export async function analyzeSources(paths: readonly string[], opts: AnalyzeOptions = {}): Promise<Analysis> {
  const analysis: Analysis = { sources: {} };
  const cacheDir = opts.cacheDir ?? resolve(".cache/analysis");
  const model = opts.whisperModel ?? process.env.CUTKILLER_WHISPER_MODEL ?? "large-v3-turbo";
  const language = opts.language ?? process.env.CUTKILLER_LANGUAGE ?? "auto";
  for (const path of paths) {
    const probe = await probeSource(confinePath(path));
    if (opts.broll?.has(resolve(path)) && probe.hasVideo) probe.role = "broll";
    const id = sourceId(path, analysis.sources);
    analysis.sources[id] = probe;
    if (!opts.deep) continue;
    const key = await contentKey(probe.path);
    if (probe.hasVideo) {
      opts.log?.(tr(`faces and colour of ${id}…`, `visages et couleurs de ${id}…`));
      const subjects = await cached<Subjects>(cacheDir, `${key}.subjects-${ANALYZER_VERSION.subjects}`, () =>
        runWorker("subjects", { path: probe.path }),
      );
      analysis.subjects = { ...analysis.subjects, [id]: subjects };
      if (opts.screen && probe.role !== "broll" && !probe.still) {
        opts.log?.(tr(`screen activity of ${id}…`, `activité à l'écran de ${id}…`));
        const activity = await cached<Activity>(
          cacheDir,
          `${key}.activity-${ANALYZER_VERSION.activity}`,
          () => runWorker("activity", { path: probe.path }),
        );
        analysis.activity = { ...analysis.activity, [id]: activity };
      }
    }
    if (!probe.hasAudio || probe.role === "broll") continue;
    if (probe.hasVideo && !probe.still) {
      opts.log?.(tr(`transcribing ${id}…`, `transcription de ${id}…`));
      const transcript = await cached<Transcript>(
        cacheDir,
        `${key}.transcribe-${ANALYZER_VERSION.transcribe}-${model}-${language}`,
        () => runWorker("transcribe", { path: probe.path, model, language }),
      );
      const vad = await cached<VoiceActivity>(cacheDir, `${key}.vad-${ANALYZER_VERSION.vad}`, () =>
        runWorker("vad", { path: probe.path }),
      );
      const prosody = await cached<Prosody>(
        cacheDir,
        `${key}.prosody-${ANALYZER_VERSION.prosody}-t${ANALYZER_VERSION.transcribe}-${model}-${language}`,
        () => runWorker("prosody", { path: probe.path, words: transcript.words }),
      );
      analysis.transcripts = { ...analysis.transcripts, [id]: transcript };
      analysis.prosody = { ...analysis.prosody, [id]: prosody };
      analysis.vad = { ...analysis.vad, [id]: vad };
    } else if (!probe.hasVideo) {
      opts.log?.(tr(`beats of ${id}…`, `beats de ${id}…`));
      const beats = await cached<BeatGrid>(cacheDir, `${key}.beats-${ANALYZER_VERSION.beats}`, () =>
        runWorker("beats", { path: probe.path }),
      );
      analysis.beats = { ...analysis.beats, [id]: beats };
    }
  }
  return analysis;
}

async function cached<T>(dir: string, key: string, compute: () => Promise<T>): Promise<T> {
  const file = join(dir, `${key}.json`);
  if (existsSync(file)) return JSON.parse(await readFile(file, "utf8")) as T;
  const t0 = performance.now();
  const value = await compute();
  if (process.env.CUTKILLER_TIMINGS !== "0")
    console.error(
      `ℹ [timing] ${key.split(".").slice(1).join(".")} ${((performance.now() - t0) / 1000).toFixed(1)} s`,
    );
  await mkdir(dir, { recursive: true });
  await writeFile(file, JSON.stringify(value));
  return value;
}

/** Fast content key: size + SHA-256 of the first and last 4 MB. */
export async function contentKey(path: string): Promise<string> {
  const { size } = await stat(path);
  const handle = await open(path, "r");
  try {
    const hash = createHash("sha256").update(String(size));
    const chunk = Math.min(size, 4 * 1024 * 1024);
    const buf = Buffer.alloc(chunk);
    await handle.read(buf, 0, chunk, 0);
    hash.update(buf);
    await handle.read(buf, 0, chunk, Math.max(0, size - chunk));
    hash.update(buf);
    return hash.digest("hex").slice(0, 24);
  } finally {
    await handle.close();
  }
}

/** Stable, human-readable source id derived from the file name. */
export function sourceId(path: string, taken: Record<string, unknown> = {}): string {
  const base =
    (path.split(/[\\/]/).pop() ?? "src")
      .replace(/\.[^.]+$/, "")
      .replace(/[^A-Za-z0-9_.-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "src";
  let id = base;
  for (let i = 2; id in taken; i++) id = `${base}-${i}`;
  return id;
}
