import {
  type AnimationIndex,
  type AnimState,
  animationIndex,
  animStateAt,
  clipEnd,
  displacement,
  type Edl,
  easeProgress,
  framesToSeconds,
  sortedClips,
  type VideoClip,
} from "@cutkiller/core";
import { directionVector, type ResolvedTransition } from "./presets";

/** Which picture of a clip a layer shows: its live frame, or its first/last frame held. */
export type LayerImage = "live" | "first" | "last";

export interface LayerPlan {
  clip: VideoClip;
  track: number;
  image: LayerImage;
  /** Animated state at a fractional timeline frame (for motion-blur sub-samples). */
  state(t: number): AnimState;
}

/**
 * What is on screen at every frame: which clips, which of their pictures, and
 * where they are. Shared by the renderer (to draw) and the QA (to know where
 * motion blur was required), so both judge the same motion.
 */
export class MotionTimeline {
  readonly index: AnimationIndex;
  private readonly main: VideoClip[];
  private readonly overlays: { track: number; clips: VideoClip[] }[];
  private readonly fps: number;

  constructor(
    private readonly edl: Edl,
    readonly transitions: readonly ResolvedTransition[],
  ) {
    this.index = animationIndex(edl);
    this.fps = edl.output.fps;
    this.main = sortedClips(edl.video[0]?.clips ?? []);
    this.overlays = edl.video.slice(1).map((t, i) => ({ track: i + 1, clips: sortedClips(t.clips) }));
  }

  /** Transition whose window contains frame f. */
  transitionAt(f: number): ResolvedTransition | undefined {
    return this.transitions.find((t) => f >= t.window[0] && f < t.window[1]);
  }

  private mainClipAt(f: number): number {
    return this.main.findIndex((c) => c.at <= f && f < clipEnd(c, this.fps));
  }

  /** Eased progress (0 → 1) of a push/slide transition at fractional frame t. */
  private progress(tr: ResolvedTransition, t: number): number {
    if (tr.params.type === "glitch") return 0;
    const [a, b] = tr.window;
    return easeProgress(tr.params.ease, (t - a) / (b - a), framesToSeconds(b - a, this.fps));
  }

  private layer(
    clip: VideoClip,
    track: number,
    image: LayerImage,
    offset?: (t: number) => [number, number],
  ): LayerPlan {
    return {
      clip,
      track,
      image,
      state: (t) => {
        const s = animStateAt(this.index, clip.id, t, this.fps);
        if (offset) {
          const [dx, dy] = offset(t);
          s.x += dx;
          s.y += dy;
        }
        return s;
      },
    };
  }

  /** Layers to draw at frame f, bottom first. */
  layersAt(f: number): LayerPlan[] {
    const layers: LayerPlan[] = [];
    const i = this.mainClipAt(f);
    const tr = this.transitionAt(f);
    if (tr && tr.params.type !== "glitch") {
      const inIdx = this.main.findIndex((c) => c.at === tr.atFrame);
      const outgoing = this.main[inIdx - 1] as VideoClip;
      const incoming = this.main[inIdx] as VideoClip;
      const [vx, vy] = directionVector(tr.params.direction);
      const before = f < tr.atFrame;
      if (tr.params.type === "push") {
        layers.push(
          this.layer(outgoing, 0, before ? "live" : "last", (t) => {
            const p = this.progress(tr, t);
            return [vx * p, vy * p];
          }),
          this.layer(incoming, 0, before ? "first" : "live", (t) => {
            const p = this.progress(tr, t);
            return [-vx * (1 - p), -vy * (1 - p)];
          }),
        );
      } else {
        layers.push(
          this.layer(outgoing, 0, "last"),
          this.layer(incoming, 0, "live", (t) => {
            const p = this.progress(tr, t);
            return [-vx * (1 - p), -vy * (1 - p)];
          }),
        );
      }
    } else if (i >= 0) {
      layers.push(this.layer(this.main[i] as VideoClip, 0, "live"));
    }
    for (const o of this.overlays) {
      const clip = o.clips.find((c) => c.at <= f && f < clipEnd(c, this.fps));
      if (clip) layers.push(this.layer(clip, o.track, "live"));
    }
    return layers;
  }

  /** Fastest on-screen movement at frame f (px/frame): largest corner travel over one frame. */
  velocityAt(f: number): number {
    const { width: W, height: H } = this.edl.output;
    let v = 0;
    for (const layer of this.layersAt(f))
      v = Math.max(v, displacement(W, H, layer.state(f - 0.5), layer.state(f + 0.5)));
    return v;
  }

  /** Glitch strength at frame f (peaks on the cut), with a per-frame seed. */
  glitchAt(f: number): { intensity: number; seed: number } | undefined {
    const tr = this.transitionAt(f);
    if (tr?.params.type !== "glitch") return undefined;
    const [a, b] = tr.window;
    const half = (b - a) / 2;
    const intensity = tr.params.intensity * Math.max(0.25, 1 - Math.abs(f + 0.5 - tr.atFrame) / half);
    return { intensity, seed: tr.params.seed * 7919 + f };
  }
}
