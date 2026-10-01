import type { StyleProfile } from "@cutkiller/core";
import type { Token } from "./words";

/** Silence kept between a kept word and removed material, so neither bleeds into the cut. */
const GUARD_S = 0.01;

export interface Run {
  words: Token[];
  /** Removed material right before this run (for the clip's `why.note`). */
  removedBefore: Token[];
  silenceBeforeS: number;
  head: number;
  tail: number;
  headRange: [number, number];
  tailRange: [number, number];
}

export interface PlannedClip {
  in: number;
  out: number;
  /** Output frames. */
  frames: number;
  kind: "speech" | "zoom-cut";
  wordIds: number[];
  note?: string;
  scale: number;
}

export interface PlanInput {
  tokens: Token[];
  durationS: number;
  profile: StyleProfile;
  fps: number;
  /** Timeline frame where this source's first clip starts. */
  startFrame: number;
  /** Beat positions on the output timeline (frames, may be fractional). */
  beatFrames: number[];
  /** Punch-in counter carried across sources so levels keep alternating. */
  framingIndex: number;
}

const start = (r: Run) => (r.words[0] as Token).word.start - r.head;
const end = (r: Run) => (r.words.at(-1) as Token).word.end + r.tail;
const clamp = (v: number, [lo, hi]: [number, number]) => Math.min(hi, Math.max(lo, v));

/** Groups kept words into runs: a removed word or a silence longer than the maximum ends a run. */
export function buildRuns(tokens: readonly Token[], durationS: number, profile: StyleProfile): Run[] {
  const maxSilence = profile.montage.maxSilenceMs / 1000;
  const [lo, hi] = profile.montage.wordMarginMs.map((ms) => ms / 1000) as [number, number];
  const target = (lo + hi) / 2;
  const runs: Run[] = [];
  let current: Token[] = [];
  let removed: Token[] = [];
  let pendingRemoved: Token[] = [];
  let lastKept: Token | undefined;
  const flush = () => {
    if (current.length > 0) runs.push(makeRun(current, removed));
    current = [];
  };
  const makeRun = (words: Token[], removedBefore: Token[]): Run => ({
    words,
    removedBefore,
    silenceBeforeS: 0,
    head: target,
    tail: target,
    headRange: [lo, hi],
    tailRange: [lo, hi],
  });
  for (const t of tokens) {
    if (t.removed) {
      pendingRemoved.push(t);
      continue;
    }
    const gap = lastKept ? t.word.start - lastKept.word.end : 0;
    if (current.length > 0 && (pendingRemoved.length > 0 || gap > maxSilence)) {
      flush();
    }
    if (current.length === 0) {
      removed = pendingRemoved;
    }
    pendingRemoved = [];
    current.push(t);
    lastKept = t;
  }
  flush();

  // Margins: as close to the target as the neighbouring sound allows.
  for (const run of runs) {
    const first = run.words[0] as Token;
    const last = run.words.at(-1) as Token;
    const prev = tokens[first.i - 1];
    const next = tokens[last.i + 1];
    const availHead = first.word.start - (prev ? prev.word.end + GUARD_S : 0);
    const availTail = (next ? next.word.start - GUARD_S : durationS) - last.word.end;
    run.headRange = [Math.max(0, Math.min(lo, availHead)), Math.max(0, Math.min(hi, availHead))];
    run.tailRange = [Math.max(0, Math.min(lo, availTail)), Math.max(0, Math.min(hi, availTail))];
    run.head = clamp(target, run.headRange);
    run.tail = clamp(target, run.tailRange);
    run.silenceBeforeS = prev && !prev.removed ? first.word.start - prev.word.end : 0;
  }
  return runs;
}

/** Nearest beat to `frame`, or undefined without music. */
function nearestBeat(beats: readonly number[], frame: number): number | undefined {
  let best: number | undefined;
  for (const b of beats) if (best === undefined || Math.abs(b - frame) < Math.abs(best - frame)) best = b;
  return best;
}

/**
 * Jump cuts: each run's head/tail margins may move inside their allowed range, which
 * shifts the next cut by a few frames. Greedily land every cut on the closest
 * reachable beat; cuts with no beat in reach keep their default margins.
 */
export function snapJumpCuts(runs: Run[], fps: number, startFrame: number, beats: readonly number[]): void {
  if (beats.length === 0) return;
  let pos = startFrame;
  for (let k = 0; k < runs.length; k++) {
    const run = runs[k] as Run;
    const core = (run.words.at(-1) as Token).word.end - (run.words[0] as Token).word.start;
    if (k < runs.length - 1) {
      const dMin = core + run.headRange[0] + run.tailRange[0];
      const dMax = core + run.headRange[1] + run.tailRange[1];
      const defaultEnd = pos + Math.round((end(run) - start(run)) * fps);
      // Among reachable cut frames, the one closest to a beat (beats are fractional frames).
      const distance = (f: number) => Math.min(...beats.map((b) => Math.abs(b - f)));
      let targetFrame = defaultEnd;
      // A run's length is rounded to whole frames: any frame its duration range rounds to is reachable.
      for (let f = pos + Math.round(dMin * fps); f <= pos + Math.round(dMax * fps); f++)
        if (distance(f) < distance(targetFrame) - 1e-9) targetFrame = f;
      const target = targetFrame !== defaultEnd ? targetFrame : undefined;
      if (target !== undefined) {
        // Spread the change over head and tail, each within its own range.
        const want = (target - pos) / fps - core;
        const headSpan = run.headRange[1] - run.headRange[0];
        const tailSpan = run.tailRange[1] - run.tailRange[0];
        const extra = want - run.headRange[0] - run.tailRange[0];
        const share = headSpan + tailSpan > 0 ? headSpan / (headSpan + tailSpan) : 0.5;
        run.head = clamp(run.headRange[0] + extra * share, run.headRange);
        run.tail = clamp(want - run.head, run.tailRange);
        run.head = clamp(want - run.tail, run.headRange);
      }
    }
    pos += Math.round((end(run) - start(run)) * fps);
  }
}

/**
 * Splits runs longer than the static-shot limit with zoom cuts: picture-only cuts
 * over continuous audio, so they can sit on any frame — on a beat when there is
 * music, otherwise in the widest pause near the limit.
 */
export function planClips(input: PlanInput): { clips: PlannedClip[]; framingIndex: number } {
  const { tokens, durationS, profile, fps, beatFrames } = input;
  const runs = buildRuns(tokens, durationS, profile);
  snapJumpCuts(runs, fps, input.startFrame, beatFrames);
  const clips: PlannedClip[] = [];
  let pos = input.startFrame;

  for (const run of runs) {
    const runIn = Math.max(0, start(run));
    const runOut = Math.min(durationS, end(run));
    const runFrames = Math.round((runOut - runIn) * fps);
    const splits = zoomSplits(runFrames, pos, beatFrames, profile, fps, (lo, hi, ideal) =>
      bestPause(run, runIn, fps, lo, hi, ideal),
    );
    const bounds = [0, ...splits, runFrames];
    for (let j = 0; j < bounds.length - 1; j++) {
      const a = bounds[j] as number;
      const b = bounds[j + 1] as number;
      const inS = runIn + a / fps;
      const outS = j === bounds.length - 2 ? runOut : runIn + b / fps;
      const words = run.words.filter((t) => t.word.end > inS && t.word.start < outS).map((t) => t.id);
      const clip: PlannedClip = {
        in: inS,
        out: outS,
        frames: b - a,
        kind: j === 0 ? "speech" : "zoom-cut",
        wordIds: words,
        scale: 1,
      };
      if (j === 0) {
        const notes = [
          ...run.removedBefore.map((t) => `« ${t.word.text} » (${t.removed})`),
          ...(run.silenceBeforeS > 0 ? [`silence de ${Math.round(run.silenceBeforeS * 1000)} ms`] : []),
        ];
        if (notes.length > 0) clip.note = `coupé avant : ${notes.join(", ")}`;
      }
      clips.push(clip);
    }
    pos += runFrames;
  }

  // Framing alternates wide / punch-in so every cut changes the picture and consecutive punch-ins differ.
  let framingIndex = input.framingIndex;
  const levels = profile.montage.zoomCutLevels;
  for (const clip of clips) {
    clip.scale =
      framingIndex % 2 === 0 ? 1 : (levels[Math.floor(framingIndex / 2) % levels.length] as number);
    framingIndex++;
  }
  return { clips, framingIndex };
}

/**
 * Zoom-cut positions (frames relative to the shot start) so that no piece exceeds
 * the static-shot limit: on a beat when one is in reach, else where `fallback`
 * chooses (a pause in speech), else at 70 % of the limit.
 */
export function zoomSplits(
  shotFrames: number,
  startFrame: number,
  beatFrames: readonly number[],
  profile: StyleProfile,
  fps: number,
  fallback?: (lo: number, hi: number, ideal: number) => number | undefined,
): number[] {
  const maxFrames = Math.floor(profile.montage.maxStaticShotS * fps);
  const minFrames = Math.ceil(profile.montage.minShotS * fps);
  const splits: number[] = [];
  let p = 0;
  while (shotFrames - p > maxFrames) {
    const lo = p + minFrames;
    const hi = Math.min(p + maxFrames, shotFrames - minFrames);
    if (hi < lo) break;
    const ideal = p + Math.round(maxFrames * 0.7);
    const onBeat = beatFrames.map((b) => Math.round(b) - startFrame).filter((b) => b >= lo && b <= hi);
    const s = onBeat.length > 0 ? nearestBeat(onBeat, ideal) : fallback?.(lo, hi, ideal);
    splits.push(s ?? ideal);
    p = s ?? ideal;
  }
  return splits;
}

/** Frame (relative to the run) of the widest inter-word pause in [lo, hi], favouring the ideal spot. */
function bestPause(
  run: Run,
  runIn: number,
  fps: number,
  lo: number,
  hi: number,
  ideal: number,
): number | undefined {
  let best: { frame: number; score: number } | undefined;
  for (let k = 1; k < run.words.length; k++) {
    const a = (run.words[k - 1] as Token).word;
    const b = (run.words[k] as Token).word;
    const frame = Math.round(((a.end + b.start) / 2 - runIn) * fps);
    if (frame < lo || frame > hi) continue;
    const punct = /[.!?,;:…]$/.test(a.text) ? 0.15 : 0;
    const score = b.start - a.end + punct - Math.abs(frame - ideal) / fps / 10;
    if (!best || score > best.score) best = { frame, score };
  }
  return best?.frame;
}
