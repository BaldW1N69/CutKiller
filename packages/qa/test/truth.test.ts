import { type Edl, type EdlInput, parseEdl } from "@cutkiller/core";
import { loadProfile } from "@cutkiller/style";
import { beforeAll, describe, expect, it } from "vitest";
import {
  captionLabels,
  checkCaptionSyncTruth,
  checkFillersTruth,
  formatLabels,
  type Label,
  parseLabels,
} from "../src";

let short: Awaited<ReturnType<typeof loadProfile>>;
beforeAll(async () => {
  short = await loadProfile("short");
});

/** Three captions, two words each, a word every 15 frames from frame 10. */
function edl(): Edl {
  const words = ["Bonjour", "à", "tous", "on", "coupe", "silences"];
  const input: EdlInput = {
    version: "1.4.0",
    output: { format: "short", width: 1080, height: 1920, fps: 30, video: { bitrateMbps: 20 }, audio: {} },
    sources: { a: { path: "a.mp4", durationS: 10 } },
    video: [{ id: "main", clips: [{ id: "c1", source: "a", in: 0, out: 4, at: 0 }] }],
    captions: [0, 1, 2].map((k) => ({
      id: `k${k}`,
      style: "karaoke-pop@1",
      fromFrame: 10 + 30 * k,
      toFrame: 40 + 30 * k,
      words: [0, 1].map((j) => ({
        text: words[2 * k + j] as string,
        fromFrame: 10 + 30 * k + 15 * j,
        toFrame: 25 + 30 * k + 15 * j,
        line: 0,
      })),
    })),
  };
  const r = parseEdl(input);
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
  return r.edl;
}

describe("annotation humaine", () => {
  it("lit et écrit les pistes d'étiquettes Audacity", () => {
    const labels = parseLabels(
      "0,333333\t0.8\tBonjour\n\\\t200\t800\n1.000000\t1.400000\tà tous\n\n# commentaire\n",
    );
    expect(labels).toEqual([
      { start: 0.333333, end: 0.8, text: "Bonjour" },
      { start: 1, end: 1.4, text: "à tous" },
    ]);
    expect(parseLabels(formatLabels(labels))).toEqual(labels);
    expect(() => parseLabels("abc\tdef\tx")).toThrow(/illisible/);
  });

  it("exporte les mots surlignés à leurs instants", () => {
    const labels = captionLabels(edl());
    expect(labels).toHaveLength(6);
    expect(labels[1]).toEqual({ start: 25 / 30, end: 40 / 30, text: "à" });
  });

  it("mesure la synchro contre l'annotation : conforme, puis en retard", () => {
    const e = edl();
    // The editor heard each word 0,5 frame before its highlight: in sync.
    const heard: Label[] = captionLabels(e).map((l) => ({ ...l, start: l.start - 0.5 / 30 }));
    const ok = checkCaptionSyncTruth(e, short, heard);
    expect(ok.status).toBe("pass");
    expect(ok.measured).toMatchObject({ annotated: 6, p95Frames: 0.5, source: "annotation humaine" });
    // Highlights 4 frames after the annotated onsets.
    const late = checkCaptionSyncTruth(
      e,
      short,
      heard.map((l) => ({ ...l, start: l.start - 4 / 30 })),
    );
    expect(late.status).toBe("fail");
    expect(late.violations[0]?.message).toMatch(/« Bonjour » surligné en retard de 4\.5 frame/);
    // A missing label is reported, not counted as an error.
    const partial = checkCaptionSyncTruth(e, short, heard.slice(1));
    expect(partial.note).toBe("1 mot(s) sans annotation");
    expect(partial.status).toBe("pass");
  });

  it("compte les hésitations annotées comme restées dans le rendu", () => {
    const labels = [...captionLabels(edl()), { start: 1.9, end: 2.1, text: "euh" }];
    const r = checkFillersTruth(labels, short, 30);
    expect(r.status).toBe("fail");
    expect(r.violations).toEqual([{ message: "« euh » encore audible (annotation)", frame: 57 }]);
    // The hesitation label does not count as a missing caption word either.
    expect(checkCaptionSyncTruth(edl(), short, labels).status).toBe("pass");
    expect(checkFillersTruth(captionLabels(edl()), short, 30).status).toBe("pass");
  });
});
