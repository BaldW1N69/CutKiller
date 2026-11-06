import { z } from "zod";
import { linearToSrgb, srgbToLinear } from "./lab";

/**
 * Look of the edit, as a 3D LUT generated from a few parameters (no LUT file is
 * shipped): a gentle S-curve around a pivot, a slight black lift, saturation that
 * keeps hues (no skin shift), optional warmth.
 */
export const LookParamsSchema = z.object({
  /** S-curve strength (0 = none). */
  contrast: z.number().min(0).max(0.5).default(0),
  /** Level the S-curve turns around (gamma-encoded, 0–1). */
  pivot: z.number().min(0.1).max(0.9).default(0.45),
  /** Black lift (0–1). */
  lift: z.number().min(0).max(0.2).default(0),
  /** Saturation change around the pixel's own luma (−1…1). */
  saturation: z.number().min(-1).max(1).default(0),
  /** Red up / blue down (−0.2…0.2). */
  warmth: z.number().min(-0.2).max(0.2).default(0),
  /**
   * Split toning: colour added to the shadows and to the highlights (bell
   * weights peaking at Y = 1/3 and 2/3, zero at black and white), each without
   * changing luma: cool shadows / warm highlights, the film-print colour contrast.
   */
  shadowTint: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
  highlightTint: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
  size: z.number().int().min(9).max(65).default(33),
});

export type LookParams = z.infer<typeof LookParamsSchema>;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** The look applied to one colour (gamma-encoded RGB, 0–1). */
export function applyLook(p: LookParams, rgb: [number, number, number]): [number, number, number] {
  let [r, g, b] = rgb.map((v) => {
    const lifted = p.lift + (1 - p.lift) * v;
    // Zero change at 0 and 1, slope 1 + contrast at the pivot: monotonic for contrast ≤ 0.5.
    return clamp01(lifted + p.contrast * (lifted - p.pivot) * 4 * lifted * (1 - lifted));
  }) as [number, number, number];
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  r = y + (r - y) * (1 + p.saturation);
  g = y + (g - y) * (1 + p.saturation);
  b = y + (b - y) * (1 + p.saturation);
  r *= 1 + p.warmth;
  b *= 1 - p.warmth;
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  // Bell-shaped weights (peaks at 1/3 and 2/3): pure black and pure white stay neutral.
  const t = clamp01(l);
  const ws = 6.75 * t * (1 - t) ** 2;
  const wh = 6.75 * t ** 2 * (1 - t);
  const tone = (c: number) =>
    ws * ((p.shadowTint[c] as number) - luma(p.shadowTint)) +
    wh * ((p.highlightTint[c] as number) - luma(p.highlightTint));
  return [clamp01(r + tone(0)), clamp01(g + tone(1)), clamp01(b + tone(2))];
}

const luma = (v: readonly number[]) => 0.2126 * (v[0] ?? 0) + 0.7152 * (v[1] ?? 0) + 0.0722 * (v[2] ?? 0);

/** Adobe/Resolve `.cube` text of the look (red varies fastest). */
export function lookCube(p: LookParams, title = "CutKiller look"): string {
  const n = p.size;
  const lines = [`TITLE "${title}"`, `LUT_3D_SIZE ${n}`, "DOMAIN_MIN 0 0 0", "DOMAIN_MAX 1 1 1"];
  for (let bi = 0; bi < n; bi++)
    for (let gi = 0; gi < n; gi++)
      for (let ri = 0; ri < n; ri++) {
        const [r, g, b] = applyLook(p, [ri / (n - 1), gi / (n - 1), bi / (n - 1)]);
        lines.push(`${r.toFixed(6)} ${g.toFixed(6)} ${b.toFixed(6)}`);
      }
  return `${lines.join("\n")}\n`;
}

/**
 * Highlight shoulder for a gain `top` > 1 (largest channel gain): linear values up
 * to `knee` are kept, the rest of [knee, top] rolls off smoothly into [knee, 1]
 * (same slope at the knee, white reaches exactly 1) instead of clipping.
 */
export function shoulder(m: number, top: number, knee = 0.5): number {
  if (top <= 1 || m <= knee) return m;
  const p = (top - knee) / (1 - knee);
  const u = Math.min(1, (m - knee) / (top - knee));
  return knee + (1 - knee) * (1 - (1 - u) ** p);
}

/** Grade of a clip: linear-light gains (exposure × balance) with a highlight shoulder, then the look. */
export function gradeCube(
  look: LookParams | undefined,
  gains: [number, number, number],
  title: string,
): string {
  const n = look?.size ?? 33;
  const top = Math.max(...gains);
  const lines = [`TITLE "${title}"`, `LUT_3D_SIZE ${n}`, "DOMAIN_MIN 0 0 0", "DOMAIN_MAX 1 1 1"];
  for (let bi = 0; bi < n; bi++)
    for (let gi = 0; gi < n; gi++)
      for (let ri = 0; ri < n; ri++) {
        const lin = [ri, gi, bi].map((i, c) => srgbToLinear(i / (n - 1)) * (gains[c] as number));
        const m = Math.max(...lin);
        const k = m > 0 ? shoulder(m, top) / m : 1;
        const graded = lin.map((v) => clamp01(linearToSrgb(v * k))) as [number, number, number];
        const [r, g, b] = look ? applyLook(look, graded) : graded;
        lines.push(`${r.toFixed(6)} ${g.toFixed(6)} ${b.toFixed(6)}`);
      }
  return `${lines.join("\n")}\n`;
}

/** Key of a clip's grade (same key, same LUT). */
export const gradeKey = (c: { exposureEv: number; balance: number[]; look?: string | undefined }) =>
  `${c.look ?? "-"}|${c.exposureEv}|${c.balance.join(",")}`;
