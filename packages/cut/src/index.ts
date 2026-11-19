import {
  type Diagnostic,
  type Edl,
  type EdlInput,
  EdlSchema,
  framesToSeconds,
  type Pass,
  type PassContext,
  sortedClips,
} from "@cutkiller/core";
import { timelineBeats } from "./beats";
import { planClips, zoomSplits } from "./plan";
import { speechTokens } from "./words";

export { type AssembleOptions, assembleEdl, outputFps } from "./assemble";
export { timelineBeats } from "./beats";
export { brollPass, isBroll, type PieceScore, verticalFit } from "./broll";
export { buildRuns, type PlannedClip, planClips, type Run, snapJumpCuts, zoomSplits } from "./plan";
export {
  classifyWords,
  normalizeWord,
  type Removal,
  resolveOverlaps,
  speechTokens,
  type Token,
} from "./words";

/**
 * Passe « cut » : chaque rush transcrit est remplacé par ses passages utiles —
 * hésitations, faux départs et silences > seuil retirés avec des marges de 80–120 ms,
 * coupes calées sur les beats quand il y a une musique, zoom-cuts pour qu'aucun plan
 * ne reste statique au-delà de la limite du profil.
 */
export const cutPass: Pass = {
  id: "cut",
  run(edl: Edl, ctx: PassContext) {
    const fps = edl.output.fps;
    const diagnostics: Diagnostic[] = [];
    const beats = timelineBeats(edl, ctx.analysis);
    const main = edl.video[0];
    if (!main) return { edl, diagnostics };
    const clips: EdlInput["video"][number]["clips"] = [];
    let at = 0;
    let framingIndex = 0;
    let removedFillers = 0;
    let removedRepeats = 0;
    let removedS = 0;
    let hallucinated = 0;

    for (const clip of sortedClips(main.clips)) {
      const transcript = ctx.analysis.transcripts?.[clip.source];
      const source = edl.sources[clip.source];
      if (!transcript || transcript.words.length === 0 || !source) {
        // No speech to edit (B-roll, still, untranscribed rush): only keep it from going static.
        // Whole frames, rounded down: a rush of 20.02 s at 30 fps gives 600 frames, never
        // a 601st that would read past its end.
        const frames = Math.floor((clip.out - clip.in) * fps + 1e-6);
        const bounds = [0, ...zoomSplits(frames, at, beats, ctx.profile, fps), frames];
        for (let j = 0; j < bounds.length - 1; j++) {
          const a = bounds[j] as number;
          const b = bounds[j + 1] as number;
          const scale =
            framingIndex % 2 === 0
              ? 1
              : (ctx.profile.montage.zoomCutLevels[
                  Math.floor(framingIndex / 2) % ctx.profile.montage.zoomCutLevels.length
                ] as number);
          framingIndex++;
          const still = source?.still === true;
          clips.push({
            ...clip,
            id: bounds.length > 2 ? `${clip.id}-${String(j + 1).padStart(3, "0")}` : clip.id,
            in: still ? clip.in : clip.in + a / fps,
            out: still ? clip.in + (b - a) / fps : Math.round((clip.in + b / fps) * 1e6) / 1e6,
            at: at + a,
            transform: { ...clip.transform, scale },
            ...(j > 0 ? { why: { kind: "zoom-cut" } } : {}),
          });
        }
        at += frames;
        continue;
      }
      const vad = ctx.analysis.vad?.[clip.source];
      const view = speechTokens(transcript.words, vad?.speech, ctx.profile);
      hallucinated += view.hallucinated;
      const tokens = view.tokens
        .filter((t) => t.word.end > clip.in && t.word.start < clip.out)
        .map((t, i) => ({ ...t, i }));
      removedFillers += tokens.filter(
        (t) => t.removed === "filler" || t.removed === "contextual-filler",
      ).length;
      removedRepeats += tokens.filter((t) => t.removed === "repeat").length;
      const plan = planClips({
        tokens,
        durationS: Math.min(clip.out, source.durationS ?? clip.out),
        profile: ctx.profile,
        fps,
        startFrame: at,
        beatFrames: beats,
        framingIndex,
      });
      framingIndex = plan.framingIndex;
      let kept = 0;
      for (const [j, p] of plan.clips.entries()) {
        clips.push({
          id: `${clip.id}-${String(j + 1).padStart(3, "0")}`,
          source: clip.source,
          in: Math.round(p.in * 1e6) / 1e6,
          out: Math.round(p.out * 1e6) / 1e6,
          at,
          transform: { scale: p.scale, x: 0, y: 0 },
          why: { kind: p.kind, wordIds: p.wordIds, ...(p.note ? { note: p.note } : {}) },
        });
        at += p.frames;
        kept += p.out - p.in;
      }
      removedS += clip.out - clip.in - kept;
    }

    const totalS = framesToSeconds(at, fps);
    const audio = edl.audio.map((track) => ({
      ...track,
      clips: track.clips
        .filter((c) => c.at < at)
        .map((c) => ({ ...c, out: Math.min(c.out, c.in + totalS - framesToSeconds(c.at, fps)) })),
    }));
    if (hallucinated > 0)
      diagnostics.push({
        level: "warning",
        code: "cut.hallucination",
        message: `${hallucinated} mot(s) transcrit(s) sans voix détectée ignorés (hallucinations de l'ASR)`,
      });
    diagnostics.push({
      level: "info",
      code: "cut.summary",
      message: `${removedFillers} hésitation(s) et ${removedRepeats} mot(s) de faux départ retirés, ${removedS.toFixed(1)} s coupées, ${clips.length} plan(s)`,
    });
    return {
      edl: EdlSchema.parse({ ...edl, video: [{ ...main, clips }, ...edl.video.slice(1)], audio }),
      diagnostics,
    };
  },
};
