/**
 * `cutkiller studio`: a local web page to edit by transcript. Every sentence of
 * the rushes is listed with a checkbox; unticking drops it, "Render" re-plans the
 * edit on the kept sentences (same engine: word-accurate cuts, captions, sound),
 * renders it and shows the video with its quality score and failed rules.
 *
 * No dependencies: Node's http server, one HTML page, files served with Range
 * support so the browser can seek in the render.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { analyzeSources } from "@cutkiller/analyze";
import { type StyleProfile, tr } from "@cutkiller/core";
import { type Sentence, sentences, toRanges } from "@cutkiller/editorial";
import type { Report } from "@cutkiller/qa";
import { check, doRender, plan } from "./pipeline";
import { STUDIO_HTML } from "./studio-page";

export interface StudioOptions {
  dir: string;
  port: number;
  language?: string;
  /** Session secret (default: CUTKILLER_STUDIO_TOKEN, else random). */
  token?: string;
}

const COOKIE = "ck_studio";
const MAX_BODY = 1_000_000;

/**
 * Who may talk to the Studio: only a page served by this Studio, opened from
 * the link printed in the terminal. The Host header must name this machine
 * (a DNS-rebinding page names its own domain), the session token must come
 * with every request (cookie set by that link, or X-CutKiller-Token), and a
 * render is only started by a same-origin JSON request (a cross-site form or
 * fetch cannot send one without a CORS preflight, which is never answered).
 */
export function studioGuard(port: number, token: string) {
  const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
  const secret = Buffer.from(token);
  const same = (given: string | undefined) => {
    if (!given) return false;
    const b = Buffer.from(given);
    return b.length === secret.length && timingSafeEqual(b, secret);
  };
  const cookieToken = (req: IncomingMessage) =>
    (req.headers.cookie ?? "")
      .split(";")
      .map((c) => c.trim().split("="))
      .find(([k]) => k === COOKIE)?.[1];
  return {
    hostOk: (req: IncomingMessage) => hosts.has(req.headers.host ?? ""),
    authorized: (req: IncomingMessage) =>
      same(cookieToken(req)) || same(req.headers["x-cutkiller-token"] as string | undefined),
    sameOrigin: (req: IncomingMessage) => {
      const origin = req.headers.origin;
      return origin === undefined || origin === `http://${req.headers.host}`;
    },
    isJson: (req: IncomingMessage) => /^application\/json\b/i.test(req.headers["content-type"] ?? ""),
    tokenMatches: same,
    cookie: `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`,
  };
}

interface StudioState {
  sentences: Pick<Sentence, "id" | "source" | "start" | "end" | "text">[];
  /** Source id → URL of the rush, to listen to a sentence before choosing. */
  sources: Record<string, string>;
  keep: number[];
  video?: string;
  report?: { score: number; coverage: number; failed: { id: string; title: string; first?: string }[] };
  busy: boolean;
  error?: string;
}

const MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".srt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json",
};

export async function studio(inputs: string[], profile: StyleProfile, opts: StudioOptions): Promise<void> {
  await mkdir(opts.dir, { recursive: true });
  const analysis = await analyzeSources(inputs, {
    deep: true,
    log: (m) => console.error(`… ${m}`),
    ...(opts.language ? { language: opts.language } : {}),
  });
  const all = sentences(analysis.transcripts ?? {});
  const statePath = join(opts.dir, "studio.json");
  const saved: Partial<StudioState> = existsSync(statePath)
    ? JSON.parse(await readFile(statePath, "utf8"))
    : {};
  const state: StudioState = {
    sentences: all.map(({ id, source, start, end, text }) => ({ id, source, start, end, text })),
    sources: Object.fromEntries(
      Object.keys(analysis.sources).map((id) => [id, `/source/${encodeURIComponent(id)}`]),
    ),
    keep: saved.keep ?? all.map((s) => s.id),
    ...(saved.video ? { video: saved.video } : {}),
    ...(saved.report ? { report: saved.report } : {}),
    busy: false,
  };
  const persist = () =>
    writeFile(
      statePath,
      `${JSON.stringify({ keep: state.keep, video: state.video, report: state.report }, null, 2)}\n`,
    );

  const renderKept = async (keep: number[], draft: boolean) => {
    const kept = all.filter((s) => keep.includes(s.id));
    if (kept.length === 0)
      throw new Error(
        tr(
          "nothing to render: every sentence is unticked",
          "rien à rendre : toutes les phrases sont décochées",
        ),
      );
    const edlPath = join(opts.dir, "edit.edl.json");
    const video = join(opts.dir, "final.mp4");
    const edl = await plan(inputs, profile, edlPath, true, [], opts.language, toRanges(kept, all));
    await doRender(edl, edlPath, video, draft, true);
    const report: Report = await check(video, profile, edlPath, {
      json: join(opts.dir, "quality.json"),
      md: join(opts.dir, "quality.md"),
    });
    state.keep = keep;
    state.video = `final.mp4?v=${Date.now()}`;
    state.report = {
      score: report.score,
      coverage: report.coverage,
      failed: report.results
        .filter((r) => r.status === "fail")
        .map((r) => ({
          id: r.ruleId,
          title: r.title,
          ...(r.violations[0]
            ? { first: `${r.violations[0].time ?? ""} ${r.violations[0].message}`.trim() }
            : {}),
        })),
    };
    await persist();
  };

  const token = opts.token ?? process.env.CUTKILLER_STUDIO_TOKEN ?? randomBytes(24).toString("base64url");
  const guard = studioGuard(opts.port, token);
  const server = createServer(async (req, res) => {
    try {
      if (!guard.hostOk(req)) return send(res, 403, "forbidden host", "text/plain");
      const url = new URL(req.url ?? "/", "http://localhost");
      // The link printed in the terminal: trade the token for a session cookie.
      if (
        req.method === "GET" &&
        url.pathname === "/" &&
        guard.tokenMatches(url.searchParams.get("token") ?? undefined)
      ) {
        res.writeHead(303, { Location: "/", "Set-Cookie": guard.cookie, "Cache-Control": "no-store" });
        res.end();
        return;
      }
      if (!guard.authorized(req))
        return send(
          res,
          401,
          tr(
            "Open the Studio from the link printed in the terminal (it carries the session key).",
            "Ouvrez le Studio depuis le lien affiché dans le terminal (il contient la clé de session).",
          ),
          "text/plain; charset=utf-8",
        );
      if (req.method === "GET" && url.pathname === "/")
        return send(res, 200, STUDIO_HTML, "text/html; charset=utf-8");
      if (req.method === "GET" && url.pathname === "/api/state")
        return send(res, 200, JSON.stringify(state), "application/json");
      if (req.method === "POST" && url.pathname === "/api/render") {
        if (!guard.sameOrigin(req) || !guard.isJson(req))
          return send(
            res,
            403,
            JSON.stringify({ error: "cross-origin or non-JSON request" }),
            "application/json",
          );
        if (state.busy)
          return send(
            res,
            409,
            JSON.stringify({ error: tr("a render is already running", "un rendu est déjà en cours") }),
            "application/json",
          );
        const raw = await readBody(req);
        if (raw === undefined)
          return send(res, 413, JSON.stringify({ error: "request too large" }), "application/json");
        const body = JSON.parse(raw || "{}") as { keep?: number[]; final?: boolean };
        const keep = (body.keep ?? []).filter((id) => Number.isInteger(id) && id >= 0 && id < all.length);
        state.busy = true;
        delete state.error;
        renderKept(keep, !body.final)
          .catch((err: Error) => {
            state.error = err.message;
          })
          .finally(() => {
            state.busy = false;
          });
        return send(res, 202, JSON.stringify({ started: true }), "application/json");
      }
      if (req.method === "GET" && url.pathname.startsWith("/files/"))
        return serveFile(req, res, resolve(opts.dir), decodeURIComponent(url.pathname.slice(7)));
      if (req.method === "GET" && url.pathname.startsWith("/source/")) {
        // Only the rushes of this session, by id: no arbitrary path from the URL.
        const probe = analysis.sources[decodeURIComponent(url.pathname.slice(8))];
        if (!probe) return send(res, 404, "not found", "text/plain");
        return serveFile(req, res, dirname(probe.path), basename(probe.path));
      }
      return send(res, 404, "not found", "text/plain");
    } catch (err) {
      return send(res, 500, JSON.stringify({ error: (err as Error).message }), "application/json");
    }
  });
  await new Promise<void>((ok) => server.listen(opts.port, "127.0.0.1", ok));
  console.log(
    tr(
      `✔ CutKiller Studio: http://localhost:${opts.port}/?token=${token}  (Ctrl+C to stop)`,
      `✔ CutKiller Studio : http://localhost:${opts.port}/?token=${token}  (Ctrl+C pour arrêter)`,
    ),
  );
}

function send(res: ServerResponse, status: number, body: string, type: string): void {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

/** The request body, or undefined past MAX_BODY (the rest is not read). */
function readBody(req: IncomingMessage): Promise<string | undefined> {
  return new Promise((ok, fail) => {
    let data = "";
    let over = false;
    req.on("data", (c: Buffer) => {
      if (over) return;
      data += c.toString();
      if (data.length > MAX_BODY) {
        over = true;
        req.pause();
        ok(undefined);
      }
    });
    req.on("end", () => {
      if (!over) ok(data);
    });
    req.on("error", fail);
  });
}

/** Files of the output folder only (no path traversal), with Range support for video seeking. */
function serveFile(req: IncomingMessage, res: ServerResponse, root: string, name: string): void {
  const path = resolve(root, name);
  if (!path.startsWith(root + sep) || !existsSync(path)) {
    send(res, 404, "not found", "text/plain");
    return;
  }
  const size = statSync(path).size;
  const type = MIME[extname(path)] ?? "application/octet-stream";
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) {
      res.writeHead(416, { "Content-Range": `bytes */${size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      "Content-Type": type,
      "Content-Length": end - start + 1,
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Accept-Ranges": "bytes",
    });
    createReadStream(path, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { "Content-Type": type, "Content-Length": size, "Accept-Ranges": "bytes" });
  createReadStream(path).pipe(res);
}
