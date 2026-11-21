import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captionsPass } from "@cutkiller/captions";
import { type Analysis, type Edl, type EdlInput, parseEdl, type Word } from "@cutkiller/core";
import { generateFixtures } from "@cutkiller/fixtures";
import { render } from "@cutkiller/render";
import { loadProfile, PresetRegistry } from "@cutkiller/style";
import { beforeAll, describe, expect, it } from "vitest";
import {
  checkCaptionContrast,
  checkCaptionDensity,
  checkCaptionSync,
  checkSafeZones,
  contrastRatio,
} from "../src/checks/captions";

let registry: PresetRegistry;
let short: Awaited<ReturnType<typeof loadProfile>>;
let long: Awaited<ReturnType<typeof loadProfile>>;
beforeAll(async () => {
  registry = await PresetRegistry.load();
  short = await loadProfile("short");
  long = await loadProfile("long");
});

const edlOf = (i: EdlInput) => {
  const r = parseEdl(i);
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
  return r.edl;
};

function words(texts: string[]): Word[] {
  return texts.map((text, i) => ({ text, start: 0.3 + i * 0.35, end: 0.55 + i * 0.35, timing: "forced" }));
}

/** EDL of one clip of `path` with its words captioned by the pass of `profile`. */
function captioned(
  path: string,
  texts: string[],
  profile: typeof short,
  size: [number, number],
  presets: PresetRegistry = registry,
): { edl: Edl; analysis: Analysis } {
  const ws = words(texts);
  const edl = edlOf({
    version: "1.2.0",
    output: {
      format: size[0] < size[1] ? "short" : "long",
      width: size[0],
      height: size[1],
      fps: 30,
      video: { bitrateMbps: 8, preset: "veryfast" },
      audio: {},
    },
    sources: { a: { path, durationS: 4 } },
    video: [
      {
        id: "main",
        clips: [
          {
            id: "A",
            source: "a",
            in: 0,
            out: 3,
            at: 0,
            why: { kind: "speech", wordIds: ws.map((_, i) => i) },
          },
        ],
      },
    ],
  });
  const analysis: Analysis = {
    sources: {},
    transcripts: { a: { language: "fr", model: "t", durationS: 4, words: ws } },
  };
  return { edl: captionsPass.run(edl, { analysis, profile, presets }).edl, analysis };
}

describe("densité et safe zones", () => {
  it("compte les mots par écran (court) et les caractères par ligne (long)", () => {
    const { edl } = captioned("a.mp4", ["un", "deux", "trois"], short, [1080, 1920]);
    expect(checkCaptionDensity(edl, short).status).toBe("pass");
    const crowded = edlOf({
      ...edl,
      captions: [
        {
          id: "k1",
          style: "karaoke-pop@1",
          fromFrame: 0,
          toFrame: 40,
          words: ["UN", "DEUX", "TROIS", "QUATRE"].map((text, i) => ({
            text,
            fromFrame: i * 10,
            toFrame: i * 10 + 8,
          })),
        },
      ],
    });
    expect(checkCaptionDensity(crowded, short).violations[0]?.message).toBe("k1 : 4 mots à l'écran");
    const wide = edlOf({
      ...edl,
      captions: [
        {
          id: "k1",
          style: "subtitle-clean@1",
          fromFrame: 0,
          toFrame: 40,
          words: "une ligne beaucoup trop longue pour un écran"
            .split(" ")
            .map((text, i) => ({ text, fromFrame: i * 4, toFrame: i * 4 + 3 })),
        },
      ],
    });
    expect(checkCaptionDensity(wide, long).violations[0]?.message).toMatch(/ligne de 44 caractères/);
  });

  it("vérifie les sous-titres contre les zones du profil, pas contre le réglage de l'EDL", () => {
    const { edl } = captioned("a.mp4", ["tout", "en", "bas"], short, [1080, 1920]);
    expect(checkSafeZones(edl, short, registry)).toMatchObject({ status: "pass" });
    // Someone edited the EDL: no margins, caption at the very bottom, under TikTok's description.
    const moved = edlOf({
      ...edl,
      output: {
        ...edl.output,
        captions: {
          safeArea: { top: 0, bottom: 0, left: 0, right: 0 },
          placement: { anchor: "bottom", y: 1 },
        },
      },
    });
    const r = checkSafeZones(moved, short, registry);
    expect(r.status).toBe("fail");
    expect(r.violations[0]?.message).toMatch(/déborde : \d+ px en bas/);
  });
});

describe("contraste", () => {
  it("ratio WCAG : blanc sur noir 21:1, gris moyen sur noir < 4,5:1 pour du gris foncé", () => {
    expect(contrastRatio([255, 255, 255], [0, 0, 0])).toBeCloseTo(21, 5);
    expect(contrastRatio([118, 118, 118], [255, 255, 255])).toBeCloseTo(4.54, 1);
    expect(contrastRatio([90, 90, 90], [0, 0, 0])).toBeLessThan(4.5);
  });

  it("mesure le contraste sur les pixels encodés et refuse un style peu lisible", async () => {
    const fx = await generateFixtures();
    const dir = await mkdtemp(join(tmpdir(), "ck-contrast-"));
    const good = captioned(fx.cam9x16, ["la", "mer", "monte", "vite"], short, [540, 960]);
    const goodOut = join(dir, "good.mp4");
    await render(good.edl, { baseDir: fx.dir, outPath: goodOut, registry });
    const ok = await checkCaptionContrast(goodOut, good.edl, short, registry);
    expect(ok.status, JSON.stringify(ok.violations)).toBe("pass");
    expect(ok.measured?.worstMeasured as number).toBeGreaterThan(8);

    // Same captions, grey letters on a dark-grey outline: fails on the style and on the pixels.
    const presets = join(dir, "presets");
    await mkdir(join(presets, "captions"), { recursive: true });
    await mkdir(join(presets, "motion"), { recursive: true });
    const pop = registry.resolve("karaoke-pop@1");
    await writeFile(
      join(presets, "captions", "karaoke-pop@1.0.0.json"),
      JSON.stringify({
        ...pop,
        params: {
          ...pop.params,
          fill: "#808080",
          activeFill: "#909090",
          stroke: { color: "#505050", widthRel: 0.2 },
        },
      }),
    );
    await writeFile(
      join(presets, "motion", "caption-pop@1.0.0.json"),
      JSON.stringify(registry.resolve("caption-pop@1")),
    );
    const dull = await PresetRegistry.load(presets);
    const badOut = join(dir, "bad.mp4");
    await render(good.edl, { baseDir: fx.dir, outPath: badOut, registry: dull });
    const bad = await checkCaptionContrast(badOut, good.edl, short, dull);
    expect(bad.status).toBe("fail");
    const messages = bad.violations.map((v) => v.message).join("\n");
    expect(messages).toMatch(/texte\/contour 2\.\d+:1/);
    expect(messages).toMatch(/contraste mesuré [12]\.\d+:1/);
  });
});

describe("synchronisation au mot", () => {
  it("écarts p95 / max en frames, mots non mesurables à part, mots oubliés comptés", async () => {
    const { edl, analysis } = captioned("a.mp4", ["un", "deux", "trois", "quatre"], long, [1920, 1080]);
    const ws = edl.captions.flatMap((c) => c.words);
    const at = (k: number, dFrames: number, alignScore = 0.9) => ({
      start: ((ws[k]?.fromFrame ?? 0) + dFrames) / 30,
      end: 0,
      timing: "forced" as const,
      alignScore,
    });
    const fine = await checkCaptionSync("v.mp4", edl, long, analysis, ".", [
      at(0, 0.3),
      at(1, -0.4),
      at(2, 0.2),
      at(3, 0.5),
    ]);
    expect(fine).toMatchObject({ status: "pass", measured: { measured: 4, unmeasured: 0, missing: 0 } });

    const late = await checkCaptionSync("v.mp4", edl, long, analysis, ".", [
      at(0, 0),
      at(1, 5),
      at(2, 0, 0.05),
      at(3, 0),
    ]);
    expect(late.status).toBe("fail");
    expect(late.measured).toMatchObject({ measured: 3, unmeasured: 1 });
    expect(late.violations.map((v) => v.message)).toContain("« deux » surligné en avance de 5.0 frame(s)");

    // A word of the edit missing from the captions.
    const dropped = {
      ...edl,
      captions: edl.captions.map((c) => ({ ...c, words: c.words.filter((w) => w.text !== "trois") })),
    };
    const r = await checkCaptionSync("v.mp4", dropped, long, analysis, ".", [at(0, 0), at(1, 0), at(3, 0)]);
    expect(r.violations.map((v) => v.message)).toContain("« trois » prononcé mais pas sous-titré");
  });

  it("is not a pass when the aligner measured under half of the words (Greek, before its fix)", async () => {
    const { edl, analysis } = captioned("a.mp4", ["un", "deux", "trois", "quatre"], long, [1920, 1080]);
    const whisper = { start: 0, end: 0, timing: "whisper" as const };
    const r = await checkCaptionSync("v.mp4", edl, long, analysis, ".", [whisper, whisper, whisper, whisper]);
    expect(r.status).toBe("not-evaluated");
  });
});
