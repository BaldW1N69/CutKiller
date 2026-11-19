import { z } from "zod";

/**
 * Procedural sound effects: every sound is computed from its preset (seeded
 * noise, filters, envelopes), so the repository ships no audio file and a given
 * preset version always renders the same samples. Each sound has a *hit*: the
 * instant of its loudest point, which the audio pass lands on the visual event.
 */
const Common = {
  durationMs: z.number().positive().max(3000),
  /** Loudest instant, from the start of the sound. */
  hitMs: z.number().nonnegative(),
  seed: z.number().int().default(1),
};

export const SfxParamsSchema = z.discriminatedUnion("type", [
  /** Band-passed noise whose centre sweeps up to the hit and back down: an air rush. */
  z.object({
    type: z.literal("whoosh"),
    ...Common,
    lowHz: z.number().positive(),
    highHz: z.number().positive(),
    q: z.number().positive().default(1.2),
    /** Envelope sharpness before (rise) and after (fall) the hit. */
    rise: z.number().positive().default(2),
    fallMs: z.number().positive().default(120),
    /** Pan travel from left to right across the sound (0 = mono). */
    pan: z.number().min(0).max(1).default(0.6),
  }),
  /** Bit-crushed noise and square bursts, densest on the hit. */
  z.object({
    type: z.literal("glitch"),
    ...Common,
    bursts: z.number().int().positive().default(7),
    bits: z.number().int().min(1).max(16).default(4),
  }),
  /** Short pitched thump with a click: an impact under a punch-in. */
  z.object({
    type: z.literal("tick"),
    ...Common,
    fromHz: z.number().positive(),
    toHz: z.number().positive(),
    decayMs: z.number().positive().default(60),
    click: z.number().min(0).max(1).default(0.3),
  }),
]);

export type SfxParams = z.infer<typeof SfxParamsSchema>;

export interface SfxSound {
  /** Interleaved stereo samples, peak at -1 dBFS. */
  samples: Float32Array;
  rate: number;
  /** Sample index of the hit. */
  hitSample: number;
}

/** Same generator as the glitch transition (mulberry32): deterministic per seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Peak-normalises to -1 dBFS (the hit stays where it is). */
function normalise(stereo: Float32Array): void {
  let peak = 0;
  for (const v of stereo) peak = Math.max(peak, Math.abs(v));
  if (peak === 0) return;
  const g = 10 ** (-1 / 20) / peak;
  for (let i = 0; i < stereo.length; i++) stereo[i] = (stereo[i] as number) * g;
}

function whoosh(p: Extract<SfxParams, { type: "whoosh" }>, rate: number): Float32Array {
  const n = Math.round((p.durationMs / 1000) * rate);
  const hit = Math.round((p.hitMs / 1000) * rate);
  const fall = (p.fallMs / 1000) * rate;
  const rand = rng(p.seed);
  const out = new Float32Array(n * 2);
  // State-variable band-pass, centre retuned every sample (cheap and smooth).
  let low = 0;
  let band = 0;
  for (let i = 0; i < n; i++) {
    const before = i <= hit;
    const x = before ? i / Math.max(1, hit) : (i - hit) / Math.max(1, n - hit);
    const env = before ? x ** p.rise : Math.exp(-(i - hit) / fall);
    const sweep = before ? x : 1 - x;
    const fc = p.lowHz * (p.highHz / p.lowHz) ** sweep;
    const f = 2 * Math.sin((Math.PI * Math.min(fc, rate / 6)) / rate);
    const noise = rand() * 2 - 1;
    low += f * band;
    const high = noise - low - band / p.q;
    band += f * high;
    const v = band * env;
    const pan = 0.5 + p.pan * (i / n - 0.5);
    out[i * 2] = v * Math.cos((pan * Math.PI) / 2);
    out[i * 2 + 1] = v * Math.sin((pan * Math.PI) / 2);
  }
  return out;
}

function glitch(p: Extract<SfxParams, { type: "glitch" }>, rate: number): Float32Array {
  const n = Math.round((p.durationMs / 1000) * rate);
  const hit = Math.round((p.hitMs / 1000) * rate);
  const rand = rng(p.seed);
  const out = new Float32Array(n * 2);
  const levels = 2 ** (p.bits - 1);
  // Bursts: random positions, louder and denser near the hit.
  const bursts = Array.from({ length: p.bursts }, (_, k) => {
    const spread = (rand() * 2 - 1) * (k === 0 ? 0 : 0.5);
    const start = Math.min(n - 1, Math.max(0, Math.round(hit + spread * n * 0.5)));
    return {
      start,
      len: Math.round(rate * (0.008 + rand() * 0.03)),
      period: 8 + Math.floor(rand() * 60),
      gain: k === 0 ? 1 : 0.25 + rand() * 0.25,
    };
  });
  for (const b of bursts) {
    let held = 0;
    for (let j = 0; j < b.len && b.start + j < n; j++) {
      const i = b.start + j;
      if (j % 6 === 0) held = rand() * 2 - 1;
      const square = Math.floor(j / b.period) % 2 === 0 ? 1 : -1;
      const raw = 0.6 * held + 0.4 * square;
      const crushed = Math.round(raw * levels) / levels;
      const env = Math.min(1, j / (rate * 0.001)) * (1 - j / b.len);
      const v = crushed * env * b.gain;
      out[i * 2] = (out[i * 2] as number) + v;
      out[i * 2 + 1] = (out[i * 2 + 1] as number) + v * (j % 2 === 0 ? 1 : 0.7);
    }
  }
  return out;
}

function tick(p: Extract<SfxParams, { type: "tick" }>, rate: number): Float32Array {
  const n = Math.round((p.durationMs / 1000) * rate);
  const hit = Math.round((p.hitMs / 1000) * rate);
  const decay = (p.decayMs / 1000) * rate;
  const rand = rng(p.seed);
  const out = new Float32Array(n * 2);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = Math.max(0, i - hit);
    const freq = p.toHz + (p.fromHz - p.toHz) * Math.exp(-t / (decay * 0.5));
    phase += (2 * Math.PI * freq) / rate;
    const attack = i < hit ? i / Math.max(1, hit) : 1;
    const env = attack * Math.exp(-t / decay);
    const click = t < rate * 0.003 ? (rand() * 2 - 1) * p.click : 0;
    const v = (Math.sin(phase) + click) * env;
    out[i * 2] = v;
    out[i * 2 + 1] = v;
  }
  return out;
}

/**
 * Silence before every sound: a clip lands its hit on a whole frame by trimming
 * the start of the sound, which must only ever trim silence (never the attack).
 */
export const SFX_PREROLL_S = 0.05;
/** Fade at the end of every sound, so that it never stops on a non-zero sample. */
const TAIL_FADE_S = 0.01;

/** Length and hit of a preset's rendered sound, preroll included (seconds). */
export function sfxTiming(params: SfxParams): { lengthS: number; hitS: number } {
  return { lengthS: SFX_PREROLL_S + params.durationMs / 1000, hitS: SFX_PREROLL_S + params.hitMs / 1000 };
}

export function synthesize(params: SfxParams, rate: number): SfxSound {
  const body =
    params.type === "whoosh"
      ? whoosh(params, rate)
      : params.type === "glitch"
        ? glitch(params, rate)
        : tick(params, rate);
  normalise(body);
  const fade = Math.round(TAIL_FADE_S * rate);
  const frames = body.length / 2;
  for (let i = Math.max(0, frames - fade); i < frames; i++) {
    const g = (frames - 1 - i) / fade;
    body[i * 2] = (body[i * 2] as number) * g;
    body[i * 2 + 1] = (body[i * 2 + 1] as number) * g;
  }
  const pre = Math.round(SFX_PREROLL_S * rate);
  const samples = new Float32Array(body.length + pre * 2);
  samples.set(body, pre * 2);
  return { samples, rate, hitSample: pre + Math.round((params.hitMs / 1000) * rate) };
}

/** Envelope peak (RMS over `windowMs`) of interleaved stereo samples, as a sample index. */
export function envelopePeak(samples: Float32Array, rate: number, windowMs = 5): number {
  const win = Math.max(1, Math.round((windowMs / 1000) * rate));
  const n = samples.length / 2;
  let best = 0;
  let bestAt = 0;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const l = samples[i * 2] as number;
    const r = samples[i * 2 + 1] as number;
    acc += l * l + r * r;
    if (i >= win) {
      const ol = samples[(i - win) * 2] as number;
      const or = samples[(i - win) * 2 + 1] as number;
      acc -= ol * ol + or * or;
    }
    if (i >= win - 1 && acc > best) {
      best = acc;
      bestAt = i - Math.floor(win / 2);
    }
  }
  return bestAt;
}
