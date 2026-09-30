import type { Edl, VideoClip } from "./edl";
import { framesToSeconds, secondsToFrames } from "./time";

/** Output frames covered by a clip: source duration quantized to whole frames. */
export function clipFrames(clip: { in: number; out: number }, fps: number): number {
  return secondsToFrames(clip.out - clip.in, fps);
}

export function clipEnd(clip: { in: number; out: number; at: number }, fps: number): number {
  return clip.at + clipFrames(clip, fps);
}

/**
 * Effective source out point: the renderer consumes exactly `clipFrames` frames,
 * so audio must stop at the same quantized point or A/V drifts by up to half a
 * frame per cut.
 */
export function effectiveOut(clip: { in: number; out: number }, fps: number): number {
  return clip.in + framesToSeconds(clipFrames(clip, fps), fps);
}

export function sortedClips<T extends { at: number }>(clips: readonly T[]): T[] {
  return [...clips].sort((a, b) => a.at - b.at);
}

export function edlDurationFrames(edl: Edl): number {
  const fps = edl.output.fps;
  let end = 0;
  for (const track of edl.video) for (const c of track.clips) end = Math.max(end, clipEnd(c, fps));
  return end;
}

export interface AudioSpan {
  clip: VideoClip;
  /** Timeline frames [start, end). */
  startFrame: number;
  endFrame: number;
  /** Source seconds matching the timeline span. */
  sourceIn: number;
  sourceOut: number;
  /** True when an edit point (not the timeline start/end) bounds the span. */
  cutAtStart: boolean;
  cutAtEnd: boolean;
}

/**
 * Audio spans of the main track once J/L splits are applied. The audio edit point
 * between clip i-1 and clip i sits at `clip_i.at + clip_i.audioSplitFrames`.
 */
export function mainAudioSpans(edl: Edl): AudioSpan[] {
  const fps = edl.output.fps;
  const clips = sortedClips(edl.video[0]?.clips ?? []);
  return clips.map((clip, i) => {
    const prev = clips[i - 1];
    const next = clips[i + 1];
    const contiguousPrev = prev !== undefined && clipEnd(prev, fps) === clip.at;
    const contiguousNext = next !== undefined && clipEnd(clip, fps) === next.at;
    const headSplit = contiguousPrev ? clip.audioSplitFrames : 0;
    const tailSplit = contiguousNext ? next.audioSplitFrames : 0;
    const end = clipEnd(clip, fps);
    return {
      clip,
      startFrame: clip.at + headSplit,
      endFrame: end + tailSplit,
      sourceIn: clip.in + framesToSeconds(headSplit, fps),
      sourceOut: effectiveOut(clip, fps) + framesToSeconds(tailSplit, fps),
      cutAtStart: contiguousPrev,
      cutAtEnd: contiguousNext,
    };
  });
}
