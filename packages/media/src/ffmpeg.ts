import { type ChildProcess, spawn } from "node:child_process";
import type { SourceProbe } from "@cutkiller/core";

export const ffmpegBin = (): string => process.env.CUTKILLER_FFMPEG ?? "ffmpeg";
export const ffprobeBin = (): string => process.env.CUTKILLER_FFPROBE ?? "ffprobe";

/**
 * Containers a media input may be: FFmpeg recognises a file by its bytes, not its
 * name, and some formats are made of references to other files (HLS playlists,
 * concat lists) or of protocols (http, concat:, subfile:). A playlist sent as a
 * "rush" would make FFmpeg read another file of the machine into the render.
 * Only local files of these self-contained formats are opened.
 */
export const MEDIA_FORMATS =
  "mov,matroska,webm,avi,mpegts,flv,mxf,wav,w64,mp3,flac,ogg,aac,aiff,caf,image2,png_pipe,jpeg_pipe,webp_pipe,bmp_pipe,tiff_pipe,gif";

/** Options that restrict the input that follows them to a local file of a media format. */
export const MEDIA_INPUT_GUARD: readonly string[] = [
  "-protocol_whitelist",
  "file,pipe",
  "-format_whitelist",
  MEDIA_FORMATS,
];

/** `-i path` for a user media file, guarded (see MEDIA_FORMATS). */
export function mediaInput(path: string): string[] {
  return [...MEDIA_INPUT_GUARD, "-i", path];
}

export interface RunResult {
  stdout: Buffer;
  stderr: string;
}

/** Runs a command to completion; rejects with the tail of stderr on failure. */
export function run(cmd: string, args: readonly string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => {
      err += d.toString();
      if (err.length > 1_000_000) err = err.slice(-500_000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout: Buffer.concat(out), stderr: err });
      else reject(new Error(`${cmd} a échoué (code ${code}) : ${err.slice(-2000)}`));
    });
  });
}

export const ffmpeg = (args: readonly string[]) => run(ffmpegBin(), ["-hide_banner", "-nostdin", ...args]);

/** Waits for a spawned process and rejects if it exits with a non-zero code. */
export function waitFor(child: ChildProcess, label: string): Promise<void> {
  let err = "";
  child.stderr?.on("data", (d: Buffer) => {
    err = (err + d.toString()).slice(-4000);
  });
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0 || signal === "SIGTERM") resolve();
      else reject(new Error(`${label} a échoué (code ${code}) : ${err}`));
    });
  });
}

export interface FfprobeStream {
  index: number;
  codec_type: "video" | "audio" | "subtitle" | "data";
  codec_name?: string;
  profile?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  nb_frames?: string;
  duration?: string;
  bit_rate?: string;
  sample_rate?: string;
  channels?: number;
}

export interface FfprobeResult {
  streams: FfprobeStream[];
  format: { format_name: string; duration?: string; bit_rate?: string };
}

export async function ffprobe(path: string): Promise<FfprobeResult> {
  const { stdout } = await run(ffprobeBin(), [
    ...MEDIA_INPUT_GUARD,
    "-v",
    "error",
    "-show_streams",
    "-show_format",
    "-of",
    "json",
    path,
  ]);
  return JSON.parse(stdout.toString()) as FfprobeResult;
}

export function parseRate(rate: string | undefined): number | undefined {
  if (!rate) return undefined;
  const [num, den] = rate.split("/").map(Number);
  if (!num || !den) return undefined;
  return num / den;
}

const IMAGE_CODECS = new Set(["png", "mjpeg", "webp", "bmp", "tiff"]);

export async function probeSource(path: string): Promise<SourceProbe> {
  const info = await ffprobe(path);
  const video = info.streams.find((s) => s.codec_type === "video");
  const audio = info.streams.find((s) => s.codec_type === "audio");
  const still =
    video !== undefined &&
    IMAGE_CODECS.has(video.codec_name ?? "") &&
    (info.format.format_name.includes("image2") || info.format.format_name.endsWith("_pipe"));
  const rFps = parseRate(video?.r_frame_rate);
  const avgFps = parseRate(video?.avg_frame_rate);
  const durationS = Number(info.format.duration ?? video?.duration ?? audio?.duration ?? 0);
  const probe: SourceProbe = {
    path,
    durationS,
    hasVideo: video !== undefined,
    hasAudio: audio !== undefined,
  };
  if (video?.width) probe.width = video.width;
  if (video?.height) probe.height = video.height;
  if (still) probe.still = true;
  else if (avgFps ?? rFps) {
    probe.fps = avgFps ?? rFps;
    if (await isVariableFrameRate(path)) probe.vfr = true;
  }
  return probe;
}

/**
 * Phones write VFR files whose header rates still read 30/1: only the spacing of
 * the actual frame timestamps tells. Looks at the first `seconds` of packets.
 */
export async function isVariableFrameRate(path: string, seconds = 10): Promise<boolean> {
  const { stdout } = await run(ffprobeBin(), [
    ...MEDIA_INPUT_GUARD,
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-read_intervals",
    `%+${seconds}`,
    "-show_entries",
    "packet=pts_time",
    "-of",
    "csv=p=0",
    path,
  ]);
  const pts = stdout
    .toString()
    .split("\n")
    .map(Number)
    .filter((n) => Number.isFinite(n) && n !== 0)
    .sort((a, b) => a - b);
  if (pts.length < 10) return false;
  const deltas = pts.slice(1).map((t, i) => t - (pts[i] as number));
  const sorted = [...deltas].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] as number;
  return deltas.some((d) => Math.abs(d - median) > median * 0.1);
}

export async function ffmpegVersion(): Promise<{ major: number; raw: string }> {
  const { stdout } = await run(ffmpegBin(), ["-version"]);
  const raw = stdout.toString().split("\n")[0] ?? "";
  const match = /version n?(\d+)/.exec(raw);
  return { major: match ? Number(match[1]) : 0, raw };
}

/** First audio stream decoded to mono float samples (48 kHz by default). */
export async function decodeMono(path: string, rate = 48_000): Promise<Float32Array> {
  const { stdout } = await ffmpeg([
    "-v",
    "error",
    ...mediaInput(path),
    "-map",
    "0:a:0",
    "-ac",
    "1",
    "-ar",
    String(rate),
    "-f",
    "f32le",
    "-",
  ]);
  const copy = new Uint8Array(stdout.length - (stdout.length % 4));
  copy.set(stdout.subarray(0, copy.length));
  return new Float32Array(copy.buffer);
}

/** Interleaved stereo samples of the first audio stream (L, R, L, R…). */
export async function decodeStereo(path: string, rate = 48_000): Promise<Float32Array> {
  const { stdout } = await ffmpeg([
    "-v",
    "error",
    ...mediaInput(path),
    "-map",
    "0:a:0",
    "-ac",
    "2",
    "-ar",
    String(rate),
    "-f",
    "f32le",
    "-",
  ]);
  const copy = new Uint8Array(stdout.length - (stdout.length % 8));
  copy.set(stdout.subarray(0, copy.length));
  return new Float32Array(copy.buffer);
}

/**
 * A file path as an option value inside an FFmpeg filtergraph, unquoted
 * (`lut3d=file=${filterPath(p)}:interp=…`). FFmpeg unescapes twice: first the
 * graph (\\ ' [ ] , ;), then the option (\\ ' :), so each special character is
 * escaped for the option, then the result for the graph. Backslashes become
 * forward slashes first: `C:\\tmp\\a.cube` → `C\\\\:/tmp/a.cube`.
 */
export function filterPath(path: string): string {
  const option = path.replace(/\\/g, "/").replace(/[\\':]/g, (c) => `\\${c}`);
  return option.replace(/[\\'[\],;]/g, (c) => `\\${c}`);
}
