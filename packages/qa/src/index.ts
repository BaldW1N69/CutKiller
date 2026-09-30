import type { Edl, StyleProfile } from "@cutkiller/core";
import { checkCutClicks } from "./checks/audio";
import { checkJlCuts, checkNoLinear, edlErrors } from "./checks/edl";
import { checkBitrate, checkBlackFrames, checkDuplicateFrames, checkExportFormat } from "./checks/image";
import { buildReport, type CheckResult, type Report } from "./report";

export { audioEditFrames, clickScore } from "./checks/audio";
export { DUPLICATE_MAD } from "./checks/image";
export * from "./report";
export * from "./rules";

export interface QualityCheckInput {
  video: string;
  profile: StyleProfile;
  edl?: Edl;
  edlPath?: string;
  /** Directory the EDL's relative source paths resolve against. */
  baseDir?: string;
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
