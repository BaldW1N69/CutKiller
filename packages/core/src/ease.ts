import { z } from "zod";

/** Named easing curves, mapped to cubic-bezier control points (CSS conventions). */
export const NAMED_EASES = {
  linear: [0, 0, 1, 1],
  ease: [0.25, 0.1, 0.25, 1],
  "ease-in": [0.42, 0, 1, 1],
  "ease-out": [0, 0, 0.58, 1],
  "ease-in-out": [0.42, 0, 0.58, 1],
  "ease-out-cubic": [0.33, 1, 0.68, 1],
  "ease-in-cubic": [0.32, 0, 0.67, 0],
  "ease-out-expo": [0.16, 1, 0.3, 1],
  "ease-in-expo": [0.7, 0, 0.84, 0],
  "ease-in-out-cubic": [0.65, 0, 0.35, 1],
  "ease-in-out-expo": [0.87, 0, 0.13, 1],
  "ease-out-back": [0.34, 1.56, 0.64, 1],
} as const satisfies Record<string, readonly [number, number, number, number]>;

export type NamedEase = keyof typeof NAMED_EASES;

export const SpringSchema = z.object({
  stiffness: z.number().positive(),
  damping: z.number().positive(),
  mass: z.number().positive().default(1),
});

export const EaseSchema = z.union([
  z.enum(Object.keys(NAMED_EASES) as [NamedEase, ...NamedEase[]]),
  z.literal("hold"),
  z.object({
    cubicBezier: z.tuple([z.number().min(0).max(1), z.number(), z.number().min(0).max(1), z.number()]),
  }),
  z.object({ spring: SpringSchema }),
]);

export type Ease = z.infer<typeof EaseSchema>;

const EPS = 1e-6;

/**
 * A curve is linear when both control points sit on the diagonal: then
 * cubic-bezier(x1,y1,x2,y2) degenerates to y = x whatever the handles' length.
 */
export function isLinearEase(ease: Ease | undefined): boolean {
  if (ease === undefined) return true; // the interpolation default is linear
  if (ease === "hold") return false;
  if (typeof ease === "string") return isLinearBezier(NAMED_EASES[ease]);
  if ("cubicBezier" in ease) return isLinearBezier(ease.cubicBezier);
  return false;
}

function isLinearBezier([x1, y1, x2, y2]: readonly [number, number, number, number]): boolean {
  return Math.abs(x1 - y1) < EPS && Math.abs(x2 - y2) < EPS;
}

type Bezier = readonly [number, number, number, number];

/** y of a CSS cubic-bezier at progress x ∈ [0, 1] (Newton-Raphson, bisection fallback). */
export function cubicBezierAt([x1, y1, x2, y2]: Bezier, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const slopeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  let t = x;
  for (let i = 0; i < 8; i++) {
    const err = sampleX(t) - x;
    if (Math.abs(err) < 1e-7) return ((ay * t + by) * t + cy) * t;
    const d = slopeX(t);
    if (Math.abs(d) < 1e-6) break;
    t -= err / d;
  }
  let lo = 0;
  let hi = 1;
  t = x;
  for (let i = 0; i < 40; i++) {
    const v = sampleX(t);
    if (Math.abs(v - x) < 1e-7) break;
    if (v < x) lo = t;
    else hi = t;
    t = (lo + hi) / 2;
  }
  return ((ay * t + by) * t + cy) * t;
}

export type Spring = z.infer<typeof SpringSchema>;

/**
 * Normalised step response of a damped spring (0 → 1) after `t` seconds.
 * Under-damped springs overshoot by exp(-ζπ/√(1-ζ²)).
 */
export function springAt({ stiffness, damping, mass }: Spring, t: number): number {
  if (t <= 0) return 0;
  const w0 = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    return 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
  }
  if (zeta === 1) return 1 - Math.exp(-w0 * t) * (1 + w0 * t);
  const r1 = -w0 * (zeta - Math.sqrt(zeta * zeta - 1));
  const r2 = -w0 * (zeta + Math.sqrt(zeta * zeta - 1));
  return 1 - (r2 * Math.exp(r1 * t) - r1 * Math.exp(r2 * t)) / (r2 - r1);
}

/** Theoretical overshoot of a spring, as a fraction of the move (0 when not under-damped). */
export function springOvershoot({ stiffness, damping, mass }: Spring): number {
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  return zeta >= 1 ? 0 : Math.exp((-zeta * Math.PI) / Math.sqrt(1 - zeta * zeta));
}

/**
 * Progress (0 → 1, may exceed 1 on overshoot) of an eased segment at normalised
 * time p ∈ [0, 1]. Springs run in real time over `durationS` and land exactly on 1
 * at the end of the segment.
 */
export function easeProgress(ease: Ease | undefined, p: number, durationS: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  if (ease === undefined) return p;
  if (ease === "hold") return 0;
  if (typeof ease === "string") return cubicBezierAt(NAMED_EASES[ease], p);
  if ("cubicBezier" in ease) return cubicBezierAt(ease.cubicBezier, p);
  return springAt(ease.spring, p * durationS);
}

/** Largest excursion past the target, as a fraction of the move, sampled over the segment. */
export function easeOvershoot(ease: Ease | undefined, durationS: number, samples = 200): number {
  let max = 1;
  for (let i = 1; i < samples; i++) max = Math.max(max, easeProgress(ease, i / samples, durationS));
  return max - 1;
}

/**
 * Entry curves decelerate (ease-out: fast start, slow landing); exit curves
 * accelerate (ease-in). Compared on the first and last tenth of the segment.
 */
export function easeShape(
  ease: Ease | undefined,
  durationS: number,
): "decelerating" | "accelerating" | "symmetric" {
  const head = easeProgress(ease, 0.1, durationS);
  const tail = 1 - easeProgress(ease, 0.9, durationS);
  if (head > tail * 1.5) return "decelerating";
  if (tail > head * 1.5) return "accelerating";
  return "symmetric";
}
