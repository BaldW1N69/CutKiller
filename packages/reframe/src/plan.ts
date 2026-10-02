import type { Ease, Face, Subjects } from "@cutkiller/core";

export interface CameraSettings {
  deadZone: number;
  minDriftS: number;
  smoothingS: number;
  moveS: [number, number];
  /** Shortest move over a distance (source fraction) that keeps the camera's acceleration in bounds. */
  minMoveS?: (distance: number) => number;
}

/** A camera position at a time (seconds, on the clip's own timeline from 0). */
export interface CameraKey {
  t: number;
  value: number;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? Number.NaN : (s[Math.floor(s.length / 2)] as number);
};

/**
 * Subject position along an axis for each sample of a source between two times:
 * the face kept from one sample to the next (nearest to the previous one, the
 * largest to start), its centre (x) or eye line (y). NaN where no face is seen.
 */
export function subjectTrack(
  subjects: Subjects,
  axis: "x" | "y",
  from: number,
  to: number,
): { t: number; value: number }[] {
  const out: { t: number; value: number }[] = [];
  let prev: Face | undefined;
  for (const s of subjects.samples) {
    if (s.t < from - 1e-6 || s.t > to + 1e-6) continue;
    let face: Face | undefined;
    if (s.faces.length > 0) {
      const area = (f: Face) => f.w * f.h;
      face = prev
        ? s.faces.reduce((a, b) =>
            Math.hypot(a.x - prev!.x, a.y - prev!.y) - area(a) <=
            Math.hypot(b.x - prev!.x, b.y - prev!.y) - area(b)
              ? a
              : b,
          )
        : s.faces.reduce((a, b) => (area(a) >= area(b) ? a : b));
      prev = face;
    }
    const value = face ? (axis === "x" ? face.x + face.w / 2 : face.y + face.h * 0.4) : Number.NaN;
    out.push({ t: s.t - from, value });
  }
  return out;
}

/**
 * Virtual camera over one shot: holds still while the (median-filtered) subject
 * stays within the dead zone around the crop centre. When it has drifted out for
 * `minDriftS` (a glance does not move the camera), the camera glides to where the
 * subject settles. The edit knows the future, so the glide is laid over the
 * subject's own move: same midpoint, as long as the subject's move (never faster
 * than `minMoveS` allows), instead of chasing it late. Positions and dead zone are
 * fractions of the source along the axis; `crop` is the crop's size in the same
 * unit. Returns hold/move keys (seconds from the start of the shot), or undefined
 * when the subject is never seen.
 */
export function planCamera(
  track: { t: number; value: number }[],
  crop: number,
  duration: number,
  cfg: CameraSettings,
): CameraKey[] | undefined {
  const seen = track.filter((p) => Number.isFinite(p.value));
  if (seen.length === 0) return undefined;
  // Fill gaps (face missed for a moment) with the nearest sighting, then median-filter.
  const filled = track.map((p) => {
    if (Number.isFinite(p.value)) return p;
    const near = seen.reduce((a, b) => (Math.abs(a.t - p.t) <= Math.abs(b.t - p.t) ? a : b));
    return { t: p.t, value: near.value };
  });
  const half = cfg.smoothingS / 2;
  const smooth = filled.map((p) => ({
    t: p.t,
    value: median(filled.filter((q) => Math.abs(q.t - p.t) <= half).map((q) => q.value)),
  }));
  const settle = (from: number, span: number) =>
    median(smooth.filter((q) => q.t >= from - 1e-6 && q.t <= from + span).map((q) => q.value));

  let pos = settle(0, 1);
  const keys: CameraKey[] = [{ t: 0, value: pos }];
  const dz = cfg.deadZone * crop;
  // "At" a position: within a quarter of the dead zone.
  const still = dz / 4;
  let driftStart: number | undefined;
  let busyUntil = 0;
  for (const p of smooth) {
    if (p.t < busyUntil) continue;
    if (Math.abs(p.value - pos) <= dz) {
      driftStart = undefined;
      continue;
    }
    driftStart ??= p.t;
    if (p.t - driftStart < cfg.minDriftS) continue;
    const drift = driftStart;
    const target = settle(p.t, 1);
    const distance = Math.abs(target - pos);
    const last = (keys.at(-1) as CameraKey).t;
    // The subject's move: last seen at the camera position → first seen at the target.
    let onset = Math.max(last, drift - cfg.moveS[1]);
    for (const q of smooth) if (q.t >= onset && q.t < drift && Math.abs(q.value - pos) <= still) onset = q.t;
    const arrive = smooth.find((q) => q.t >= drift && Math.abs(q.value - target) <= still)?.t ?? p.t;
    // Its midpoint: where it crosses half the distance (interpolated between samples).
    let mid = (onset + arrive) / 2;
    for (let k = 1; k < smooth.length; k++) {
      const a = smooth[k - 1] as CameraKey;
      const b = smooth[k] as CameraKey;
      if (b.t < onset || a.t > arrive) continue;
      const da = Math.abs(a.value - pos);
      const db = Math.abs(b.value - pos);
      if (da < distance / 2 && db >= distance / 2) {
        mid = a.t + ((b.t - a.t) * (distance / 2 - da)) / (db - da || 1);
        break;
      }
    }
    // The acceleration bound wins over the longest move.
    const dur = Math.max(
      Math.min(cfg.moveS[1], Math.max(cfg.moveS[0], arrive - onset)),
      cfg.minMoveS?.(distance) ?? 0,
    );
    // Within the shot: a move near the end starts earlier; with no room left, the next cut reframes.
    const start = Math.max(last, Math.min(mid - dur / 2, duration - dur));
    if (start + dur > duration + 1e-6) break;
    const end = start + dur;
    if (start > last + 1e-6) keys.push({ t: start, value: pos });
    keys.push({ t: end, value: target });
    pos = target;
    busyUntil = end;
    driftStart = undefined;
  }
  return keys;
}

export type { Ease };
