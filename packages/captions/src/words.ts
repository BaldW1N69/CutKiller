import { type Edl, mainAudioSpans, type Transcript } from "@cutkiller/core";

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
 * `why.wordIds`), mapped from source time to timeline frames through the clip's
 * audio (a J/L cut moves the sound edit away from the picture cut: the word is
 * heard, and captioned, where its audio plays). A word that spans a zoom cut
 * (continuous audio, two clips) is kept once, over both clips.
 */
export function timelineWords(edl: Edl, transcripts: Record<string, Transcript> | undefined): TimelineWord[] {
  const fps = edl.output.fps;
  const out: TimelineWord[] = [];
  const seen = new Map<string, TimelineWord>();
  for (const span of mainAudioSpans(edl)) {
    const clip = span.clip;
    const transcript = transcripts?.[clip.source];
    if (!transcript) continue;
    const end = span.endFrame;
    for (const id of clip.why?.wordIds ?? []) {
      const w = transcript.words[id];
      if (!w) continue;
      const toTimeline = (t: number) => span.startFrame + Math.round((t - span.sourceIn) * fps);
      const from = Math.min(end - 1, Math.max(span.startFrame, toTimeline(w.start)));
      const to = Math.min(end, Math.max(from + 1, toTimeline(w.end)));
      const key = `${clip.source}#${id}`;
      const existing = seen.get(key);
      if (existing && existing.toFrame >= span.startFrame - 1) {
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
