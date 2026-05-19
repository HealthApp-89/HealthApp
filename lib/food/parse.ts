// lib/food/parse.ts
//
// Haiku 4.5 text → [{ name, qty_g }] extraction.
//
// Returns ONLY the extracted item list. Macro resolution happens downstream
// via lib/food/lookup.ts:resolveItemMacros, which the route handler
// dispatches per item. This split keeps the Haiku call narrow: it does NOT
// estimate macros — that's either DB-sourced (preferred) or done by a
// separate cheap LLM call only when the DB has no match.

import { z } from "zod";
import { callClaude, parseClaudeJson } from "@/lib/anthropic/client";
import { SHORT_FORM_MODEL } from "@/lib/anthropic/models";

export const ExtractedItemSchema = z.object({
  name: z.string().min(1),
  qty_g: z.number().positive().finite(),
});

export const ExtractResponseSchema = z.object({
  items: z.array(ExtractedItemSchema).min(1).max(15),
});

export type ExtractedItem = z.infer<typeof ExtractedItemSchema>;

const SYSTEM = `You convert free-text food descriptions into a structured list of items with quantities in grams.

Rules:
- Output STRICT JSON matching {"items": [{"name": string, "qty_g": number}]}. No commentary.
- EXPLICIT QUANTITY OVERRIDES DEFAULTS. When the user specifies a quantity in grams (e.g. "45g", "200 g") or ounces (e.g. "3 oz"), use that exact value. Convert oz → g by × 28.35. The household-unit table below applies ONLY when no explicit g/oz quantity is given.
- PRESERVE MODIFIERS. Words that describe the food — "low fat", "grilled", "whole wheat", "fried", "raw", brand names like "Balade" — must appear in the name field. Do not drop them.
- Convert household units to grams using common references (apply ONLY when no explicit g/oz):
    1 cup cooked rice ≈ 158g
    1 cup raw oats ≈ 80g
    1 slice bread ≈ 30g
    1 tbsp olive oil ≈ 14g
    1 medium apple ≈ 180g
    1 large egg ≈ 50g
    1 chicken breast (medium) ≈ 170g
- If quantity is ambiguous AND no explicit g/oz, pick a reasonable single-serving default and proceed (don't ask, don't refuse).
- name should be canonical-ish: "chicken breast grilled" not "I ate chicken".
- Max 15 items per call.

Examples:
- Input: "2 fried eggs with 1 tablespoon olive oil, 50g of low fat Balade grilled halloumi, 45g of wholewheat toast"
  Output: {"items": [
    {"name": "egg fried", "qty_g": 100},
    {"name": "olive oil", "qty_g": 14},
    {"name": "halloumi grilled low fat Balade", "qty_g": 50},
    {"name": "wholewheat toast", "qty_g": 45}
  ]}
- Input: "1 slice of bread"
  Output: {"items": [{"name": "bread", "qty_g": 30}]}
- Input: "200g chicken breast and 1 cup rice"
  Output: {"items": [{"name": "chicken breast", "qty_g": 200}, {"name": "rice cooked", "qty_g": 158}]}`;

/** Extract a list of items from free-text food input. */
export async function extractItems(text: string): Promise<ExtractedItem[]> {
  const raw = await callClaude(
    [{ role: "user", content: text }],
    {
      model: SHORT_FORM_MODEL,
      system: SYSTEM,
      maxTokens: 600,
      temperature: 0,
    },
  );
  const parsed = parseClaudeJson<unknown>(raw);
  const validated = ExtractResponseSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(`Haiku returned invalid extraction: ${validated.error.message}`);
  }
  return validated.data.items;
}
