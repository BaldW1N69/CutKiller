/**
 * Human ground truth for the checks the models cannot settle alone: an editor
 * listens to the render and marks where each word really starts, and where a
 * hesitation is still heard. Labels use Audacity's label-track format
 * (`start<TAB>end<TAB>text`, seconds), so the workflow is: export the predicted
 * word onsets, import them over the rendered audio, drag each label onto the
 * real onset (add a label « euh » on any hesitation left), export, check.
 */
import { type Edl, type StyleProfile, tr } from "@cutkiller/core";
import { type CheckResult, graded, notEvaluated, type Violation } from "./report";

export interface Label {
  start: number;
  end: number;
  text: string;
}

export function parseLabels(text: string): Label[] {
  const out: Label[] = [];
  for (const line of text.split(/\r?\n/)) {
    // Audacity writes spectral-selection lines starting with a backslash.
    if (line.trim() === "" || line.startsWith("\\") || line.startsWith("#")) continue;
    const [a, b, ...rest] = line.split("\t");
    const start = Number((a ?? "").replace(",", "."));
    const end = Number((b ?? "").replace(",", "."));
    if (!Number.isFinite(start) || !Number.isFinite(end))
      throw new Error(
        tr(`unreadable annotation line: « ${line} »`, `ligne d'annotation illisible : « ${line} »`),
      );
    out.push({ start, end, text: rest.join("\t").trim() });
  }
  return out.sort((x, y) => x.start - y.start);
}

export function formatLabels(labels: Label[]): string {
  return labels
    .map((l) => `${l.start.toFixed(6)}\t${l.end.toFixed(6)}\t${l.text}`)
    .join("\n")
    .concat("\n");
}

/** The render's captioned words, at the onsets the captions highlight them: the labels to correct by ear. */
export function captionLabels(edl: Edl): Label[] {
  const fps = edl.output.fps;
  return edl.captions.flatMap((c) =>
    c.words.map((w) => ({ start: w.fromFrame / fps, end: w.toFrame / fps, text: w.text })),
  );
}

const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");

/**
 * captions.sync against the annotation: each caption word is paired, in order,
 * with the next label of the same text within 0,5 s; the gap between its
 * highlight and the annotated onset must stay within p95 / max.
 */
export function checkCaptionSyncTruth(edl: Edl, profile: StyleProfile, labels: Label[]): CheckResult {
  const fps = edl.output.fps;
  const { p95, max } = profile.captions.maxSyncErrorFrames;
  const words = edl.captions.flatMap((c) => c.words);
  if (words.length === 0) return notEvaluated("captions.sync", "aucun sous-titre");
  const pool = labels.filter((l) => !isFillerLabel(l, profile));
  const errors: number[] = [];
  const violations: Violation[] = [];
  let next = 0;
  let unmatched = 0;
  for (const w of words) {
    const t = w.fromFrame / fps;
    let k = next;
    while (
      k < pool.length &&
      !(norm(pool[k]?.text ?? "") === norm(w.text) && Math.abs((pool[k] as Label).start - t) <= 0.5)
    )
      k++;
    const label = pool[k];
    if (!label) {
      unmatched++;
      continue;
    }
    next = k + 1;
    const err = w.fromFrame - label.start * fps;
    errors.push(Math.abs(err));
    if (Math.abs(err) > max)
      violations.push({
        message: tr(
          `« ${w.text} » highlighted ${Math.abs(err).toFixed(1)} frame(s) ${err > 0 ? "late" : "early"} (annotation)`,
          `« ${w.text} » surligné ${err > 0 ? "en retard" : "en avance"} de ${Math.abs(err).toFixed(1)} frame(s) (annotation)`,
        ),
        frame: w.fromFrame,
      });
  }
  if (errors.length === 0)
    return notEvaluated("captions.sync", tr("no annotated word recognised", "aucun mot annoté reconnu"));
  const sorted = [...errors].sort((a, b) => a - b);
  const p = sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] as number;
  if (p > p95)
    violations.push({
      message: tr(
        `p95 of ${p.toFixed(2)} frame(s) > ${p95} (annotation)`,
        `p95 de ${p.toFixed(2)} frame(s) > ${p95} (annotation)`,
      ),
    });
  const result = graded("captions.sync", errors.length, violations, {
    source: "annotation humaine",
    words: words.length,
    annotated: errors.length,
    unmatched,
    p95Frames: Math.round(p * 100) / 100,
    maxFrames: Math.round((sorted.at(-1) as number) * 100) / 100,
  });
  return unmatched > 0
    ? {
        ...result,
        note: tr(`${unmatched} word(s) without annotation`, `${unmatched} mot(s) sans annotation`),
      }
    : result;
}

const isFillerLabel = (l: Label, profile: StyleProfile) =>
  profile.montage.fillerWords.map(norm).includes(norm(l.text));

/** montage.fillers against the annotation: every label marking a hesitation is one left in the render. */
export function checkFillersTruth(labels: Label[], profile: StyleProfile, fps: number): CheckResult {
  const words = labels.filter((l) => !isFillerLabel(l, profile)).length;
  const left = labels.filter((l) => isFillerLabel(l, profile));
  return graded(
    "montage.fillers",
    Math.max(1, words + left.length),
    left.map((l) => ({
      message: tr(`« ${l.text} » still audible (annotation)`, `« ${l.text} » encore audible (annotation)`),
      frame: Math.round(l.start * fps),
    })),
    { source: "annotation humaine", annotated: words + left.length, left: left.length },
  );
}
