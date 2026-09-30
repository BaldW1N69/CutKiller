import { type ChildProcess, spawn } from "node:child_process";
import { resolve } from "node:path";
import {
  clipEnd,
  clipFrames,
  type Edl,
  edlDurationFrames,
  framesToSeconds,
  sortedClips,
  type VideoClip,
} from "@cutkiller/core";
import { ffmpegBin, waitFor } from "@cutkiller/media";
import { type CanvasRenderingContext2D, createCanvas, type ImageData } from "canvas";
import { FrameReader } from "./frames";

export interface ClipLog {
  id: string;
  track: string;
  frames: number;
  /** Frames repeated because the decoder delivered fewer frames than the clip needs. */
  held: number;
}

export interface VideoLog {
  frames: number;
  clips: ClipLog[];
  heldFrames: number;
  elapsedMs: number;
  renderFps: number;
  warnings: string[];
}

/** Input options and filter chain that turn a clip's source into output-sized, output-rate frames. */
export function decoderChain(
  edl: Edl,
  clip: VideoClip,
  baseDir: string,
): { input: string[]; vf: string; duration: number } {
  const { width: W, height: H, fps } = edl.output;
  const source = edl.sources[clip.source];
  if (!source) throw new Error(`source inconnue ${clip.source}`);
  const path = resolve(baseDir, source.path);
  const frames = clipFrames(clip, fps);
  // Crop before scaling: resampling only the kept area is several times cheaper.
  const { scale, x, y } = clip.transform;
  const cw = `min(iw,ih*${W}/${H})`;
  const ch = `min(ih,iw*${H}/${W})`;
  const fit =
    clip.fit === "contain"
      ? `scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black`
      : `crop=w='${cw}/${scale}':h='${ch}/${scale}':x='clip(iw/2+${x}*${cw}-ow/2,0,iw-ow)':y='clip(ih/2+${y}*${ch}-oh/2,0,ih-oh)',scale=${W}:${H}:flags=lanczos`;
  return {
    input: source.still ? ["-loop", "1", "-i", path] : ["-ss", clip.in.toFixed(6), "-i", path],
    // start_time=0: output time 0 is the seek point; if the video stream starts
    // later than that (offset streams), its first frame is held, never shifted.
    vf: `fps=${fps}:start_time=0:round=near,${fit}`,
    duration: framesToSeconds(frames, fps) + 0.5 / fps,
  };
}

export function decoderArgs(edl: Edl, clip: VideoClip, baseDir: string): string[] {
  const { input, vf, duration } = decoderChain(edl, clip, baseDir);
  return [
    "-hide_banner",
    "-nostdin",
    "-v",
    "error",
    ...input,
    "-t",
    duration.toFixed(6),
    "-an",
    "-sn",
    "-vf",
    `${vf},format=rgba`,
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgba",
    "pipe:1",
  ];
}

export function encoderArgs(edl: Edl, audioPath: string, outPath: string): string[] {
  const { width: W, height: H, fps, video, audio } = edl.output;
  const kbps = Math.round(video.bitrateMbps * 1000);
  const codec =
    video.codec === "h265"
      ? [
          "-c:v",
          "libx265",
          "-tag:v",
          "hvc1",
          "-x265-params",
          `vbv-maxrate=${kbps}:vbv-bufsize=${kbps * 2}:strict-cbr=1`,
        ]
      : ["-c:v", "libx264", "-profile:v", "high", "-x264-params", "nal-hrd=cbr:force-cfr=1"];
  return [
    "-hide_banner",
    "-nostdin",
    "-v",
    "error",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "bgra",
    "-s",
    `${W}x${H}`,
    "-framerate",
    String(fps),
    "-i",
    "pipe:0",
    "-i",
    audioPath,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-vf",
    "scale=out_color_matrix=bt709:out_range=tv:flags=bicubic,format=yuv420p",
    ...codec,
    "-preset",
    video.preset,
    "-b:v",
    `${kbps}k`,
    "-minrate",
    `${kbps}k`,
    "-maxrate",
    `${kbps}k`,
    "-bufsize",
    `${kbps * 2}k`,
    "-g",
    String(fps * 2),
    "-colorspace",
    "bt709",
    "-color_primaries",
    "bt709",
    "-color_trc",
    "bt709",
    "-color_range",
    "tv",
    "-fps_mode",
    "cfr",
    "-r",
    String(fps),
    "-c:a",
    "aac",
    "-b:a",
    `${audio.bitrateKbps}k`,
    "-ar",
    String(audio.sampleRate),
    "-movflags",
    "+faststart",
    "-y",
    outPath,
  ];
}

interface ActiveClip {
  clip: VideoClip;
  track: string;
  end: number;
  process: ChildProcess;
  reader: FrameReader;
  done: Promise<void>;
  last: Buffer | null;
  log: ClipLog;
  stopped: boolean;
}

function write(stream: NodeJS.WritableStream, data: Buffer): Promise<void> {
  return new Promise((resolveWrite, reject) => {
    const ok = stream.write(data, (err) => (err ? reject(err) : undefined));
    if (ok) resolveWrite();
    else stream.once("drain", () => resolveWrite());
  });
}

/**
 * Frame loop: every track's active clip is decoded by its own FFmpeg process
 * (seek + fps conform + fit), composited on a Cairo canvas, and piped to one
 * encoder. Keyframe animation is evaluated here from phase 3 on.
 */
export async function renderVideo(
  edl: Edl,
  baseDir: string,
  audioPath: string,
  outPath: string,
  onProgress?: (frame: number, total: number) => void,
): Promise<VideoLog> {
  const { width: W, height: H, fps } = edl.output;
  const total = edlDurationFrames(edl);
  const started = performance.now();
  const warnings: string[] = [];
  if (edl.keyframes.length > 0)
    warnings.push("keyframes présentes mais non rendues avant la phase 3 (motion)");

  const encoder = spawn(ffmpegBin(), encoderArgs(edl, audioPath, outPath), {
    stdio: ["pipe", "ignore", "pipe"],
  });
  const encoded = waitFor(encoder, "encodeur");
  const stdin = encoder.stdin;
  if (!stdin) throw new Error("encodeur sans stdin");

  const out = createCanvas(W, H);
  const ctx = out.getContext("2d") as CanvasRenderingContext2D;
  ctx.quality = "good";
  const layer = createCanvas(W, H);
  const layerCtx = layer.getContext("2d") as CanvasRenderingContext2D;
  const pixels: ImageData = layerCtx.createImageData(W, H);
  const frameSize = W * H * 4;

  const queues = edl.video.map((track) => ({ id: track.id, clips: sortedClips(track.clips) }));
  const active = new Map<string, ActiveClip>();
  const logs: ClipLog[] = [];

  const start = (track: string, clip: VideoClip): ActiveClip => {
    const child = spawn(ffmpegBin(), decoderArgs(edl, clip, baseDir), { stdio: ["ignore", "pipe", "pipe"] });
    const log: ClipLog = { id: clip.id, track, frames: clipFrames(clip, fps), held: 0 };
    logs.push(log);
    return {
      clip,
      track,
      end: clipEnd(clip, fps),
      process: child,
      reader: new FrameReader(child.stdout as NonNullable<typeof child.stdout>, frameSize),
      done: waitFor(child, `décodeur ${clip.id}`),
      last: null,
      log,
      stopped: false,
    };
  };

  const stop = async (a: ActiveClip) => {
    // The decoder is asked for half a frame of margin: stopping it early is normal.
    if (a.process.exitCode === null) {
      a.stopped = true;
      a.process.kill("SIGTERM");
    }
    await a.done.catch((e: Error) => {
      if (!a.stopped) warnings.push(e.message);
    });
  };

  try {
    for (let f = 0; f < total; f++) {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, W, H);
      for (const q of queues) {
        let a = active.get(q.id);
        if (a && f >= a.end) {
          await stop(a);
          active.delete(q.id);
          a = undefined;
        }
        if (!a && q.clips[0] && q.clips[0].at <= f) {
          a = start(q.id, q.clips.shift() as VideoClip);
          active.set(q.id, a);
        }
        if (!a) continue;
        let frame = await a.reader.next();
        if (frame === null) {
          frame = a.last;
          a.log.held++;
        }
        if (frame === null) continue;
        a.last = frame;
        pixels.data.set(frame);
        layerCtx.putImageData(pixels, 0, 0);
        ctx.drawImage(layer, 0, 0);
      }
      await write(stdin, out.toBuffer("raw"));
      if (onProgress && f % fps === 0) onProgress(f, total);
    }
  } finally {
    for (const a of active.values()) await stop(a);
    stdin.end();
  }
  await encoded;

  const elapsedMs = performance.now() - started;
  const heldFrames = logs.reduce((n, l) => n + l.held, 0);
  if (heldFrames > 0) warnings.push(`${heldFrames} frame(s) répétée(s) faute d'images source`);
  return {
    frames: total,
    clips: logs,
    heldFrames,
    elapsedMs,
    renderFps: total / (elapsedMs / 1000),
    warnings,
  };
}
