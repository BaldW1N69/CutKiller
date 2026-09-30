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
