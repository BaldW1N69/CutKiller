import type { z } from "zod";
import { isLinearEase } from "./ease";
import { type Edl, EdlSchema, SPATIAL_PROPERTIES } from "./edl";
import { clipEnd, clipFrames, mainAudioSpans, sortedClips } from "./timeline";

export interface Diagnostic {
  level: "error" | "warning";
  code: string;
  message: string;
  path?: string;
}

export type ParseResult =
  | { ok: true; edl: Edl; diagnostics: Diagnostic[] }
  | { ok: false; diagnostics: Diagnostic[] };

/** Schema parse + semantic invariants. An EDL with any error must not be rendered. */
export function parseEdl(input: unknown): ParseResult {
  const parsed = EdlSchema.safeParse(input);
  if (!parsed.success) return { ok: false, diagnostics: zodDiagnostics(parsed.error) };
  const diagnostics = validateEdl(parsed.data);
  if (diagnostics.some((d) => d.level === "error")) return { ok: false, diagnostics };
  return { ok: true, edl: parsed.data, diagnostics };
}

function zodDiagnostics(error: z.ZodError): Diagnostic[] {
  return error.issues.map((issue) => ({
    level: "error",
    code: `schema.${issue.code}`,
    message: issue.message,
    path: issue.path.join("."),
  }));
}

export function validateEdl(edl: Edl): Diagnostic[] {
  const out: Diagnostic[] = [];
  const err = (code: string, message: string, path?: string) =>
    out.push({ level: "error", code, message, ...(path ? { path } : {}) });
  const fps = edl.output.fps;
  const clipIds = new Map<string, string>();

  const checkId = (id: string, path: string) => {
    if (clipIds.has(id)) err("id.duplicate", `identifiant de clip dupliqué « ${id} »`, path);
    clipIds.set(id, path);
  };

  const checkSourceRange = (sourceId: string, inS: number, outS: number, path: string) => {
    const source = edl.sources[sourceId];
    if (!source) return err("source.unknown", `source inconnue « ${sourceId} »`, path);
    if (inS < 0) err("source.range", `point d'entrée négatif (${inS.toFixed(3)} s)`, path);
    if (source.durationS !== undefined && !source.still && outS > source.durationS + 1e-3)
      err(
        "source.range",
        `point de sortie ${outS.toFixed(3)} s au-delà de la source (${source.durationS} s)`,
        path,
      );
  };

  edl.video.forEach((track, t) => {
    const clips = sortedClips(track.clips);
    clips.forEach((clip, i) => {
      const path = `video.${t}.${clip.id}`;
      checkId(clip.id, path);
      if (clip.out <= clip.in) err("clip.empty", "out doit être > in", path);
      else if (clipFrames(clip, fps) < 1) err("clip.empty", "clip plus court qu'une frame", path);
      checkSourceRange(clip.source, clip.in, clip.out, path);
      const prev = clips[i - 1];
      if (prev && clipEnd(prev, fps) > clip.at)
        err("track.overlap", `chevauche « ${prev.id} » sur la piste ${track.id}`, path);
      if (t === 0) {
        const expectedStart = prev ? clipEnd(prev, fps) : 0;
        if (clip.at > expectedStart)
          err(
            "track.gap",
            `trou de ${clip.at - expectedStart} frame(s) sur la piste principale (frames noires)`,
            path,
          );
      }
      if (clip.audioSplitFrames !== 0 && (t !== 0 || !prev || clipEnd(prev, fps) !== clip.at))
        err("split.orphan", "un J/L cut exige un clip précédent contigu sur la piste principale", path);
    });
  });

  for (const span of mainAudioSpans(edl)) {
    const path = `video.0.${span.clip.id}`;
    if (span.endFrame <= span.startFrame) err("split.range", "J/L cut plus long que le clip", path);
    checkSourceRange(span.clip.source, span.sourceIn, span.sourceOut, `${path}.audio`);
  }

  edl.audio.forEach((track, t) => {
    const clips = sortedClips(track.clips);
    clips.forEach((clip, i) => {
      const path = `audio.${t}.${clip.id}`;
      checkId(clip.id, path);
      if (clip.out <= clip.in) err("clip.empty", "out doit être > in", path);
      checkSourceRange(clip.source, clip.in, clip.out, path);
      const prev = clips[i - 1];
      if (prev && clipEnd(prev, fps) > clip.at)
        err("track.overlap", `chevauche « ${prev.id} » sur la piste ${track.id}`, path);
    });
  });

  edl.keyframes.forEach((track, k) => {
    const path = `keyframes.${k}`;
    const dot = track.target.lastIndexOf(".");
    const clipId = track.target.slice(0, dot);
    const prop = track.target.slice(dot + 1);
    if (!clipIds.has(clipId)) err("keyframes.target", `clip cible inconnu « ${clipId} »`, path);
    track.keys.forEach((key, i) => {
      const prev = track.keys[i - 1];
      if (prev && key.frame <= prev.frame)
        err("keyframes.order", "frames de keyframes non croissantes", path);
      if (i > 0 && SPATIAL_PROPERTIES.has(prop) && isLinearEase(key.ease))
        err(
          "motion.linear",
          `interpolation linéaire interdite sur « ${prop} » (clé ${i}) : utiliser un easing ou un spring`,
          `${path}.keys.${i}`,
        );
    });
  });

  return out;
}
