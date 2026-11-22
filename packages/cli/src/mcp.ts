/**
 * CutKiller as an MCP server (stdio): any MCP client (Claude Code, Claude Desktop,
 * Cursor, Codex…) can edit videos, read the quality report, fix the EDL and
 * render again.
 *
 *   claude mcp add cutkiller -- npx tsx /path/to/CutKiller/packages/cli/src/main.ts mcp
 *   claude mcp add cutkiller -- docker run -i --rm -v "$PWD:/work" -v cutkiller-models:/models ghcr.io/baldw1n69/cutkiller mcp
 *
 * The protocol owns stdout: everything the pipeline prints goes to stderr.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseEdl, type StyleProfile, SUPPORTED_LANGUAGES } from "@cutkiller/core";
import { toFcp7Xml, toOtio } from "@cutkiller/interchange";
import { confinePath } from "@cutkiller/media";
import { type Report, RULES } from "@cutkiller/qa";
import { listLooks, loadProfile, PresetRegistry, withLook } from "@cutkiller/style";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { doctor, doctorReport } from "./doctor";
import { fetchMusic } from "./music";
import { check, doRender, plan } from "./pipeline";

const VERSION = "1.0.0";
const PROFILES = ["short", "long", "cinematic", "cinematic-short", "tutorial"] as const;

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

async function profileOf(name: string, look?: string): Promise<StyleProfile> {
  // A profile is a built-in name or a path to a .yaml file (then inside the workspace).
  const profile = await loadProfile(/[\\/]|\.ya?ml$/i.test(name) ? confinePath(name) : name);
  return look ? withLook(profile, await PresetRegistry.load(), look) : profile;
}

/** What an agent needs to decide its next move: the score, then every failed rule with its first violations. */
export function reportSummary(report: Report, files: Record<string, string> = {}): string {
  const lines = [`Quality score: ${report.score}/100 (coverage ${report.coverage} %)`];
  const failed = report.results.filter((r) => r.status === "fail");
  if (failed.length === 0) lines.push("All evaluated rules pass.");
  for (const r of failed) {
    lines.push(
      `✖ ${r.ruleId} — ${r.title} (score ${Math.round(r.score * 100)} %, threshold: ${r.threshold})`,
    );
    for (const v of r.violations.slice(0, 5)) lines.push(`   ${v.time ? `${v.time} ` : ""}${v.message}`);
    if (r.violations.length > 5) lines.push(`   … ${r.violations.length - 5} more`);
  }
  const skipped = report.results.filter((r) => r.status === "not-evaluated").map((r) => r.ruleId);
  if (skipped.length) lines.push(`Not evaluated: ${skipped.join(", ")}`);
  for (const [k, v] of Object.entries(files)) lines.push(`${k}: ${v}`);
  return lines.join("\n");
}

const common = {
  profile: z
    .enum(PROFILES)
    .or(z.string())
    .default("short")
    .describe(
      "Style profile: short (9:16), long (16:9), cinematic, cinematic-short, or a path to a .yaml profile",
    ),
  look: z.string().optional().describe("Image style (see list_styles), e.g. film-print, neon-80s"),
};

export function createServer(): McpServer {
  const server = new McpServer({ name: "cutkiller", version: VERSION });

  server.registerTool(
    "doctor",
    {
      title: "Check installation",
      description: "Checks FFmpeg, Python workers, models and GPU, with the fix for each problem.",
    },
    async () => text(doctorReport(await doctor()).text),
  );

  server.registerTool(
    "list_styles",
    {
      title: "List profiles, looks and languages",
      description: "Style profiles, image looks and supported spoken languages.",
    },
    async () => {
      const looks = listLooks(await PresetRegistry.load());
      return text(
        [
          `Profiles: ${PROFILES.join(", ")}`,
          "Looks:",
          ...looks.map((l) => `  ${l.ref}: ${l.description}`),
          `Languages with hesitation removal and word alignment: ${SUPPORTED_LANGUAGES.join(", ")} (others: transcription only)`,
        ].join("\n"),
      );
    },
  );

  server.registerTool(
    "auto_edit",
    {
      title: "Edit a video end to end",
      description: `Analyses the rushes, plans the edit (cuts silences and hesitations, beat-synced cuts, punch-ins, captions, music ducking, vertical reframing), renders it and runs the ${RULES.length}-rule quality check. Returns the score and every failed rule. Takes about 1–3× the footage duration on a CPU.`,
      inputSchema: {
        inputs: z.array(z.string()).min(1).describe("Rushes and music files (paths)"),
        outDir: z.string().describe("Output folder: edit.edl.json, final.mp4, final.srt, quality.md"),
        broll: z.array(z.string()).default([]).describe("Cutaway footage"),
        music: z
          .string()
          .optional()
          .describe(
            'Free music to find on Openverse, e.g. "lofi chill" (CC0 / CC BY; credit written to credits.txt)',
          ),
        lang: z.string().optional().describe("Spoken language (ISO 639-1); detected when omitted"),
        draft: z
          .boolean()
          .default(true)
          .describe("Fast encode (iterate first, final render with draft=false)"),
        fast: z.boolean().default(false).describe("Skip speech and beat analysis"),
        ...common,
      },
    },
    async ({ inputs, outDir, broll, music, lang, draft, fast, profile, look }) => {
      inputs = inputs.map((i) => confinePath(i));
      broll = broll.map((b) => confinePath(b));
      outDir = confinePath(outDir);
      const p = await profileOf(profile, look);
      if (music) inputs = [...inputs, (await fetchMusic(music, outDir, { minDurationS: 60 })).path];
      const edlPath = join(outDir, "edit.edl.json");
      const video = join(outDir, "final.mp4");
      const edl = await plan(inputs, p, edlPath, !fast, broll, lang);
      await doRender(edl, edlPath, video, draft, true);
      const report = await check(video, p, edlPath, {
        json: join(outDir, "quality.json"),
        md: join(outDir, "quality.md"),
      });
      return text(
        reportSummary(report, {
          video,
          edl: edlPath,
          subtitles: video.replace(/\.mp4$/, ".srt"),
          report: join(outDir, "quality.md"),
        }),
      );
    },
  );

  server.registerTool(
    "plan_edit",
    {
      title: "Plan an edit (EDL only)",
      description:
        "Analyses the rushes and writes the editable EDL (JSON) without rendering. Read it with read_edl, change it with write_edl, then render_edl.",
      inputSchema: {
        inputs: z.array(z.string()).min(1),
        edlPath: z.string().describe("Where to write the EDL, e.g. out/edit.edl.json"),
        broll: z.array(z.string()).default([]),
        lang: z.string().optional(),
        fast: z.boolean().default(false),
        ...common,
      },
    },
    async ({ inputs, edlPath, broll, lang, fast, profile, look }) => {
      edlPath = confinePath(edlPath);
      const edl = await plan(
        inputs.map((i) => confinePath(i)),
        await profileOf(profile, look),
        edlPath,
        !fast,
        broll.map((b) => confinePath(b)),
        lang,
      );
      const clips = edl.video[0]?.clips ?? [];
      const cuts = clips.map((c) => c.why?.note).filter(Boolean);
      return text(
        [
          `EDL written: ${edlPath}`,
          `${clips.length} clip(s), ${edl.captions.length} caption screen(s)`,
          ...cuts.map((n) => `- ${n}`),
        ].join("\n"),
      );
    },
  );

  server.registerTool(
    "read_edl",
    {
      title: "Read an EDL",
      description: "Returns the EDL JSON (clips, cuts with their reason, animations, captions, audio).",
      inputSchema: { edlPath: z.string() },
    },
    async ({ edlPath }) => {
      // Only an EDL is ever returned, never the raw content of another file.
      const result = parseEdl(JSON.parse(await readFile(confinePath(edlPath), "utf8")));
      if (!result.ok) return { ...text("Not a valid EDL."), isError: true };
      return text(JSON.stringify(result.edl, null, 2));
    },
  );

  server.registerTool(
    "write_edl",
    {
      title: "Validate and save an EDL",
      description:
        "Validates an edited EDL (schema + invariants: frame times, overlaps, references) and saves it only if valid. Returns the diagnostics.",
      inputSchema: {
        edlPath: z.string(),
        edl: z.record(z.string(), z.unknown()).describe("The whole EDL object"),
      },
    },
    async ({ edlPath, edl }) => {
      if (!/\.json$/i.test(edlPath)) return { ...text("The EDL path must end with .json."), isError: true };
      edlPath = confinePath(edlPath);
      const result = parseEdl(edl);
      const diag = result.diagnostics.map((d) => `${d.level}: ${d.message}`);
      if (!result.ok) return { ...text(["EDL not saved: invalid.", ...diag].join("\n")), isError: true };
      await mkdir(dirname(resolve(edlPath)), { recursive: true });
      await writeFile(edlPath, `${JSON.stringify(edl, null, 2)}\n`);
      return text([`EDL saved: ${edlPath}`, ...diag].join("\n"));
    },
  );

  server.registerTool(
    "render_edl",
    {
      title: "Render an EDL",
      description: "Renders the EDL to a video (and a .srt when there are captions).",
      inputSchema: {
        edlPath: z.string(),
        out: z.string().describe("Output .mp4"),
        draft: z.boolean().default(true),
      },
    },
    async ({ edlPath, out, draft }) => {
      edlPath = confinePath(edlPath);
      out = confinePath(out);
      const result = parseEdl(JSON.parse(await readFile(edlPath, "utf8")));
      if (!result.ok) return { ...text(result.diagnostics.map((d) => d.message).join("\n")), isError: true };
      const log = await doRender(result.edl, edlPath, out, draft, true);
      return text(
        [`Rendered: ${out} (${log.frames} frames)`, ...log.warnings.map((w) => `⚠ ${w}`)].join("\n"),
      );
    },
  );

  server.registerTool(
    "quality_check",
    {
      title: "Quality check",
      description: `Scores a rendered video on ${RULES.length} rules (silences, hesitations, beat sync, motion, captions sync/safe zones/contrast, loudness, ducking, reframing, colour, flashes, export). Pass the EDL for the full check.`,
      inputSchema: {
        video: z.string(),
        edlPath: z.string().optional(),
        reportPath: z.string().optional().describe("Also write the Markdown report here"),
        ...common,
      },
    },
    async ({ video, edlPath, reportPath, profile, look }) => {
      video = confinePath(video);
      if (edlPath) edlPath = confinePath(edlPath);
      if (reportPath) reportPath = confinePath(reportPath);
      const report = await check(
        video,
        await profileOf(profile, look),
        edlPath,
        reportPath ? { md: reportPath } : {},
      );
      return text(reportSummary(report, reportPath ? { report: reportPath } : {}));
    },
  );

  server.registerTool(
    "make_shorts",
    {
      title: "Long video → ranked Shorts",
      description:
        "Finds the passages of a long recording that make the best standalone Shorts (strongest opening line, complete idea, requested duration), then edits, renders and scores each one. Returns them ranked with their hook and quality score. ai=true lets Claude choose the clips (needs Anthropic credentials where CutKiller runs; otherwise the offline planner is used).",
      inputSchema: {
        inputs: z.array(z.string()).min(1).describe("The long recording(s), plus an optional music file"),
        outDir: z.string(),
        count: z.number().int().min(1).max(20).default(5),
        minS: z.number().positive().default(15),
        maxS: z.number().positive().default(60),
        ai: z.boolean().default(false),
        draft: z.boolean().default(true),
        lang: z.string().optional(),
        ...common,
      },
    },
    async ({ inputs, outDir, count, minS, maxS, ai, draft, lang, profile, look }) => {
      const { makeShorts } = await import("./shorts");
      outDir = confinePath(outDir);
      const results = await makeShorts(
        inputs.map((i) => confinePath(i)),
        await profileOf(profile, look),
        {
          dir: outDir,
          count,
          minS,
          maxS,
          ai,
          draft,
          ...(lang ? { language: lang } : {}),
        },
      );
      return text(
        [
          ...results.map(
            (r) =>
              `${r.rank}. ${r.plan.title} — ${r.plan.durationS} s — hook ${r.plan.scores.hook}/10 — quality ${r.report.score}/100 — ${r.video}\n   « ${r.plan.hook} »`,
          ),
          `Ranking: ${outDir}/shorts.md`,
        ].join("\n"),
      );
    },
  );

  server.registerTool(
    "export_timeline",
    {
      title: "Export to Premiere / DaVinci / Final Cut",
      description:
        "Writes the edit as a timeline a pro editor opens: .otio (DaVinci Resolve, Avid, OTIO tools) or .xml (Final Cut Pro 7 XML: Premiere Pro, DaVinci Resolve, Final Cut). Cuts, rushes' audio, music, punch-ins and one marker per edit decision; captions go in the .srt.",
      inputSchema: {
        edlPath: z.string(),
        out: z.string().regex(/\.(otio|xml)$/i, "ends with .otio or .xml"),
      },
    },
    async ({ edlPath, out }) => {
      edlPath = confinePath(edlPath);
      out = confinePath(out);
      const result = parseEdl(JSON.parse(await readFile(edlPath, "utf8")));
      if (!result.ok) return { ...text(result.diagnostics.map((d) => d.message).join("\n")), isError: true };
      const opts = { baseDir: dirname(resolve(edlPath)) };
      await writeFile(out, /\.xml$/i.test(out) ? toFcp7Xml(result.edl, opts) : toOtio(result.edl, opts));
      return text(`Timeline written: ${out}`);
    },
  );

  return server;
}

export async function serveMcp(): Promise<void> {
  // stdout carries JSON-RPC: route the pipeline's console output to stderr.
  console.log = (...args: unknown[]) => console.error(...args);
  const server = createServer();
  await server.connect(new StdioServerTransport());
}
