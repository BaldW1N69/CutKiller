/**
 * CutBench: edits a set of CC-licensed rushes end to end and records, for each,
 * the wall time of every stage and the quality score. The baseline every speed
 * or quality change is measured against.
 *
 *   pnpm bench [--profile short] [--only gl-vallee-360-60] [--out bench/results]
 *
 * Results: <out>/<rush>/ (EDL, render, quality report) and <out>/results.json,
 * <out>/results.md (one row per rush, appended run by run with the git commit).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fetchRushes } from "./rushes";

interface BenchRow {
  rush: string;
  profile: string;
  commit: string;
  date: string;
  machine: string;
  wallS: number;
  stages: Record<string, number>;
  score: number | null;
  coverage: number | null;
  failed: string[];
}

const ROOT = resolve(import.meta.dirname, "..");
const MUSIC = "cely-grande-thunder.mp3";
/** Rushes with speech, the case CutBench measures first. */
const DEFAULT_SET = ["gl-vallee-360-60.mp4", "gl-vallee-300-180.mp4"];

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      profile: { type: "string", default: "short" },
      only: { type: "string" },
      out: { type: "string", default: "bench/results" },
    },
  });
  const dir = resolve(".cache/rushes");
  const wanted = values.only
    ? values.only.split(",").map((n) => (n.endsWith(".mp4") ? n : `${n}.mp4`))
    : DEFAULT_SET;
  if (!wanted.every((f) => existsSync(join(dir, f))) || !existsSync(join(dir, MUSIC))) await fetchRushes(dir);
  const commit = spawnSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const machine = `${cpus().length} threads, ${(totalmem() / 1024 ** 3).toFixed(0)} GB, ${process.env.CUTKILLER_DEVICE ?? "auto"} device`;
  const rows: BenchRow[] = [];
  for (const file of wanted) {
    const name = file.replace(/\.mp4$/, "");
    const out = join(values.out, name);
    await mkdir(out, { recursive: true });
    const t0 = performance.now();
    const run = spawnSync(
      join(ROOT, "node_modules/.bin/tsx"),
      [
        join(ROOT, "packages/cli/src/main.ts"),
        "auto",
        join(dir, file),
        join(dir, MUSIC),
        "-p",
        values.profile,
        "-o",
        out,
      ],
      { encoding: "utf8", env: { ...process.env, CUTKILLER_LANG: "en" }, maxBuffer: 64 * 1024 * 1024 },
    );
    const wallS = (performance.now() - t0) / 1000;
    const stages: Record<string, number> = {};
    for (const m of run.stderr.matchAll(/ℹ \[timing\] (.+?) ([\d.]+) s/g)) {
      const stage = m[1] as string;
      stages[stage] = (stages[stage] ?? 0) + Number(m[2]);
    }
    let score: number | null = null;
    let coverage: number | null = null;
    let failed: string[] = [];
    const reportPath = join(out, "quality.json");
    if (existsSync(reportPath)) {
      const report = JSON.parse(await readFile(reportPath, "utf8"));
      score = report.score;
      coverage = report.coverage;
      failed = report.results
        .filter((r: { status: string }) => r.status === "fail")
        .map((r: { ruleId: string }) => r.ruleId);
    }
    if (run.status !== 0) console.error(run.stderr.slice(-2000));
    const row: BenchRow = {
      rush: name,
      profile: values.profile,
      commit,
      date: new Date().toISOString(),
      machine,
      wallS: Math.round(wallS),
      stages,
      score,
      coverage,
      failed,
    };
    rows.push(row);
    console.log(`${name}: ${row.wallS} s, score ${score ?? "—"}`);
  }
  const jsonPath = join(values.out, "results.json");
  const previous: BenchRow[] = existsSync(jsonPath) ? JSON.parse(await readFile(jsonPath, "utf8")) : [];
  const all = [...previous, ...rows];
  await writeFile(jsonPath, `${JSON.stringify(all, null, 2)}\n`);
  await writeFile(join(values.out, "results.md"), markdown(all));
}

function markdown(rows: readonly BenchRow[]): string {
  const stageNames = [...new Set(rows.flatMap((r) => Object.keys(r.stages)))];
  return [
    "# CutBench results",
    "",
    `| Commit | Rush | Profile | Wall | ${stageNames.join(" | ")} | Score | Failed rules |`,
    `|---|---|---|---|${stageNames.map(() => "---").join("|")}|---|---|`,
    ...rows.map(
      (r) =>
        `| ${r.commit} | ${r.rush} | ${r.profile} | ${r.wallS} s | ${stageNames.map((s) => (r.stages[s] !== undefined ? `${r.stages[s]?.toFixed(0)} s` : "—")).join(" | ")} | ${r.score ?? "—"} | ${r.failed.join(", ") || "—"} |`,
    ),
    "",
    `Machine of the last run: ${rows.at(-1)?.machine ?? "—"}. Cached analyses are not timed: delete \`.cache/analysis\` for a cold run.`,
    "",
  ].join("\n");
}

await main();
