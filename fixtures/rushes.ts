/**
 * Downloads the real test rushes listed in rushes.json into .cache/rushes.
 * Video excerpts are cut by FFmpeg over HTTP (only the needed bytes are fetched).
 *
 *   pnpm rushes
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ffmpeg } from "@cutkiller/media";

interface Rush {
  file: string;
  /** Remote source, or `from`: an excerpt of a rush listed before (no second download). */
  url?: string;
  from?: string;
  start?: number;
  duration?: number;
  license: string;
  attribution: string;
}

const here = dirname(fileURLToPath(import.meta.url));

export async function fetchRushes(dir = resolve(".cache/rushes")): Promise<string[]> {
  const { rushes } = JSON.parse(await readFile(join(here, "rushes.json"), "utf8")) as { rushes: Rush[] };
  await mkdir(dir, { recursive: true });
  const out: string[] = [];
  for (const r of rushes) {
    const path = join(dir, r.file);
    out.push(path);
    if (existsSync(path)) continue;
    console.error(`téléchargement de ${r.file} (${r.license})`);
    const input = r.from ? join(dir, r.from) : r.url;
    if (!input) throw new Error(`${r.file} : ni url ni from`);
    if (r.start !== undefined) {
      // Re-encoding the excerpt keeps both streams starting together (a stream copy
      // would start the video on the next keyframe).
      await ffmpeg([
        "-v",
        "error",
        "-ss",
        String(r.start),
        "-i",
        input,
        "-t",
        String(r.duration),
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
    } else {
      const res = await fetch(input);
      if (!res.ok) throw new Error(`${input} : HTTP ${res.status}`);
      await writeFile(path, Buffer.from(await res.arrayBuffer()));
    }
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const p of await fetchRushes(process.argv[2] ? resolve(process.argv[2]) : undefined)) console.log(p);
}
