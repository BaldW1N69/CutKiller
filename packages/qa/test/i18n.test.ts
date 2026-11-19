import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { locale, tr } from "@cutkiller/core";
import { loadProfile } from "@cutkiller/style";
import { afterEach, describe, expect, it } from "vitest";
import { buildReport, reportMarkdown } from "../src/index";

const saved = process.env.CUTKILLER_LANG;
afterEach(() => {
  process.env.CUTKILLER_LANG = saved;
});

describe("message language", () => {
  it("English by default, French on request", () => {
    process.env.CUTKILLER_LANG = "";
    const lang = process.env.LANG;
    process.env.LANG = "en_US.UTF-8";
    expect(locale()).toBe("en");
    process.env.CUTKILLER_LANG = "fr_FR";
    expect(locale()).toBe("fr");
    expect(tr("cut", "coupe")).toBe("coupe");
    process.env.LANG = lang;
  });

  it("the quality report reads in the chosen language", async () => {
    const profile = await loadProfile("short");
    const report = () =>
      reportMarkdown(
        buildReport(
          { video: "v.mp4", profile: "short@1" },
          [{ ruleId: "audio.loudness", status: "fail", score: 0.5, violations: [{ message: "x" }] }],
          { profile },
        ),
      );
    process.env.CUTKILLER_LANG = "en";
    const en = report();
    expect(en).toContain("| Rule | Weight | Status |");
    expect(en).toContain("Captions synced to the word");
    expect(en).toContain("## To fix");
    expect(en).not.toMatch(/Écarts|Règle/);
    process.env.CUTKILLER_LANG = "fr";
    const fr = report();
    expect(fr).toContain("| Règle | Poids | Statut |");
    expect(fr).toContain("Sous-titres synchronisés au mot");
  });

  it("CLI help follows the locale", () => {
    const main = resolve(import.meta.dirname, "../../cli/src/main.ts");
    const tsx = resolve(import.meta.dirname, "../../../node_modules/.bin/tsx");
    const help = (lang: string) =>
      spawnSync(tsx, [main, "help"], { encoding: "utf8", env: { ...process.env, CUTKILLER_LANG: lang } })
        .stdout;
    expect(help("en")).toContain("cutkiller <command> [options]");
    expect(help("fr")).toContain("cutkiller <commande> [options]");
  });
});
