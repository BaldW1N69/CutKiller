import type { Analysis, Edl, StyleProfile } from "@cutkiller/core";
import { PresetRegistry } from "@cutkiller/style";
import { checkCutClicks, checkDucking, checkLoudness, checkSfxSync } from "./checks/audio";
import {
  checkCaptionContrast,
  checkCaptionDensity,
  checkCaptionSync,
  checkSafeZones,
} from "./checks/captions";
import { checkJlCuts, checkNoLinear, edlErrors } from "./checks/edl";
import { checkBitrate, checkBlackFrames, checkDuplicateFrames, checkExportFormat } from "./checks/image";
import { checkBeatCuts, checkFillers, checkSilences, checkStaticShots } from "./checks/montage";
import {
  checkDurations,
  checkMotionBlur,
  checkOvershoot,
  checkPresets,
  checkPunchIns,
} from "./checks/motion";
import { checkColor, checkReframe } from "./checks/subject";
import { buildReport, type CheckResult, type Report } from "./report";

export { audioEditFrames, clickScore } from "./checks/audio";
export { contrastRatio, luminance, parseColor } from "./checks/captions";
export { DUPLICATE_MAD } from "./checks/image";
export { renderSubjects } from "./checks/subject";
export * from "./report";
export * from "./rules";

export interface QualityCheckInput {
  video: string;
  profile: StyleProfile;
  edl?: Edl;
  edlPath?: string;
  /** Directory the EDL's relative source paths resolve against. */
  baseDir?: string;
  /** Analysis the EDL was planned from (transcripts, beats): needed by montage checks. */
  analysis?: Analysis;
  /** Re-transcribe the render to look for leftover hesitations (slow: ~1× real time). Default: true. */
  transcribeOutput?: boolean;
  /** Force-align the captions on the rendered dialogue to measure their sync (needs the models). Default: true. */
  alignCaptions?: boolean;
  /** Preset library the EDL refers to (default: the repo's presets/). */
  registry?: PresetRegistry;
}

/**
 * Analyzes a rendered video (and the EDL that produced it) against every rule of
 * the quality standards. Rules whose check is not delivered yet are reported as
 * not evaluated and left out of the score.
 */
export async function qualityCheck(input: QualityCheckInput): Promise<Report> {
  const ctx = {
    video: input.video,
    profile: input.profile,
    baseDir: input.baseDir ?? ".",
    ...(input.edl ? { edl: input.edl } : {}),
  };
  const results: CheckResult[] = [
    ...(await checkExportFormat(ctx)),
    await checkBitrate(ctx),
    await checkBlackFrames(ctx),
    await checkDuplicateFrames(ctx),
  ];
  if (input.edl) {
    const errors = edlErrors(input.edl);
    if (errors.length > 0) throw new Error(`EDL invalide : ${errors.map((e) => e.message).join("; ")}`);
    results.push(checkNoLinear(input.edl), checkJlCuts(input.edl, input.profile));
    results.push(await checkCutClicks(input.video, input.edl, input.profile));
    results.push(
      await checkLoudness(input.video, input.profile),
      await checkSfxSync(input.video, input.edl, input.profile),
    );
    if (Object.keys(input.analysis?.transcripts ?? {}).length > 0)
      results.push(await checkDucking(input.video, input.edl, input.profile));
    results.push(checkStaticShots(input.edl, input.profile), checkPunchIns(input.edl, input.profile));
    const registry = input.registry ?? (await PresetRegistry.load());
    results.push(
      checkPresets(input.edl, registry, input.profile),
      checkDurations(input.edl, input.profile),
      checkOvershoot(input.edl, registry, input.profile),
      checkMotionBlur(input.video, input.edl, registry, input.profile),
    );
    results.push(checkBeatCuts(input.edl, input.profile, input.analysis));
    results.push(
      await checkReframe(input.video, input.edl, input.profile, input.analysis),
      await checkColor(input.video, input.edl, input.profile),
    );
    results.push(
      checkCaptionDensity(input.edl, input.profile),
      checkSafeZones(input.edl, input.profile, registry),
      await checkCaptionContrast(input.video, input.edl, input.profile, registry),
    );
    if (input.alignCaptions !== false)
      results.push(
        await checkCaptionSync(input.video, input.edl, input.profile, input.analysis, ctx.baseDir),
      );
    const hasSpeech = Object.keys(input.analysis?.transcripts ?? {}).length > 0;
    if (hasSpeech) {
      results.push(await checkSilences(input.video, input.edl, input.profile, input.analysis));
      if (input.transcribeOutput !== false)
        results.push(await checkFillers(input.video, input.profile, input.edl.output.fps));
    }
  }
  return buildReport(
    {
      video: input.video,
      profile: `${input.profile.id}@${input.profile.version}`,
      ...(input.edlPath ? { edl: input.edlPath } : {}),
    },
    results,
  );
}
