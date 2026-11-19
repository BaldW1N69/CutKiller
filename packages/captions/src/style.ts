import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { PresetResolver } from "@cutkiller/core";
import { registerFont } from "canvas";
import { z } from "zod";

/** Repository root: font files in caption presets are relative to it. */
export const ASSETS_ROOT = resolve(import.meta.dirname, "../../..");

const Color = z.string().min(1);

export const CaptionStyleSchema = z.object({
  font: z.object({
    /** OFL font file, relative to the repository root. */
    file: z.string(),
    family: z.string(),
    weight: z.string().default("400"),
  }),
  /** Font size as a fraction of the output height. */
  sizeRel: z.number().positive().max(0.2),
  lineHeight: z.number().positive().default(1.2),
  uppercase: z.boolean().default(false),
  /** Short-form look: no punctuation on screen. */
  stripPunctuation: z.boolean().default(false),
  fill: Color,
  /** Colour of the word being spoken (karaoke highlight). */
  activeFill: Color,
  stroke: z.object({
    color: Color,
    /** Outline width as a fraction of the font size (drawn centred on the glyph edge). */
    widthRel: z.number().nonnegative(),
  }),
  shadow: z
    .object({ color: Color, blurRel: z.number().nonnegative(), offsetYRel: z.number().default(0) })
    .optional(),
  /** Motion preset played when the caption appears. */
  entry: z.string().optional(),
});

export type CaptionStyle = z.infer<typeof CaptionStyleSchema>;

export function captionStyle(presets: PresetResolver, ref: string): CaptionStyle {
  const preset = presets.resolve(ref);
  if (preset.kind !== "captions") throw new Error(`${ref} n'est pas un style de sous-titres`);
  return CaptionStyleSchema.parse(preset.params);
}

const registered = new Set<string>();

/** Family name the canvas knows the style's font by (registered once per file). */
export function fontFamily(style: CaptionStyle): string {
  const family = `CK ${style.font.family} ${style.font.weight}`;
  if (!registered.has(family)) {
    const path = resolve(ASSETS_ROOT, style.font.file);
    if (!existsSync(path)) throw new Error(`police introuvable : ${style.font.file}`);
    registerFont(path, { family, weight: style.font.weight });
    registered.add(family);
  }
  return family;
}

/** CSS font shorthand for a size in pixels. */
export const fontCss = (style: CaptionStyle, px: number) =>
  `${style.font.weight} ${px.toFixed(2)}px "${fontFamily(style)}"`;

const STRONG = /[.?!…]["»”)]*$/;
const WEAK = /[,;:]["»”)]*$/;

/** End-of-word punctuation, from the transcript text (before the style strips it). */
export function punctuationAfter(text: string): "strong" | "weak" | undefined {
  if (STRONG.test(text)) return "strong";
  if (WEAK.test(text)) return "weak";
  return undefined;
}

/** Text as the style shows it ("" when nothing is left, e.g. a lone punctuation mark). */
export function displayText(style: CaptionStyle, text: string): string {
  let out = text.replace(/’/g, "'").trim();
  if (style.stripPunctuation) out = out.replace(/[^\p{L}\p{N}'-]+/gu, "").replace(/^['-]+|['-]+$/g, "");
  if (style.uppercase) out = out.toLocaleUpperCase("fr-FR");
  return out;
}

export const hasLetters = (text: string) => /[\p{L}\p{N}]/u.test(text);
