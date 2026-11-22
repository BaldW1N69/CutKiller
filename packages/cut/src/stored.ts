import { clipFrames } from "@cutkiller/core";

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

/**
 * In and out points as written to the EDL (µs), still spanning exactly `frames`
 * frames: rounding 2.10500001 → 5.15499999 to µs turns 91.49999 frames into
 * 91.5, read back as 92, and the clip overlaps the next one by a frame
 * (measured on a Dutch reading). The out point moves by a few µs at most.
 */
export function stored(inS: number, outS: number, frames: number, fps: number): { in: number; out: number } {
  const a = round6(inS);
  let b = round6(outS);
  for (let k = 0; k < 20 && clipFrames({ in: a, out: b }, fps) > frames; k++) b = round6(b - 1e-6);
  for (let k = 0; k < 20 && clipFrames({ in: a, out: b }, fps) < frames; k++) b = round6(b + 1e-6);
  return { in: a, out: b };
}
