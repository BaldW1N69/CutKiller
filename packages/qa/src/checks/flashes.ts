import { tr } from "@cutkiller/core";
import { ffprobe, mediaInput, parseRate } from "@cutkiller/media";
import { streamFrames } from "../decode";
import { type CheckResult, graded, type Violation } from "../report";

/**
 * WCAG 2.3.1 « three flashes or below threshold » (general flash): a flash is a
 * pair of opposing changes in relative luminance of 10 % or more of the maximum,
 * where the darker state is under 0.80; no more than 3 flashes in any second.
 * The area condition (25 % of a 10° field, about a ninth of a screen seen from
 * a normal distance) is approximated by a 3 × 3 grid: a flash counts when one
 * cell flashes as a whole.
 */
export const FLASH_DELTA = 0.1;
export const FLASH_DARK_MAX = 0.8;
export const MAX_FLASHES_PER_SECOND = 3;
const GRID = 3;
const CELL_W = 16;
const CELL_H = 9;

/** sRGB 0–255 to linear light (WCAG relative luminance). */
const LINEAR = Array.from({ length: 256 }, (_, v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

/** Mean relative luminance of each grid cell of an RGB24 frame of GRID·CELL_W × GRID·CELL_H. */
export function cellLuminances(frame: Buffer): number[] {
  const w = GRID * CELL_W;
  const out = new Array<number>(GRID * GRID).fill(0);
  for (let y = 0; y < GRID * CELL_H; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const lum =
        0.2126 * (LINEAR[frame[i] as number] as number) +
        0.7152 * (LINEAR[frame[i + 1] as number] as number) +
        0.0722 * (LINEAR[frame[i + 2] as number] as number);
      const cell = Math.floor(y / CELL_H) * GRID + Math.floor(x / CELL_W);
      out[cell] = (out[cell] as number) + lum;
    }
  return out.map((v) => v / (CELL_W * CELL_H));
}

/**
 * Frames at which a luminance series completes a change (a swing of at least
 * FLASH_DELTA from the last extreme, the opposite way to the previous change,
 * with the darker end under FLASH_DARK_MAX). Two changes make one flash.
 */
export function luminanceChanges(series: readonly number[]): number[] {
  const changes: number[] = [];
  if (series.length === 0) return changes;
  const first = series[0] as number;
  let lo = first;
  let hi = first;
  let ref = first; // extreme reached since the last change
  let direction = 0; // +1 after a rise, -1 after a fall, 0 before any change
  const change = (f: number, dir: number, v: number) => {
    changes.push(f);
    direction = dir;
    ref = v;
  };
  for (let f = 1; f < series.length; f++) {
    const v = series[f] as number;
    if (direction === 0) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
      if (v - lo >= FLASH_DELTA && lo < FLASH_DARK_MAX) change(f, 1, v);
      else if (hi - v >= FLASH_DELTA && v < FLASH_DARK_MAX) change(f, -1, v);
    } else if (direction === 1) {
      ref = Math.max(ref, v);
      if (ref - v >= FLASH_DELTA && v < FLASH_DARK_MAX) change(f, -1, v);
    } else {
      ref = Math.min(ref, v);
      if (v - ref >= FLASH_DELTA && ref < FLASH_DARK_MAX) change(f, 1, v);
    }
  }
  return changes;
}

/** Start frames of the one-second windows holding more than MAX_FLASHES_PER_SECOND flashes. */
export function flashBursts(changes: readonly number[], fps: number): { frame: number; flashes: number }[] {
  const window = Math.round(fps);
  const bursts: { frame: number; flashes: number }[] = [];
  let lastEnd = -1;
  for (let i = 0; i < changes.length; i++) {
    const start = changes[i] as number;
    let j = i;
    while (j + 1 < changes.length && (changes[j + 1] as number) < start + window) j++;
    const flashes = Math.floor((j - i + 1) / 2);
    if (flashes > MAX_FLASHES_PER_SECOND && start > lastEnd) {
      bursts.push({ frame: start, flashes });
      lastEnd = start + window;
    }
  }
  return bursts;
}

/** No flashing over the WCAG general flash threshold anywhere in the render. */
export async function checkFlashes(video: string): Promise<CheckResult> {
  const info = await ffprobe(video);
  const fps = parseRate(info.streams.find((s) => s.codec_type === "video")?.avg_frame_rate) ?? 30;
  const cells: number[][] = Array.from({ length: GRID * GRID }, () => []);
  const frames = await streamFrames(
    [
      ...mediaInput(video),
      "-map",
      "0:v:0",
      "-vf",
      `scale=${GRID * CELL_W}:${GRID * CELL_H}:flags=area,format=rgb24`,
      "-f",
      "rawvideo",
      "-",
    ],
    GRID * CELL_W * GRID * CELL_H * 3,
    (f) => cellLuminances(f).forEach((v, k) => cells[k]?.push(v)),
  );
  const bursts = cells.flatMap((series) => flashBursts(luminanceChanges(series), fps));
  bursts.sort((a, b) => a.frame - b.frame);
  // One violation per second of flashing, whichever cells flash.
  const violations: Violation[] = [];
  for (const b of bursts) {
    const last = violations.at(-1)?.frame ?? Number.NEGATIVE_INFINITY;
    if (b.frame < last + fps) continue;
    violations.push({
      message: tr(
        `${b.flashes} flashes within one second (limit ${MAX_FLASHES_PER_SECOND}, photosensitive seizure risk)`,
        `${b.flashes} flashs en une seconde (limite ${MAX_FLASHES_PER_SECOND}, risque de crise photosensible)`,
      ),
      frame: b.frame,
    });
  }
  const seconds = Math.max(1, Math.ceil(frames / fps));
  return graded("image.flashes", seconds, violations, {
    seconds,
    flashingSeconds: violations.length,
  });
}
