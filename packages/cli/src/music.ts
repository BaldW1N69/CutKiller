/**
 * Free music from Openverse (CC0 and CC BY audio from Freesound, Jamendo,
 * Wikimedia…): the best match for a query is downloaded next to the edit and
 * its attribution written to credits.txt, ready to paste in a description.
 *
 * Only CC0 and CC BY are requested: both allow commercial use and edits; CC BY
 * requires the credit, which is why it is always written.
 */
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tr } from "@cutkiller/core";
import { fetchPublic, type HostResolver } from "./net";

const API = "https://api.openverse.org/v1/audio/";
/** A music bed is a few MB; anything far larger is not one. */
const MAX_MUSIC_BYTES = 100 * 1024 * 1024;

export interface Track {
  id: string;
  title: string;
  creator: string;
  license: string;
  licenseVersion: string;
  /** Seconds. */
  duration: number;
  url: string;
  filetype: string;
  landingUrl: string;
  attribution: string;
}

interface OpenverseAudio {
  id: string;
  title?: string;
  creator?: string;
  license: string;
  license_version?: string;
  duration?: number | null;
  url: string;
  filetype?: string | null;
  foreign_landing_url?: string;
  attribution?: string;
  mature?: boolean;
}

/**
 * Candidates for a query, best first: long enough to cover the edit, then the
 * API's relevance order. Loops shorter than `minDurationS` are kept last (the
 * mixer can still use them, with a fade).
 */
export async function searchMusic(
  query: string,
  opts: { minDurationS?: number; licenses?: string[]; fetchImpl?: typeof fetch } = {},
): Promise<Track[]> {
  const params = new URLSearchParams({
    q: query,
    license: (opts.licenses ?? ["cc0", "by"]).join(","),
    page_size: "20",
    mature: "false",
  });
  const res = await (opts.fetchImpl ?? fetch)(`${API}?${params}`, {
    headers: { "User-Agent": "cutkiller (https://github.com/BaldW1N69/CutKiller)" },
  });
  if (!res.ok) throw new Error(tr(`Openverse: HTTP ${res.status}`, `Openverse : HTTP ${res.status}`));
  const body = (await res.json()) as { results?: OpenverseAudio[] };
  const min = opts.minDurationS ?? 0;
  const tracks: Track[] = (body.results ?? [])
    .filter((r) => !r.mature && r.url && (r.filetype ?? "mp3").match(/mp3|wav|ogg|flac|m4a/i))
    .map((r) => ({
      id: r.id,
      title: r.title ?? "untitled",
      creator: r.creator ?? "unknown",
      license: r.license,
      licenseVersion: r.license_version ?? "",
      duration: (r.duration ?? 0) / 1000,
      url: r.url,
      filetype: (r.filetype ?? "mp3").toLowerCase(),
      landingUrl: r.foreign_landing_url ?? "",
      attribution:
        r.attribution ??
        `"${r.title}" by ${r.creator} (${r.license.toUpperCase()} ${r.license_version ?? ""})`,
    }));
  const long = tracks.filter((t) => t.duration >= min);
  const short = tracks.filter((t) => t.duration < min).sort((a, b) => b.duration - a.duration);
  return [...long, ...short];
}

/** Downloads the best match into `dir` and appends its credit to `dir/credits.txt`. Returns the file path. */
export async function fetchMusic(
  query: string,
  dir: string,
  opts: {
    minDurationS?: number;
    fetchImpl?: typeof fetch;
    resolveHost?: HostResolver;
    log?: (m: string) => void;
  } = {},
): Promise<{ path: string; track: Track }> {
  const tracks = await searchMusic(query, opts);
  const track = tracks[0];
  if (!track)
    throw new Error(
      tr(`no free music found for « ${query} »`, `aucune musique libre trouvée pour « ${query} »`),
    );
  const res = await fetchPublic(track.url, {
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.resolveHost ? { resolveHost: opts.resolveHost } : {}),
  });
  if (!res.ok) throw new Error(`${track.url}: HTTP ${res.status}`);
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_MUSIC_BYTES) throw new Error(`${track.url}: ${declared} bytes, over the limit`);
  await mkdir(dir, { recursive: true });
  const safe = track.title
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .slice(0, 60);
  const ext = /^(mp3|wav|ogg|flac|m4a)$/i.test(track.filetype) ? track.filetype.toLowerCase() : "mp3";
  const id = track.id.replace(/[^\p{L}\p{N}_-]+/gu, "-").slice(0, 60);
  const path = join(dir, `music-${safe || id}.${ext}`);
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length > MAX_MUSIC_BYTES) throw new Error(`${track.url}: ${body.length} bytes, over the limit`);
  await writeFile(path, body);
  await appendFile(join(dir, "credits.txt"), `Music: ${track.attribution}\nSource: ${track.landingUrl}\n`);
  opts.log?.(
    tr(
      `♪ « ${query} » → ${track.title} by ${track.creator} (${track.license.toUpperCase()}, ${Math.round(track.duration)} s) — credit in credits.txt`,
      `♪ « ${query} » → ${track.title} par ${track.creator} (${track.license.toUpperCase()}, ${Math.round(track.duration)} s) — crédit dans credits.txt`,
    ),
  );
  return { path, track };
}
