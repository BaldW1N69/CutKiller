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
    const t = this.texture;
    return t.grain > 0 || t.vignette > 0 || t.halation > 0 || t.bloom > 0 || this.bar > 0;
  }

  private readonly glows = new Map<
    number,
    { canvas: Canvas; ctx: CanvasRenderingContext2D; w: number; h: number }
  >();

  /**
   * Glow of the highlights, taken at 1/8 resolution, blurred and added back in
   * `screen` mode:
   * - halation: luma above 0,75, tinted red-orange: the warm bleed of film around
   *   bright edges (a window, a lamp), absent from shadows and midtones;
   * - bloom: luma above 0,62, in the highlights' own colours, wider: the neon glow.
   */
  private glowPass(
    ctx: CanvasRenderingContext2D,
    strength: number,
    threshold: number,
    /** Working resolution divisor and blur radius at that resolution. */
    scale: number,
    radius: number,
    tint?: [number, number, number],
  ): void {
    const { width: W, height: H } = this;
    let buffer = this.glows.get(scale);
    if (!buffer) {
      const w = Math.max(8, Math.round(W / scale));
      const h = Math.max(8, Math.round(H / scale));
      const canvas = createCanvas(w, h);
      buffer = { canvas, ctx: canvas.getContext("2d"), w, h };
      this.glows.set(scale, buffer);
    }
    const { canvas, ctx: g, w, h } = buffer;
    g.globalCompositeOperation = "copy";
    g.drawImage(ctx.canvas, 0, 0, w, h);
    const img = g.getImageData(0, 0, w, h);
    const d = img.data;
    let planes: Float32Array[] = [0, 1, 2].map(() => new Float32Array(w * h));
    for (let i = 0; i < w * h; i++) {
      const r = (d[4 * i] as number) / 255;
      const gr = (d[4 * i + 1] as number) / 255;
      const b = (d[4 * i + 2] as number) / 255;
      const m = Math.max(0, (0.2126 * r + 0.7152 * gr + 0.0722 * b - threshold) / (1 - threshold));
      const c = tint ?? [r, gr, b];
      for (let k = 0; k < 3; k++) (planes[k] as Float32Array)[i] = m * (c[k] as number);
    }
    // Two box blurs (halation: radius 2 at 1/8 ≈ 16 px; bloom: radius 6 at 1/4 ≈ 24 px).
    for (let pass = 0; pass < 2; pass++) planes = planes.map((p) => boxBlur(p, w, h, radius));
    for (let i = 0; i < w * h; i++) {
      for (let k = 0; k < 3; k++)
        d[4 * i + k] = Math.round(255 * Math.min(1, ((planes[k] as Float32Array)[i] as number) * strength));
      d[4 * i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    ctx.save();
    ctx.globalCompositeOperation = "screen";
    ctx.globalAlpha = 1;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(canvas, 0, 0, W, H);
    ctx.restore();
  }

  private vignette?: Canvas;

  /**
   * Black layer whose opacity rises from 45 % of the half-diagonal to the corners
   * (smoothstep, up to 65 % × vignette). Its 8-bit alpha is dithered: a plain canvas
   * gradient steps by whole levels and draws visible rings on bright skies.
   */
  private vignetteLayer(): Canvas {
    if (this.vignette) return this.vignette;
    const { width: W, height: H } = this;
    const layer = createCanvas(W, H);
    const lctx = layer.getContext("2d");
    const img = lctx.createImageData(W, H);
    const rand = rng(0x5eed);
    const r = Math.hypot(W, H) / 2;
    const top = 0.65 * this.texture.vignette * 255;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const u = Math.min(1, Math.max(0, (Math.hypot(x + 0.5 - W / 2, y + 0.5 - H / 2) / r - 0.45) / 0.55));
        const a = top * u * u * (3 - 2 * u);
        const i = 4 * (y * W + x);
        img.data[i + 3] = Math.max(0, Math.min(255, Math.floor(a + rand())));
      }
    lctx.putImageData(img, 0, 0);
    this.vignette = layer;
    return layer;
  }

  paint(ctx: CanvasRenderingContext2D, seed: number): void {
    const { width: W, height: H } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // Bloom works at 1/4 resolution so that thin lights (a neon tube) still pass the threshold.
    if (this.texture.bloom > 0) this.glowPass(ctx, this.texture.bloom * 3, 0.62, 4, 6);
    if (this.texture.halation > 0)
      this.glowPass(ctx, this.texture.halation, 0.75, 8, 2, [1, 90 / 255, 40 / 255]);
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
        // Overlay leaves pure white untouched: a faint normal blend of the same
        // grain (σ ≈ 1–2 levels) dithers the highlights too, so that a bright sky
        // stretched by the look does not show its 8-bit steps as rings.
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = Math.min(0.05, 0.4 * this.texture.grain);
        ctx.fillRect(0, 0, W + TILE, H + TILE);
        ctx.restore();
      }
    }
    if (this.texture.vignette > 0) {
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      ctx.drawImage(this.vignetteLayer(), 0, 0);
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

/** Separable box blur of a w×h scalar field (radius r, edges clamped). */
function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const n = 2 * r + 1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += src[y * w + Math.min(w - 1, Math.max(0, x + k))] as number;
      tmp[y * w + x] = s / n;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += tmp[Math.min(h - 1, Math.max(0, y + k)) * w + x] as number;
      out[y * w + x] = s / n;
    }
  return out;
}
