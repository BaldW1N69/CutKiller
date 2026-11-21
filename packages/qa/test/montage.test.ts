import { type Analysis, type EdlInput, parseEdl, type Word } from "@cutkiller/core";
import { loadProfile } from "@cutkiller/style";
import { beforeAll, describe, expect, it } from "vitest";
import { checkBeatCuts, checkFillers, checkSilences, checkStaticShots } from "../src/checks/montage";
import { checkPunchIns } from "../src/checks/motion";

let profile: Awaited<ReturnType<typeof loadProfile>>;
beforeAll(async () => {
  profile = await loadProfile("long");
});

const words: Word[] = [
  { text: "Bonjour", start: 1, end: 1.5, timing: "forced" },
  { text: "à", start: 1.6, end: 1.7, timing: "forced" },
  { text: "tous.", start: 1.75, end: 2.1, timing: "forced" },
  { text: "Ensuite", start: 4, end: 4.6, timing: "forced" },
];
const analysis = (beats: number[] = []): Analysis => ({
  sources: {},
  transcripts: { r: { language: "fr", model: "t", durationS: 10, words } },
  ...(beats.length ? { beats: { m: { tempoBpm: 120, beats, durationS: 60 } } } : {}),
});

function edl(clips: EdlInput["video"][number]["clips"], music = false) {
  const r = parseEdl({
    version: "1.0.0",
    output: { format: "long", width: 1920, height: 1080, fps: 30, video: { bitrateMbps: 20 }, audio: {} },
    sources: { r: { path: "r.mp4", durationS: 10 }, m: { path: "m.wav", durationS: 60 } },
    video: [{ id: "main", clips }],
    ...(music ? { audio: [{ id: "music", clips: [{ id: "m1", source: "m", in: 0, out: 10, at: 0 }] }] } : {}),
  });
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
  return r.edl;
}

// Clip 1: words 0-2 with 100 ms margins; clip 2: « Ensuite » with 100 ms margins.
const good = [
  { id: "a", source: "r", in: 0.9, out: 2.2, at: 0, why: { kind: "speech", wordIds: [0, 1, 2] } },
  {
    id: "b",
    source: "r",
    in: 3.9,
    out: 4.7,
    at: 39,
    transform: { scale: 1.08 },
    why: { kind: "speech", wordIds: [3] },
  },
];

describe("montage checks", () => {
  it("silences: flags long pauses in the render and out-of-range margins", async () => {
    const vad = (gaps: number[]) => {
      let t = 0;
      const speech = [{ start: 0, end: 1 }];
      for (const g of gaps) {
        t = (speech.at(-1) as { end: number }).end + g;
        speech.push({ start: t, end: t + 1 });
      }
      return { durationS: 20, speech, noiseFloorDb: -60, peakDb: -10 };
    };
    const ok = await checkSilences("x.mp4", edl(good), profile, analysis(), vad([0.2, 0.3]));
    expect(ok.status).toBe("pass");
    const long = await checkSilences("x.mp4", edl(good), profile, analysis(), vad([0.2, 0.6]));
    expect(long.violations.map((v) => v.message)).toEqual(["silence de 600 ms"]);
    const tight = [
      { ...good[0]!, out: 2.15 },
      { ...good[1]!, at: 38 },
    ];
    const margins = await checkSilences("x.mp4", edl(tight), profile, analysis(), vad([0.2]));
    expect(margins.violations[0]?.message).toMatch(/marge après « tous\. » de 67 ms/); // out quantized to 38 frames → 2.167 s
  });

  it("fillers: counts hesitations and false starts left in the render", async () => {
    const transcript = {
      language: "fr",
      model: "t",
      durationS: 3,
      words: [
        { text: "je", start: 0, end: 0.2, timing: "whisper" as const },
        { text: "euh", start: 0.3, end: 0.5, timing: "whisper" as const },
        { text: "pense", start: 0.6, end: 0.9, timing: "whisper" as const },
      ],
    };
    const r = await checkFillers("x.mp4", profile, 30, transcript);
    expect(r).toMatchObject({ status: "fail" });
    expect(r.violations[0]?.message).toContain("euh");
  });

  it("beat cuts: a reachable beat must be hit, an unreachable one is not required", () => {
    // Cut at frame 39. Clip a can grow by 20+20 ms (≈1 frame) or shrink by 20+20 ms.
    expect(checkBeatCuts(edl(good, true), profile, analysis([39.2 / 30]))).toMatchObject({ status: "pass" });
    expect(checkBeatCuts(edl(good, true), profile, analysis([40.9 / 30])).status).toBe("fail");
    expect(checkBeatCuts(edl(good, true), profile, analysis([45 / 30])).status).toBe("not-evaluated");
    expect(checkBeatCuts(edl(good), profile, analysis()).status).toBe("not-evaluated");
  });

  it("static shots: a visual change is needed before the profile limit", () => {
    const long = [{ id: "a", source: "r", in: 0, out: 9, at: 0 }];
    expect(checkStaticShots(edl(long), profile).violations[0]?.message).toBe("plan statique de 9.0 s");
    const sameFraming = [
      { id: "a", source: "r", in: 0, out: 4.5, at: 0 },
      { id: "b", source: "r", in: 5, out: 9.5, at: 135 },
    ];
    expect(checkStaticShots(edl(sameFraming), profile).status).toBe("fail");
    expect(checkStaticShots(edl(good), profile).status).toBe("pass");
  });

  it("punch-ins: within range, never twice in a row at the same level", () => {
    const clips = (scales: number[]) =>
      scales.map((scale, i) => ({
        id: `c${i}`,
        source: "r",
        in: i,
        out: i + 1,
        at: i * 30,
        transform: { scale },
      }));
    expect(checkPunchIns(edl(clips([1, 1.08, 1, 1.12])), profile).status).toBe("pass");
    expect(checkPunchIns(edl(clips([1, 1.08, 1, 1.08])), profile).violations[0]?.message).toMatch(
      /deux punch-ins/,
    );
    expect(checkPunchIns(edl(clips([1, 1.3])), profile).violations[0]?.message).toMatch(/130 %/);
  });
});
