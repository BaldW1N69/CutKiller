import { type Activity, type Analysis, parseEdl } from "@cutkiller/core";
import { loadProfile } from "@cutkiller/style";
import { describe, expect, it } from "vitest";
import { screenZoomPass } from "../src/index";

/** 8 s of activity: a small change top-left for 4 s, then bottom-right (5 samples/s). */
function activity(): Activity {
  const samples: Activity["samples"] = [];
  for (let i = 1; i < 40; i++) {
    const t = i / 5;
    const [cx, cy] = t < 4 ? [0.15, 0.28] : [0.82, 0.78];
    samples.push({ t, fraction: 0.0006, cx, cy, w: 0.03, h: 0.02 });
  }
  // The sample where the action jumps: the change spans both places.
  samples[19] = { t: 4, fraction: 0.001, cx: 0.48, cy: 0.53, w: 0.7, h: 0.5 };
  return { fps: 5, width: 1920, height: 1080, samples };
}

function edl() {
  const r = parseEdl({
    version: "1.5.0",
    output: { format: "long", width: 1920, height: 1080, fps: 30, video: { bitrateMbps: 20 }, audio: {} },
    sources: { s: { path: "screen.mp4", durationS: 8, width: 1920, height: 1080 } },
    video: [{ id: "main", clips: [{ id: "c1", source: "s", in: 0, out: 8, at: 0 }] }],
  });
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
  return r.edl;
}

describe("screen zoom", () => {
  it("pushes in on the action, follows it without stopping halfway, stays inside the picture", async () => {
    const profile = await loadProfile("tutorial");
    const analysis: Analysis = { sources: {}, activity: { s: activity() } };
    const out = screenZoomPass.run(edl(), { analysis, profile }).edl;
    const track = (p: string) => out.keyframes.find((k) => k.target === `c1.${p}`);
    const scale = track("scale");
    const x = track("x");
    expect(scale?.role).toBe("move");
    expect(scale?.keys.map((k) => k.value)).toEqual([1, 1, 1.6, 1.6, 1.6]);
    // In on the top-left (x clamped to (k−1)/2 = 0.3), then straight to the bottom-right.
    expect(x?.keys.map((k) => k.value)).toEqual([0, 0, 0.3, 0.3, -0.3]);
    for (const t of out.keyframes) for (const k of t.keys.slice(1)) expect(k.ease).toBe("ease-in-out");
    const moveFrames = (x?.keys[2]?.frame ?? 0) - (x?.keys[1]?.frame ?? 0);
    expect(moveFrames).toBe(18); // 0.6 s at 30 fps
  });

  it("does nothing outside the tutorial profile", async () => {
    const profile = await loadProfile("long");
    const out = screenZoomPass.run(edl(), {
      analysis: { sources: {}, activity: { s: activity() } },
      profile,
    }).edl;
    expect(out.keyframes).toEqual([]);
  });
});
