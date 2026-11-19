import { Easing, interpolate } from "remotion";
import type { Accent } from "./types";

/** Decaying pulse (0..1) from the most recent accents: 1 on the hit, eased to 0 after `decay` frames. */
export const pulse = (frame: number, accents: Accent[], decay: number, onlyDownbeats = false): number => {
  let v = 0;
  for (let i = accents.length - 1; i >= 0; i--) {
    const a = accents[i];
    if (a.frame > frame) continue;
    if (frame - a.frame > decay) break;
    if (onlyDownbeats && !a.downbeat) continue;
    const t = (frame - a.frame) / decay;
    v = Math.max(v, a.strength * (1 - t) * (1 - t));
  }
  return v;
};

/** 0..1 progress of an animation that lasts `beats` beats starting at `start`. */
export const beatProgress = (
  frame: number,
  start: number,
  beats: number,
  beatFrames: number,
  easing: (t: number) => number = Easing.bezier(0.16, 1, 0.3, 1),
): number =>
  interpolate(frame, [start, start + Math.max(1, beats * beatFrames)], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing,
  });
