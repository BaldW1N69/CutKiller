import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const workersDir = (): string =>
  process.env.CUTKILLER_WORKERS ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../../workers");

/**
 * Runs a Python analysis worker: JSON request on stdin, JSON response on stdout.
 * Workers run in the uv-managed environment of `workers/` (`uv run`), so their
 * dependencies never leak into the Node side.
 */
export function runWorker<T>(task: string, request: unknown): Promise<T> {
  const cwd = workersDir();
  const child = spawn("uv", ["run", "--quiet", "--project", cwd, "python", "-m", "cutkiller_workers", task], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (d: Buffer) => {
    out += d.toString();
  });
  child.stderr.on("data", (d: Buffer) => {
    err = (err + d.toString()).slice(-8000);
  });
  child.stdin.end(JSON.stringify(request));
  return new Promise((resolvePromise, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      let response: { ok: boolean; result?: T; error?: string };
      try {
        response = JSON.parse(out) as typeof response;
      } catch {
        return reject(new Error(`worker ${task} a échoué (code ${code}) : ${err || out.slice(0, 500)}`));
      }
      if (!response.ok || code !== 0) return reject(new Error(`worker ${task} : ${response.error ?? err}`));
      resolvePromise(response.result as T);
    });
  });
}
