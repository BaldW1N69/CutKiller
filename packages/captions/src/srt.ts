import type { Caption } from "@cutkiller/core";

const stamp = (frames: number, fps: number) => {
  const ms = Math.round((frames / fps) * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor(ms / 60_000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms % 1000, 3)}`;
};

/** SubRip file of the captions (one cue per screen, its lines kept), for platforms' own subtitle tracks. */
export function toSrt(captions: readonly Caption[], fps: number): string {
  return captions
    .map((c, i) => {
      const lines: string[] = [];
      for (const w of c.words) lines[w.line] = lines[w.line] ? `${lines[w.line]} ${w.text}` : w.text;
      return `${i + 1}\n${stamp(c.fromFrame, fps)} --> ${stamp(c.toFrame, fps)}\n${lines.filter(Boolean).join("\n")}\n`;
    })
    .join("\n");
}
