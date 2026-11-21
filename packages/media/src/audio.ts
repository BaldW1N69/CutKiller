import { readFile, writeFile } from "node:fs/promises";
import { ffmpeg, mediaInput } from "./ffmpeg";

export interface Loudness {
  /** Integrated loudness (EBU R128 / ITU-R BS.1770-4), LUFS; -Infinity for silence. */
  integrated: number;
  /** True peak (4× oversampled), dBTP. */
  truePeak: number;
  /** Loudness range, LU. */
  range: number;
}

/** EBU R128 measurement of a file's first audio stream (FFmpeg `ebur128`). */
export async function measureLoudness(path: string): Promise<Loudness> {
  const { stderr } = await ffmpeg([
    "-nostats",
    ...mediaInput(path),
    "-map",
    "0:a:0",
    "-af",
    "ebur128=peak=true:framelog=quiet",
    "-f",
    "null",
    "-",
  ]);
  const summary = stderr.slice(stderr.lastIndexOf("Summary:"));
  const num = (re: RegExp) => {
    const m = re.exec(summary);
    if (!m) throw new Error(`mesure de loudness illisible pour ${path}`);
    return m[1] === "-inf" ? Number.NEGATIVE_INFINITY : Number(m[1]);
  };
  return {
    integrated: num(/I:\s+(-?inf|-?[\d.]+) LUFS/),
    truePeak: num(/Peak:\s+(-?inf|-?[\d.]+) dBFS/),
    range: num(/LRA:\s+(-?inf|-?[\d.]+) LU/),
  };
}

export interface WavData {
  rate: number;
  channels: number;
  /** Interleaved float samples. */
  samples: Float32Array;
}

/** Reads a 32-bit float PCM WAV (as written by FFmpeg `pcm_f32le`). */
export async function readWavF32(path: string): Promise<WavData> {
  const buf = await readFile(path);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE")
    throw new Error(`${path} n'est pas un WAV`);
  let pos = 12;
  let rate = 0;
  let channels = 0;
  let bits = 0;
  let format = 0;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    let size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === "fmt ") {
      format = buf.readUInt16LE(body);
      channels = buf.readUInt16LE(body + 2);
      rate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
      if (format === 0xfffe) format = buf.readUInt16LE(body + 24);
    } else if (id === "data") {
      if (format !== 3 || bits !== 32) throw new Error(`${path} : WAV non flottant 32 bits`);
      if (size === 0xffffffff || body + size > buf.length) size = buf.length - body;
      const n = Math.floor(size / 4);
      const samples = new Float32Array(n);
      for (let i = 0; i < n; i++) samples[i] = buf.readFloatLE(body + i * 4);
      return { rate, channels, samples };
    }
    pos = body + size + (size % 2);
  }
  throw new Error(`${path} : pas de données audio`);
}

/** Writes interleaved float samples as a 32-bit float PCM WAV. */
export async function writeWavF32(path: string, data: WavData): Promise<void> {
  const bytes = data.samples.length * 4;
  const buf = Buffer.alloc(44 + bytes);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + bytes, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(3, 20);
  buf.writeUInt16LE(data.channels, 22);
  buf.writeUInt32LE(data.rate, 24);
  buf.writeUInt32LE(data.rate * data.channels * 4, 28);
  buf.writeUInt16LE(data.channels * 4, 32);
  buf.writeUInt16LE(32, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(bytes, 40);
  for (let i = 0; i < data.samples.length; i++) buf.writeFloatLE(data.samples[i] as number, 44 + i * 4);
  await writeFile(path, buf);
}
