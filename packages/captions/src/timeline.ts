import {
  type Caption,
  type Edl,
  easeProgress,
  framesToSeconds,
  type PresetResolver,
  secondsToFrames,
} from "@cutkiller/core";
import { type MotionParams, MotionParamsSchema } from "@cutkiller/motion";
import { type Canvas, type CanvasRenderingContext2D, createCanvas } from "canvas";
import { type CaptionLayout, layoutCaption } from "./layout";
import { type CaptionStyle, captionStyle, fontCss } from "./style";

export interface CaptionState {
  scale: number;
  opacity: number;
}

interface Entry {
  params: MotionParams;
  frames: number;
  ref: string;
}

export interface PlacedCaption {
  caption: Caption;
  style: CaptionStyle;
  layout: CaptionLayout;
  entry?: Entry;
  /** Largest scale the entry animation reaches (overshoot included): the layout keeps room for it. */
  maxScale: number;
}

type Paints = { fill: string; activeFill: string; stroke: string; shadow: boolean };

/** Entry animation state `dt` frames after the caption appears. */
function entryState(entry: Entry | undefined, dt: number, fps: number): CaptionState {
  const state = { scale: 1, opacity: 1 };
  if (!entry) return state;
  const { params, frames } = entry;
  const progress = easeProgress(params.ease, Math.max(0, dt / frames), framesToSeconds(frames, fps));
  const from = params.from ?? 0;
  const to = params.to ?? 1;
  const value = from + (to - from) * progress;
  if (params.property === "scale") state.scale = value;
  else if (params.property === "opacity") state.opacity = value;
  return state;
}

/**
 * Captions on screen over time: which one is visible, how far its entry
 * animation is, which word is being spoken. Shared by the renderer (draw,
 * motion blur) and the QA (safe zones, contrast masks, speeds).
 */
export class CaptionTimeline {
  readonly placed: PlacedCaption[];
  private readonly fps: number;
  /** Rasterised caption (outline, shadow, text) per active word, for the caption on screen. */
  private cache: { caption?: PlacedCaption; bitmaps: Map<number, { canvas: Canvas; x: number; y: number }> } =
    { bitmaps: new Map() };

  constructor(edl: Edl, presets: PresetResolver) {
    const fps = edl.output.fps;
    this.fps = fps;
    const styles = new Map<string, CaptionStyle>();
    const entries = new Map<string, Entry>();
    this.placed = edl.captions.map((caption) => {
      let style = styles.get(caption.style);
      if (!style) {
        style = captionStyle(presets, caption.style);
        styles.set(caption.style, style);
      }
      let entry: Entry | undefined;
      if (style.entry) {
        entry = entries.get(style.entry);
        if (!entry) {
          const preset = presets.resolve(style.entry);
          const params = MotionParamsSchema.parse(preset.params);
          const frames = Math.max(1, secondsToFrames(params.durationMs / 1000, fps));
          entry = { params, frames, ref: `${preset.name}@${preset.version}` };
          entries.set(style.entry, entry);
        }
      }
      let maxScale = 1;
      if (entry?.params.property === "scale")
        for (let dt = 0; dt <= entry.frames; dt += 0.05)
          maxScale = Math.max(maxScale, entryState(entry, dt, fps).scale);
      const layout = layoutCaption(caption, style, edl.output, maxScale);
      return { caption, style, layout, maxScale, ...(entry ? { entry } : {}) };
    });
  }

  /** Caption visible at frame f. */
  at(f: number): PlacedCaption | undefined {
    let lo = 0;
    let hi = this.placed.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const p = this.placed[mid] as PlacedCaption;
      if (f < p.caption.fromFrame) hi = mid - 1;
      else if (f >= p.caption.toFrame) lo = mid + 1;
      else return p;
    }
    return undefined;
  }

  /** Entry animation state at a fractional frame t. */
  stateAt(p: PlacedCaption, t: number): CaptionState {
    return entryState(p.entry, t - p.caption.fromFrame, this.fps);
  }

  /** Fastest movement of the visible caption's outline at frame f, in px/frame. */
  velocityAt(f: number): number {
    const p = this.at(f);
    if (p === undefined) return 0;
    if (p.entry?.params.property !== "scale") return 0;
    const halfDiagonal = Math.hypot(p.layout.box.w, p.layout.box.h) / 2;
    const a = this.stateAt(p, Math.max(p.caption.fromFrame, f - 0.5)).scale;
    const b = this.stateAt(p, f + 0.5).scale;
    return halfDiagonal * Math.abs(b - a);
  }

  /** Pixels the caption can touch (largest scale, outline and shadow), whole pixels inside the frame. */
  extent(p: PlacedCaption, width: number, height: number): { x: number; y: number; w: number; h: number } {
    const { layout, style, maxScale } = p;
    const shadow = style.shadow
      ? (style.shadow.blurRel * 2 + Math.abs(style.shadow.offsetYRel)) * layout.fontPx
      : 0;
    const halfW = (layout.box.w / 2) * maxScale + shadow + 2;
    const halfH = (layout.box.h / 2) * maxScale + shadow + 2;
    const x = Math.max(0, Math.floor(layout.cx - halfW));
    const y = Math.max(0, Math.floor(layout.cy - halfH));
    return {
      x,
      y,
      w: Math.min(width, Math.ceil(layout.cx + halfW)) - x,
      h: Math.min(height, Math.ceil(layout.cy + halfH)) - y,
    };
  }

  /** Index of the word highlighted at frame f: spoken now, or the last one until the next starts. */
  activeWord(p: PlacedCaption, f: number): number {
    const words = p.caption.words;
    for (let i = words.length - 1; i >= 0; i--) {
      const w = words[i] as Caption["words"][number];
      if (f < w.fromFrame) continue;
      return i < words.length - 1 || f < w.toFrame ? i : -1;
    }
    return -1;
  }

  /** Paints the caption's words around (0, 0) = the caption centre. */
  private paint(ctx: CanvasRenderingContext2D, p: PlacedCaption, active: number, paints?: Paints): void {
    const { style, layout } = p;
    ctx.font = fontCss(style, layout.fontPx);
    ctx.textBaseline = "alphabetic";
    ctx.lineJoin = "round";
    ctx.miterLimit = 2;
    // Outlines (and their shadow) first, so no outline overlaps a neighbouring word's fill.
    if (layout.strokePx > 0) {
      ctx.strokeStyle = paints?.stroke ?? style.stroke.color;
      ctx.lineWidth = layout.strokePx;
      if (style.shadow && (paints?.shadow ?? true)) {
        ctx.shadowColor = style.shadow.color;
        ctx.shadowBlur = style.shadow.blurRel * layout.fontPx;
        ctx.shadowOffsetY = style.shadow.offsetYRel * layout.fontPx;
      }
      for (const w of layout.words) ctx.strokeText(w.text, w.x, w.baseline);
      ctx.shadowColor = "rgba(0,0,0,0)";
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
    }
    for (const w of layout.words) {
      ctx.fillStyle =
        w.index === active ? (paints?.activeFill ?? style.activeFill) : (paints?.fill ?? style.fill);
      ctx.fillText(w.text, w.x, w.baseline);
    }
  }

  /** Caption rasterised once per highlighted word (shadow blur is costly), placed on whole pixels. */
  private bitmap(p: PlacedCaption, active: number) {
    if (this.cache.caption !== p) this.cache = { caption: p, bitmaps: new Map() };
    let entry = this.cache.bitmaps.get(active);
    if (!entry) {
      const { layout, style } = p;
      const shadow = style.shadow
        ? (style.shadow.blurRel * 2 + Math.abs(style.shadow.offsetYRel)) * layout.fontPx
        : 0;
      const pad = Math.ceil(layout.strokePx + shadow + 2);
      const x = Math.floor(layout.box.x) - pad;
      const y = Math.floor(layout.box.y) - pad;
      const canvas = createCanvas(
        Math.ceil(layout.box.x + layout.box.w) + pad - x,
        Math.ceil(layout.box.y + layout.box.h) + pad - y,
      );
      const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
      ctx.translate(layout.cx - x, layout.cy - y);
      this.paint(ctx, p, active);
      entry = { canvas, x, y };
      this.cache.bitmaps.set(active, entry);
    }
    return entry;
  }

  /**
   * Draws the caption of frame f with its animation state at t (t ≠ f for motion
   * blur sub-samples). `paints` overrides the colours (QA masks) and draws directly.
   */
  draw(ctx: CanvasRenderingContext2D, f: number, t = f, paints?: Paints): void {
    const p = this.at(f);
    if (!p) return;
    const state = this.stateAt(p, t);
    if (state.opacity <= 0 || state.scale <= 0) return;
    const active = this.activeWord(p, f);
    const { cx, cy } = p.layout;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = Math.min(1, state.opacity);
    if (paints) {
      ctx.translate(cx, cy);
      ctx.scale(state.scale, state.scale);
      this.paint(ctx, p, active, paints);
    } else {
      const b = this.bitmap(p, active);
      if (Math.abs(state.scale - 1) > 1e-4) {
        ctx.translate(cx, cy);
        ctx.scale(state.scale, state.scale);
        ctx.translate(-cx, -cy);
      }
      ctx.drawImage(b.canvas, b.x, b.y);
    }
    ctx.restore();
  }
}
