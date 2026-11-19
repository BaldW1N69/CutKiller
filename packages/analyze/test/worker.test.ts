import { describe, expect, it } from "vitest";
import { runWorker, sourceId } from "../src";

describe("analyze", () => {
  it("runs a Python worker over the JSON protocol", async () => {
    const res = await runWorker<{ echo: unknown }>("ping", { hello: "monde" });
    expect(res.echo).toEqual({ hello: "monde" });
  });

  it("reports worker errors", async () => {
    await expect(runWorker("does-not-exist", {})).rejects.toThrow(/tâche inconnue/);
  });

  it("derives stable, unique source ids", () => {
    const taken: Record<string, unknown> = {};
    const a = sourceId("/r/Interview Take 1.MOV", taken);
    taken[a] = 1;
    expect(a).toBe("Interview-Take-1");
    expect(sourceId("/other/Interview Take 1.mp4", taken)).toBe("Interview-Take-1-2");
  });
});
