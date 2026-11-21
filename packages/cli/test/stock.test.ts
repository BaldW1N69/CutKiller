import { describe, expect, it } from "vitest";
import { searchBroll, searchCommons, searchPexels } from "../src/stock";

const commonsPage = (title: string, license: string, height: number, duration: number, index: number) => ({
  title: `File:${title}.webm`,
  index,
  imageinfo: [
    {
      url: `https://upload.example/${title}.webm`,
      descriptionurl: `https://commons.example/${title}`,
      width: Math.round((height * 16) / 9),
      height,
      duration,
      extmetadata: { LicenseShortName: { value: license }, Artist: { value: `<a href="x">Jane</a> Doe` } },
    },
  ],
});

const fake = (routes: Record<string, unknown>): typeof fetch =>
  (async (url: string, init?: { headers?: Record<string, string> }) => {
    const key = Object.keys(routes).find((k) => String(url).includes(k));
    if (!key) return new Response("not found", { status: 404 });
    if (key === "pexels" && init?.headers?.Authorization !== "KEY") return new Response("", { status: 401 });
    return new Response(JSON.stringify(routes[key]), { status: 200 });
  }) as typeof fetch;

const COMMONS = {
  query: {
    pages: {
      a: commonsPage("harbor-by-sa", "CC BY-SA 4.0", 2160, 120, 1),
      b: commonsPage("harbor-pd", "Public domain", 1080, 60, 2),
      c: commonsPage("harbor-small", "CC0", 480, 60, 3),
      d: commonsPage("harbor-by", "CC BY 4.0", 1080, 30, 4),
      e: commonsPage("harbor-nc", "CC BY-NC 4.0", 1080, 30, 5),
    },
  },
};

describe("B-roll search", () => {
  it("Commons: keeps public domain, CC0 and CC BY in HD; share-alike only on request", async () => {
    const clips = await searchCommons("harbor", { fetchImpl: fake({ commons: COMMONS }) });
    expect(clips.map((c) => c.title)).toEqual(["harbor-pd", "harbor-by"]);
    expect(clips[1]?.credit).toBe(
      '"harbor-by" by Jane Doe, CC BY 4.0, via Wikimedia Commons (https://commons.example/harbor-by)',
    );
    const withSa = await searchCommons("harbor", {
      fetchImpl: fake({ commons: COMMONS }),
      allowShareAlike: true,
    });
    expect(withSa.map((c) => c.title)).toContain("harbor-by-sa");
  });

  it("Pexels only with a key, smallest HD mp4, then Commons fills the rest", async () => {
    const pexels = {
      videos: [
        {
          url: "https://www.pexels.com/video/boats-123/",
          duration: 20,
          user: { name: "Ana" },
          video_files: [
            { link: "https://p/sd.mp4", width: 640, height: 360, file_type: "video/mp4" },
            { link: "https://p/hd.mp4", width: 1920, height: 1080, file_type: "video/mp4" },
            { link: "https://p/4k.mp4", width: 3840, height: 2160, file_type: "video/mp4" },
          ],
        },
      ],
    };
    const fetchImpl = fake({ pexels, commons: COMMONS });
    expect(await searchPexels("boats", { fetchImpl, env: {} })).toEqual([]);
    const clips = await searchBroll("boats", { fetchImpl, env: { PEXELS_API_KEY: "KEY" }, count: 3 });
    expect(clips.map((c) => [c.provider, c.url])).toEqual([
      ["pexels", "https://p/hd.mp4"],
      ["commons", "https://upload.example/harbor-pd.webm"],
      ["commons", "https://upload.example/harbor-by.webm"],
    ]);
    expect(clips[0]?.credit).toBe("Video by Ana on Pexels (https://www.pexels.com/video/boats-123/)");
  });
});
