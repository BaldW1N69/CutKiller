import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listLooks, listProfiles, loadProfile, PresetRegistry, withLook } from "../src";

describe("style profiles", () => {
  it("ships short and long profiles carrying the quality standards", async () => {
    expect(await listProfiles()).toEqual(expect.arrayContaining(["short", "long"]));
    const short = await loadProfile("short");
    expect(short.format).toMatchObject({ kind: "short", width: 1080, height: 1920 });
    expect(short.montage.maxStaticShotS).toBe(4);
    expect(short.captions.wordsPerScreen).toEqual([1, 3]);
    const long = await loadProfile("long");
    expect(long.format).toMatchObject({ kind: "long", width: 1920, height: 1080 });
    expect(long.montage.maxStaticShotS).toBe(8);
    expect(long.captions).toMatchObject({ maxLines: 2, maxCharsPerLine: 32 });
    for (const p of [short, long]) {
      expect(p.audio).toMatchObject({
        integratedLufs: -14,
        lufsTolerance: 1,
        truePeakDbtp: -1,
        cutFadeMs: [5, 10],
      });
      expect(p.montage).toMatchObject({ maxSilenceMs: 350, wordMarginMs: [80, 120], jlCutFrames: [4, 12] });
      expect(p.motion.motionBlurThresholdPxPerFrame).toBe(12);
      expect(p.export.minBitrateMbps).toEqual({ "30": 16, "60": 24 });
    }
  });

  it("ships cinematic profiles: same rules, calmer thresholds, film texture", async () => {
    expect(await listProfiles()).toEqual(expect.arrayContaining(["cinematic", "cinematic-short"]));
    const long = await loadProfile("long");
    const short = await loadProfile("short");
    const cine = await loadProfile("cinematic");
    const cineShort = await loadProfile("cinematic-short");
    expect(cine.format).toMatchObject({ kind: "long", width: 1920, height: 1080 });
    expect(cineShort.format).toMatchObject({ kind: "short", width: 1080, height: 1920 });
    // Longer shots, rarer and slower push-ins, no whoosh on fades.
    expect(cine.montage.maxStaticShotS).toBeGreaterThan(long.montage.maxStaticShotS);
    expect(cineShort.montage.maxStaticShotS).toBeGreaterThan(short.montage.maxStaticShotS);
    expect(cine.motion.punchMinSpacingS).toBeGreaterThan(long.motion.punchMinSpacingS);
    expect(cine.motion.emphasisMinScore).toBeGreaterThan(long.motion.emphasisMinScore);
    expect(cine.texture).toEqual({ grain: 0.07, vignette: 0.35, halation: 0.35, bloom: 0, letterbox: 2.39 });
    expect(cineShort.texture.letterbox).toBeUndefined();
    expect(long.texture).toEqual({ grain: 0, vignette: 0, halation: 0, bloom: 0 });
    // Delivery standards do not change.
    for (const p of [cine, cineShort]) {
      expect(p.audio).toMatchObject({ integratedLufs: -14, truePeakDbtp: -1, cutFadeMs: [5, 10] });
      expect(p.motion.transitionDurationMs).toEqual([200, 500]);
      expect(p.captions.maxSyncErrorFrames).toEqual({ p95: 1, max: 3 });
    }
  });

  it("every preset a profile refers to exists", async () => {
    const registry = await PresetRegistry.load();
    for (const id of await listProfiles()) {
      const p = await loadProfile(id);
      const refs = [
        p.motion.punchPreset,
        ...p.motion.transitions.sameSource,
        ...p.motion.transitions.crossSource,
        p.captions.style,
        p.color.look,
        ...Object.values(p.audio.sfx.transitions),
        ...(p.audio.sfx.punchIn ? [p.audio.sfx.punchIn] : []),
      ];
      for (const ref of refs) expect(() => registry.resolve(ref), `${id} → ${ref}`).not.toThrow();
    }
  });

  it("styles d'image : le look et sa texture remplacent ceux du profil, le reste ne bouge pas", async () => {
    const registry = await PresetRegistry.load();
    const cine = await loadProfile("cinematic");
    const grit = withLook(cine, registry, "bleach-grit");
    expect(grit.color.look).toBe("bleach-grit@1");
    expect(grit.texture).toMatchObject({ grain: 0.11, vignette: 0.5, letterbox: 2.39 });
    expect(grit.montage).toEqual(cine.montage);
    const neon = withLook(await loadProfile("short"), registry, "neon-80s@1");
    expect(neon.texture.bloom).toBeGreaterThan(0);
    expect(neon.texture.letterbox).toBeUndefined();
    expect(() => withLook(cine, registry, "whoosh")).toThrow(/n'est pas un style/);
    const refs = listLooks(registry).map((l) => l.ref);
    expect(refs).toEqual(
      expect.arrayContaining([
        "film-print@1",
        "bleach-grit@1",
        "neon-80s@1",
        "teal-orange@1",
        "noir@1",
        "clean@1",
      ]),
    );
  });

  it("reports invalid profiles with the offending field", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ck-"));
    const path = join(dir, "bad.yaml");
    await writeFile(
      path,
      "id: bad\nversion: 1.0.0\nformat: { kind: short, width: 1080, height: 1920, fps: 12 }\n",
    );
    await expect(loadProfile(path)).rejects.toThrow(/format\.fps/);
    await expect(loadProfile("nope")).rejects.toThrow(/introuvable/);
  });
});

describe("preset registry", () => {
  async function registry(files: Record<string, unknown>) {
    const dir = await mkdtemp(join(tmpdir(), "ck-presets-"));
    for (const [file, content] of Object.entries(files)) {
      await mkdir(join(dir, file.split("/")[0] as string), { recursive: true });
      await writeFile(join(dir, file), JSON.stringify(content));
    }
    return PresetRegistry.load(dir);
  }
  const preset = (version: string) => ({
    name: "zoom-punch",
    version,
    kind: "motion",
    params: { v: version },
  });

  it("resolves name@major to the latest compatible version", async () => {
    const r = await registry({
      "motion/zoom-punch@1.0.0.json": preset("1.0.0"),
      "motion/zoom-punch@1.2.0.json": preset("1.2.0"),
      "motion/zoom-punch@1.10.1.json": preset("1.10.1"),
      "motion/zoom-punch@2.0.0.json": preset("2.0.0"),
    });
    expect(r.resolve("zoom-punch@1").version).toBe("1.10.1");
    expect(r.resolve("zoom-punch@1.2").version).toBe("1.2.0");
    expect(r.resolve("zoom-punch@2").version).toBe("2.0.0");
    expect(r.resolve("zoom-punch@1.0.0").version).toBe("1.0.0");
    expect(() => r.resolve("zoom-punch@3")).toThrow(/introuvable/);
  });

  it("rejects files whose name, version or kind disagree with their content", async () => {
    await expect(registry({ "motion/zoom-punch@1.0.0.json": preset("1.0.1") })).rejects.toThrow(/incohérent/);
    await expect(registry({ "sfx/zoom-punch@1.0.0.json": preset("1.0.0") })).rejects.toThrow(/incohérent/);
  });
});
