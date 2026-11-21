import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { runWorker } from "@cutkiller/analyze";
import { envelopePeak } from "@cutkiller/audio";
import {
  type Edl,
  framesToSeconds,
  mainAudioSpans,
  type StyleProfile,
  tr,
  type VoiceActivity,
} from "@cutkiller/core";
import { decodeMono, measureLoudness, readWavF32 } from "@cutkiller/media";
import { type CheckResult, graded, notEvaluated, type Violation } from "../report";

const RATE = 48_000;

/** Audio edit points of the timeline, in output frames: dialogue edits and music/SFX edits. */
export function audioEditFrames(edl: Edl): { dialogue: number[]; other: number[] } {
  const fps = edl.output.fps;
  const dialogue = mainAudioSpans(edl)
    .filter((s) => s.cutAtStart && s.startFrame > 0)
    .map((s) => s.startFrame);
  const frames: number[] = [];
  for (const track of edl.audio) {
    for (const c of track.clips) {
      frames.push(c.at, c.at + Math.round((c.out - c.in) * fps));
    }
  }
  return {
    dialogue: [...new Set(dialogue)].sort((a, b) => a - b),
    other: [...new Set(frames)].filter((f) => f > 0).sort((a, b) => a - b),
  };
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
  const { dialogue, other } = audioEditFrames(edl);
  const edits = [...dialogue, ...other];
  if (edits.length === 0) return notEvaluated("audio.cut-clicks", tr("no audio edit", "aucune coupe audio"));
  const [minFade, maxFade] = profile.audio.cutFadeMs;
  const violations: Violation[] = [];
  const fade = edl.output.audio.cutFadeMs;
  if (fade < minFade || fade > maxFade)
    violations.push({
      message: tr(
        `cut fades of ${fade} ms (expected ${minFade}–${maxFade} ms)`,
        `fondus de coupe de ${fade} ms (attendu ${minFade}–${maxFade} ms)`,
      ),
    });
  // Dialogue edits are judged on the dialogue stem when it exists: on the mix, a
  // music hit that a beat-snapped cut lands on would read as a click.
  const voice = `${video}.voice.wav`;
  const voiceSamples = existsSync(voice) ? await decodeMono(voice) : undefined;
  const mixSamples = await decodeMono(video);
  let clicks = 0;
  for (const frame of edits) {
    const samples = voiceSamples && dialogue.includes(frame) ? voiceSamples : mixSamples;
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

/** Integrated loudness and true peak of the delivered file (EBU R128, after encoding). */
export async function checkLoudness(video: string, profile: StyleProfile): Promise<CheckResult> {
  const a = profile.audio;
  const l = await measureLoudness(video);
  // FFmpeg reports pure silence as -70 LUFS: no sound to measure, not a loudness fault.
  if (!Number.isFinite(l.integrated) || l.integrated <= -69.5)
    return notEvaluated("audio.loudness", tr("silent audio track", "piste audio silencieuse"));
  const violations: Violation[] = [];
  if (Math.abs(l.integrated - a.integratedLufs) > a.lufsTolerance + 1e-9)
    violations.push({
      message: tr(
        `${l.integrated.toFixed(1)} LUFS (target ${a.integratedLufs} ±${a.lufsTolerance})`,
        `${l.integrated.toFixed(1)} LUFS (cible ${a.integratedLufs} ±${a.lufsTolerance})`,
      ),
    });
  if (l.truePeak > a.truePeakDbtp + 1e-9)
    violations.push({ message: `true peak ${l.truePeak.toFixed(1)} dBTP (max ${a.truePeakDbtp})` });
  return graded("audio.loudness", 2, violations, {
    lufs: l.integrated,
    truePeakDbtp: l.truePeak,
    lra: l.range,
  });
}

/** Short-term level (dBFS) of a stereo float stem, per window. */
function levels(samples: Float32Array, rate: number, windowS: number): Float64Array {
  const win = Math.round(windowS * rate);
  const n = Math.floor(samples.length / 2 / win);
  const out = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let acc = 0;
    for (let i = k * win; i < (k + 1) * win; i++) {
      const l = samples[i * 2] as number;
      const r = samples[i * 2 + 1] as number;
      acc += (l * l + r * r) / 2;
    }
    out[k] = 10 * Math.log10(acc / win + 1e-20);
  }
  return out;
}

/** Below this the dry music is too quiet for its gain to be measured. */
const AUDIBLE_DB = -55;
/** Steepest gain change allowed between two 10 ms windows (a 15 dB duck in 80 ms ≈ 3 dB/10 ms). */
const MAX_SLOPE_DB = 4;

/**
 * Ducking: wherever the dialogue speaks (independent VAD on the dialogue stem),
 * the music must play 12–18 dB under its own level (rendered music stem vs the
 * same music without ducking), and the gain must move smoothly (no step, no
 * up-and-down shorter than 300 ms between two sentences).
 */
export async function checkDucking(
  video: string,
  edl: Edl,
  profile: StyleProfile,
  vadOverride?: VoiceActivity,
): Promise<CheckResult> {
  const hasMusic = edl.audio.some((t) => t.clips.some((c) => c.source !== undefined));
  if (!hasMusic) return notEvaluated("audio.ducking", tr("no music", "pas de musique"));
  const ducked = `${video}.music.wav`;
  const dryPath = `${video}.music-dry.wav`;
  if (!existsSync(ducked) || !existsSync(dryPath))
    return notEvaluated(
      "audio.ducking",
      tr(
        "music stems missing (rendered without --keep-stems)",
        "stems musique absents (rendu sans --keep-stems)",
      ),
    );
  const vad = vadOverride ?? (await runWorker<VoiceActivity>("vad", { path: resolve(`${video}.voice.wav`) }));
  const wet = await readWavF32(ducked);
  const dry = await readWavF32(dryPath);
  const W = 0.01;
  const gw = levels(wet.samples, wet.rate, W);
  const gd = levels(dry.samples, dry.rate, W);
  const gain = (k: number) =>
    (gd[k] as number) > AUDIBLE_DB ? (gw[k] as number) - (gd[k] as number) : Number.NaN;
  const [lo, hi] = profile.audio.duckingDb;
  const fps = edl.output.fps;
  const violations: Violation[] = [];
  let items = 0;
  const depths: number[] = [];
  for (const s of vad.speech) {
    if (s.end - s.start < 0.4) continue;
    const g: number[] = [];
    for (let k = Math.ceil((s.start + 0.05) / W); k < Math.floor((s.end - 0.05) / W); k++) {
      const v = gain(k);
      if (Number.isFinite(v)) g.push(v);
    }
    if (g.length < 10) continue;
    items++;
    g.sort((a, b) => a - b);
    const depth = g[Math.floor(g.length / 2)] as number;
    depths.push(depth);
    if (depth < lo - 0.5 || depth > hi + 0.5)
      violations.push({
        message: tr(
          `music at ${depth.toFixed(1)} dB under speech (expected ${lo}–${hi} dB)`,
          `musique à ${depth.toFixed(1)} dB sous la parole (attendu ${lo}–${hi} dB)`,
        ),
        frame: Math.round(s.start * fps),
      });
  }
  // Smoothness: no gain step, no short release-attack cycle.
  items++;
  let steep = 0;
  let worst = 0;
  for (let k = 1; k < gw.length; k++) {
    const d = Math.abs(gain(k) - gain(k - 1));
    if (Number.isFinite(d) && d > MAX_SLOPE_DB) {
      steep++;
      worst = Math.max(worst, d);
    }
  }
  if (steep > 0)
    violations.push({
      message: tr(
        `${steep} abrupt gain change(s) (up to ${worst.toFixed(1)} dB in 10 ms)`,
        `${steep} variation(s) brusque(s) du gain (jusqu'à ${worst.toFixed(1)} dB en 10 ms)`,
      ),
    });
  const up = (k: number) => gain(k) > lo / 3;
  let pumps = 0;
  let k = 0;
  while (k < gw.length) {
    if (!(up(k) && k > 0 && !up(k - 1))) {
      k++;
      continue;
    }
    let j = k;
    while (j < gw.length && up(j)) j++;
    if (j < gw.length && (j - k) * W < 0.3) pumps++;
    k = j;
  }
  if (pumps > 0)
    violations.push({
      message: tr(
        `${pumps} music swell(s) shorter than 300 ms (pumping)`,
        `${pumps} remontée(s) de la musique de moins de 300 ms (pompage)`,
      ),
    });
  if (items === 1 && depths.length === 0)
    return notEvaluated("audio.ducking", tr("no speech under the music", "aucune parole sous la musique"));
  depths.sort((a, b) => a - b);
  return graded("audio.ducking", items, violations, {
    speech: depths.length,
    medianDepthDb: depths.length
      ? Math.round((depths[Math.floor(depths.length / 2)] as number) * 10) / 10
      : null,
    steepSteps: steep,
    pumps,
  });
}

/**
 * Sound effects: each effect's loudest instant, measured on the rendered effects
 * stem, must fall within ±1 frame of the visual event it is synced to (the cut
 * of its transition, the start of its punch-in).
 */
export async function checkSfxSync(video: string, edl: Edl, profile: StyleProfile): Promise<CheckResult> {
  const fps = edl.output.fps;
  const clips = edl.audio.flatMap((t) => t.clips.filter((c) => c.asset !== undefined && c.syncTo));
  if (clips.length === 0) return notEvaluated("audio.sfx-sync", tr("no sound effect", "aucun effet sonore"));
  const path = `${video}.sfx.wav`;
  if (!existsSync(path))
    return notEvaluated(
      "audio.sfx-sync",
      tr(
        "SFX stem missing (rendered without --keep-stems)",
        "stem des effets absent (rendu sans --keep-stems)",
      ),
    );
  const { samples, rate } = await readWavF32(path);
  const tol = profile.audio.sfxToleranceFrames;
  const violations: Violation[] = [];
  const errors: number[] = [];
  for (const c of clips) {
    const [kind, id] = (c.syncTo as string).split(/:(.*)/s);
    let expected: number | undefined;
    if (kind === "transition") expected = edl.transitions.find((t) => t.id === id)?.atFrame;
    else if (kind === "keyframes") expected = edl.keyframes.find((k) => k.target === id)?.keys[0]?.frame;
    else if (kind === "cut") expected = edl.video[0]?.clips.find((v) => v.id === id)?.at;
    if (expected === undefined) {
      violations.push({
        message: tr(
          `${c.id}: event « ${c.syncTo} » not found`,
          `${c.id} : événement « ${c.syncTo} » introuvable`,
        ),
        frame: c.at,
      });
      continue;
    }
    const from = Math.round(framesToSeconds(c.at, fps) * rate);
    const to = Math.min(samples.length / 2, from + Math.round((c.out - c.in) * rate));
    const peak = from + envelopePeak(samples.subarray(from * 2, to * 2), rate);
    const err = (peak / rate) * fps - expected;
    errors.push(Math.abs(err));
    if (Math.abs(err) > tol + 1e-9)
      violations.push({
        message: tr(
          `${c.id} (${c.asset}): impact at ${err > 0 ? "+" : ""}${err.toFixed(1)} frame(s) from ${c.syncTo}`,
          `${c.id} (${c.asset}) : impact à ${err > 0 ? "+" : ""}${err.toFixed(1)} frame(s) de ${c.syncTo}`,
        ),
        frame: expected,
      });
  }
  return graded("audio.sfx-sync", clips.length, violations, {
    sfx: clips.length,
    maxErrorFrames: errors.length ? Math.round(Math.max(...errors) * 100) / 100 : null,
  });
}

/**
 * Dialogue balance: on the rendered dialogue, each rush's speech plays at a
 * similar level (loud speech: 90th percentile of 10 ms frames above the noise,
 * per rush), within the profile's spread. A second camera's mic left 8 dB under
 * the first sounds like a cut to another room.
 */
export async function checkDialogueBalance(
  video: string,
  edl: Edl,
  profile: StyleProfile,
): Promise<CheckResult> {
  const fps = edl.output.fps;
  const spans = mainAudioSpans(edl);
  const sources = new Set(spans.map((s) => s.clip.source));
  if (sources.size < 2) return notEvaluated("audio.dialogue-balance", tr("a single rush", "un seul rush"));
  const voice = existsSync(`${video}.voice.wav`) ? `${video}.voice.wav` : video;
  const rate = 16_000;
  const samples = await decodeMono(voice, rate);
  const hop = rate / 100;
  const frames = Math.floor(samples.length / hop);
  const db = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = f * hop; i < (f + 1) * hop; i++) sum += (samples[i] as number) ** 2;
    db[f] = 10 * Math.log10(sum / hop + 1e-12);
  }
  const floor = [...db].sort((a, b) => a - b)[Math.floor(frames * 0.1)] ?? -120;
  const bySource = new Map<string, number[]>();
  for (const span of spans) {
    const from = Math.floor(framesToSeconds(span.startFrame, fps) * 100);
    const to = Math.min(frames, Math.floor(framesToSeconds(span.endFrame, fps) * 100));
    const list = bySource.get(span.clip.source) ?? [];
    for (let f = from; f < to; f++) if ((db[f] as number) > floor + 15) list.push(db[f] as number);
    bySource.set(span.clip.source, list);
  }
  const levels = new Map<string, number>();
  for (const [source, list] of bySource)
    if (list.length >= 100)
      levels.set(source, [...list].sort((a, b) => a - b)[Math.floor(list.length * 0.9)] as number);
  if (levels.size < 2)
    return notEvaluated("audio.dialogue-balance", tr("speech from a single rush", "parole d'un seul rush"));
  const values = [...levels.values()];
  const spread = Math.max(...values) - Math.min(...values);
  const max = profile.audio.dialogueBalance.maxSpreadDb;
  const measured = Object.fromEntries([...levels].map(([s, v]) => [s, Math.round(v * 10) / 10]));
  return graded(
    "audio.dialogue-balance",
    1,
    spread > max
      ? [
          {
            message: tr(
              `speech levels of the rushes ${spread.toFixed(1)} dB apart (max ${max} dB)`,
              `niveaux de parole des rushes écartés de ${spread.toFixed(1)} dB (max ${max} dB)`,
            ),
          },
        ]
      : [],
    { spreadDb: Math.round(spread * 10) / 10, ...measured },
  );
}
