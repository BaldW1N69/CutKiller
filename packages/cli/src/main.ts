#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { analyzeSources } from "@cutkiller/analyze";
import { audioPass } from "@cutkiller/audio";
import { captionsPass } from "@cutkiller/captions";
import { colorPass } from "@cutkiller/color";
import {
  type Analysis,
  type Diagnostic,
  type Edl,
  edlJsonSchema,
  parseEdl,
  profileJsonSchema,
  runPasses,
  type StyleProfile,
} from "@cutkiller/core";
import { assembleEdl, cutPass } from "@cutkiller/cut";
import { ffmpegVersion, probeSource } from "@cutkiller/media";
import { motionPass } from "@cutkiller/motion";
import { qualityCheck, type Report, reportMarkdown } from "@cutkiller/qa";
import { reframePass } from "@cutkiller/reframe";
import { render } from "@cutkiller/render";
import { loadProfile, PresetRegistry } from "@cutkiller/style";

const USAGE = `cutkiller <commande> [options]

  probe <fichiers…>                         métadonnées des rushes
  plan <entrées…> -p <profil> -o edl.json   analyse + planification → EDL éditable
  validate <edl.json>                       vérifie une EDL (schéma + invariants)
  render <edl.json> -o out.mp4 [--draft]    rend une EDL
  check <vidéo> [--edl edl.json] -p <profil> [--json r.json] [--md r.md] [--min-score 90]
  auto <entrées…> -p <profil> -o <dossier> [--draft] [--min-score 90]
  schema --out <dossier>                    exporte les JSON Schemas (EDL, profil)

Profils : short (9:16), long (16:9), ou chemin vers un .yaml.
--draft : encodage rapide (preset veryfast) pour itérer.
--fast  : sans analyse de la parole ni des beats (assemblage brut).`;

const PASSES = [cutPass, reframePass, colorPass, motionPass, captionsPass, audioPass];

function printDiagnostics(diagnostics: Diagnostic[]): void {
  const icon = { error: "✖", warning: "⚠", info: "ℹ" } as const;
  for (const d of diagnostics)
    console.error(`${icon[d.level]} [${d.code}] ${d.message}${d.path ? ` — ${d.path}` : ""}`);
}

async function readEdl(path: string): Promise<Edl> {
  const result = parseEdl(JSON.parse(await readFile(path, "utf8")));
  printDiagnostics(result.diagnostics);
  if (!result.ok) throw new Error(`EDL invalide : ${path}`);
  return result.edl;
}

async function plan(inputs: string[], profile: StyleProfile, edlPath: string, deep: boolean): Promise<Edl> {
  const analysis = await analyzeSources(inputs, { deep, log: (m) => console.error(`… ${m}`) });
  await mkdir(dirname(resolve(edlPath)), { recursive: true });
  await writeFile(analysisPath(edlPath), `${JSON.stringify(analysis)}\n`);
  for (const [id, probe] of Object.entries(analysis.sources)) {
    const ratio = probe.fps ? profile.format.fps / probe.fps : 1;
    if (probe.fps && Math.abs(ratio - Math.round(ratio)) > 0.01)
      console.error(
        `⚠ [source.fps] ${id} est à ${probe.fps.toFixed(3)} fps : la conversion en ${profile.format.fps} fps répète des images (saccade de pulldown)`,
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
const analysisPath = (edlPath: string) => `${edlPath.replace(/(\.edl)?\.json$/, "")}.analysis.json`;

async function readAnalysis(edlPath: string): Promise<Analysis | undefined> {
  const path = analysisPath(edlPath);
  return existsSync(path) ? (JSON.parse(await readFile(path, "utf8")) as Analysis) : undefined;
}

async function doRender(edl: Edl, edlPath: string, out: string, draft: boolean, keepStems: boolean) {
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
  for (const w of log.warnings) console.error(`⚠ ${w}`);
  return log;
}

async function check(
  video: string,
  profile: StyleProfile,
  edlPath: string | undefined,
  opts: { json?: string; md?: string },
) {
  const edl = edlPath ? await readEdl(edlPath) : undefined;
  const analysis = edlPath ? await readAnalysis(edlPath) : undefined;
  const report = await qualityCheck({
    video,
    profile,
    ...(edl ? { edl, edlPath, baseDir: dirname(resolve(edlPath as string)) } : {}),
    ...(analysis ? { analysis } : {}),
  });
  const md = reportMarkdown(report);
  if (opts.json) await writeFile(opts.json, `${JSON.stringify(report, null, 2)}\n`);
  if (opts.md) await writeFile(opts.md, md);
  console.log(md);
  return report;
}

function gate(report: Report, minScore: string | undefined): void {
  if (minScore === undefined) return;
  if (report.score < Number(minScore)) {
    console.error(`✖ score ${report.score} < ${minScore}`);
    process.exitCode = 1;
  }
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      profile: { type: "string", short: "p" },
      out: { type: "string", short: "o" },
      edl: { type: "string" },
      json: { type: "string" },
      md: { type: "string" },
      "min-score": { type: "string" },
      draft: { type: "boolean", default: false },
      fast: { type: "boolean", default: false },
      "keep-stems": { type: "boolean", default: false },
    },
  });
  const need = (v: string | undefined, name: string): string => {
    if (!v) throw new Error(`option --${name} requise\n\n${USAGE}`);
    return v;
  };

  switch (command) {
    case "probe":
      for (const p of positionals) console.log(JSON.stringify(await probeSource(p), null, 2));
      return;
    case "validate":
      await readEdl(need(positionals[0], "edl"));
      console.log("✔ EDL valide");
      return;
    case "plan": {
      const out = need(values.out, "out");
      const edl = await plan(
        positionals,
        await loadProfile(need(values.profile, "profile")),
        out,
        !values.fast,
      );
      console.log(`✔ ${out} : ${edl.video[0]?.clips.length ?? 0} clip(s)`);
      return;
    }
    case "render": {
      const edlPath = need(positionals[0], "edl");
      await doRender(
        await readEdl(edlPath),
        edlPath,
        need(values.out, "out"),
        values.draft,
        values["keep-stems"],
      );
      return;
    }
    case "check": {
      const video = need(positionals[0], "vidéo");
      const report = await check(
        video,
        await loadProfile(need(values.profile, "profile")),
        values.edl,
        values,
      );
      gate(report, values["min-score"]);
      return;
    }
    case "auto": {
      const dir = need(values.out, "out");
      const profile = await loadProfile(need(values.profile, "profile"));
      const edlPath = join(dir, "edit.edl.json");
      const video = join(dir, "final.mp4");
      const edl = await plan(positionals, profile, edlPath, !values.fast);
      await doRender(edl, edlPath, video, values.draft, true);
      const report = await check(video, profile, edlPath, {
        json: join(dir, "quality.json"),
        md: join(dir, "quality.md"),
      });
      gate(report, values["min-score"]);
      return;
    }
    case "schema": {
      const dir = need(values.out, "out");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "edl-1.schema.json"), `${JSON.stringify(edlJsonSchema(), null, 2)}\n`);
      await writeFile(
        join(dir, "profile-1.schema.json"),
        `${JSON.stringify(profileJsonSchema(), null, 2)}\n`,
      );
      console.log(`✔ schémas écrits dans ${dir}`);
      return;
    }
    case "version":
      console.log(`cutkiller 0.1.0 — ${(await ffmpegVersion()).raw}`);
      return;
    default:
      console.log(USAGE);
      if (command && command !== "help") process.exitCode = 2;
  }
}

main(process.argv.slice(2)).catch((err: Error) => {
  console.error(`✖ ${err.message}`);
  process.exitCode = 1;
});
