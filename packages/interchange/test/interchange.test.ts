import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type Edl, EdlSchema } from "@cutkiller/core";
import { describe, expect, it } from "vitest";
import { editMarkers, timelineFrames, toFcp7Xml, toOtio } from "../src/index";

const edl: Edl = EdlSchema.parse({
  version: "1.5.0",
  meta: { title: "Interview" },
  output: {
    format: "short",
    width: 1080,
    height: 1920,
    fps: 30,
    video: { codec: "h264", bitrateMbps: 20, preset: "medium" },
    audio: {
      sampleRate: 48000,
      targetLufs: -14,
      truePeakDbtp: -1.5,
      musicBedLu: -7,
      bitrateKbps: 192,
      cutFadeMs: 7.5,
    },
  },
  sources: {
    talk: { path: "rushes/talk & co.mp4", durationS: 20, fps: 30, width: 1920, height: 1080, hasAudio: true },
    song: { path: "/abs/music.wav", durationS: 60, hasAudio: true },
  },
  video: [
    {
      id: "main",
      clips: [
        { id: "c1", source: "talk", in: 1, out: 3, at: 0 },
        {
          id: "c2",
          source: "talk",
          in: 4,
          out: 6.5,
          at: 60,
          transform: { scale: 1.1, x: 0, y: 0 },
          why: { kind: "speech", note: "cut before: « um » (filler)" },
        },
      ],
    },
  ],
  audio: [
    { id: "music", clips: [{ id: "m1", source: "song", in: 0, out: 4.5, at: 0, gainDb: -6 }] },
    { id: "sfx", clips: [{ id: "fx1", asset: "whoosh@1.0.0", in: 0, out: 0.5, at: 58 }] },
  ],
});

describe("interchange", () => {
  it("timeline length and markers", () => {
    expect(timelineFrames(edl)).toBe(135);
    expect(editMarkers(edl)).toEqual([
      { frame: 58, name: "SFX whoosh@1.0.0" },
      { frame: 60, name: "cut before: « um » (filler)" },
    ]);
  });

  it("OTIO: every cut at frame accuracy, rushes' audio and music, absolute file URLs", () => {
    const otio = JSON.parse(toOtio(edl, { baseDir: "/proj" }));
    const [v1, a1, a2] = otio.tracks.children;
    expect(otio.tracks.children).toHaveLength(3);
    expect(v1.kind).toBe("Video");
    const clips = v1.children.filter((c: { OTIO_SCHEMA: string }) => c.OTIO_SCHEMA.startsWith("Clip"));
    expect(
      clips.map((c: { source_range: { start_time: { value: number }; duration: { value: number } } }) => [
        c.source_range.start_time.value,
        c.source_range.duration.value,
      ]),
    ).toEqual([
      [30, 60],
      [120, 75],
    ]);
    expect(clips[0].media_references.DEFAULT_MEDIA.target_url).toBe(
      pathToFileURL(resolve("/proj/rushes/talk & co.mp4")).href,
    );
    expect(a1.kind).toBe("Audio");
    expect(a1.children).toHaveLength(2);
    expect(a2.children[0].media_references.DEFAULT_MEDIA.target_url).toBe(
      pathToFileURL(resolve("/abs/music.wav")).href,
    );
    expect(otio.tracks.markers).toHaveLength(2);
  });

  it("FCP7 XML: well-formed, one file element per media, punch-in as Basic Motion scale", () => {
    const xml = toFcp7Xml(edl, { baseDir: "/proj" });
    expect(xml).toContain('<xmeml version="5">');
    expect(xml.match(/<file id="file-1">/g)).toHaveLength(1);
    expect(xml).toContain('<file id="file-1"/>');
    expect(xml).toContain("<value>110.00</value>");
    expect(xml).toContain("talk &amp; co.mp4");
    expect(xml).toMatch(/<start>60<\/start><end>135<\/end><in>120<\/in><out>195<\/out>/);
    const lint = spawnSync("xmllint", ["--noout", "-"], { input: xml });
    if (!lint.error) expect(lint.status, lint.stderr?.toString()).toBe(0);
  });

  it("OTIO file opens with the reference implementation (opentimelineio)", async () => {
    if (spawnSync("uvx", ["--version"]).status !== 0) return;
    const dir = await mkdtemp(join(tmpdir(), "ck-otio-"));
    const file = join(dir, "edit.otio");
    await writeFile(file, toOtio(edl, { baseDir: "/proj" }));
    const script = [
      "import sys, opentimelineio as otio",
      "t = otio.adapters.read_from_file(sys.argv[1])",
      "v = t.video_tracks()[0]",
      "print(len(t.video_tracks()), len(t.audio_tracks()), v.duration().value, [c.source_range.start_time.value for c in v.find_clips()])",
    ].join("\n");
    const r = spawnSync(
      "uvx",
      ["--quiet", "--from", "opentimelineio==0.18.1", "python", "-c", script, file],
      {
        encoding: "utf8",
      },
    );
    if (r.status !== 0 && /network|resolve|connect|fetch/i.test(r.stderr)) return; // offline
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe("1 2 135.0 [30.0, 120.0]");
  }, 180_000);
});
