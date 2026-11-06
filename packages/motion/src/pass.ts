import {
  clipEnd,
  type Diagnostic,
  type Edl,
  type EdlInput,
  EdlSchema,
  type Pass,
  type PassContext,
  type PresetResolver,
  secondsToFrames,
  sortedClips,
  type VideoClip,
} from "@cutkiller/core";
import { emphasisScores } from "./emphasis";
import { MotionParamsSchema, TransitionParamsSchema } from "./presets";

/** Frames kept free at each end of a clip: a punch that late would land on the next cut. */
const EDGE_HEAD_FRAMES = 6;
const EDGE_TAIL_FRAMES = 9;
/** The punch starts slightly before the word so it lands on its stressed syllable. */
const LEAD_FRAMES = 2;

function resolver(ctx: PassContext): PresetResolver {
  if (!ctx.presets) throw new Error("la passe motion a besoin du registre de presets");
  return ctx.presets;
}

/**
 * Passe « motion » :
 * - punch-ins animés (preset zoom-punch) sur les mots d'emphase des plans larges,
 *   espacés, à un niveau toujours différent du punch-in précédent (statique ou animé) ;
 * - transitions aux ruptures (jump cuts qui ont retiré au moins `minRemovedS` de rush,
 *   ou changement de source), espacées, presets du profil utilisés à tour de rôle.
 */
export const motionPass: Pass = {
  id: "motion",
  run(edl: Edl, ctx: PassContext) {
    const presets = resolver(ctx);
    const fps = edl.output.fps;
    const m = ctx.profile.motion;
    const diagnostics: Diagnostic[] = [];
    const clips = sortedClips(edl.video[0]?.clips ?? []);
    const keyframes: EdlInput["keyframes"] = [...edl.keyframes];
    const transitions: EdlInput["transitions"] = [...edl.transitions];

    // A cutaway (overlay) hides the speaker: no punch-in nor transition under it.
    const overlays = edl.video.slice(1).flatMap((t) => t.clips);
    const hidden = (from: number, to: number) => overlays.some((o) => o.at < to && clipEnd(o, fps) > from);

    // Punch-ins.
    const punchPreset = presets.resolve(m.punchPreset);
    const punch = MotionParamsSchema.parse(punchPreset.params);
    const punchFrames = Math.max(1, secondsToFrames(punch.durationMs / 1000, fps));
    const scores = new Map<string, number[]>();
    let lastPunchLevel: number | undefined;
    let lastPunchFrame = Number.NEGATIVE_INFINITY;
    let levelIndex = 0;
    let punches = 0;
    clips.forEach((clip, k) => {
      if (clip.transform.scale > 1.0001) {
        lastPunchLevel = clip.transform.scale;
        return;
      }
      const transcript = ctx.analysis.transcripts?.[clip.source];
      const ids = clip.why?.wordIds ?? [];
      if (!transcript || ids.length === 0) return;
      if (!scores.has(clip.source))
        scores.set(clip.source, emphasisScores(transcript, ctx.analysis.prosody?.[clip.source], ctx.profile));
      const sc = scores.get(clip.source) as number[];
      const end = clipEnd(clip, fps);
      let best: { id: number; frame: number; score: number } | undefined;
      for (const id of ids) {
        const w = transcript.words[id];
        const score = sc[id] ?? Number.NEGATIVE_INFINITY;
        if (!w || score < m.emphasisMinScore) continue;
        const frame = clip.at + secondsToFrames(w.start - clip.in, fps) - LEAD_FRAMES;
        if (frame < clip.at + EDGE_HEAD_FRAMES || frame + punchFrames > end - EDGE_TAIL_FRAMES) continue;
        if ((frame - lastPunchFrame) / fps < m.punchMinSpacingS) continue;
        if (hidden(frame, frame + punchFrames)) continue;
        if (!best || score > best.score) best = { id, frame, score };
      }
      if (!best) return;
      // Never the level of the previous punch-in, nor of the next static one.
      const nextStatic = clips.slice(k + 1).find((c) => c.transform.scale > 1.0001)?.transform.scale;
      let level: number | undefined;
      for (let tries = 0; tries < m.punchLevels.length; tries++) {
        const candidate = m.punchLevels[(levelIndex + tries) % m.punchLevels.length] as number;
        if (candidate !== lastPunchLevel && candidate !== nextStatic) {
          level = candidate;
          levelIndex += tries + 1;
          break;
        }
      }
      if (level === undefined) return;
      const word = transcript.words[best.id] as { text: string };
      keyframes.push({
        target: `${clip.id}.scale`,
        role: punch.role,
        preset: `${punchPreset.name}@${punchPreset.version}`,
        keys: [
          { frame: best.frame, value: 1 },
          { frame: best.frame + punchFrames, value: level, ease: punch.ease },
        ],
        why: {
          kind: "emphasis",
          wordIds: [best.id],
          note: `« ${word.text} » (score ${best.score.toFixed(1)})`,
        },
      });
      lastPunchLevel = level;
      lastPunchFrame = best.frame;
      punches++;
    });

    // Transitions at section breaks.
    let lastTransition = Number.NEGATIVE_INFINITY;
    const used = { same: 0, cross: 0 };
    let placed = 0;
    for (let k = 1; k < clips.length; k++) {
      const prev = clips[k - 1] as VideoClip;
      const cur = clips[k] as VideoClip;
      const sameSource = prev.source === cur.source;
      const removed = sameSource ? cur.in - prev.out : Number.POSITIVE_INFINITY;
      if (removed < m.transitions.minRemovedS) continue;
      if ((cur.at - lastTransition) / fps < m.transitions.minSpacingS) continue;
      const list = sameSource ? m.transitions.sameSource : m.transitions.crossSource;
      if (list.length === 0) continue;
      const ref = list[(sameSource ? used.same : used.cross) % list.length] as string;
      const preset = presets.resolve(ref);
      const params = TransitionParamsSchema.parse(preset.params);
      const duration = Math.max(2, secondsToFrames(params.durationMs / 1000, fps));
      const half = Math.ceil(duration / 2);
      if (half > cur.at - prev.at || half > clipEnd(cur, fps) - cur.at) continue;
      if (hidden(cur.at - half, cur.at + half)) continue;
      transitions.push({
        id: `t${String(transitions.length + 1).padStart(3, "0")}`,
        atFrame: cur.at,
        preset: `${preset.name}@${preset.version}`,
        durationFrames: duration,
        why: {
          kind: "section-break",
          note: Number.isFinite(removed)
            ? `${removed.toFixed(1)} s de rush retirées`
            : "changement de source",
        },
      });
      lastTransition = cur.at;
      if (sameSource) used.same++;
      else used.cross++;
      placed++;
    }

    diagnostics.push({
      level: "info",
      code: "motion.summary",
      message: `${punches} punch-in(s) sur l'emphase, ${placed} transition(s)`,
    });
    return { edl: EdlSchema.parse({ ...edl, keyframes, transitions }), diagnostics };
  },
};
