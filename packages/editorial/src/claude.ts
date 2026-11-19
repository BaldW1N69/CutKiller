/**
 * Claude as editorial director: it reads the numbered transcript and returns
 * the Shorts to cut (structured output, validated), each with its hook, title
 * and scores. Optional: without Anthropic credentials, or if the call fails or
 * is declined, the caller falls back to the offline heuristic.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { heuristicShorts, planFromIds, type Sentence, type ShortPlan, type ShortsOptions } from "./index";

/** The part of the SDK client this module uses (a fake one in tests). */
export type ClaudeLike = Pick<Anthropic, "beta">;

export const MODEL = "claude-opus-5-5";

/** True when the SDK will find a credential: an API key, an auth token or an `ant auth login` profile. */
export function hasAnthropicCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_PROFILE) return true;
  if (env.ANTHROPIC_FEDERATION_RULE_ID && env.ANTHROPIC_ORGANIZATION_ID) return true;
  return existsSync(join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "anthropic"));
}

const Pick = z.object({
  title: z.string().min(1),
  hook: z.string().min(1),
  sentence_ids: z.array(z.number().int()).min(1),
  why: z.string(),
  scores: z.object({ hook: z.number(), retention: z.number(), clarity: z.number() }),
});
const Answer = z.object({ shorts: z.array(Pick) });

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["shorts"],
  properties: {
    shorts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "hook", "sentence_ids", "why", "scores"],
        properties: {
          title: { type: "string", description: "Short title for the clip, in the transcript's language" },
          hook: { type: "string", description: "The opening sentence, verbatim" },
          sentence_ids: {
            type: "array",
            items: { type: "integer" },
            description: "Sentence ids in playback order; the first one is the hook",
          },
          why: { type: "string", description: "One sentence: why this clip holds attention" },
          scores: {
            type: "object",
            additionalProperties: false,
            required: ["hook", "retention", "clarity"],
            properties: {
              hook: { type: "number", description: "0-10" },
              retention: { type: "number", description: "0-10" },
              clarity: { type: "number", description: "0-10" },
            },
          },
        },
      },
    },
  },
} as const;

const SYSTEM = `You are the editorial director of a video editing tool. You receive the transcript of real footage, one sentence per line, numbered, with its time range. You choose the passages that make the best standalone short vertical videos (TikTok, Reels, Shorts).

What makes a good clip:
- It opens on its strongest line: a question, a surprising claim, a number, a conflict. No greeting, no "so, today…".
- It is one complete idea with a payoff: someone who never saw the rest understands it and gets something out of it.
- It fits the requested duration. Sentences may be dropped from the middle of a passage when they digress, and the hook may be moved to the front when it comes from the same passage, but never change what the speaker meant.
- Clips do not reuse each other's sentences.

Score each clip honestly from 0 to 10 for hook, retention and clarity, and rank them best first. Titles are in the language of the transcript.`;

const ts = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;

export async function claudeShorts(
  all: readonly Sentence[],
  opts: ShortsOptions & { client?: ClaudeLike; log?: (m: string) => void } = {},
): Promise<ShortPlan[]> {
  const { count = 5, minS = 15, maxS = 60 } = opts;
  const fallback = (reason: string) => {
    opts.log?.(`editorial: ${reason}; using the offline planner`);
    return heuristicShorts(all, opts);
  };
  if (!opts.client && !hasAnthropicCredentials()) return fallback("no Anthropic credentials");
  const client = opts.client ?? new Anthropic();
  const transcript = all
    .map((s) => `[${s.id}] (${ts(s.start)}–${ts(s.end)}, ${s.source}) ${s.text}`)
    .join("\n");
  try {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: `Choose up to ${count} clips of ${minS}–${maxS} seconds each.\n\nTranscript:\n${transcript}`,
        },
      ],
    });
    if (response.stop_reason === "refusal") return fallback("the request was declined");
    if (response.stop_reason === "max_tokens") return fallback("the answer was cut off");
    const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    const parsed = Answer.safeParse(JSON.parse(text));
    if (!parsed.success) return fallback("the answer did not match the schema");
    const plans = parsed.data.shorts.flatMap((p) => planFromIds(all, p, opts) ?? []).slice(0, count);
    return plans.length > 0 ? plans : fallback("no usable clip in the answer");
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) return fallback("Anthropic credentials were refused");
    if (err instanceof Anthropic.RateLimitError) return fallback("rate limited by the Anthropic API");
    if (err instanceof Anthropic.APIError) return fallback(`Anthropic API error ${err.status}`);
    if (err instanceof SyntaxError) return fallback("the answer was not valid JSON");
    throw err;
  }
}
