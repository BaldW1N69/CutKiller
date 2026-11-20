import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { runWorker } from "@cutkiller/analyze";
import {
  type Analysis,
  clipEnd,
  type Edl,
  mainAudioSpans,
  type StyleProfile,
  sortedClips,
  type Transcript,
  tr,
  type VideoClip,
  type VoiceActivity,
} from "@cutkiller/core";
import { classifyWords, speechTokens, type Token, timelineBeats } from "@cutkiller/cut";
import { type CheckResult, graded, notEvaluated, type Violation } from "../report";

/** VAD boundaries are ±30 ms; a pause is only "too long" beyond this margin. */
const SILENCE_TOLERANCE_S = 0.06;

/** Dialogue stem written next to the render (`--keep-stems`), else the video's own audio. */
export const voiceTrack = (video: string) =>
  resolve(existsSync(`${video}.voice.wav`) ? `${video}.voice.wav` : video);

const views = new WeakMap<Analysis, Map<string, Token[]>>();

/** Same speech view the cut pass planned from (sanitized, classified tokens). */
function tokensOf(source: string, analysis: Analysis | undefined, profile: StyleProfile): Token[] {
  if (!analysis) return [];
  let bySource = views.get(analysis);
  if (!bySource) {
    bySource = new Map();
    views.set(analysis, bySource);
  }
  let tokens = bySource.get(source);
  if (!tokens) {
    const transcript = analysis.transcripts?.[source];
    tokens = transcript ? speechTokens(transcript.words, analysis.vad?.[source]?.speech, profile).tokens : [];
    bySource.set(source, tokens);
  }
  return tokens;
}

/**
 * A clip's speech margins and how far each could grow before touching the
 * neighbouring sound of the rush (10 ms guard, as the planner uses).
 */
function margins(clip: VideoClip, analysis: Analysis | undefined, profile: StyleProfile) {
  const ids = clip.why?.wordIds ?? [];
  const tokens = tokensOf(clip.source, analysis, profile);
  const firstIdx = tokens.findIndex((t) => t.id === ids[0]);
  const lastIdx = tokens.findIndex((t) => t.id === ids.at(-1));
  if (ids.length === 0 || firstIdx < 0 || lastIdx < 0) return undefined;
  const first = (tokens[firstIdx] as Token).word;
  const last = (tokens[lastIdx] as Token).word;
  const prev = tokens[firstIdx - 1]?.word;
  const next = tokens[lastIdx + 1]?.word;
  return {
    first,
    last,
    head: first.start - clip.in,
    tail: clip.out - last.end,
    headRoom: prev ? first.start - prev.end - 0.01 : Number.POSITIVE_INFINITY,
    tailRoom: next ? next.start - last.end - 0.01 : Number.POSITIVE_INFINITY,
  };
}

/**
 * Silences: an independent VAD on the rendered dialogue must find no pause longer
 * than the limit, and every audio edit must keep 80–120 ms around its words
 * (unless the neighbouring sound was closer than that in the rush).
 */
export async function checkSilences(
  video: string,
  edl: Edl,
  profile: StyleProfile,
  analysis: Analysis | undefined,
  vadOverride?: VoiceActivity,
): Promise<CheckResult> {
  const vad = vadOverride ?? (await runWorker<VoiceActivity>("vad", { path: voiceTrack(video) }));
  const max = profile.montage.maxSilenceMs / 1000;
  const violations: Violation[] = [];
  const fps = edl.output.fps;
  let items = 0;
  for (let k = 1; k < vad.speech.length; k++) {
    items++;
    const gap = (vad.speech[k] as { start: number }).start - (vad.speech[k - 1] as { end: number }).end;
    if (gap > max + SILENCE_TOLERANCE_S)
      violations.push({
        message: tr(`silence of ${Math.round(gap * 1000)} ms`, `silence de ${Math.round(gap * 1000)} ms`),
        frame: Math.round((vad.speech[k - 1] as { end: number }).end * fps),
      });
  }
  const [lo, hi] = profile.montage.wordMarginMs;
  const tol = 1; // ms, rounding of the EDL
  for (const span of mainAudioSpans(edl)) {
    const m = margins(span.clip, analysis, profile);
    if (!m) continue;
    if (span.cutAtStart) {
      items++;
      const head = (m.first.start - span.sourceIn) * 1000;
      if ((head < lo - tol && m.headRoom * 1000 >= lo) || head > hi + tol)
        violations.push({
          message: tr(
            `margin before « ${m.first.text} » of ${Math.round(head)} ms`,
            `marge avant « ${m.first.text} » de ${Math.round(head)} ms`,
          ),
          frame: span.startFrame,
        });
    }
    if (span.cutAtEnd) {
      items++;
      const tail = (span.sourceOut - m.last.end) * 1000;
      if ((tail < lo - tol && m.tailRoom * 1000 >= lo) || tail > hi + tol)
        violations.push({
          message: tr(
            `margin after « ${m.last.text} » of ${Math.round(tail)} ms`,
            `marge après « ${m.last.text} » de ${Math.round(tail)} ms`,
          ),
          frame: span.endFrame,
        });
    }
  }
  return graded("montage.silences", items, violations, { pauses: vad.speech.length - 1 });
}

/**
 * Hesitations: re-transcribes the rendered dialogue (same disfluent prompt as the
 * analysis) and looks for fillers and immediately repeated phrases left in.
 */
export async function checkFillers(
  video: string,
  profile: StyleProfile,
  fps: number,
  transcriptOverride?: Transcript,
  language = "fr",
): Promise<CheckResult> {
  const transcript =
    transcriptOverride ??
    (await runWorker<Transcript>("transcribe", { path: voiceTrack(video), language, align: false }));
  if (transcript.words.length === 0)
    return notEvaluated("montage.fillers", tr("no speech in the render", "aucune parole dans le rendu"));
  const tokens = classifyWords(transcript.words, profile);
  const violations = tokens
    .filter((t) => t.removed)
    .map((t) => ({ message: `« ${t.word.text} » (${t.removed})`, frame: Math.round(t.word.start * fps) }));
  return graded("montage.fillers", transcript.words.length, violations, {
    words: transcript.words.length,
    left: violations.length,
  });
}

/**
 * Beat cuts: a cut is "free" when a beat lies within the range its margins (jump
 * cut) or its placement freedom (zoom cut) allow; every free cut must sit on a beat.
 */
export function checkBeatCuts(edl: Edl, profile: StyleProfile, analysis: Analysis | undefined): CheckResult {
  const beats = timelineBeats(edl, analysis ?? {});
  if (beats.length === 0) return notEvaluated("montage.beat-cuts", tr("no music", "pas de musique"));
  const fps = edl.output.fps;
  const tol = profile.montage.beatToleranceFrames;
  const [lo, hi] = profile.montage.wordMarginMs.map((ms) => ms / 1000) as [number, number];
  const minShot = profile.montage.minShotS * fps;
  const maxShot = profile.montage.maxStaticShotS * fps;
  const clips = sortedClips(edl.video[0]?.clips ?? []);
  const spans = mainAudioSpans(edl);
  const violations: Violation[] = [];
  let free = 0;
  for (let k = 1; k < clips.length; k++) {
    const prev = clips[k - 1] as VideoClip;
    const cur = clips[k] as VideoClip;
    const cut = cur.at;
    let window: [number, number];
    const silent = (c: VideoClip) => (c.why?.wordIds?.length ?? 0) === 0;
    if ((spans[k] as { continuesPrev: boolean }).continuesPrev || (silent(prev) && silent(cur))) {
      // Continuous take (zoom cut) or shots without speech (B-roll montage): the cut
      // may go anywhere the shot lengths allow.
      window = [prev.at + minShot, Math.min(prev.at + maxShot, clipEnd(cur, fps) - minShot)];
    } else {
      // The adjustable margins belong to the whole speech run the previous clip ends,
      // which may have been split by zoom cuts.
      let j = k - 1;
      while (j > 0 && (spans[j] as { continuesPrev: boolean }).continuesPrev) j--;
      const head = margins(clips[j] as VideoClip, analysis, profile);
      const tail = margins(prev, analysis, profile);
      if (!head || !tail) continue;
      // Same reachable range as the planner: the run starts where it starts on the
      // timeline, its length spans its words plus the smallest to largest margins,
      // in whole frames (clips are quantized, so the longest length rounds down).
      const core = tail.last.end - head.first.start;
      const room = (r: number, m: number) => Math.max(0, Math.min(m, r));
      const dMin = core + room(head.headRoom, lo) + room(tail.tailRoom, lo);
      const dMax = core + room(head.headRoom, hi) + room(tail.tailRoom, hi);
      const runStart = (clips[j] as VideoClip).at;
      window = [runStart + Math.ceil(dMin * fps - 1e-6), runStart + Math.floor(dMax * fps + 1e-6)];
    }
    // Free cut: some beat can be reached within tolerance from an allowed position.
    const toWindow = (b: number) => Math.max(0, window[0] - b, b - window[1]);
    if (!beats.some((b) => toWindow(b) <= tol + 1e-6)) continue;
    free++;
    const nearest = Math.min(...beats.map((b) => Math.abs(b - cut)));
    if (nearest > tol + 1e-6)
      violations.push({
        message: tr(
          `cut ${nearest.toFixed(1)} frame(s) from the nearest beat`,
          `coupe à ${nearest.toFixed(1)} frame(s) du beat le plus proche`,
        ),
        frame: cut,
      });
  }
  if (free === 0)
    return notEvaluated(
      "montage.beat-cuts",
      tr("no free cut (no beat in reach)", "aucune coupe libre (aucun beat à portée)"),
    );
  return graded("montage.beat-cuts", free, violations, { cuts: clips.length - 1, freeCuts: free });
}

const framingKey = (c: VideoClip) => `${c.source}|${c.transform.scale}|${c.transform.x}|${c.transform.y}`;

/**
 * Static shots: time between two visual changes (new source or framing, animation
 * start) must stay under the profile's limit.
 */
export function checkStaticShots(edl: Edl, profile: StyleProfile): CheckResult {
  const fps = edl.output.fps;
  const clips = sortedClips(edl.video[0]?.clips ?? []);
  if (clips.length === 0) return notEvaluated("montage.static-shots", tr("empty timeline", "timeline vide"));
  const changes = new Set<number>([0]);
  clips.forEach((c, k) => {
    const prev = clips[k - 1];
    if (!prev || framingKey(prev) !== framingKey(c)) changes.add(c.at);
  });
  for (const track of edl.keyframes) for (const key of track.keys) changes.add(key.frame);
  // An overlay (cutaway) changes the picture when it comes in and when it leaves.
  for (const track of edl.video.slice(1))
    for (const c of track.clips) {
      changes.add(c.at);
      changes.add(clipEnd(c, fps));
    }
  const end = clipEnd(clips.at(-1) as VideoClip, fps);
  const points = [...changes].filter((f) => f < end).sort((a, b) => a - b);
  points.push(end);
  const max = profile.montage.maxStaticShotS * fps + 1;
  const violations: Violation[] = [];
  for (let k = 1; k < points.length; k++) {
    const len = (points[k] as number) - (points[k - 1] as number);
    if (len > max)
      violations.push({
        message: tr(
          `static shot of ${(len / fps).toFixed(1)} s`,
          `plan statique de ${(len / fps).toFixed(1)} s`,
        ),
        frame: points[k - 1] as number,
      });
  }
  return graded("montage.static-shots", points.length - 1, violations, { shots: points.length - 1 });
}
