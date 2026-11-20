/**
 * B-roll found for you: `--broll-search "harbor boats"` downloads short excerpts
 * of free footage and adds them as cutaways, with their credits in credits.txt.
 *
 * Sources, in order: Pexels when PEXELS_API_KEY is set (Pexels license: free for
 * commercial use, no attribution required), then Wikimedia Commons (no key).
 * From Commons only public domain, CC0 and CC BY are taken by default: CC BY-SA
 * would put the whole edited video under BY-SA (opt in with allowShareAlike).
 * Only the excerpt is read (FFmpeg seeks over HTTP), never the whole file.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tr } from "@cutkiller/core";
import { ffmpeg } from "@cutkiller/media";

export interface StockClip {
  provider: "pexels" | "commons";
  title: string;
  url: string;
  page: string;
  width: number;
  height: number;
  durationS: number;
  license: string;
  credit: string;
}

export interface StockOptions {
  count?: number;
  minHeight?: number;
  allowShareAlike?: boolean;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

const UA = { "User-Agent": "cutkiller (https://github.com/BaldW1N69/CutKiller)" };
const FREE = /^(public domain|cc0|cc-0|cc by \d|cc-by-\d|cc by-\d)/i;
const SHARE_ALIKE = /^(cc by-sa|cc-by-sa)/i;

const strip = (html: string) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();

export async function searchCommons(query: string, opts: StockOptions = {}): Promise<StockClip[]> {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    generator: "search",
    gsrsearch: `filetype:video ${query}`,
    gsrnamespace: "6",
    gsrlimit: "30",
    prop: "imageinfo",
    iiprop: "url|size|mime|extmetadata",
    iiextmetadatafilter: "LicenseShortName|Artist",
  });
  const res = await (opts.fetchImpl ?? fetch)(`https://commons.wikimedia.org/w/api.php?${params}`, {
    headers: UA,
  });
  if (!res.ok) throw new Error(`Wikimedia Commons: HTTP ${res.status}`);
  type Page = {
    title: string;
    index?: number;
    imageinfo?: {
      url: string;
      descriptionurl?: string;
      width?: number;
      height?: number;
      duration?: number;
      extmetadata?: Record<string, { value: string }>;
    }[];
  };
  const body = (await res.json()) as { query?: { pages?: Record<string, Page> } };
  const pages = Object.values(body.query?.pages ?? {}).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const out: StockClip[] = [];
  for (const p of pages) {
    const ii = p.imageinfo?.[0];
    if (!ii) continue;
    const license = ii.extmetadata?.LicenseShortName?.value ?? "";
    if (!FREE.test(license) && !(opts.allowShareAlike && SHARE_ALIKE.test(license))) continue;
    if ((ii.height ?? 0) < (opts.minHeight ?? 720) || (ii.duration ?? 0) < 4) continue;
    const artist = strip(ii.extmetadata?.Artist?.value ?? "unknown");
    const title = p.title.replace(/^File:/, "").replace(/\.[a-z0-9]+$/i, "");
    out.push({
      provider: "commons",
      title,
      url: ii.url,
      page: ii.descriptionurl ?? ii.url,
      width: ii.width ?? 0,
      height: ii.height ?? 0,
      durationS: ii.duration ?? 0,
      license,
      credit: `"${title}" by ${artist}, ${license}, via Wikimedia Commons (${ii.descriptionurl ?? ii.url})`,
    });
  }
  return out;
}

export async function searchPexels(query: string, opts: StockOptions = {}): Promise<StockClip[]> {
  const key = (opts.env ?? process.env).PEXELS_API_KEY;
  if (!key) return [];
  const params = new URLSearchParams({ query, per_page: "15", size: "medium" });
  const res = await (opts.fetchImpl ?? fetch)(`https://api.pexels.com/videos/search?${params}`, {
    headers: { ...UA, Authorization: key },
  });
  if (!res.ok) throw new Error(`Pexels: HTTP ${res.status}`);
  type Video = {
    url: string;
    duration: number;
    user?: { name?: string };
    video_files: { link: string; width: number; height: number; file_type: string }[];
  };
  const body = (await res.json()) as { videos?: Video[] };
  const min = opts.minHeight ?? 720;
  return (body.videos ?? []).flatMap((v) => {
    const file = v.video_files
      .filter((f) => f.file_type === "video/mp4" && f.height >= min)
      .sort((a, b) => a.height - b.height)[0];
    if (!file || v.duration < 4) return [];
    const title = v.url.split("/").filter(Boolean).pop() ?? "pexels video";
    return [
      {
        provider: "pexels" as const,
        title,
        url: file.link,
        page: v.url,
        width: file.width,
        height: file.height,
        durationS: v.duration,
        license: "Pexels License",
        credit: `Video by ${v.user?.name ?? "unknown"} on Pexels (${v.url})`,
      },
    ];
  });
}

/** Up to `count` clips for a query, Pexels first when a key is set. */
export async function searchBroll(query: string, opts: StockOptions = {}): Promise<StockClip[]> {
  const pexels = await searchPexels(query, opts).catch(() => []);
  const commons = pexels.length >= (opts.count ?? 3) ? [] : await searchCommons(query, opts);
  return [...pexels, ...commons].slice(0, opts.count ?? 3);
}

/**
 * Downloads an 8 s excerpt of each clip (from 20 % into it, where the action
 * usually is), as H.264 at most 1080 p high, and appends the credits.
 */
export async function fetchBroll(
  query: string,
  dir: string,
  opts: StockOptions & { log?: (m: string) => void; seconds?: number } = {},
): Promise<string[]> {
  const clips = await searchBroll(query, opts);
  if (clips.length === 0) {
    opts.log?.(tr(`no free B-roll found for « ${query} »`, `aucun B-roll libre trouvé pour « ${query} »`));
    return [];
  }
  await mkdir(dir, { recursive: true });
  const seconds = opts.seconds ?? 8;
  const paths: string[] = [];
  for (const [i, c] of clips.entries()) {
    const path = join(dir, `broll-${String(i + 1).padStart(2, "0")}.mp4`);
    const start = Math.max(0, Math.min(c.durationS - seconds, c.durationS * 0.2));
    try {
      await ffmpeg([
        "-v",
        "error",
        "-ss",
        start.toFixed(2),
        "-t",
        String(Math.min(seconds, c.durationS)),
        "-user_agent",
        UA["User-Agent"],
        "-i",
        c.url,
        "-an",
        "-vf",
        "scale=-2:'min(1080,ih)'",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-y",
        path,
      ]);
      paths.push(path);
      await appendFile(join(dir, "..", "credits.txt"), `B-roll: ${c.credit}\n`);
      opts.log?.(`▣ « ${query} » → ${c.title} (${c.license}, ${c.width}×${c.height})`);
    } catch (err) {
      opts.log?.(`⚠ ${c.title}: ${(err as Error).message.split("\n")[0]}`);
    }
  }
  return paths;
}
