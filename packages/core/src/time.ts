/**
 * Frame/second conversions. Timeline positions are integer frames at the output
 * frame rate; source positions are seconds. Every conversion rounds through
 * integer ticks (idea from OpenCut's MediaTime) so repeated conversions never drift.
 */
export const TICKS_PER_SECOND = 120_000;

export function secondsToTicks(seconds: number): number {
  return Math.round(seconds * TICKS_PER_SECOND);
}

export function ticksToSeconds(ticks: number): number {
  return ticks / TICKS_PER_SECOND;
}

export function framesToSeconds(frames: number, fps: number): number {
  return ticksToSeconds(Math.round((frames * TICKS_PER_SECOND) / fps));
}

/** Nearest frame index for a time in seconds (ties round up). */
export function secondsToFrames(seconds: number, fps: number): number {
  return Math.floor((secondsToTicks(seconds) * fps) / TICKS_PER_SECOND + 0.5);
}

/** Round a source time to millisecond precision, the EDL's storage precision. */
export function roundMs(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}
