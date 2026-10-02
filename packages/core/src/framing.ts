import { keysValue } from "./animation";
import type { Edl, VideoClip } from "./edl";

/**
 * Geometry of a moving (reframed) crop: the band of the source the decoder keeps
 * (every crop position the clip will use), and the shift that brings the crop
 * centre of a given frame to the middle of the picture. Shared by the decoder
 * (band), the compositor and the motion analysis (shift), and the QA (crop path).
 */
export interface Framing {
  axis: "x" | "y";
  /** Source pixels decoded: the union of every crop of the clip. */
  band: { x: number; y: number; w: number; h: number };
  /** Output pixels per source pixel, at the static framing (transform.scale) and no animation. */
  outPerSrc: number;
  /** Crop centre along the axis at a timeline frame, in source pixels (clamped inside the source). */
  centreAt(frame: number): number;
  /** Shift (output pixels, before animation scale) that puts the crop centre of `frame` mid-picture. */
  shiftAt(frame: number): [number, number];
}

export function clipFraming(edl: Edl, clip: VideoClip): Framing | undefined {
  const reframe = clip.reframe;
  const source = edl.sources[clip.source];
  if (!reframe || !source?.width || !source.height) return undefined;
  const { width: W, height: H, fps } = edl.output;
  const sw = source.width;
  const sh = source.height;
  const s = clip.transform.scale;
  // Crop of the static framing ("cover"), then narrowed by the static punch-in;
  // whole source pixels across the axis, so the decoder crops exactly this.
  const exactH = Math.min(sh, (sw * H) / W) / s;
  const exactW = (exactH * W) / H;
  const ch = reframe.axis === "x" ? Math.round(exactH) : exactH;
  const cw = reframe.axis === "y" ? Math.round(exactW) : exactW;
  const outPerSrc = reframe.axis === "x" ? H / ch : W / cw;
  const along = reframe.axis === "x" ? sw : sh;
  const size = reframe.axis === "x" ? cw : ch;
  const clamp = (c: number) => Math.min(along - size / 2, Math.max(size / 2, c));
  const centreAt = (frame: number) => clamp(keysValue(reframe.keys, frame, fps) * along);
  // The band covers every crop position the keys reach (eased curves stay between keys, overshoot aside).
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  const first = reframe.keys[0]?.frame ?? clip.at;
  const last = reframe.keys.at(-1)?.frame ?? clip.at;
  for (let f = first; f <= last; f += 0.5) {
    const c = centreAt(f);
    lo = Math.min(lo, c);
    hi = Math.max(hi, c);
  }
  const a0 = Math.max(0, Math.floor(lo - size / 2));
  const a1 = Math.min(along, Math.ceil(hi + size / 2));
  const band =
    reframe.axis === "x"
      ? { x: a0, y: Math.round((sh - ch) / 2), w: a1 - a0, h: ch }
      : { x: Math.round((sw - cw) / 2), y: a0, w: cw, h: a1 - a0 };
  const mid = (a0 + a1) / 2;
  return {
    axis: reframe.axis,
    band,
    outPerSrc,
    centreAt,
    shiftAt(frame) {
      const d = (mid - centreAt(frame)) * outPerSrc;
      return reframe.axis === "x" ? [d, 0] : [0, d];
    },
  };
}
