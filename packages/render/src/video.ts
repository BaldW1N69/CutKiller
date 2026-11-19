import { type ChildProcess, spawn } from "node:child_process";
import { resolve } from "node:path";
import { CaptionTimeline } from "@cutkiller/captions";
import { gradeKey } from "@cutkiller/color";
import {
  clipEnd,
  clipFrames,
  clipFraming,
  clipUpscale,
  type Edl,
  edlDurationFrames,
  framesToSeconds,
  maxAnimatedScale,
  type VideoClip,
} from "@cutkiller/core";
import { ffmpegBin, waitFor } from "@cutkiller/media";
import { applyGlitch, type LayerPlan, MotionTimeline, resolveTransitions } from "@cutkiller/motion";
import type { PresetRegistry } from "@cutkiller/style";
import { type Canvas, type CanvasRenderingContext2D, createCanvas, type ImageData } from "canvas";
import { FrameReader } from "./frames";
import { hashString, TexturePainter } from "./texture";

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
  k = 1,
  looks: ReadonlyMap<string, string> = new Map(),
  /** Extra frames decoded before the in point and after the out point (dissolve handles). */
  pad: { head: number; tail: number } = { head: 0, tail: 0 },
): { input: string[]; vf: string; duration: number; width: number; height: number } {
  const { width: outW, height: outH, fps } = edl.output;
  // Decoded k× larger than the output when the clip zooms in later, so the punch-in stays sharp.
  let W = Math.round((outW * k) / 2) * 2;
  let H = Math.round((outH * k) / 2) * 2;
  const source = edl.sources[clip.source];
  if (!source) throw new Error(`source inconnue ${clip.source}`);
  const path = resolve(baseDir, source.path);
  const frames = clipFrames(clip, fps) + pad.head + pad.tail;
  const start = Math.max(0, clip.in - pad.head / fps);
  // Crop before scaling: resampling only the kept area is several times cheaper.
  const { scale, x, y } = clip.transform;
  const cw = `min(iw,ih*${outW}/${outH})`;
  const ch = `min(ih,iw*${outH}/${outW})`;
  const framing = clip.fit === "cover" ? clipFraming(edl, clip) : undefined;
  // Grade on whichever is smaller, the source crop or the output: same result, fewer pixels.
  const filters = gradeFilters(clip, looks);
  let graded = false;
  const grade = (cropPixels: number) => {
    if (filters.length === 0 || cropPixels > W * H) return "";
    graded = true;
    return `,${filters.join(",")}`;
  };
  // Enlarged pictures are sharpened after the resize (contrast-adaptive, stronger
  // the more the source is enlarged); a downscale is never sharpened.
  const up = (clipUpscale(edl, clip) ?? 1) * k;
  const sharpen = up > 1.15 ? `,cas=${Math.min(0.7, 0.25 + 0.35 * (up - 1)).toFixed(2)}` : "";
  let fit: string;
  if (framing) {
    // Moving framing: the whole band the crop travels over, panned by the compositor.
    const { band, outPerSrc, axis } = framing;
    if (axis === "x") W = Math.max(2, Math.round((band.w * outPerSrc * k) / 2) * 2);
    else H = Math.max(2, Math.round((band.h * outPerSrc * k) / 2) * 2);
    fit = `crop=${band.w}:${band.h}:${band.x}:${band.y}${grade(band.w * band.h)},scale=${W}:${H}:flags=lanczos${sharpen}`;
  } else if (clip.fit === "contain")
    fit = `scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos${sharpen},pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black`;
  else {
    const cropArea =
      source.width && source.height
        ? Math.min(
            source.width * source.width * (outH / outW),
            source.height * source.height * (outW / outH),
            source.width * source.height,
          ) /
          scale ** 2
        : W * H;
    fit = `crop=w='${cw}/${scale}':h='${ch}/${scale}':x='clip(iw/2+${x}*${cw}-ow/2,0,iw-ow)':y='clip(ih/2+${y}*${ch}-oh/2,0,ih-oh)'${grade(cropArea)},scale=${W}:${H}:flags=lanczos${sharpen}`;
  }
  return {
    input: source.still ? ["-loop", "1", "-i", path] : ["-ss", start.toFixed(6), "-i", path],
    // start_time=0: output time 0 is the seek point; if the video stream starts
    // later than that (offset streams), its first frame is held, never shifted.
    vf: [`fps=${fps}:start_time=0:round=near`, fit, ...(graded ? [] : filters)].join(","),
    duration: framesToSeconds(frames, fps) + 0.5 / fps,
    width: W,
    height: H,
  };
}

/** Grading filter of a clip: its exposure, balance and look, baked into one LUT (`grades` by gradeKey). */
export function gradeFilters(clip: VideoClip, grades: ReadonlyMap<string, string>): string[] {
  const lut = clip.color ? grades.get(gradeKey(clip.color)) : undefined;
  return lut ? [`lut3d=file='${lut}':interp=tetrahedral`] : [];
}

export function decoderArgs(
  edl: Edl,
  clip: VideoClip,
  baseDir: string,
  k = 1,
  looks: ReadonlyMap<string, string> = new Map(),
  pad: { head: number; tail: number } = { head: 0, tail: 0 },
): string[] {
  const { input, vf, duration } = decoderChain(edl, clip, baseDir, k, looks, pad);
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
    // FFmpeg's AAC encoder, left at its own bandwidth, can overshoot by several dB
    // on dense mixes (measured: −1.8 dBTP in, +0.8 out); 18 kHz keeps it under 0.5.
    "-cutoff",
    "18000",
    "-ar",
    String(audio.sampleRate),
    "-movflags",
    "+faststart",
    "-y",
    outPath,
  ];
}

interface Decoded {
  clip: VideoClip;
  k: number;
  width: number;
  height: number;
  canvas: Canvas;
  ctx: CanvasRenderingContext2D;
  pixels: ImageData;
  process: ChildProcess;
  reader: FrameReader;
  done: Promise<void>;
  /** Frames of the clip already decoded into `canvas`. */
  read: number;
  /** Count of the source pictures put into `canvas` (a held frame does not count): seeds the grain. */
  shown: number;
  /** Handle frames decoded before the clip's first frame. */
  head: number;
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

export interface MotionLog {
  /** [frame, speed in px/frame, motion-blur samples (1 = none)] for frames that move. */
  frames: [number, number, number][];
  blurredFrames: number;
  glitchFrames: number;
  /** Frames with a caption on screen. */
  captionFrames: number;
}

/** Sample times (fractional frames) spread over the shutter, centred on the frame. */
export function shutterSamples(f: number, n: number, shutterAngle: number): number[] {
  const open = shutterAngle / 360;
  return Array.from({ length: n }, (_, i) => f - open / 2 + (open * (i + 0.5)) / n);
}

/**
 * Frame loop: each visible clip is decoded by its own FFmpeg process (seek + fps
 * conform + static framing), animated and composited on a Cairo canvas, then piped
 * to one encoder. Layers, their pictures and their motion come from the
 * MotionTimeline; frames moving faster than the threshold are the average of
 * shutter sub-samples (motion blur).
 */
export async function renderVideo(
  edl: Edl,
  baseDir: string,
  audioPath: string,
  outPath: string,
  registry: PresetRegistry,
  onProgress?: (frame: number, total: number) => void,
  /** Look LUT files (`.cube`) by preset reference. */
  looks: ReadonlyMap<string, string> = new Map(),
): Promise<VideoLog & { motion: MotionLog }> {
  const { width: W, height: H, fps, motionBlur } = edl.output;
  const total = edlDurationFrames(edl);
  const started = performance.now();
  const warnings: string[] = [];
  const timeline = new MotionTimeline(edl, resolveTransitions(edl, registry));
  const captions = new CaptionTimeline(edl, registry);

  const encoder = spawn(ffmpegBin(), encoderArgs(edl, audioPath, outPath), {
    stdio: ["pipe", "ignore", "pipe"],
  });
  const encoded = waitFor(encoder, "encodeur");
  const stdin = encoder.stdin;
  if (!stdin) throw new Error("encodeur sans stdin");

  const out = createCanvas(W, H);
  const ctx = out.getContext("2d") as CanvasRenderingContext2D;
  ctx.quality = "good";
  const sum = new Uint32Array(W * H * 4);
  const glitched = ctx.createImageData(W, H);

  const texture = edl.output.texture ? new TexturePainter(edl.output.texture, W, H) : undefined;
  const decoders = new Map<string, Decoded>();
  const logs: ClipLog[] = [];
  const motion: MotionLog = { frames: [], blurredFrames: 0, glitchFrames: 0, captionFrames: 0 };

  const open = (clip: VideoClip): Decoded => {
    const existing = decoders.get(clip.id);
    if (existing) return existing;
    const k = Math.min(1.5, maxAnimatedScale(timeline.index, clip.id, fps));
    const pad = timeline.handles(clip);
    const { width, height } = decoderChain(edl, clip, baseDir, k, looks, pad);
    const child = spawn(ffmpegBin(), decoderArgs(edl, clip, baseDir, k, looks, pad), {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const canvas = createCanvas(width, height);
    const cctx = canvas.getContext("2d") as CanvasRenderingContext2D;
    const log: ClipLog = {
      id: clip.id,
      track: "",
      frames: clipFrames(clip, fps) + pad.head + pad.tail,
      held: 0,
    };
    logs.push(log);
    const d: Decoded = {
      clip,
      k,
      width,
      height,
      canvas,
      ctx: cctx,
      pixels: cctx.createImageData(width, height),
      process: child,
      reader: new FrameReader(child.stdout as NonNullable<typeof child.stdout>, width * height * 4),
      done: waitFor(child, `décodeur ${clip.id}`),
      read: 0,
      shown: 0,
      head: pad.head,
      log,
      stopped: false,
    };
    decoders.set(clip.id, d);
    return d;
  };

  /** Decodes until the clip's local frame `index` is in its canvas (holding the last picture if the source runs out). */
  const advance = async (d: Decoded, index: number) => {
    while (d.read <= index) {
      const frame = await d.reader.next();
      d.read++;
      if (frame === null) {
        d.log.held++;
        continue;
      }
      if (d.read <= index) continue; // skipped picture: only the latest one is drawn
      d.pixels.data.set(frame);
      d.ctx.putImageData(d.pixels, 0, 0);
      d.shown++;
    }
  };

  const close = async (d: Decoded) => {
    if (d.process.exitCode === null) {
      d.stopped = true;
      d.process.kill("SIGTERM");
    }
    await d.done.catch((e: Error) => {
      if (!d.stopped) warnings.push(e.message);
    });
    decoders.delete(d.clip.id);
  };

  /** Pictures of frame f at time t, captions on top unless they are drawn later (over a glitch). */
  const draw = (
    target: CanvasRenderingContext2D,
    layers: LayerPlan[],
    f: number,
    t: number,
    withCaptions: boolean,
  ) => {
    target.setTransform(1, 0, 0, 1, 0, 0);
    target.globalAlpha = 1;
    target.fillStyle = "#000";
    target.fillRect(0, 0, W, H);
    for (const layer of layers) {
      const d = decoders.get(layer.clip.id);
      if (!d) continue;
      const s = layer.state(t);
      target.setTransform(1, 0, 0, 1, 0, 0);
      target.globalAlpha = Math.min(1, Math.max(0, s.opacity));
      target.translate(W / 2 + s.x * W, H / 2 + s.y * H);
      if (s.rotation !== 0) target.rotate((s.rotation * Math.PI) / 180);
      const scale = s.scale / d.k;
      target.scale(scale, scale);
      target.drawImage(d.canvas, -d.width / 2, -d.height / 2);
    }
    target.setTransform(1, 0, 0, 1, 0, 0);
    target.globalAlpha = 1;
    if (texture?.active) {
      // Same pictures, same grain: a frame held by the decoder still reads as a repeat.
      let seed = 0;
      for (const layer of layers) {
        const d = decoders.get(layer.clip.id);
        if (d) seed = Math.imul(seed ^ hashString(layer.clip.id), 31) + d.shown;
      }
      texture.paint(target, seed);
    }
    if (withCaptions) captions.draw(target, f, t);
  };

  try {
    for (let f = 0; f < total; f++) {
      const layers = timeline.layersAt(f);
      for (const layer of layers) {
        const d = open(layer.clip);
        if (layer.image === "live") await advance(d, f - layer.clip.at + d.head);
        else if (layer.image === "first") await advance(d, d.head);
      }
      // Clips no longer on screen and past their end will not come back.
      for (const d of [...decoders.values()])
        if (f >= clipEnd(d.clip, fps) && !layers.some((l) => l.clip.id === d.clip.id)) await close(d);

      const v = Math.max(timeline.velocityAt(f), captions.velocityAt(f));
      const glitch = timeline.glitchAt(f);
      // A glitch distorts the pictures, never the captions: they go on top afterwards.
      const captionsInDraw = !glitch;
      let samples = 1;
      if (v > motionBlur.thresholdPxPerFrame && motionBlur.shutterAngle > 0)
        samples = Math.min(
          motionBlur.maxSamples,
          Math.max(2, Math.ceil((v * motionBlur.shutterAngle) / 360 / motionBlur.stepPx)),
        );
      let frame: Buffer;
      const caption = captions.at(f);
      if (
        samples > 1 &&
        caption &&
        captionsInDraw &&
        timeline.velocityAt(f) <= motionBlur.thresholdPxPerFrame
      ) {
        // Only the caption moves (its entry): average its area alone over the pictures drawn once.
        draw(ctx, layers, f, f, false);
        const r = captions.extent(caption, W, H);
        const base = ctx.getImageData(r.x, r.y, r.w, r.h);
        const acc = new Uint32Array(r.w * r.h * 4);
        for (const t of shutterSamples(f, samples, motionBlur.shutterAngle)) {
          ctx.putImageData(base, r.x, r.y);
          captions.draw(ctx, f, t);
          const px = ctx.getImageData(r.x, r.y, r.w, r.h).data;
          for (let i = 0; i < px.length; i++) acc[i] = (acc[i] as number) + (px[i] as number);
        }
        const avg = ctx.createImageData(r.w, r.h);
        for (let i = 0; i < acc.length; i++) avg.data[i] = Math.round((acc[i] as number) / samples);
        ctx.putImageData(avg, r.x, r.y);
        frame = out.toBuffer("raw");
        motion.blurredFrames++;
      } else if (samples === 1) {
        draw(ctx, layers, f, f, captionsInDraw);
        frame = out.toBuffer("raw");
      } else {
        // Exact average of the sub-frame samples, accumulated in 32 bits.
        sum.fill(0);
        for (const t of shutterSamples(f, samples, motionBlur.shutterAngle)) {
          draw(ctx, layers, f, t, captionsInDraw);
          const px = out.toBuffer("raw");
          for (let i = 0; i < px.length; i++) sum[i] = (sum[i] as number) + (px[i] as number);
        }
        frame = Buffer.allocUnsafe(sum.length);
        for (let i = 0; i < sum.length; i++) frame[i] = Math.round((sum[i] as number) / samples);
        motion.blurredFrames++;
      }
      if (v > 0.5) motion.frames.push([f, Math.round(v * 10) / 10, samples]);
      if (glitch) {
        applyGlitch(frame, W, H, glitch.intensity, glitch.seed);
        motion.glitchFrames++;
        if (caption) {
          // Raw canvas pixels are BGRA (opaque here), ImageData is RGBA.
          const rgba = glitched.data;
          for (let i = 0; i < frame.length; i += 4) {
            rgba[i] = frame[i + 2] as number;
            rgba[i + 1] = frame[i + 1] as number;
            rgba[i + 2] = frame[i] as number;
            rgba[i + 3] = 255;
          }
          ctx.putImageData(glitched, 0, 0);
          captions.draw(ctx, f);
          frame = out.toBuffer("raw");
        }
      }
      if (caption) motion.captionFrames++;
      await write(stdin, frame);
      if (onProgress && f % fps === 0) onProgress(f, total);
    }
  } finally {
    for (const d of [...decoders.values()]) await close(d);
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
    motion,
  };
}
