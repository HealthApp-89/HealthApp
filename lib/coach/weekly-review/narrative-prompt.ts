// lib/coach/weekly-review/narrative-prompt.ts
//
// Single Sonnet 4.6 call. Reads structured payload, returns coach-voice
// prose (1 paragraph, 120-180 words) explaining "what changes & why".
// No fabricated numbers — post-call validation regex-checks all numbers
// in the output appear in the payload (with ±1 integer rounding tolerance,
// because natural-language prose rounds "172.99g" to "173g" and the
// validator should catch fabrication, not punish that).

import { callClaude } from "@/lib/anthropic/client";
import { NARRATIVE_MODEL } from "@/lib/anthropic/models";
import { jargonRuleForPrompt } from "@/lib/coach/glossary";
import type { WeeklyReviewPayload } from "@/lib/data/types";

const MODEL = NARRATIVE_MODEL;
const MAX_TOKENS = 400;

const SYSTEM_PROMPT = `You are an experienced strength coach reviewing a client's week. Voice: direct, concise, second person ("you"). Length: 120-180 words, single paragraph, no markdown headings.

TEACHING:
${jargonRuleForPrompt()}
- Prefer everyday language. Avoid textbook tone.

TRENDS DEEP CONTEXT (sub-project #5 — optional fields):
- payload.trends.per_lift_slope[] may be present — each entry has a 4w slope in pct/wk and an R² confidence value. When referring to a specific lift's trajectory, cite its slope_pct_per_wk_4w if available.
- payload.trends.plateau_spans[] flags lifts plateaued ≥ 3 weeks.
- payload.trends.cross_insights[] holds short English sentences describing nutrition × weight and volume × recovery correlations. When the prose touches body composition or recovery, you may reference these insights verbatim or paraphrase them.
- payload.trends.nutrition.top_items[] (optional) lists the week's most-used foods by frequency × kcal (name, frequency, total_kcal). When the prose touches nutrition patterns, you may reference these items by name (e.g. "your chicken-and-rice lunches stayed the anchor"). Numbers from this array are allowed in the narrative.
- All fields are OPTIONAL — when undefined, omit any reference to per-lift slope, correlation insights, or top items.

RULES:
1. Every numeric token you emit must appear in the payload EXACTLY as a value (or as that value rounded to 0, 1, or 2 decimals). Do NOT compute derived numbers — no differences, sums, ratios, or per-day extrapolations. If the payload doesn't carry a number, do not cite it.
2. When a numeric ratio is stored as a decimal (e.g. slope_pct_per_wk_4w: 0.07), you may cite it as "7%" — that conversion is allowed. Always round the percentage to an integer.
3. Lead with the most important per-lift change and its rationale_tag meaning.
4. Acknowledge reconfirm questions if any (but do not answer them — they're for the athlete).
5. Close with a single concrete cue for the upcoming week.
6. No bullet lists, no headers — flowing prose.

The rationale_tag suffixes "_increment_floor" and "_increment_capped" mean the lift held because the smallest physical jump is bigger than the rule's target — explain this naturally without using the suffix term.`;

export async function renderNarrative(args: {
  payload: WeeklyReviewPayload;
}): Promise<string> {
  const userMessage = JSON.stringify(args.payload);

  const text = await callClaude(
    [{ role: "user", content: userMessage }],
    {
      model: MODEL,
      system: SYSTEM_PROMPT,
      maxTokens: MAX_TOKENS,
      cacheSystem: true,
    },
  );

  validateNoFabricatedNumbers(text, args.payload);
  return text.trim();
}

/** Collect every number that appears in the payload tree. We add four
 *  variants per numeric value: the raw string, the rounded integer, ±1
 *  from the rounded integer, and the one-decimal form — natural-language
 *  prose rounds "172.99g" to "173g" routinely, and the validator should
 *  catch fabricated numbers (made-up loads / percentages), not punish
 *  rounding.
 *
 *  String fields (notably `header.block_goal_text` like "Deadlift 115kg x 5")
 *  also contribute their embedded numerics — the model legitimately
 *  references the target weight from the goal narrative.
 *
 *  Numbers ≤ 31 are always allowed (calendar days, small counts that
 *  appear in conversational filler like "next 3 weeks"). */
export function validateNoFabricatedNumbers(
  text: string,
  payload: WeeklyReviewPayload,
): void {
  const allowed = new Set<string>();
  const addNumber = (n: number): void => {
    if (!Number.isFinite(n)) return;
    allowed.add(String(n));
    const rounded = Math.round(n);
    allowed.add(String(rounded));
    allowed.add(String(rounded - 1));
    allowed.add(String(rounded + 1));
    allowed.add(n.toFixed(1));
    allowed.add(String(Math.round(n * 100) / 100));
    // Ratio → integer percent (0.068 → "7"). Bounded to |n| ≤ 1 so a
    // payload value like 7.5 doesn't authorize "750%".
    if (Math.abs(n) <= 1) {
      allowed.add(String(Math.round(n * 100)));
      allowed.add(String(Math.round(Math.abs(n) * 100)));
    }
  };
  const collect = (obj: unknown): void => {
    if (obj == null) return;
    if (typeof obj === "number") {
      addNumber(obj);
      return;
    }
    if (typeof obj === "string") {
      // Pull numerics out of any string field — e.g. goal_text "Deadlift 115kg x 5".
      const inner = obj.match(/\d+(?:\.\d+)?/g) ?? [];
      for (const s of inner) {
        const n = Number(s);
        if (Number.isFinite(n)) addNumber(n);
      }
      return;
    }
    if (Array.isArray(obj)) {
      obj.forEach(collect);
      return;
    }
    if (typeof obj === "object") Object.values(obj).forEach(collect);
  };
  collect(payload);

  const matches = text.match(/\d+(?:\.\d+)?/g) ?? [];
  const fabricated = matches.filter((m) => {
    if (allowed.has(m)) return false;
    const n = Number(m);
    if (!Number.isFinite(n)) return true;
    // Small integers (≤ 31) commonly appear as weekday/week counts —
    // always tolerate.
    if (Number.isInteger(n) && n <= 31) return false;
    // Only integer values benefit from the ±1 tolerance (catches natural
    // rounding of payload values like 168.4g → "168g" in prose). Non-integers
    // must match exactly so a fabricated "86.5kg" can't slip past when the
    // payload has 85.2kg (round(85.2)=85 → 85+1=86 would otherwise pass).
    if (Number.isInteger(n)) {
      const rounded = Math.round(n);
      if (
        allowed.has(String(rounded)) ||
        allowed.has(String(rounded - 1)) ||
        allowed.has(String(rounded + 1))
      ) {
        return false;
      }
    }
    return true;
  });
  if (fabricated.length > 0) {
    // Log a compact diagnostic; full payload-number set is intentionally
    // suppressed (cron logs would be very chatty).
    console.warn("[weekly-review] narrative validator triggered", {
      fabricated,
      narrative_head: text.slice(0, 240),
    });
    throw new Error(
      `Narrative referenced numbers not in payload: ${fabricated.join(", ")}`,
    );
  }
}
