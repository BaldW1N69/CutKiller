import {
  dominantLanguage,
  FRENCH,
  lexicon,
  localizeProfile,
  StyleProfileSchema,
  SUPPORTED_LANGUAGES,
} from "@cutkiller/core";
import { describe, expect, it } from "vitest";
import { loadProfile } from "../src/index";

describe("lexicon", () => {
  it("covers the languages the workers align", () => {
    expect(SUPPORTED_LANGUAGES).toEqual(expect.arrayContaining(["fr", "en", "es", "de", "it", "pt", "nl"]));
    for (const code of SUPPORTED_LANGUAGES) {
      const lex = lexicon(code);
      expect(lex.fillerWords.length, code).toBeGreaterThan(3);
      expect(lex.stopWords.length, code).toBeGreaterThan(20);
      // A pure hesitation is never also a word that carries meaning in the same language.
      for (const f of lex.fillerWords) expect(lex.stopWords, `${code}: ${f}`).not.toContain(f);
    }
    expect(lexicon("en-US")).toBe(lexicon("en"));
    expect(lexicon("xx").fillerWords).toContain("hmm");
  });

  it("swaps the French defaults, keeps lists a profile customised", async () => {
    const profile = await loadProfile("long");
    expect(profile.montage.fillerWords).toEqual(FRENCH.fillerWords);
    const en = localizeProfile(profile, "en");
    expect(en.montage.fillerWords).toContain("um");
    expect(en.montage.fillerWords).not.toContain("ben");
    expect(en.motion.stopWords).toContain("the");
    expect(localizeProfile(profile, "fr")).toBe(profile);
    const custom = { ...profile, montage: { ...profile.montage, fillerWords: ["bof"] } };
    expect(localizeProfile(custom, "en").montage.fillerWords).toEqual(["bof"]);
    expect(StyleProfileSchema.safeParse(en).success).toBe(true);
  });

  it("dominant language counts words", () => {
    expect(dominantLanguage(undefined)).toBeUndefined();
    expect(
      dominantLanguage({ a: { language: "fr", words: [1, 2] }, b: { language: "en", words: [1, 2, 3] } }),
    ).toBe("en");
  });
});
