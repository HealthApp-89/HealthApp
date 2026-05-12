// lib/morning/brief/advice-prompt.ts
//
// Single Anthropic Haiku 4.5 call producing the prose Advice block of the
// brief. No tool use; single completion; ~$0.0005 per call.

import { callClaude } from "@/lib/anthropic/client";
import type {
  AdviceFlags,
  AthleteProfileDocument,
  MorningBriefCard,
} from "@/lib/data/types";
import type { TodayTargets } from "@/lib/morning/brief/get-today-targets";

const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 350;
const TEMPERATURE = 0.4;

export type AdviceContext = {
  activeProfile: AthleteProfileDocument | null;
  /** Card without advice_md — used as the data context the AI references. */
  card: Omit<MorningBriefCard, "advice_md">;
  flags: AdviceFlags;
  /** GLP-1-aware targets from getTodayTargets(). Provides today_phase_mode,
   *  deficit_alarm threshold, and other mode-conditional context. */
  targets: TodayTargets | null;
};

/** Throws on Anthropic failures (rate limit, network, malformed). Orchestrator
 *  catches and transitions state to brief_failed. */
export async function generateAdvice(ctx: AdviceContext): Promise<string> {
  const system = buildSystemPrompt(ctx);
  const userMessage = "Write today's Advice block per the instructions.";
  const result = await callClaude(
    [{ role: "user", content: userMessage }],
    { model: MODEL, system, maxTokens: MAX_TOKENS, temperature: TEMPERATURE },
  );
  return result.trim();
}

function buildSystemPrompt(ctx: AdviceContext): string {
  const profile = ctx.activeProfile?.intake_payload;
  const goal = profile?.goals;
  const meds = profile?.health.medications?.trim() ?? "";
  const injuries = profile?.health.active_injuries ?? [];

  const athleteContext: string[] = [];
  if (goal) {
    athleteContext.push(
      `Goal: ${goal.primary_metric} → ${goal.target_value}${goal.target_unit} by ${goal.target_date}.`,
    );
    if (goal.why_narrative.trim()) {
      athleteContext.push(`Goal narrative: "${goal.why_narrative.trim()}".`);
    }
  }
  if (profile?.nutrition.current_phase) {
    athleteContext.push(`Phase: ${profile.nutrition.current_phase}.`);
  }
  if (meds) athleteContext.push(`Medications: ${meds}.`);
  if (injuries.length > 0) {
    athleteContext.push("Restrictions:");
    for (const i of injuries) {
      athleteContext.push(`  - ${i.joint}: ${i.restriction}`);
    }
  }

  const dataBlock = buildDataBlock(ctx.card);
  const flagsBlock = buildFlagsBlock(ctx.flags);
  const coachingContext = buildCoachingContext(ctx.flags, ctx.targets);

  return `You are this athlete's coach delivering today's morning brief — the catch-up after the morning intake.

## Athlete context

${athleteContext.length > 0 ? athleteContext.join("\n") : "(no profile data available)"}

## Today's data

${dataBlock}

## Flags

${flagsBlock}
${coachingContext ? `\n## Coaching context\n\n${coachingContext}` : ""}

## Your task

Write the Advice block of today's brief. 2-4 sentences. Markdown allowed for bold/italic only.

When suggesting weight progressions, use the listed "min increment" per exercise — don't recommend jumps smaller than that value. E.g., if min increment is 2.5kg, the next step from 60kg is 62.5kg — never 61kg or 61.5kg.

Cover (in this order, but only what's relevant):
1. ONE coaching observation tying readiness to today's session. If poor_sleep_efficiency is true, probe the sleep gap ("you're in bed X hours but sleeping Y — push bedtime earlier / address latency").
2. Eating timing anchored to the session start (training days): pre-workout (~90 min before) + post (within 90 min after). Include ONE specific food example per window.
3. Hydration one-liner.

Conditional rules:
- If glp1.active is true: in the eating section, note that hunger cues may be blunted; suggest setting a reminder for the pre-workout meal rather than "eat when hungry". If glp1.deficit_alarm_triggered is also true, note that the 7-day rolling deficit (see glp1.rolling_7d_avg_deficit in Flags) is high — recommend adding a carb-heavy meal around the session and prioritising ~30g protein per meal.
- If alcohol_low_readiness_warning is true: mention pushing protein earlier in the day to compensate for overnight protein-synthesis suppression.
- If has_active_injuries is true: note "modify per restriction" on relevant exercises rather than the prescribed weight.
- If missed_protein_yesterday is true: open the eating section with a brief "yesterday's protein came in short — let's hit it cleanly today" before the timing.
- Rest day variant: skip pre/post-workout entirely. Focus on protein distribution across 4 meals + sleep prep. Mobility / steps mention if relevant.
- If coach_swap_suggested is true: a "Swap to Mobility" chip is already visible
  to the athlete on this brief. Your Advice should explain WHY mobility makes
  sense today — which readiness signals fired (HRV vs baseline, recovery score,
  readiness score). DO NOT re-decide whether to swap (the chip is the decision
  surface). DO NOT prescribe weights for the currently-named session. DO NOT
  pin eating timing to the original session start time — if they swap, that
  timing no longer applies; fall back to a 4-meal protein distribution
  spaced 3-4 hours apart.
- Apply any additional context from the Coaching context section above where relevant.

Style:
- Direct but warm. Default balanced tone (Phase 2 will surface specific directness preference).
- Reference numbers from the data block above; never invent values.
- Default protein examples: chicken, greek yogurt, eggs, salmon. Default carbs: rice, oats, sweet potato, banana.
- Do not restate data the card already shows above the advice block. Build on the data, don't recite it.

Output ONLY the advice text. No headers, no preamble.`;
}

/** Assembles mode-conditional coaching context lines injected into the system
 *  prompt after Flags. Keeps mode-specific guidance versioned in TS, not buried
 *  in a long prompt string. Returns empty string when no conditions apply. */
function buildCoachingContext(flags: AdviceFlags, targets: TodayTargets | null): string {
  const lines: string[] = [];

  if (flags.glp1.mode === "glp1_active" && flags.glp1.deficit_alarm_triggered) {
    const deficit = flags.glp1.rolling_7d_avg_deficit;
    const threshold = targets?.deficit_alarm?.threshold_kcal_per_day;
    const deficitStr = deficit !== null ? `~${deficit} kcal/day` : "elevated";
    const thresholdStr = threshold !== undefined ? `the ${threshold} kcal/day threshold` : "the alarm threshold";
    lines.push(
      `GLP-1 deficit alarm: 7-day average deficit ${deficitStr}, above ${thresholdStr}. ` +
      `Recommend adding ~30g protein + a carb-heavy meal around tomorrow's session. ` +
      `Do not recommend a "diet break".`,
    );
  }

  if (flags.glp1.mode === "glp1_tapering") {
    lines.push(
      `GLP-1 tapering: appetite is returning. Hold protein constant; let carbs ramp to appetite. ` +
      `Reference the user's dose-tapering schedule with their doctor.`,
    );
  }

  if (targets?.today_phase_mode === "diet_break") {
    lines.push(
      `Diet break week: +400 kcal vs cut, mostly directed to carbs. ` +
      `Mention leptin restoration; remind that appetite will rebound and that's the intended physiology.`,
    );
  }

  if (targets?.today_phase_mode === "reverse") {
    lines.push(
      `Reverse phase. Metabolic recovery in progress; scale may drift up 0.3–0.5 kg from glycogen ` +
      `and water retention, not fat.`,
    );
  }

  return lines.join("\n");
}

function buildDataBlock(card: Omit<MorningBriefCard, "advice_md">): string {
  const lines: string[] = [];
  lines.push(`- Variant: ${card.variant}`);
  if (card.variant === "training") {
    lines.push(`- Session: ${card.session.type} at ${card.session.start_time ?? "unscheduled"}`);
    if (card.session.exercises.length > 0) {
      lines.push("- Exercises (sets × reps @ kg; min increment in parentheses):");
      for (const ex of card.session.exercises) {
        const weightPart = ex.kg != null ? ` @ ${ex.kg}kg` : "";
        const incrementPart = ex.min_increment_kg != null ? ` (min increment: ${ex.min_increment_kg}kg)` : "";
        lines.push(`  - ${ex.name}: ${ex.sets} × ${ex.reps}${weightPart}${incrementPart}`);
      }
    }
  } else {
    lines.push("- Session: REST");
  }
  const r = card.readiness;
  lines.push(
    `- Readiness band: ${r.band} (score ${r.score ?? "n/a"}/10, HRV ${r.hrv ?? "n/a"}, recovery ${r.recovery ?? "n/a"})`,
  );
  const m = card.macros;
  lines.push(
    `- Macros target today: ${m.kcal_target} kcal, ${m.protein_target_g}g protein / ${m.carb_target_g}g carb / ${m.fat_target_g}g fat`,
  );
  const recap = card.recap;
  const recapParts: string[] = [];
  if (recap.sleep_hours !== null) recapParts.push(`slept ${recap.sleep_hours}h`);
  if (recap.kcal_actual !== null) recapParts.push(`ate ${recap.kcal_actual} kcal (target ${recap.kcal_target})`);
  if (recap.protein_actual_g !== null)
    recapParts.push(`${recap.protein_actual_g}g protein (target ${recap.protein_target_g}g)`);
  if (recap.trained_yesterday) recapParts.push(`trained ${recap.trained_yesterday}`);
  if (recap.top_e1rm_yesterday)
    recapParts.push(`top e1RM ${recap.top_e1rm_yesterday.lift} ${recap.top_e1rm_yesterday.kg}kg`);
  if (recapParts.length > 0) {
    lines.push(`- Recap: yesterday ${recapParts.join(", ")}`);
  } else {
    lines.push(`- Recap: yesterday — no data available`);
  }
  return lines.join("\n");
}

function buildFlagsBlock(flags: AdviceFlags): string {
  const lines: string[] = [];
  // Expand the nested glp1 object so each sub-field renders as its own line.
  for (const [subKey, subVal] of Object.entries(flags.glp1)) {
    lines.push(`- glp1.${subKey}: ${subVal}`);
  }
  // All other flags are scalar.
  const { glp1: _glp1, ...rest } = flags;
  for (const [k, v] of Object.entries(rest)) {
    lines.push(`- ${k}: ${v}`);
  }
  return lines.join("\n");
}
