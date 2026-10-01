import { describe, expect, it } from "vitest";
import {
  animationIndex,
  animStateAt,
  cubicBezierAt,
  displacement,
  type EdlInput,
  easeOvershoot,
  easeProgress,
  easeShape,
  maxAnimatedScale,
  NAMED_EASES,
  parseEdl,
  REST_STATE,
  springAt,
  springOvershoot,
  trackValue,
} from "../src";

describe("courbes", () => {
  it("évalue un cubic-bezier CSS (valeurs de référence)", () => {
    expect(cubicBezierAt(NAMED_EASES.linear, 0.3)).toBeCloseTo(0.3, 6);
    expect(cubicBezierAt(NAMED_EASES.ease, 0.5)).toBeCloseTo(0.8024, 3);
    expect(cubicBezierAt(NAMED_EASES["ease-in"], 0.5)).toBeCloseTo(0.3153, 3);
    expect(cubicBezierAt(NAMED_EASES["ease-out"], 0.5)).toBeCloseTo(0.6847, 3);
    expect(cubicBezierAt(NAMED_EASES["ease-in-out"], 0.5)).toBeCloseTo(0.5, 6);
  });

  it("un ressort sous-amorti dépasse de exp(-ζπ/√(1-ζ²)) et se pose sur 1", () => {
    const spring = { stiffness: 1310, damping: 50, mass: 1 };
    expect(springOvershoot(spring)).toBeCloseTo(0.0497, 3);
    expect(easeOvershoot({ spring }, 0.2)).toBeCloseTo(0.0497, 2);
    expect(springAt(spring, 1)).toBeCloseTo(1, 4);
    expect(springOvershoot({ stiffness: 100, damping: 40, mass: 1 })).toBe(0);
  });

  it("distingue entrées (décélérées) et sorties (accélérées)", () => {
    expect(easeShape("ease-out-cubic", 0.3)).toBe("decelerating");
    expect(easeShape("ease-in-cubic", 0.3)).toBe("accelerating");
    expect(easeShape("ease-in-out", 0.3)).toBe("symmetric");
    expect(easeShape({ spring: { stiffness: 830, damping: 39.8, mass: 1 } }, 0.25)).toBe("decelerating");
    expect(easeProgress("hold", 0.7, 1)).toBe(0);
  });
});

describe("keyframes", () => {
  const input: EdlInput = {
    version: "1.1.0",
    output: { format: "short", width: 1080, height: 1920, fps: 30, video: { bitrateMbps: 20 }, audio: {} },
    sources: { a: { path: "a.mp4", durationS: 10 } },
    video: [{ id: "main", clips: [{ id: "c1", source: "a", in: 0, out: 2, at: 0 }] }],
    keyframes: [
      {
        target: "c1.scale",
        keys: [
          { frame: 10, value: 1 },
          { frame: 16, value: 1.1, ease: "ease-out" },
        ],
      },
      {
        target: "c1.x",
        keys: [
          { frame: 30, value: 0 },
          { frame: 40, value: 0.5, ease: "ease-in-out" },
        ],
      },
    ],
  };

  it("tient la première/dernière valeur hors des clés et interpole avec la courbe", () => {
    const r = parseEdl(input);
    if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
    const track = r.edl.keyframes[0]!;
    expect(trackValue(track, 0, 30)).toBe(1);
    expect(trackValue(track, 50, 30)).toBeCloseTo(1.1, 9);
    expect(trackValue(track, 13, 30)).toBeCloseTo(1 + 0.1 * cubicBezierAt(NAMED_EASES["ease-out"], 0.5), 9);
    const index = animationIndex(r.edl);
    expect(animStateAt(index, "c1", 35, 30)).toMatchObject({ scale: 1.1, x: 0.25, opacity: 1 });
    expect(animStateAt(index, "other", 35, 30)).toEqual(REST_STATE);
    expect(maxAnimatedScale(index, "c1", 30)).toBeCloseTo(1.1, 6);
  });

  it("mesure le déplacement à l'écran (coins du calque)", () => {
    const moved = { ...REST_STATE, x: 0.01 };
    expect(displacement(1080, 1920, REST_STATE, moved)).toBeCloseTo(10.8, 6);
    const zoomed = { ...REST_STATE, scale: 1.01 };
    expect(displacement(1080, 1920, REST_STATE, zoomed)).toBeCloseTo(0.01 * Math.hypot(540, 960), 6);
  });

  it("refuse une animation hors de son clip et une transition hors d'une coupe", () => {
    const outside = parseEdl({
      ...input,
      keyframes: [
        {
          target: "c1.scale",
          keys: [
            { frame: 50, value: 1 },
            { frame: 70, value: 1.1, ease: "ease-out" },
          ],
        },
      ],
    });
    expect(outside.diagnostics.map((d) => d.code)).toContain("keyframes.range");
    const noCut = parseEdl({
      ...input,
      transitions: [{ id: "t", atFrame: 30, preset: "whip-pan@1", durationFrames: 9 }],
    });
    expect(noCut.diagnostics.map((d) => d.code)).toContain("transition.cut");
  });
});
