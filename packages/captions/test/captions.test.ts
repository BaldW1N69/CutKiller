import { type Analysis, type EdlInput, parseEdl, type Word } from "@cutkiller/core";
import { loadProfile, PresetRegistry } from "@cutkiller/style";
import { createCanvas } from "canvas";
import { beforeAll, describe, expect, it } from "vitest";
import {
  buildCaptions,
  CaptionTimeline,
  captionStyle,
  captionsPass,
  displayText,
  profileSafeArea,
  safeRect,
  splitLines,
  timelineWords,
  toSrt,
} from "../src";

let registry: PresetRegistry;
let short: Awaited<ReturnType<typeof loadProfile>>;
let long: Awaited<ReturnType<typeof loadProfile>>;
beforeAll(async () => {
  registry = await PresetRegistry.load();
  short = await loadProfile("short");
  long = await loadProfile("long");
});

const edlOf = (input: EdlInput) => {
  const r = parseEdl(input);
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
  return r.edl;
};

/** Words spoken back to back (0.1 s apart), with a longer pause before the indices in `pauses`. */
function speech(texts: string[], pauses: number[] = [], wordS = 0.3): Word[] {
  let t = 0.5;
  return texts.map((text, i) => {
    if (pauses.includes(i)) t += 0.6;
    const w: Word = { text, start: t, end: t + wordS, timing: "forced" };
    t += wordS + 0.1;
    return w;
  });
}

function edlWith(words: Word[], format: "short" | "long", clips?: EdlInput["video"][number]["clips"]) {
  const end = (words.at(-1)?.end ?? 1) + 1;
  const [width, height] = format === "short" ? [1080, 1920] : [1920, 1080];
  const edl = edlOf({
    version: "1.2.0",
    output: { format, width, height, fps: 30, video: { bitrateMbps: 20 }, audio: {} },
    sources: { a: { path: "a.mp4", durationS: 60 } },
    video: [
      {
        id: "main",
        clips: clips ?? [
          {
            id: "A",
            source: "a",
            in: 0,
            out: end,
            at: 0,
            why: { kind: "speech", wordIds: words.map((_, i) => i) },
          },
        ],
      },
    ],
  });
  const analysis: Analysis = {
    sources: {},
    transcripts: { a: { language: "fr", model: "t", durationS: 60, words } },
  };
  return { edl, analysis };
}

describe("mots sur la timeline", () => {
  it("convertit le temps source en frames et garde une seule fois un mot à cheval sur un zoom-cut", () => {
    const words = speech(["Bonjour", "à", "tous"]);
    // Zoom cut at 1.0 s in the middle of « à » (0.9–1.2 s): audio continuous, two clips.
    const { edl, analysis } = edlWith(words, "long", [
      { id: "A", source: "a", in: 0, out: 1, at: 0, why: { kind: "speech", wordIds: [0, 1] } },
      {
        id: "B",
        source: "a",
        in: 1,
        out: 2.5,
        at: 30,
        transform: { scale: 1.1 },
        why: { kind: "zoom", wordIds: [1, 2] },
      },
    ]);
    const tw = timelineWords(edl, analysis.transcripts);
    expect(tw.map((w) => [w.text, w.fromFrame, w.toFrame])).toEqual([
      ["Bonjour", 15, 24],
      ["à", 27, 36],
      ["tous", 39, 48],
    ]);
  });

  it("suit les jump cuts : les mots retirés disparaissent, les suivants avancent", () => {
    const words = speech(["un", "euh", "deux"]);
    // « euh » (0.9–1.2 s) cut out: the second clip starts at 1.3 s on frame 24.
    const { edl, analysis } = edlWith(words, "long", [
      { id: "A", source: "a", in: 0.4, out: 0.9, at: 0, why: { kind: "speech", wordIds: [0] } },
      { id: "B", source: "a", in: 1.2, out: 1.8, at: 15, why: { kind: "speech", wordIds: [2] } },
    ]);
    const tw = timelineWords(edl, analysis.transcripts);
    expect(tw.map((w) => [w.text, w.fromFrame])).toEqual([
      ["un", 3],
      ["deux", 18],
    ]);
  });
});

describe("découpage", () => {
  it("court : 1 à 3 mots en capitales sans ponctuation, coupe aux pauses et aux virgules", () => {
    const words = speech(
      ["Alors,", "aujourd'hui", "on", "va", "parler", "de", "la", "mer.", "C'est", "parti"],
      [8],
    );
    const { edl, analysis } = edlWith(words, "short");
    const style = captionStyle(registry, "karaoke-pop@1");
    const caps = buildCaptions(
      timelineWords(edl, analysis.transcripts),
      style,
      "karaoke-pop@1.0.0",
      short,
      30,
      200,
    );
    const screens = caps.map((c) => c.words.map((w) => w.text).join(" "));
    // « AUJOURD'HUI ON VA » would be 17 characters (limit 16 on one line).
    expect(screens).toEqual(["ALORS", "AUJOURD'HUI", "ON VA PARLER", "DE LA MER", "C'EST PARTI"]);
    for (const c of caps) expect(c.words.length).toBeLessThanOrEqual(3);
  });

  it("court : ne termine pas un écran sur un mot-outil quand il peut passer au suivant", () => {
    const words = speech(["il", "faut", "partir", "de", "la", "base"]);
    const { edl, analysis } = edlWith(words, "short");
    const style = captionStyle(registry, "karaoke-pop@1");
    const caps = buildCaptions(timelineWords(edl, analysis.transcripts), style, "k@1", short, 30, 200);
    expect(caps.map((c) => c.words.map((w) => w.text).join(" "))).toEqual(["IL FAUT PARTIR", "DE LA BASE"]);
  });

  it("court : en débit rapide, aucun écran ne reste moins de 300 ms (il rejoint un voisin)", () => {
    // 0,22 s par mot : sans fusion, « OUI » puis « BON » ne restaient que 7 frames.
    const words = speech(["Oui,", "on", "va", "voir.", "Bon,", "tout", "va", "bien"], [], 0.12);
    const { edl, analysis } = edlWith(words, "short");
    const style = captionStyle(registry, "karaoke-pop@1");
    const caps = buildCaptions(timelineWords(edl, analysis.transcripts), style, "k@1", short, 30, 200);
    expect(caps.map((c) => c.words.map((w) => w.text).join(" "))).toEqual([
      "OUI ON",
      "VA VOIR",
      "BON TOUT",
      "VA BIEN",
    ]);
    for (const c of caps) expect(c.toFrame - c.fromFrame).toBeGreaterThanOrEqual(9);
  });

  it("the last screen, cut short by the end of the edit, joins the previous one (pt reading: 17 frames)", () => {
    const words = speech(
      [
        "através",
        "da",
        "charneca",
        "estava",
        "parada",
        "uma",
        "carruagem",
        "era",
        "um",
        "cupê",
        "pintado",
        "de",
      ],
      [10],
    );
    const { edl, analysis } = edlWith(words, "long");
    const style = captionStyle(registry, "karaoke-pop@1");
    const end = Math.round((words.at(-1) as Word).end * 30) + 1;
    const caps = buildCaptions(timelineWords(edl, analysis.transcripts), style, "k@1", long, 30, end);
    const minFrames = Math.round((long.captions.minDurationMs / 1000) * 30);
    for (const c of caps) expect(c.toFrame - c.fromFrame).toBeGreaterThanOrEqual(minFrames - 1);
    expect(caps.at(-1)?.words.map((w) => w.text.toLowerCase())).toContain("cupê");
  });

  it("long : deux lignes de 32 caractères au plus, équilibrées, sans mot-outil en fin de ligne", () => {
    const stop = new Set(long.motion.stopWords);
    const ws = "les pêcheurs partent tôt le matin vers la grande baie"
      .split(" ")
      .map((t) => ({ text: t, shown: t }));
    const lines = splitLines(ws, 2, 32, stop) as number[];
    const first = ws
      .filter((_, i) => lines[i] === 0)
      .map((w) => w.text)
      .join(" ");
    const second = ws
      .filter((_, i) => lines[i] === 1)
      .map((w) => w.text)
      .join(" ");
    expect(first.length).toBeLessThanOrEqual(32);
    expect(second.length).toBeLessThanOrEqual(32);
    expect(stop.has(first.split(" ").at(-1) as string)).toBe(false);
    expect(Math.abs(first.length - second.length)).toBeLessThanOrEqual(12);
    expect(splitLines(ws.slice(0, 3), 2, 32, stop)).toEqual([0, 0, 0]);
  });

  it("long : commence un nouvel écran plutôt que de laisser un mot-outil en fin de ligne", () => {
    const words = speech(
      "Bonjour à tous, aujourd'hui, je vais vous montrer comment monter une vidéo.".split(" "),
    );
    const { edl, analysis } = edlWith(words, "long");
    const out = captionsPass.run(edl, { analysis, profile: long, presets: registry }).edl;
    const lines = out.captions.map((c) =>
      [0, 1]
        .map((l) =>
          c.words
            .filter((w) => w.line === l)
            .map((w) => w.text)
            .join(" "),
        )
        .filter(Boolean)
        .join(" / "),
    );
    expect(lines).toEqual([
      "Bonjour à tous, aujourd'hui,",
      "je vais vous montrer / comment monter une vidéo.",
    ]);
  });

  it("long : nouveau sous-titre après un point, tenue après le dernier mot, jamais de chevauchement", () => {
    const words = speech(
      "Le port est calme ce matin. Les bateaux rentrent un par un avec la marée haute et les mouettes".split(
        " ",
      ),
    );
    const { edl, analysis } = edlWith(words, "long");
    const out = captionsPass.run(edl, { analysis, profile: long, presets: registry }).edl;
    expect(out.captions[0]?.words.map((w) => w.text).join(" ")).toBe("Le port est calme ce matin.");
    out.captions.forEach((c, i) => {
      const lines = Math.max(...c.words.map((w) => w.line)) + 1;
      expect(lines).toBeLessThanOrEqual(2);
      const next = out.captions[i + 1];
      if (next) expect(c.toFrame).toBeLessThanOrEqual(next.fromFrame);
    });
    // The last caption lingers 500 ms after its last word.
    const last = out.captions.at(-1)!;
    expect(last.toFrame - last.words.at(-1)!.toFrame).toBe(15);
    expect(out.output.captions.safeArea).toEqual(profileSafeArea(long));
  });

  it("cinematic-short : un mot isolé entre deux pauses rejoint l'écran le plus proche (2–4 mots)", async () => {
    const cine = await loadProfile("cinematic-short");
    // « Alors » alone after a 0.6 s pause, then a pause again before « on ».
    const words = speech("Je pense que oui. Alors, on avance vite maintenant.".split(" "), [4, 5]);
    const { edl, analysis } = edlWith(words, "short");
    const out = captionsPass.run(edl, { analysis, profile: cine, presets: registry }).edl;
    for (const c of out.captions) expect(c.words.length).toBeGreaterThanOrEqual(2);
    expect(out.captions.flatMap((c) => c.words.map((w) => w.text)).join(" ")).toBe(
      "Je pense que oui Alors on avance vite maintenant",
    );
  });

  it("letterbox 2,39:1 : les sous-titres restent sur l'image, pas sur les bandes", async () => {
    const cine = await loadProfile("cinematic");
    const area = profileSafeArea(cine);
    // Bars of (1 − 1920 / 2.39 / 1080) / 2 ≈ 12,8 % each, plus a 2 % margin.
    expect(area.bottom).toBeCloseTo(0.148, 3);
    expect(area.top).toBeCloseTo(0.148, 3);
    expect(area.left).toBe(0.05);
    expect(profileSafeArea(await loadProfile("cinematic-short")).bottom).toBe(profileSafeArea(short).bottom);
  });

  it("styles : capitales et ponctuation selon le preset", () => {
    const pop = captionStyle(registry, "karaoke-pop@1");
    const clean = captionStyle(registry, "subtitle-clean@1");
    expect(displayText(pop, "l’été,")).toBe("L'ÉTÉ");
    expect(displayText(pop, "«")).toBe("");
    expect(displayText(clean, "l’été,")).toBe("l'été,");
  });
});

describe("mise en page et timeline", () => {
  const shortEdl = () => {
    const words = speech(["anticonstitutionnellement", "vraiment"], [1]);
    const { edl, analysis } = edlWith(words, "short");
    return captionsPass.run(edl, { analysis, profile: short, presets: registry }).edl;
  };

  it("reste dans la safe zone, rebond compris, en réduisant un mot trop long", () => {
    const edl = shortEdl();
    const timeline = new CaptionTimeline(edl, registry);
    const safe = safeRect(profileSafeArea(short), 1080, 1920);
    for (const p of timeline.placed) {
      const { box, cx, cy } = p.layout;
      const s = p.maxScale;
      expect(s).toBeGreaterThan(1);
      expect(cx - (box.w / 2) * s).toBeGreaterThanOrEqual(safe.x - 1e-6);
      expect(cx + (box.w / 2) * s).toBeLessThanOrEqual(safe.x + safe.w + 1e-6);
      expect(cy - (box.h / 2) * s).toBeGreaterThanOrEqual(safe.y - 1e-6);
      expect(cy + (box.h / 2) * s).toBeLessThanOrEqual(safe.y + safe.h + 1e-6);
    }
    const [longWord, normal] = timeline.placed;
    expect(longWord!.layout.fontPx).toBeLessThan(normal!.layout.fontPx);
  });

  it("surligne le mot prononcé, anime l'entrée et signale sa vitesse", () => {
    const words = speech(["on", "y", "va"]);
    const { edl, analysis } = edlWith(words, "short");
    const out = captionsPass.run(edl, { analysis, profile: short, presets: registry }).edl;
    const timeline = new CaptionTimeline(out, registry);
    const p = timeline.at(out.captions[0]!.fromFrame)!;
    const [a, b] = p.caption.words;
    expect(timeline.activeWord(p, a!.fromFrame)).toBe(0);
    expect(timeline.activeWord(p, b!.fromFrame - 1)).toBe(0);
    expect(timeline.activeWord(p, b!.fromFrame)).toBe(1);
    expect(timeline.stateAt(p, p.caption.fromFrame).scale).toBeCloseTo(0.8, 5);
    expect(timeline.stateAt(p, p.caption.fromFrame + 6).scale).toBe(1);
    // A spring starts at rest, peaks, then settles: px/frame of the outline's corners.
    const speeds = [0, 1, 2, 3, 4, 5].map((k) => timeline.velocityAt(p.caption.fromFrame + k));
    expect(speeds[0]).toBeLessThan(Math.max(...speeds));
    expect(Math.max(...speeds)).toBeGreaterThan(5);
    expect(timeline.velocityAt(p.caption.fromFrame + 8)).toBe(0);
  });

  it("dessine les lettres en blanc et le mot actif en jaune, contour noir", () => {
    const words = speech(["OK", "super"]);
    const { edl, analysis } = edlWith(words, "short");
    const out = captionsPass.run(edl, { analysis, profile: short, presets: registry }).edl;
    const timeline = new CaptionTimeline(out, registry);
    const c = out.captions[0]!;
    const f = c.words[1]!.fromFrame + 1;
    const canvas = createCanvas(1080, 1920);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#3080c0";
    ctx.fillRect(0, 0, 1080, 1920);
    timeline.draw(ctx, f);
    const p = timeline.at(f)!;
    const px = (x: number, y: number) => [
      ...ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data.slice(0, 3),
    ];
    const count = (color: number[]) => {
      const { x, y, w, h } = p.layout.box;
      const data = ctx.getImageData(Math.round(x), Math.round(y), Math.round(w), Math.round(h)).data;
      let n = 0;
      for (let i = 0; i < data.length; i += 4)
        if (
          Math.abs(data[i]! - color[0]!) +
            Math.abs(data[i + 1]! - color[1]!) +
            Math.abs(data[i + 2]! - color[2]!) <
          10
        )
          n++;
      return n;
    };
    expect(count([255, 255, 255])).toBeGreaterThan(500); // « OK »
    expect(count([255, 225, 77])).toBeGreaterThan(500); // « SUPER », spoken
    expect(count([0, 0, 0])).toBeGreaterThan(500); // outline
    expect(px(10, 10)).toEqual([48, 128, 192]); // untouched outside the caption
  });

  it("exporte un SRT", () => {
    const words = speech("Le port est calme ce matin. Les bateaux rentrent".split(" "));
    const { edl, analysis } = edlWith(words, "long");
    const out = captionsPass.run(edl, { analysis, profile: long, presets: registry }).edl;
    const srt = toSrt(out.captions, 30);
    expect(srt).toMatch(/^1\n00:00:00,500 --> 00:00:0\d,\d{3}\nLe port est calme ce matin\.\n/);
    expect(srt.split("\n\n")).toHaveLength(out.captions.length);
  });
});

describe("validation EDL", () => {
  it("refuse des sous-titres qui se chevauchent ou des mots hors de leur sous-titre", () => {
    const base = edlWith(speech(["a"]), "long").edl;
    const caption = (
      id: string,
      from: number,
      to: number,
      words: { text: string; fromFrame: number; toFrame: number }[],
    ) => ({
      id,
      style: "subtitle-clean@1",
      fromFrame: from,
      toFrame: to,
      words,
    });
    const r = parseEdl({
      ...base,
      captions: [
        caption("k1", 0, 30, [{ text: "a", fromFrame: 0, toFrame: 10 }]),
        caption("k2", 20, 40, [{ text: "b", fromFrame: 45, toFrame: 50 }]),
      ],
    });
    expect(r.ok).toBe(false);
    const codes = r.diagnostics.map((d) => d.code);
    expect(codes).toContain("captions.overlap");
    expect(codes).toContain("captions.word-range");
  });
});
