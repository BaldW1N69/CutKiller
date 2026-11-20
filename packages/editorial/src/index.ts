/**
 * Editorial director: decides *what* to keep and in which order, before the cut
 * pass decides *how* to cut it. A long recording becomes N Shorts, each built
 * from whole sentences, opening on its strongest line.
 *
 * Two planners share one output shape:
 * - `heuristicShorts`: free, offline, deterministic — scores sentences on what
 *   retention research and editors agree on (a question or a number up front,
 *   direct address, intensifiers, complete thoughts, no rambling);
 * - `claudeShorts`: Claude reads the numbered transcript and picks the clips,
 *   their hook and title (needs Anthropic credentials; falls back to the
 *   heuristic when there are none or the call fails).
 *
 * The plan is a list of source time ranges (`Selection`): `applySelection` turns
 * it into the main track of an EDL, and every later pass — word-accurate cuts,
 * captions, sound, QA — works on it unchanged.
 */
import type { Edl, Transcript, Word } from "@cutkiller/core";
import { lexicon } from "@cutkiller/core";

export interface Sentence {
  id: number;
  source: string;
  start: number;
  end: number;
  text: string;
  words: Word[];
}

/** One kept passage of a source, in seconds. */
export interface Range {
  source: string;
  start: number;
  end: number;
}

export interface ShortPlan {
  title: string;
  /** The opening line, what makes a viewer stay. */
  hook: string;
  sentenceIds: number[];
  ranges: Range[];
  durationS: number;
  /** 0–10 each. */
  scores: { hook: number; retention: number; clarity: number };
  why: string;
  planner: "heuristic" | "claude";
}

export interface ShortsOptions {
  count?: number;
  minS?: number;
  maxS?: number;
  language?: string;
}

const TERMINAL = /[.!?…]["»”)]?$/;
const PAUSE_S = 0.7;

/** Sentences of each transcript, in time order: split on final punctuation or a long pause. */
export function sentences(transcripts: Readonly<Record<string, Transcript>>): Sentence[] {
  const out: Sentence[] = [];
  for (const [source, t] of Object.entries(transcripts)) {
    let cur: Word[] = [];
    const flush = () => {
      if (cur.length === 0) return;
      const first = cur[0] as Word;
      const last = cur[cur.length - 1] as Word;
      out.push({
        id: out.length,
        source,
        start: first.start,
        end: last.end,
        text: cur.map((w) => w.text).join(" "),
        words: cur,
      });
      cur = [];
    };
    for (const [i, w] of t.words.entries()) {
      const next = t.words[i + 1];
      cur.push(w);
      if (TERMINAL.test(w.text) || !next || next.start - w.end > PAUSE_S) flush();
    }
    flush();
  }
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}'’-]+/gu, "");
const DIRECT = new Set([
  "you",
  "your",
  "vous",
  "tu",
  "toi",
  "votre",
  "ton",
  "tú",
  "usted",
  "du",
  "ihr",
  "voi",
  "você",
]);

/** 0–10: how well a sentence opens a Short. */
export function hookScore(s: Sentence, language?: string): number {
  const lex = lexicon(language);
  const words = s.words.map((w) => norm(w.text)).filter(Boolean);
  if (words.length === 0) return 0;
  const fillers = new Set(lex.fillerWords);
  const emphasis = new Set(lex.emphasisWords);
  let score = 4;
  if (/\?["»”)]?$/.test(s.text)) score += 2;
  if (words.some((w) => /\d/.test(w))) score += 1.5;
  if (words.some((w) => emphasis.has(w))) score += 1.5;
  if (words.some((w) => DIRECT.has(w))) score += 1;
  if (TERMINAL.test(s.text)) score += 0.5;
  if (words.length < 4) score -= 2;
  if (words.length > 30) score -= 1.5;
  score -= 3 * (words.filter((w) => fillers.has(w)).length / words.length);
  return Math.max(0, Math.min(10, score));
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/** Sentences as source ranges with a little air around speech; neighbours of one source merge. */
export function toRanges(chosen: Sentence[]): Range[] {
  const ranges: Range[] = [];
  for (const s of chosen) {
    const start = Math.max(0, s.start - 0.25);
    const end = s.end + 0.35;
    const last = ranges[ranges.length - 1];
    if (last && last.source === s.source && start - last.end < 1.5) last.end = Math.max(last.end, end);
    else ranges.push({ source: s.source, start, end });
  }
  return ranges;
}

const duration = (ss: Sentence[]) => ss.reduce((d, s) => d + (s.end - s.start), 0);

/** Offline planner: the best windows of consecutive sentences, never overlapping. */
export function heuristicShorts(all: readonly Sentence[], opts: ShortsOptions = {}): ShortPlan[] {
  const { count = 5, minS = 15, maxS = 60, language } = opts;
  const hook = all.map((s) => hookScore(s, language));
  const candidates: { from: number; to: number; score: number; hook: number; mean: number }[] = [];
  for (let i = 0; i < all.length; i++) {
    for (let j = i; j < all.length; j++) {
      const span = all.slice(i, j + 1);
      if ((all[j] as Sentence).source !== (all[i] as Sentence).source) break;
      const d = duration(span);
      if (d > maxS) break;
      if (d < minS) continue;
      const mean = span.reduce((m, _, k) => m + (hook[i + k] as number), 0) / span.length;
      const ends = TERMINAL.test((all[j] as Sentence).text) ? 1 : 0;
      candidates.push({
        from: i,
        to: j,
        hook: hook[i] as number,
        mean,
        score: 2 * (hook[i] as number) + mean + ends,
      });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const used = new Set<number>();
  const plans: ShortPlan[] = [];
  for (const c of candidates) {
    if (plans.length >= count) break;
    const ids = Array.from({ length: c.to - c.from + 1 }, (_, k) => c.from + k);
    if (ids.some((id) => used.has(id))) continue;
    for (const id of ids) used.add(id);
    const span = ids.map((id) => all[id] as Sentence);
    const first = span[0] as Sentence;
    plans.push({
      title: titleFrom(first.text),
      hook: first.text,
      sentenceIds: ids,
      ranges: toRanges(span),
      durationS: round1(duration(span)),
      scores: {
        hook: round1(c.hook),
        retention: round1(c.mean),
        clarity: round1(TERMINAL.test(span[span.length - 1]?.text ?? "") ? 8 : 5),
      },
      why: "heuristic: strongest opening line, complete sentences, dense in emphasis",
      planner: "heuristic",
    });
  }
  return plans;
}

/**
 * Cut-down to a target duration (a 60 s version of a 10 min video): the best
 * sentences until the target is reached, in their original order, except the
 * strongest hook, which opens the edit. Sentences that are mostly hesitation
 * or shorter than three words are never picked.
 */
export function heuristicCutdown(
  all: readonly Sentence[],
  targetS: number,
  opts: { language?: string } = {},
): ShortPlan {
  const scored = all
    .map((s) => ({ s, score: hookScore(s, opts.language) }))
    .filter(({ s }) => s.words.length >= 3);
  const ranked = [...scored].sort((a, b) => b.score - a.score);
  const chosen: Sentence[] = [];
  let total = 0;
  for (const { s } of ranked) {
    const d = s.end - s.start;
    if (total + d > targetS) continue;
    chosen.push(s);
    total += d;
    if (total > targetS * 0.95) break;
  }
  const hook = ranked[0]?.s;
  const ordered = chosen.filter((s) => s !== hook).sort((a, b) => a.id - b.id);
  const span = hook && chosen.includes(hook) ? [hook, ...ordered] : ordered;
  const first = span[0];
  return {
    title: first ? titleFrom(first.text) : "",
    hook: first?.text ?? "",
    sentenceIds: span.map((s) => s.id),
    ranges: toRanges(span),
    durationS: round1(duration(span)),
    scores: {
      hook: round1(first ? hookScore(first, opts.language) : 0),
      retention: round1(span.reduce((m, s) => m + hookScore(s, opts.language), 0) / Math.max(1, span.length)),
      clarity: 6,
    },
    why: `heuristic cut-down: the ${span.length} strongest sentences within ${targetS} s, strongest hook first`,
    planner: "heuristic",
  };
}

function titleFrom(text: string): string {
  const words = text
    .replace(/[«»"“”]/g, "")
    .split(/\s+/)
    .slice(0, 8)
    .join(" ");
  return words.replace(/[,;:.…!?]+$/, "");
}

/** Builds a plan from sentence ids chosen elsewhere (Claude), keeping only valid, in-range ids. */
export function planFromIds(
  all: readonly Sentence[],
  pick: { title: string; hook: string; sentence_ids: number[]; why: string; scores: ShortPlan["scores"] },
  opts: ShortsOptions = {},
): ShortPlan | undefined {
  const ids = [...new Set(pick.sentence_ids)].filter(
    (id) => Number.isInteger(id) && id >= 0 && id < all.length,
  );
  if (ids.length === 0) return undefined;
  const span = ids.map((id) => all[id] as Sentence);
  const d = duration(span);
  if (d > (opts.maxS ?? 60) * 1.25) return undefined;
  return {
    title: pick.title,
    hook: pick.hook,
    sentenceIds: ids,
    ranges: toRanges(span),
    durationS: round1(d),
    scores: pick.scores,
    why: pick.why,
    planner: "claude",
  };
}

/**
 * The EDL with its main track replaced by the selected ranges, in order. Each range
 * becomes one clip; the cut pass then removes silences and hesitations inside it.
 */
export function applySelection(edl: Edl, ranges: readonly Range[]): Edl {
  const fps = edl.output.fps;
  const main = edl.video[0];
  if (!main || ranges.length === 0) return edl;
  let at = 0;
  const clips = ranges.map((r, i) => {
    const template = main.clips.find((c) => c.source === r.source) ?? main.clips[0];
    if (!template) throw new Error(`selection: no clip of source « ${r.source} » on the main track`);
    const durationS = edl.sources[r.source]?.durationS ?? r.end;
    const clip = {
      ...template,
      id: `s${String(i + 1).padStart(2, "0")}`,
      source: r.source,
      in: Math.max(0, Math.round(r.start * 1000) / 1000),
      out: Math.min(durationS, Math.round(r.end * 1000) / 1000),
      at,
      why: { kind: "selection", note: `editorial selection ${i + 1}/${ranges.length}` },
    };
    at += Math.round((clip.out - clip.in) * fps);
    return clip;
  });
  return { ...edl, video: [{ ...main, clips }, ...edl.video.slice(1)] };
}

export { type ClaudeLike, claudeShorts, hasAnthropicCredentials } from "./claude";
