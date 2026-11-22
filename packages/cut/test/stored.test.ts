import { clipFrames } from "@cutkiller/core";
import { describe, expect, it } from "vitest";
import { stored } from "../src";

describe("clip points written to the EDL", () => {
  it("keep the planned frame count after rounding to the µs (Dutch reading: 91.49999 → 92 frames)", () => {
    const p = stored(2.10500001, 5.15499999, 91, 30);
    expect(clipFrames(p, 30)).toBe(91);
    expect(Math.abs(p.out - 5.155)).toBeLessThan(2e-5);
  });

  it("leave clean points untouched", () => {
    expect(stored(1, 2.5, 45, 30)).toEqual({ in: 1, out: 2.5 });
  });
});
