import { type Edl, framesToSeconds, mainAudioSpans, type StyleProfile } from "@cutkiller/core";
import { decodeMono } from "@cutkiller/media";
import { type CheckResult, graded, notEvaluated, type Violation } from "../report";

const RATE = 48_000;

/** Audio edit points of the timeline, in output frames. */
export function audioEditFrames(edl: Edl): number[] {
  const fps = edl.output.fps;
  const frames = mainAudioSpans(edl)
    .filter((s) => s.cutAtStart)
    .map((s) => s.startFrame);
  for (const track of edl.audio) {
    for (const c of track.clips) {
      frames.push(c.at, c.at + Math.round((c.out - c.in) * fps));
    }
  }
  return [...new Set(frames)].filter((f) => f > 0).sort((a, b) => a - b);
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] as number;
}

/**
 * Click detector: a click is a sample-to-sample jump at the edit point that stands
 * far above the local signal's own slope. Smooth micro-fades keep the jump inside
 * the natural range of the surrounding waveform.
 */
export function clickScore(samples: Float32Array, at: number): { jump: number; baseline: number } {
  const ms = RATE / 1000;
  const slope = (a: number, b: number) => {
    const out: number[] = [];
    for (let i = Math.max(1, Math.round(a)); i < Math.min(samples.length, Math.round(b)); i++)
      out.push(Math.abs((samples[i] as number) - (samples[i - 1] as number)));
    return out;
  };
  const jump = Math.max(0, ...slope(at - 3 * ms, at + 3 * ms));
  const around = [...slope(at - 60 * ms, at - 10 * ms), ...slope(at + 10 * ms, at + 60 * ms)];
  return { jump, baseline: percentile(around, 0.99) };
}

export async function checkCutClicks(video: string, edl: Edl, profile: StyleProfile): Promise<CheckResult> {
  const edits = audioEditFrames(edl);
  if (edits.length === 0) return notEvaluated("audio.cut-clicks", "aucune coupe audio");
  const [minFade, maxFade] = profile.audio.cutFadeMs;
  const violations: Violation[] = [];
  const fade = edl.output.audio.cutFadeMs;
  if (fade < minFade || fade > maxFade)
    violations.push({ message: `fondus de coupe de ${fade} ms (attendu ${minFade}–${maxFade} ms)` });
  const samples = await decodeMono(video);
  let clicks = 0;
  for (const frame of edits) {
    const at = framesToSeconds(frame, edl.output.fps) * RATE;
    const { jump, baseline } = clickScore(samples, at);
    if (jump > 3 * baseline + 0.02) {
      clicks++;
      violations.push({ message: `clic (saut ${jump.toFixed(3)} vs ${baseline.toFixed(3)})`, frame });
    }
  }
  return graded("audio.cut-clicks", edits.length, violations, {
    edits: edits.length,
    clicks,
    cutFadeMs: fade,
  });
}
