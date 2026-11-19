/**
 * Language of CutKiller's own messages (CLI, logs, quality report): English by
 * default, French when CUTKILLER_LANG (or LC_ALL / LC_MESSAGES / LANG) starts
 * with "fr". Unrelated to the spoken language of the rushes.
 */
export type Locale = "en" | "fr";

export function locale(): Locale {
  const v =
    process.env.CUTKILLER_LANG || process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || "";
  return v.toLowerCase().startsWith("fr") ? "fr" : "en";
}

/** The English or the French text, by the current locale. */
export const tr = (en: string, fr: string): string => (locale() === "fr" ? fr : en);
