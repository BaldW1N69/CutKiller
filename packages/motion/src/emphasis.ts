import type { Prosody, StyleProfile, Transcript } from "@cutkiller/core";

const norm = (text: string) =>
  text
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[^\p{L}\p{N}'-]+/gu, "");

/** Spread of the local window used to normalise prosody, in seconds each side. */
const WINDOW_S = 6;

/**
 * Emphasis score of each word: how much louder and higher it is than the
 * speaker around it (z-scores over ±6 s), plus a lexical prior (intensifiers,
 * numbers, long content words) and a penalty for function words.
 */
export function emphasisScores(
  transcript: Transcript,
  prosody: Prosody | undefined,
  profile: StyleProfile,
): number[] {
  const words = transcript.words;
  const intens = new Set(profile.motion.emphasisWords.map(norm));
  const stop = new Set(profile.motion.stopWords.map(norm));
  const feats = words.map((_, i) => prosody?.words[i] ?? { rmsDb: null, pitchSt: null });
  const z = (i: number, key: "rmsDb" | "pitchSt"): number => {
    const v = feats[i]?.[key];
    if (v === null || v === undefined) return 0;
    const t = (words[i] as { start: number }).start;
    const local: number[] = [];
    for (let j = 0; j < words.length; j++) {
      const w = words[j] as { start: number };
      const x = feats[j]?.[key];
      if (x !== null && x !== undefined && Math.abs(w.start - t) <= WINDOW_S) local.push(x);
    }
    if (local.length < 5) return 0;
    const mean = local.reduce((a, b) => a + b, 0) / local.length;
    const sd = Math.sqrt(local.reduce((a, b) => a + (b - mean) ** 2, 0) / local.length) || 1;
    return (v - mean) / sd;
  };
  return words.map((w, i) => {
    const n = norm(w.text);
    if (n === "") return Number.NEGATIVE_INFINITY;
    let score = 0.6 * z(i, "rmsDb") + 0.4 * z(i, "pitchSt");
    if (intens.has(n)) score += 1;
    else if (/^\d/.test(n)) score += 0.6;
    else if (n.length >= 7) score += 0.2;
    if (stop.has(n)) score -= 2;
    else if (n.length < 3) score -= 1;
    return score;
  });
}
