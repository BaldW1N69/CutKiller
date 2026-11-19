import { existsSync, readFileSync } from "node:fs";
import { CaptionTimeline, captionStyle } from "@cutkiller/captions";
import {
  type Ease,
  type Edl,
  easeOvershoot,
  easeShape,
  framesToSeconds,
  isLinearEase,
  type KeyframeTrack,
  type StyleProfile,
  sortedClips,
  tr,
  trackClip,
  trackProperty,
  type VideoClip,
} from "@cutkiller/core";
import {
  MotionParamsSchema,
  MotionTimeline,
  resolveTransitions,
  type TransitionParams,
  TransitionParamsSchema,
} from "@cutkiller/motion";
import type { MotionLog } from "@cutkiller/render";
import type { Preset, PresetRegistry } from "@cutkiller/style";
import { type CheckResult, graded, notEvaluated, type Violation } from "../report";

/** Half a frame of tolerance on durations: animations live on whole frames. */
const frameTolerance = (fps: number) => 500 / fps;
/** Overshoot under this is numerical noise, not a bounce. */
const NO_OVERSHOOT = 0.005;

interface Segment {
  durationS: number;
  ease: Ease | undefined;
}

/** Animated (non-hold) segments of a track. */
function segments(track: KeyframeTrack, fps: number): Segment[] {
  return track.keys.slice(1).flatMap((key, i) => {
    const prev = track.keys[i] as (typeof track.keys)[number];
    if (key.ease === "hold" || key.value === prev.value) return [];
    return [{ durationS: framesToSeconds(key.frame - prev.frame, fps), ease: key.ease }];
  });
}

/** Overshoot allowed for a role: a light bounce on entries and micro-animations, none elsewhere. */
function overshootViolation(
  role: string | undefined,
  overshoot: number,
  profile: StyleProfile,
): string | undefined {
  const [lo, hi] = profile.motion.overshoot;
  const pct = (x: number) => `${(x * 100).toFixed(1)} %`;
  if (overshoot <= NO_OVERSHOOT) return undefined;
  if (role === "entry" || role === "micro") {
    if (overshoot < lo || overshoot > hi)
      return tr(
        `overshoot of ${pct(overshoot)} (expected 0 or ${pct(lo)}–${pct(hi)})`,
        `dépassement de ${pct(overshoot)} (attendu 0 ou ${pct(lo)}–${pct(hi)})`,
      );
    return undefined;
  }
  return tr(
    `overshoot of ${pct(overshoot)} on a « ${role ?? "no role"} » animation (none allowed)`,
    `dépassement de ${pct(overshoot)} sur une animation « ${role ?? "sans rôle"} » (aucun autorisé)`,
  );
}

/** Entries decelerate (ease-out), exits accelerate (ease-in). */
function shapeViolation(
  role: string | undefined,
  ease: Ease | undefined,
  durationS: number,
): string | undefined {
  const shape = easeShape(ease, durationS);
  if (role === "entry" && shape !== "decelerating")
    return tr("an entrance must decelerate (ease-out)", "une entrée doit décélérer (ease-out)");
  if (role === "exit" && shape !== "accelerating")
    return tr("an exit must accelerate (ease-in)", "une sortie doit accélérer (ease-in)");
  return undefined;
}

function checkPresetDefinition(preset: Preset, profile: StyleProfile, fps: number): string[] {
  const id = `${preset.name}@${preset.version}`;
  const problems: string[] = [];
  const [mLo, mHi] = profile.motion.microDurationMs;
  const tol = frameTolerance(fps);
  if (preset.kind === "motion") {
    const p = MotionParamsSchema.safeParse(preset.params);
    if (!p.success) return [tr(`${id}: invalid parameters`, `${id} : paramètres invalides`)];
    const { role, durationMs, ease, property } = p.data;
    if (
      (role === "micro" || role === "entry" || role === "exit") &&
      (durationMs < mLo - tol || durationMs > mHi + tol)
    )
      problems.push(
        tr(
          `${id}: ${durationMs} ms (expected ${mLo}–${mHi} ms)`,
          `${id} : ${durationMs} ms (attendu ${mLo}–${mHi} ms)`,
        ),
      );
    if (property !== "rotation" && isLinearEase(ease))
      problems.push(tr(`${id}: linear curve`, `${id} : courbe linéaire`));
    const o = overshootViolation(role, easeOvershoot(ease, durationMs / 1000), profile);
    if (o) problems.push(`${id} : ${o}`);
    const sh = shapeViolation(role, ease, durationMs / 1000);
    if (sh) problems.push(`${id} : ${sh}`);
  } else if (preset.kind === "transition") {
    const p = TransitionParamsSchema.safeParse(preset.params);
    if (!p.success) return [tr(`${id}: invalid parameters`, `${id} : paramètres invalides`)];
    const params: TransitionParams = p.data;
    const [tLo, tHi] = transitionRange(params, profile);
    if (params.durationMs < tLo - tol || params.durationMs > tHi + tol)
      problems.push(
        tr(
          `${id}: ${params.durationMs} ms (expected ${tLo}–${tHi} ms)`,
          `${id} : ${params.durationMs} ms (attendu ${tLo}–${tHi} ms)`,
        ),
      );
    if (params.type !== "glitch") {
      if (isLinearEase(params.ease)) problems.push(tr(`${id}: linear curve`, `${id} : courbe linéaire`));
      const o = easeOvershoot(params.ease, params.durationMs / 1000);
      if (o > NO_OVERSHOOT)
        problems.push(
          tr(
            `${id}: overshoot of ${(o * 100).toFixed(1)} % on a transition`,
            `${id} : dépassement de ${(o * 100).toFixed(1)} % sur une transition`,
          ),
        );
      if (params.type === "slide") {
        const sh = shapeViolation("entry", params.ease, params.durationMs / 1000);
        if (sh) problems.push(`${id} : ${sh}`);
      }
    }
  }
  return problems;
}

/**
 * Presets: every preset of the library follows the rules (durations, no linear
 * curve, entries ease out / exits ease in, overshoot), every reference in the EDL
 * resolves, and animations generated from a preset still match it.
 */
export function checkPresets(edl: Edl, registry: PresetRegistry, profile: StyleProfile): CheckResult {
  const fps = edl.output.fps;
  const violations: Violation[] = [];
  const library = registry.all().filter((p) => p.kind === "motion" || p.kind === "transition");
  for (const preset of library)
    for (const message of checkPresetDefinition(preset, profile, fps)) violations.push({ message });
  let items = library.length;
  for (const track of edl.keyframes) {
    if (!track.preset) continue;
    items++;
    try {
      const params = MotionParamsSchema.parse(registry.resolve(track.preset).params);
      const segs = segments(track, fps);
      const expected = params.durationMs / 1000;
      if (segs.length !== 1 || Math.abs((segs[0] as Segment).durationS - expected) > 1 / fps + 1e-9)
        violations.push({
          message: `${track.target} : ne suit plus ${track.preset}`,
          frame: track.keys[0]?.frame,
        });
    } catch (e) {
      violations.push({ message: `${track.target} : ${(e as Error).message}`, frame: track.keys[0]?.frame });
    }
  }
  for (const t of edl.transitions) {
    items++;
    try {
      const params = TransitionParamsSchema.parse(registry.resolve(t.preset).params);
      if (Math.abs(framesToSeconds(t.durationFrames, fps) * 1000 - params.durationMs) > 1000 / fps)
        violations.push({
          message: tr(
            `${t.id}: duration differs from ${t.preset}`,
            `${t.id} : durée différente de ${t.preset}`,
          ),
          frame: t.atFrame,
        });
    } catch (e) {
      violations.push({ message: `${t.id} : ${(e as Error).message}`, frame: t.atFrame });
    }
  }
  // Caption styles and the entry animation each one plays.
  for (const ref of new Set(edl.captions.map((c) => c.style))) {
    items++;
    try {
      const style = captionStyle(registry, ref);
      if (style.entry) {
        const entry = registry.resolve(style.entry);
        const params = MotionParamsSchema.safeParse(entry.params);
        if (entry.kind !== "motion" || !params.success || params.data.role !== "entry")
          violations.push({
            message: tr(
              `${ref}: ${style.entry} is not an entrance animation`,
              `${ref} : ${style.entry} n'est pas une animation d'entrée`,
            ),
          });
      }
    } catch (e) {
      violations.push({ message: `${ref} : ${(e as Error).message}` });
    }
  }
  if (items === 0) return notEvaluated("motion.presets", "aucun preset");
  return graded("motion.presets", items, violations, { presets: library.length });
}

/** Duration range of a transition: moves (push, slide, glitch) or dissolves. */
function transitionRange(params: TransitionParams, profile: StyleProfile): [number, number] {
  return params.type === "dissolve" ? profile.motion.dissolveDurationMs : profile.motion.transitionDurationMs;
}

/** Micro-animations, entries and exits 150–300 ms; transitions 200–500 ms; dissolves 400–1 500 ms. */
export function checkDurations(edl: Edl, profile: StyleProfile, registry?: PresetRegistry): CheckResult {
  const fps = edl.output.fps;
  const tol = frameTolerance(fps);
  const [mLo, mHi] = profile.motion.microDurationMs;
  const violations: Violation[] = [];
  let items = 0;
  for (const track of edl.keyframes) {
    if (track.role !== "micro" && track.role !== "entry" && track.role !== "exit") continue;
    for (const seg of segments(track, fps)) {
      items++;
      const ms = seg.durationS * 1000;
      if (ms < mLo - tol || ms > mHi + tol)
        violations.push({ message: `${track.target} : ${Math.round(ms)} ms`, frame: track.keys[0]?.frame });
    }
  }
  for (const t of edl.transitions) {
    items++;
    const ms = framesToSeconds(t.durationFrames, fps) * 1000;
    let params: TransitionParams | undefined;
    try {
      params = registry ? TransitionParamsSchema.parse(registry.resolve(t.preset).params) : undefined;
    } catch {
      params = undefined; // an unknown preset is motion.presets' finding
    }
    const [tLo, tHi] = params ? transitionRange(params, profile) : profile.motion.transitionDurationMs;
    if (ms < tLo - tol || ms > tHi + tol)
      violations.push({ message: `${t.id} : ${Math.round(ms)} ms`, frame: t.atFrame });
  }
  if (items === 0) return notEvaluated("motion.durations", "aucune animation ni transition");
  return graded("motion.durations", items, violations, { animations: items });
}

/** Light bounce (3–8 %) only on entries and micro-animations; none on exits, moves and transitions. */
export function checkOvershoot(edl: Edl, registry: PresetRegistry, profile: StyleProfile): CheckResult {
  const fps = edl.output.fps;
  const violations: Violation[] = [];
  let items = 0;
  for (const track of edl.keyframes) {
    if (trackProperty(track) === "rotation") continue;
    for (const seg of segments(track, fps)) {
      items++;
      const v = overshootViolation(track.role, easeOvershoot(seg.ease, seg.durationS), profile);
      if (v) violations.push({ message: `${track.target} : ${v}`, frame: track.keys[0]?.frame });
      const sh = shapeViolation(track.role, seg.ease, seg.durationS);
      if (sh) violations.push({ message: `${track.target} : ${sh}`, frame: track.keys[0]?.frame });
    }
  }
  for (const t of resolveTransitions(edl, registry)) {
    if (t.params.type === "glitch") continue;
    items++;
    const o = easeOvershoot(t.params.ease, framesToSeconds(t.durationFrames, fps));
    if (o > NO_OVERSHOOT)
      violations.push({
        message: tr(
          `${t.id}: overshoot of ${(o * 100).toFixed(1)} %`,
          `${t.id} : dépassement de ${(o * 100).toFixed(1)} %`,
        ),
        frame: t.atFrame,
      });
  }
  if (items === 0) return notEvaluated("motion.overshoot", "aucune animation");
  return graded("motion.overshoot", items, violations, { animations: items });
}

/**
 * Motion blur: recomputes, from the EDL, every frame moving faster than the
 * threshold (pictures, transitions and caption entries) and checks the render log says it was blurred (several shutter
 * samples). Indirect measure: blur is not measured on the pixels.
 */
export function checkMotionBlur(
  video: string,
  edl: Edl,
  registry: PresetRegistry,
  profile: StyleProfile,
): CheckResult {
  const logPath = `${video}.render-log.json`;
  if (!existsSync(logPath))
    return notEvaluated("motion.blur", tr("render log missing", "journal de rendu absent"));
  const log = JSON.parse(readFileSync(logPath, "utf8")) as { motion?: MotionLog; frames: number };
  if (!log.motion)
    return notEvaluated(
      "motion.blur",
      tr("render log without motion data", "journal de rendu sans données de mouvement"),
    );
  const rendered = new Map(log.motion.frames.map(([f, , n]) => [f, n]));
  const timeline = new MotionTimeline(edl, resolveTransitions(edl, registry));
  const captions = new CaptionTimeline(edl, registry);
  const threshold = profile.motion.motionBlurThresholdPxPerFrame;
  const violations: Violation[] = [];
  let fast = 0;
  for (let f = 0; f < log.frames; f++) {
    const v = Math.max(timeline.velocityAt(f), captions.velocityAt(f));
    if (v <= threshold) continue;
    fast++;
    if ((rendered.get(f) ?? 1) < 2)
      violations.push({
        message: tr(`${v.toFixed(0)} px/frame without blur`, `${v.toFixed(0)} px/frame sans flou`),
        frame: f,
      });
  }
  if (fast === 0)
    return notEvaluated(
      "motion.blur",
      tr(`no motion above ${threshold} px/frame`, `aucun mouvement au-delà de ${threshold} px/frame`),
    );
  return graded("motion.blur", fast, violations, { fastFrames: fast, thresholdPxPerFrame: threshold });
}

/**
 * Punch-ins, static (zoom cuts) and animated (on emphasis words), in timeline
 * order: level within range, never twice the same in a row, animated ones
 * anchored on the word they underline.
 */
export function checkPunchIns(edl: Edl, profile: StyleProfile): CheckResult {
  const [lo, hi] = profile.montage.punchInScale;
  const clips = sortedClips(edl.video[0]?.clips ?? []);
  const byId = new Map(clips.map((c) => [c.id, c]));
  const events: { frame: number; level: number; label: string; track?: KeyframeTrack }[] = [];
  for (const c of clips)
    if (c.transform.scale > 1.0001) events.push({ frame: c.at, level: c.transform.scale, label: c.id });
  for (const track of edl.keyframes) {
    // Punches (micro) and the slow push-ins of the cinematic profiles (move) alike.
    if (trackProperty(track) !== "scale" || (track.role !== "micro" && track.role !== "move")) continue;
    const clip = byId.get(trackClip(track)) as VideoClip | undefined;
    if (!clip) continue;
    const end = track.keys.at(-1)?.value ?? 1;
    if (end <= 1.0001) continue;
    events.push({
      frame: track.keys[0]?.frame ?? clip.at,
      level: clip.transform.scale * end,
      label: track.target,
      track,
    });
  }
  if (events.length === 0) return notEvaluated("montage.punch-ins", "aucun punch-in");
  events.sort((a, b) => a.frame - b.frame);
  const violations: Violation[] = [];
  events.forEach((e, k) => {
    const pct = Math.round(e.level * 100);
    if (e.level < lo - 1e-6 || e.level > hi + 1e-6)
      violations.push({
        message: tr(`${e.label}: punch-in at ${pct} %`, `${e.label} : punch-in à ${pct} %`),
        frame: e.frame,
      });
    const prev = events[k - 1];
    if (prev && Math.abs(prev.level - e.level) < 1e-6)
      violations.push({
        message: tr(
          `${e.label}: two punch-ins in a row at ${pct} %`,
          `${e.label} : deux punch-ins de suite à ${pct} %`,
        ),
        frame: e.frame,
      });
    if (e.track && !(e.track.why?.kind === "emphasis" && (e.track.why.wordIds?.length ?? 0) > 0))
      violations.push({
        message: tr(
          `${e.label}: animated punch-in without an emphasised word`,
          `${e.label} : punch-in animé sans mot d'emphase`,
        ),
        frame: e.frame,
      });
  });
  return graded("montage.punch-ins", events.length, violations, {
    punchIns: events.length,
    animated: events.filter((e) => e.track).length,
  });
}
