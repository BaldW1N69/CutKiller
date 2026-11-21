import { parseEdl } from "@cutkiller/core";
import { loadProfile } from "@cutkiller/style";
import { describe, expect, it } from "vitest";
import { checkWholeWords } from "../src/checks/montage";

const word = (text: string, start: number, end: number) => ({ text, start, end, timing: "forced" as const });
const analysis = {
  sources: {},
  transcripts: {
    a: {
      language: "fr",
      words: [
        word("Bonjour", 0.5, 0.9),
        word("à", 1.0, 1.1),
        word("tous.", 1.15, 1.6),
        word("Entre", 2.0, 2.4),
      ],
    },
  },
} as never;

function edlEnding(out: number) {
  const r = parseEdl({
    version: "1.4.0",
    output: { format: "short", width: 1080, height: 1920, fps: 30, video: { bitrateMbps: 20 }, audio: {} },
    sources: { a: { path: "a.mp4", durationS: 10 } },
    video: [
      {
        id: "main",
        clips: [{ id: "c1", source: "a", in: 0.4, out, at: 0, why: { kind: "speech", wordIds: [0, 1, 2] } }],
      },
    ],
  });
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
  return r.edl;
}

describe("whole words (montage.whole-words)", () => {
  it("passes when the edit ends between words", async () => {
    expect(checkWholeWords(edlEnding(1.7), await loadProfile("short"), analysis).status).toBe("pass");
  });
  it("fails when the edit ends inside the next word (a clipped first syllable)", async () => {
    const r = checkWholeWords(edlEnding(2.1), await loadProfile("short"), analysis);
    expect(r.status).toBe("fail");
    expect(r.violations[0]?.message).toContain("Entre");
  });
  it("tolerates alignment noise of 20 ms", async () => {
    expect(checkWholeWords(edlEnding(2.015), await loadProfile("short"), analysis).status).toBe("pass");
  });
});
