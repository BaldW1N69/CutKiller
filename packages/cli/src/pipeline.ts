import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { analyzeSources } from "@cutkiller/analyze";
import { audioPass } from "@cutkiller/audio";
import { captionsPass, toSrt } from "@cutkiller/captions";
import { colorPass } from "@cutkiller/color";
import {
  type Analysis,
  type Diagnostic,
  type Edl,
  parseEdl,
  runPasses,
  type StyleProfile,
} from "@cutkiller/core";
import { assembleEdl, cutPass } from "@cutkiller/cut";
import { motionPass } from "@cutkiller/motion";
import { parseLabels, qualityCheck, reportMarkdown } from "@cutkiller/qa";
import { reframePass } from "@cutkiller/reframe";
import { render } from "@cutkiller/render";
import { PresetRegistry } from "@cutkiller/style";

export const PASSES = [cutPass, reframePass, colorPass, motionPass, captionsPass, audioPass];

export function printDiagnostics(diagnostics: Diagnostic[]): void {
  const icon = { error: "✖", warning: "⚠", info: "ℹ" } as const;
  for (const d of diagnostics)
    console.error(`${icon[d.level]} [${d.code}] ${d.message}${d.path ? ` — ${d.path}` : ""}`);
}

export async function readEdl(path: string): Promise<Edl> {
  const result = parseEdl(JSON.parse(await readFile(path, "utf8")));
  printDiagnostics(result.diagnostics);
  if (!result.ok) throw new Error(`EDL invalide : ${path}`);
  return result.edl;
}

export async function plan(
  inputs: string[],
  profile: StyleProfile,
  edlPath: string,
  deep: boolean,
): Promise<Edl> {
  const analysis = await analyzeSources(inputs, { deep, log: (m) => console.error(`… ${m}`) });
  await mkdir(dirname(resolve(edlPath)), { recursive: true });
  await writeFile(analysisPath(edlPath), `${JSON.stringify(analysis)}\n`);
  for (const [id, probe] of Object.entries(analysis.sources)) {
    const ratio = probe.fps ? profile.format.fps / probe.fps : 1;
    if (probe.fps && Math.abs(ratio - Math.round(ratio)) > 0.01)
      console.error(
        probe.fps < profile.format.fps
          ? `⚠ [source.fps] ${id} est à ${probe.fps.toFixed(3)} fps : la conversion en ${profile.format.fps} fps répète des images (saccade de pulldown)`
          : `⚠ [source.fps] ${id} est à ${probe.fps.toFixed(3)} fps : la conversion en ${profile.format.fps} fps saute des images à intervalles irréguliers (mouvement moins fluide)`,
      );
  }
  const assembled = assembleEdl(analysis, profile, { edlDir: dirname(resolve(edlPath)) });
  const { edl, diagnostics } = runPasses(assembled, PASSES, {
    analysis,
    profile,
    presets: await PresetRegistry.load(),
  });
  printDiagnostics(diagnostics);
  await mkdir(dirname(resolve(edlPath)), { recursive: true });
  await writeFile(
    edlPath,
    `${JSON.stringify({ $schema: "https://cutkiller.dev/schema/edl-1.schema.json", ...edl }, null, 2)}\n`,
  );
  return edl;
}

/** Analysis results are written next to the EDL so `check` can reuse them. */
export const analysisPath = (edlPath: string) => `${edlPath.replace(/(\.edl)?\.json$/, "")}.analysis.json`;

export async function readAnalysis(edlPath: string): Promise<Analysis | undefined> {
  const path = analysisPath(edlPath);
  return existsSync(path) ? (JSON.parse(await readFile(path, "utf8")) as Analysis) : undefined;
}

export async function doRender(edl: Edl, edlPath: string, out: string, draft: boolean, keepStems: boolean) {
  const target = draft
    ? { ...edl, output: { ...edl.output, video: { ...edl.output.video, preset: "veryfast" as const } } }
    : edl;
  let last = -1;
  const log = await render(target, {
    baseDir: dirname(resolve(edlPath)),
    outPath: out,
    keepStems,
    onProgress: (f, total) => {
      const pct = Math.floor((100 * f) / total);
      if (pct >= last + 10) {
        last = pct;
        process.stderr.write(`\rrendu ${pct} %`);
      }
    },
  });
  process.stderr.write(`\rrendu 100 % — ${log.frames} frames à ${log.renderFps.toFixed(1)} fps\n`);
  // Sidecar subtitles (same cues as the burnt-in captions) for the platforms' own subtitle track.
  if (edl.captions.length > 0)
    await writeFile(`${out.replace(/\.[^./]+$/, "")}.srt`, toSrt(edl.captions, edl.output.fps));
  for (const w of log.warnings) console.error(`⚠ ${w}`);
  return log;
}

export async function check(
  video: string,
  profile: StyleProfile,
  edlPath: string | undefined,
  opts: { json?: string; md?: string; truth?: string },
) {
  const edl = edlPath ? await readEdl(edlPath) : undefined;
  const analysis = edlPath ? await readAnalysis(edlPath) : undefined;
  const report = await qualityCheck({
    video,
    profile,
    ...(edl ? { edl, edlPath, baseDir: dirname(resolve(edlPath as string)) } : {}),
    ...(analysis ? { analysis } : {}),
    ...(opts.truth ? { truth: parseLabels(await readFile(opts.truth, "utf8")) } : {}),
  });
  const md = reportMarkdown(report);
  if (opts.json) await writeFile(opts.json, `${JSON.stringify(report, null, 2)}\n`);
  if (opts.md) await writeFile(opts.md, md);
  console.log(md);
  return report;
}
