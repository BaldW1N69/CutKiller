#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { edlJsonSchema, profileJsonSchema } from "@cutkiller/core";
import { ffmpegVersion, probeSource } from "@cutkiller/media";
import { captionLabels, formatLabels, type Report, reportJsonSchema } from "@cutkiller/qa";
import { loadProfile } from "@cutkiller/style";
import { calibrate, calibrationMarkdown } from "./calibrate";
import { check, doRender, plan, readEdl } from "./pipeline";

const USAGE = `cutkiller <commande> [options]

  probe <fichiers…>                         métadonnées des rushes
  plan <entrées…> -p <profil> -o edl.json   analyse + planification → EDL éditable
  validate <edl.json>                       vérifie une EDL (schéma + invariants)
  render <edl.json> -o out.mp4 [--draft]    rend une EDL
  check <vidéo> [--edl edl.json] -p <profil> [--json r.json] [--md r.md] [--min-score 90] [--truth labels.txt]
  annotate <edl.json> -o labels.txt        mots surlignés à corriger à l'oreille (pistes d'étiquettes Audacity)
  auto <entrées…> -p <profil> -o <dossier> [--draft] [--min-score 90]
  calibrate -o <dossier> [--only a,b]       calibre la QA : un défaut injecté par règle sur un montage propre
  schema --out <dossier>                    exporte les JSON Schemas (EDL, profil, rapport QA)

Profils : short (9:16), long (16:9), ou chemin vers un .yaml.
--draft : encodage rapide (preset veryfast) pour itérer.
--fast  : sans analyse de la parole ni des beats (assemblage brut).`;

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
      only: { type: "string" },
      truth: { type: "string" },
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
    case "annotate": {
      const edl = await readEdl(need(positionals[0], "edl"));
      const out = need(values.out, "out");
      await writeFile(out, formatLabels(captionLabels(edl)));
      console.log(
        `✔ ${out} : ${edl.captions.reduce((n, c) => n + c.words.length, 0)} mot(s). Audacity : Fichier → Importer → Étiquettes, sur l'audio du rendu ; placez chaque étiquette sur le début réel du mot, ajoutez « euh » sur chaque hésitation entendue, exportez, puis check --truth.`,
      );
      return;
    }
    case "calibrate": {
      const dir = need(values.out, "out");
      const result = await calibrate(dir, {
        ...(values.only ? { only: values.only.split(",") } : {}),
        log: (m) => console.error(m),
      });
      console.log(calibrationMarkdown(result));
      const { detected, defects, controls, controlsOk } = result.summary;
      if (detected < defects || controlsOk < controls) process.exitCode = 1;
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
      await writeFile(join(dir, "report-1.schema.json"), `${JSON.stringify(reportJsonSchema(), null, 2)}\n`);
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
