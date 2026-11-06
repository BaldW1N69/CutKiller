import type { Caption, Output, StyleProfile } from "@cutkiller/core";
import { type CanvasRenderingContext2D, createCanvas } from "canvas";
import { type CaptionStyle, fontCss } from "./style";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Margins {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * Intersection of every platform's safe area listed in the profile (fractions
 * hidden on each side), and the picture left between letterbox bars, with a 2 %
 * margin: captions stay on the picture, not on the bars.
 */
export function profileSafeArea(profile: StyleProfile): Margins {
  const zones = Object.values(profile.captions.safeZones);
  const { width, height } = profile.format;
  const ratio = profile.texture.letterbox;
  const bar = ratio && width / ratio < height ? (1 - width / ratio / height) / 2 + 0.02 : 0;
  return {
    top: Math.max(bar, ...zones.map((z) => z.top)),
    bottom: Math.max(bar, ...zones.map((z) => z.bottom)),
    left: Math.max(0, ...zones.map((z) => z.left)),
    right: Math.max(0, ...zones.map((z) => z.right)),
  };
}

/** Safe area in pixels. */
export function safeRect(area: Margins, width: number, height: number): Rect {
  return {
    x: area.left * width,
    y: area.top * height,
    w: (1 - area.left - area.right) * width,
    h: (1 - area.top - area.bottom) * height,
  };
}

export interface PlacedWord {
  /** Index in the caption's words. */
  index: number;
  text: string;
  /** Left edge and baseline, relative to the caption centre. */
  x: number;
  baseline: number;
  width: number;
}

export interface CaptionLayout {
  fontPx: number;
  strokePx: number;
  /** Centre of the caption block on the frame: animations scale about it. */
  cx: number;
  cy: number;
  words: PlacedWord[];
  /** Block on the frame, outline included (before any entry animation). */
  box: Rect;
}

let measurer: CanvasRenderingContext2D | undefined;
const measure = () => {
  measurer ??= createCanvas(8, 8).getContext("2d");
  return measurer;
};

/**
 * Places a caption's words: lines centred, the font shrunk if a line would be
 * wider than the safe area, the block at the profile's position and pushed back
 * inside the safe area if needed (both from the EDL's `output.captions`).
 * Shared by the renderer and the QA.
 */
export function layoutCaption(
  caption: Caption,
  style: CaptionStyle,
  output: Pick<Output, "width" | "height" | "captions">,
  /** Largest scale an animation will give the block: it must still fit the safe area. */
  maxScale = 1,
): CaptionLayout {
  const { width: W, height: H } = output;
  const safe = safeRect(output.captions.safeArea, W, H);
  const ctx = measure();
  const lineCount = Math.max(...caption.words.map((w) => w.line)) + 1;
  const lines = Array.from({ length: lineCount }, (_, l) =>
    caption.words.map((w, index) => ({ w, index })).filter(({ w }) => w.line === l),
  );

  let fontPx = style.sizeRel * H;
  const metrics = (px: number) => {
    ctx.font = fontCss(style, px);
    const space = ctx.measureText(" ").width;
    const widths = lines.map((line) => line.map(({ w }) => ctx.measureText(w.text).width));
    const lineWidths = widths.map((ws) => ws.reduce((a, b) => a + b, 0) + space * Math.max(0, ws.length - 1));
    const probe = ctx.measureText("ÉÀÇgjpq");
    return {
      space,
      widths,
      lineWidths,
      ascent: probe.actualBoundingBoxAscent,
      descent: probe.actualBoundingBoxDescent,
    };
  };
  let m = metrics(fontPx);
  const strokeOf = (px: number) => style.stroke.widthRel * px;
  const widest = Math.max(...m.lineWidths);
  const room = safe.w / maxScale - strokeOf(fontPx);
  if (widest > room) {
    fontPx *= room / widest;
    m = metrics(fontPx);
  }
  const strokePx = strokeOf(fontPx);
  const lineStep = fontPx * style.lineHeight;
  const blockW = Math.max(...m.lineWidths) + strokePx;
  const blockH = (lineCount - 1) * lineStep + m.ascent + m.descent + strokePx;

  const { anchor, y } = output.captions.placement;
  let cy = anchor === "center" ? y * H : y * H - blockH / 2;
  const halfW = (blockW * maxScale) / 2;
  const halfH = (blockH * maxScale) / 2;
  cy = Math.min(Math.max(cy, safe.y + halfH), safe.y + safe.h - halfH);
  const cx = Math.min(Math.max(W / 2, safe.x + halfW), safe.x + safe.w - halfW);

  // Baseline of the first line, relative to the block centre.
  const firstBaseline = -blockH / 2 + strokePx / 2 + m.ascent;
  const words: PlacedWord[] = [];
  lines.forEach((line, l) => {
    let x = -(m.lineWidths[l] as number) / 2;
    line.forEach(({ w, index }, i) => {
      const width = (m.widths[l] as number[])[i] as number;
      words.push({ index, text: w.text, x, baseline: firstBaseline + l * lineStep, width });
      x += width + m.space;
    });
  });
  return {
    fontPx,
    strokePx,
    cx,
    cy,
    words: words.sort((a, b) => a.index - b.index),
    box: { x: cx - blockW / 2, y: cy - blockH / 2, w: blockW, h: blockH },
  };
}
