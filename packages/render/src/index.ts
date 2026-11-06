import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gradeCube, gradeKey, LookParamsSchema, sceneLook } from "@cutkiller/color";
import type { Edl } from "@cutkiller/core";
import { ffmpeg, measureLoudness } from "@cutkiller/media";
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
export { letterboxBar, TexturePainter } from "./texture";
export {
  type ClipLog,
  decoderArgs,
  decoderChain,
  encoderArgs,
  gradeFilters,
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
    // Grades (exposure × balance, then the look) baked into one LUT per distinct grade.
    const looks = new Map<string, string>();
    for (const clip of edl.video.flatMap((t) => t.clips)) {
      const c = clip.color;
      if (!c) continue;
      const key = gradeKey(c);
      if (looks.has(key)) continue;
      const preset = c.look ? registry.resolve(c.look) : undefined;
      const gains = c.balance.map((b) => 2 ** c.exposureEv * b) as [number, number, number];
      const cube = join(work, `grade-${looks.size}.cube`);
      await writeFile(
        cube,
        gradeCube(
          preset ? sceneLook(LookParamsSchema.parse(preset.params), c.contrast) : undefined,
          gains,
          preset?.name ?? "grade",
        ),
      );
      looks.set(key, cube);
    }
    const video = await renderVideo(edl, opts.baseDir, mix, opts.outPath, registry, opts.onProgress, looks);
    // Delivered true peak: the AAC encode may overshoot the mix's. Over the delivery
    // margin (mix target + 0.5 dB), the audio alone is encoded again at a higher
    // bitrate and a lower bandwidth, the video stream copied as is.
    const encoded = await measureLoudness(opts.outPath);
    const ceiling = edl.output.audio.truePeakDbtp + 0.5;
    let reencoded: { truePeakDbtp: number } | undefined;
    if (encoded.truePeak > ceiling) {
      const fixed = `${opts.outPath}.aac.mp4`;
      await ffmpeg([
        "-v",
        "error",
        "-i",
        opts.outPath,
        "-i",
        mix,
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        `${Math.max(256, edl.output.audio.bitrateKbps)}k`,
        "-cutoff",
        "16000",
        "-ar",
        String(edl.output.audio.sampleRate),
        "-movflags",
        "+faststart",
        "-y",
        fixed,
      ]);
      await rename(fixed, opts.outPath);
      reencoded = { truePeakDbtp: (await measureLoudness(opts.outPath)).truePeak };
      video.warnings.push(
        `true peak de l'encodage AAC ${encoded.truePeak.toFixed(1)} dBTP > ${ceiling} : audio réencodé (${reencoded.truePeakDbtp.toFixed(1)} dBTP)`,
      );
    }
    const log: RenderLog = {
      ...video,
      audio: { ...audio, encodedTruePeakDbtp: reencoded?.truePeakDbtp ?? encoded.truePeak },
      output: opts.outPath,
      stems: opts.keepStems ? { mix, voice } : {},
    };
    await writeFile(`${opts.outPath}.render-log.json`, `${JSON.stringify(log, null, 2)}\n`);
    return log;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
