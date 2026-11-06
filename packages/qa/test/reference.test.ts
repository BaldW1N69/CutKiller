import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ffmpeg } from "@cutkiller/media";
import { beforeAll, describe, expect, it } from "vitest";
import { compareFingerprints, type Fingerprint, fingerprint, fingerprintMarkdown } from "../src";

let colour: Fingerprint;
let grey: Fingerprint;
let boxed: Fingerprint;

/** Three 2 s shots (moving test patterns of different hues) with a tone, optionally graded. */
async function clip(path: string, vf: string): Promise<void> {
  await ffmpeg([
    "-v",
    "error",
    ...["-f", "lavfi", "-i", "testsrc2=s=640x360:r=24:d=2"],
    ...["-f", "lavfi", "-i", "smptehdbars=s=640x360:r=24:d=2"],
    ...["-f", "lavfi", "-i", "mandelbrot=s=640x360:r=24"],
    ...["-f", "lavfi", "-i", "sine=f=440:d=6:sample_rate=48000"],
    "-filter_complex",
    `[2]trim=duration=2,setpts=PTS-STARTPTS[m];[0][1][m]concat=n=3:v=1:a=0,${vf},format=yuv420p[v]`,
    ...[
      "-map",
      "[v]",
      "-map",
      "3:a",
      "-c:v",
      "libx264",
      "-crf",
      "18",
      "-c:a",
      "aac",
      "-shortest",
      "-y",
      path,
    ],
  ]);
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "ck-ref-"));
  await clip(join(dir, "colour.mp4"), "null");
  await clip(join(dir, "grey.mp4"), "hue=s=0");
  await clip(
    join(dir, "boxed.mp4"),
    "drawbox=x=0:y=0:w=iw:h=46:color=black:t=fill,drawbox=x=0:y=ih-46:w=iw:h=46:color=black:t=fill",
  );
  const prints = await Promise.all(
    ["colour", "grey", "boxed"].map((n) => fingerprint(join(dir, `${n}.mp4`))),
  );
  [colour, grey, boxed] = prints as [Fingerprint, Fingerprint, Fingerprint];
}, 120_000);

describe("empreinte de style d'une vidéo de référence", () => {
  it("compte les plans : 3 plans de 2 s, 2 coupes", () => {
    expect(colour.cuts).toBe(2);
    expect(colour.shotMedianS).toBeCloseTo(2, 0);
    expect(colour.cutsPerMin).toBeCloseTo(20, 0);
    expect(colour.fps).toBe(24);
  });

  it("mesure l'image : saturation, letterbox", () => {
    expect(colour.saturation).toBeGreaterThan(20);
    expect(grey.saturation).toBeLessThan(2);
    expect(colour.letterbox).toBeLessThan(0.05);
    expect(boxed.letterbox).toBeCloseTo(92 / 360, 1);
  });

  it("compare un rendu à la référence et dit quoi régler", () => {
    expect(compareFingerprints(colour, colour).every((r) => r.ok)).toBe(true);
    const rows = compareFingerprints(colour, grey);
    const sat = rows.find((r) => r.metric === "saturation moyenne");
    expect(sat?.ok).toBe(false);
    expect(sat?.advice).toMatch(/saturation du look plus haute/);
    expect(compareFingerprints(boxed, colour).find((r) => r.metric.startsWith("letterbox"))?.advice).toMatch(
      /ajouter texture\.letterbox/,
    );
    expect(fingerprintMarkdown(colour, grey)).toMatch(/mesures dans la tolérance/);
  });
});
