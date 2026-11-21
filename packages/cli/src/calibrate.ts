/**
 * Calibration of the quality check: a clean edit of a talking head with known
 * ground truth, then one deliberate defect per rule, each rendered and checked.
 * A rule is calibrated when it catches its own defect (sensitivity), passes the
 * clean edit (specificity) and stays quiet on the other rules' defects (no cross
 * talk). The defects are defined from the edit, never from the checks' code.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import {
  type Analysis,
  clipEnd,
  clipFrames,
  type Edl,
  EdlSchema,
  parseEdl,
  type StyleProfile,
  sortedClips,
  type VideoClip,
} from "@cutkiller/core";
import { generateFixtures } from "@cutkiller/fixtures";
import { decodeMono, ffmpeg } from "@cutkiller/media";
import {
  type CheckResult,
  checkCaptionSyncTruth,
  type Label,
  qualityCheck,
  type Report,
  RULES,
} from "@cutkiller/qa";
import { render } from "@cutkiller/render";
import { loadProfile, type Preset, PresetRegistry } from "@cutkiller/style";
import { plan } from "./pipeline";

export interface Base {
  edl: Edl;
  analysis: Analysis;
  profile: StyleProfile;
  /** Directory the EDL's source paths resolve against. */
  baseDir: string;
  /** Ground-truth word onsets of the talking head's voice (seconds of the source). */
  truth: { text: string; start: number; end: number; filler: boolean }[];
}

export interface Variant {
  id: string;
  /** Rule the defect targets; "control" for a clean case. */
  rule: string;
  /** fail: the rule must catch it; pass: a valid edit the rule must accept; reject: the validator must refuse the EDL. */
  expect: "fail" | "pass" | "reject";
  /** The defect, in words (report). */
  what: string;
  edl?: (edl: Edl, base: Base) => void | Promise<void>;
  registry?: (presets: Preset[]) => Preset[];
  /** Post-processing of the rendered file (in place): defects of the delivered file. */
  post?: (video: string, edl: Edl) => Promise<void>;
  /** Narrower detection than "the rule fails" (e.g. a specific violation). */
  detectedIf?: (result: CheckResult) => boolean;
  /**
   * Other rules this defect legitimately breaks too (a restored pause also leaves a
   * longer shot…): reported as consequences, not as false alarms.
   */
  consequences?: string[];
  /** Checked against the ground truth as a human annotation (no render): the `check --truth` workflow. */
  annotation?: boolean;
}

export interface Outcome {
  id: string;
  rule: string;
  expect: Variant["expect"];
  what: string;
  /** detected / missed / not-evaluated (fail or reject expected); ok / false-alarm (pass expected). */
  verdict: "detected" | "missed" | "not-evaluated" | "ok" | "false-alarm" | "error";
  target?: { status: string; score: number; violations: string[] };
  /** Rules failing here but not on the clean edit (other than the target). */
  crossTalk: { ruleId: string; violation: string; expected: boolean }[];
  score?: number;
  seconds: number;
  error?: string;
}

// ————————————————————————————————————————————— timeline surgery

/** Shifts everything at or after `from` (timeline frames) by `delta` frames. */
export function ripple(edl: Edl, from: number, delta: number): void {
  const at = (f: number) => (f >= from ? f + delta : f);
  for (const track of edl.video)
    for (const c of track.clips) {
      c.at = at(c.at);
      if (c.reframe) for (const k of c.reframe.keys) k.frame = at(k.frame);
    }
  // A synced SFX moves with its event (its own start may lie before the ripple point).
  const event = (syncTo: string) => {
    const [kind, ref] = [syncTo.slice(0, syncTo.indexOf(":")), syncTo.slice(syncTo.indexOf(":") + 1)];
    if (kind === "transition") return edl.transitions.find((t) => t.id === ref)?.atFrame;
    if (kind === "cut") return edl.video[0]?.clips.find((v) => v.id === ref)?.at;
    return edl.keyframes.find((t) => t.target === ref)?.keys[0]?.frame;
  };
  for (const track of edl.audio)
    for (const c of track.clips) {
      const e = c.syncTo ? event(c.syncTo) : undefined;
      c.at = e === undefined ? at(c.at) : e >= from ? c.at + delta : c.at;
      for (const d of c.duck) {
        d.fromFrame = at(d.fromFrame);
        d.toFrame = at(d.toFrame);
      }
    }
  for (const track of edl.keyframes) for (const k of track.keys) k.frame = at(k.frame);
  for (const t of edl.transitions) t.atFrame = at(t.atFrame);
  for (const c of edl.captions) {
    c.fromFrame = at(c.fromFrame);
    c.toFrame = at(c.toFrame);
    for (const w of c.words) {
      w.fromFrame = at(w.fromFrame);
      w.toFrame = at(w.toFrame);
    }
  }
}

/** Moves a main-track clip's out point, rippling the rest of the timeline. */
export function setOut(edl: Edl, clip: VideoClip, out: number): void {
  const fps = edl.output.fps;
  const end = clipEnd(clip, fps);
  const before = clipFrames(clip, fps);
  clip.out = out;
  ripple(edl, end, clipFrames(clip, fps) - before);
}

/** Every caption and highlight `frames` later (kept inside the timeline). */
function delayCaptions(edl: Edl, frames: number): void {
  const end = Math.max(...main(edl).map((c) => clipEnd(c, edl.output.fps)));
  for (const c of edl.captions) {
    c.fromFrame = Math.min(end - 1, c.fromFrame + frames);
    c.toFrame = Math.min(end, c.toFrame + frames);
    for (const w of c.words) {
      w.fromFrame = Math.min(c.toFrame - 1, w.fromFrame + frames);
      w.toFrame = Math.min(c.toFrame, w.toFrame + frames);
    }
  }
}

const main = (edl: Edl) => sortedClips(edl.video[0]?.clips ?? []);

/** Consecutive main-track clips of one source (a jump cut or a zoom cut). */
function pairs(edl: Edl) {
  const clips = main(edl);
  return clips.slice(1).flatMap((cur, k) => {
    const prev = clips[k] as VideoClip;
    return prev.source === cur.source ? [{ prev, cur }] : [];
  });
}

function words(base: Base, source: string) {
  return base.analysis.transcripts?.[source]?.words ?? [];
}

/** Longest silence between words over a stretch of a source (with the words around it). */
function longestPause(base: Base, source: string, from: number, to: number): number {
  const ws = words(base, source).filter((w) => w.end > from - 1 && w.start < to + 1);
  let longest = 0;
  for (let i = 1; i < ws.length; i++)
    longest = Math.max(longest, (ws[i]?.start ?? 0) - (ws[i - 1]?.end ?? 0));
  return longest;
}

const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}']/gu, "");
const isFiller = (base: Base, text: string) =>
  base.profile.montage.fillerWords.map(norm).includes(norm(text));

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`variante inapplicable : ${what}`);
  return value;
}

// ————————————————————————————————————————————— post-processing

async function replaceWith(video: string, args: string[]): Promise<void> {
  const tmp = video.replace(/\.mp4$/, ".post.mp4");
  await ffmpeg(["-v", "error", "-i", video, ...args, "-y", tmp]);
  await rename(tmp, video);
}

const reencodeVideo = (vf: string) => [
  "-vf",
  `${vf},format=yuv420p`,
  "-c:v",
  "libx264",
  "-preset",
  "veryfast",
  "-crf",
  "12",
  "-r",
  "30",
  "-c:a",
  "copy",
];

/**
 * Word-free stretches of a rush (head, pauses, tail), largest first, 80 ms away
 * from any word, joined until `want` frames: picture and room sound without voice.
 */
function silentPieces(edl: Edl, base: Base, source: string, want: number): { in: number; frames: number }[] {
  const fps = edl.output.fps;
  const ws = words(base, source);
  const duration = edl.sources[source]?.durationS ?? 0;
  const bounds = [0, ...ws.flatMap((w) => [w.start, w.end]), duration];
  const gaps: [number, number][] = [];
  for (let i = 0; i + 1 < bounds.length; i += 2) {
    const a = (bounds[i] as number) + (i === 0 ? 0 : 0.08);
    const b = (bounds[i + 1] as number) - (i + 2 === bounds.length ? 0.05 : 0.08);
    if (b - a >= 0.3) gaps.push([a, b]);
  }
  gaps.sort((x, y) => y[1] - y[0] - (x[1] - x[0]));
  const pieces: { in: number; frames: number }[] = [];
  let total = 0;
  for (const [a, b] of gaps) {
    if (total >= want) break;
    const frames = Math.min(want - total, Math.floor((b - a) * fps));
    pieces.push({ in: a, frames });
    total += frames;
  }
  return pieces;
}

// ————————————————————————————————————————————— the defects

export const VARIANTS: Variant[] = [
  { id: "control", rule: "control", expect: "pass", what: "montage propre, sans défaut injecté" },
  {
    id: "silences",
    rule: "montage.silences",
    expect: "fail",
    consequences: ["montage.fillers", "montage.static-shots", "image.reframe"],
    what: "un silence coupé par le montage est remis dans la timeline",
    edl(edl, base) {
      const p = must(
        pairs(edl).find(({ prev, cur }) => longestPause(base, cur.source, prev.out, cur.in) > 0.6),
        "aucun silence coupé de plus de 600 ms",
      );
      setOut(edl, p.prev, p.cur.in);
    },
  },
  {
    id: "fillers",
    rule: "montage.fillers",
    expect: "fail",
    consequences: ["montage.silences", "montage.beat-cuts"],
    what: "une hésitation coupée (« euh ») est remise, entre deux pauses courtes",
    edl(edl, base) {
      const candidates = pairs(edl).filter(({ prev, cur }) =>
        words(base, cur.source).some((w) => isFiller(base, w.text) && w.start >= prev.out && w.end <= cur.in),
      );
      const p = must(
        candidates.sort(
          (a, b) =>
            longestPause(base, a.cur.source, a.prev.out, a.cur.in) -
            longestPause(base, b.cur.source, b.prev.out, b.cur.in),
        )[0],
        "aucune hésitation coupée",
      );
      setOut(edl, p.prev, p.cur.in);
    },
  },
  {
    id: "dialogue-unbalanced",
    rule: "audio.dialogue-balance",
    expect: "fail",
    what: "la seconde moitié des plans vient d'un « second micro » 9 dB plus bas",
    edl(edl) {
      const clips = main(edl);
      const first = clips[0];
      if (!first || clips.length < 4) throw new Error("variante inapplicable : moins de 4 plans");
      const src = edl.sources[first.source];
      if (!src) throw new Error("variante inapplicable : source absente");
      edl.sources["second-mic"] = { ...src };
      for (const c of clips.slice(Math.floor(clips.length / 2))) {
        c.source = "second-mic";
        c.gainDb = -9;
      }
    },
  },
  {
    id: "word-cut",
    rule: "montage.whole-words",
    expect: "fail",
    what: "la fin d'un plan coupe son dernier mot en deux",
    edl(edl, base) {
      const clips = main(edl);
      for (const clip of clips) {
        const last = clip.why?.wordIds?.at(-1);
        const w = last === undefined ? undefined : words(base, clip.source)[last];
        if (!w || w.end - w.start < 0.2 || w.start <= clip.in) continue;
        setOut(edl, clip, (w.start + w.end) / 2);
        return;
      }
      throw new Error("variante inapplicable : aucun plan finissant sur un mot de plus de 200 ms");
    },
  },
  {
    id: "hook-late",
    rule: "montage.hook",
    expect: "fail",
    what: "1,5 s sans voix ajoutées en tête : le premier mot arrive après le seuil du profil",
    edl(edl, base) {
      const first = main(edl)[0];
      if (!first) throw new Error("variante inapplicable : piste vide");
      const fps = edl.output.fps;
      const want = Math.round(1.5 * fps);
      const pieces = silentPieces(edl, base, first.source, want);
      const total = pieces.reduce((n, p) => n + p.frames, 0);
      if (total < want) throw new Error("variante inapplicable : moins de 1,5 s de silence dans le rush");
      ripple(edl, 0, total);
      let at = 0;
      for (const [k, piece] of pieces.entries()) {
        const { reframe: _moving, ...still } = first;
        edl.video[0]?.clips.push({
          ...still,
          id: `hook-pad-${k + 1}`,
          in: piece.in,
          out: piece.in + piece.frames / fps,
          at,
          audioSplitFrames: 0,
          why: { kind: "selection", note: "silent intro (calibration)" },
        });
        at += piece.frames;
      }
    },
  },
  {
    id: "tail-dead-air",
    rule: "montage.tail",
    expect: "fail",
    what: "2,5 s sans voix ajoutées en fin de montage (temps mort après le dernier mot, seuil 1,5 s)",
    edl(edl, base) {
      const clips = main(edl);
      const last = clips.at(-1);
      if (!last) throw new Error("variante inapplicable : piste vide");
      const fps = edl.output.fps;
      const want = Math.round(2.5 * fps);
      const pieces = silentPieces(edl, base, last.source, want);
      const total = pieces.reduce((n, p) => n + p.frames, 0);
      if (total < want) throw new Error("variante inapplicable : moins de 2,5 s de silence dans le rush");
      let at = clipEnd(last, fps);
      for (const [k, piece] of pieces.entries()) {
        const { reframe: _moving, ...still } = last;
        edl.video[0]?.clips.push({
          ...still,
          id: `tail-pad-${k + 1}`,
          in: piece.in,
          out: piece.in + piece.frames / fps,
          at,
          audioSplitFrames: 0,
          why: { kind: "selection", note: "silent ending (calibration)" },
        });
        at += piece.frames;
      }
    },
    consequences: ["montage.static-shots", "montage.silences", "audio.ducking"],
  },
  {
    id: "beat-cuts",
    rule: "montage.beat-cuts",
    expect: "fail",
    consequences: ["montage.silences"],
    what: "une coupe posée sur un beat est retardée de 3 frames (pause plus longue)",
    edl(edl, base) {
      const fps = edl.output.fps;
      const beats = timelineBeatFrames(edl, base);
      const p = must(
        pairs(edl).find(
          ({ prev, cur }) => prev.out !== cur.in && beats.some((b) => Math.abs(b - clipEnd(prev, fps)) <= 1),
        ),
        "aucune coupe sur un beat",
      );
      setOut(edl, p.prev, p.prev.out + 3 / fps);
    },
  },
  {
    id: "jl-ok",
    rule: "montage.jl-cuts",
    expect: "pass",
    consequences: ["montage.silences"],
    what: "témoin : L-cut de 6 frames (dans la plage 4–12)",
    edl(edl) {
      const p = must(pairs(edl).at(-1), "aucune coupe");
      p.cur.audioSplitFrames = 6;
    },
  },
  {
    id: "jl-short",
    rule: "montage.jl-cuts",
    expect: "fail",
    consequences: ["montage.silences"],
    what: "L-cut de 2 frames (sous la plage 4–12)",
    edl(edl) {
      const p = must(pairs(edl).at(-1), "aucune coupe");
      p.cur.audioSplitFrames = 2;
    },
  },
  {
    id: "static-shots",
    rule: "montage.static-shots",
    expect: "fail",
    what: "les premiers plans gardent le même cadrage, sans animation, au-delà de la limite",
    edl(edl, base) {
      const fps = edl.output.fps;
      const clips = main(edl);
      const first = clips[0] as VideoClip;
      const limit = base.profile.montage.maxStaticShotS * fps;
      const same = clips.filter((c) => c.at < limit + 2 * fps);
      for (const c of same) c.transform = { ...first.transform };
      const ids = new Set(same.map((c) => c.id));
      edl.keyframes = edl.keyframes.filter((t) => !ids.has(t.target.slice(0, t.target.lastIndexOf("."))));
      edl.transitions = edl.transitions.filter((t) => t.atFrame > limit + 2 * fps);
      edl.audio = edl.audio.map((tr) => ({
        ...tr,
        clips: tr.clips.filter((c) => !c.syncTo || c.at > limit + 2 * fps),
      }));
    },
  },
  {
    id: "punch-ins",
    rule: "montage.punch-ins",
    expect: "fail",
    what: "un zoom-cut resserré à 125 %",
    edl(edl) {
      const clip = must(
        main(edl).find((c) => c.transform.scale > 1.0001),
        "aucun zoom-cut",
      );
      clip.transform.scale = 1.25;
    },
  },
  {
    id: "no-linear",
    rule: "motion.no-linear",
    expect: "reject",
    what: "un punch-in animé passe en interpolation linéaire",
    edl(edl) {
      const track = must(
        edl.keyframes.find((t) => t.keys.length > 1),
        "aucune animation",
      );
      (track.keys.at(-1) as { ease?: unknown }).ease = "linear";
    },
  },
  {
    id: "durations",
    rule: "motion.durations",
    expect: "fail",
    consequences: ["motion.presets"],
    what: "un punch-in animé dure 600 ms au lieu de 200",
    edl(edl) {
      const track = must(
        edl.keyframes.find((t) => t.role === "micro" && t.keys.length === 2),
        "aucun punch-in animé",
      );
      const last = track.keys[1] as { frame: number };
      last.frame = (track.keys[0]?.frame ?? 0) + 18;
    },
  },
  {
    id: "blur",
    rule: "motion.blur",
    expect: "fail",
    what: "rendu sans flou de mouvement (seuil du moteur porté à 2 000 px/frame)",
    edl(edl) {
      edl.output.motionBlur.thresholdPxPerFrame = 2000;
    },
  },
  {
    id: "overshoot",
    rule: "motion.overshoot",
    expect: "fail",
    what: "le ressort d'un punch-in rebondit de 16 % (amortissement 36 au lieu de 50)",
    edl(edl) {
      const track = must(
        edl.keyframes.find((t) => t.role === "micro" && t.keys.length === 2),
        "aucun punch-in animé",
      );
      const key = track.keys[1] as { ease?: unknown };
      key.ease = { spring: { stiffness: 1310, damping: 36, mass: 1 } };
    },
  },
  {
    id: "presets",
    rule: "motion.presets",
    expect: "fail",
    what: "la bibliothèque reçoit un preset non conforme (zoom-punch@1.1.0 de 600 ms)",
    registry: (presets) => [
      ...presets,
      ...presets
        .filter((p) => p.name === "zoom-punch" && p.version === "1.0.0")
        .map((p) => ({ ...p, version: "1.1.0", params: { ...p.params, durationMs: 600 } })),
    ],
  },
  {
    id: "captions-sync",
    rule: "captions.sync",
    expect: "fail",
    what: "tous les sous-titres arrivent 4 frames en retard",
    edl: (edl) => delayCaptions(edl, 4),
  },
  {
    id: "captions-density",
    rule: "captions.density",
    expect: "fail",
    what: "deux écrans fusionnés : plus de 3 mots à l'écran en format court",
    edl(edl) {
      const [a, b] = edl.captions;
      if (!a || !b) throw new Error("variante inapplicable : moins de deux sous-titres");
      a.toFrame = b.toFrame;
      a.words = [...a.words, ...b.words.map((w) => ({ ...w, line: 0 }))];
      edl.captions.splice(1, 1);
    },
  },
  {
    id: "captions-flash",
    rule: "captions.reading-time",
    expect: "fail",
    what: "un écran d'un mot remplacé par le suivant au bout de 3 frames (débit rapide haché à chaque virgule)",
    edl(edl) {
      // A one-word screen whose word is still shown whole within the 3 frames: only the
      // time on screen changes, the word and its highlight stay where they are heard.
      const cap = edl.captions.find(
        (c) => c.words.length === 1 && (c.words[0]?.fromFrame ?? 0) <= c.fromFrame + 1,
      );
      if (!cap) throw new Error("variante inapplicable : aucun écran d'un seul mot");
      cap.toFrame = cap.fromFrame + 3;
      for (const w of cap.words) w.toFrame = Math.min(Math.max(w.toFrame, w.fromFrame + 1), cap.toFrame);
    },
  },
  {
    id: "safe-zones-clamped",
    rule: "captions.safe-zones",
    expect: "pass",
    what: "témoin : placement demandé à 92 % de la hauteur, que le moteur ramène dans la zone sûre",
    edl(edl) {
      edl.output.captions.placement.y = 0.92;
    },
  },
  {
    id: "safe-zones",
    rule: "captions.safe-zones",
    expect: "fail",
    what: "zone sûre de l'EDL retouchée (marge basse 2 %) et sous-titres à 92 % : sous l'interface des plateformes",
    edl(edl) {
      edl.output.captions.safeArea.bottom = 0.02;
      edl.output.captions.placement.y = 0.92;
    },
  },
  {
    id: "contrast",
    rule: "captions.contrast",
    expect: "fail",
    what: "style de sous-titres gris clair à contour blanc",
    registry: (presets) =>
      presets.map((p) =>
        p.kind === "captions"
          ? {
              ...p,
              params: {
                ...p.params,
                fill: "#BDBDBD",
                activeFill: "#D8D8D8",
                stroke: { ...(p.params as { stroke: object }).stroke, color: "#FFFFFF" },
              },
            }
          : p,
      ),
  },
  {
    id: "loudness",
    rule: "audio.loudness",
    expect: "fail",
    what: "fichier livré remonté de 8 dB (−6 LUFS, crêtes écrêtées)",
    post: (video) => replaceWith(video, ["-c:v", "copy", "-af", "volume=8dB", "-c:a", "aac", "-b:a", "192k"]),
  },
  {
    id: "antiphase",
    rule: "audio.phase",
    expect: "fail",
    what: "canal droit du fichier livré inversé : le son s'annule sur une enceinte mono",
    post: (video) =>
      replaceWith(video, ["-c:v", "copy", "-af", "pan=stereo|c0=c0|c1=-1*c1", "-c:a", "aac", "-b:a", "192k"]),
  },
  {
    id: "stereo-music-ok",
    rule: "audio.phase",
    expect: "pass",
    what: "témoin : largeur stéréo élargie (extrastereo ×1,5), toujours compatible mono",
    post: (video) =>
      replaceWith(video, ["-c:v", "copy", "-af", "extrastereo=m=1.5", "-c:a", "aac", "-b:a", "192k"]),
    consequences: ["audio.loudness"],
  },
  {
    id: "ducking",
    rule: "audio.ducking",
    expect: "fail",
    what: "musique baissée de 4 dB seulement sous la voix",
    edl(edl) {
      for (const t of edl.audio) for (const c of t.clips) for (const d of c.duck) d.depthDb = -4;
    },
  },
  {
    id: "sfx-sync",
    rule: "audio.sfx-sync",
    expect: "fail",
    what: "un effet sonore décalé de 3 frames après son événement",
    edl(edl) {
      const fx = must(
        edl.audio.flatMap((t) => t.clips).find((c) => c.asset),
        "aucun effet sonore",
      );
      fx.at += 3;
    },
  },
  {
    id: "cut-fades",
    rule: "audio.cut-clicks",
    expect: "fail",
    what: "fondus de coupe à 0 ms dans l'EDL",
    edl(edl) {
      edl.output.audio.cutFadeMs = 0;
    },
  },
  {
    id: "cut-click",
    rule: "audio.cut-clicks",
    expect: "fail",
    consequences: ["montage.silences", "montage.beat-cuts", "captions.sync", "montage.fillers"],
    what: "une coupe au milieu d'un mot, sans fondu : clic audible",
    detectedIf: (r) => r.violations.some((v) => v.message.startsWith("clic")),
    async edl(edl, base) {
      edl.output.audio.cutFadeMs = 0;
      const fps = edl.output.fps;
      const p = must(
        pairs(edl).find(({ prev }) =>
          words(base, prev.source).some((w) => w.end <= prev.out && w.end > prev.out - 0.3),
        ),
        "aucune coupe après un mot",
      );
      const last = must(
        words(base, p.prev.source)
          .filter((w) => w.end <= p.prev.out)
          .at(-1),
        "aucun mot",
      );
      // The audio is cut at in + frames / fps: pick the frame boundary where the
      // word's waveform is the loudest, so the cut lands mid-cycle on a voiced sound.
      const path = resolve(base.baseDir, must(edl.sources[p.prev.source], "source").path);
      const samples = await decodeMono(path);
      let best = { n: 0, level: -1 };
      for (let n = Math.ceil((last.start - p.prev.in) * fps); p.prev.in + n / fps < last.end; n++) {
        const level = Math.abs(samples[Math.round((p.prev.in + n / fps) * 48_000)] ?? 0);
        if (level > best.level) best = { n, level };
      }
      setOut(edl, p.prev, p.prev.in + best.n / fps);
    },
  },
  {
    id: "reframe",
    rule: "image.reframe",
    expect: "fail",
    what: "le cadre 9:16 reste figé sur le bord gauche du rush, loin du visage",
    edl(edl) {
      for (const c of main(edl))
        if (c.reframe) c.reframe = { ...c.reframe, keys: [{ frame: c.at, value: 0.12 }] };
    },
  },
  {
    id: "color",
    rule: "image.color",
    expect: "fail",
    what: "un plan sur deux surexposé de 1,2 EV",
    edl(edl) {
      main(edl).forEach((c, k) => {
        if (k % 2 === 1 && c.color) c.color = { ...c.color, exposureEv: c.color.exposureEv + 1.2 };
      });
    },
  },
  {
    id: "export-format",
    rule: "image.export-format",
    expect: "fail",
    what: "fichier livré réencodé en MPEG-4 Part 2 au lieu de H.264",
    post: (video) =>
      replaceWith(video, ["-c:v", "mpeg4", "-q:v", "1", "-b:v", "40M", "-r", "30", "-c:a", "copy"]),
  },
  {
    id: "bitrate",
    rule: "image.bitrate",
    expect: "fail",
    what: "export à 4 Mbps",
    edl(edl) {
      edl.output.video.bitrateMbps = 4;
    },
  },
  {
    id: "black-frames",
    rule: "image.black-frames",
    expect: "fail",
    what: "5 frames noires insérées au milieu d'un plan",
    post: (video) =>
      replaceWith(
        video,
        reencodeVideo("drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable='between(n,100,104)'"),
      ),
  },
  {
    id: "strobe",
    rule: "image.flashes",
    expect: "fail",
    what: "1 s de stroboscope blanc (alternance toutes les 2 frames) au milieu d'un plan",
    post: (video) =>
      replaceWith(
        video,
        reencodeVideo(
          "drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='between(n,90,119)*lt(mod(n,4),2)'",
        ),
      ),
    consequences: ["image.color", "image.reframe", "captions.contrast", "image.duplicate-frames"],
  },
  {
    id: "flash-cuts-ok",
    rule: "image.flashes",
    expect: "pass",
    what: "témoin : 3 flashs blancs en une seconde (la limite WCAG, autorisée)",
    post: (video) =>
      replaceWith(
        video,
        reencodeVideo(
          "drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='between(n,90,119)*lt(mod(n,10),3)'",
        ),
      ),
    consequences: ["image.color", "image.reframe", "captions.contrast", "image.duplicate-frames"],
  },
  {
    id: "sharpness",
    rule: "image.sharpness",
    expect: "fail",
    what: "rush 1080p remplacé par sa copie au tiers de la définition (640×360) : image agrandie ×5,3 au lieu de ×1,78 (limite ×2,2)",
    async edl(edl, base) {
      const clip = must(main(edl)[0], "aucun plan");
      const source = must(edl.sources[clip.source], "source inconnue");
      const from = resolve(base.baseDir, source.path);
      const low = join(dirname(from), `lowres-${clip.source}.mp4`);
      await ffmpeg(["-v", "error", "-i", from, "-vf", "scale=trunc(iw/6)*2:-2", "-c:a", "copy", "-y", low]);
      source.path = relative(base.baseDir, low);
      source.width = Math.trunc((source.width ?? 1920) / 6) * 2;
      source.height = Math.trunc((source.height ?? 1080) / 6) * 2;
    },
    consequences: ["image.reframe", "image.color"],
  },
  {
    id: "freeze-static",
    rule: "image.duplicate-frames",
    expect: "pass",
    what: "témoin : 6 frames figées sur un plan où rien ne bouge (photo fixe, seul le grain change) : invisible",
    post: (video) =>
      replaceWith(video, reencodeVideo("split[a][b];[a][b]freezeframes=first=120:last=125:replace=119")),
  },
  {
    id: "freeze-animated",
    rule: "image.duplicate-frames",
    expect: "fail",
    what: "5 frames figées pendant un punch-in animé",
    async post(video, edl) {
      const track = must(
        edl.keyframes.find((t) => t.role === "micro"),
        "aucun punch-in animé",
      );
      const first = track.keys[0]?.frame ?? 0;
      await replaceWith(
        video,
        reencodeVideo(`split[a][b];[a][b]freezeframes=first=${first + 1}:last=${first + 5}:replace=${first}`),
      );
    },
  },
  {
    id: "annotation-ok",
    rule: "captions.sync",
    expect: "pass",
    annotation: true,
    what: "témoin : synchro mesurée contre une annotation au mot (la vérité terrain de la voix)",
  },
  {
    id: "annotation-late",
    rule: "captions.sync",
    expect: "fail",
    annotation: true,
    what: "sous-titres 4 frames en retard, mesurés contre l'annotation",
    edl: (edl) => delayCaptions(edl, 4),
  },
];

/** The ground truth as an editor's annotation of the render: each kept word at its timeline onset. */
export function truthLabels(edl: Edl, base: Base): Label[] {
  const fps = edl.output.fps;
  return main(edl).flatMap((clip) =>
    base.truth
      .filter((w) => w.start >= clip.in && w.start < clip.out)
      .map((w) => {
        const start = clip.at / fps + (w.start - clip.in);
        return { start, end: start + (w.end - w.start), text: w.text };
      }),
  );
}

function timelineBeatFrames(edl: Edl, base: Base): number[] {
  const fps = edl.output.fps;
  const out: number[] = [];
  for (const track of edl.audio)
    for (const c of track.clips) {
      const grid = c.source ? base.analysis.beats?.[c.source] : undefined;
      if (!grid) continue;
      for (const b of grid.beats) if (b >= c.in && b <= c.out) out.push(Math.round(c.at + (b - c.in) * fps));
    }
  return out;
}

// ————————————————————————————————————————————— running

/** Clean edit of the calibration talking head (short profile, every rule applicable). */
export async function calibrationBase(dir: string): Promise<Base> {
  const fx = await generateFixtures();
  const short = await loadProfile("short");
  // The synthetic voice is flat: a lower emphasis bar lets the planner place its own
  // animated punch-in, so the motion rules apply.
  const profile: StyleProfile = { ...short, motion: { ...short.motion, emphasisMinScore: 0.3 } };
  const edlPath = join(dir, "base", "edit.edl.json");
  await mkdir(dirname(edlPath), { recursive: true });
  const edl = await plan([fx.talkingHead, fx.music], profile, edlPath, true);
  const analysis = JSON.parse(await readFile(join(dir, "base", "edit.analysis.json"), "utf8")) as Analysis;
  return { edl, analysis, profile, baseDir: dirname(resolve(edlPath)), truth: fx.speechTruth.words };
}

async function runOne(
  base: Base,
  variant: Variant,
  dir: string,
  library: Preset[],
  clean: Report | undefined,
): Promise<{ outcome: Outcome; report?: Report }> {
  const started = Date.now();
  const outcome: Outcome = {
    id: variant.id,
    rule: variant.rule,
    expect: variant.expect,
    what: variant.what,
    verdict: "error",
    crossTalk: [],
    seconds: 0,
  };
  try {
    const edl = EdlSchema.parse(structuredClone(base.edl));
    await variant.edl?.(edl, base);
    const parsed = parseEdl(edl);
    if (!parsed.ok) {
      outcome.verdict = variant.expect === "reject" ? "detected" : "error";
      outcome.target = {
        status: "rejected",
        score: 0,
        violations: parsed.diagnostics
          .filter((d) => d.level === "error")
          .map((d) => `${d.code} : ${d.message}`),
      };
      return { outcome };
    }
    if (variant.expect === "reject") {
      outcome.verdict = "missed";
      return { outcome };
    }
    if (variant.annotation) {
      const r = checkCaptionSyncTruth(parsed.edl, base.profile, truthLabels(base.edl, base));
      outcome.target = {
        status: r.status,
        score: r.score,
        violations: r.violations.slice(0, 3).map((v) => v.message),
      };
      if (r.measured)
        outcome.target.violations.push(
          `p95 ${r.measured.p95Frames} / max ${r.measured.maxFrames} frame(s) sur ${r.measured.annotated} mots`,
        );
      outcome.verdict =
        variant.expect === "pass"
          ? r.status === "pass"
            ? "ok"
            : "false-alarm"
          : r.status === "fail"
            ? "detected"
            : "missed";
      return { outcome };
    }
    const registry = new PresetRegistry();
    for (const p of variant.registry ? variant.registry(library) : library) registry.add(p);
    const vdir = join(dir, variant.id);
    await mkdir(vdir, { recursive: true });
    await writeFile(join(vdir, "edit.edl.json"), `${JSON.stringify(parsed.edl, null, 2)}\n`);
    const video = join(vdir, "final.mp4");
    await render(
      {
        ...parsed.edl,
        output: { ...parsed.edl.output, video: { ...parsed.edl.output.video, preset: "veryfast" } },
      },
      { baseDir: base.baseDir, outPath: video, keepStems: true, registry },
    );
    await variant.post?.(video, parsed.edl);
    const report = await qualityCheck({
      video,
      profile: base.profile,
      edl: parsed.edl,
      baseDir: base.baseDir,
      analysis: base.analysis,
      registry,
    });
    await writeFile(join(vdir, "quality.json"), `${JSON.stringify(report, null, 2)}\n`);
    outcome.score = report.score;
    const target = report.results.find((r) => r.ruleId === variant.rule);
    if (target)
      outcome.target = {
        status: target.status,
        score: target.score,
        violations: target.violations.slice(0, 3).map((v) => v.message),
      };
    if (variant.rule === "control") {
      const failing = report.results.filter((r) => r.status === "fail");
      outcome.verdict = failing.length === 0 ? "ok" : "false-alarm";
      outcome.crossTalk = failing.map((r) => ({
        ruleId: r.ruleId,
        violation: r.violations[0]?.message ?? "",
        expected: false,
      }));
    } else {
      if (variant.expect === "pass") outcome.verdict = target?.status === "pass" ? "ok" : "false-alarm";
      else if (!target || target.status === "not-evaluated") outcome.verdict = "not-evaluated";
      else
        outcome.verdict =
          target.status === "fail" && (variant.detectedIf?.(target) ?? true) ? "detected" : "missed";
      const before = new Map(clean?.results.map((r) => [r.ruleId, r.status]));
      outcome.crossTalk = report.results
        .filter((r) => r.ruleId !== variant.rule && r.status === "fail" && before.get(r.ruleId) !== "fail")
        .map((r) => ({
          ruleId: r.ruleId,
          violation: r.violations[0]?.message ?? "",
          expected: variant.consequences?.includes(r.ruleId) ?? false,
        }));
    }
    return { outcome, report };
  } catch (e) {
    outcome.error = (e as Error).message;
    return { outcome };
  } finally {
    outcome.seconds = Math.round((Date.now() - started) / 1000);
  }
}

export interface Calibration {
  date: string;
  base: { clips: number; captions: number; keyframes: number; transitions: number; sfx: number };
  outcomes: Outcome[];
  summary: {
    defects: number;
    detected: number;
    controls: number;
    controlsOk: number;
    crossTalk: number;
    falseAlarms: number;
    rulesCovered: number;
  };
}

export async function calibrate(
  dir: string,
  opts: { only?: string[]; log?: (m: string) => void } = {},
): Promise<Calibration> {
  const log = opts.log ?? (() => {});
  const base = await calibrationBase(dir);
  const library = (await PresetRegistry.load()).all();
  const selected = VARIANTS.filter((v) => !opts.only || v.id === "control" || opts.only.includes(v.id));
  const outcomes: Outcome[] = [];
  let clean: Report | undefined;
  for (const variant of selected) {
    log(`${variant.id} : ${variant.what}`);
    const { outcome, report } = await runOne(base, variant, dir, library, clean);
    if (variant.id === "control") clean = report;
    outcomes.push(outcome);
    log(`  → ${outcome.verdict}${outcome.error ? ` (${outcome.error})` : ""} en ${outcome.seconds} s`);
  }
  const defects = outcomes.filter((o) => o.expect !== "pass");
  const controls = outcomes.filter((o) => o.expect === "pass");
  const result: Calibration = {
    date: new Date().toISOString(),
    base: {
      clips: base.edl.video[0]?.clips.length ?? 0,
      captions: base.edl.captions.length,
      keyframes: base.edl.keyframes.length,
      transitions: base.edl.transitions.length,
      sfx: base.edl.audio.flatMap((t) => t.clips).filter((c) => c.asset).length,
    },
    outcomes,
    summary: {
      defects: defects.length,
      detected: defects.filter((o) => o.verdict === "detected").length,
      controls: controls.length,
      controlsOk: controls.filter((o) => o.verdict === "ok").length,
      crossTalk: defects.filter((o) => o.crossTalk.length > 0).length,
      falseAlarms: outcomes.filter((o) => o.crossTalk.some((x) => !x.expected)).length,
      rulesCovered: new Set(defects.filter((o) => o.verdict === "detected").map((o) => o.rule)).size,
    },
  };
  await writeFile(join(dir, "calibration.json"), `${JSON.stringify(result, null, 2)}\n`);
  await writeFile(join(dir, "calibration.md"), calibrationMarkdown(result));
  return result;
}

const VERDICT = {
  detected: "✅ détecté",
  ok: "✅ accepté",
  missed: "❌ manqué",
  "false-alarm": "❌ fausse alerte",
  "not-evaluated": "⏳ non évalué",
  error: "⚠️ erreur",
} as const;

export function calibrationMarkdown(c: Calibration): string {
  const title = new Map(RULES.map((r) => [r.id, r.titleFr]));
  const s = c.summary;
  const lines = [
    "# Calibration du quality-check",
    "",
    `- Base : talking head synthétique (visage réel, voix française avec vérité terrain au mot, musique), format court ; ${c.base.clips} plans, ${c.base.captions} sous-titres, ${c.base.keyframes} animation(s), ${c.base.transitions} transition(s), ${c.base.sfx} SFX.`,
    `- **Défauts détectés : ${s.detected}/${s.defects}**, règles couvertes : ${s.rulesCovered}/${RULES.length}.`,
    `- **Témoins acceptés : ${s.controlsOk}/${s.controls}**.`,
    `- Défauts qui font aussi échouer une autre règle : ${s.crossTalk}, dont **${s.falseAlarms} hors des conséquences attendues** (fausses alertes à expliquer).`,
    "",
    "Autres règles en échec : en italique, une conséquence réelle du défaut (déclarée dans la variante) ; en gras, une fausse alerte.",
    "",
    "| Variante | Règle visée | Défaut injecté | Résultat | Mesure de la règle | Autres règles en échec | Score |",
    "|---|---|---|---|---|---|---|",
  ];
  const esc = (t: string) => t.replaceAll("|", "\\|");
  for (const o of c.outcomes) {
    const rule = o.rule === "control" ? "toutes" : `${title.get(o.rule) ?? o.rule}`;
    const measure = o.error
      ? esc(o.error)
      : o.target
        ? esc(o.target.violations.slice(0, 2).join(" ; ") || o.target.status)
        : "";
    const cross =
      o.crossTalk
        .map((x) =>
          x.expected ? `_${x.ruleId}_ (${esc(x.violation)})` : `**${x.ruleId}** (${esc(x.violation)})`,
        )
        .join(" ; ") || "—";
    lines.push(
      `| \`${o.id}\` | ${rule} | ${esc(o.what)} | ${VERDICT[o.verdict]} | ${measure} | ${cross} | ${o.score ?? "—"} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}
