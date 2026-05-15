// lib/coach/weekly-review/regenerate-narrative.ts
//
// Re-render §6 prose after reconfirm chip answers, without re-running
// composers. Cheaper than full regenerate (~$0.004).

import { callClaude } from "@/lib/anthropic/client";
import type {
  WeeklyReviewPayload,
  ReconfirmResponses,
} from "@/lib/data/types";
import { validateNoFabricatedNumbers } from "./narrative-prompt";

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 400;

const SYSTEM_PROMPT = `You are an experienced strength coach. The athlete has just answered one or more of your reconfirm questions. Update the weekly narrative to reflect their answers naturally. Same rules as before: 120-180 words, prose, no fabricated numbers, second person.`;

export async function regenerateNarrative(args: {
  payload: WeeklyReviewPayload;
  reconfirmResponses: ReconfirmResponses;
}): Promise<string> {
  const merged = {
    ...args.payload,
    _reconfirm_answers: args.reconfirmResponses,
  };
  const text = await callClaude(
    [{ role: "user", content: JSON.stringify(merged) }],
    {
      model: MODEL,
      system: SYSTEM_PROMPT,
      maxTokens: MAX_TOKENS,
      cacheSystem: true,
    },
  );
  // Reconfirm-triggered re-renders need the same fabrication guard as the
  // initial narrative — otherwise a chip answer could nudge the model into
  // inventing numbers and we'd silently persist them.
  validateNoFabricatedNumbers(text, args.payload);
  return text.trim();
}
