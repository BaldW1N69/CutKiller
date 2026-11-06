import { createCanvas } from "canvas";
import { describe, expect, it } from "vitest";
import { letterboxBar, TexturePainter } from "../src";

/** A dark grey frame with a white square (a window) in the middle. */
function scene(W: number, H: number) {
  const c = createCanvas(W, H);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "rgb(60,60,60)";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#fff";
  ctx.fillRect(W / 2 - 40, H / 2 - 40, 80, 80);
  return { c, ctx };
}
const px = (ctx: ReturnType<typeof scene>["ctx"], x: number, y: number) => [
  ...ctx.getImageData(x, y, 1, 1).data,
];

describe("texture film", () => {
  it("halation : halo chaud autour des hautes lumières, rien loin d'elles", () => {
    const W = 320;
    const H = 240;
    const { ctx } = scene(W, H);
    const before = px(ctx, W / 2 + 46, H / 2);
    new TexturePainter({ grain: 0, vignette: 0, halation: 0.6 }, W, H).paint(ctx, 0);
    const edge = px(ctx, W / 2 + 46, H / 2);
    // Just outside the window: warmer (red up more than blue).
    expect((edge[0] as number) - (before[0] as number)).toBeGreaterThan(15);
    expect((edge[0] as number) - (edge[2] as number)).toBeGreaterThan(10);
    // Far from it: untouched.
    expect(px(ctx, 10, 10)).toEqual([60, 60, 60, 255]);
  });

  it("grain : même graine, même grain ; graine différente, grain différent", () => {
    const paint = (seed: number) => {
      const { ctx } = scene(160, 120);
      new TexturePainter({ grain: 0.1, vignette: 0, halation: 0 }, 160, 120).paint(ctx, seed);
      return ctx.getImageData(0, 0, 160, 120).data;
    };
    expect(Buffer.from(paint(3)).equals(Buffer.from(paint(3)))).toBe(true);
    expect(Buffer.from(paint(3)).equals(Buffer.from(paint(4)))).toBe(false);
  });

  it("letterbox : hauteur des bandes", () => {
    expect(letterboxBar(1920, 1080, 2.39)).toBe(138);
    expect(letterboxBar(1080, 1920, undefined)).toBe(0);
    expect(letterboxBar(1920, 800, 2)).toBe(0);
  });
});
