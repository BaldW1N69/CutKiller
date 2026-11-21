import { parseEdl } from "@cutkiller/core";
import { probeSource } from "@cutkiller/media";
import { render } from "@cutkiller/render";

const fx = "/home/user/CutKiller/.cache/fixtures";
console.log(await probeSource(`${fx}/phone-vfr.mp4`), await probeSource(`${fx}/still.png`));
const edl = parseEdl({
  version: "1.0.0",
  output: { format: "short", width: 1080, height: 1920, fps: 30, video: { bitrateMbps: 20 }, audio: {} },
  sources: {
    a: { path: `${fx}/cam-16x9.mp4`, durationS: 6, hasAudio: true },
    b: { path: `${fx}/cam-9x16.mp4`, durationS: 4 },
    s: { path: `${fx}/still.png`, still: true, hasAudio: false },
    v: { path: `${fx}/phone-vfr.mp4`, durationS: 5 },
  },
  video: [
    {
      id: "main",
      clips: [
        { id: "c1", source: "a", in: 0.5, out: 2.5, at: 0 },
        { id: "c2", source: "b", in: 1.0, out: 3.0, at: 60, audioSplitFrames: -6 },
        { id: "c3", source: "s", in: 0, out: 1, at: 120 },
        { id: "c4", source: "v", in: 1.0, out: 2.5, at: 150 },
      ],
    },
  ],
});
if (!edl.ok) {
  console.log(edl.diagnostics);
  process.exit(1);
}
const log = await render(edl.edl, {
  baseDir: fx,
  outPath: "/home/user/CutKiller/out/smoke.mp4",
  keepStems: true,
});
console.log({ ...log, clips: log.clips.length });
