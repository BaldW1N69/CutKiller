import { clipEnd, type Edl, sortedClips, type Transcript } from "@cutkiller/core";

/** A spoken word kept by the edit, placed on the timeline. */
export interface TimelineWord {
  /** Transcript text, punctuation included. */
  text: string;
  fromFrame: number;
  toFrame: number;
  source: string;
  wordId: number;
}

/**
 * Words the viewer hears, in order: every word of the main-track clips (their
 * `why.wordIds`), mapped from source time to timeline frames. A word that spans
 * a zoom cut (continuous audio, two clips) is kept once, over both clips.
 */
export function timelineWords(edl: Edl, transcripts: Record<string, Transcript> | undefined): TimelineWord[] {
  const fps = edl.output.fps;
  const out: TimelineWord[] = [];
  const seen = new Map<string, TimelineWord>();
  for (const clip of sortedClips(edl.video[0]?.clips ?? [])) {
    const transcript = transcripts?.[clip.source];
    if (!transcript) continue;
    const end = clipEnd(clip, fps);
    for (const id of clip.why?.wordIds ?? []) {
      const w = transcript.words[id];
      if (!w) continue;
      const toTimeline = (t: number) => clip.at + Math.round((t - clip.in) * fps);
      const from = Math.min(end - 1, Math.max(clip.at, toTimeline(w.start)));
      const to = Math.min(end, Math.max(from + 1, toTimeline(w.end)));
      const key = `${clip.source}#${id}`;
      const existing = seen.get(key);
      if (existing && existing.toFrame >= clip.at - 1) {
        existing.toFrame = Math.max(existing.toFrame, to);
        continue;
      }
      const word = { text: w.text, fromFrame: from, toFrame: to, source: clip.source, wordId: id };
      seen.set(key, word);
      out.push(word);
    }
  }
  return out.sort((a, b) => a.fromFrame - b.fromFrame);
}
