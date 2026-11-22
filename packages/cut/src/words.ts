import {
  type StyleProfile,
  TRUNCATED_ALIGN_SCORE,
  truncatedEdges,
  type VoiceActivity,
  type Word,
} from "@cutkiller/core";

export type Removal = "filler" | "contextual-filler" | "repeat" | "truncated";

export interface Token {
  /** Position in the token list. */
  i: number;
  /** Index of the word in the source transcript (what `why.wordIds` refers to). */
  id: number;
  word: Word;
  norm: string;
  removed?: Removal;
}

/** Lower-case, strip punctuation (keeps inner apostrophes and hyphens). */
export function normalizeWord(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[^\p{L}\p{N}'-]+/gu, "")
    .replace(/^['-]+|['-]+$/g, "");
}

/** Whisper writes a trailing ellipsis or comma where the speaker hesitates. */
const hesitationMark = (text: string) => /(…|\.\.\.|,)\s*$/.test(text);

export function classifyWords(
  words: readonly Word[],
  profile: StyleProfile,
  ids?: readonly number[],
): Token[] {
  const m = profile.montage;
  const fillers = new Set(m.fillerWords.map(normalizeWord));
  const contextual = m.contextualFillers.map((f) => f.split(/\s+/).map(normalizeWord));
  const pause = m.contextualPauseMs / 1000;
  const tokens: Token[] = words.map((word, i) => ({
    i,
    id: ids?.[i] ?? i,
    word,
    norm: normalizeWord(word.text),
  }));

  for (const t of tokens) if (t.norm === "" || fillers.has(t.norm)) t.removed = "filler";

  // Contextual fillers (« donc », « en fait »…): only when a pause or a hesitation isolates them.
  const gapBefore = (k: number) =>
    k === 0 ? Number.POSITIVE_INFINITY : tokens[k]!.word.start - tokens[k - 1]!.word.end;
  const gapAfter = (k: number) =>
    k === tokens.length - 1 ? Number.POSITIVE_INFINITY : tokens[k + 1]!.word.start - tokens[k]!.word.end;
  for (let k = 0; k < tokens.length; k++) {
    for (const phrase of contextual) {
      const n = phrase.length;
      if (k + n > tokens.length) continue;
      if (!phrase.every((p, j) => tokens[k + j]!.norm === p && !tokens[k + j]!.removed)) continue;
      const last = k + n - 1;
      const isolatedBefore = gapBefore(k) >= pause || tokens[k - 1]?.removed === "filler";
      const isolatedAfter =
        gapAfter(last) >= pause ||
        tokens[last + 1]?.removed === "filler" ||
        hesitationMark(tokens[last]!.word.text);
      if (isolatedBefore && isolatedAfter)
        for (let j = k; j <= last; j++) tokens[j]!.removed = "contextual-filler";
    }
  }

  // False starts: a phrase immediately said again. The first take goes.
  const kept = () => tokens.filter((t) => !t.removed);
  for (let n = m.repetitionMaxWords; n >= 1; n--) {
    const list = kept();
    for (let k = 0; k + 2 * n <= list.length; k++) {
      const a = list.slice(k, k + n);
      const b = list.slice(k + n, k + 2 * n);
      if (a.some((t) => t.removed) || !a.every((t, j) => t.norm === b[j]!.norm)) continue;
      const lastOfA = a[n - 1]!;
      // A single repeated word is often emphasis (« très très »): only cut it when the speaker stumbled.
      if (n === 1 && !hesitationMark(lastOfA.word.text) && b[0]!.word.start - lastOfA.word.end < 0.15)
        continue;
      for (const t of a) t.removed = "repeat";
    }
  }
  return tokens;
}

/** Gap enforced between a kept word and removed material that overlapped it. */
const SEPARATION_S = 0.012;

/**
 * ASR and forced alignment can return overlapping words, notably a hesitation
 * carved out of the word that swallowed it. Kept words win: removed material is
 * pushed off them, or dropped when it lies entirely inside a kept word (it cannot
 * be cut without cutting the word).
 */
export function resolveOverlaps(tokens: Token[]): Token[] {
  const sorted = [...tokens].sort((a, b) => a.word.start - b.word.start);
  const out: Token[] = [];
  for (const cur of sorted) {
    const prev = out.at(-1);
    if (!prev || prev.word.end <= cur.word.start - 0.005) {
      out.push({ ...cur, word: { ...cur.word } });
      continue;
    }
    const a = prev.word;
    const b = { ...cur.word };
    if (prev.removed && !cur.removed) {
      a.end = b.start - SEPARATION_S;
      if (a.end - a.start < 0.02) out.pop();
    } else if (!prev.removed && cur.removed) {
      b.start = a.end + SEPARATION_S;
      if (b.end - b.start < 0.02) continue;
    } else {
      const mid = (a.end + b.start) / 2;
      a.end = mid - SEPARATION_S / 2;
      b.start = mid + SEPARATION_S / 2;
    }
    out.push({ ...cur, word: b });
  }
  return out.map((t, i) => ({ ...t, i }));
}

/**
 * The speech view shared by the cut pass and the QA: punctuation-only tokens and
 * words the VAD never heard (ASR hallucinations) dropped, words classified,
 * overlaps resolved. `id` keeps the index in the source transcript.
 */
export function speechTokens(
  words: readonly Word[],
  speech: readonly { start: number; end: number }[] | undefined,
  profile: StyleProfile,
  /** The rush's voice activity: a word the recording cuts off is never kept. */
  vad?: VoiceActivity,
): { tokens: Token[]; hallucinated: number } {
  const pad = 0.15;
  const heard = (w: Word) => !speech || speech.some((s) => w.end > s.start - pad && w.start < s.end + pad);
  const ids = words.flatMap((w, i) => (normalizeWord(w.text) !== "" && heard(w) ? [i] : []));
  const hallucinated = words.filter((w) => normalizeWord(w.text) !== "" && !heard(w)).length;
  const tokens = classifyWords(
    ids.map((i) => words[i] as Word),
    profile,
    ids,
  );
  const cut = truncatedEdges(vad);
  if (vad)
    for (const t of tokens) {
      const atStart = t.word.start <= EDGE_S;
      const atEnd = t.word.end >= vad.durationS - EDGE_S;
      const unfit = t.word.alignScore !== undefined && t.word.alignScore < TRUNCATED_ALIGN_SCORE;
      if ((atStart && (cut.start || unfit)) || (atEnd && (cut.end || unfit))) t.removed = "truncated";
    }
  return { tokens: resolveOverlaps(tokens), hallucinated };
}

/** A word this close to the start or end of a recording cut mid-word is the cut one. */
const EDGE_S = 0.1;
