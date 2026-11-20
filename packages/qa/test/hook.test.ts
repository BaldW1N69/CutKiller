import { loadProfile } from "@cutkiller/style";
import { describe, expect, it } from "vitest";

const vad = (speech: { start: number; end: number }[]) => ({
  speech,
  durationS: 10,
  noiseFloorDb: -60,
  peakDb: -3,
});

import { checkHook } from "../src/checks/montage";

describe("hook (montage.hook)", () => {
  it("passes when the voice comes in early, fails after the profile's limit", async () => {
    const short = await loadProfile("short"); // 1 s
    const early = await checkHook("v.mp4", short, vad([{ start: 0.35, end: 2 }]));
    expect(early.status).toBe("pass");
    const late = await checkHook("v.mp4", short, vad([{ start: 1.8, end: 3 }]));
    expect(late.status).toBe("fail");
    expect(late.violations[0]?.message).toMatch(/1[.,]80/);
    const cinematic = await loadProfile("cinematic"); // 5 s: room for an intro
    expect((await checkHook("v.mp4", cinematic, vad([{ start: 1.8, end: 3 }]))).status).toBe("pass");
  });

  it("is not evaluated when no voice is heard", async () => {
    expect((await checkHook("v.mp4", await loadProfile("short"), vad([]))).status).toBe("not-evaluated");
  });
});
