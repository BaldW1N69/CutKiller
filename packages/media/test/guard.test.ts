import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeMono, probeSource } from "../src";

describe("media input guard", () => {
  it("refuses a playlist sent as a rush (it would read another file of the machine)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ck-guard-"));
    const secret = join(dir, "other-user.wav");
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=duration=1", secret]);
    const playlist = join(dir, "upload.m3u8");
    await writeFile(playlist, `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n${secret}\n#EXT-X-ENDLIST\n`);
    await expect(probeSource(playlist)).rejects.toThrow();
    await expect(decodeMono(playlist)).rejects.toThrow();
    // The real media still opens.
    expect((await probeSource(secret)).hasAudio).toBe(true);
  });
});
