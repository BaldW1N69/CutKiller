#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname as dirOf, join, resolve as resolvePath } from "node:path";
import { parseArgs } from "node:util";
import { edlJsonSchema, profileJsonSchema, tr } from "@cutkiller/core";
import { toFcp7Xml, toOtio } from "@cutkiller/interchange";
import { ffmpegVersion, probeSource } from "@cutkiller/media";
import {
  captionLabels,
  compareFingerprints,
  fingerprint,
  fingerprintMarkdown,
  formatLabels,
  type Report,
  reportJsonSchema,
} from "@cutkiller/qa";
import { listLooks, loadProfile, PresetRegistry, withLook } from "@cutkiller/style";
import { calibrate, calibrationMarkdown } from "./calibrate";
import { doctor, doctorReport } from "./doctor";
import { fetchMusic } from "./music";
import { check, doRender, plan, readEdl } from "./pipeline";

const USAGE_FR = `cutkiller <commande> [options]

  mcp                                       serveur MCP (stdio) pour Claude, Cursor, Codex…
  doctor                                    vérifie l'installation (FFmpeg, workers, modèles, GPU)
  probe <fichiers…>                         métadonnées des rushes
  plan <entrées…> -p <profil> -o edl.json   analyse + planification → EDL éditable
  validate <edl.json>                       vérifie une EDL (schéma + invariants)
  render <edl.json> -o out.mp4 [--draft]    rend une EDL
  export <edl.json> -o edit.otio|edit.xml   timeline pour DaVinci Resolve (.otio/.xml), Premiere Pro et Final Cut (.xml)
  check <vidéo> [--edl edl.json] -p <profil> [--json r.json] [--md r.md] [--min-score 90] [--truth labels.txt]
  annotate <edl.json> -o labels.txt        mots surlignés à corriger à l'oreille (pistes d'étiquettes Audacity)
  auto <entrées…> -p <profil> -o <dossier> [--broll b.mp4]… [--draft] [--min-score 90]
  looks                                     liste les styles d'image (--look)
  reference <réf.mp4> [--against rendu.mp4] [--md r.md] [--json r.json]
                                            empreinte de style d'une vidéo (rythme, image, son), comparée à un rendu
  calibrate -o <dossier> [--only a,b]       calibre la QA : un défaut injecté par règle sur un montage propre
  schema --out <dossier>                    exporte les JSON Schemas (EDL, profil, rapport QA)

Profils : short (9:16), long (16:9), cinematic (16:9), cinematic-short (9:16), tutorial (captures d’écran 16:9), ou chemin vers un .yaml.
--music : « <recherche> » ajoute une musique libre trouvée sur Openverse (CC0 / CC BY), crédit dans credits.txt.
--draft : encodage rapide (preset veryfast) pour itérer.
--lang  : langue parlée (fr, en, es, de, it, pt, nl…) ; par défaut détectée automatiquement.
--target: <secondes> garde seulement les phrases les plus fortes jusqu'à cette durée (version courte d'une vidéo longue) ; --ai : choisies par Claude.
--fast  : sans analyse de la parole ni des beats (assemblage brut).
--look  : style d'image (presets/look/) : film-print, bleach-grit (façon Fight Club), neon-80s (façon Vice City),
          teal-orange, noir, clean ; « cutkiller looks » les décrit. Le style apporte sa texture (grain, halo…).
--broll : plan d'illustration (répétable) : plans de coupe sur la parole, ou montage sur la musique s'il n'y a pas de parole
          (profils cinematic). Une vidéo sans parole est aussi traitée comme B-roll.`;
const USAGE_EN = `cutkiller <command> [options]

  auto <inputs…> -p <profile> -o <dir> [--broll b.mp4]… [--draft] [--min-score 90]
                                            analysis + edit + render + quality report, in one go
  studio <inputs…> -p <profile> -o <dir> [--port 4317]
                                            local web page: untick sentences in the transcript, render, see the score
  plan <inputs…> -p <profile> -o edl.json   analysis + planning → editable EDL
  render <edl.json> -o out.mp4 [--draft]    renders an EDL
  check <video> [--edl edl.json] -p <profile> [--json r.json] [--md r.md] [--min-score 90] [--truth labels.txt]
                                            26-rule quality check
  export <edl.json> -o edit.otio|edit.xml   timeline for DaVinci Resolve (.otio/.xml), Premiere Pro and Final Cut (.xml)
  shorts <long video…> -p short -o <dir> [--count 5] [--min 15] [--max 60] [--ai]
                                            one long video → N Shorts chosen for their hook, edited, scored and ranked
                                            (--ai: Claude picks the clips; needs Anthropic credentials)
  music <query> [-o <dir>]                  downloads free music (CC0 / CC BY, Openverse) and writes its credit
  validate <edl.json>                       checks an EDL (schema + invariants)
  doctor                                    checks the installation (FFmpeg, workers, models, GPU)
  mcp                                       MCP server (stdio) for Claude, Cursor, Codex…
  looks                                     lists image styles (--look)
  probe <files…>                            rush metadata
  reference <ref.mp4> [--against render.mp4] [--md r.md] [--json r.json]
                                            style fingerprint of a video (rhythm, image, sound), compared with a render
  annotate <edl.json> -o labels.txt        words to check by ear (Audacity label tracks)
  calibrate -o <dir> [--only a,b]           calibrates the QA: one defect injected per rule into a clean edit
  schema --out <dir>                        exports the JSON Schemas (EDL, profile, QA report)

Profiles: short (9:16), long (16:9), cinematic (16:9), cinematic-short (9:16), tutorial (16:9 screen recordings), or a path to a .yaml.
--lang  : spoken language (en, fr, es, de, it, pt, nl…); detected by default.
--target: <seconds> keeps only the strongest sentences up to that length (a 60 s version of a long video); --ai: chosen by Claude.
--music : "<query>" adds free music found on Openverse (CC0 / CC BY), credit in credits.txt.
--draft : fast encode (veryfast preset) to iterate.
--fast  : no speech or beat analysis (raw assembly).
--look  : image style (presets/look/): film-print, bleach-grit, neon-80s, teal-orange, noir, clean; "cutkiller looks" describes them.
--broll : cutaway footage (repeatable): over the speech, or a montage on the music when there is no speech.
--broll-search : "<query>" finds free cutaways (Pexels with PEXELS_API_KEY, else Wikimedia Commons: public domain, CC0, CC BY).
Messages in French: CUTKILLER_LANG=fr.`;
const usage = () => tr(USAGE_EN, USAGE_FR);

function gate(report: Report, minScore: string | undefined): void {
  if (minScore === undefined) return;
  if (report.score < Number(minScore)) {
    console.error(`✖ score ${report.score} < ${minScore}`);
    process.exitCode = 1;
  }
}

/** Inputs plus, with --music "<query>", a free track found on Openverse (credit in <dir>/credits.txt). */
/** With --target <seconds>: the editorial cut-down to keep; otherwise everything. */
async function targetRanges(inputs: string[], target: string | undefined, ai: boolean, language?: string) {
  if (!target) return undefined;
  const { cutdownRanges } = await import("./shorts");
  return cutdownRanges(inputs, Number(target), { ai, ...(language ? { language } : {}) });
}

/** --broll plus, with --broll-search "<query>", free footage found online (credits in <dir>/credits.txt). */
async function withBroll(
  broll: string[] | undefined,
  query: string | undefined,
  dir: string,
): Promise<string[]> {
  if (!query) return broll ?? [];
  const { fetchBroll } = await import("./stock");
  const found = await fetchBroll(query, join(dir, "broll"), { log: (m) => console.error(m) });
  return [...(broll ?? []), ...found];
}

async function withMusic(inputs: string[], query: string | undefined, dir: string): Promise<string[]> {
  if (!query) return inputs;
  const { path } = await fetchMusic(query, dir, { minDurationS: 60, log: (m) => console.error(m) });
  return [...inputs, path];
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
      /** Accepted for compatibility: stems are always kept (the quality check needs the voice alone). */
      "keep-stems": { type: "boolean", default: true },
      only: { type: "string" },
      against: { type: "string" },
      truth: { type: "string" },
      broll: { type: "string", multiple: true },
      look: { type: "string" },
      lang: { type: "string" },
      music: { type: "string" },
      count: { type: "string" },
      min: { type: "string" },
      max: { type: "string" },
      ai: { type: "boolean", default: false },
      target: { type: "string" },
      port: { type: "string" },
      "broll-search": { type: "string" },
    },
  });
  /** The profile named by -p, with the image style of --look if any. */
  const profileOf = async () => {
    const profile = await loadProfile(need(values.profile, "profile"));
    return values.look ? withLook(profile, await PresetRegistry.load(), values.look) : profile;
  };
  if (values.look === "list" || command === "looks") {
    for (const l of listLooks(await PresetRegistry.load()))
      console.log(`${l.ref.padEnd(16)} ${l.description}`);
    return;
  }
  const need = (v: string | undefined, name: string): string => {
    if (!v)
      throw new Error(
        tr(`option --${name} required\n\n${usage()}`, `option --${name} requise\n\n${usage()}`),
      );
    return v;
  };

  switch (command) {
    case "probe":
      for (const p of positionals) console.log(JSON.stringify(await probeSource(p), null, 2));
      return;
    case "validate":
      await readEdl(need(positionals[0], "edl"));
      console.log(tr("✔ valid EDL", "✔ EDL valide"));
      return;
    case "plan": {
      const out = need(values.out, "out");
      const inputs = await withMusic(positionals, values.music, dirOf(resolvePath(out)));
      const ranges = await targetRanges(inputs, values.target, values.ai, values.lang);
      const edl = await plan(
        inputs,
        await profileOf(),
        out,
        !values.fast,
        await withBroll(values.broll, values["broll-search"], dirOf(resolvePath(out))),
        values.lang,
        ranges,
      );
      console.log(`✔ ${out} : ${edl.video[0]?.clips.length ?? 0} clip(s)`);
      return;
    }
    case "render": {
      const edlPath = need(positionals[0], "edl");
      await doRender(await readEdl(edlPath), edlPath, need(values.out, "out"), values.draft, true);
      return;
    }
    case "check": {
      const video = need(positionals[0], "video");
      const report = await check(video, await profileOf(), values.edl, values);
      gate(report, values["min-score"]);
      return;
    }
    case "auto": {
      const dir = need(values.out, "out");
      const profile = await profileOf();
      const edlPath = join(dir, "edit.edl.json");
      const video = join(dir, "final.mp4");
      const inputs = await withMusic(positionals, values.music, dir);
      const ranges = await targetRanges(inputs, values.target, values.ai, values.lang);
      const edl = await plan(
        inputs,
        profile,
        edlPath,
        !values.fast,
        await withBroll(values.broll, values["broll-search"], dir),
        values.lang,
        ranges,
      );
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
    case "reference": {
      const ref = await fingerprint(need(positionals[0], "reference video"));
      const ours = values.against ? await fingerprint(values.against) : undefined;
      const md = fingerprintMarkdown(ref, ours);
      if (values.md) await writeFile(values.md, md);
      if (values.json)
        await writeFile(
          values.json,
          `${JSON.stringify({ reference: ref, ours, comparison: ours ? compareFingerprints(ref, ours) : undefined }, null, 2)}\n`,
        );
      console.log(md);
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
      console.log(tr(`✔ schemas written to ${dir}`, `✔ schémas écrits dans ${dir}`));
      return;
    }
    case "mcp": {
      const { serveMcp } = await import("./mcp");
      await serveMcp();
      return;
    }
    case "studio": {
      const dir = need(values.out, "out");
      const { studio } = await import("./studio");
      await studio(await withMusic(positionals, values.music, dir), await profileOf(), {
        dir,
        port: Number(values.port ?? 4317),
        ...(values.lang ? { language: values.lang } : {}),
      });
      await new Promise(() => {}); // serve until Ctrl+C
      return;
    }
    case "shorts": {
      const dir = need(values.out, "out");
      const inputs = await withMusic(positionals, values.music, dir);
      const { makeShorts } = await import("./shorts");
      const results = await makeShorts(inputs, await profileOf(), {
        dir,
        count: Number(values.count ?? 5),
        minS: Number(values.min ?? 15),
        maxS: Number(values.max ?? 60),
        ai: values.ai,
        draft: values.draft,
        ...(values.lang ? { language: values.lang } : {}),
      });
      for (const r of results)
        console.log(
          `${r.rank}. ${r.plan.title} — ${r.plan.durationS} s — ${r.report.score}/100 — ${r.video}`,
        );
      console.log(`✔ ${join(dir, "shorts.md")}`);
      return;
    }
    case "music": {
      const query = need(positionals.join(" ") || undefined, "query");
      const { path, track } = await fetchMusic(query, values.out ?? ".", { log: (m) => console.error(m) });
      console.log(`✔ ${path}\n${track.attribution}`);
      return;
    }
    case "docs": {
      const { writeRulesReference } = await import("./docs");
      const out = values.out ?? "docs/rules.md";
      await writeRulesReference(out);
      console.log(`✔ ${out}`);
      return;
    }
    case "export": {
      const edlPath = need(positionals[0], "edl");
      const out = need(values.out, "out");
      const edl = await readEdl(edlPath);
      const opts = { baseDir: dirOf(resolvePath(edlPath)) };
      const xml = /\.xml$/i.test(out);
      if (!xml && !/\.otio$/i.test(out))
        throw new Error(
          tr(
            "export: -o must end with .otio (DaVinci Resolve, Avid…) or .xml (Premiere Pro, Final Cut Pro 7, Resolve)",
            "export : -o doit finir par .otio (DaVinci Resolve, Avid…) ou .xml (Premiere Pro, Final Cut Pro 7, Resolve)",
          ),
        );
      await writeFile(out, xml ? toFcp7Xml(edl, opts) : toOtio(edl, opts));
      console.log(
        tr(
          `✔ ${out}: ${edl.video.reduce((n, t) => n + t.clips.length, 0)} shot(s) — captions: use the .srt written next to the render`,
          `✔ ${out} : ${edl.video.reduce((n, t) => n + t.clips.length, 0)} plan(s) — sous-titres : le .srt écrit à côté du rendu`,
        ),
      );
      return;
    }
    case "doctor": {
      const { text, ok } = doctorReport(await doctor());
      console.log(text);
      if (!ok) process.exitCode = 1;
      return;
    }
    case "version":
      console.log(`cutkiller 0.1.0 — ${(await ffmpegVersion()).raw}`);
      return;
    default:
      console.log(usage());
      if (command && command !== "help") process.exitCode = 2;
  }
}

main(process.argv.slice(2)).catch((err: Error) => {
  console.error(`✖ ${err.message}`);
  process.exitCode = 1;
});
