/** Outputs of the Python analysis workers, as stored in `Analysis`. */

export interface Word {
  text: string;
  start: number;
  end: number;
  prob?: number;
  /** "forced": CTC-aligned and refined on the signal; "whisper": raw ASR timestamps. */
  timing: "forced" | "whisper";
}

export interface Transcript {
  language: string;
  model: string;
  durationS: number;
  words: Word[];
}

export interface Interval {
  start: number;
  end: number;
}

export interface VoiceActivity {
  durationS: number;
  speech: Interval[];
  noiseFloorDb: number;
  peakDb: number;
  /** Level of loud speech (90th percentile of 10 ms frames), dBFS. */
  speechDb?: number;
  /** Level of the first and last 30 ms of the recording, dBFS. */
  edgeDb?: { start: number; end: number };
}

/** Within this many dB of loud speech, an edge of the recording is still mid-word. */
export const TRUNCATED_EDGE_DB = 15;

/**
 * Whether the recording starts or stops in the middle of a word: its first or
 * last 30 ms are nearly as loud as its speech (a word ending naturally fades
 * 20 dB or more before the file ends). Measured on real rushes: a cut-off
 * « pour… » ends 6 dB under speech, a finished « 6h. » 22 dB under.
 */
export function truncatedEdges(vad: VoiceActivity | undefined): { start: boolean; end: boolean } {
  if (!vad?.edgeDb || vad.speechDb === undefined) return { start: false, end: false };
  const limit = vad.speechDb - TRUNCATED_EDGE_DB;
  return { start: vad.edgeDb.start > limit, end: vad.edgeDb.end > limit };
}

export interface BeatGrid {
  tempoBpm: number;
  beats: number[];
  durationS: number;
}

/** Per-word prosody, aligned with the transcript's words (same indices). */
export interface Prosody {
  words: { rmsDb: number | null; pitchSt: number | null }[];
}

/** A face found in a sample, box as fractions of the frame; `rgb` is the mean skin colour (0–1, gamma-encoded). */
export interface Face {
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
  rgb: [number, number, number];
}

/** Faces and colours of a video source, sampled on the container timeline. */
export interface Subjects {
  width: number;
  height: number;
  sampleFps: number;
  /** `luma`: 5th, 50th and 95th percentiles of the picture's luma (gamma-encoded, 0–1), when measured. */
  samples: { t: number; faces: Face[]; rgb: [number, number, number]; luma?: [number, number, number] }[];
}

/**
 * Where the picture changes, for screen recordings: per sample, the share of the
 * image that changed since the previous sample and the box around the change
 * (fractions of the frame). No box when nothing changed.
 */
export interface Activity {
  fps: number;
  width: number;
  height: number;
  samples: { t: number; fraction: number; cx?: number; cy?: number; w?: number; h?: number }[];
}

/** Per-source analyzer results, keyed by source id. */
export interface AnalyzerResults {
  subjects?: Record<string, Subjects>;
  activity?: Record<string, Activity>;
  transcripts?: Record<string, Transcript>;
  prosody?: Record<string, Prosody>;
  vad?: Record<string, VoiceActivity>;
  beats?: Record<string, BeatGrid>;
}
