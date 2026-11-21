import { type EdlInput, parseEdl } from "@cutkiller/core";
import { loadProfile } from "@cutkiller/style";
import { describe, expect, it } from "vitest";
import { checkSharpness } from "../src";

const edlOf = (width: number, height: number, punch = 1) => {
  const input: EdlInput = {
    version: "1.5.0",
    output: { format: "short", width: 1080, height: 1920, fps: 30, video: { bitrateMbps: 20 }, audio: {} },
    sources: {
      a: { path: "a.mp4", durationS: 10, width, height },
      b: { path: "b.mp4", durationS: 10, width: 3840, height: 2160 },
    },
    video: [
      {
        id: "main",
        clips: [
          { id: "c1", source: "a", in: 0, out: 4, at: 0 },
          { id: "c2", source: "b", in: 0, out: 2, at: 120 },
        ],
      },
    ],
    keyframes:
      punch > 1
        ? [
            {
              target: "c1.scale",
              role: "move",
              keys: [
                { frame: 10, value: 1 },
                { frame: 37, value: punch, ease: "ease-in-out" },
              ],
            },
          ]
        : [],
  };
  const r = parseEdl(input);
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
  return r.edl;
};

describe("netteté (image.sharpness)", () => {
  it("accepte un 1080p recadré en 9:16 (×1,78), refuse un 640×360 (×5,3), pondéré par la durée", async () => {
    const short = await loadProfile("cinematic-short");
    const ok = checkSharpness(edlOf(1920, 1080), short);
    expect(ok.status).toBe("pass");
    expect(ok.measured?.maxUpscale).toBe(1.78);
    const soft = checkSharpness(edlOf(640, 360), short);
    expect(soft.status).toBe("fail");
    expect(soft.violations[0]?.message).toBe(
      "c1 : image agrandie ×5.33 (source 640×360 → 1080×1920), max ×2",
    );
    // c1 is 4 s of 6: two thirds of the timeline soft.
    expect(soft.score).toBeCloseTo(1 / 3, 6);
  });

  it("compte la poussée animée : un 1080p poussé à 120 % dépasse ×2 (cinematic), pas ×2,2 (short)", async () => {
    const r = checkSharpness(edlOf(1920, 1080, 1.2), await loadProfile("cinematic-short"));
    expect(r.measured?.maxUpscale).toBe(2.13);
    expect(r.status).toBe("fail");
    expect(checkSharpness(edlOf(1920, 1080, 1.2), await loadProfile("short")).status).toBe("pass");
  });
});
