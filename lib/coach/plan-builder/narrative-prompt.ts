// lib/coach/plan-builder/narrative-prompt.ts
//
// Single Sonnet 4.6 call producing the three short narrative fields
// (goal_summary, strength_notes, nutrition_notes) that wrap the
// deterministic plan_payload skeleton. JSON output for clean parsing.
//
// Cost: ~$0.018 per call. Prompt caching enabled (system prompt is
// cacheable; varies only with intake + skeleton inputs).

import { callClaude } from "@/lib/anthropic/client";
import { NARRATIVE_MODEL } from "@/lib/anthropic/models";
import type { IntakePayload, PlanPayload } from "@/lib/data/types";

const MODEL = NARRATIVE_MODEL;
const MAX_TOKENS = 600;
const TEMPERATURE = 0.4;

export type NarrativeContext = {
  intake: IntakePayload;
  skeleton: {
    goal: PlanPayload["goal"];
    strength: PlanPayload["strength"];
    nutrition: PlanPayload["nutrition"];
    sleep: PlanPayload["sleep"];
    recovery: PlanPayload["recovery"];
    coaching_agreement: PlanPayload["coaching_agreement"];
  };
  /** Auto-applied exercise swaps (constraint/identity-driven). Empty when none. */
  adjustments?: { from: string; to: string; reason: string }[];
};

export type PlanNarrative = {
  goal_summary: string;
  strength_notes: string;
  nutrition_notes: string;
};

export async function generatePlanNarrative(
  ctx: NarrativeContext,
): Promise<PlanNarrative> {
  const system = buildSystemPrompt(ctx);
  const userMessage = "Output the three narrative fields as JSON: { goal_summary, strength_notes, nutrition_notes }";
  const result = await callClaude(
    [{ role: "user", content: userMessage }],
    {
      model: MODEL,
      system,
      maxTokens: MAX_TOKENS,
      temperature: TEMPERATURE,
      cacheSystem: true,
    },
  );
  return parseNarrative(result);
}

/**
 * Builds the adjustments block injected into the strength_notes instruction.
 * Returns an empty string when no adjustments occurred — the AI sees nothing
 * and says nothing about swaps.
 */
function buildAdjustmentBlock(adjustments: { from: string; to: string; reason: string }[]): string {
  if (adjustments.length === 0) return "";
  const lines = adjustments
    .map((a) => `  - swapped "${a.from}" → "${a.to}": ${a.reason}`)
    .join("\n");
  return `   Exercise swaps were auto-applied (cite ONLY these reasons — observed facts, not speculation):
${lines}
   Mention each swap naturally in strength_notes. Do NOT invent reasons beyond those listed.`;
}

function buildSystemPrompt(ctx: NarrativeContext): string {
  const goalNarrativeForm = ctx.intake.goals.why_narrative.trim();
  const goalNarrativeChat = ctx.intake.goal_narrative_chat?.trim();
  const phase = ctx.skeleton.nutrition.phase;
  const meds = ctx.intake.health.medications.trim();
  const directness = ctx.intake.coaching_preferences?.directness ?? "balanced";

  return `You are writing narrative fields wrapping a coaching plan's deterministic skeleton.

## Athlete context
- Goal: ${ctx.skeleton.goal.primary_metric} → ${ctx.skeleton.goal.target_value}${ctx.skeleton.goal.target_unit} by ${ctx.skeleton.goal.target_date}
- Goal narrative (form): "${goalNarrativeForm}"
${goalNarrativeChat ? `- Goal narrative (chat-deepened): "${goalNarrativeChat}"` : ""}
- Phase: ${phase}
${meds ? `- Medications: ${meds}` : ""}
${ctx.intake.health.active_injuries.length > 0 ? `- Active injuries: ${ctx.intake.health.active_injuries.map((i) => `${i.joint} (${i.restriction})`).join("; ")}` : ""}

## Plan skeleton (deterministic — DO NOT REPRODUCE NUMBERS, only narrate)
- Sessions/wk: ${ctx.skeleton.strength.sessions_per_week}
- Day pattern: ${Object.entries(ctx.skeleton.strength.day_pattern).filter(([_, v]) => v !== "REST").map(([k, v]) => `${k}=${v}`).join(", ")}
- Volume targets: ${Object.entries(ctx.skeleton.strength.weekly_volume_targets).map(([lift, t]) => `${lift} ${t.reps_per_week}reps/wk`).join("; ")}
- Progression rule: ${ctx.skeleton.strength.progression_rule}
- Nutrition: ${ctx.skeleton.nutrition.protein_g}g protein (${ctx.skeleton.nutrition.protein_g_per_kg_bw} g/kg BW), ${ctx.skeleton.nutrition.kcal_target} kcal
${ctx.skeleton.nutrition.refeed_cadence_days ? `- Refeed every ${ctx.skeleton.nutrition.refeed_cadence_days} days (+${ctx.skeleton.nutrition.refeed_uplift?.kcal} kcal)` : ""}
- Sleep: ${ctx.skeleton.sleep.target_hours_min}-${ctx.skeleton.sleep.target_hours_max}h, wake ${ctx.skeleton.sleep.wake_target} → bed ${ctx.skeleton.sleep.bedtime_target}

## Your task

Write THREE short narrative fields:

1. **goal_summary** (2-3 sentences) — synthesize the form narrative + chat-deepened narrative (if present) into the athlete's voice. Reference the goal target. Make it feel like THEIR goal, not a coach's prescription.

2. **strength_notes** (1-2 sentences) — context for the strength prescription. Reference the primary lift focus + day pattern. Note progression rule briefly. Don't restate numbers.
${buildAdjustmentBlock(ctx.adjustments ?? [])}

3. **nutrition_notes** (1-2 sentences) — context for the nutrition prescription. Reference the phase + protein-per-kg-BW choice. If GLP-1 mentioned in medications, note the elevated importance of hitting protein floor consistently (hunger cues may be blunted). If refeed cadence set, note it.

## Style

- Directness: ${directness} (blunt = cut hedges; balanced = coach-Sunday-call tone; softer = acknowledge effort + push)
- Coach voice, not assistant voice
- No exclamation points
- No markdown formatting in the values
- Numbers only when referencing thresholds (don't restate every prescription)

## Output format

JSON object with exactly three keys:
{ "goal_summary": "...", "strength_notes": "...", "nutrition_notes": "..." }

No other text. No code fences. JUST the JSON.`;
}

function parseNarrative(raw: string): PlanNarrative {
  // Strip code fences if present
  let s = raw.trim();
  if (s.startsWith("```")) {
    s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch (e) {
    throw new Error(`Failed to parse narrative JSON: ${(e as Error).message}\nRaw: ${raw.slice(0, 200)}`);
  }
  const p = parsed as Record<string, unknown>;
  if (
    typeof p.goal_summary !== "string" ||
    typeof p.strength_notes !== "string" ||
    typeof p.nutrition_notes !== "string"
  ) {
    throw new Error(`Narrative JSON missing required fields: ${JSON.stringify(parsed)}`);
  }
  return {
    goal_summary: p.goal_summary.trim(),
    strength_notes: p.strength_notes.trim(),
    nutrition_notes: p.nutrition_notes.trim(),
  };
}
