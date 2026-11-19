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

export type ReelShot = {
  from: number;
  dur: number;
  inSec: number;
  cx?: number; // focus point in source pixels
  cy?: number;
  zoom?: number; // 1 = full frame
  push?: number; // zoom added over the shot
  tag?: string;
};

export type ReelPlan = Base & {
  mode: "reel";
  beatFrames: number;
  video: { src: string; width: number; height: number };
  brand: { name: string; accent: string; tagline: string };
  shots: ReelShot[];
  captions: { from: number; dur: number; text: string }[];
  tags: { from: number; text: string }[];
  beats: number[];
  heroFrame: number;
  scaleFrame: number;
  endFrame: number;
};
