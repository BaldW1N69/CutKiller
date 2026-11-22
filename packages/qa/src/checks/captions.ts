import { resolve } from "node:path";
import { runWorker } from "@cutkiller/analyze";
import {
  type CaptionStyle,
  CaptionTimeline,
  type PlacedCaption,
  profileSafeArea,
  safeRect,
  timelineWords,
} from "@cutkiller/captions";
import { type Analysis, dominantLanguage, type Edl, type StyleProfile, tr } from "@cutkiller/core";
import { confinePath, mediaInput } from "@cutkiller/media";
import type { PresetRegistry } from "@cutkiller/style";
import { type CanvasRenderingContext2D, createCanvas } from "canvas";
import { streamFrames } from "../decode";
import { type CheckResult, graded, notEvaluated, type Violation } from "../report";
import { voiceTrack } from "./montage";

interface AlignedWord {
  start: number;
  end: number;
  timing: "forced" | "whisper";
  alignScore?: number;
}

/** Below this CTC confidence on the render, a word's position is not measured (counted apart). */
export /** Under this share of words measured, the sync rule is not evaluated. */
const MIN_MEASURED_SHARE = 0.5;
const MIN_ALIGN_SCORE = 0.2;

const quantile = (sorted: number[], q: number) =>
  sorted.length === 0 ? 0 : (sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] as number);

/**
 * Word sync: the caption text is force-aligned (wav2vec2 CTC) on the rendered
 * dialogue; each word's highlight must start within the profile's limits of the
 * moment it is heard (p95 and max, in frames). Every word of the edit must also
 * appear in the captions.
 */
export async function checkCaptionSync(
  video: string,
  edl: Edl,
  profile: StyleProfile,
  analysis: Analysis | undefined,
  baseDir = ".",
  alignOverride?: AlignedWord[],
): Promise<CheckResult> {
  const fps = edl.output.fps;
  const words = edl.captions.flatMap((c) => c.words);
  if (words.length === 0) return notEvaluated("captions.sync", tr("no captions", "aucun sous-titre"));
  // The noise floor that word boundaries are refined against comes from the rush:
  // the edit has its pauses removed, its own floor would be far higher.
  const counts = new Map<string, number>();
  for (const w of words) if (w.source) counts.set(w.source, (counts.get(w.source) ?? 0) + 1);
  const main = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  const rush = main ? edl.sources[main]?.path : undefined;
  const aligned =
    alignOverride ??
    (
      await runWorker<{ words: AlignedWord[] }>("align", {
        path: voiceTrack(video),
        ...(rush ? { floorPath: confinePath(resolve(baseDir, rush)) } : {}),
        language: dominantLanguage(analysis?.transcripts) ?? "fr",
        words: words.map((w) => ({ text: w.text, start: w.fromFrame / fps, end: w.toFrame / fps })),
      })
    ).words;
  const limits = profile.captions.maxSyncErrorFrames;
  const violations: Violation[] = [];
  const errors: number[] = [];
  let unmeasured = 0;
  words.forEach((w, i) => {
    const a = aligned[i];
    // Where the aligner is not confident on the render, the measure would be noise.
    if (a?.timing !== "forced" || (a.alignScore ?? 1) < MIN_ALIGN_SCORE) {
      unmeasured++;
      return;
    }
    const err = a.start * fps - w.fromFrame;
    errors.push(Math.abs(err));
    if (Math.abs(err) > limits.max)
      violations.push({
        message: tr(
          `« ${w.text} » highlighted ${Math.abs(err).toFixed(1)} frame(s) ${err > 0 ? "early" : "late"}`,
          `« ${w.text} » surligné ${err > 0 ? "en avance" : "en retard"} de ${Math.abs(err).toFixed(1)} frame(s)`,
        ),
        frame: w.fromFrame,
      });
  });
  const sorted = [...errors].sort((a, b) => a - b);
  const p95 = quantile(sorted, 0.95);
  if (p95 > limits.p95)
    violations.push({
      message: tr(`p95 offset of ${p95.toFixed(2)} frame(s)`, `écart p95 de ${p95.toFixed(2)} frame(s)`),
    });

  let missing = 0;
  if (analysis?.transcripts) {
    const shown = new Set(words.map((w) => `${w.source}#${w.wordId}`));
    for (const w of timelineWords(edl, analysis.transcripts)) {
      if (!/[\p{L}\p{N}]/u.test(w.text) || shown.has(`${w.source}#${w.wordId}`)) continue;
      missing++;
      violations.push({
        message: tr(`« ${w.text} » spoken but not captioned`, `« ${w.text} » prononcé mais pas sous-titré`),
        frame: w.fromFrame,
      });
    }
  }
  // Timing measured on too few words (an aligner that does not know the language's
  // script, as the Greek one did not): not a pass.
  if (words.length > 0 && errors.length < MIN_MEASURED_SHARE * words.length && missing === 0)
    return notEvaluated(
      "captions.sync",
      tr(
        `aligner confident on ${errors.length}/${words.length} words of the render only`,
        `aligneur sûr de lui sur ${errors.length}/${words.length} mots du rendu seulement`,
      ),
    );
  return graded("captions.sync", words.length + missing, violations, {
    words: words.length,
    measured: errors.length,
    unmeasured,
    medianFrames: Math.round(quantile(sorted, 0.5) * 100) / 100,
    p95Frames: Math.round(p95 * 100) / 100,
    maxFrames: Math.round((sorted.at(-1) ?? 0) * 100) / 100,
    missing,
  });
}

/**
 * Time on screen: each caption must stay up at least the profile's minimum
 * (captions.minDurationMs) before the next one replaces it or the video ends.
 * Flash screens come from fast speech chopped at every comma, or from an edit
 * ending on the first syllable of a word. Tolerance: one frame.
 */
export function checkCaptionReadingTime(edl: Edl, profile: StyleProfile): CheckResult {
  if (edl.captions.length === 0)
    return notEvaluated("captions.reading-time", tr("no captions", "aucun sous-titre"));
  const fps = edl.output.fps;
  const minFrames = Math.round((profile.captions.minDurationMs / 1000) * fps);
  const shown = edl.captions.map((c) => c.toFrame - c.fromFrame);
  const violations: Violation[] = edl.captions.flatMap((c, i) =>
    (shown[i] as number) < minFrames - 1
      ? [
          {
            message: tr(
              `${c.id}: « ${c.words.map((w) => w.text).join(" ")} » on screen ${shown[i]} frame(s), under ${minFrames}`,
              `${c.id} : « ${c.words.map((w) => w.text).join(" ")} » à l'écran ${shown[i]} frame(s), moins de ${minFrames}`,
            ),
            frame: c.fromFrame,
          },
        ]
      : [],
  );
  const sorted = [...shown].sort((a, b) => a - b);
  return graded("captions.reading-time", edl.captions.length, violations, {
    captions: edl.captions.length,
    minFrames,
    shortestFrames: sorted[0],
    medianFrames: sorted[Math.floor((sorted.length - 1) / 2)],
  });
}

/** Words per screen (short form), lines and characters per line. */
export function checkCaptionDensity(edl: Edl, profile: StyleProfile): CheckResult {
  const c = profile.captions;
  if (edl.captions.length === 0)
    return notEvaluated("captions.density", tr("no captions", "aucun sous-titre"));
  const violations: Violation[] = [];
  for (const cap of edl.captions) {
    const n = cap.words.length;
    if (c.wordsPerScreen && (n < c.wordsPerScreen[0] || n > c.wordsPerScreen[1]))
      violations.push({
        message: tr(`${cap.id}: ${n} words on screen`, `${cap.id} : ${n} mots à l'écran`),
        frame: cap.fromFrame,
      });
    const lines: string[][] = [];
    for (const w of cap.words) {
      const line = lines[w.line] ?? [];
      line.push(w.text);
      lines[w.line] = line;
    }
    if (lines.length > c.maxLines)
      violations.push({ message: `${cap.id} : ${lines.length} lignes`, frame: cap.fromFrame });
    for (const line of lines) {
      const chars = line.join(" ").length;
      // A single word longer than the limit cannot be split: the layout shrinks it instead.
      if (chars > c.maxCharsPerLine && line.length > 1)
        violations.push({
          message: tr(`${cap.id}: line of ${chars} characters`, `${cap.id} : ligne de ${chars} caractères`),
          frame: cap.fromFrame,
        });
    }
  }
  return graded("captions.density", edl.captions.length, violations, { captions: edl.captions.length });
}

/**
 * Safe zones: each caption block (outline included, at the largest scale its
 * entry animation reaches) stays inside the intersection of the profile's
 * platform safe areas — measured against the profile, not the EDL's own setting.
 */
export function checkSafeZones(edl: Edl, profile: StyleProfile, registry: PresetRegistry): CheckResult {
  if (edl.captions.length === 0)
    return notEvaluated("captions.safe-zones", tr("no captions", "aucun sous-titre"));
  const { width: W, height: H } = edl.output;
  const safe = safeRect(profileSafeArea(profile), W, H);
  const timeline = new CaptionTimeline(edl, registry);
  const violations: Violation[] = [];
  const tol = 0.5;
  for (const p of timeline.placed) {
    const s = p.maxScale;
    const { box, cx, cy } = p.layout;
    const x0 = cx + (box.x - cx) * s;
    const y0 = cy + (box.y - cy) * s;
    const x1 = cx + (box.x + box.w - cx) * s;
    const y1 = cy + (box.y + box.h - cy) * s;
    const out: string[] = [];
    if (x0 < safe.x - tol)
      out.push(tr(`${Math.round(safe.x - x0)} px on the left`, `${Math.round(safe.x - x0)} px à gauche`));
    if (x1 > safe.x + safe.w + tol)
      out.push(
        tr(
          `${Math.round(x1 - safe.x - safe.w)} px on the right`,
          `${Math.round(x1 - safe.x - safe.w)} px à droite`,
        ),
      );
    if (y0 < safe.y - tol) out.push(`${Math.round(safe.y - y0)} px en haut`);
    if (y1 > safe.y + safe.h + tol) out.push(`${Math.round(y1 - safe.y - safe.h)} px en bas`);
    if (out.length > 0)
      violations.push({
        message: tr(
          `${p.caption.id} overflows: ${out.join(", ")}`,
          `${p.caption.id} déborde : ${out.join(", ")}`,
        ),
        frame: p.caption.fromFrame,
      });
  }
  return graded("captions.safe-zones", timeline.placed.length, violations, {
    captions: timeline.placed.length,
    safeArea: profileSafeArea(profile),
  });
}

/** sRGB colour from a CSS hex or rgb()/rgba() string. */
export function parseColor(css: string): [number, number, number] {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(css.trim());
  if (hex) {
    const h = hex[1] as string;
    const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
    return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
  }
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(css.trim());
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  throw new Error(`couleur non reconnue : ${css}`);
}

/** WCAG 2 relative luminance of an sRGB colour (0–255 channels). */
export function luminance([r, g, b]: readonly number[]): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r as number) + 0.7152 * lin(g as number) + 0.0722 * lin(b as number);
}

export function contrastRatio(a: readonly number[], b: readonly number[]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** How many captions the pixel measurement samples, spread over the video. */
const CONTRAST_SAMPLES = 12;
/** Fewest core pixels a class needs to be measured. */
const MIN_PIXELS = 30;

const CLASSES = { stroke: 0, fill: 1, active: 2 } as const;

/** Pixels of each paint of a caption at frame f: drawn in pure colours, kept only well inside each area. */
function captionMasks(timeline: CaptionTimeline, f: number, W: number, H: number): Int8Array {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
  ctx.antialias = "none";
  timeline.draw(ctx, f, f, { stroke: "#ff0000", fill: "#00ff00", activeFill: "#0000ff", shadow: false });
  const px = canvas.toBuffer("raw"); // BGRA
  const raw = new Int8Array(W * H).fill(-1);
  for (let i = 0; i < W * H; i++) {
    const b = px[i * 4] as number;
    const g = px[i * 4 + 1] as number;
    const r = px[i * 4 + 2] as number;
    if (r === 255 && g === 0 && b === 0) raw[i] = CLASSES.stroke;
    else if (g === 255 && r === 0 && b === 0) raw[i] = CLASSES.fill;
    else if (b === 255 && r === 0 && g === 0) raw[i] = CLASSES.active;
  }
  // Erosion (radius 1): edges are blurred by chroma subsampling and compression.
  const mask = new Int8Array(W * H).fill(-1);
  for (let y = 1; y < H - 1; y++)
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const c = raw[i] as number;
      if (c < 0) continue;
      let keep = true;
      for (let dy = -1; dy <= 1 && keep; dy++)
        for (let dx = -1; dx <= 1; dx++)
          if (raw[i + dy * W + dx] !== c) {
            keep = false;
            break;
          }
      if (keep) mask[i] = c;
    }
  return mask;
}

/** A frame where the caption is fully in (entry over) and still on screen. */
function sampleFrame(p: PlacedCaption): number {
  const settled = p.caption.fromFrame + (p.entry?.frames ?? 0) + 1;
  return Math.min(p.caption.toFrame - 1, settled);
}

/**
 * Contrast (WCAG ≥ 4.5:1 by default): the text colours against their outline,
 * from the style, then measured on the rendered pixels — mean colour of the
 * letters vs mean colour of their outline, on sampled captions. A style must
 * also draw an outline wide enough to separate letters from any background.
 */
export async function checkCaptionContrast(
  video: string,
  edl: Edl,
  profile: StyleProfile,
  registry: PresetRegistry,
): Promise<CheckResult> {
  if (edl.captions.length === 0)
    return notEvaluated("captions.contrast", tr("no captions", "aucun sous-titre"));
  const min = profile.captions.minContrast;
  const timeline = new CaptionTimeline(edl, registry);
  const violations: Violation[] = [];
  let items = 0;

  const styles = new Map<string, { style: CaptionStyle; p: PlacedCaption }>();
  for (const p of timeline.placed)
    if (!styles.has(p.caption.style)) styles.set(p.caption.style, { style: p.style, p });
  for (const [ref, { style, p }] of styles) {
    const stroke = parseColor(style.stroke.color);
    for (const [label, color] of [
      ["texte", style.fill],
      ["mot actif", style.activeFill],
    ] as const) {
      items++;
      const ratio = contrastRatio(parseColor(color), stroke);
      if (ratio < min) violations.push({ message: `${ref} : ${label}/contour ${ratio.toFixed(2)}:1` });
    }
    items++;
    // Visible outline outside the letters: half the stroke; at least 5 % of the font size and 1.5 px.
    const ring = p.layout.strokePx / 2;
    if (ring < Math.max(1.5, 0.05 * p.layout.fontPx))
      violations.push({
        message: tr(
          `${ref}: ${ring.toFixed(1)} px outline, too thin to separate the text from the background`,
          `${ref} : contour de ${ring.toFixed(1)} px, trop fin pour isoler le texte du fond`,
        ),
      });
  }

  // Pixels: the encoded letters must still stand out from their encoded outline.
  const { width: W, height: H } = edl.output;
  const step = Math.max(1, timeline.placed.length / CONTRAST_SAMPLES);
  const picked: PlacedCaption[] = [];
  for (let k = 0; k < timeline.placed.length && picked.length < CONTRAST_SAMPLES; k += step)
    picked.push(timeline.placed[Math.floor(k)] as PlacedCaption);
  const frames = picked.map(sampleFrame);
  const select = frames.map((f) => `eq(n\\,${f})`).join("+");
  const decoded: Buffer[] = [];
  await streamFrames(
    [
      ...mediaInput(video),
      "-map",
      "0:v:0",
      "-vf",
      `select='${select}',scale=in_color_matrix=bt709:in_range=tv,format=rgb24`,
      "-fps_mode",
      "passthrough",
      "-f",
      "rawvideo",
      "-",
    ],
    W * H * 3,
    (frame) => decoded.push(Buffer.from(frame)),
  );
  let worst = Number.POSITIVE_INFINITY;
  picked.forEach((p, k) => {
    const frame = decoded[k];
    if (!frame) return;
    const mask = captionMasks(timeline, frames[k] as number, W, H);
    const sums = [0, 1, 2].map(() => [0, 0, 0, 0]);
    for (let i = 0; i < mask.length; i++) {
      const c = mask[i] as number;
      if (c < 0) continue;
      const s = sums[c] as number[];
      s[0] = (s[0] as number) + (frame[i * 3] as number);
      s[1] = (s[1] as number) + (frame[i * 3 + 1] as number);
      s[2] = (s[2] as number) + (frame[i * 3 + 2] as number);
      s[3] = (s[3] as number) + 1;
    }
    const mean = (s: number[]) => s.slice(0, 3).map((v) => v / (s[3] as number));
    const stroke = sums[CLASSES.stroke] as number[];
    if ((stroke[3] as number) < MIN_PIXELS) return;
    for (const cls of [CLASSES.fill, CLASSES.active]) {
      const s = sums[cls] as number[];
      if ((s[3] as number) < MIN_PIXELS) continue;
      items++;
      const ratio = contrastRatio(mean(s), mean(stroke));
      worst = Math.min(worst, ratio);
      if (ratio < min)
        violations.push({
          message: tr(
            `${p.caption.id}: measured contrast ${ratio.toFixed(2)}:1 (${cls === CLASSES.active ? "active word" : "text"})`,
            `${p.caption.id} : contraste mesuré ${ratio.toFixed(2)}:1 (${cls === CLASSES.active ? "mot actif" : "texte"})`,
          ),
          frame: frames[k],
        });
    }
  });
  return graded("captions.contrast", items, violations, {
    sampled: picked.length,
    worstMeasured: Number.isFinite(worst) ? Math.round(worst * 100) / 100 : null,
  });
}
