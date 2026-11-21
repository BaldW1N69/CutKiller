/**
 * Screen zoom for tutorials: the virtual camera pushes in on where the screen
 * changes (cursor, typing, a menu opening) and pulls back out when the whole
 * screen changes (a new window). Moves are eased, never shorter than
 * `screenZoom.moveS`, and a framing is held at least `screenZoom.holdS`, so the
 * viewer is never dragged around.
 *
 * Output: keyframe tracks `<clip>.scale`, `<clip>.x`, `<clip>.y` (role "move").
 * The picture is scaled by k about the frame centre and shifted by (x, y)
 * output-frame fractions; centring the point (cx, cy) needs x = −k·(cx − ½),
 * clamped to ±(k − 1)/2 so the frame never leaves the picture.
 */
import {
  type Activity,
  type Diagnostic,
  type Edl,
  EdlSchema,
  type KeyframeTrack,
  type Pass,
  sortedClips,
  tr,
} from "@cutkiller/core";

interface Framing {
  k: number;
  x: number;
  y: number;
}

const WIDE: Framing = { k: 1, x: 0, y: 0 };

function framingOn(cx: number, cy: number, k: number): Framing {
  const lim = (k - 1) / 2;
  const clamp = (v: number) => Math.max(-lim, Math.min(lim, v));
  return { k, x: clamp(-k * (cx - 0.5)), y: clamp(-k * (cy - 0.5)) };
}

const differs = (a: Framing, b: Framing) =>
  Math.abs(a.k - b.k) > 0.05 || Math.abs(a.x - b.x) > 0.08 || Math.abs(a.y - b.y) > 0.08;

/** Desired framing at each activity sample inside [from, to) seconds of the source. */
function desired(activity: Activity, from: number, to: number, scale: number, maxFraction: number) {
  const out: { t: number; framing: Framing | undefined }[] = [];
  for (const s of activity.samples) {
    if (s.t < from || s.t >= to) continue;
    if (s.fraction > maxFraction) out.push({ t: s.t, framing: WIDE });
    else if (s.fraction > 0 && s.cx !== undefined && s.cy !== undefined)
      out.push({ t: s.t, framing: framingOn(s.cx, s.cy, scale) });
    else out.push({ t: s.t, framing: undefined }); // idle: keep the current framing
  }
  return out;
}

export const screenZoomPass: Pass = {
  id: "screen-zoom",
  run(edl: Edl, ctx) {
    const cfg = ctx.profile.screenZoom;
    const diagnostics: Diagnostic[] = [];
    if (!cfg.enabled || !ctx.analysis.activity) return { edl, diagnostics };
    const fps = edl.output.fps;
    const moveF = Math.max(2, Math.round(cfg.moveS * fps));
    const holdF = Math.round(cfg.holdS * fps);
    // Successive push-ins never land on the same level (the punch-in rule): 0, −0.1, +0.1.
    const levels = [cfg.scale, cfg.scale - 0.1, cfg.scale + 0.1].map((k) => Math.max(1.05, k));
    let level = 0;
    const tracks: KeyframeTrack[] = [];
    let moves = 0;
    for (const clip of sortedClips(edl.video[0]?.clips ?? [])) {
      const activity = ctx.analysis.activity[clip.source];
      if (!activity) continue;
      const frames = Math.round((clip.out - clip.in) * fps);
      if (frames < moveF + 2) continue;
      const keys: { frame: number; f: Framing }[] = [{ frame: clip.at, f: WIDE }];
      let current = WIDE;
      let lastChange = clip.at - holdF;
      const wanted = desired(activity, clip.in, clip.out, cfg.scale, cfg.maxFraction);
      for (const [i, d] of wanted.entries()) {
        if (!d.framing) continue;
        // Only a target confirmed by the next sample: when the action jumps, the change
        // covers both places for one sample, and its middle is nowhere worth going.
        const next = wanted.slice(i + 1).find((n) => n.framing)?.framing;
        if (!next || differs(next, d.framing)) continue;
        const at = clip.at + Math.round((d.t - clip.in) * fps);
        if (at <= clip.at || at - lastChange < holdF || at + moveF > clip.at + frames - 1) continue;
        let target = d.framing;
        if (target.k > 1) {
          // Already in: follow the action at the same level; coming in: next level.
          const k = current.k > 1 ? current.k : (levels[level % levels.length] as number);
          target = framingOn(0.5 - target.x / target.k, 0.5 - target.y / target.k, k);
        }
        if (!differs(current, target)) continue;
        if (target.k > 1 && current.k === 1) level++;
        keys.push({ frame: at, f: current }, { frame: at + moveF, f: target });
        current = target;
        lastChange = at;
        moves++;
      }
      if (keys.length < 3) continue;
      for (const prop of ["scale", "x", "y"] as const) {
        const pick = (f: Framing) => Math.round((prop === "scale" ? f.k : f[prop]) * 10000) / 10000;
        tracks.push({
          target: `${clip.id}.${prop}`,
          role: "move",
          keys: keys.map((k, i) => ({
            frame: k.frame,
            value: pick(k.f),
            ...(i > 0 ? { ease: "ease-in-out" as const } : {}),
          })),
          why: {
            kind: "screen-zoom",
            note: tr("zoom on the active area of the screen", "zoom sur la zone active de l'écran"),
          },
        });
      }
    }
    diagnostics.push({
      level: "info",
      code: "screen-zoom.summary",
      message: tr(`${moves} screen zoom move(s)`, `${moves} mouvement(s) de zoom sur l'écran`),
    });
    return { edl: EdlSchema.parse({ ...edl, keyframes: [...edl.keyframes, ...tracks] }), diagnostics };
  },
};
