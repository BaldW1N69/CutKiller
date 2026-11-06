import {
  type Analysis,
  clipEnd,
  clipFrames,
  type Diagnostic,
  type Edl,
  type EdlInput,
  EdlSchema,
  framesToSeconds,
  type Pass,
  type StyleProfile,
  sortedClips,
  type VideoClip,
} from "@cutkiller/core";
import { timelineBeats } from "./beats";

/**
 * A B-roll source: marked so (`--broll`), or, once speech was analysed, a video
 * whose transcript has no word (a shot of the street, of hands at work).
 */
export function isBroll(edl: Edl, analysis: Analysis, sourceId: string): boolean {
  const source = edl.sources[sourceId];
  if (!source || source.still) return false;
  if (source.role === "broll") return true;
  if (!analysis.transcripts) return false;
  if (analysis.sources[sourceId]?.hasVideo === false) return false;
  return (analysis.transcripts[sourceId]?.words.length ?? 0) === 0;
}

interface Piece {
  source: string;
  in: number;
  out: number;
}

/** How well a piece of B-roll fits the frame: higher is better, 0 is neutral. */
export type PieceScore = (source: string, from: number, to: number) => number;

/**
 * B-roll material: the rushes in turn, never the same second twice. Within a
 * rush, the free window with the best score (a subject the frame can follow),
 * the earliest one on a tie, so without a score the rush is used in order.
 */
class Material {
  private readonly ranges: { source: string; from: number; out: number; used: [number, number][] }[];
  private next = 0;

  constructor(
    clips: VideoClip[],
    skipHeadS: number,
    minS: number,
    private readonly score: PieceScore = () => 0,
  ) {
    const bySource = new Map<string, { in: number; out: number }>();
    for (const c of clips) {
      const r = bySource.get(c.source);
      bySource.set(
        c.source,
        r ? { in: Math.min(r.in, c.in), out: Math.max(r.out, c.out) } : { in: c.in, out: c.out },
      );
    }
    this.ranges = [...bySource].map(([source, r]) => ({
      source,
      from: r.out - r.in - skipHeadS >= minS ? r.in + skipHeadS : r.in,
      out: r.out,
      used: [],
    }));
  }

  private free(r: (typeof this.ranges)[number]): number {
    return Math.max(0, r.out - r.from - r.used.reduce((s, [a, b]) => s + (b - a), 0));
  }

  get seconds(): number {
    return this.ranges.reduce((s, r) => s + this.free(r), 0);
  }

  /** A piece of `wantS` seconds (at least `minS`), from the next rush that has one. */
  take(wantS: number, minS: number): Piece | undefined {
    for (let k = 0; k < this.ranges.length; k++) {
      const r = this.ranges[(this.next + k) % this.ranges.length] as (typeof this.ranges)[number];
      let best: { from: number; len: number; score: number } | undefined;
      for (let len = wantS; len >= minS - 1e-6 && !best; len = Math.max(minS, len - 0.5)) {
        for (let t = r.from; t + len <= r.out + 1e-6; t += 0.25) {
          if (r.used.some(([a, b]) => t < b && t + len > a)) continue;
          const score = this.score(r.source, t, t + len);
          if (!best || score > best.score + 1e-9) best = { from: t, len, score };
        }
        if (len <= minS + 1e-6) break;
      }
      if (!best) continue;
      r.used.push([best.from, best.from + best.len]);
      this.next = (this.next + k + 1) % this.ranges.length;
      return { source: r.source, in: best.from, out: best.from + best.len };
    }
    return undefined;
  }
}

/**
 * Score of a B-roll window in a vertical frame: the 9:16 crop shows about a third
 * of a 16:9 picture, so a window is good when its people fit in one crop and hold
 * still (a face moving across the picture outruns the virtual camera). Windows
 * without anyone score 0 (a landscape is fine). Horizontal output: always 0.
 */
export function verticalFit(edl: Edl, analysis: Analysis): PieceScore {
  const { width: W, height: H } = edl.output;
  return (sourceId, from, to) => {
    const source = edl.sources[sourceId];
    const subjects = analysis.subjects?.[sourceId];
    if (W >= H || !source?.width || !source.height || !subjects) return 0;
    const crop = Math.min(1, (source.height * W) / H / source.width);
    const samples = subjects.samples.filter((x) => x.t >= from - 1e-6 && x.t <= to + 1e-6);
    const withFaces = samples.filter((x) => x.faces.length > 0);
    if (withFaces.length === 0) return 0;
    let penalty = 0;
    let prev: number | undefined;
    const centres: number[] = [];
    for (const x of withFaces) {
      const spread = Math.max(...x.faces.map((f) => f.x + f.w)) - Math.min(...x.faces.map((f) => f.x));
      if (spread > crop) penalty += 1 / withFaces.length; // several people the crop cannot hold
      const main = x.faces.reduce((a, b) => (a.w * a.h >= b.w * b.h ? a : b));
      const c = main.x + main.w / 2;
      if (prev !== undefined) penalty += Math.max(0, Math.abs(c - prev) - 0.02) / crop; // jumps
      prev = c;
      centres.push(c);
    }
    const m = centres.reduce((a, b) => a + b, 0) / centres.length;
    const spreadOverTime = Math.sqrt(centres.reduce((a, b) => a + (b - m) ** 2, 0) / centres.length);
    // People seen only part of the time: faces appear and vanish (walking in and out).
    const flicker = 1 - withFaces.length / Math.max(1, samples.length);
    return -(penalty + (2 * spreadOverTime) / crop + 0.5 * flicker);
  };
}

/** Nearest beat to `target` within [lo, hi] (frames), if any. */
function snap(beats: readonly number[], target: number, lo: number, hi: number): number | undefined {
  let best: number | undefined;
  for (const b of beats) {
    const f = Math.round(b);
    if (f < lo || f > hi) continue;
    if (best === undefined || Math.abs(f - target) < Math.abs(best - target)) best = f;
  }
  return best;
}

interface Cutaway {
  from: number;
  to: number;
  covers: "jump-cut" | "long-shot";
}

/**
 * Cutaways over the speech: first centred on the jump cuts (they hide them; the
 * voice goes on underneath, like an L-cut), then on the zoom cuts of long
 * stretches. Each lasts within `shotS`, starts and ends on a beat when one is in
 * reach, leaves the speaker on screen at the head, the tail and between two
 * cutaways, and all together cover at most `maxShare` of the edit.
 */
function planCutaways(speech: VideoClip[], beats: number[], profile: StyleProfile, fps: number): Cutaway[] {
  const b = profile.broll;
  const total = speech.length > 0 ? clipEnd(speech.at(-1) as VideoClip, fps) : 0;
  const [minS, maxS] = b.shotS;
  const want = Math.round(((minS + maxS) / 2) * fps);
  const minLen = Math.ceil(minS * fps);
  const maxLen = Math.floor(maxS * fps);
  const head = Math.round(b.headS * fps);
  const tail = total - Math.round(b.tailS * fps);
  const spacing = Math.round(b.minSpacingS * fps);
  const budget = b.maxShare * total;
  const placed: Cutaway[] = [];
  let covered = 0;
  const cuts = speech.slice(1).map((c, k) => {
    const prev = speech[k] as VideoClip;
    const jump = prev.source !== c.source || c.in - prev.out > 0.25;
    return { frame: c.at, jump };
  });
  const tryAt = (cut: number, covers: Cutaway["covers"]) => {
    const lead = Math.round(want * 0.4);
    const reach = Math.round(0.4 * fps);
    const from =
      snap(beats, cut - lead, cut - lead - reach, Math.min(cut - 6, cut - lead + reach)) ?? cut - lead;
    const to = snap(beats, from + want, Math.max(from + minLen, cut + 6), from + maxLen) ?? from + want;
    const len = to - from;
    if (from < head || to > tail || len < minLen || len > maxLen || to <= cut) return;
    if (covered + len > budget) return;
    if (placed.some((p) => from < p.to + spacing && to > p.from - spacing)) return;
    placed.push({ from, to, covers });
    covered += len;
  };
  for (const c of cuts) if (c.jump) tryAt(c.frame, "jump-cut");
  for (const c of cuts) if (!c.jump) tryAt(c.frame, "long-shot");
  return placed.sort((x, y) => x.from - y.from);
}

/**
 * Montage without speech: one shot every `beatsPerShot` beats of the music (a bar
 * in 4/4), within `shotS`; without music, shots of the middle length. As long as
 * the music, or the material, lasts.
 */
function planMontage(
  material: Material,
  beats: number[],
  musicFrames: number | undefined,
  profile: StyleProfile,
  fps: number,
): { pieces: Piece[]; frames: number[] } {
  const b = profile.broll;
  const [minS, maxS] = b.shotS;
  const minLen = Math.ceil(minS * fps);
  const maxLen = Math.floor(maxS * fps);
  const bars = beats.filter((_, i) => i % b.beatsPerShot === 0).map((f) => Math.round(f));
  const total = Math.min(musicFrames ?? Number.POSITIVE_INFINITY, Math.floor(material.seconds * fps));
  const pieces: Piece[] = [];
  const frames: number[] = [];
  let pos = 0;
  while (pos < total) {
    const left = total - pos;
    if (left < minLen) break;
    const bar = bars.find((f) => f >= pos + minLen && f <= pos + maxLen);
    let len = bar !== undefined ? bar - pos : Math.round(((minS + maxS) / 2) * fps);
    if (left - len < minLen) len = Math.min(left, maxLen);
    const piece = material.take(len / fps, len / fps);
    if (!piece) break;
    pieces.push(piece);
    frames.push(len);
    pos += len;
  }
  return { pieces, frames };
}

/**
 * Passe « broll » : les rushes d'illustration quittent la piste de la parole.
 * - Avec de la parole : plans de coupe sur une piste superposée, la voix continue
 *   dessous ; d'abord sur les jump cuts (qu'ils masquent), puis sur les longues
 *   tirades, calés sur les beats.
 * - Sans parole : montage d'un plan par mesure de la musique.
 */
export const brollPass: Pass = {
  id: "broll",
  run(edl: Edl, ctx) {
    const diagnostics: Diagnostic[] = [];
    const cfg = ctx.profile.broll;
    const main = edl.video[0];
    if (!cfg.enabled || !main) return { edl, diagnostics };
    const fps = edl.output.fps;
    const clips = sortedClips(main.clips);
    const broll = clips.filter((c) => isBroll(edl, ctx.analysis, c.source));
    if (broll.length === 0) return { edl, diagnostics };
    const speech = clips.filter((c) => !broll.includes(c));
    const material = new Material(broll, cfg.skipHeadS, cfg.shotS[0], verticalFit(edl, ctx.analysis));
    const beats = timelineBeats(edl, ctx.analysis);

    let mainClips: EdlInput["video"][number]["clips"];
    let overlay: EdlInput["video"][number]["clips"] = [];
    let total: number;
    if (speech.length > 0) {
      // The speech, end to end again where the B-roll stood between its takes.
      let at = 0;
      const packed = speech.map((c) => {
        const moved = { ...c, at };
        at += clipFrames(c, fps);
        return moved;
      });
      total = at;
      const cutaways = planCutaways(packed, beats, ctx.profile, fps);
      for (const cut of cutaways) {
        const piece = material.take(
          framesToSeconds(cut.to - cut.from, fps),
          framesToSeconds(cut.to - cut.from, fps),
        );
        if (!piece) break;
        overlay.push({
          id: `b${String(overlay.length + 1).padStart(3, "0")}`,
          source: piece.source,
          in: Math.round(piece.in * 1e6) / 1e6,
          out: Math.round(piece.out * 1e6) / 1e6,
          at: cut.from,
          why: {
            kind: "broll",
            note: cut.covers === "jump-cut" ? "masque un jump cut" : "relance un long plan",
          },
        });
      }
      mainClips = packed;
      const jumps = cutaways.slice(0, overlay.length).filter((c) => c.covers === "jump-cut").length;
      const seconds = overlay.reduce((s, c) => s + (c.out - c.in), 0);
      diagnostics.push({
        level: "info",
        code: "broll.summary",
        message: `${overlay.length} plan(s) de coupe (${seconds.toFixed(1)} s, ${Math.round((100 * seconds) / Math.max(1e-9, framesToSeconds(total, fps)))} % du montage), ${jumps} jump cut(s) masqué(s)`,
      });
    } else {
      const music = edl.audio.flatMap((t) => t.clips);
      const musicFrames =
        music.length > 0
          ? Math.max(
              ...music.map((c) => {
                const d = c.source === undefined ? undefined : ctx.analysis.sources[c.source]?.durationS;
                return c.at + Math.round(((d ?? c.out) - c.in) * fps);
              }),
            )
          : undefined;
      const { pieces, frames } = planMontage(material, beats, musicFrames, ctx.profile, fps);
      let at = 0;
      mainClips = pieces.map((p, k) => {
        const clip = {
          id: `s${String(k + 1).padStart(3, "0")}`,
          source: p.source,
          in: Math.round(p.in * 1e6) / 1e6,
          out: Math.round((p.in + (frames[k] as number) / fps) * 1e6) / 1e6,
          at,
          // Natural sound of the B-roll stays far under the music.
          gainDb: -20,
          why: { kind: "broll", note: beats.length > 0 ? `${cfg.beatsPerShot} temps` : "sans musique" },
        };
        at += frames[k] as number;
        return clip;
      });
      overlay = [];
      total = at;
      diagnostics.push({
        level: "info",
        code: "broll.summary",
        message: `montage B-roll : ${mainClips.length} plan(s) sur ${framesToSeconds(total, fps).toFixed(1)} s, ${beats.length > 0 ? `un tous les ${cfg.beatsPerShot} temps` : "sans musique"}`,
      });
    }

    const totalS = framesToSeconds(total, fps);
    const audio = edl.audio.map((track) => ({
      ...track,
      clips: track.clips
        .filter((c) => c.at < total)
        .map((c) => {
          const d = c.source === undefined ? undefined : ctx.analysis.sources[c.source]?.durationS;
          return { ...c, out: Math.min(d ?? c.out, c.in + totalS - framesToSeconds(c.at, fps)) };
        }),
    }));
    return {
      edl: EdlSchema.parse({
        ...edl,
        video: [
          { ...main, clips: mainClips },
          ...(overlay.length > 0 ? [{ id: "broll", clips: overlay }] : []),
          ...edl.video.slice(1),
        ],
        audio,
      }),
      diagnostics,
    };
  },
};
