import { loadProfile } from "@cutkiller/style";
import { describe, expect, it } from "vitest";
import { cellLuminances, flashBursts, luminanceChanges, phaseCorrelations } from "../src";
import { checkTail } from "../src/checks/montage";

describe("image.flashes (WCAG 2.3.1)", () => {
  it("counts a strobe as flashes, a cut from dark to bright as one change", () => {
    const strobe = Array.from({ length: 30 }, (_, f) => (f % 4 < 2 ? 0.02 : 0.9));
    const changes = luminanceChanges(strobe);
    expect(changes.length).toBeGreaterThanOrEqual(14);
    expect(flashBursts(changes, 30)).not.toHaveLength(0);
    const cut = [...Array(15).fill(0.05), ...Array(15).fill(0.9)];
    expect(luminanceChanges(cut)).toEqual([15]);
    expect(flashBursts(luminanceChanges(cut), 30)).toEqual([]);
  });

  it("allows up to 3 flashes per second, and ignores small or very bright swings", () => {
    // 3 flashes in one second (6 changes), then still.
    const three = Array.from({ length: 60 }, (_, f) => (f < 30 && f % 10 < 5 ? 0.6 : 0.1));
    expect(flashBursts(luminanceChanges(three), 30)).toEqual([]);
    const small = Array.from({ length: 30 }, (_, f) => (f % 2 ? 0.3 : 0.35));
    expect(luminanceChanges(small)).toEqual([]);
    // Both states over 0.8: not a flash under WCAG (the darker one is too bright).
    const bright = Array.from({ length: 30 }, (_, f) => (f % 2 ? 0.82 : 0.98));
    expect(luminanceChanges(bright)).toEqual([]);
  });

  it("measures relative luminance per cell (white top-left cell, black elsewhere)", () => {
    const frame = Buffer.alloc(48 * 27 * 3);
    for (let y = 0; y < 9; y++)
      for (let x = 0; x < 16; x++) frame.fill(255, (y * 48 + x) * 3, (y * 48 + x) * 3 + 3);
    const cells = cellLuminances(frame);
    expect(cells[0]).toBeCloseTo(1, 5);
    expect(cells.slice(1).every((c) => c === 0)).toBe(true);
  });
});

describe("audio.phase", () => {
  const stereo = (rate: number, seconds: number, invertRight: boolean) => {
    const out = new Float32Array(rate * seconds * 2);
    for (let i = 0; i < rate * seconds; i++) {
      const v = 0.3 * Math.sin((2 * Math.PI * 220 * i) / rate);
      out[2 * i] = v;
      out[2 * i + 1] = invertRight ? -v : v;
    }
    return out;
  };

  it("+1 for a centred voice, -1 when one side is inverted, null on silence", () => {
    expect(phaseCorrelations(stereo(16_000, 1, false), 16_000).every((c) => c !== null && c > 0.99)).toBe(
      true,
    );
    expect(phaseCorrelations(stereo(16_000, 1, true), 16_000).every((c) => c !== null && c < -0.99)).toBe(
      true,
    );
    expect(phaseCorrelations(new Float32Array(16_000 * 2), 16_000).every((c) => c === null)).toBe(true);
  });
});

describe("montage.tail", () => {
  const vad = (lastEnd: number, durationS: number) => ({
    durationS,
    speech: [{ start: 0.2, end: lastEnd }],
    noiseFloorDb: -60,
    peakDb: -6,
  });

  it("passes a clean ending, fails 3 s of dead air", async () => {
    const long = await loadProfile("long");
    expect((await checkTail("x.mp4", long, vad(59.5, 60))).status).toBe("pass");
    const late = await checkTail("x.mp4", long, vad(57, 60));
    expect(late.status).toBe("fail");
    expect(late.measured).toMatchObject({ tailS: 3 });
  });
});
