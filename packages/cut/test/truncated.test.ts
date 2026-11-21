import { truncatedEdges } from "@cutkiller/core";
import { loadProfile } from "@cutkiller/style";
import { describe, expect, it } from "vitest";
import { speechTokens } from "../src";

const vad = (start: number, end: number) => ({
  durationS: 60.008,
  speech: [{ start: 0, end: 60 }],
  noiseFloorDb: -55.5,
  peakDb: -6,
  speechDb: -18.6,
  edgeDb: { start, end },
});
const word = (text: string, start: number, end: number) => ({ text, start, end, timing: "forced" as const });

describe("words cut off by the recording", () => {
  it("tells a word cut off by the end of the file from one that fades out (measured levels)", () => {
    expect(truncatedEdges(vad(-57.3, -24.7)).end).toBe(true); // « pour… » still loud on the last 30 ms
    expect(truncatedEdges(vad(-57.3, -41.1)).end).toBe(false); // « 6h. » faded 22 dB
    expect(truncatedEdges(undefined)).toEqual({ start: false, end: false });
  });

  it("never keeps the cut-off word", async () => {
    const words = [word("heures", 59.42, 59.78), word("pour...", 59.81, 60)];
    const { tokens } = speechTokens(
      words,
      [{ start: 0, end: 60 }],
      await loadProfile("short"),
      vad(-57.3, -24.7),
    );
    expect(tokens.map((t) => [t.word.text, t.removed])).toEqual([
      ["heures", undefined],
      ["pour...", "truncated"],
    ]);
    const faded = speechTokens(words, [{ start: 0, end: 60 }], await loadProfile("short"), vad(-57.3, -41.1));
    expect(faded.tokens.every((t) => !t.removed)).toBe(true);
  });

  it("drops an edge word the aligner could not fit, even on a quiet edge (cut in a stop)", async () => {
    const words = [
      word("de", 59.78, 59.86),
      { ...word("escuro", 59.86, 60.005), alignScore: 0.331 }, // LibriVox pt, cut in « es|curo »
    ];
    const quiet = { ...vad(-57.3, -48), durationS: 60.032 };
    const { tokens } = speechTokens(words, [{ start: 0, end: 60.032 }], await loadProfile("long"), quiet);
    expect(tokens.map((t) => t.removed)).toEqual([undefined, "truncated"]);
    const fit = speechTokens(
      [word("de", 59.5, 59.58), { ...word("escuro", 59.6, 60.0), alignScore: 0.95 }],
      [{ start: 0, end: 60.032 }],
      await loadProfile("long"),
      quiet,
    );
    expect(fit.tokens.every((t) => !t.removed)).toBe(true);
  });
});
