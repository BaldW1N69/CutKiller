import type { Analysis, Edl } from "@cutkiller/core";

/** Music beats projected onto the output timeline (frames), from the EDL's audio clips. */
export function timelineBeats(edl: Edl, analysis: Pick<Analysis, "beats">): number[] {
  const fps = edl.output.fps;
  const out: number[] = [];
  for (const track of edl.audio)
    for (const clip of track.clips) {
      const grid = clip.source === undefined ? undefined : analysis.beats?.[clip.source];
      if (!grid) continue;
      for (const b of grid.beats) if (b >= clip.in && b <= clip.out) out.push(clip.at + (b - clip.in) * fps);
    }
  return out.sort((a, b) => a - b);
}
