import {
  clipFrames,
  cubicBezierAt,
  type Diagnostic,
  type Ease,
  EaseSchema,
  type Edl,
  EdlSchema,
  NAMED_EASES,
  type Pass,
  type VideoClip,
} from "@cutkiller/core";
import { planCamera, subjectTrack } from "./plan";

export { type CameraKey, type CameraSettings, planCamera, subjectTrack } from "./plan";

/**
 * Peak of |d²y/dx²| of an easing curve over [0, 1]: a move of D pixels over T frames
 * accelerates at most peak·D/T² px/frame². Infinite for curves that are not
 * cubic-béziers (springs, holds): those cannot be bounded this way.
 */
export function easePeakAcceleration(ease: Ease): number {
  const bezier =
    typeof ease === "string" && ease !== "hold"
      ? NAMED_EASES[ease]
      : typeof ease === "object" && "cubicBezier" in ease
        ? ease.cubicBezier
        : undefined;
  if (!bezier) return Number.POSITIVE_INFINITY;
  const n = 1000;
  const y = (i: number) => cubicBezierAt(bezier, i / n);
  let peak = 0;
  for (let i = 1; i < n; i++) peak = Math.max(peak, Math.abs(y(i + 1) - 2 * y(i) + y(i - 1)) * n * n);
  return peak;
}

/**
 * Passe « reframe » : quand le rush n'a pas le format de sortie (16:9 → 9:16), le
 * cadre de chaque plan suit le visage du sujet comme une caméra posée — immobile
 * tant que le sujet reste dans la zone morte, glissement en douceur sinon — et se
 * recale librement à chaque coupe.
 */
export const reframePass: Pass = {
  id: "reframe",
  run(edl: Edl, ctx) {
    const cfg = ctx.profile.reframe;
    const diagnostics: Diagnostic[] = [];
    if (!cfg.enabled) return { edl, diagnostics };
    const { width: W, height: H, fps } = edl.output;
    const ease = EaseSchema.parse(cfg.ease) as Ease;
    // Moves are slowed down until their acceleration stays under the QA bound
    // (with a margin for key frames rounded to whole frames).
    const peak = easePeakAcceleration(ease);
    const accel = 0.85 * ctx.profile.reframe.maxAccelPx;
    let reframed = 0;
    let moves = 0;
    const video = edl.video.map((track, t) => ({
      ...track,
      clips: track.clips.map((clip): VideoClip => {
        if (t > 0) return clip;
        const source = edl.sources[clip.source];
        const subjects = ctx.analysis.subjects?.[clip.source];
        if (!source?.width || !source.height || !subjects || source.still || clip.fit !== "cover")
          return clip;
        const srcAspect = source.width / source.height;
        if (Math.abs(srcAspect - W / H) / (W / H) < 0.05) return clip;
        const axis = srcAspect > W / H ? "x" : "y";
        // Crop size along the axis, as a fraction of the source.
        const ch = Math.min(source.height, (source.width * H) / W) / clip.transform.scale;
        const crop = axis === "x" ? (ch * W) / H / source.width : ch / source.height;
        const frames = clipFrames(clip, fps);
        const duration = frames / fps;
        // Output pixels per unit of source fraction along the axis.
        const pxPerUnit = (axis === "x" ? W : H) / crop;
        const camera = planCamera(subjectTrack(subjects, axis, clip.in, clip.out), crop, duration, {
          ...cfg,
          minMoveS: (distance) => Math.sqrt((peak * distance * pxPerUnit) / accel) / fps,
        });
        if (!camera) return clip;
        reframed++;
        moves += Math.max(0, camera.length - 1) / 2;
        const keys: NonNullable<VideoClip["reframe"]>["keys"] = [];
        for (const k of camera) {
          const frame = clip.at + Math.min(frames, Math.round(k.t * fps));
          const value = Math.round(Math.min(1, Math.max(0, k.value)) * 1e4) / 1e4;
          const last = keys.at(-1);
          if (last && frame <= last.frame) continue;
          keys.push(keys.length === 0 ? { frame, value } : { frame, value, ease });
        }
        return {
          ...clip,
          transform: { ...clip.transform, x: 0, y: 0 },
          reframe: { axis, keys, why: { kind: "subject", note: `visage suivi, ${keys.length} clé(s)` } },
        };
      }),
    }));
    diagnostics.push({
      level: "info",
      code: "reframe.summary",
      message: `${reframed} plan(s) recadré(s) sur le visage, ${Math.round(moves)} mouvement(s) de caméra`,
    });
    return { edl: EdlSchema.parse({ ...edl, video }), diagnostics };
  },
};
