// Plan schema produced by the Python planner (cutkiller/plan.py).

export type Accent = { frame: number; strength: number; downbeat: boolean };

export type Clip = {
  src: string; // path inside public/ (staged by the renderer)
  from: number;
  durationInFrames: number;
  trimBeforeSec: number;
  kind: "beat" | "downbeat" | "section" | "drop";
  energy: number;
  motion: number;
};

type Base = {
  version: 1;
  fps: number;
  width: number;
  height: number;
  durationInFrames: number;
  bpm: number;
  audio: { src: string; startSec: number };
};

export type CutPlan = Base & {
  mode: "cut";
  title?: string | null;
  drop: number | null;
  clips: Clip[];
  accents: Accent[];
};

export type MotionBeat = Accent & { energy: number };

export type MotionPlan = Base & {
  mode: "motion";
  beatFrames: number;
  feel: "airy" | "punchy";
  title: string;
  subtitle: string;
  palette: { paper: string; accent: string; ink: string };
  heroFrame: number;
  scaleFrame: number;
  beats: MotionBeat[];
};
