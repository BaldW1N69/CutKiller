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
  tr,
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
        voiceCleanup: a.voiceCleanup,
      },
    };

    const balanced = balanceDialogue(edl, ctx);
    for (const [source, g] of balanced)
      diagnostics.push({
        level: "info",
        code: "audio.dialogue-balance",
        message: tr(
          `dialogue of « ${source} » ${g > 0 ? "+" : ""}${g.toFixed(1)} dB to match the other rushes`,
          `dialogue de « ${source} » ${g > 0 ? "+" : ""}${g.toFixed(1)} dB pour égaler les autres rushes`,
        ),
      });
    const video = edl.video.map((track, t) =>
      t === 0
        ? {
            ...track,
            clips: track.clips.map((c) =>
              balanced.has(c.source) && c.gainDb === 0
                ? { ...c, gainDb: balanced.get(c.source) as number }
                : c,
            ),
          }
        : track,
    );

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
    // Changes of section: the first shot of each editorial selection after the first.
    if (a.sfx.sectionChange.length > 0)
      for (const c of edl.video[0]?.clips ?? []) {
        const m = /^s(\d+)-001$/.exec(c.id);
        if (m && Number(m[1]) > 1)
          for (const ref of a.sfx.sectionChange) events.push({ ref, frame: c.at, syncTo: `cut:${c.id}` });
      }
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
      message: tr(
        `${ducks} ducking zone(s), ${sfxTracks.reduce((s, t) => s + t.clips.length, 0)} SFX, target ${a.integratedLufs} LUFS`,
        `${ducks} zone(s) de ducking, ${sfxTracks.reduce((s, t) => s + t.clips.length, 0)} SFX, cible ${a.integratedLufs} LUFS`,
      ),
    });
    return { edl: EdlSchema.parse({ ...edl, output, video, audio: kept }), diagnostics };
  },
};

/**
 * Gain per rush that brings each one's speech level (analysis: 90th percentile
 * of 10 ms frames) to the median of the rushes speaking on the main track.
 * Only gains of 1 dB or more, at most the profile's maximum.
 */
export function balanceDialogue(edl: Edl, ctx: PassContext): Map<string, number> {
  const cfg = ctx.profile.audio.dialogueBalance;
  const out = new Map<string, number>();
  if (!cfg.enabled) return out;
  const sources = [...new Set((edl.video[0]?.clips ?? []).map((c) => c.source))].filter(
    (s) =>
      (ctx.analysis.transcripts?.[s]?.words.length ?? 0) > 0 && ctx.analysis.vad?.[s]?.speechDb !== undefined,
  );
  if (sources.length < 2) return out;
  const levels = sources.map((s) => ctx.analysis.vad?.[s]?.speechDb as number);
  const sorted = [...levels].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  const median =
    sorted.length % 2
      ? (sorted[Math.floor(mid)] as number)
      : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  sources.forEach((s, i) => {
    const g = Math.max(-cfg.maxGainDb, Math.min(cfg.maxGainDb, median - (levels[i] as number)));
    if (Math.abs(g) >= 1) out.set(s, Math.round(g * 10) / 10);
  });
  return out;
}
