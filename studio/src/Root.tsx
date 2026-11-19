import { CalculateMetadataFunction, Composition } from "remotion";
import { BeatCut } from "./BeatCut";
import { EditorialReel } from "./EditorialReel";
import { MotionDesign } from "./MotionDesign";
import type { CutPlan, MotionPlan, ReelPlan } from "./types";

// Duration, size and fps come from the plan JSON passed with --props.
const fromPlan: CalculateMetadataFunction<CutPlan | MotionPlan | ReelPlan> = ({ props }) => ({
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

const reelDefaults: ReelPlan = {
  version: 1,
  mode: "reel",
  fps,
  width: 1080,
  height: 1920,
  durationInFrames: 240,
  bpm: 120,
  beatFrames: 15,
  audio: { src: "", startSec: 0 },
  video: { src: "https://remotion.media/video.mp4", width: 1920, height: 1080 },
  brand: { name: "BRAND", accent: "#FF3B30", tagline: "THE TEAM" },
  shots: [{ from: 0, dur: 240, inSec: 0 }],
  captions: [{ from: 10, dur: 100, text: "hello world" }],
  tags: [{ from: 0, text: "01" }],
  beats: Array.from({ length: 16 }, (_, i) => i * 15),
  heroFrame: 120,
  scaleFrame: 180,
  endFrame: 220,
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
    <Composition
      id="EditorialReel"
      component={EditorialReel}
      durationInFrames={240}
      fps={fps}
      width={1080}
      height={1920}
      defaultProps={reelDefaults}
      calculateMetadata={fromPlan as CalculateMetadataFunction<ReelPlan>}
    />
  </>
);
