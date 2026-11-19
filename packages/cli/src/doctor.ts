import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { cpus, freemem, homedir, totalmem } from "node:os";
import { join } from "node:path";
import { runWorker, workersDir } from "@cutkiller/analyze";
import { ffmpegVersion } from "@cutkiller/media";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  /** What was found. */
  detail: string;
  /** How to fix it (only when not ok). */
  fix?: string;
  /** A failed optional check only degrades features. */
  optional?: boolean;
}

const have = (bin: string, args = ["--version"]) => {
  const r = spawnSync(bin, args, { encoding: "utf8" });
  return r.status === 0 ? (r.stdout || r.stderr).trim().split("\n")[0] : undefined;
};

function dirSize(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(p) : entry.isFile() ? statSync(p).size : 0;
  }
  return total;
}

const GB = 1024 ** 3;

/** Everything CutKiller needs, checked in order, with the command that fixes each problem. */
export async function doctor(): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const major = Number(process.versions.node.split(".")[0]);
  checks.push({
    name: "Node.js",
    ok: major >= 22,
    detail: `v${process.versions.node}`,
    fix: "install Node 22 or newer: https://nodejs.org (or use the Docker image)",
  });

  try {
    const v = await ffmpegVersion();
    checks.push({
      name: "FFmpeg",
      ok: v.major >= 6,
      detail: v.raw,
      fix: "FFmpeg 6+ is required: apt install ffmpeg / brew install ffmpeg / winget install ffmpeg",
    });
  } catch {
    checks.push({
      name: "FFmpeg",
      ok: false,
      detail: "not found",
      fix: "apt install ffmpeg / brew install ffmpeg / winget install ffmpeg",
    });
  }

  const uv = have("uv");
  checks.push({
    name: "uv (Python workers)",
    ok: Boolean(uv),
    detail: uv ?? "not found",
    fix: "curl -LsSf https://astral.sh/uv/install.sh | sh",
  });

  if (uv) {
    try {
      const pong = await runWorker<{ python: string }>("ping", {});
      checks.push({ name: "Python workers", ok: true, detail: `Python ${pong.python} (${workersDir()})` });
    } catch (err) {
      checks.push({
        name: "Python workers",
        ok: false,
        detail: (err as Error).message.split("\n")[0] ?? "failed",
        fix: `cd ${workersDir()} && uv sync`,
      });
    }
  }

  try {
    // canvas is a dependency of the renderer: resolve it from there.
    createRequire(import.meta.resolve("@cutkiller/render"))("canvas");
    checks.push({ name: "Canvas (captions, motion)", ok: true, detail: "loaded" });
  } catch (err) {
    checks.push({
      name: "Canvas (captions, motion)",
      ok: false,
      detail: (err as Error).message.split("\n")[0] ?? "failed",
      fix: "pnpm install (see https://github.com/Automattic/node-canvas#compiling for system libraries)",
    });
  }

  const models = process.env.CUTKILLER_MODELS ?? join(homedir(), ".cache", "cutkiller", "models");
  const hf = process.env.HF_HOME ?? join(homedir(), ".cache", "cutkiller", "hf");
  const cached = (dirSize(models) + dirSize(hf)) / GB;
  checks.push({
    name: "Speech models",
    ok: true,
    optional: true,
    detail:
      cached > 0.05
        ? `${cached.toFixed(1)} GB cached (${models})`
        : "not downloaded yet: the first analysis downloads Whisper (~0.5–1.6 GB) and one aligner per language (~1.3 GB)",
  });

  const gpu = have("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader"]);
  checks.push({
    name: "GPU",
    ok: Boolean(gpu),
    optional: true,
    detail: gpu ?? `none: analysis runs on ${cpus().length} CPU threads (about 1× real time)`,
    fix: "optional: an NVIDIA GPU speeds up transcription; CPU works everywhere",
  });

  const ram = totalmem() / GB;
  checks.push({
    name: "Memory",
    ok: ram >= 6,
    optional: true,
    detail: `${ram.toFixed(1)} GB total, ${(freemem() / GB).toFixed(1)} GB free`,
    fix: "8 GB recommended; with less, use a smaller model: CUTKILLER_WHISPER_MODEL=small",
  });
  return checks;
}

export function doctorReport(checks: readonly DoctorCheck[]): { text: string; ok: boolean } {
  const lines = checks.map((c) => {
    const mark = c.ok ? "✔" : c.optional ? "•" : "✖";
    const fix = !c.ok && c.fix ? `\n    → ${c.fix}` : "";
    return `${mark} ${c.name.padEnd(26)} ${c.detail}${fix}`;
  });
  const ok = checks.every((c) => c.ok || c.optional);
  lines.push(
    "",
    ok
      ? "Ready: cutkiller auto <video> -p short -o out"
      : "Fix the ✖ items above, then run cutkiller doctor again.",
  );
  return { text: lines.join("\n"), ok };
}
