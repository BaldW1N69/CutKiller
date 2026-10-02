import { statSync } from "node:fs";
import { resolve } from "node:path";
import { runWorker } from "@cutkiller/analyze";
import { type Rgb, srgbToLab } from "@cutkiller/color";
import {
  type Analysis,
  clipEnd,
  clipFraming,
  type Edl,
  type Face,
  type StyleProfile,
  type Subjects,
  sortedClips,
  type VideoClip,
} from "@cutkiller/core";
import { clipAt } from "../decode";
import { type CheckResult, notEvaluated, type Violation } from "../report";

const SAMPLE_FPS = 5;
const memo = new Map<string, Promise<Subjects>>();

/** Faces and skin colours of the rendered video (5 samples/s), computed once per version of the file. */
export function renderSubjects(video: string): Promise<Subjects> {
  const path = resolve(video);
  const key = `${path}@${statSync(path).mtimeMs}`;
  let subjects = memo.get(key);
  if (!subjects) {
    // The worker runs from its own directory: absolute path.
    subjects = runWorker<Subjects>("subjects", { path, fps: SAMPLE_FPS });
    memo.set(key, subjects);
  }
  return subjects;
}

const largest = (faces: Face[]) => faces.reduce((a, b) => (a.w * a.h >= b.w * b.h ? a : b));

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] as number;
};

interface SteadySample {
  frame: number;
  clip: VideoClip;
  faces: Face[];
}

/**
 * Render samples that show one main-track shot steadily: the top layer is the main
 * track, at least 2 frames from its cuts, outside transitions (a whip-pan moves
 * and blurs the picture on purpose), not black.
 */
function steadySamples(edl: Edl, subjects: Subjects): SteadySample[] {
  const fps = edl.output.fps;
  const main = new Set((edl.video[0]?.clips ?? []).map((c) => c.id));
  const busy = edl.transitions.map((t) => {
    const half = Math.ceil(t.durationFrames / 2) + 1;
    return [t.atFrame - half, t.atFrame + half] as const;
  });
  const out: SteadySample[] = [];
  for (const s of subjects.samples) {
    const frame = Math.round(s.t * fps);
    const clip = clipAt(edl, frame);
    if (!clip || !main.has(clip.id)) continue;
    if (frame - clip.at < 2 || clipEnd(clip, fps) - frame <= 2) continue;
    if (busy.some(([a, b]) => frame >= a && frame <= b)) continue;
    // A black frame is image.black-frames' finding: not counted again as a lost face.
    if (Math.max(...s.rgb) < 0.05) continue;
    out.push({ frame, clip, faces: s.faces });
  }
  return out;
}

/** Whether the source shows a face at the instant a render frame comes from (undefined: unknown). */
function sourceHasFace(analysis: Analysis | undefined, clip: VideoClip, frame: number, fps: number) {
  const subjects = analysis?.subjects?.[clip.source];
  if (!subjects || subjects.samples.length === 0) return undefined;
  const t = clip.in + (frame - clip.at) / fps;
  const near = subjects.samples.reduce((a, b) => (Math.abs(a.t - t) <= Math.abs(b.t - t) ? a : b));
  return Math.abs(near.t - t) <= 1 / subjects.sampleFps ? near.faces.length > 0 : undefined;
}

/** Runs of consecutive bad samples (same problem, same shot) become one violation. */
function runs(bad: { frame: number; clip: string; kind: string; message: string }[], fps: number) {
  const out: Violation[] = [];
  let last: (typeof bad)[number] | undefined;
  let count = 0;
  const flush = () => {
    if (last)
      out.push({
        message: `${last.message}${count > 1 ? ` (${count} échantillons)` : ""}`,
        frame: last.frame,
      });
  };
  for (const b of bad) {
    if (
      last &&
      b.clip === last.clip &&
      b.kind === last.kind &&
      b.frame - last.frame <= fps / SAMPLE_FPS + 1
    ) {
      count++;
      continue;
    }
    flush();
    last = b;
    count = 1;
  }
  flush();
  return out;
}

const ratio = (
  ruleId: string,
  total: number,
  bad: number,
  violations: Violation[],
  measured: Record<string, unknown>,
): CheckResult => ({
  ruleId,
  status: bad === 0 ? "pass" : "fail",
  score: total === 0 ? 1 : (total - Math.min(total, bad)) / total,
  violations,
  measured,
});

/**
 * image.reframe — the 9:16 crop follows the subject without jolts:
 * - camera path (shared framing geometry): acceleration of the crop centre ≤ maxAccelPx;
 * - on the render (independent face detection, 5 samples/s): wherever the source
 *   shows a face, the render shows it, at least minFaceInFrame of its box inside
 *   the picture and its centre within maxFaceOffset of the middle.
 */
export async function checkReframe(
  video: string,
  edl: Edl,
  profile: StyleProfile,
  analysis?: Analysis,
): Promise<CheckResult> {
  const cfg = profile.reframe;
  const fps = edl.output.fps;
  const reframed = sortedClips(edl.video[0]?.clips ?? []).filter((c) => c.reframe);
  if (reframed.length === 0)
    return notEvaluated("image.reframe", "aucun plan recadré : les rushes ont déjà le format de sortie");
  const violations: Violation[] = [];
  let badClips = 0;
  let peakAccel = 0;
  for (const clip of reframed) {
    const framing = clipFraming(edl, clip);
    if (!framing) continue;
    const i = framing.axis === "x" ? 0 : 1;
    const shift = (f: number) => framing.shiftAt(f)[i];
    let worst = 0;
    let at = clip.at;
    for (let f = clip.at + 1; f < clipEnd(clip, fps) - 1; f++) {
      const a = Math.abs(shift(f + 1) - 2 * shift(f) + shift(f - 1));
      if (a > worst) {
        worst = a;
        at = f;
      }
    }
    peakAccel = Math.max(peakAccel, worst);
    if (worst > cfg.maxAccelPx) {
      badClips++;
      violations.push({
        message: `à-coup de la caméra virtuelle : ${worst.toFixed(1)} px/frame² (max ${cfg.maxAccelPx})`,
        frame: at,
      });
    }
  }

  const subjects = await renderSubjects(video);
  const bad: { frame: number; clip: string; kind: string; message: string }[] = [];
  const offsets: number[] = [];
  let samples = 0;
  for (const s of steadySamples(edl, subjects)) {
    if (!s.clip.reframe) continue;
    const expected = sourceHasFace(analysis, s.clip, s.frame, fps);
    if (s.faces.length === 0) {
      if (expected) {
        samples++;
        bad.push({
          frame: s.frame,
          clip: s.clip.id,
          kind: "lost",
          message: "visage du rush absent du cadre",
        });
      }
      continue;
    }
    if (expected === false) continue;
    samples++;
    const f = largest(s.faces);
    const ix = Math.max(0, Math.min(1, f.x + f.w) - Math.max(0, f.x));
    const iy = Math.max(0, Math.min(1, f.y + f.h) - Math.max(0, f.y));
    const inside = (ix * iy) / (f.w * f.h);
    const offset = s.clip.reframe.axis === "x" ? Math.abs(f.x + f.w / 2 - 0.5) : 0;
    offsets.push(offset);
    if (inside < cfg.minFaceInFrame)
      bad.push({
        frame: s.frame,
        clip: s.clip.id,
        kind: "cut",
        message: `visage coupé par le cadre (${Math.round(inside * 100)} % dans l'image)`,
      });
    else if (offset > cfg.maxFaceOffset)
      bad.push({
        frame: s.frame,
        clip: s.clip.id,
        kind: "off",
        message: `visage décentré (${Math.round(offset * 100)} % de la largeur)`,
      });
  }
  violations.push(...runs(bad, fps));
  const sorted = [...offsets].sort((a, b) => a - b);
  return ratio("image.reframe", reframed.length + samples, badClips + bad.length, violations, {
    clips: reframed.length,
    samples,
    badSamples: bad.length,
    peakAccelPx: Math.round(peakAccel * 100) / 100,
    faceOffsetP50: Math.round((sorted[Math.floor(sorted.length / 2)] ?? 0) * 1000) / 1000,
    faceOffsetMax: Math.round((sorted.at(-1) ?? 0) * 1000) / 1000,
  });
}

/**
 * image.color — consistent grading: one look on every shot, and the skin of each
 * shot (measured on the render: cheeks and nose of the largest face) within
 * maxSkinDeltaL (CIE L*) and maxSkinDeltaAb (a*b* distance) of the edit's
 * reference, the duration-weighted median skin.
 */
export async function checkColor(video: string, edl: Edl, profile: StyleProfile): Promise<CheckResult> {
  const cfg = profile.color;
  const main = edl.video[0]?.clips ?? [];
  if (main.length === 0) return notEvaluated("image.color", "aucun plan");
  const violations: Violation[] = [];
  const looks = new Set(main.map((c) => c.color?.look ?? "aucun"));
  if (looks.size > 1)
    violations.push({ message: `looks différents d'un plan à l'autre : ${[...looks].join(", ")}` });

  const subjects = await renderSubjects(video);
  const skins = new Map<string, Rgb[]>();
  for (const s of steadySamples(edl, subjects))
    if (s.faces.length > 0)
      skins.set(s.clip.id, [...(skins.get(s.clip.id) ?? []), largest(s.faces).rgb as Rgb]);
  const shots = main.flatMap((clip) => {
    const rgb = skins.get(clip.id) ?? [];
    if (rgb.length < 2) return [];
    const tone = [0, 1, 2].map((c) => median(rgb.map((v) => v[c] as number))) as Rgb;
    return [{ clip, lab: srgbToLab(tone), weight: rgb.length }];
  });
  const measured: Record<string, unknown> = { looks: [...looks], shots: shots.length };
  if (shots.length < 2) {
    if (!main.some((c) => c.color))
      return notEvaluated("image.color", "ni étalonnage, ni deux plans avec un visage à comparer");
    return {
      ...ratio("image.color", 1, violations.length, violations, measured),
      note: "moins de deux plans avec un visage : seul le look est vérifié",
    };
  }
  const weighted = shots.flatMap((s) => Array.from({ length: s.weight }, () => s.lab));
  const ref = [0, 1, 2].map((c) => median(weighted.map((l) => l[c] as number))) as Rgb;
  let maxL = 0;
  let maxAb = 0;
  let bad = 0;
  for (const s of shots) {
    const dL = Math.abs((s.lab[0] as number) - ref[0]);
    const dAb = Math.hypot((s.lab[1] as number) - ref[1], (s.lab[2] as number) - ref[2]);
    maxL = Math.max(maxL, dL);
    maxAb = Math.max(maxAb, dAb);
    if (dL > cfg.maxSkinDeltaL || dAb > cfg.maxSkinDeltaAb) {
      bad++;
      violations.push({
        message: `peau de « ${s.clip.id} » loin de la référence : ΔL* ${dL.toFixed(1)}, Δa*b* ${dAb.toFixed(1)}`,
        frame: s.clip.at,
      });
    }
  }
  return ratio("image.color", shots.length + 1, bad + (looks.size > 1 ? 1 : 0), violations, {
    ...measured,
    skinLab: ref.map((v) => Math.round(v * 10) / 10),
    maxDeltaL: Math.round(maxL * 10) / 10,
    maxDeltaAb: Math.round(maxAb * 10) / 10,
  });
}
