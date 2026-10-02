import { timelineWords } from "@cutkiller/captions";
import {
  type Diagnostic,
  type Duck,
  type Edl,
  type EdlInput,
  EdlSchema,
  edlDurationFrames,
  type Pass,
  type PassContext,
  sortedClips,
} from "@cutkiller/core";
import { TransitionParamsSchema } from "@cutkiller/motion";
import { SfxParamsSchema, sfxTiming } from "./sfx";

type AudioClipInput = EdlInput["audio"] extends (infer T)[] | undefined
  ? T extends { clips: (infer C)[] }
    ? C
    : never
  : never;

/** Speech on the timeline, in frames: words of the edit, pauses shorter than `gap` merged. */
export function speechRegions(edl: Edl, ctx: PassContext, gapFrames: number): [number, number][] {
  const regions: [number, number][] = [];
  for (const w of timelineWords(edl, ctx.analysis.transcripts)) {
    if (!/[\p{L}\p{N}]/u.test(w.text)) continue;
    const last = regions.at(-1);
    if (last && w.fromFrame - last[1] <= gapFrames) last[1] = Math.max(last[1], w.toFrame);
    else regions.push([w.fromFrame, w.toFrame]);
  }
  return regions;
}

/** A sound effect whose hit lands exactly on `syncFrame` (the sound is trimmed rather than shifted). */
function sfxClip(
  id: string,
  ref: string,
  ctx: PassContext,
  syncFrame: number,
  syncTo: string,
  fps: number,
  total: number,
  gainDb: number,
): AudioClipInput | undefined {
  const preset = ctx.presets?.resolve(ref);
  if (!preset) return undefined;
  const { hitS, lengthS } = sfxTiming(SfxParamsSchema.parse(preset.params));
  const at = Math.max(0, Math.ceil(syncFrame - hitS * fps - 1e-9));
  const inS = hitS - (syncFrame - at) / fps;
  const outS = Math.min(lengthS, inS + (total - at) / fps);
  if (inS < 0 || outS - inS < 1 / fps) return undefined;
  return {
    id,
    asset: `${preset.name}@${preset.version}`,
    in: Math.round(inS * 1e6) / 1e6,
    out: Math.round(outS * 1e6) / 1e6,
    at,
    gainDb,
    syncTo,
    why: { kind: "sfx", note: `impact sur la frame ${syncFrame}` },
  };
}

/**
 * Passe « audio » :
 * - cibles de mixage dans l'EDL (loudness intégrée, true peak, niveau de la musique sous la voix) ;
 * - ducking de chaque musique sous la parole, rampes douces, pauses courtes fusionnées ;
 * - effets sonores procéduraux calés à l'impact sur les transitions et les punch-ins.
 */
export const audioPass: Pass = {
  id: "audio",
  run(edl: Edl, ctx: PassContext) {
    const a = ctx.profile.audio;
    const fps = edl.output.fps;
    const total = edlDurationFrames(edl);
    const diagnostics: Diagnostic[] = [];
    const output = {
      ...edl.output,
      audio: {
        ...edl.output.audio,
        targetLufs: a.integratedLufs,
        truePeakDbtp: a.renderTruePeakDbtp,
        musicBedLu: a.musicBedLu,
        voiceCompression: a.voiceCompression,
      },
    };

    // Ducking: every source clip of the audio tracks (music) goes down under speech.
    const regions = speechRegions(edl, ctx, Math.round((a.duck.mergeGapMs / 1000) * fps));
    const hold = Math.round((a.duck.holdMs / 1000) * fps);
    let ducks = 0;
    const audio: EdlInput["audio"] = edl.audio.map((track) => ({
      ...track,
      clips: track.clips.map((clip) => {
        if (clip.source === undefined) return clip;
        const start = clip.at;
        const end = clip.at + Math.round((clip.out - clip.in) * fps);
        const duck: Duck[] = regions
          .filter(([from, to]) => to + hold > start && from < end)
          .map(([from, to]) => ({
            fromFrame: Math.max(start, from),
            toFrame: Math.min(end, to + hold),
            depthDb: a.duck.depthDb,
            attackMs: a.duck.attackMs,
            releaseMs: a.duck.releaseMs,
          }));
        ducks += duck.length;
        return { ...clip, duck };
      }),
    }));

    // Sound effects, on as many tracks as needed so that none overlaps.
    const events: { ref: string; frame: number; syncTo: string }[] = [];
    for (const t of edl.transitions) {
      const preset = ctx.presets?.resolve(t.preset);
      const type = preset ? TransitionParamsSchema.parse(preset.params).type : undefined;
      const ref = type ? a.sfx.transitions[type] : undefined;
      if (ref) events.push({ ref, frame: t.atFrame, syncTo: `transition:${t.id}` });
    }
    if (a.sfx.punchIn)
      for (const k of edl.keyframes)
        if (k.role === "micro" && k.why?.kind === "emphasis" && k.keys[0])
          events.push({ ref: a.sfx.punchIn, frame: k.keys[0].frame, syncTo: `keyframes:${k.target}` });
    events.sort((x, y) => x.frame - y.frame);
    const sfxTracks: { id: string; clips: AudioClipInput[]; end: number }[] = [];
    let n = 0;
    for (const e of events) {
      const clip = sfxClip(
        `fx${String(++n).padStart(3, "0")}`,
        e.ref,
        ctx,
        e.frame,
        e.syncTo,
        fps,
        total,
        a.sfx.gainDb,
      );
      if (!clip) continue;
      const end = clip.at + Math.round((clip.out - clip.in) * fps);
      let track = sfxTracks.find((t) => t.end <= clip.at);
      if (!track) {
        track = { id: `sfx${sfxTracks.length + 1}`, clips: [], end: 0 };
        sfxTracks.push(track);
      }
      track.clips.push(clip);
      track.end = end;
    }
    const kept = audio.filter((t) => !/^sfx\d+$/.test(t.id));
    for (const t of sfxTracks) kept.push({ id: t.id, clips: t.clips });

    diagnostics.push({
      level: "info",
      code: "audio.summary",
      message: `${ducks} zone(s) de ducking, ${sfxTracks.reduce((s, t) => s + t.clips.length, 0)} SFX, cible ${a.integratedLufs} LUFS`,
    });
    return { edl: EdlSchema.parse({ ...edl, output, audio: kept }), diagnostics };
  },
};
