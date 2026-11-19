import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SfxParamsSchema, synthesize } from "@cutkiller/audio";
import {
  type Edl,
  edlDurationFrames,
  framesToSeconds,
  mainAudioSpans,
  type PresetResolver,
} from "@cutkiller/core";
import { ffmpeg, ffprobe, measureLoudness, readWavF32, writeWavF32 } from "@cutkiller/media";

interface Segment {
  path: string;
  sourceIn: number;
  sourceOut: number;
  startSeconds: number;
  gainDb: number;
  fadeInS: number;
  fadeOutS: number;
}

/**
 * Decodes each source's audio once to a float WAV on the container timeline:
 * t = 0 is the start of the file, even when the audio stream starts later
 * (padded with silence). Seeking a WAV is sample-accurate, whereas seeking the
 * container snaps to video keyframes and can shift the audio by seconds.
 */
export async function conformAudio(
  paths: readonly string[],
  workDir: string,
  rate: number,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const [i, path] of [...new Set(paths)].entries()) {
    const wav = join(workDir, `src${i}.wav`);
    await ffmpeg([
      "-v",
      "error",
      "-i",
      path,
      "-map",
      "0:a:0",
      "-vn",
      "-af",
      `aresample=${rate}:async=1:first_pts=0,aformat=sample_fmts=flt:channel_layouts=stereo`,
      "-c:a",
      "pcm_f32le",
      "-y",
      wav,
    ]);
    out.set(path, wav);
  }
  return out;
}

export type StemKind = "voice" | "music" | "sfx";

/**
 * Pieces of one stem: `voice` is the main track's audio (with its edits and J/L
 * splits), `music` every source clip of the audio tracks, `sfx` the generated
 * sound effects (`assets` maps a preset reference to its synthesized WAV).
 */
export function audioSegments(
  edl: Edl,
  baseDir: string,
  kind: StemKind | boolean = "voice",
  assets: ReadonlyMap<string, string> = new Map(),
): Segment[] {
  // Back-compat: `true` meant "voice only", `false` "everything".
  if (typeof kind === "boolean")
    return kind
      ? audioSegments(edl, baseDir, "voice", assets)
      : [
          ...audioSegments(edl, baseDir, "voice", assets),
          ...audioSegments(edl, baseDir, "music", assets),
          ...audioSegments(edl, baseDir, "sfx", assets),
        ];
  const fps = edl.output.fps;
  const cutFade = edl.output.audio.cutFadeMs / 1000;
  const segments: Segment[] = [];
  if (kind === "voice") {
    let last: Segment | undefined;
    for (const span of mainAudioSpans(edl)) {
      const source = span.clip.source === undefined ? undefined : edl.sources[span.clip.source];
      if (!source || source.hasAudio === false || source.still) {
        last = undefined;
        continue;
      }
      if (span.continuesPrev && last) {
        // Seamless continuation (zoom cut): extend the previous segment, no fade.
        last.sourceOut = span.sourceOut;
        continue;
      }
      last = {
        path: resolve(baseDir, source.path),
        sourceIn: span.sourceIn,
        sourceOut: span.sourceOut,
        startSeconds: framesToSeconds(span.startFrame, fps),
        gainDb: span.clip.gainDb,
        // Every piece fades in and out, not only at edits between two clips: the
        // timeline's first and last clips, or one next to a gap, start or stop the
        // speech mid-waveform too.
        fadeInS: cutFade,
        fadeOutS: cutFade,
      };
      segments.push(last);
    }
    return segments;
  }
  for (const track of edl.audio)
    for (const clip of track.clips) {
      let path: string | undefined;
      if (kind === "music" && clip.source !== undefined) {
        const source = edl.sources[clip.source];
        if (source) path = resolve(baseDir, source.path);
      } else if (kind === "sfx" && clip.asset !== undefined) path = assets.get(clip.asset);
      if (!path) continue;
      segments.push({
        path,
        sourceIn: clip.in,
        sourceOut: clip.out,
        startSeconds: framesToSeconds(clip.at, fps),
        gainDb: clip.gainDb,
        // Effects keep their own attack: no cut fade forced on them.
        fadeInS: kind === "sfx" ? clip.fadeInMs / 1000 : Math.max(clip.fadeInMs / 1000, cutFade),
        fadeOutS: kind === "sfx" ? clip.fadeOutMs / 1000 : Math.max(clip.fadeOutMs / 1000, cutFade),
      });
    }
  return segments;
}

const totalSamplesOf = (edl: Edl) =>
  Math.round(framesToSeconds(edlDurationFrames(edl), edl.output.fps) * edl.output.audio.sampleRate);

/**
 * ffmpeg arguments that render one stem of the timeline to a stereo float WAV of
 * exact length. `conformed` maps source paths to their conformed WAV (see conformAudio).
 */
export function audioMixArgs(
  edl: Edl,
  baseDir: string,
  outPath: string,
  kind: StemKind | boolean = false,
  conformed: ReadonlyMap<string, string> = new Map(),
  assets: ReadonlyMap<string, string> = new Map(),
  /** Duration (s) of each input file, when known: a cut fade never lands after the audio has ended. */
  durations: ReadonlyMap<string, number> = new Map(),
): string[] {
  const rate = edl.output.audio.sampleRate;
  const totalSamples = totalSamplesOf(edl);
  const segments = audioSegments(edl, baseDir, kind, assets);
  const args: string[] = [];
  const filters: string[] = [];
  const labels: string[] = [];

  segments.forEach((seg, i) => {
    const input = conformed.get(seg.path) ?? seg.path;
    args.push("-ss", seg.sourceIn.toFixed(6), "-i", input);
    // A source whose audio stream stops before its video (by a few ms) would end
    // the piece abruptly before the fade: the fade ends where the audio does.
    const available = (durations.get(input) ?? Number.POSITIVE_INFINITY) - seg.sourceIn;
    const len = Math.max(0, Math.min(seg.sourceOut - seg.sourceIn, available));
    const chain = [
      `atrim=start=0:duration=${len.toFixed(6)}`,
      "asetpts=PTS-STARTPTS",
      `aresample=${rate}`,
      "aformat=sample_fmts=fltp:channel_layouts=stereo",
    ];
    if (seg.fadeInS > 0) chain.push(`afade=t=in:st=0:d=${seg.fadeInS.toFixed(4)}:curve=qsin`);
    if (seg.fadeOutS > 0)
      chain.push(
        `afade=t=out:st=${Math.max(0, len - seg.fadeOutS).toFixed(6)}:d=${seg.fadeOutS.toFixed(4)}:curve=qsin`,
      );
    if (seg.gainDb !== 0) chain.push(`volume=${seg.gainDb}dB`);
    const delay = Math.round(seg.startSeconds * rate);
    if (delay > 0) chain.push(`adelay=delays=${delay}S:all=1`);
    filters.push(`[${i}:a]${chain.join(",")}[s${i}]`);
    labels.push(`[s${i}]`);
  });

  const tail = `apad=whole_len=${totalSamples},atrim=end_sample=${totalSamples}`;
  if (labels.length === 0) {
    args.push("-f", "lavfi", "-i", `anullsrc=r=${rate}:cl=stereo`);
    filters.push(`[0:a]${tail}[mix]`);
  } else if (labels.length === 1) {
    filters.push(`${labels[0]}${tail}[mix]`);
  } else {
    filters.push(
      `${labels.join("")}amix=inputs=${labels.length}:normalize=0:dropout_transition=0,${tail}[mix]`,
    );
  }
  args.push("-filter_complex", filters.join(";"), "-map", "[mix]", "-c:a", "pcm_f32le", "-y", outPath);
  return args;
}

/**
 * Gain (linear) of the music at every sample: 1, except under the clips' ducks,
 * where it follows raised-cosine ramps down to `depthDb` and back.
 */
export function duckEnvelope(edl: Edl): Float32Array | undefined {
  const rate = edl.output.audio.sampleRate;
  const fps = edl.output.fps;
  const total = totalSamplesOf(edl);
  let env: Float32Array | undefined;
  for (const track of edl.audio)
    for (const clip of track.clips) {
      if (clip.source === undefined || clip.duck.length === 0) continue;
      env ??= new Float32Array(total).fill(1);
      const clipStart = framesToSeconds(clip.at, fps);
      const clipEndS = clipStart + (clip.out - clip.in);
      for (const d of clip.duck) {
        const a = framesToSeconds(d.fromFrame, fps);
        const b = framesToSeconds(d.toFrame, fps);
        const att = d.attackMs / 1000;
        const rel = d.releaseMs / 1000;
        const from = Math.max(0, Math.floor(Math.max(clipStart, a - att) * rate));
        const to = Math.min(total, Math.ceil(Math.min(clipEndS, b + rel) * rate));
        for (let i = from; i < to; i++) {
          const t = i / rate;
          const shape =
            t < a
              ? att > 0
                ? 0.5 - 0.5 * Math.cos((Math.PI * (t - (a - att))) / att)
                : 1
              : t <= b
                ? 1
                : rel > 0
                  ? 0.5 + 0.5 * Math.cos((Math.PI * (t - b)) / rel)
                  : 0;
          const g = 10 ** ((d.depthDb * shape) / 20);
          if (g < (env[i] as number)) env[i] = g;
        }
      }
    }
  return env;
}

export interface AudioMixLog {
  /** True peak of the delivered file (after AAC encoding), dBTP. */
  encodedTruePeakDbtp?: number;
  voiceLufs: number | null;
  musicLufs: number | null;
  /** Gain given to the music so that it sits `musicBedLu` under the voice. */
  musicGainDb: number;
  ducks: number;
  sfx: number;
  /** Loudness before the final gain and limiter. */
  preLufs: number | null;
  gainDb: number;
  limiterDb: number;
  /** Loudness the limiter took away (gain applied minus loudness gained), LU. */
  limiterLossLu: number | null;
  lufs: number;
  truePeakDbtp: number;
  passes: number;
}

const finite = (x: number) => (Number.isFinite(x) ? x : null);
const dbToGain = (db: number) => 10 ** (db / 20);

/**
 * Mixes the timeline: dialogue, music (set to its bed level under the voice,
 * then ducked under speech) and synthesized effects, rendered as stems by
 * FFmpeg and summed here; then brought to the target integrated loudness under
 * a true-peak ceiling (gain + look-ahead limiter, re-measured until both hold).
 * With `stems`, also writes `<stems>.voice.wav`, `.music.wav`, `.music-dry.wav`
 * and `.sfx.wav` for the QA.
 */
export async function renderAudio(
  edl: Edl,
  baseDir: string,
  outPath: string,
  workDir: string,
  presets?: PresetResolver,
  stems?: string,
): Promise<AudioMixLog> {
  const rate = edl.output.audio.sampleRate;
  const total = totalSamplesOf(edl);
  const target = edl.output.audio;

  // Sound effects: synthesized once per preset.
  const assets = new Map<string, string>();
  for (const ref of new Set(edl.audio.flatMap((t) => t.clips.flatMap((c) => (c.asset ? [c.asset] : []))))) {
    if (!presets) throw new Error(`effet sonore ${ref} sans registre de presets`);
    const sound = synthesize(SfxParamsSchema.parse(presets.resolve(ref).params), rate);
    const path = join(workDir, `sfx-${assets.size}.wav`);
    await writeWavF32(path, { rate, channels: 2, samples: sound.samples });
    assets.set(ref, path);
  }

  const read = async (kind: StemKind): Promise<Float32Array | undefined> => {
    const segments = audioSegments(edl, baseDir, kind, assets);
    if (segments.length === 0) return undefined;
    const conformed =
      kind === "sfx"
        ? new Map<string, string>()
        : await conformAudio(
            segments.map((s) => s.path),
            join(workDir, kind),
            rate,
          );
    const durations = new Map<string, number>();
    for (const wav of conformed.values()) {
      const d = Number((await ffprobe(wav)).format.duration);
      if (Number.isFinite(d) && d > 0) durations.set(wav, d);
    }
    const path = join(workDir, `${kind}.wav`);
    await ffmpeg(audioMixArgs(edl, baseDir, path, kind, conformed, assets, durations));
    const { samples } = await readWavF32(path);
    return samples;
  };
  await mkdir(join(workDir, "voice"), { recursive: true });
  await mkdir(join(workDir, "music"), { recursive: true });
  let voice = await read("voice");
  const dry = await read("music");
  const sfx = await read("sfx");

  let voiceLufs = Number.NaN;
  let musicLufs = Number.NaN;
  let musicGainDb = 0;
  let voicePath = join(workDir, "voice.wav");
  if (voice) voiceLufs = (await measureLoudness(voicePath)).integrated;
  const comp = target.voiceCompression;
  if (voice && comp && Number.isFinite(voiceLufs)) {
    // Threshold relative to the dialogue's loudness: same treatment whatever the recording level.
    const threshold = Math.min(1, Math.max(0.000976563, dbToGain(voiceLufs + comp.thresholdLu)));
    const compressed = join(workDir, "voice-comp.wav");
    await ffmpeg([
      "-v",
      "error",
      "-i",
      voicePath,
      "-af",
      `acompressor=threshold=${threshold.toFixed(6)}:ratio=${comp.ratio}:attack=${comp.attackMs}:release=${comp.releaseMs}:knee=4:detection=rms:link=average`,
      "-c:a",
      "pcm_f32le",
      "-y",
      compressed,
    ]);
    voicePath = compressed;
    voice = (await readWavF32(compressed)).samples;
    voiceLufs = (await measureLoudness(compressed)).integrated;
  }
  if (dry && voice && target.musicBedLu !== undefined) {
    musicLufs = (await measureLoudness(join(workDir, "music.wav"))).integrated;
    if (Number.isFinite(voiceLufs) && Number.isFinite(musicLufs))
      musicGainDb = voiceLufs + target.musicBedLu - musicLufs;
  }
  const env = duckEnvelope(edl);
  const bed = dbToGain(musicGainDb);
  const n = total * 2;
  const music = dry ? new Float32Array(n) : undefined;
  const musicDry = dry ? new Float32Array(n) : undefined;
  const mix = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = voice ? (voice[i] ?? 0) : 0;
    if (dry && music && musicDry) {
      const d = (dry[i] ?? 0) * bed;
      musicDry[i] = d;
      const m = d * (env ? (env[i >> 1] as number) : 1);
      music[i] = m;
      v += m;
    }
    if (sfx) v += sfx[i] ?? 0;
    mix[i] = v;
  }
  const pre = join(workDir, "pre.wav");
  await writeWavF32(pre, { rate, channels: 2, samples: mix });

  // Loudness: gain to target, then a true-peak ceiling; re-measure and correct.
  const before = await measureLoudness(pre);
  let gainDb = Number.isFinite(before.integrated) ? target.targetLufs - before.integrated : 0;
  let limiterDb = target.truePeakDbtp - 0.3;
  let result = before;
  let passes = 0;
  for (; passes < 5; passes++) {
    await ffmpeg([
      "-v",
      "error",
      "-i",
      pre,
      "-af",
      `volume=${gainDb.toFixed(3)}dB,alimiter=limit=${Math.max(0.0625, dbToGain(limiterDb)).toFixed(5)}:attack=1:release=60:level=0:latency=1,apad=whole_len=${total},atrim=end_sample=${total}`,
      "-c:a",
      "pcm_f32le",
      "-y",
      outPath,
    ]);
    result = await measureLoudness(outPath);
    if (!Number.isFinite(result.integrated)) break;
    const lufsOff = target.targetLufs - result.integrated;
    const peakOver = result.truePeak - target.truePeakDbtp;
    if (Math.abs(lufsOff) <= 0.2 && peakOver <= 0) break;
    gainDb += lufsOff;
    if (peakOver > 0) limiterDb -= peakOver + 0.1;
  }

  if (stems) {
    const write = (suffix: string, samples: Float32Array | undefined) =>
      samples ? writeWavF32(`${stems}.${suffix}.wav`, { rate, channels: 2, samples }) : Promise.resolve();
    await write("voice", voice ?? new Float32Array(n));
    await write("music", music);
    await write("music-dry", musicDry);
    await write("sfx", sfx);
  }
  return {
    voiceLufs: finite(voiceLufs),
    musicLufs: finite(musicLufs),
    musicGainDb: Math.round(musicGainDb * 100) / 100,
    ducks: edl.audio.reduce((s, t) => s + t.clips.reduce((c, k) => c + k.duck.length, 0), 0),
    sfx: edl.audio.reduce((s, t) => s + t.clips.filter((k) => k.asset).length, 0),
    preLufs: finite(before.integrated),
    gainDb: Math.round(gainDb * 100) / 100,
    limiterDb: Math.round(limiterDb * 100) / 100,
    limiterLossLu: finite(Math.round((gainDb - (result.integrated - before.integrated)) * 100) / 100),
    lufs: result.integrated,
    truePeakDbtp: result.truePeak,
    passes: passes + 1,
  };
}
