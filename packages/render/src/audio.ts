import { resolve } from "node:path";
import { type Edl, edlDurationFrames, framesToSeconds, mainAudioSpans } from "@cutkiller/core";
import { ffmpeg } from "@cutkiller/media";

interface Segment {
  path: string;
  sourceIn: number;
  sourceOut: number;
  startSeconds: number;
  gainDb: number;
  fadeInS: number;
  fadeOutS: number;
}

/** Seek this far before the in point, then trim precisely in the filter graph. */
const SEEK_PREROLL_S = 1;

export function audioSegments(edl: Edl, baseDir: string): Segment[] {
  const fps = edl.output.fps;
  const cutFade = edl.output.audio.cutFadeMs / 1000;
  const segments: Segment[] = [];
  for (const span of mainAudioSpans(edl)) {
    const source = edl.sources[span.clip.source];
    if (!source || source.hasAudio === false || source.still) continue;
    segments.push({
      path: resolve(baseDir, source.path),
      sourceIn: span.sourceIn,
      sourceOut: span.sourceOut,
      startSeconds: framesToSeconds(span.startFrame, fps),
      gainDb: span.clip.gainDb,
      fadeInS: span.cutAtStart ? cutFade : 0,
      fadeOutS: span.cutAtEnd ? cutFade : 0,
    });
  }
  for (const track of edl.audio) {
    for (const clip of track.clips) {
      const source = edl.sources[clip.source];
      if (!source) continue;
      segments.push({
        path: resolve(baseDir, source.path),
        sourceIn: clip.in,
        sourceOut: clip.out,
        startSeconds: framesToSeconds(clip.at, fps),
        gainDb: clip.gainDb,
        fadeInS: Math.max(clip.fadeInMs / 1000, cutFade),
        fadeOutS: Math.max(clip.fadeOutMs / 1000, cutFade),
      });
    }
  }
  return segments;
}

/** ffmpeg arguments that render the whole audio timeline to a float WAV of exact length. */
export function audioMixArgs(edl: Edl, baseDir: string, outPath: string): string[] {
  const rate = edl.output.audio.sampleRate;
  const totalSamples = Math.round(framesToSeconds(edlDurationFrames(edl), edl.output.fps) * rate);
  const segments = audioSegments(edl, baseDir);
  const args: string[] = [];
  const filters: string[] = [];
  const labels: string[] = [];

  segments.forEach((seg, i) => {
    const seek = Math.max(0, seg.sourceIn - SEEK_PREROLL_S);
    args.push("-ss", seek.toFixed(6), "-i", seg.path);
    const len = seg.sourceOut - seg.sourceIn;
    const chain = [
      `atrim=start=${(seg.sourceIn - seek).toFixed(6)}:duration=${len.toFixed(6)}`,
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

export async function renderAudio(edl: Edl, baseDir: string, outPath: string): Promise<void> {
  await ffmpeg(audioMixArgs(edl, baseDir, outPath));
}
