import { z } from "zod";
import { callClaude, parseClaudeJson } from "@/lib/anthropic/client";
import { SHORT_FORM_MODEL } from "@/lib/anthropic/models";
import type { ParsedSet } from "@/lib/logger/parse-voice";

const SYSTEM = `You parse a voice phrase from a weightlifter logging a set into structured JSON.

Output STRICT JSON: {"kg": number | null, "reps": integer}. No commentary.

Rules:
- Convert pounds → kilograms (× 0.453592, round to nearest 0.5).
- "bodyweight" or movements without weight → kg = null.
- reps is always a positive integer between 1 and 100.
- If the phrase is too ambiguous to extract a set, return {"kg": null, "reps": 0} (caller treats reps=0 as parse failure).

Examples:
- Input: "sixty kilos eight reps" → {"kg": 60, "reps": 8}
- Input: "135 pounds for 5" → {"kg": 61.5, "reps": 5}
- Input: "bodyweight twelve reps" → {"kg": null, "reps": 12}
- Input: "eight at sixty" → {"kg": 60, "reps": 8}`;

const ResponseSchema = z.object({
  kg: z.union([z.number(), z.null()]),
  reps: z.number().int().min(0).max(100),
});

/**
 * Haiku 4.5 fallback when the regex parser returns null.
 * Returns null on parse failure (zero reps or invalid JSON) — caller falls back
 * to showing the user-typed-instead banner.
 */
export async function parseVoiceSetLLM(transcript: string): Promise<ParsedSet | null> {
  const raw = await callClaude(
    [{ role: "user", content: transcript }],
    {
      model: SHORT_FORM_MODEL,
      system: SYSTEM,
      maxTokens: 60,
      temperature: 0,
    },
  );
  let parsed: unknown;
  try {
    parsed = parseClaudeJson<unknown>(raw);
  } catch {
    return null;
  }
  const validated = ResponseSchema.safeParse(parsed);
  if (!validated.success) return null;
  if (validated.data.reps < 1) return null;
  return { kg: validated.data.kg, reps: validated.data.reps };
}
