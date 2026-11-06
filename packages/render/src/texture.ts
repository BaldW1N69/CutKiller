import type { Output } from "@cutkiller/core";
import { type Canvas, type CanvasRenderingContext2D, createCanvas } from "canvas";

type Texture = NonNullable<Output["texture"]>;

/** Side of a grain tile (px): not a power of two, so its repetition does not line up with the picture. */
const TILE = 389;
const TILES = 4;

/** Deterministic pseudo-random generator (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Grain tiles: grey (128) plus a Gaussian luma noise, generated at half
 * resolution and upscaled so the grain is a little coarser than one pixel, like
 * film rather than sensor noise.
 */
function grainTiles(): Canvas[] {
  return Array.from({ length: TILES }, (_, k) => {
    const half = Math.ceil(TILE / 2);
    const small = createCanvas(half, half);
    const sctx = small.getContext("2d");
    const img = sctx.createImageData(half, half);
    const rand = rng(0x9e3779b9 + k);
    for (let i = 0; i < half * half; i++) {
      // Box–Muller: one normal deviate per pixel, σ = 48 levels.
      const n = Math.sqrt(-2 * Math.log(rand() || 1e-12)) * Math.cos(2 * Math.PI * rand());
      const v = Math.max(0, Math.min(255, Math.round(128 + 48 * n)));
      img.data[4 * i] = v;
      img.data[4 * i + 1] = v;
      img.data[4 * i + 2] = v;
      img.data[4 * i + 3] = 255;
    }
    sctx.putImageData(img, 0, 0);
    const tile = createCanvas(TILE, TILE);
    const tctx = tile.getContext("2d");
    tctx.quality = "good";
    tctx.drawImage(small, 0, 0, TILE, TILE);
    return tile;
  });
}

/** Height of each letterbox bar (px) for a frame W×H cropped to `ratio`; 0 when the frame is already wider. */
export function letterboxBar(width: number, height: number, ratio: number | undefined): number {
  if (!ratio) return 0;
  return Math.max(0, Math.round((height - width / ratio) / 2));
}

/**
 * Film texture painter: grain (overlay blend, the tile and its offset chosen
 * by `seed`, so a repeated picture keeps the same grain and still reads as a
 * repeat), then vignette, then letterbox bars. Captions are drawn afterwards.
 */
export class TexturePainter {
  private readonly tiles: Canvas[];
  private readonly bar: number;

  constructor(
    private readonly texture: Texture,
    private readonly width: number,
    private readonly height: number,
  ) {
    this.tiles = texture.grain > 0 ? grainTiles() : [];
    this.bar = letterboxBar(width, height, texture.letterbox);
  }

  get active(): boolean {
    return this.texture.grain > 0 || this.texture.vignette > 0 || this.bar > 0;
  }

  paint(ctx: CanvasRenderingContext2D, seed: number): void {
    const { width: W, height: H } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (this.texture.grain > 0) {
      const s = Math.abs(Math.imul(seed | 0, 2654435761)) >>> 0;
      const tile = this.tiles[s % TILES] as Canvas;
      const pattern = ctx.createPattern(tile, "repeat");
      if (pattern) {
        ctx.save();
        ctx.globalCompositeOperation = "overlay";
        // σ ≈ 55 × grain levels (8-bit) on mid-grey, fading towards black and white (overlay).
        ctx.globalAlpha = Math.min(1, 2 * this.texture.grain);
        ctx.translate(-((s >>> 3) % TILE), -((s >>> 13) % TILE));
        ctx.fillStyle = pattern;
        ctx.fillRect(0, 0, W + TILE, H + TILE);
        ctx.restore();
      }
    }
    if (this.texture.vignette > 0) {
      const r = Math.hypot(W, H) / 2;
      const g = ctx.createRadialGradient(W / 2, H / 2, r * 0.45, W / 2, H / 2, r);
      g.addColorStop(0, "rgba(0,0,0,0)");
      g.addColorStop(1, `rgba(0,0,0,${(0.65 * this.texture.vignette).toFixed(3)})`);
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
    if (this.bar > 0) {
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, W, this.bar);
      ctx.fillRect(0, H - this.bar, W, this.bar);
      ctx.restore();
    }
  }
}

/** FNV-1a hash of a string, for grain seeds. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
