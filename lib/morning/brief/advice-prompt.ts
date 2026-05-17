// lib/morning/brief/advice-prompt.ts
//
// Single Anthropic Haiku 4.5 call producing the prose Advice block of the
// brief. No tool use; single completion; ~$0.0005 per call.
//
// Variant-aware: the dispatcher in buildSystemPrompt routes to a kickoff
// (Monday), analytical (Tue-Sat with a committed week), or legacy (no
// committed week / rest) prompt builder. All branches share the same
// teacher-tone rules so the voice is consistent across variants.

import { callClaude, streamClaude } from "@/lib/anthropic/client";
import { SHORT_FORM_MODEL } from "@/lib/anthropic/models";
import { jargonRuleForPrompt } from "@/lib/coach/glossary";
import { CARTER_VOICE_RULES } from "@/lib/coach/planning-prompts";
import type {
  AdviceFlags,
  AthleteProfileDocument,
  MorningBriefCard,
  MuscleVolumeFlag,
  StrengthMuscleVolume,
  ThisWeekPlanBlock,
  YesterdayVsPlanBlock,
} from "@/lib/data/types";
import type { TodayTargets } from "@/lib/morning/brief/get-today-targets";
import { fmtNum } from "@/lib/ui/score";

const MODEL = SHORT_FORM_MODEL;
const MAX_TOKENS = 350;
const TEMPERATURE = 0.4;

/** Shared teacher-tone rules applied to every variant. The jargon
 *  vocabulary is sourced from the canonical glossary module
 *  (`lib/coach/glossary.ts`) via `jargonRuleForPrompt()` so the UI tooltips
 *  (JargonPill / TermSheet) and the AI prompts stay in lockstep — change
 *  a definition in one place and both surfaces update. Reinforced separately
 *  by the per-variant prompt bodies. */
const TEACHER_TONE_RULES = `
TONE & TEACHING RULES (apply to every reply):
1. Second person, conversational. "You" not "the athlete".
2. ${jargonRuleForPrompt().split("\n").join("\n  ")}
3. Prefer everyday language. Don't write "myofibrillar hypertrophy" when "muscle growth" works.
4. Explain why a concept matters when it drives a decision today. Skip the textbook tone.

EXAMPLES OF THE VOICE (do NOT cite values from these — they're tone anchors only):
Good: "Recovery's at 71% — solid floor. Push the heaviest triple you can hold for sets of 5; if it stalls, drop the last set and call it. Eat a real lunch before the gym (chicken + rice works), not a protein bar."
Good: "Sleep was thin (6.2h) and protein came in 30g short yesterday. Front-load protein today — a 4-egg scramble before noon — and keep the squat top set conservative; you don't have headroom for a PR attempt."
Bad: "Today is a great opportunity to focus on hypertrophy and ensure you're hitting your macros! Have a wonderful workout!"
Bad: "Your recovery score indicates you're well-recovered. You should perform well today."
`.trim();

export type AdviceContext = {
  activeProfile: AthleteProfileDocument | null;
  /** Card without advice_md — used as the data context the AI references. */
  card: Omit<MorningBriefCard, "advice_md">;
  flags: AdviceFlags;
  /** GLP-1-aware targets from getTodayTargets(). Provides today_phase_mode,
   *  deficit_alarm threshold, and other mode-conditional context. */
  targets: TodayTargets | null;
  /** NEW: top-2 muscle-volume flags + the underlying StrengthMuscleVolume
   *  so the prompt can reference band numbers and rationale. */
  muscleVolumeFlags?: MuscleVolumeFlag[];
  muscleVolume?: StrengthMuscleVolume | null;
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

/** Streaming variant. Yields text deltas as they arrive, then a final 'done'
 *  with the assembled full text (trimmed). On error, yields 'error' and
 *  returns — callers should treat it the same as `generateAdvice` throwing. */
export async function* generateAdviceStream(
  ctx: AdviceContext,
  signal?: AbortSignal,
): AsyncGenerator<
  | { type: "delta"; text: string }
  | { type: "done"; full: string }
  | { type: "error"; message: string }
> {
  const system = buildSystemPrompt(ctx);
  const userMessage = "Write today's Advice block per the instructions.";
  let accumulated = "";
  for await (const ev of streamClaude(
    [{ role: "user", content: userMessage }],
    { model: MODEL, system, maxTokens: MAX_TOKENS, temperature: TEMPERATURE, signal },
  )) {
    if (ev.type === "delta") {
      accumulated += ev.text;
      yield { type: "delta", text: ev.text };
    } else if (ev.type === "done") {
      yield { type: "done", full: accumulated.trim() };
      return;
    } else if (ev.type === "error") {
      yield { type: "error", message: ev.message };
      return;
    }
  }
}

/** Variant dispatcher. The 'training' and 'rest' variants share the legacy
 *  prompt — the back-compat path used when no committed weekly review exists
 *  for the current week. Kickoff + analytical require a committed prescription
 *  and lean on the structured this_week_plan / yesterday_vs_plan blocks. */
function buildSystemPrompt(ctx: AdviceContext): string {
  const variant = ctx.card.variant;

  if (variant === "kickoff") return buildKickoffPrompt(ctx);
  if (variant === "analytical") return buildAnalyticalPrompt(ctx);
  // 'training' (legacy) and 'rest' use the existing prompt unchanged.
  return buildLegacyPrompt(ctx);
}

// ── Variant-specific prompt builders ───────────────────────────────────────

function buildKickoffPrompt(ctx: AdviceContext): string {
  const athleteContextBlock = buildAthleteContext(ctx);
  const dataBlock = buildDataBlock(ctx.card);
  const flagsBlock = buildFlagsBlock(ctx.flags);
  const coachingContext = buildCoachingContext(ctx.flags, ctx.targets);
  const muscleVolumeBlock = buildMuscleVolumeBlock(ctx.muscleVolumeFlags, ctx.muscleVolume);
  const planBlock = buildThisWeekPlanBlock(ctx.card.this_week_plan ?? null);

  const phaseExplainer = ctx.flags.phase_transition_this_week
    ? "PHASE TRANSITION: this week's phase differs from last week. Open with one plain-English sentence explaining what the new phase asks of the athlete."
    : "Phase is unchanged from last week. Don't re-explain the phase; reference it briefly.";

  return [
    `You are Coach Carter delivering today's Monday morning kickoff brief.`,
    CARTER_VOICE_RULES,
    TEACHER_TONE_RULES,
    "",
    athleteContextBlock,
    "",
    planBlock,
    "",
    "FLAGS:",
    flagsBlock,
    "",
    "COACHING CONTEXT:",
    coachingContext,
    "",
    muscleVolumeBlock,
    "",
    "TODAY'S DATA:",
    dataBlock,
    "",
    "WRITING INSTRUCTIONS:",
    `${phaseExplainer}`,
    "Length: 100-150 words of prose, Carter voice — terse, evidence-first, no filler. Cover, in order:",
    "  1. The phase and what it means (1 sentence if changed; brief mention if unchanged).",
    "  2. Today's session focus (today's biggest lift + its prescribed load).",
    "  3. The volume context (1 sentence on per-muscle targets if notable).",
    "  4. Nutrition + sleep anchors (1 sentence each).",
    "",
    "Never invent numbers. Reference exact values from the payload.",
  ].join("\n");
}

function buildAnalyticalPrompt(ctx: AdviceContext): string {
  const athleteContextBlock = buildAthleteContext(ctx);
  const dataBlock = buildDataBlock(ctx.card);
  const flagsBlock = buildFlagsBlock(ctx.flags);
  const coachingContext = buildCoachingContext(ctx.flags, ctx.targets);
  const muscleVolumeBlock = buildMuscleVolumeBlock(ctx.muscleVolumeFlags, ctx.muscleVolume);
  const yesterdayBlock = buildYesterdayVsPlanBlock(ctx.card.yesterday_vs_plan ?? null);

  return [
    `You are Coach Carter delivering today's Tue-Sat morning brief.`,
    CARTER_VOICE_RULES,
    TEACHER_TONE_RULES,
    "",
    athleteContextBlock,
    "",
    yesterdayBlock,
    "",
    "FLAGS:",
    flagsBlock,
    "",
    "COACHING CONTEXT:",
    coachingContext,
    "",
    muscleVolumeBlock,
    "",
    "TODAY'S DATA:",
    dataBlock,
    "",
    "WRITING INSTRUCTIONS:",
    "Length: 80-130 words of prose, Carter voice — terse, evidence-first, no filler. Cover, in order:",
    "  1. Yesterday's per-lift performance — rep completion, any RIR miss. 1-2 sentences.",
    "  2. Today's prescribed lift(s) with exact loads. 1-2 sentences.",
    "  3. One adaptive cue (form, fatigue, nutrition gap) — pick the most actionable.",
    "",
    "If yesterday's session was not logged (session_logged: false), acknowledge it briefly and pivot to today-prescription-only framing.",
    "",
    "Never invent numbers. Reference exact values from the payload.",
  ].join("\n");
}

/** Legacy prompt — back-compat path for the 'training' and 'rest' variants
 *  (no committed weekly review available for the current week, or today is a
 *  scheduled rest day). The body is the original pre-Slice 2 prompt with
 *  TEACHER_TONE_RULES prepended so tone stays consistent with the new
 *  variants. */
function buildLegacyPrompt(ctx: AdviceContext): string {
  const athleteContextBlock = buildAthleteContext(ctx);
  const dataBlock = buildDataBlock(ctx.card);
  const flagsBlock = buildFlagsBlock(ctx.flags);
  const coachingContext = buildCoachingContext(ctx.flags, ctx.targets);
  const muscleVolumeBlock = buildMuscleVolumeBlock(ctx.muscleVolumeFlags, ctx.muscleVolume);

  return `${CARTER_VOICE_RULES}

${TEACHER_TONE_RULES}

You are Coach Carter delivering today's morning brief — the catch-up after the morning intake.

## Athlete context

${athleteContextBlock}

## Today's data

${dataBlock}

## Flags

${flagsBlock}
${coachingContext ? `\n## Coaching context\n\n${coachingContext}` : ""}${muscleVolumeBlock ? `\n${muscleVolumeBlock}` : ""}

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

// ── Shared block builders ──────────────────────────────────────────────────

/** Renders the ATHLETE CONTEXT block — goal, phase, medications,
 *  restrictions. Extracted from the original buildSystemPrompt so all three
 *  variant builders can reuse it. */
function buildAthleteContext(ctx: AdviceContext): string {
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
  return athleteContext.length > 0 ? athleteContext.join("\n") : "(no profile data available)";
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
  if (card.variant === "rest") {
    lines.push("- Session: REST");
  } else {
    lines.push(`- Session: ${card.session.type} at ${card.session.start_time ?? "unscheduled"}`);
    if (card.session.exercises.length > 0) {
      lines.push("- Exercises (sets × reps @ kg; min increment in parentheses):");
      for (const ex of card.session.exercises) {
        const weightPart = ex.kg != null ? ` @ ${ex.kg}kg` : "";
        const incrementPart = ex.min_increment_kg != null ? ` (min increment: ${ex.min_increment_kg}kg)` : "";
        lines.push(`  - ${ex.name}: ${ex.sets} × ${ex.reps}${weightPart}${incrementPart}`);
      }
    }
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

/** Builds the optional MUSCLE VOLUME CONTEXT section. Returns empty string
 *  when no flags fire or muscleVolume is absent. */
function buildMuscleVolumeBlock(
  flags: MuscleVolumeFlag[] | undefined,
  muscleVolume: StrengthMuscleVolume | null | undefined,
): string {
  if (!flags || flags.length === 0 || !muscleVolume) return "";

  const lines: string[] = [
    "=== MUSCLE VOLUME CONTEXT ===",
  ];
  for (const flag of flags) {
    const band = muscleVolume.bands[flag.group];
    lines.push(
      `- ${flag.group}: ${describeFlag(flag)}. Band: MEV ${band.mev} / MAV ${band.mav[0]}-${band.mav[1]} / MRV ${band.mrv}. Plan source: ${band.source}. Rationale: ${band.rationale}`,
    );
  }
  lines.push("");
  lines.push("Coaching directives:");
  lines.push(
    "- For below_mev_* flags: suggest ONE concrete exercise + set count to close the gap today. Fit into the planned session (e.g., face-pulls before cooldown). Cap at +3 sets per gap; abrupt large jumps trigger soreness, not adaptation.",
  );
  lines.push(
    "- For near_mrv flags: recommend dropping the LAST exercise/set of today's session. Frame as autoregulation, not failure.",
  );

  return lines.join("\n");
}

function describeFlag(flag: MuscleVolumeFlag): string {
  switch (flag.kind) {
    case "below_mev_persistent":
      return `8wk avg ${flag.actual_8wk} sets/wk is below MEV (${flag.mev}) — systematic under-training`;
    case "below_mev_recent":
      return `week-to-date ${flag.actual_wtd} sets vs target ${flag.target_this_week} this week (${flag.days_left} days left to rescue)`;
    case "near_mrv":
      return `week-to-date ${flag.actual_wtd} sets approaching MRV (${flag.mrv}) — consider backing off`;
  }
}

/** Builds the THIS WEEK PLAN block for the kickoff variant. Renders the
 *  committed weekly review's per-lift prescription + volume targets in a
 *  shape the AI can reference without inventing numbers. */
function buildThisWeekPlanBlock(plan: ThisWeekPlanBlock | null): string {
  if (!plan) return "(No committed weekly review available for this week.)";
  const lines = [
    `THIS WEEK'S PLAN (committed weekly review):`,
    `  Week ${plan.week_n} of ${plan.total_weeks} · phase: ${plan.phase_now}${plan.phase_changed_this_week ? " (NEW THIS WEEK)" : ""}`,
    `  Per-lift loads:`,
  ];
  for (const p of plan.per_lift) {
    const rir = p.rir_target != null ? `, RIR ${p.rir_target}` : "";
    const delta =
      p.delta_from_last_week_pct != null
        ? ` (${fmtNum(p.delta_from_last_week_pct * 100)}% from last week)`
        : "";
    lines.push(`    - ${p.lift}: ${p.load_kg}kg × ${p.sets} × ${p.reps}${rir}${delta}`);
  }
  if (plan.volume_summary.length > 0) {
    lines.push(`  Volume targets:`);
    for (const v of plan.volume_summary) {
      lines.push(`    - ${v.muscle}: ${v.sets} sets (${v.tier})`);
    }
  }
  if (plan.weekly_focus) {
    lines.push(`  Weekly focus: ${plan.weekly_focus}`);
  }
  return lines.join("\n");
}

/** Builds the YESTERDAY VS PLAN block for the analytical variant. Surfaces
 *  per-lift planned vs actual + swap context so the AI can compare without
 *  fabricating numbers. */
function buildYesterdayVsPlanBlock(block: YesterdayVsPlanBlock | null): string {
  if (!block) return "(Yesterday was a planned rest day.)";
  if (!block.session_logged) {
    return [
      "YESTERDAY VS PLAN:",
      "  (No session logged for yesterday — actual data unavailable.)",
      ...(block.swap_applied
        ? ["  Note: yesterday's session was swapped from the original prescription."]
        : []),
    ].join("\n");
  }
  const lines = ["YESTERDAY VS PLAN:"];
  if (block.swap_applied) {
    lines.push("  Note: yesterday's session was swapped from the original prescription.");
  }
  for (const p of block.per_lift) {
    const planned = `${p.planned.load_kg}kg × ${p.planned.sets} × ${p.planned.reps}`;
    if (p.actual === null) {
      lines.push(`  - ${p.lift}: planned ${planned}; no actual logged.`);
      continue;
    }
    const repsPct =
      p.reps_completed_pct != null
        ? `${Math.round(p.reps_completed_pct * 100)}% reps completed`
        : "rep completion unknown";
    const topLoad =
      p.actual.top_set_load_kg != null ? `, top set ${p.actual.top_set_load_kg}kg` : "";
    lines.push(
      `  - ${p.lift}: planned ${planned}; actual ${p.actual.sets_done} sets, ${p.actual.total_reps_done} reps${topLoad} (${repsPct})`,
    );
  }
  return lines.join("\n");
}
