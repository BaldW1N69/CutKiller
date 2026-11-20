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
  dominantLanguage,
  type Edl,
  lexicon,
  localizeProfile,
  parseEdl,
  runPasses,
  type StyleProfile,
  tr,
} from "@cutkiller/core";
import { assembleEdl, brollPass, cutPass, outputFps } from "@cutkiller/cut";
import { applySelection, type Range } from "@cutkiller/editorial";
import { motionPass } from "@cutkiller/motion";
import { parseLabels, qualityCheck, reportMarkdown } from "@cutkiller/qa";
import { reframePass, screenZoomPass } from "@cutkiller/reframe";
import { render } from "@cutkiller/render";
import { PresetRegistry } from "@cutkiller/style";

export const PASSES = [
  cutPass,
  brollPass,
  reframePass,
  screenZoomPass,
  colorPass,
  motionPass,
  captionsPass,
  audioPass,
];

export function printDiagnostics(diagnostics: Diagnostic[]): void {
  const icon = { error: "✖", warning: "⚠", info: "ℹ" } as const;
  for (const d of diagnostics)
    console.error(`${icon[d.level]} [${d.code}] ${d.message}${d.path ? ` — ${d.path}` : ""}`);
}

/** Wall time of a stage, on stderr: where the minutes go (CUTKILLER_TIMINGS=0 to hide). */
function timing(stage: string, since: number): void {
  if (process.env.CUTKILLER_TIMINGS === "0") return;
  console.error(`ℹ [timing] ${stage} ${((performance.now() - since) / 1000).toFixed(1)} s`);
}

export async function readEdl(path: string): Promise<Edl> {
  const result = parseEdl(JSON.parse(await readFile(path, "utf8")));
  printDiagnostics(result.diagnostics);
  if (!result.ok) throw new Error(tr(`invalid EDL: ${path}`, `EDL invalide : ${path}`));
  return result.edl;
}

export async function plan(
  inputs: string[],
  profile: StyleProfile,
  edlPath: string,
  deep: boolean,
  /** Inputs that are B-roll (cutaways, montage material), also listed in `inputs` or not. */
  broll: readonly string[] = [],
  /** Spoken language (ISO 639-1) or "auto". */
  language?: string,
  /** Editorial selection: only these source ranges, in this order (see @cutkiller/editorial). */
  ranges?: readonly Range[],
): Promise<Edl> {
  const all = [...inputs, ...broll.filter((b) => !inputs.includes(b))];
  const t0 = performance.now();
  const analysis = await analyzeSources(all, {
    deep,
    log: (m) => console.error(`… ${m}`),
    broll: new Set(broll.map((b) => resolve(b))),
    ...(language ? { language } : {}),
    ...(profile.screenZoom.enabled ? { screen: true } : {}),
  });
  timing("analysis", t0);
  const spoken = dominantLanguage(analysis.transcripts);
  if (spoken) {
    if (!lexicon(spoken).contextualFillers.length)
      console.error(
        `⚠ [language] ${spoken} : no hesitation list for this language yet, only universal fillers are cut`,
      );
    else console.error(`ℹ [language] ${spoken}`);
    profile = localizeProfile(profile, spoken);
  }
  await mkdir(dirname(resolve(edlPath)), { recursive: true });
  await writeFile(analysisPath(edlPath), `${JSON.stringify(analysis)}\n`);
  for (const [id, probe] of Object.entries(analysis.sources)) {
    if (!probe.hasVideo || !probe.width || !probe.height) continue;
    const { width: W, height: H } = profile.format;
    // Full-frame enlargement before any punch-in (cover fit).
    const up = Math.max(W / probe.width, H / probe.height);
    if (up > profile.export.maxUpscale)
      console.error(
        tr(
          `⚠ [source.resolution] ${id} (${probe.width}×${probe.height}) will be enlarged ×${up.toFixed(1)} to ${W}×${H}: soft picture (limit ×${profile.export.maxUpscale}, rule image.sharpness). A source ≥ ${Math.ceil(W / profile.export.maxUpscale)}×${Math.ceil(H / profile.export.maxUpscale)} is needed.`,
          `⚠ [source.resolution] ${id} (${probe.width}×${probe.height}) sera agrandi ×${up.toFixed(1)} en ${W}×${H} : image molle (limite ×${profile.export.maxUpscale}, règle image.sharpness). Une source ≥ ${Math.ceil(W / profile.export.maxUpscale)}×${Math.ceil(H / profile.export.maxUpscale)} est nécessaire.`,
        ),
      );
  }
  const fps = outputFps(analysis, profile);
  if (fps !== profile.format.fps)
    console.error(
      tr(
        `ℹ [output.fps] output at ${fps} fps, the rushes' frame rate`,
        `ℹ [output.fps] sortie à ${fps} fps, la cadence des rushes`,
      ),
    );
  for (const [id, probe] of Object.entries(analysis.sources)) {
    const ratio = probe.fps ? fps / probe.fps : 1;
    if (probe.fps && Math.abs(ratio - Math.round(ratio)) > 0.01)
      console.error(
        probe.fps < fps
          ? tr(
              `⚠ [source.fps] ${id} is at ${probe.fps.toFixed(3)} fps: converting to ${fps} fps repeats frames (pulldown judder)`,
              `⚠ [source.fps] ${id} est à ${probe.fps.toFixed(3)} fps : la conversion en ${fps} fps répète des images (saccade de pulldown)`,
            )
          : tr(
              `⚠ [source.fps] ${id} is at ${probe.fps.toFixed(3)} fps: converting to ${fps} fps drops frames at irregular intervals (less fluid motion)`,
              `⚠ [source.fps] ${id} est à ${probe.fps.toFixed(3)} fps : la conversion en ${fps} fps saute des images à intervalles irréguliers (mouvement moins fluide)`,
            ),
      );
  }
  const tPlan = performance.now();
  const full = assembleEdl(analysis, profile, { edlDir: dirname(resolve(edlPath)) });
  const assembled = ranges && ranges.length > 0 ? applySelection(full, ranges) : full;
  const { edl, diagnostics } = runPasses(assembled, PASSES, {
    analysis,
    profile,
    presets: await PresetRegistry.load(),
  });
  printDiagnostics(diagnostics);
  timing("planning", tPlan);
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
  const t0 = performance.now();
  const log = await render(target, {
    baseDir: dirname(resolve(edlPath)),
    outPath: out,
    keepStems,
    onProgress: (f, total) => {
      const pct = Math.floor((100 * f) / total);
      if (pct >= last + 10) {
        last = pct;
        process.stderr.write(tr(`\rrender ${pct} %`, `\rrendu ${pct} %`));
      }
    },
  });
  process.stderr.write(
    tr(
      `\rrender 100 % — ${log.frames} frames at ${log.renderFps.toFixed(1)} fps\n`,
      `\rrendu 100 % — ${log.frames} frames à ${log.renderFps.toFixed(1)} fps\n`,
    ),
  );
  // Sidecar subtitles (same cues as the burnt-in captions) for the platforms' own subtitle track.
  if (edl.captions.length > 0)
    await writeFile(`${out.replace(/\.[^./]+$/, "")}.srt`, toSrt(edl.captions, edl.output.fps));
  for (const w of log.warnings) console.error(`⚠ ${w}`);
  timing("render", t0);
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
  // Without the dialogue stem, word timings are measured on the mix: music and
  // effects under the voice make the aligner place words late (false sync errors).
  if (edl && !existsSync(`${video}.voice.wav`) && edl.audio.some((t) => t.clips.length > 0))
    console.warn(
      tr(
        `⚠ ${video}.voice.wav not found: caption sync and fillers are measured on the mix with music, less reliable. Render with this version (stems are kept) and check again.`,
        `⚠ ${video}.voice.wav introuvable : synchro des sous-titres et hésitations mesurées sur le mix avec musique, moins fiable. Refaites le rendu avec cette version (les pistes séparées sont gardées) puis vérifiez.`,
      ),
    );
  const t0 = performance.now();
  const report = await qualityCheck({
    video,
    profile,
    ...(edl ? { edl, edlPath, baseDir: dirname(resolve(edlPath as string)) } : {}),
    ...(analysis ? { analysis } : {}),
    ...(opts.truth ? { truth: parseLabels(await readFile(opts.truth, "utf8")) } : {}),
  });
  timing("quality check", t0);
  const md = reportMarkdown(report);
  if (opts.json) await writeFile(opts.json, `${JSON.stringify(report, null, 2)}\n`);
  if (opts.md) await writeFile(opts.md, md);
  console.log(md);
  return report;
}
