import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generateFixtures } from "@cutkiller/fixtures";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const MAIN = resolve(import.meta.dirname, "../src/main.ts");
const ROOT = resolve(import.meta.dirname, "../../..");
const TSX = resolve(ROOT, "node_modules/.bin/tsx");

type TextResult = { content: { type: string; text: string }[]; isError?: boolean };
const textOf = (r: unknown) => (r as TextResult).content.map((c) => c.text).join("\n");

describe("MCP server (stdio, real client)", () => {
  const client = new Client({ name: "cutkiller-test", version: "0.0.0" });

  beforeAll(async () => {
    await client.connect(
      new StdioClientTransport({ command: TSX, args: [MAIN, "mcp"], cwd: ROOT, stderr: "ignore" }),
    );
  }, 60_000);
  afterAll(async () => {
    await client.close();
  });

  it("lists the editing tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "auto_edit",
        "doctor",
        "export_timeline",
        "list_styles",
        "plan_edit",
        "quality_check",
        "read_edl",
        "render_edl",
        "write_edl",
      ].sort(),
    );
    const styles = textOf(await client.callTool({ name: "list_styles", arguments: {} }));
    expect(styles).toMatch(/neon-80s/);
    expect(styles).toMatch(/en, es/);
  });

  it("edits end to end, then refuses an invalid EDL and saves a valid one", async () => {
    const fx = await generateFixtures();
    const dir = await mkdtemp(join(tmpdir(), "ck-mcp-"));
    const result = await client.callTool(
      {
        name: "auto_edit",
        arguments: { inputs: [fx.cam9x16, fx.phoneVfr, fx.music], outDir: dir, fast: true },
      },
      undefined,
      { timeout: 600_000 },
    );
    const summary = textOf(result);
    expect(summary, summary).toMatch(/Quality score: (9\d|100)(\.\d)?\/100/);
    expect(summary).toContain(join(dir, "final.mp4"));

    const edlPath = join(dir, "edit.edl.json");
    const edl = JSON.parse(await readFile(edlPath, "utf8"));
    const broken = await client.callTool({
      name: "write_edl",
      arguments: { edlPath, edl: { ...edl, output: { ...edl.output, fps: -1 } } },
    });
    expect((broken as TextResult).isError).toBe(true);
    expect(textOf(broken)).toMatch(/not saved/);

    const ok = await client.callTool({
      name: "write_edl",
      arguments: { edlPath: join(dir, "copy.edl.json"), edl },
    });
    expect(textOf(ok)).toMatch(/EDL saved/);

    const xml = join(dir, "edit.xml");
    expect(
      textOf(await client.callTool({ name: "export_timeline", arguments: { edlPath, out: xml } })),
    ).toMatch(/written/);
    expect(await readFile(xml, "utf8")).toContain("<xmeml");
  }, 700_000);
});
