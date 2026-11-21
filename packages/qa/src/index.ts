import {
  type Analysis,
  dominantLanguage,
  type Edl,
  localizeProfile,
  type StyleProfile,
} from "@cutkiller/core";
import { PresetRegistry } from "@cutkiller/style";
import { checkCutClicks, checkDucking, checkLoudness, checkSfxSync } from "./checks/audio";
import {
  checkCaptionContrast,
  checkCaptionDensity,
  checkCaptionReadingTime,
  checkCaptionSync,
  checkSafeZones,
} from "./checks/captions";
import { checkJlCuts, checkNoLinear, edlErrors } from "./checks/edl";
import {
  checkBitrate,
  checkBlackFrames,
  checkDuplicateFrames,
  checkExportFormat,
  checkSharpness,
} from "./checks/image";
import {
  checkBeatCuts,
  checkFillers,
  checkHook,
  checkSilences,
  checkStaticShots,
  checkWholeWords,
} from "./checks/montage";
import {
  checkDurations,
  checkMotionBlur,
  checkOvershoot,
  checkPresets,
  checkPunchIns,
} from "./checks/motion";
import { checkColor, checkReframe } from "./checks/subject";
import { buildReport, type CheckResult, type Report } from "./report";
import { checkCaptionSyncTruth, checkFillersTruth, type Label } from "./truth";

export { audioEditFrames, clickScore } from "./checks/audio";
export { contrastRatio, luminance, parseColor } from "./checks/captions";
export { checkSharpness, DUPLICATE_MAD } from "./checks/image";
export { renderSubjects } from "./checks/subject";
export {
  type Comparison,
  compareFingerprints,
  type Fingerprint,
  fingerprint,
  fingerprintMarkdown,
} from "./reference";
export * from "./report";
export * from "./rules";
export * from "./truth";

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
  /** Human annotation of the render (word onsets, hesitations heard): replaces the models for captions.sync and montage.fillers. */
  truth?: Label[];
}

/**
 * Analyzes a rendered video (and the EDL that produced it) against every rule of
 * the quality standards. Rules whose check is not delivered yet are reported as
 * not evaluated and left out of the score.
 */
export async function qualityCheck(input: QualityCheckInput): Promise<Report> {
  const started = Date.now();
  const registry = input.registry ?? (await PresetRegistry.load());
  const ctx = {
    video: input.video,
    profile: input.profile,
    baseDir: input.baseDir ?? ".",
    registry,
    ...(input.edl ? { edl: input.edl } : {}),
  };
  const results: CheckResult[] = [];
  /** Runs one check and records how long it took. */
  const run = async (check: () => CheckResult | CheckResult[] | Promise<CheckResult | CheckResult[]>) => {
    const t0 = Date.now();
    const out = await check();
    const list = Array.isArray(out) ? out : [out];
    for (const r of list) results.push({ ...r, ms: Date.now() - t0 });
  };
  await run(() => checkExportFormat(ctx));
  await run(() => checkBitrate(ctx));
  await run(() => checkBlackFrames(ctx));
  await run(() => checkDuplicateFrames(ctx));
  const edl = input.edl;
  if (edl) {
    const errors = edlErrors(edl);
    if (errors.length > 0) throw new Error(`EDL invalide : ${errors.map((e) => e.message).join("; ")}`);
    const { analysis, video } = input;
    const language = dominantLanguage(analysis?.transcripts) ?? "fr";
    const profile = localizeProfile(input.profile, language);
    await run(() => checkNoLinear(edl));
    await run(() => checkJlCuts(edl, profile));
    await run(() => checkCutClicks(video, edl, profile));
    await run(() => checkLoudness(video, profile));
    await run(() => checkSfxSync(video, edl, profile));
    const hasSpeech = Object.keys(analysis?.transcripts ?? {}).length > 0;
    if (hasSpeech) await run(() => checkDucking(video, edl, profile));
    await run(() => checkStaticShots(edl, profile));
    await run(() => checkPunchIns(edl, profile));
    await run(() => checkPresets(edl, registry, profile));
    await run(() => checkDurations(edl, profile, registry));
    await run(() => checkOvershoot(edl, registry, profile));
    await run(() => checkMotionBlur(video, edl, registry, profile));
    await run(() => checkBeatCuts(edl, profile, analysis));
    await run(() => checkReframe(video, edl, profile, analysis));
    await run(() => checkColor(video, edl, profile));
    await run(() => checkSharpness(edl, profile));
    await run(() => checkCaptionDensity(edl, profile));
    await run(() => checkCaptionReadingTime(edl, profile));
    await run(() => checkSafeZones(edl, profile, registry));
    await run(() => checkCaptionContrast(video, edl, profile, registry));
    const truth = input.truth;
    if (truth) await run(() => checkCaptionSyncTruth(edl, profile, truth));
    else if (input.alignCaptions !== false)
      await run(() => checkCaptionSync(video, edl, profile, analysis, ctx.baseDir));
    if (hasSpeech) {
      await run(() => checkSilences(video, edl, profile, analysis));
      await run(() => checkHook(video, profile));
      await run(() => checkWholeWords(edl, profile, analysis));
      if (truth) await run(() => checkFillersTruth(truth, profile, edl.output.fps));
      else if (input.transcribeOutput !== false)
        await run(() => checkFillers(video, profile, edl.output.fps, undefined, language));
    }
  }
  return buildReport(
    {
      video: input.video,
      profile: `${input.profile.id}@${input.profile.version}`,
      ...(input.edlPath ? { edl: input.edlPath } : {}),
    },
    results,
    {
      profile: input.profile,
      ...(input.edl ? { fps: input.edl.output.fps } : {}),
      seconds: (Date.now() - started) / 1000,
    },
  );
}
