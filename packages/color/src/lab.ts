export type Rgb = [number, number, number];

/** sRGB transfer (IEC 61966-2-1): display value → linear light. */
export const srgbToLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
export const linearToSrgb = (v: number) =>
  v <= 0.0031308 ? v * 12.92 : 1.055 * Math.max(0, v) ** (1 / 2.4) - 0.055;

/** Linear luminance (Rec. 709 / sRGB primaries). */
export const lumaLinear = ([r, g, b]: Rgb) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

const D = 6 / 29;
const f = (t: number) => (t > D ** 3 ? Math.cbrt(t) : t / (3 * D * D) + 4 / 29);

/** CIELAB (D65) of a display sRGB colour (0–1). */
export function srgbToLab(rgb: Rgb): Rgb {
  const [r, g, b] = rgb.map(srgbToLinear) as Rgb;
  const x = 0.4124 * r + 0.3576 * g + 0.1805 * b;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = 0.0193 * r + 0.1192 * g + 0.9505 * b;
  const fy = f(y);
  return [116 * fy - 16, 500 * (f(x / 0.95047) - fy), 200 * (fy - f(z / 1.08883))];
}

/** Linear luminance of a CIE lightness L* (0–100). */
export function lightnessToY(l: number): number {
  const fy = (l + 16) / 116;
  return fy > D ? fy ** 3 : 3 * D * D * (fy - 4 / 29);
}
