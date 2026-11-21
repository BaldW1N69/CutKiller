import {
  type Edl,
  isLinearEase,
  SPATIAL_PROPERTIES,
  type StyleProfile,
  tr,
  validateEdl,
} from "@cutkiller/core";
import { type CheckResult, graded, notEvaluated, type Violation } from "../report";

/** Every keyframe segment of a spatial property must use an easing curve or a spring. */
export function checkNoLinear(edl: Edl): CheckResult {
  let segments = 0;
  const violations: Violation[] = [];
  for (const track of edl.keyframes) {
    const prop = track.target.slice(track.target.lastIndexOf(".") + 1);
    if (!SPATIAL_PROPERTIES.has(prop)) continue;
    track.keys.slice(1).forEach((key) => {
      segments++;
      if (isLinearEase(key.ease))
        violations.push({
          message: tr(`${track.target}: linear segment`, `${track.target} : segment linéaire`),
          frame: key.frame,
        });
    });
  }
  if (segments === 0)
    return notEvaluated("motion.no-linear", tr("no animation in the EDL", "aucune animation dans l'EDL"));
  return graded("motion.no-linear", segments, violations, { segments });
}

export function checkJlCuts(edl: Edl, profile: StyleProfile): CheckResult {
  const [min, max] = profile.montage.jlCutFrames;
  const splits = edl.video.flatMap((t) => t.clips).filter((c) => c.audioSplitFrames !== 0);
  if (splits.length === 0)
    return notEvaluated("montage.jl-cuts", tr("no J/L cut in the EDL", "aucun J/L cut dans l'EDL"));
  const violations = splits
    .filter((c) => Math.abs(c.audioSplitFrames) < min || Math.abs(c.audioSplitFrames) > max)
    .map((c) => ({
      message: tr(
        `${c.id}: offset of ${c.audioSplitFrames} frames (expected ${min}–${max})`,
        `${c.id} : décalage de ${c.audioSplitFrames} frames (attendu ${min}–${max})`,
      ),
      frame: c.at,
    }));
  return graded("montage.jl-cuts", splits.length, violations, { jlCuts: splits.length });
}

export function edlErrors(edl: Edl): Violation[] {
  return validateEdl(edl)
    .filter((d) => d.level === "error")
    .map((d) => ({ message: `${d.code} : ${d.message}${d.path ? ` (${d.path})` : ""}` }));
}
