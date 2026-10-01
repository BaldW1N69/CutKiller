import { type Ease, EaseSchema, type Edl, type Transition } from "@cutkiller/core";
import type { Preset, PresetRegistry } from "@cutkiller/style";
import { z } from "zod";

export const MotionParamsSchema = z.object({
  property: z.enum(["x", "y", "scale", "opacity", "rotation"]),
  role: z.enum(["entry", "exit", "micro", "move"]),
  durationMs: z.number().positive(),
  ease: EaseSchema,
  from: z.number().optional(),
  to: z.number().optional(),
});

const Direction = z.enum(["left", "right", "up", "down"]);

export const TransitionParamsSchema = z.discriminatedUnion("type", [
  /** Outgoing and incoming pictures move together (whip pan). */
  z.object({
    type: z.literal("push"),
    durationMs: z.number().positive(),
    direction: Direction,
    ease: EaseSchema,
  }),
  /** Incoming picture slides over the outgoing one. */
  z.object({
    type: z.literal("slide"),
    durationMs: z.number().positive(),
    direction: Direction,
    ease: EaseSchema,
  }),
  /** RGB split and displaced bands around the cut. */
  z.object({
    type: z.literal("glitch"),
    durationMs: z.number().positive(),
    intensity: z.number().min(0).max(2),
    seed: z.number().int(),
  }),
]);

export type MotionParams = z.infer<typeof MotionParamsSchema>;
export type TransitionParams = z.infer<typeof TransitionParamsSchema>;

export function motionParams(preset: Preset): MotionParams {
  if (preset.kind !== "motion")
    throw new Error(`${preset.name}@${preset.version} n'est pas un preset de mouvement`);
  return MotionParamsSchema.parse(preset.params);
}

export function transitionParams(preset: Preset): TransitionParams {
  if (preset.kind !== "transition")
    throw new Error(`${preset.name}@${preset.version} n'est pas une transition`);
  return TransitionParamsSchema.parse(preset.params);
}

export interface ResolvedTransition extends Transition {
  params: TransitionParams;
  /** Timeline frames [start, end) during which the transition draws. */
  window: [number, number];
}

/**
 * Push and glitch straddle the cut (half before, half after); a slide starts on
 * the cut, since the incoming picture covers the outgoing one.
 */
export function transitionWindow(t: Transition, params: TransitionParams): [number, number] {
  if (params.type === "slide") return [t.atFrame, t.atFrame + t.durationFrames];
  const before = Math.floor(t.durationFrames / 2);
  return [t.atFrame - before, t.atFrame - before + t.durationFrames];
}

export function resolveTransitions(edl: Edl, registry: PresetRegistry): ResolvedTransition[] {
  return [...edl.transitions]
    .sort((a, b) => a.atFrame - b.atFrame)
    .map((t) => {
      const params = transitionParams(registry.resolve(t.preset));
      return { ...t, params, window: transitionWindow(t, params) };
    });
}

/** Unit vector of a direction, in frame widths/heights: where the pictures travel. */
export function directionVector(direction: z.infer<typeof Direction>): [number, number] {
  return { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }[direction] as [number, number];
}

export type { Ease };
