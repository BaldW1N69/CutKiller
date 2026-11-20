import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generateFixtures } from "@cutkiller/fixtures";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../../..");
const PORT = 4391;
const base = `http://127.0.0.1:${PORT}`;
let server: ChildProcess | undefined;

afterAll(() => {
  server?.kill();
});

async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs: number): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await probe().catch(() => undefined);
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("timed out");
}

describe("Studio (edit by transcript)", () => {
  it("lists the sentences, renders the kept ones, scores them and streams the video", async () => {
    const fx = await generateFixtures();
    const dir = await mkdtemp(join(tmpdir(), "ck-studio-"));
    server = spawn(
      join(ROOT, "node_modules/.bin/tsx"),
      [
        join(ROOT, "packages/cli/src/main.ts"),
        "studio",
        fx.speechEnVideo,
        "-p",
        "long",
        "-o",
        dir,
        "--port",
        String(PORT),
      ],
      { cwd: ROOT, stdio: "ignore" },
    );
    type State = {
      sentences: { id: number; text: string }[];
      busy: boolean;
      video?: string;
      report?: { score: number };
      error?: string;
    };
    const state = await waitFor(async () => {
      const r = await fetch(`${base}/api/state`);
      return r.ok ? ((await r.json()) as State) : undefined;
    }, 300_000);
    expect(state.sentences.length).toBeGreaterThan(3);
    expect(await (await fetch(base)).text()).toContain("CutKiller Studio");
    // Each sentence can be heard in its rush: the source is served by id, with Range.
    const rush = await fetch(`${base}/source/speech-en`, { headers: { Range: "bytes=0-9" } });
    expect(rush.status).toBe(206);
    expect((await fetch(`${base}/source/unknown`)).status).toBe(404);

    // Keep every sentence but the first.
    const keep = state.sentences.slice(1).map((s) => s.id);
    const started = await fetch(`${base}/api/render`, { method: "POST", body: JSON.stringify({ keep }) });
    expect(started.status).toBe(202);
    const done = await waitFor(async () => {
      const s = (await (await fetch(`${base}/api/state`)).json()) as State;
      return s.busy ? undefined : s;
    }, 600_000);
    expect(done.error).toBeUndefined();
    expect(done.report?.score).toBeGreaterThanOrEqual(85);

    const video = await fetch(`${base}/files/final.mp4`, { headers: { Range: "bytes=0-99" } });
    expect(video.status).toBe(206);
    expect((await video.arrayBuffer()).byteLength).toBe(100);
    expect((await fetch(`${base}/files/../package.json`)).status).toBe(404);
  }, 900_000);
});
