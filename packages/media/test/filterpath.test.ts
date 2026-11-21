import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ffmpeg, filterPath } from "../src/index";

describe("file paths inside filtergraphs", () => {
  it("Windows paths: forward slashes, escaped drive colon", () => {
    expect(filterPath("C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\grade-0.cube")).toBe(
      "C\\\\:/Users/RUNNER~1/AppData/Local/Temp/grade-0.cube",
    );
    expect(filterPath("/tmp/ck/grade-0.cube")).toBe("/tmp/ck/grade-0.cube");
  });

  it("FFmpeg reads a LUT whose path holds a colon and a quote", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "ck-lut-")), "C:", "it's");
    await mkdir(dir, { recursive: true });
    const lut = join(dir, "identity.cube");
    const rows: string[] = ["LUT_3D_SIZE 2"];
    for (let b = 0; b < 2; b++)
      for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) rows.push(`${r} ${g} ${b}`);
    await writeFile(lut, `${rows.join("\n")}\n`);
    const done = ffmpeg([
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=gray:s=32x32:d=0.1",
      "-vf",
      `lut3d=file=${filterPath(lut)}:interp=tetrahedral`,
      "-f",
      "null",
      "-",
    ]);
    await expect(done).resolves.toBeDefined();
  });
});
