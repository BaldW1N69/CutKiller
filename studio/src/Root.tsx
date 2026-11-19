import { CalculateMetadataFunction, Composition } from "remotion";
import { BeatCut } from "./BeatCut";
import { MotionDesign } from "./MotionDesign";
import type { CutPlan, MotionPlan } from "./types";

// Duration, size and fps come from the plan JSON passed with --props.
const fromPlan: CalculateMetadataFunction<CutPlan | MotionPlan> = ({ props }) => ({
  durationInFrames: Math.max(1, props.durationInFrames),
  fps: props.fps,
  width: props.width,
  height: props.height,
});

// Preview defaults (no media): a 128 BPM grid so the Studio shows the motion design.
const bpm = 128;
const fps = 30;
const beatFrames = (60 / bpm) * fps;
const demoBeats = Array.from({ length: 24 }, (_, i) => ({
  frame: Math.round(15 + i * beatFrames),
  strength: i % 4 === 0 ? 1 : 0.5,
  downbeat: i % 4 === 0,
  energy: 0.5,
}));

const motionDefaults: MotionPlan = {
  version: 1,
  mode: "motion",
  fps,
  width: 1920,
  height: 1080,
  durationInFrames: 360,
  bpm,
  beatFrames,
  feel: "punchy",
  audio: { src: "", startSec: 0 },
  title: "CutKiller",
  subtitle: "on the beat",
  palette: { paper: "#FFEDD3", accent: "#FEB649", ink: "#895834" },
  heroFrame: demoBeats[4].frame,
  scaleFrame: demoBeats[8].frame,
  beats: demoBeats,
};

const cutDefaults: CutPlan = {
  version: 1,
  mode: "cut",
  fps,
  width: 1920,
  height: 1080,
  durationInFrames: 90,
  bpm,
  audio: { src: "", startSec: 0 },
  title: null,
  drop: null,
  clips: [],
  accents: [],
};

export const RemotionRoot: React.FC = () => (
  <>
    <Composition
      id="BeatCut"
      component={BeatCut}
      durationInFrames={90}
      fps={fps}
      width={1920}
      height={1080}
      defaultProps={cutDefaults}
      calculateMetadata={fromPlan as CalculateMetadataFunction<CutPlan>}
    />
    <Composition
      id="MotionDesign"
      component={MotionDesign}
      durationInFrames={360}
      fps={fps}
      width={1920}
      height={1080}
      defaultProps={motionDefaults}
      calculateMetadata={fromPlan as CalculateMetadataFunction<MotionPlan>}
    />
  </>
);
