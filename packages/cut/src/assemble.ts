import { relative } from "node:path";
import {
  type Analysis,
  EDL_VERSION,
  type Edl,
  type EdlInput,
  EdlSchema,
  type StyleProfile,
  secondsToFrames,
} from "@cutkiller/core";

export interface AssembleOptions {
  /** Directory the EDL will be written to: source paths are stored relative to it. */
  edlDir: string;
  /** Seconds a still image stays on screen. */
  stillSeconds?: number;
  /** Trim on audio-only inputs (music); their level under the voice is set at render (`output.audio.musicBedLu`). */
  musicGainDb?: number;
}

/**
 * Initial EDL: every video/still input end to end on the main track, in the order
 * given, and audio-only inputs (music) under the whole timeline. The cut pass
 * refines this rough assembly from phase 2 on.
 */
export function assembleEdl(analysis: Analysis, profile: StyleProfile, opts: AssembleOptions): Edl {
  const { width, height, fps, kind } = profile.format;
  const sources: Edl["sources"] = {};
  const clips: EdlInput["video"][number]["clips"] = [];
  const music: [string, number][] = [];
  let at = 0;

  for (const [id, probe] of Object.entries(analysis.sources)) {
    sources[id] = {
      path: relative(opts.edlDir, probe.path) || probe.path,
      ...(probe.durationS > 0 ? { durationS: probe.durationS } : {}),
      hasAudio: probe.hasAudio,
      ...(probe.fps ? { fps: probe.fps } : {}),
      ...(probe.width ? { width: probe.width, height: probe.height } : {}),
      ...(probe.still ? { still: true } : {}),
      ...(probe.role ? { role: probe.role } : {}),
    };
    if (!probe.hasVideo) {
      music.push([id, probe.durationS]);
      continue;
    }
    const out = probe.still ? (opts.stillSeconds ?? 3) : probe.durationS;
    clips.push({
      id: `c${String(clips.length + 1).padStart(3, "0")}`,
      source: id,
      in: 0,
      out,
      at,
      why: { kind: "assemble" },
    });
    at += secondsToFrames(out, fps);
  }

  const totalS = at / fps;
  const audio = music.map(([id, duration], i) => ({
    id: `music${i + 1}`,
    clips: [
      {
        id: `m${String(i + 1).padStart(3, "0")}`,
        source: id,
        in: 0,
        out: Math.min(duration, totalS),
        at: 0,
        gainDb: opts.musicGainDb ?? 0,
        fadeOutMs: 1000,
        why: { kind: "music" },
      },
    ],
  }));

  const minMbps = fps === 60 ? profile.export.minBitrateMbps["60"] : profile.export.minBitrateMbps["30"];
  return EdlSchema.parse({
    version: EDL_VERSION,
    meta: { generator: "cutkiller@0.1.0", profile: `${profile.id}@${profile.version}` },
    output: {
      format: kind,
      width,
      height,
      fps,
      video: {
        codec: profile.export.codec,
        bitrateMbps: Math.round(minMbps * profile.export.targetBitrateFactor * 10) / 10,
      },
      audio: { cutFadeMs: (profile.audio.cutFadeMs[0] + profile.audio.cutFadeMs[1]) / 2 },
      motionBlur: { thresholdPxPerFrame: profile.motion.motionBlurThresholdPxPerFrame },
      ...(profile.texture.grain > 0 ||
      profile.texture.vignette > 0 ||
      profile.texture.halation > 0 ||
      profile.texture.letterbox
        ? { texture: profile.texture }
        : {}),
    },
    sources,
    video: [{ id: "main", clips }],
    audio,
  });
}
