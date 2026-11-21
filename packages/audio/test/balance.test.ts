import { parseEdl } from "@cutkiller/core";
import { loadProfile } from "@cutkiller/style";
import { describe, expect, it } from "vitest";
import { balanceDialogue } from "../src/pass";

const vad = (speechDb: number) => ({
  durationS: 10,
  speech: [{ start: 0, end: 10 }],
  noiseFloorDb: -60,
  peakDb: -3,
  speechDb,
});
const words = { language: "fr", words: [{ text: "oui", start: 1, end: 1.3, timing: "forced" as const }] };

async function setup(levels: Record<string, number>) {
  const r = parseEdl({
    version: "1.4.0",
    output: { format: "long", width: 1920, height: 1080, fps: 30, video: { bitrateMbps: 12 }, audio: {} },
    sources: Object.fromEntries(Object.keys(levels).map((s) => [s, { path: `${s}.mp4`, durationS: 10 }])),
    video: [
      {
        id: "main",
        clips: Object.keys(levels).map((s, i) => ({ id: `c${i}`, source: s, in: 0, out: 3, at: i * 90 })),
      },
    ],
  });
  if (!r.ok) throw new Error("bad EDL");
  const ctx = {
    profile: await loadProfile("long"),
    analysis: {
      sources: {},
      transcripts: Object.fromEntries(Object.keys(levels).map((s) => [s, words])),
      vad: Object.fromEntries(Object.entries(levels).map(([s, l]) => [s, vad(l)])),
    },
  } as never;
  return { edl: r.edl, ctx };
}

describe("dialogue balance across rushes", () => {
  it("brings a quieter mic up to the others (median), leaves close levels alone", async () => {
    const { edl, ctx } = await setup({ cam: -18.3, lav: -18.6, far: -27.4 });
    const g = balanceDialogue(edl, ctx);
    expect(g.get("far")).toBeCloseTo(8.8, 1);
    expect(g.has("cam")).toBe(false); // 0.3 dB: under the 1 dB step
    expect(g.has("lav")).toBe(false);
  });
  it("does nothing with a single rush, and caps the gain", async () => {
    expect(balanceDialogue((await setup({ cam: -18 })).edl, (await setup({ cam: -18 })).ctx).size).toBe(0);
    const { edl, ctx } = await setup({ cam: -10, far: -50 });
    expect(Math.abs(balanceDialogue(edl, ctx).get("far") as number)).toBeLessThanOrEqual(12);
  });
});
