import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Edl } from "@cutkiller/core";
import { renderAudio } from "./audio";
import { renderVideo, type VideoLog } from "./video";

export { audioMixArgs, audioSegments } from "./audio";
export { type ClipLog, decoderArgs, decoderChain, encoderArgs, type VideoLog } from "./video";

export interface RenderOptions {
  /** Directory that relative source paths in the EDL resolve against. */
  baseDir: string;
  outPath: string;
  /** Keep the intermediate audio mix next to the output (`<out>.mix.wav`). */
  keepStems?: boolean;
  onProgress?: (frame: number, total: number) => void;
}

export interface RenderLog extends VideoLog {
  output: string;
  stems: { mix?: string };
}

export async function render(edl: Edl, opts: RenderOptions): Promise<RenderLog> {
  await mkdir(dirname(opts.outPath), { recursive: true });
  const work = await mkdtemp(join(tmpdir(), "cutkiller-"));
  const mix = opts.keepStems ? `${opts.outPath}.mix.wav` : join(work, "mix.wav");
  try {
    await renderAudio(edl, opts.baseDir, mix);
    const video = await renderVideo(edl, opts.baseDir, mix, opts.outPath, opts.onProgress);
    const log: RenderLog = { ...video, output: opts.outPath, stems: opts.keepStems ? { mix } : {} };
    await writeFile(`${opts.outPath}.render-log.json`, `${JSON.stringify(log, null, 2)}\n`);
    return log;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
