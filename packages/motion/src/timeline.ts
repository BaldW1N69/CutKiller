import {
  type AnimationIndex,
  type AnimState,
  animationIndex,
  animStateAt,
  clipEnd,
  clipFraming,
  displacement,
  type Edl,
  easeProgress,
  effectiveOut,
  type Framing,
  framesToSeconds,
  sortedClips,
  type VideoClip,
} from "@cutkiller/core";
import { directionVector, type ResolvedTransition } from "./presets";

/** Share of a dip to black spent fully black, around the cut. */
const DIP_HOLD = 0.15;

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
    // Dissolve handles: the outgoing shot keeps playing after the cut, the incoming one
    // starts before it, when their rushes have the material (else their picture holds).
    for (const tr of transitions) {
      if (tr.params.type !== "dissolve" || tr.params.via !== "direct") continue;
      const k = this.main.findIndex((c) => c.at === tr.atFrame);
      const outgoing = this.main[k - 1];
      const incoming = this.main[k];
      if (!outgoing || !incoming) continue;
      const tail = tr.window[1] - tr.atFrame;
      const head = tr.atFrame - tr.window[0];
      if (this.room(outgoing, "after") >= tail) this.pad(outgoing.id).tail = tail;
      if (this.room(incoming, "before") >= head) this.pad(incoming.id).head = head;
    }
  }

  private readonly pads = new Map<string, { head: number; tail: number }>();

  private pad(id: string): { head: number; tail: number } {
    let p = this.pads.get(id);
    if (!p) {
      p = { head: 0, tail: 0 };
      this.pads.set(id, p);
    }
    return p;
  }

  /** Frames of rush available before a clip's in point or after its out point. */
  private room(clip: VideoClip, side: "before" | "after"): number {
    const source = this.edl.sources[clip.source];
    if (!source) return 0;
    if (source.still) return Number.POSITIVE_INFINITY;
    if (side === "before") return Math.floor(clip.in * this.fps + 1e-6);
    if (source.durationS === undefined) return 0;
    return Math.floor((source.durationS - effectiveOut(clip, this.fps)) * this.fps + 1e-6);
  }

  /**
   * Frames a clip plays beyond its own span: `head` before its start, `tail` after
   * its end (dissolve handles, taken from its rush). The renderer decodes them.
   */
  handles(clip: VideoClip): { head: number; tail: number } {
    return this.pads.get(clip.id) ?? { head: 0, tail: 0 };
  }

  private readonly framings = new Map<string, Framing | undefined>();

  /** Moving-framing geometry of a clip (undefined when its framing is static). */
  framing(clip: VideoClip): Framing | undefined {
    if (!this.framings.has(clip.id))
      this.framings.set(clip.id, clip.fit === "cover" ? clipFraming(this.edl, clip) : undefined);
    return this.framings.get(clip.id);
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
    alpha?: (t: number) => number,
  ): LayerPlan {
    return {
      clip,
      track,
      image,
      state: (t) => {
        const s = animStateAt(this.index, clip.id, t, this.fps);
        // Moving framing: the decoded band pans so that the crop centre stays mid-picture.
        const framing = this.framing(clip);
        if (framing) {
          const [dx, dy] = framing.shiftAt(t);
          s.x += (dx * s.scale) / this.edl.output.width;
          s.y += (dy * s.scale) / this.edl.output.height;
        }
        if (offset) {
          const [dx, dy] = offset(t);
          s.x += dx;
          s.y += dy;
        }
        if (alpha) s.opacity *= alpha(t);
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
      const before = f < tr.atFrame;
      if (tr.params.type === "dissolve") {
        if (tr.params.via === "black") {
          // Out to black over the first half, in from black over the second, with a
          // short hold on black (15 % of the duration) so the dip reads as one.
          const fade = (t: number) =>
            Math.max(0, Math.abs(1 - 2 * this.progress(tr, t)) - DIP_HOLD) / (1 - DIP_HOLD);
          layers.push(
            before
              ? this.layer(outgoing, 0, "live", undefined, fade)
              : this.layer(incoming, 0, "live", undefined, fade),
          );
        } else {
          // Handles: both shots keep moving through the dissolve when their rushes allow.
          const out = before || this.handles(outgoing).tail > 0 ? "live" : "last";
          const inc = !before || this.handles(incoming).head > 0 ? "live" : "first";
          layers.push(
            this.layer(outgoing, 0, out),
            this.layer(incoming, 0, inc, undefined, (t) => this.progress(tr, t)),
          );
        }
        for (const o of this.overlays) {
          const clip = o.clips.find((c) => c.at <= f && f < clipEnd(c, this.fps));
          if (clip) layers.push(this.layer(clip, o.track, "live"));
        }
        return layers;
      }
      const [vx, vy] = directionVector(tr.params.direction);
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
