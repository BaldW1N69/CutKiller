import { easeProgress } from "./ease";
import type { Edl, KeyframeTrack } from "./edl";
import { framesToSeconds } from "./time";

export type AnimatedProperty = "x" | "y" | "scale" | "opacity" | "rotation";

/** A clip's animated state on top of its static framing. */
export interface AnimState {
  scale: number;
  x: number;
  y: number;
  opacity: number;
  rotation: number;
}

export const REST_STATE: Readonly<AnimState> = { scale: 1, x: 0, y: 0, opacity: 1, rotation: 0 };

export const trackClip = (track: KeyframeTrack) => track.target.slice(0, track.target.lastIndexOf("."));
export const trackProperty = (track: KeyframeTrack) =>
  track.target.slice(track.target.lastIndexOf(".") + 1) as AnimatedProperty;

/** Value of a keyframe track at a (fractional) timeline frame. */
export function trackValue(track: KeyframeTrack, frame: number, fps: number): number {
  const keys = track.keys;
  const first = keys[0];
  const last = keys.at(-1);
  if (!first || !last) return Number.NaN;
  if (frame <= first.frame) return first.value;
  if (frame >= last.frame) return last.value;
  for (let i = 1; i < keys.length; i++) {
    const b = keys[i] as (typeof keys)[number];
    if (frame > b.frame) continue;
    const a = keys[i - 1] as (typeof keys)[number];
    const span = b.frame - a.frame;
    const p = (frame - a.frame) / span;
    if (b.ease === "hold") return frame < b.frame ? a.value : b.value;
    return a.value + (b.value - a.value) * easeProgress(b.ease, p, framesToSeconds(span, fps));
  }
  return last.value;
}

/** Keyframe tracks grouped by clip id, for per-frame evaluation. */
export type AnimationIndex = Map<string, KeyframeTrack[]>;

export function animationIndex(edl: Edl): AnimationIndex {
  const index: AnimationIndex = new Map();
  for (const track of edl.keyframes) {
    const id = trackClip(track);
    index.set(id, [...(index.get(id) ?? []), track]);
  }
  return index;
}

export function animStateAt(index: AnimationIndex, clipId: string, frame: number, fps: number): AnimState {
  const state: AnimState = { ...REST_STATE };
  for (const track of index.get(clipId) ?? []) state[trackProperty(track)] = trackValue(track, frame, fps);
  return state;
}

/** Largest `scale` a clip reaches over its animation (≥ 1): the decoder renders that much margin. */
export function maxAnimatedScale(index: AnimationIndex, clipId: string, fps: number): number {
  let max = 1;
  for (const track of index.get(clipId) ?? []) {
    if (trackProperty(track) !== "scale") continue;
    const first = track.keys[0]?.frame ?? 0;
    const last = track.keys.at(-1)?.frame ?? 0;
    for (let f = first; f <= last; f += 0.25) max = Math.max(max, trackValue(track, f, fps));
  }
  return max;
}

/**
 * Corners of a full-frame layer (W×H) once transformed: scaled and rotated about
 * the frame centre, then moved by (x·W, y·H). Used to measure on-screen speed.
 */
export function layerCorners(W: number, H: number, s: AnimState): [number, number][] {
  const cos = Math.cos((s.rotation * Math.PI) / 180);
  const sin = Math.sin((s.rotation * Math.PI) / 180);
  const cx = W / 2 + s.x * W;
  const cy = H / 2 + s.y * H;
  return [
    [-W / 2, -H / 2],
    [W / 2, -H / 2],
    [W / 2, H / 2],
    [-W / 2, H / 2],
  ].map(([px, py]) => [
    cx + s.scale * ((px as number) * cos - (py as number) * sin),
    cy + s.scale * ((px as number) * sin + (py as number) * cos),
  ]);
}

/** Largest corner displacement between two states, in pixels. */
export function displacement(W: number, H: number, a: AnimState, b: AnimState): number {
  const ca = layerCorners(W, H, a);
  const cb = layerCorners(W, H, b);
  return Math.max(
    ...ca.map(([x, y], i) =>
      Math.hypot(x - (cb[i] as [number, number])[0], y - (cb[i] as [number, number])[1]),
    ),
  );
}
