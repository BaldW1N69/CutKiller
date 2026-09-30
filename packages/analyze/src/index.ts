import { resolve } from "node:path";
import type { Analysis } from "@cutkiller/core";
import { probeSource } from "@cutkiller/media";

export { runWorker, workersDir } from "./worker";

/** Stage 1 of the pipeline: probes every input. Analyzers (transcription, beats…) join in later phases. */
export async function analyzeSources(paths: readonly string[]): Promise<Analysis> {
  const sources: Analysis["sources"] = {};
  for (const path of paths) {
    const probe = await probeSource(resolve(path));
    sources[sourceId(path, sources)] = probe;
  }
  return { sources };
}

/** Stable, human-readable source id derived from the file name. */
export function sourceId(path: string, taken: Record<string, unknown> = {}): string {
  const base =
    (path.split(/[\\/]/).pop() ?? "src")
      .replace(/\.[^.]+$/, "")
      .replace(/[^A-Za-z0-9_.-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "src";
  let id = base;
  for (let i = 2; id in taken; i++) id = `${base}-${i}`;
  return id;
}
