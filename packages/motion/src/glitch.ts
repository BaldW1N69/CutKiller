/** Small deterministic PRNG (mulberry32): the same seed always glitches the same way. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Glitch on a 4-byte-per-pixel frame (BGRA or RGBA, red and blue channels are
 * the two outer ones): red/blue split horizontally, then a few bands of rows
 * shifted sideways. Works in place.
 */
export function applyGlitch(frame: Buffer, W: number, H: number, intensity: number, seed: number): void {
  const random = rng(seed);
  const src = Buffer.from(frame);
  const split = Math.round(intensity * 0.02 * W);
  // Channel split: channel 0 pulled from the left, channel 2 from the right.
  if (split > 0) {
    for (let y = 0; y < H; y++) {
      const row = y * W * 4;
      for (let x = 0; x < W; x++) {
        const o = row + x * 4;
        frame[o] = src[row + Math.max(0, x - split) * 4] as number;
        frame[o + 2] = src[row + Math.min(W - 1, x + split) * 4 + 2] as number;
      }
    }
  }
  const after = Buffer.from(frame);
  const bands = 3 + Math.floor(random() * 5);
  for (let b = 0; b < bands; b++) {
    const y0 = Math.floor(random() * H);
    const h = Math.max(2, Math.floor((0.02 + random() * 0.06) * H));
    const shift = Math.round((random() * 2 - 1) * intensity * 0.08 * W);
    for (let y = y0; y < Math.min(H, y0 + h); y++) {
      const row = y * W * 4;
      for (let x = 0; x < W; x++) {
        const sx = Math.min(W - 1, Math.max(0, x - shift));
        after.copy(frame, row + x * 4, row + sx * 4, row + sx * 4 + 4);
      }
    }
  }
}
