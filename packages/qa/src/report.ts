import type { StyleProfile } from "@cutkiller/core";
import { tr } from "@cutkiller/core";
import { z } from "zod";
import { type Category, measuredOnLabel, RULES, type Rule, ruleThreshold, ruleTitle } from "./rules";

/** Version of the report format (JSON schema `schema/report-1.schema.json`). */
export const REPORT_VERSION = "1.0.0";

const ViolationSchema = z.object({
  message: z.string(),
  /** Output frame where the problem shows, when it has a position. */
  frame: z.number().int().optional(),
  /** Same position as a timecode, mm:ss.ff (filled by the report). */
  time: z.string().optional(),
});

const CheckResultSchema = z.object({
  ruleId: z.string(),
  /** "not-evaluated": the video does not contain what the rule is about. */
  status: z.enum(["pass", "fail", "not-evaluated"]),
  /** 0..1, share of compliant items when the rule is countable. */
  score: z.number().min(0).max(1),
  violations: z.array(ViolationSchema),
  measured: z.record(z.string(), z.unknown()).optional(),
  note: z.string().optional(),
  /** Time the check took, milliseconds. */
  ms: z.number().nonnegative().optional(),
});

const CategorySchema = z.enum(["montage", "motion", "captions", "audio", "image"]);

export const ReportSchema = z.object({
  reportVersion: z.string(),
  generatedAt: z.string(),
  tool: z.string(),
  video: z.string(),
  edl: z.string().optional(),
  profile: z.string(),
  fps: z.number().positive().optional(),
  /** Weighted score over evaluated rules, /100. */
  score: z.number().min(0).max(100),
  /** Share of the total rule weight actually evaluated, /100. */
  coverage: z.number().min(0).max(100),
  /** Wall time of the whole check, seconds. */
  seconds: z.number().nonnegative().optional(),
  categories: z.record(
    CategorySchema,
    z.object({ score: z.number().nullable(), evaluatedWeight: z.number(), totalWeight: z.number() }),
  ),
  results: z.array(
    CheckResultSchema.extend({
      title: z.string(),
      weight: z.number(),
      category: CategorySchema,
      /** Pass condition with the profile's values. */
      threshold: z.string(),
      /** What the check reads: an independent measurement of the file, or the plan the renderer executed. */
      measuredOn: z.string(),
    }),
  ),
});

export type Violation = z.infer<typeof ViolationSchema>;
export type CheckResult = z.infer<typeof CheckResultSchema>;
export type Report = z.infer<typeof ReportSchema>;

export function reportJsonSchema(): unknown {
  return z.toJSONSchema(ReportSchema, { target: "draft-2020-12" });
}

/** mm:ss.ff of an output frame. */
export function timecode(frame: number, fps: number): string {
  const f = Math.round(fps);
  const total = Math.floor(frame / f);
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${mm}:${ss}.${String(frame % f).padStart(2, "0")}`;
}

export const pass = (ruleId: string, measured?: Record<string, unknown>): CheckResult => ({
  ruleId,
  status: "pass",
  score: 1,
  violations: [],
  ...(measured ? { measured } : {}),
});

export const notEvaluated = (ruleId: string, note: string): CheckResult => ({
  ruleId,
  status: "not-evaluated",
  score: 0,
  violations: [],
  note,
});

/** Countable rule: score = compliant / total, fails as soon as one item is out. */
export function graded(
  ruleId: string,
  total: number,
  violations: Violation[],
  measured?: Record<string, unknown>,
): CheckResult {
  if (total === 0) return { ...notEvaluated(ruleId, "rien à évaluer"), ...(measured ? { measured } : {}) };
  const bad = Math.min(total, violations.length);
  return {
    ruleId,
    status: bad === 0 ? "pass" : "fail",
    score: (total - bad) / total,
    violations,
    ...(measured ? { measured } : {}),
  };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function buildReport(
  meta: { video: string; edl?: string; profile: string },
  results: CheckResult[],
  opts: { profile?: StyleProfile; fps?: number; seconds?: number } = {},
): Report {
  const byRule = new Map(results.map((r) => [r.ruleId, r]));
  const fps = opts.fps;
  const full = RULES.map((rule: Rule) => {
    const r = byRule.get(rule.id) ?? notEvaluated(rule.id, tr("no check run", "aucun contrôle exécuté"));
    return {
      ...r,
      violations: r.violations.map((v) =>
        v.frame !== undefined && fps ? { ...v, time: timecode(v.frame, fps) } : v,
      ),
      title: ruleTitle(rule),
      weight: rule.weight,
      category: rule.category,
      threshold: opts.profile ? ruleThreshold(rule.id, opts.profile) : "",
      measuredOn: measuredOnLabel(rule.measuredOn),
    };
  });
  const evaluated = full.filter((r) => r.status !== "not-evaluated");
  const evaluatedWeight = evaluated.reduce((s, r) => s + r.weight, 0);
  const totalWeight = full.reduce((s, r) => s + r.weight, 0);
  const score =
    evaluatedWeight === 0 ? 0 : evaluated.reduce((s, r) => s + r.weight * r.score, 0) / evaluatedWeight;
  const categories = {} as Report["categories"];
  for (const cat of ["montage", "motion", "captions", "audio", "image"] as Category[]) {
    const inCat = full.filter((r) => r.category === cat);
    const ev = inCat.filter((r) => r.status !== "not-evaluated");
    const w = ev.reduce((s, r) => s + r.weight, 0);
    categories[cat] = {
      score: w === 0 ? null : round1((100 * ev.reduce((s, r) => s + r.weight * r.score, 0)) / w),
      evaluatedWeight: w,
      totalWeight: inCat.reduce((s, r) => s + r.weight, 0),
    };
  }
  return {
    reportVersion: REPORT_VERSION,
    generatedAt: new Date().toISOString(),
    tool: "cutkiller 0.1.0",
    ...meta,
    ...(fps ? { fps } : {}),
    // Floor: the score only reads 100 when every evaluated rule passes.
    score: Math.floor(score * 1000 + 1e-9) / 10,
    coverage: round1((100 * evaluatedWeight) / totalWeight),
    ...(opts.seconds !== undefined ? { seconds: Math.round(opts.seconds) } : {}),
    categories,
    results: full,
  };
}

const ICON = { pass: "✅", fail: "❌", "not-evaluated": "⏳" } as const;
const categoryTitle = (c: Category) =>
  ({
    montage: tr("Editing", "Montage"),
    motion: "Motion",
    captions: tr("Captions", "Sous-titres"),
    audio: "Audio",
    image: "Image",
  })[c];

/** A few measured values, compact (numbers rounded). */
function measuredSummary(m: Record<string, unknown> | undefined): string {
  if (!m) return "";
  const fmt = (v: unknown): string =>
    typeof v === "number"
      ? String(Math.round(v * 100) / 100)
      : Array.isArray(v)
        ? `[${v.slice(0, 3).map(fmt).join(", ")}${v.length > 3 ? ", …" : ""}]`
        : typeof v === "string" || typeof v === "boolean"
          ? String(v)
          : "…";
  return Object.entries(m)
    .slice(0, 4)
    .map(([k, v]) => `${k} ${fmt(v)}`)
    .join(", ");
}

const esc = (t: string) => t.replaceAll("|", "\\|");
const where = (v: Violation) =>
  v.time ? `${v.time} (f${v.frame})` : v.frame !== undefined ? `f${v.frame}` : "";

export function reportMarkdown(report: Report): string {
  const lines = [
    `# Quality check — ${report.score}/100`,
    "",
    tr(`- Video: \`${report.video}\``, `- Vidéo : \`${report.video}\``),
    ...(report.edl ? [`- EDL : \`${report.edl}\``] : []),
    tr(`- Profile: ${report.profile}`, `- Profil : ${report.profile}`),
    tr(
      `- Coverage: ${report.coverage} % of the total rule weight evaluated`,
      `- Couverture : ${report.coverage} % du poids total des règles évalué`,
    ),
    ...(report.seconds !== undefined
      ? [tr(`- Check time: ${report.seconds} s`, `- Durée du contrôle : ${report.seconds} s`)]
      : []),
    "",
    tr("| Category | Score | Weight evaluated |", "| Catégorie | Score | Poids évalué |"),
    "|---|---|---|",
    ...(Object.entries(report.categories) as [Category, Report["categories"][Category]][]).map(
      ([cat, c]) => `| ${categoryTitle(cat)} | ${c.score ?? "—"} | ${c.evaluatedWeight}/${c.totalWeight} |`,
    ),
    "",
    tr(
      "| Rule | Weight | Status | Score | Threshold | Measured on | Measure | Detail |",
      "| Règle | Poids | Statut | Score | Seuil | Mesuré sur | Mesure | Détail |",
    ),
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const r of report.results) {
    const detail =
      r.violations.length > 0
        ? r.violations
            .slice(0, 3)
            .map((v) => (where(v) ? `${where(v)} : ${v.message}` : v.message))
            .join(" ; ") + (r.violations.length > 3 ? ` (+${r.violations.length - 3})` : "")
        : (r.note ?? "");
    // Floor, so a failing rule never reads « 100 % ».
    const score = r.status === "not-evaluated" ? "—" : `${Math.floor(r.score * 1000) / 10} %`;
    lines.push(
      `| ${r.title} | ${r.weight} | ${ICON[r.status]} | ${score} | ${esc(r.threshold)} | ${r.measuredOn} | ${esc(measuredSummary(r.measured))} | ${esc(detail)} |`,
    );
  }
  const failing = report.results.filter((r) => r.status === "fail");
  if (failing.length > 0) {
    lines.push("", tr("## To fix", "## Écarts à corriger"), "");
    for (const r of failing) {
      lines.push(`### ${r.title}`, "", tr(`Threshold: ${r.threshold}`, `Seuil : ${r.threshold}`), "");
      for (const v of r.violations) lines.push(`- ${where(v) ? `${where(v)} — ` : ""}${v.message}`);
      lines.push("");
    }
  }
  const skipped = report.results.filter((r) => r.status === "not-evaluated");
  if (skipped.length > 0) {
    lines.push("", tr("## Not evaluated", "## Non évaluées"), "");
    for (const r of skipped)
      lines.push(tr(`- ${r.title}: ${r.note ?? "—"}`, `- ${r.title} : ${r.note ?? "—"}`));
  }
  return `${lines.join("\n")}\n`;
}
