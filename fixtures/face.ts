/**
 * Fixtures with a real face, for subject tracking, 9:16 reframing and skin-tone
 * matching. The face is NASA's public-domain portrait of Eileen Collins, as
 * shipped by scikit-image (`astronaut.png`); it is downloaded once (sha256-pinned)
 * and composited by FFmpeg, never committed.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ffmpeg } from "@cutkiller/media";

const ASTRONAUT_URL =
  "https://raw.githubusercontent.com/scikit-image/scikit-image/v0.24.0/skimage/data/astronaut.png";
const ASTRONAUT_SHA256 = "88431cd9653ccd539741b555fb0a46b61558b301d4110412b5bc28b5e3ea6cb5";

/** Head crop of the portrait (pixels of the 512×512 original) and where the face sits in it. */
const CROP = { x: 113, y: 10, size: 220 };
/** Face centre inside the crop, as a fraction of the crop (from YuNet on the original: box 178,63 90×113). */
const FACE_IN_CROP = { x: (178 + 45 - 113) / 220, y: (63 + 56 - 10) / 220 };

export const FACE_PAN = {
  width: 1280,
  height: 720,
  fps: 30,
  durationS: 8,
  /** Overlay size of the head crop. */
  size: 300,
  /** Face centre (fraction of the frame width): holds at `from`, glides to `to` between `moveS`, holds. */
  from: 0.3,
  to: 0.7,
  moveS: [2.5, 3.5] as const,
};

/** Ground truth: face centre (fraction of the frame width) at time t of `face-pan.mp4`. */
export function facePanX(t: number): number {
  const { from, to, moveS } = FACE_PAN;
  const p = Math.min(1, Math.max(0, (t - moveS[0]) / (moveS[1] - moveS[0])));
  return from + (to - from) * (p * p * (3 - 2 * p));
}

async function astronaut(dir: string): Promise<string> {
  const path = join(dir, "astronaut.png");
  const ok = async () =>
    existsSync(path) &&
    createHash("sha256")
      .update(await readFile(path))
      .digest("hex") === ASTRONAUT_SHA256;
  if (await ok()) return path;
  const res = await fetch(ASTRONAUT_URL);
  if (!res.ok) throw new Error(`téléchargement du portrait de test impossible (${res.status})`);
  await writeFile(path, Buffer.from(await res.arrayBuffer()));
  if (!(await ok())) throw new Error("portrait de test corrompu (sha256)");
  return path;
}

/** Overlay position (left edge, px) giving the face centre at frame fraction `fx`. */
const overlayX = (fx: number) => fx * FACE_PAN.width - FACE_IN_CROP.x * FACE_PAN.size;

export async function facePanFixture(dir: string): Promise<string> {
  const path = join(dir, "face-pan.mp4");
  if (existsSync(path)) return path;
  const portrait = await astronaut(dir);
  const { width, height, fps, durationS, size, moveS } = FACE_PAN;
  const x0 = overlayX(FACE_PAN.from).toFixed(2);
  const x1 = overlayX(FACE_PAN.to).toFixed(2);
  const p = `clip((t-${moveS[0]})/${moveS[1] - moveS[0]},0,1)`;
  const x = `${x0}+(${x1}-${x0})*${p}*${p}*(3-2*${p})`;
  const y = (height * 0.45 - FACE_IN_CROP.y * size).toFixed(2);
  await ffmpeg([
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `gradients=s=${width}x${height}:r=${fps}:d=${durationS}:c0=0x4a5d6e:c1=0x9fb3a8:speed=0.01`,
    "-loop",
    "1",
    "-i",
    portrait,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=330:sample_rate=48000:duration=${durationS}`,
    "-filter_complex",
    `[1:v]crop=${CROP.size}:${CROP.size}:${CROP.x}:${CROP.y},scale=${size}:${size}[face];[0:v][face]overlay=x='${x}':y=${y}:shortest=1,noise=alls=6:allf=t,format=yuv420p[v]`,
    "-map",
    "[v]",
    "-map",
    "2:a",
    "-t",
    String(durationS),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "18",
    "-c:a",
    "aac",
    "-y",
    path,
  ]);
  return path;
}

/**
 * The same face, still and centred, in two gradings: `face-neutral.mp4` as shot,
 * `face-graded.mp4` about a stop darker and blue (another camera, white balance off).
 */
export async function faceGradingFixtures(dir: string): Promise<{ neutral: string; graded: string }> {
  const neutral = join(dir, "face-neutral.mp4");
  const graded = join(dir, "face-graded.mp4");
  if (existsSync(neutral) && existsSync(graded)) return { neutral, graded };
  const portrait = await astronaut(dir);
  for (const [path, grade] of [
    [neutral, "null"],
    // About a stop under (display gain 2^(-1/2.2) ≈ 0.73) and blue.
    [graded, "colorchannelmixer=rr=0.7:gg=0.73:bb=0.86"],
  ] as const) {
    await ffmpeg([
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=0x6b7a74:s=1280x720:r=30:d=4",
      "-loop",
      "1",
      "-i",
      portrait,
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=330:sample_rate=48000:duration=4",
      "-filter_complex",
      `[1:v]scale=640:640[p];[0:v][p]overlay=x=320:y=40:shortest=1,${grade},noise=alls=4:allf=t,format=yuv420p[v]`,
      "-map",
      "[v]",
      "-map",
      "2:a",
      "-t",
      "4",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "18",
      "-c:a",
      "aac",
      "-y",
      path,
    ]);
  }
  return { neutral, graded };
}

/** Face path of `talking-head.mp4` (fraction of the frame width): holds, shifts once, holds. */
export const TALKING_HEAD = { from: 0.42, to: 0.6, moveS: [6, 7.2] as const, size: 420 };

export function talkingHeadX(t: number): number {
  const { from, to, moveS } = TALKING_HEAD;
  const p = Math.min(1, Math.max(0, (t - moveS[0]) / (moveS[1] - moveS[0])));
  return from + (to - from) * (p * p * (3 - 2 * p));
}

/**
 * A talking head for the QA calibration: the portrait in a 1920×1080 frame, who
 * shifts sideways once (the 9:16 camera has to follow), over the synthetic French
 * speech (word-level ground truth). Every rule of the standards applies to it.
 */
export async function talkingHeadFixture(dir: string, speechWav: string, durationS: number): Promise<string> {
  const path = join(dir, "talking-head.mp4");
  if (existsSync(path)) return path;
  const portrait = await astronaut(dir);
  const { size, moveS } = TALKING_HEAD;
  const at = (fx: number) => (fx * 1920 - FACE_IN_CROP.x * size).toFixed(2);
  const p = `clip((t-${moveS[0]})/${moveS[1] - moveS[0]},0,1)`;
  const x = `${at(TALKING_HEAD.from)}+(${at(TALKING_HEAD.to)}-${at(TALKING_HEAD.from)})*${p}*${p}*(3-2*${p})`;
  const y = (1080 * 0.42 - FACE_IN_CROP.y * size).toFixed(2);
  await ffmpeg([
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `gradients=s=1920x1080:r=30:d=${durationS}:c0=0x55606a:c1=0xa8b2a0:speed=0.01`,
    "-loop",
    "1",
    "-i",
    portrait,
    "-i",
    speechWav,
    "-filter_complex",
    `[1:v]crop=${CROP.size}:${CROP.size}:${CROP.x}:${CROP.y},scale=${size}:${size}[face];[0:v][face]overlay=x='${x}':y=${y}:shortest=1,noise=alls=6:allf=t,format=yuv420p[v]`,
    "-map",
    "[v]",
    "-map",
    "2:a",
    "-t",
    String(durationS),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "18",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-y",
    path,
  ]);
  return path;
}
