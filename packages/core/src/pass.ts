import type { AnalyzerResults } from "./analysis";
import type { Edl } from "./edl";
import { tr } from "./i18n";
import type { StyleProfile } from "./profile";
import type { Diagnostic } from "./validate";
import { validateEdl } from "./validate";

/**
 * Output of the analysis stage (Python workers + probes). Each analyzer adds its
 * own key in later phases; passes must tolerate missing keys.
 */
export interface Analysis extends AnalyzerResults {
  sources: Record<string, SourceProbe>;
}

export interface SourceProbe {
  path: string;
  durationS: number;
  hasVideo: boolean;
  hasAudio: boolean;
  width?: number;
  height?: number;
  fps?: number;
  /** Variable frame rate (typical of phone footage). */
  vfr?: boolean;
  still?: boolean;
  /** B-roll (cutaways, montage material): not transcribed, never on the speech track. */
  role?: "broll";
}

/** Structural view of the preset registry (implemented by @cutkiller/style). */
export interface PresetResolver {
  resolve(ref: string): { name: string; version: string; kind: string; params: Record<string, unknown> };
}

export interface PassContext {
  analysis: Analysis;
  profile: StyleProfile;
  /** Needed by passes that place presets (motion, captions, audio). */
  presets?: PresetResolver;
}

export interface PassResult {
  edl: Edl;
  diagnostics: Diagnostic[];
}

/** A planning pass: pure and deterministic, EDL in, EDL out. */
export interface Pass {
  id: PassId;
  run(edl: Edl, ctx: PassContext): PassResult;
}

/** Fixed order: B-roll once the speech is cut; reframe before motion/captions (they depend on the final frame), audio last (SFX follow transitions). */
export const PASS_ORDER = [
  "cut",
  "broll",
  "reframe",
  "screen-zoom",
  "color",
  "motion",
  "captions",
  "audio",
] as const;
export type PassId = (typeof PASS_ORDER)[number];

export function runPasses(edl: Edl, passes: readonly Pass[], ctx: PassContext): PassResult {
  const byId = new Map(passes.map((p) => [p.id, p]));
  const diagnostics: Diagnostic[] = [];
  let current = edl;
  for (const id of PASS_ORDER) {
    const pass = byId.get(id);
    if (!pass) continue;
    const result = pass.run(current, ctx);
    diagnostics.push(...result.diagnostics);
    const invalid = validateEdl(result.edl).filter((d) => d.level === "error");
    if (invalid.length > 0) {
      throw new Error(
        tr(
          `pass « ${id} » produced an invalid EDL: ${invalid.map((d) => d.message).join("; ")}`,
          `la passe « ${id} » a produit une EDL invalide : ${invalid.map((d) => d.message).join("; ")}`,
        ),
      );
    }
    current = result.edl;
  }
  return { edl: current, diagnostics };
}

/** Identity pass for modules whose phase has not been implemented yet. */
export function identityPass(id: PassId): Pass {
  return { id, run: (edl) => ({ edl, diagnostics: [] }) };
}
