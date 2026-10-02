import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Edl } from "@cutkiller/core";
import { PresetRegistry } from "@cutkiller/style";
import { type AudioMixLog, renderAudio } from "./audio";
import { type MotionLog, renderVideo, type VideoLog } from "./video";

export {
  type AudioMixLog,
  audioMixArgs,
  audioSegments,
  conformAudio,
  duckEnvelope,
  type StemKind,
} from "./audio";
export {
  type ClipLog,
  decoderArgs,
  decoderChain,
  encoderArgs,
  type MotionLog,
  shutterSamples,
  type VideoLog,
} from "./video";

export interface RenderOptions {
  /** Directory that relative source paths in the EDL resolve against. */
  baseDir: string;
  outPath: string;
  /** Keep the intermediate audio mix next to the output (`<out>.mix.wav`). */
  keepStems?: boolean;
  onProgress?: (frame: number, total: number) => void;
  /** Presets used by the EDL's transitions (default: the repo's presets/). */
  registry?: PresetRegistry;
}

export interface RenderLog extends VideoLog {
  motion: MotionLog;
  /** Mix measurements: music bed gain, loudness before/after, limiter. */
  audio: AudioMixLog;
  output: string;
  /** Kept stems: the full mix and the dialogue alone (main-track audio, no music/SFX). */
  stems: { mix?: string; voice?: string };
}

export async function render(edl: Edl, opts: RenderOptions): Promise<RenderLog> {
  await mkdir(dirname(opts.outPath), { recursive: true });
  const work = await mkdtemp(join(tmpdir(), "cutkiller-"));
  const mix = opts.keepStems ? `${opts.outPath}.mix.wav` : join(work, "mix.wav");
  try {
    const registry = opts.registry ?? (await PresetRegistry.load());
    const audio = await renderAudio(
      edl,
      opts.baseDir,
      mix,
      work,
      registry,
      opts.keepStems ? opts.outPath : undefined,
    );
    const voice = `${opts.outPath}.voice.wav`;
    const video = await renderVideo(edl, opts.baseDir, mix, opts.outPath, registry, opts.onProgress);
    const log: RenderLog = {
      ...video,
      audio,
      output: opts.outPath,
      stems: opts.keepStems ? { mix, voice } : {},
    };
    await writeFile(`${opts.outPath}.render-log.json`, `${JSON.stringify(log, null, 2)}\n`);
    return log;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
