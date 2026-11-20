import { type Edl, EdlSchema, type Transcript } from "@cutkiller/core";
import { describe, expect, it } from "vitest";
import {
  applySelection,
  type ClaudeLike,
  claudeShorts,
  heuristicCutdown,
  heuristicShorts,
  hookScore,
  sentences,
  titleFrom,
} from "../src/index";

/** A transcript built from sentences: each word lasts 0.3 s, 0.1 s apart, 1 s between sentences. */
function transcript(lines: string[]): Transcript {
  const words: Transcript["words"] = [];
  let t = 0;
  for (const line of lines) {
    for (const w of line.split(" ")) {
      words.push({ text: w, start: t, end: t + 0.3, timing: "forced" });
      t += 0.4;
    }
    t += 1;
  }
  return { language: "en", model: "test", durationS: t, words };
}

const TALK = transcript([
  "So, um, hello everyone and welcome back.",
  "Today we talk about editing.",
  "Why do 90 percent of videos lose viewers in the first three seconds?",
  "Because they open with a greeting instead of the point.",
  "You have to start with the strongest line you have.",
  "Then deliver the payoff before the viewer gets bored.",
  "Anyway, uh, that was it.",
  "Thanks for watching and see you next time.",
]);

describe("editorial director", () => {
  it("splits sentences on final punctuation", () => {
    const s = sentences({ talk: TALK });
    expect(s).toHaveLength(8);
    expect(s[2]?.text).toBe("Why do 90 percent of videos lose viewers in the first three seconds?");
    expect(s[2]?.source).toBe("talk");
  });

  it("a question with a number hooks better than a greeting", () => {
    const s = sentences({ talk: TALK });
    expect(hookScore(s[2]!, "en")).toBeGreaterThan(hookScore(s[0]!, "en"));
    expect(hookScore(s[2]!, "en")).toBeGreaterThan(hookScore(s[6]!, "en"));
  });

  it("offline planner opens the Short on the hook and keeps whole sentences", () => {
    const s = sentences({ talk: TALK });
    const [best] = heuristicShorts(s, { count: 2, minS: 5, maxS: 12, language: "en" });
    expect(best?.sentenceIds[0]).toBe(2);
    expect(best?.hook).toMatch(/^Why do 90 percent/);
    expect(best?.durationS).toBeLessThanOrEqual(12);
    expect(best?.ranges[0]?.start).toBeCloseTo(s[2]!.start - 0.25, 5);
    expect(best?.planner).toBe("heuristic");
  });

  it("titles end on a whole clause, never on a function word", () => {
    expect(
      titleFrom("En débarquant d'un bateau, on a toujours un minimum de 10 heures de repos.", "fr"),
    ).toBe("En débarquant d'un bateau");
    expect(titleFrom("Tu peux faire tous les bateaux.", "fr")).toBe("Tu peux faire tous les bateaux");
    expect(
      titleFrom("Why do most videos lose their viewers in the first three seconds of the edit?", "en"),
    ).toBe("Why do most videos lose their viewers");
  });

  it("clips never share a sentence", () => {
    const s = sentences({ talk: TALK });
    const plans = heuristicShorts(s, { count: 3, minS: 2, maxS: 8 });
    const ids = plans.flatMap((p) => p.sentenceIds);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("cut-down fits the target, opens on the strongest hook, then keeps the original order", () => {
    const s = sentences({ talk: TALK });
    const plan = heuristicCutdown(s, 10, { language: "en" });
    expect(plan.durationS).toBeLessThanOrEqual(10);
    expect(plan.sentenceIds[0]).toBe(2);
    const rest = plan.sentenceIds.slice(1);
    expect(rest).toEqual([...rest].sort((a, b) => a - b));
    expect(plan.sentenceIds).not.toContain(6); // « Anyway, uh, that was it. »
  });

  it("selection replaces the main track, in order", () => {
    const edl: Edl = EdlSchema.parse({
      version: "1.5.0",
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
      sources: { talk: { path: "talk.mp4", durationS: 30, hasAudio: true } },
      video: [{ id: "main", clips: [{ id: "c1", source: "talk", in: 0, out: 30, at: 0 }] }],
    });
    const out = applySelection(edl, [
      { source: "talk", start: 10, end: 14 },
      { source: "talk", start: 2, end: 3.5 },
    ]);
    expect(out.video[0]?.clips.map((c) => [c.in, c.out, c.at])).toEqual([
      [10, 14, 0],
      [2, 3.5, 120],
    ]);
    expect(EdlSchema.safeParse(out).success).toBe(true);
  });
});

/** A fake Anthropic client that returns `answer` (or refuses) and records the request. */
function fakeClient(answer: unknown, stop = "end_turn"): ClaudeLike & { request?: Record<string, unknown> } {
  const fake: { request?: Record<string, unknown> } = {};
  return Object.assign(fake, {
    beta: {
      messages: {
        create: async (req: Record<string, unknown>) => {
          fake.request = req;
          return {
            stop_reason: stop,
            content: stop === "refusal" ? [] : [{ type: "text", text: JSON.stringify(answer) }],
          };
        },
      },
    },
  }) as unknown as ClaudeLike & { request?: Record<string, unknown> };
}

describe("Claude as editorial director", () => {
  const s = sentences({ talk: TALK });

  it("asks for structured output with fallbacks, and keeps only valid sentence ids", async () => {
    const client = fakeClient({
      shorts: [
        {
          title: "Lose viewers in 3 s",
          hook: s[2]!.text,
          sentence_ids: [2, 3, 4, 99],
          why: "question + payoff",
          scores: { hook: 9, retention: 8, clarity: 9 },
        },
      ],
    });
    const plans = await claudeShorts(s, { client, count: 3, minS: 5, maxS: 20 });
    expect(plans).toHaveLength(1);
    expect(plans[0]?.sentenceIds).toEqual([2, 3, 4]);
    expect(plans[0]?.planner).toBe("claude");
    const req = client.request as {
      model: string;
      fallbacks: string;
      output_config: { format: { type: string } };
      messages: { content: string }[];
    };
    expect(req.model).toBe("claude-opus-5-5");
    expect(req.fallbacks).toBe("default");
    expect(req.output_config.format.type).toBe("json_schema");
    expect(req.messages[0]?.content).toContain("[2] (");
  });

  it("falls back to the offline planner when Claude declines", async () => {
    const plans = await claudeShorts(s, { client: fakeClient({}, "refusal"), count: 1, minS: 5, maxS: 12 });
    expect(plans[0]?.planner).toBe("heuristic");
  });

  it("falls back when the answer has no usable clip", async () => {
    const plans = await claudeShorts(s, { client: fakeClient({ shorts: [] }), count: 1, minS: 5, maxS: 12 });
    expect(plans[0]?.planner).toBe("heuristic");
  });
});
