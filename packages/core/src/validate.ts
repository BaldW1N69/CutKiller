import type { z } from "zod";
import { isLinearEase } from "./ease";
import { type Edl, EdlSchema, SPATIAL_PROPERTIES } from "./edl";
import { tr } from "./i18n";
import { clipEnd, clipFrames, mainAudioSpans, sortedClips } from "./timeline";

export interface Diagnostic {
  level: "error" | "warning" | "info";
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
    if (clipIds.has(id))
      err("id.duplicate", tr(`duplicate clip id « ${id} »`, `identifiant de clip dupliqué « ${id} »`), path);
    clipIds.set(id, path);
  };

  const checkSourceRange = (sourceId: string, inS: number, outS: number, path: string) => {
    const source = edl.sources[sourceId];
    if (!source)
      return err(
        "source.unknown",
        tr(`unknown source « ${sourceId} »`, `source inconnue « ${sourceId} »`),
        path,
      );
    if (inS < 0)
      err(
        "source.range",
        tr(`negative in point (${inS.toFixed(3)} s)`, `point d'entrée négatif (${inS.toFixed(3)} s)`),
        path,
      );
    if (source.durationS !== undefined && !source.still && outS > source.durationS + 1e-3)
      err(
        "source.range",
        tr(
          `out point ${outS.toFixed(3)} s beyond the source (${source.durationS} s)`,
          `point de sortie ${outS.toFixed(3)} s au-delà de la source (${source.durationS} s)`,
        ),
        path,
      );
  };

  edl.video.forEach((track, t) => {
    const clips = sortedClips(track.clips);
    clips.forEach((clip, i) => {
      const path = `video.${t}.${clip.id}`;
      checkId(clip.id, path);
      if (clip.out <= clip.in) err("clip.empty", tr("out must be > in", "out doit être > in"), path);
      else if (clipFrames(clip, fps) < 1) err("clip.empty", "clip plus court qu'une frame", path);
      checkSourceRange(clip.source, clip.in, clip.out, path);
      const prev = clips[i - 1];
      if (prev && clipEnd(prev, fps) > clip.at)
        err(
          "track.overlap",
          tr(
            `overlaps « ${prev.id} » on track ${track.id}`,
            `chevauche « ${prev.id} » sur la piste ${track.id}`,
          ),
          path,
        );
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
        err(
          "split.orphan",
          tr(
            "a J/L cut needs a contiguous previous clip on the main track",
            "un J/L cut exige un clip précédent contigu sur la piste principale",
          ),
          path,
        );
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
      if (clip.out <= clip.in) err("clip.empty", tr("out must be > in", "out doit être > in"), path);
      if ((clip.source === undefined) === (clip.asset === undefined))
        err("audio.source", "un clip audio a soit une source, soit un asset (SFX)", path);
      if (clip.source !== undefined) checkSourceRange(clip.source, clip.in, clip.out, path);
      const prev = clips[i - 1];
      if (prev && clipEnd(prev, fps) > clip.at)
        err(
          "track.overlap",
          tr(
            `overlaps « ${prev.id} » on track ${track.id}`,
            `chevauche « ${prev.id} » sur la piste ${track.id}`,
          ),
          path,
        );
      for (const d of clip.duck)
        if (d.toFrame < d.fromFrame) err("audio.duck", "ducking : toFrame < fromFrame", path);
    });
  });

  const spans = new Map<string, { at: number; end: number }>();
  for (const track of edl.video)
    for (const c of track.clips) spans.set(c.id, { at: c.at, end: clipEnd(c, fps) });

  edl.keyframes.forEach((track, k) => {
    const path = `keyframes.${k}`;
    const dot = track.target.lastIndexOf(".");
    const clipId = track.target.slice(0, dot);
    const prop = track.target.slice(dot + 1);
    if (!clipIds.has(clipId))
      err(
        "keyframes.target",
        tr(`unknown target clip « ${clipId} »`, `clip cible inconnu « ${clipId} »`),
        path,
      );
    const span = spans.get(clipId);
    const first = track.keys[0]?.frame ?? 0;
    const last = track.keys.at(-1)?.frame ?? 0;
    if (span && (first < span.at || last > span.end))
      err(
        "keyframes.range",
        tr(
          `animation outside clip « ${clipId} » (frames ${span.at}–${span.end})`,
          `animation hors du clip « ${clipId} » (frames ${span.at}–${span.end})`,
        ),
        path,
      );
    track.keys.forEach((key, i) => {
      const prev = track.keys[i - 1];
      if (prev && key.frame <= prev.frame)
        err("keyframes.order", "frames de keyframes non croissantes", path);
      if (i > 0 && SPATIAL_PROPERTIES.has(prop) && isLinearEase(key.ease))
        err(
          "motion.linear",
          tr(
            `linear interpolation not allowed on « ${prop} » (key ${i}): use an easing or a spring`,
            `interpolation linéaire interdite sur « ${prop} » (clé ${i}) : utiliser un easing ou un spring`,
          ),
          `${path}.keys.${i}`,
        );
    });
  });

  // Transitions sit on a cut of the main track and fit inside both clips.
  const main = sortedClips(edl.video[0]?.clips ?? []);
  let lastEnd = -1;
  for (const [k, t] of [...edl.transitions].sort((a, b) => a.atFrame - b.atFrame).entries()) {
    const path = `transitions.${k}`;
    const idx = main.findIndex((c) => c.at === t.atFrame);
    const prev = main[idx - 1];
    const next = main[idx];
    if (idx < 1 || !prev || !next || clipEnd(prev, fps) !== next.at) {
      err(
        "transition.cut",
        tr(
          `transition « ${t.id} » is not on a cut of the main track`,
          `la transition « ${t.id} » n'est pas sur une coupe de la piste principale`,
        ),
        path,
      );
      continue;
    }
    const half = Math.ceil(t.durationFrames / 2);
    if (half > clipFrames(prev, fps) || half > clipFrames(next, fps))
      err(
        "transition.range",
        tr(
          `transition « ${t.id} » longer than the clips it joins`,
          `transition « ${t.id} » plus longue que les clips qu'elle relie`,
        ),
        path,
      );
    if (t.atFrame - half < lastEnd)
      err(
        "transition.overlap",
        tr(
          `transition « ${t.id} » overlaps the previous one`,
          `la transition « ${t.id} » chevauche la précédente`,
        ),
        path,
      );
    lastEnd = t.atFrame + half;
  }

  // Moving framing: keys inside the clip, positions inside the source.
  for (const track of edl.video)
    for (const clip of track.clips) {
      if (!clip.reframe) continue;
      const path = `video.${clip.id}.reframe`;
      const end = clipEnd(clip, fps);
      for (const k of clip.reframe.keys) {
        if (k.frame < clip.at || k.frame > end)
          err(
            "reframe.range",
            tr(`reframe key outside clip « ${clip.id} »`, `clé de recadrage hors du clip « ${clip.id} »`),
            path,
          );
        if (k.value < 0 || k.value > 1)
          err(
            "reframe.range",
            tr("reframe position outside the source (0–1)", "position de recadrage hors de la source (0–1)"),
            path,
          );
        if (isLinearEase(k.ease) && k !== clip.reframe.keys[0])
          err(
            "motion.linear",
            tr(
              `reframe of « ${clip.id} » uses linear interpolation`,
              `recadrage de « ${clip.id} » en interpolation linéaire`,
            ),
            path,
          );
      }
    }

  // Captions: in order, never overlapping, words inside their caption and in spoken order.
  let captionEnd = 0;
  edl.captions.forEach((c, k) => {
    const path = `captions.${k}`;
    if (c.toFrame <= c.fromFrame)
      err("captions.range", tr(`empty caption « ${c.id} »`, `sous-titre « ${c.id} » vide`), path);
    if (c.fromFrame < captionEnd)
      err(
        "captions.overlap",
        tr(
          `caption « ${c.id} » overlaps the previous one`,
          `le sous-titre « ${c.id} » chevauche le précédent`,
        ),
        path,
      );
    captionEnd = Math.max(captionEnd, c.toFrame);
    let prevFrom = -1;
    let prevLine = 0;
    c.words.forEach((w, i) => {
      const wpath = `${path}.words.${i}`;
      if (w.fromFrame < c.fromFrame || w.fromFrame >= c.toFrame || w.toFrame <= w.fromFrame)
        err(
          "captions.word-range",
          tr(
            `word « ${w.text} » outside its caption « ${c.id} »`,
            `mot « ${w.text} » hors de son sous-titre « ${c.id} »`,
          ),
          wpath,
        );
      if (w.fromFrame < prevFrom)
        err(
          "captions.word-order",
          tr(`words of caption « ${c.id} » out of order`, `mots du sous-titre « ${c.id} » dans le désordre`),
          wpath,
        );
      if (w.line < prevLine || w.line > prevLine + 1)
        err(
          "captions.lines",
          tr(
            `lines of caption « ${c.id} » not consecutive`,
            `lignes du sous-titre « ${c.id} » non consécutives`,
          ),
          wpath,
        );
      prevFrom = w.fromFrame;
      prevLine = w.line;
    });
    if ((c.words[0]?.line ?? 0) !== 0)
      err(
        "captions.lines",
        tr(
          `caption « ${c.id} » must start on line 0`,
          `le sous-titre « ${c.id} » doit commencer à la ligne 0`,
        ),
        path,
      );
  });

  return out;
}
