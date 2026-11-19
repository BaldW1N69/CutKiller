/**
 * `cutkiller shorts`: one long recording → N vertical Shorts, chosen by the
 * editorial director (offline heuristic, or Claude with --ai), each edited,
 * rendered and scored, then ranked in shorts.md.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { analyzeSources } from "@cutkiller/analyze";
import { dominantLanguage, type StyleProfile, tr } from "@cutkiller/core";
import {
  claudeShorts,
  hasAnthropicCredentials,
  heuristicShorts,
  type ShortPlan,
  sentences,
} from "@cutkiller/editorial";
import type { Report } from "@cutkiller/qa";
import { check, doRender, plan } from "./pipeline";

export interface ShortsRun {
  dir: string;
  count: number;
  minS: number;
  maxS: number;
  ai: boolean;
  draft: boolean;
  language?: string;
}

export interface ShortResult {
  rank: number;
  plan: ShortPlan;
  video: string;
  report: Report;
}

export async function makeShorts(
  inputs: string[],
  profile: StyleProfile,
  run: ShortsRun,
): Promise<ShortResult[]> {
  const log = (m: string) => console.error(`… ${m}`);
  const analysis = await analyzeSources(inputs, {
    deep: true,
    log,
    ...(run.language ? { language: run.language } : {}),
  });
  const all = sentences(analysis.transcripts ?? {});
  if (all.length === 0)
    throw new Error(tr("shorts: no speech found in the inputs", "shorts : aucune parole dans les entrées"));
  const language = dominantLanguage(analysis.transcripts);
  const opts = { count: run.count, minS: run.minS, maxS: run.maxS, ...(language ? { language } : {}) };
  if (!run.ai && hasAnthropicCredentials())
    console.error(
      tr(
        "ℹ [editorial] Anthropic credentials found: add --ai to let Claude choose the clips",
        "ℹ [editorial] identifiants Anthropic trouvés : ajoutez --ai pour que Claude choisisse les extraits",
      ),
    );
  const plans = run.ai
    ? await claudeShorts(all, { ...opts, log: (m) => console.error(`⚠ ${m}`) })
    : heuristicShorts(all, opts);
  if (plans.length === 0)
    throw new Error(
      tr(
        `shorts: no passage of ${run.minS}–${run.maxS} s found; try --min/--max`,
        `shorts : aucun passage de ${run.minS} à ${run.maxS} s ; essayez --min/--max`,
      ),
    );
  console.error(`ℹ [editorial] ${plans.length} short(s), planner ${plans[0]?.planner}`);
  const results: ShortResult[] = [];
  for (const [i, p] of plans.entries()) {
    const dir = join(run.dir, `short-${String(i + 1).padStart(2, "0")}`);
    await mkdir(dir, { recursive: true });
    console.error(`▶ ${i + 1}/${plans.length} « ${p.title} » (${p.durationS} s)`);
    const edlPath = join(dir, "edit.edl.json");
    const video = join(dir, "final.mp4");
    const edl = await plan(inputs, profile, edlPath, true, [], run.language, p.ranges);
    await doRender(edl, edlPath, video, run.draft, true);
    const report = await check(video, profile, edlPath, {
      json: join(dir, "quality.json"),
      md: join(dir, "quality.md"),
    });
    results.push({ rank: i + 1, plan: p, video, report });
  }
  await writeFile(
    join(run.dir, "shorts.json"),
    `${JSON.stringify(
      results.map(({ report, ...r }) => ({ ...r, score: report.score })),
      null,
      2,
    )}\n`,
  );
  await writeFile(join(run.dir, "shorts.md"), shortsMarkdown(results));
  return results;
}

export function shortsMarkdown(results: readonly ShortResult[]): string {
  const lines = [
    `# Shorts — ${results.length}`,
    "",
    "| # | Title | Duration | Hook | Retention | Clarity | Quality | File |",
    "|---|---|---|---|---|---|---|---|",
    ...results.map(
      (r) =>
        `| ${r.rank} | ${r.plan.title.replaceAll("|", "/")} | ${r.plan.durationS} s | ${r.plan.scores.hook} | ${r.plan.scores.retention} | ${r.plan.scores.clarity} | ${r.report.score}/100 | \`${r.video}\` |`,
    ),
    "",
    ...results.flatMap((r) => [
      `## ${r.rank}. ${r.plan.title}`,
      "",
      `> ${r.plan.hook}`,
      "",
      `${r.plan.why} (${r.plan.planner})`,
      "",
    ]),
  ];
  return `${lines.join("\n")}\n`;
}
