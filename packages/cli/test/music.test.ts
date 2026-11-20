import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fetchMusic, searchMusic } from "../src/music";

const result = (title: string, duration: number, license = "cc0", extra = {}) => ({
  id: title,
  title,
  creator: "someone",
  license,
  license_version: "1.0",
  duration: duration * 1000,
  url: `https://cdn.example/${title}.mp3`,
  filetype: "mp3",
  foreign_landing_url: `https://example/${title}`,
  attribution: `"${title}" by someone is marked with ${license.toUpperCase()}`,
  ...extra,
});

/** Offline Openverse: one search response, then the audio bytes. */
const fakeFetch = (results: unknown[]): typeof fetch =>
  (async (url: string) => {
    if (String(url).includes("api.openverse.org")) {
      expect(String(url)).toContain("license=cc0%2Cby");
      return new Response(JSON.stringify({ results }), { status: 200 });
    }
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  }) as typeof fetch;

describe("free music (Openverse)", () => {
  it("prefers tracks long enough for the edit, drops mature content", async () => {
    const tracks = await searchMusic("lofi", {
      minDurationS: 60,
      fetchImpl: fakeFetch([
        result("loop", 20),
        result("adult", 200, "cc0", { mature: true }),
        result("bed", 180, "by"),
      ]),
    });
    expect(tracks.map((t) => t.title)).toEqual(["bed", "loop"]);
    expect(tracks[0]?.duration).toBe(180);
  });

  it("downloads the best match and writes its credit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ck-music-"));
    const { path, track } = await fetchMusic("lofi", dir, {
      fetchImpl: fakeFetch([result("Chill bed.wav", 90, "by")]),
      resolveHost: async () => ["93.184.216.34"],
    });
    expect(path).toBe(join(dir, "music-Chill-bed.mp3"));
    expect(track.license).toBe("by");
    const credits = await readFile(join(dir, "credits.txt"), "utf8");
    expect(credits).toContain('"Chill bed.wav" by someone');
    expect(credits).toContain("https://example/Chill bed.wav");
  });

  it("never downloads from this machine or its network, even through a redirect", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ck-music-"));
    const internal = (url: string) => ({ ...result("bed", 90), url });
    for (const url of [
      "http://cdn.example/a.mp3",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/a.mp3",
    ])
      await expect(fetchMusic("lofi", dir, { fetchImpl: fakeFetch([internal(url)]) })).rejects.toThrow(
        /refused|refusé/,
      );
    // A public URL that redirects to a private one is refused at the second hop.
    const redirecting = (async (url: string) => {
      if (String(url).includes("api.openverse.org"))
        return new Response(JSON.stringify({ results: [result("bed", 90)] }), { status: 200 });
      return new Response(null, { status: 302, headers: { location: "https://10.0.0.5/secret" } });
    }) as typeof fetch;
    await expect(
      fetchMusic("lofi", dir, { fetchImpl: redirecting, resolveHost: async () => ["93.184.216.34"] }),
    ).rejects.toThrow(/refused|refusé/);
  });

  it("says so when nothing is found", async () => {
    await expect(fetchMusic("zzz", tmpdir(), { fetchImpl: fakeFetch([]) })).rejects.toThrow(/zzz/);
  });
});
