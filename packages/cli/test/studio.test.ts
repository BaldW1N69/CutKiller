import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generateFixtures } from "@cutkiller/fixtures";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../../..");
const PORT = 4391;
const base = `http://127.0.0.1:${PORT}`;
const TOKEN = "test-session-token";
const auth = { "X-CutKiller-Token": TOKEN };

/** Raw request with a chosen Host header (fetch cannot forge it). */
function rawStatus(path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((ok, fail) => {
    const req = request({ host: "127.0.0.1", port: PORT, path, headers }, (res) => {
      res.resume();
      ok(res.statusCode ?? 0);
    });
    req.on("error", fail);
    req.end();
  });
}
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
      { cwd: ROOT, stdio: "ignore", env: { ...process.env, CUTKILLER_STUDIO_TOKEN: TOKEN } },
    );
    type State = {
      sentences: { id: number; text: string }[];
      busy: boolean;
      video?: string;
      report?: { score: number };
      error?: string;
    };
    const state = await waitFor(async () => {
      const r = await fetch(`${base}/api/state`, { headers: auth });
      return r.ok ? ((await r.json()) as State) : undefined;
    }, 300_000);
    expect(state.sentences.length).toBeGreaterThan(3);
    expect(await (await fetch(base, { headers: auth })).text()).toContain("CutKiller Studio");
    // Without the session key, or from another site, nothing is served or started.
    expect((await fetch(`${base}/api/state`)).status).toBe(401);
    expect((await fetch(`${base}/files/final.mp4`)).status).toBe(401);
    expect(await rawStatus("/api/state", { ...auth, Host: "evil.example:4391" })).toBe(403);
    const crossSite = await fetch(`${base}/api/render`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json", Origin: "http://evil.example" },
      body: "{}",
    });
    expect(crossSite.status).toBe(403);
    const form = await fetch(`${base}/api/render`, { method: "POST", headers: auth, body: "{}" });
    expect(form.status).toBe(403);
    // The printed link trades the key for a session cookie.
    const link = await fetch(`${base}/?token=${TOKEN}`, { redirect: "manual" });
    expect(link.status).toBe(303);
    expect(link.headers.get("set-cookie")).toMatch(/HttpOnly; SameSite=Strict/);
    // Each sentence can be heard in its rush: the source is served by id, with Range.
    const rush = await fetch(`${base}/source/speech-en`, { headers: { ...auth, Range: "bytes=0-9" } });
    expect(rush.status).toBe(206);
    expect((await fetch(`${base}/source/unknown`, { headers: auth })).status).toBe(404);

    // Keep every sentence but the first.
    const keep = state.sentences.slice(1).map((s) => s.id);
    const started = await fetch(`${base}/api/render`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ keep }),
    });
    expect(started.status).toBe(202);
    const done = await waitFor(async () => {
      const s = (await (await fetch(`${base}/api/state`, { headers: auth })).json()) as State;
      return s.busy ? undefined : s;
    }, 600_000);
    expect(done.error).toBeUndefined();
    expect(done.report?.score).toBeGreaterThanOrEqual(85);

    const video = await fetch(`${base}/files/final.mp4`, { headers: { ...auth, Range: "bytes=0-99" } });
    expect(video.status).toBe(206);
    expect((await video.arrayBuffer()).byteLength).toBe(100);
    expect((await fetch(`${base}/files/../package.json`, { headers: auth })).status).toBe(404);
  }, 900_000);
});
