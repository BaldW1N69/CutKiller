import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

export const workersDir = (): string =>
  process.env.CUTKILLER_WORKERS ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../../workers");

/**
 * Runs a Python analysis worker task: JSON request in, JSON response out.
 * Workers run in the uv-managed environment of `workers/` (`uv run`), so their
 * dependencies never leak into the Node side.
 *
 * By default one persistent worker process serves every task of this run
 * (`python -m cutkiller_workers --serve`): Whisper and the aligner stay loaded
 * between calls instead of costing ~8 s each time. CUTKILLER_WORKER_MODE=oneshot
 * spawns one process per task (the previous behaviour).
 */
export function runWorker<T>(task: string, request: unknown): Promise<T> {
  if (process.env.CUTKILLER_WORKER_MODE === "oneshot") return runOnce<T>(task, request);
  return serverFor(workersDir()).call<T>(task, request);
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; task: string };

class WorkerServer {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = "";
  private stderr = "";
  dead = false;

  constructor(cwd: string) {
    this.child = spawn(
      "uv",
      ["run", "--quiet", "--project", cwd, "python", "-m", "cutkiller_workers", "--serve"],
      {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.child.stdout.on("data", (d: Buffer) => this.onData(d.toString()));
    this.child.stderr.on("data", (d: Buffer) => {
      this.stderr = (this.stderr + d.toString()).slice(-8000);
    });
    const fail = (why: string) => {
      this.dead = true;
      for (const p of this.pending.values()) p.reject(new Error(`worker ${p.task} : ${why}\n${this.stderr}`));
      this.pending.clear();
    };
    this.child.on("error", (err) => fail(err.message));
    this.child.on("exit", (code) => fail(`process exited (code ${code})`));
    this.idle();
  }

  call<T>(task: string, request: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise as (v: unknown) => void, reject, task });
      this.busy();
      this.child.stdin.write(`${JSON.stringify({ id, task, request })}\n`);
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl = this.buffer.indexOf("\n");
    while (nl >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      nl = this.buffer.indexOf("\n");
      if (!line.trim()) continue;
      let msg: { id: number; ok: boolean; result?: unknown; error?: string };
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // not a protocol line
      }
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(`worker ${p.task} : ${msg.error ?? this.stderr}`));
    }
    if (this.pending.size === 0) this.idle();
  }

  /** While a task is pending the worker keeps Node alive; idle, it never blocks exit. */
  private busy(): void {
    this.child.ref();
    for (const s of [this.child.stdin, this.child.stdout, this.child.stderr] as (Readable | Writable)[])
      (s as unknown as { ref?: () => void }).ref?.();
  }

  private idle(): void {
    this.child.unref();
    for (const s of [this.child.stdin, this.child.stdout, this.child.stderr] as (Readable | Writable)[])
      (s as unknown as { unref?: () => void }).unref?.();
  }
}

const servers = new Map<string, WorkerServer>();

function serverFor(cwd: string): WorkerServer {
  const existing = servers.get(cwd);
  if (existing && !existing.dead) return existing;
  const server = new WorkerServer(cwd);
  servers.set(cwd, server);
  return server;
}

/** One process per task: JSON request on stdin, JSON response on stdout. */
function runOnce<T>(task: string, request: unknown): Promise<T> {
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
