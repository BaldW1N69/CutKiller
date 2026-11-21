import type { EdlInput, StyleProfile } from "@cutkiller/core";
import { type CaptionStyle, displayText, hasLetters, punctuationAfter } from "./style";
import type { TimelineWord } from "./words";

type CaptionInput = EdlInput["captions"] extends (infer C)[] | undefined ? C : never;

/** A word ready to be shown: its on-screen text and why a caption may end after it. */
interface ShownWord extends TimelineWord {
  shown: string;
  punct: "strong" | "weak" | undefined;
}

const norm = (text: string) =>
  text
    .toLowerCase()
    .replace(/’/g, "'")
    .replace(/[^\p{L}\p{N}'-]+/gu, "");

/** Lone punctuation tokens are glued to the previous word (or dropped by the style). */
function shownWords(words: TimelineWord[], style: CaptionStyle): ShownWord[] {
  const out: ShownWord[] = [];
  for (const w of words) {
    if (!hasLetters(w.text)) {
      const prev = out.at(-1);
      if (prev) {
        prev.punct = punctuationAfter(w.text) ?? prev.punct;
        if (!style.stripPunctuation) prev.shown = displayText(style, `${prev.text}${w.text}`);
        prev.text += w.text;
      }
      continue;
    }
    const shown = displayText(style, w.text);
    if (shown === "") continue;
    out.push({ ...w, shown, punct: punctuationAfter(w.text) });
  }
  return out;
}

const lineLength = (words: { shown: string }[]) =>
  words.reduce((n, w, i) => n + w.shown.length + (i > 0 ? 1 : 0), 0);

/**
 * Splits a caption's words into at most `maxLines` lines of at most `maxChars`
 * characters: one line when it fits, else the most balanced two-line split that
 * does not leave a function word dangling at the end of the first line (the
 * bottom line may be the longer one, as in subtitling practice).
 */
export function splitLines(
  words: { shown: string; text: string }[],
  maxLines: number,
  maxChars: number,
  stopWords: ReadonlySet<string>,
  /** Refuse a split that ends the first line on a function word. */
  strict = false,
): number[] | undefined {
  if (lineLength(words) <= maxChars) return words.map(() => 0);
  if (maxLines < 2) return undefined;
  let best: { k: number; cost: number } | undefined;
  for (let k = 1; k < words.length; k++) {
    const a = lineLength(words.slice(0, k));
    const b = lineLength(words.slice(k));
    if (a > maxChars || b > maxChars) continue;
    const lastOfFirst = words[k - 1] as { text: string };
    const dangling = stopWords.has(norm(lastOfFirst.text));
    if (dangling && strict) continue;
    let cost = Math.abs(a - b) + (a > b ? 2 : 0);
    if (dangling) cost += 25;
    if (punctuationAfter(lastOfFirst.text)) cost -= 8;
    if (!best || cost < best.cost) best = { k, cost };
  }
  if (!best) return undefined;
  const k = best.k;
  return words.map((_, i) => (i < k ? 0 : 1));
}

/**
 * Groups the spoken words into caption screens, following the profile: a new
 * screen at a pause, after end-of-sentence punctuation (and commas for 1–3 word
 * screens), or when the next word would not fit (words per screen, lines,
 * characters, duration). A screen never ends on a function word when it can
 * hand it to the next one. Each screen stays up until the next one, or for a
 * short hold after its last word.
 */
export function buildCaptions(
  words: TimelineWord[],
  style: CaptionStyle,
  styleRef: string,
  profile: StyleProfile,
  fps: number,
  totalFrames: number,
): CaptionInput[] {
  const c = profile.captions;
  const maxWords = c.wordsPerScreen?.[1] ?? Number.POSITIVE_INFINITY;
  const shortForm = c.wordsPerScreen !== undefined;
  const stopWords = new Set(profile.motion.stopWords.map(norm));
  const maxFrames = Math.round(c.maxDurationS * fps);
  const pause = (c.pauseBreakMs / 1000) * fps;
  // A screen is only "full enough" if its lines can break cleanly: rather than
  // leave « je » dangling at the end of a line, the next screen starts earlier.
  const fits = (ws: ShownWord[]) =>
    splitLines(ws, c.maxLines, c.maxCharsPerLine, stopWords, true) !== undefined ||
    (ws.length <= 1 && splitLines(ws, c.maxLines, c.maxCharsPerLine, stopWords) !== undefined);

  const groups: ShownWord[][] = [];
  let current: ShownWord[] = [];
  for (const w of shownWords(words, style)) {
    const prev = current.at(-1);
    if (prev) {
      const filled = lineLength(current) >= c.commaBreakFill * c.maxLines * c.maxCharsPerLine;
      const natural =
        w.fromFrame - prev.toFrame >= pause ||
        prev.punct === "strong" ||
        (prev.punct === "weak" && (shortForm || filled));
      const full =
        current.length >= maxWords ||
        !fits([...current, w]) ||
        w.toFrame - (current[0] as ShownWord).fromFrame > maxFrames;
      // A break needs the next word to start on a later frame than the last one shown.
      if ((natural || full) && w.fromFrame > prev.fromFrame) {
        const next: ShownWord[] = [];
        if (!natural && current.length > 1 && stopWords.has(norm(prev.text))) {
          const moved = current.pop() as ShownWord;
          if (moved.fromFrame > (current.at(-1) as ShownWord).fromFrame) next.push(moved);
          else current.push(moved);
        }
        groups.push(current);
        current = next;
      }
    }
    current.push(w);
    // Handing a word over can overfill the next screen: split it again if needed.
    while (current.length > maxWords || !fits(current)) {
      const head = current.slice(0, -1);
      const tail = current.at(-1) as ShownWord;
      if (head.length === 0 || tail.fromFrame <= (head.at(-1) as ShownWord).fromFrame) break;
      groups.push(head);
      current = current.slice(-1);
    }
  }
  if (current.length > 0) groups.push(current);
  const minFrames = Math.round((c.minDurationMs / 1000) * fps);
  // A screen that would flash may end on a function word: the lesser evil.
  const fitsLoose = (ws: ShownWord[]) =>
    splitLines(ws, c.maxLines, c.maxCharsPerLine, stopWords) !== undefined;
  mergeShortScreens(groups, c.wordsPerScreen?.[0] ?? 1, maxWords, maxFrames, minFrames, fps, fits, fitsLoose);

  const hold = Math.round((c.holdMs / 1000) * fps);
  const closeGap = Math.round(0.25 * fps);
  return groups.map((group, k) => {
    const first = group[0] as ShownWord;
    const last = group.at(-1) as ShownWord;
    const next = groups[k + 1]?.[0];
    const limit = next ? next.fromFrame : totalFrames;
    let to = Math.min(limit, Math.max(last.toFrame + hold, first.fromFrame + minFrames));
    if (next && limit - to < closeGap) to = limit;
    to = Math.max(to, last.fromFrame + 1);
    const lines = splitLines(group, c.maxLines, c.maxCharsPerLine, stopWords) ?? group.map(() => 0);
    return {
      id: `k${String(k + 1).padStart(3, "0")}`,
      style: styleRef,
      fromFrame: first.fromFrame,
      toFrame: to,
      words: group.map((w, i) => ({
        text: w.shown,
        fromFrame: w.fromFrame,
        toFrame: Math.max(w.fromFrame + 1, Math.min(w.toFrame, to)),
        line: lines[i] as number,
        source: w.source,
        wordId: w.wordId,
      })),
    };
  });
}

/**
 * Screens with fewer words than the profile's minimum (a lone word between two
 * pauses) join the neighbour they are closest to in time, when the pause between
 * them stays under 1 s. If the joined screen is too full (words, lines,
 * duration), it is split again in two screens of at least the minimum, at the
 * widest pause between words. Otherwise the screen stays as it is.
 *
 * Screens on view for less than `minFrames` before the next one replaces them
 * (fast speech: « C'EST » → « ON VA » → « AVOIR » in 0.7 s) cannot be read: they
 * join a neighbour when the joined screen fits as one, never across the end of
 * a sentence.
 */
function mergeShortScreens(
  groups: ShownWord[][],
  minWords: number,
  maxWords: number,
  maxFrames: number,
  minFrames: number,
  fps: number,
  fits: (ws: ShownWord[]) => boolean,
  fitsLoose: (ws: ShownWord[]) => boolean = fits,
): void {
  let loose = false;
  const ok = (ws: ShownWord[]) =>
    ws.length >= minWords &&
    ws.length <= maxWords &&
    (loose ? fitsLoose(ws) : fits(ws)) &&
    (ws.at(-1) as ShownWord).toFrame - (ws[0] as ShownWord).fromFrame <= maxFrames;
  /**
   * The joined words as one screen, or two, or undefined when neither fits. With
   * `minView`, two screens only when the first stays up that long.
   */
  const regroup = (ws: ShownWord[], minView = 0): ShownWord[][] | undefined => {
    if (ok(ws)) return [ws];
    let best: { at: number; score: number } | undefined;
    for (let at = minWords; at <= ws.length - minWords; at++) {
      const a = ws.slice(0, at);
      const b = ws.slice(at);
      const start = (b[0] as ShownWord).fromFrame;
      if (!ok(a) || !ok(b) || start <= (a.at(-1) as ShownWord).fromFrame) continue;
      if (start - (a[0] as ShownWord).fromFrame < minView) continue;
      const gap = start - (a.at(-1) as ShownWord).toFrame;
      const score = gap - Math.abs(a.length - b.length) * 0.01;
      if (!best || score > best.score) best = { at, score };
    }
    return best ? [ws.slice(0, best.at), ws.slice(best.at)] : undefined;
  };
  /** Frames a screen stays up before the next one replaces it. */
  const onView = (k: number) => {
    const next = groups[k + 1];
    return next
      ? (next[0] as ShownWord).fromFrame - ((groups[k] as ShownWord[])[0] as ShownWord).fromFrame
      : Infinity;
  };
  const endsSentence = (ws: ShownWord[]) => (ws.at(-1) as ShownWord).punct === "strong";
  for (let k = 0; k < groups.length; k++) {
    const g = groups[k] as ShownWord[];
    const fewWords = g.length < minWords;
    if (!fewWords && onView(k) >= minFrames) continue;
    const prev = groups[k - 1];
    const next = groups[k + 1];
    const options = [
      prev && {
        gap: (g[0] as ShownWord).fromFrame - (prev.at(-1) as ShownWord).toFrame,
        at: k - 1,
        ws: [...prev, ...g],
      },
      next && {
        gap: (next[0] as ShownWord).fromFrame - (g.at(-1) as ShownWord).toFrame,
        at: k,
        ws: [...g, ...next],
      },
    ]
      .filter((o): o is { gap: number; at: number; ws: ShownWord[] } => !!o && o.gap <= fps)
      .filter((o) => fewWords || !endsSentence(groups[o.at] as ShownWord[]))
      .sort((a, b) => a.gap - b.gap)
      .map((o) => {
        if (fewWords) return { ...o, screens: regroup(o.ws) };
        // Readable means on view for the minimum, give or take the frame QA tolerates.
        const view = minFrames - 1;
        // A regrouping that gives the brief screen back unchanged fixes nothing.
        const changes = (sc: ShownWord[][] | undefined) =>
          sc?.some((x) => x[0] === g[0] && x.length === g.length) ? undefined : sc;
        let screens = changes(regroup(o.ws, view));
        if (!screens) {
          loose = true;
          screens = changes(regroup(o.ws, view));
          loose = false;
        }
        return { ...o, screens };
      });
    const best = options.find((o) => o.screens);
    if (!best?.screens) continue;
    groups.splice(best.at, 2, ...best.screens);
    k = best.at + best.screens.length - 1;
  }
}
