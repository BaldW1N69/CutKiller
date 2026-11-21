import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { confinePath } from "../src";

describe("workspace confinement", () => {
  const ws = mkdtempSync(join(tmpdir(), "ck-ws-"));
  const outside = mkdtempSync(join(tmpdir(), "ck-out-"));
  writeFileSync(join(outside, "secret.mp4"), "x");
  mkdirSync(join(ws, "rushes"));
  symlinkSync(outside, join(ws, "rushes", "link"));
  const env = { CUTKILLER_WORKSPACE: ws };

  it("accepts paths inside, existing or not", () => {
    expect(confinePath(join(ws, "rushes", "a.mp4"), env)).toContain("rushes");
    expect(confinePath(join(ws, "out", "new", "final.mp4"), env)).toContain("final.mp4");
  });

  it("refuses absolute paths, '..' and symlinks that lead outside", () => {
    expect(() => confinePath(join(outside, "secret.mp4"), env)).toThrow(/workspace|espace/);
    expect(() => confinePath(join(ws, "..", "etc", "passwd"), env)).toThrow();
    expect(() => confinePath(join(ws, "rushes", "link", "secret.mp4"), env)).toThrow();
    expect(() => confinePath(join(ws, "rushes", "link", "new.mp4"), env)).toThrow();
  });

  it("only resolves when no workspace is set (one person's own machine)", () => {
    expect(confinePath(join(outside, "secret.mp4"), {})).toBe(join(outside, "secret.mp4"));
  });
});
