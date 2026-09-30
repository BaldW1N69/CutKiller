import { type Category, RULES, type Rule } from "./rules";

export interface Violation {
  message: string;
  /** Output frame where the problem shows, when it has a position. */
  frame?: number;
}

export interface CheckResult {
  ruleId: string;
  /** "not-evaluated": no check yet, or the video does not contain what the rule is about. */
  status: "pass" | "fail" | "not-evaluated";
  /** 0..1, share of compliant items when the rule is countable. */
  score: number;
  violations: Violation[];
  measured?: Record<string, unknown>;
  note?: string;
}

export interface Report {
  video: string;
  edl?: string;
  profile: string;
  /** Weighted score over evaluated rules, /100. */
  score: number;
  /** Share of the total rule weight actually evaluated, /100. */
  coverage: number;
  categories: Record<Category, { score: number | null; evaluatedWeight: number; totalWeight: number }>;
  results: (CheckResult & { title: string; weight: number; category: Category })[];
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

export function buildReport(meta: Pick<Report, "video" | "edl" | "profile">, results: CheckResult[]): Report {
  const byRule = new Map(results.map((r) => [r.ruleId, r]));
  const full = RULES.map((rule: Rule) => ({
    ...(byRule.get(rule.id) ?? notEvaluated(rule.id, `contrôle livré en phase ${rule.phase}`)),
    title: rule.title,
    weight: rule.weight,
    category: rule.category,
  }));
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
    ...meta,
    // Floor: the score only reads 100 when every evaluated rule passes.
    score: Math.floor(score * 1000 + 1e-9) / 10,
    coverage: round1((100 * evaluatedWeight) / totalWeight),
    categories,
    results: full,
  };
}

const ICON = { pass: "✅", fail: "❌", "not-evaluated": "⏳" } as const;

export function reportMarkdown(report: Report): string {
  const lines = [
    `# Quality check — ${report.score}/100`,
    "",
    `- Vidéo : \`${report.video}\``,
    ...(report.edl ? [`- EDL : \`${report.edl}\``] : []),
    `- Profil : ${report.profile}`,
    `- Couverture : ${report.coverage} % du poids total des règles évalué`,
    "",
    "| Règle | Poids | Statut | Score | Détail |",
    "|---|---|---|---|---|",
  ];
  for (const r of report.results) {
    const detail =
      r.violations.length > 0
        ? r.violations
            .slice(0, 3)
            .map((v) => (v.frame !== undefined ? `f${v.frame} : ${v.message}` : v.message))
            .join(" ; ") + (r.violations.length > 3 ? ` (+${r.violations.length - 3})` : "")
        : (r.note ?? "");
    // Floor, so a failing rule never reads « 100 % ».
    const score = r.status === "not-evaluated" ? "—" : `${Math.floor(r.score * 1000) / 10} %`;
    lines.push(
      `| ${r.title} | ${r.weight} | ${ICON[r.status]} | ${score} | ${detail.replaceAll("|", "\\|")} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}
