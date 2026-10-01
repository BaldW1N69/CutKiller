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

/** Per-source analyzer results, keyed by source id. */
export interface AnalyzerResults {
  transcripts?: Record<string, Transcript>;
  prosody?: Record<string, Prosody>;
  vad?: Record<string, VoiceActivity>;
  beats?: Record<string, BeatGrid>;
}
