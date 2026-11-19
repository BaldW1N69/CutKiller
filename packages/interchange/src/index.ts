/**
 * Hand-off to professional editors: the EDL as an OpenTimelineIO timeline
 * (DaVinci Resolve, Avid, Nuke, Hiero, OTIO adapters for Premiere/FCP) and as a
 * Final Cut Pro 7 XML (xmeml v5: Premiere Pro, DaVinci Resolve, Final Cut Pro 7).
 *
 * What travels: every cut of every video track (source in/out at frame
 * accuracy), the rushes' own audio under the main track, music clips with their
 * gain and fades, static punch-ins (scale), and one marker per edit decision
 * (« cut before: « um » (filler) »). What does not: animated keyframes, grading,
 * captions (use the .srt written next to the render) and synthesized SFX
 * (markers at their impact frames): the editor finishes those by hand.
 */
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AudioClip, Edl, VideoClip } from "@cutkiller/core";

export interface ExportOptions {
  /** Directory the EDL's relative source paths are relative to. */
  baseDir: string;
  title?: string;
}

interface Placed {
  name: string;
  /** Absolute path of the media, undefined for generated sounds. */
  path?: string;
  /** Timeline start and length, output frames. */
  at: number;
  frames: number;
  /** Source start, output frames (sources are conformed to the output rate). */
  inFrame: number;
  /** Total source length, output frames. */
  sourceFrames?: number;
  scale?: number;
  gainDb?: number;
  note?: string;
}

const clipFrames = (c: { in: number; out: number }, fps: number) => Math.round((c.out - c.in) * fps);

function placedVideo(edl: Edl, opts: ExportOptions, c: VideoClip): Placed {
  const fps = edl.output.fps;
  const src = edl.sources[c.source];
  const path = src ? (isAbsolute(src.path) ? src.path : resolve(opts.baseDir, src.path)) : undefined;
  return {
    name: c.id,
    ...(path ? { path } : {}),
    at: c.at,
    frames: clipFrames(c, fps),
    inFrame: Math.round(c.in * fps),
    ...(src?.durationS ? { sourceFrames: Math.round(src.durationS * fps) } : {}),
    scale: c.transform?.scale ?? 1,
    gainDb: c.gainDb ?? 0,
    ...(c.why?.note ? { note: c.why.note } : {}),
  };
}

function placedAudio(edl: Edl, opts: ExportOptions, c: AudioClip): Placed | undefined {
  if (!c.source) return undefined;
  const fps = edl.output.fps;
  const src = edl.sources[c.source];
  if (!src) return undefined;
  return {
    name: c.id,
    path: isAbsolute(src.path) ? src.path : resolve(opts.baseDir, src.path),
    at: c.at,
    frames: clipFrames(c, fps),
    inFrame: Math.round(c.in * fps),
    ...(src.durationS ? { sourceFrames: Math.round(src.durationS * fps) } : {}),
    gainDb: c.gainDb ?? 0,
  };
}

/** Timeline markers: one per edit decision with a reason, one per generated sound effect. */
export function editMarkers(edl: Edl): { frame: number; name: string }[] {
  const out: { frame: number; name: string }[] = [];
  for (const c of edl.video[0]?.clips ?? []) if (c.why?.note) out.push({ frame: c.at, name: c.why.note });
  for (const t of edl.audio)
    for (const c of t.clips) if (c.asset) out.push({ frame: c.at, name: `SFX ${c.asset}` });
  return out.sort((a, b) => a.frame - b.frame);
}

/** Total timeline length in frames. */
export function timelineFrames(edl: Edl): number {
  let end = 0;
  for (const t of edl.video)
    for (const c of t.clips) end = Math.max(end, c.at + clipFrames(c, edl.output.fps));
  return end;
}

// ───────────────────────────── OpenTimelineIO ─────────────────────────────

const rt = (value: number, rate: number) => ({ OTIO_SCHEMA: "RationalTime.1", rate, value });
const range = (start: number, duration: number, rate: number) => ({
  OTIO_SCHEMA: "TimeRange.1",
  start_time: rt(start, rate),
  duration: rt(duration, rate),
});

function otioTrack(name: string, kind: "Video" | "Audio", clips: Placed[], rate: number) {
  const children: unknown[] = [];
  let cursor = 0;
  for (const p of [...clips].sort((a, b) => a.at - b.at)) {
    if (p.at > cursor)
      children.push({
        OTIO_SCHEMA: "Gap.1",
        name: "",
        source_range: range(0, p.at - cursor, rate),
        effects: [],
        markers: [],
        metadata: {},
      });
    children.push({
      OTIO_SCHEMA: "Clip.2",
      name: p.name,
      source_range: range(p.inFrame, p.frames, rate),
      media_references: {
        DEFAULT_MEDIA: p.path
          ? {
              OTIO_SCHEMA: "ExternalReference.1",
              name: p.path.split("/").pop() ?? p.name,
              target_url: pathToFileURL(p.path).href,
              available_range: p.sourceFrames ? range(0, p.sourceFrames, rate) : null,
              available_image_bounds: null,
              metadata: {},
            }
          : {
              OTIO_SCHEMA: "MissingReference.1",
              name: p.name,
              available_range: null,
              available_image_bounds: null,
              metadata: {},
            },
      },
      active_media_reference_key: "DEFAULT_MEDIA",
      effects: [],
      markers: [],
      enabled: true,
      metadata: { cutkiller: { scale: p.scale, gainDb: p.gainDb, ...(p.note ? { note: p.note } : {}) } },
    });
    cursor = Math.max(cursor, p.at + p.frames);
  }
  return {
    OTIO_SCHEMA: "Track.1",
    name,
    kind,
    source_range: null,
    children,
    effects: [],
    markers: [],
    enabled: true,
    metadata: {},
  };
}

export function toOtio(edl: Edl, opts: ExportOptions): string {
  const rate = edl.output.fps;
  const video = edl.video.map((t, i) =>
    otioTrack(
      `V${i + 1}`,
      "Video",
      t.clips.map((c) => placedVideo(edl, opts, c)),
      rate,
    ),
  );
  const sourceAudio = otioTrack(
    "A1",
    "Audio",
    (edl.video[0]?.clips ?? [])
      .filter((c) => edl.sources[c.source]?.hasAudio)
      .map((c) => placedVideo(edl, opts, c)),
    rate,
  );
  const extra = edl.audio
    .map((t) => ({ t, clips: t.clips.flatMap((c) => placedAudio(edl, opts, c) ?? []) }))
    .filter((x) => x.clips.length > 0)
    .map((x, i) => otioTrack(`A${i + 2} ${x.t.id}`, "Audio", x.clips, rate));
  const markers = editMarkers(edl).map((m) => ({
    OTIO_SCHEMA: "Marker.2",
    name: m.name,
    marked_range: range(m.frame, 0, rate),
    color: "RED",
    comment: "",
    metadata: {},
  }));
  const timeline = {
    OTIO_SCHEMA: "Timeline.1",
    name: opts.title ?? edl.meta.title ?? "CutKiller edit",
    global_start_time: rt(0, rate),
    tracks: {
      OTIO_SCHEMA: "Stack.1",
      name: "tracks",
      source_range: null,
      children: [...video, sourceAudio, ...extra],
      effects: [],
      markers,
      enabled: true,
      metadata: {},
    },
    metadata: { cutkiller: { edlVersion: edl.version, profile: edl.meta.profile ?? null } },
  };
  return `${JSON.stringify(timeline, null, 2)}\n`;
}

// ───────────────────────── Final Cut Pro 7 XML (xmeml) ─────────────────────────

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** xmeml rate: integer timebase plus NTSC flag (29.97 → 30 + TRUE). */
function xRate(fps: number): string {
  const timebase = Math.round(fps);
  const ntsc = Math.abs(fps - timebase) > 0.001 ? "TRUE" : "FALSE";
  return `<rate><timebase>${timebase}</timebase><ntsc>${ntsc}</ntsc></rate>`;
}

export function toFcp7Xml(edl: Edl, opts: ExportOptions): string {
  const fps = edl.output.fps;
  const { width, height } = edl.output;
  const total = timelineFrames(edl);
  const files = new Map<string, string>();
  const fileRef = (p: Placed, kind: "video" | "audio"): string => {
    if (!p.path) return "";
    const known = files.get(p.path);
    if (known) return `<file id="${known}"/>`;
    const id = `file-${files.size + 1}`;
    files.set(p.path, id);
    const media =
      kind === "video"
        ? `<media><video><samplecharacteristics>${xRate(fps)}<width>${width}</width><height>${height}</height></samplecharacteristics></video><audio><channelcount>2</channelcount></audio></media>`
        : "<media><audio><channelcount>2</channelcount></audio></media>";
    return `<file id="${id}"><name>${esc(p.path.split("/").pop() ?? id)}</name><pathurl>${esc(pathToFileURL(p.path).href)}</pathurl>${xRate(fps)}${p.sourceFrames ? `<duration>${p.sourceFrames}</duration>` : ""}${media}</file>`;
  };
  let n = 0;
  const clipitem = (p: Placed, kind: "video" | "audio") => {
    n++;
    const motion =
      kind === "video" && p.scale && p.scale !== 1
        ? `<filter><effect><name>Basic Motion</name><effectid>basic</effectid><effectcategory>motion</effectcategory><effecttype>motion</effecttype><mediatype>video</mediatype><parameter><parameterid>scale</parameterid><name>Scale</name><value>${(p.scale * 100).toFixed(2)}</value></parameter></effect></filter>`
        : "";
    const level =
      kind === "audio" && p.gainDb
        ? `<filter><effect><name>Audio Levels</name><effectid>audiolevels</effectid><effectcategory>audiolevels</effectcategory><effecttype>audiolevels</effecttype><mediatype>audio</mediatype><parameter><parameterid>level</parameterid><name>Level</name><value>${(10 ** (p.gainDb / 20)).toFixed(4)}</value></parameter></effect></filter>`
        : "";
    return `<clipitem id="clipitem-${n}"><name>${esc(p.name)}</name><enabled>TRUE</enabled><duration>${p.sourceFrames ?? p.inFrame + p.frames}</duration>${xRate(fps)}<start>${p.at}</start><end>${p.at + p.frames}</end><in>${p.inFrame}</in><out>${p.inFrame + p.frames}</out>${fileRef(p, kind)}${motion}${level}</clipitem>`;
  };
  const vtracks = edl.video
    .map((t) => `<track>${t.clips.map((c) => clipitem(placedVideo(edl, opts, c), "video")).join("")}</track>`)
    .join("");
  const main = (edl.video[0]?.clips ?? [])
    .filter((c) => edl.sources[c.source]?.hasAudio)
    .map((c) => placedVideo(edl, opts, c));
  const atracks = [
    `<track>${main.map((p) => clipitem(p, "audio")).join("")}</track>`,
    ...edl.audio
      .map((t) => t.clips.flatMap((c) => placedAudio(edl, opts, c) ?? []))
      .filter((clips) => clips.length > 0)
      .map((clips) => `<track>${clips.map((p) => clipitem(p, "audio")).join("")}</track>`),
  ].join("");
  const markers = editMarkers(edl)
    .map((m) => `<marker><name>${esc(m.name)}</name><comment/><in>${m.frame}</in><out>-1</out></marker>`)
    .join("");
  const name = esc(opts.title ?? edl.meta.title ?? "CutKiller edit");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="5"><sequence id="sequence-1"><name>${name}</name><duration>${total}</duration>${xRate(fps)}<timecode>${xRate(fps)}<string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode><media><video><format><samplecharacteristics>${xRate(fps)}<width>${width}</width><height>${height}</height><pixelaspectratio>square</pixelaspectratio></samplecharacteristics></format>${vtracks}</video><audio>${atracks}</audio></media>${markers}</sequence></xmeml>
`;
}
