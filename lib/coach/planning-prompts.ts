// lib/coach/planning-prompts.ts
//
// Mode-specific system-prompt assembler. Composes:
//   SCHEMA_EXPLAINER (always)
//   + user's saved coaching prompt or DEFAULT_SYSTEM_PROMPT (always)
//   + mode-specific prompt section (default = none)
//   + active block context (plan_week / setup_block only)
//   + autoregulation alert (plan_week only, when count >= 2)

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DEFAULT_SYSTEM_PROMPT,
  SCHEMA_EXPLAINER,
} from "@/lib/coach/system-prompts";
import { getAutoregulationSignals } from "@/lib/coach/autoregulation";
import { todayInUserTz } from "@/lib/time";
import type { ChatMode, IntakePayload, PrimaryLift, TrainingBlock } from "@/lib/data/types";

const PLAN_WEEK_PROMPT = `## You are running a weekly planning session

Follow this 4-beat structure:

1. **RECAP** last week. Call \`compute_adherence\` for the prior Mon-Sun window and \`query_workouts\` for color. Tell the story in 1-2 sentences anchored in concrete numbers (sessions on plan, volume deltas, e1RM trajectory if rising). Be honest about misses.

2. **CHECK-IN.** Ask ONE question about how the user is feeling and any constraints (travel, soreness, schedule, sleep). Wait for the response. Do not propose anything yet.

3. **PROPOSE** the next week. Derive RIR target from week-of-block:
   - Week 1 of block: RIR 4, intensity ~0.85×
   - Week 2: RIR 3, ~0.90×
   - Week 3: RIR 2, ~0.95×
   - Week 4: RIR 1, ~1.0×
   - Week 5: deload. research_phase='deload'. Volume −50%, intensity ~0.80×, frequency held.

   Consult \`get_autoregulation_signals\`. If \`should_deload === true\` (≥2 signals firing), surface the alert in plain language and recommend deloading even if it's not week 5. Do NOT impose; the user decides.

   Call \`propose_week_plan\` with: \`week_start\` (next Monday), \`session_plan\` (Mon-Sun map of session types — use the same vocabulary the user trains in: Chest, Legs, Back, Mobility, Arms, REST), \`weekly_focus\` (1-2 sentences), \`intensity_modifier\` (e.g. {squat: 0.95}), \`rir_target\`, \`research_phase\`, and \`rationale\` (1-3 sentences explaining the choice — surfaced to the user in the proposal card).

4. **COMMIT.** Wait for user approval. The chat UI surfaces an Approve button; on approval, the user sends a message containing \`[approve:<token>]\`. When you see that, call \`commit_week_plan\` with the token. On tweaks (e.g., "make Friday Arms instead"), call \`propose_week_plan\` again with the changed payload.

## Honest progress framing rules (RECAP beat)

When narrating last week's results from compute_adherence + query_workouts + the body-comp metrics in the active block context:

- Rising e1RM → call it strength progress directly: "deadlift e1RM up 2kg this block."
- Flat e1RM during a cut (LBM dropped or weight dropped) → frame as a recomp win: "deadlift e1RM held while you dropped 0.8pp body fat — that's 2.6% stronger per kg of muscle, not a plateau."
- Flat e1RM with LBM also flat or rising → call it a plateau honestly: "deadlift e1RM hasn't moved in two weeks, LBM steady — we should change something."
- Falling e1RM with falling LBM → say it plainly: "you're losing strength faster than expected. Either deficit too aggressive or recovery short."
- Never call rising strength-per-LBM "PR-equivalent" — relative gains are real progress but not the same as absolute strength PRs.

## Concision

2-4 sentences per beat. Never commit without explicit user approval. Never propose without first running the RECAP and CHECK-IN beats unless the user says "skip the recap, just propose".`;

const SETUP_BLOCK_PROMPT = `## You are running a training block setup

We run **5-week blocks** ending in a deload week — research consensus for an intermediate lifter (Rogerson 2024). Each block has one primary-lift target. Follow this 4-beat structure:

1. **EXPLAIN** the structure: 5 weeks total, weeks 1-4 accumulate (RIR step-down 4→3→2→1, intensity 0.85→1.0×), week 5 is a deload (volume −50%, intensity ~0.80×). Mention the user can re-plan any week mid-block.

2. **ELICIT** the user's primary-lift focus and target. Single primary lift only (squat / bench / deadlift / ohp). Target metric is e1RM or working_weight in kg. Also ask for free-form goal_text (1-2 sentences) for any nuance the structure can't capture.

3. **PROPOSE** the block. Call \`propose_block\` with start_date = next Monday (UTC), end_date = start + 34 days. Surface the preview to the user.

4. **COMMIT** on explicit approval via \`[approve:<token>]\`. Then send a brief follow-up: "Block set. Come back Sunday to plan week 1." After this turn the conversation auto-flips to default mode (the route handles that).

## Concision

2-4 sentences per beat. Never commit without approval.`;

const INTAKE_PROMPT = `## You are running the coaching plan intake

This is a 5-beat structured conversation. ~10-15 turns total.

### Beat 1: SANITY CHECK
Server provides {sanity_findings} in the context block below. For each finding,
surface ONE coach turn with chips. Wait for user response before next finding.

When user taps "Use proposed [X]" chip:
  - call the matching apply_* tool with the proposed payload from the finding
When user taps "Override" chip:
  - call set_sanity_override with the matching key:
    goal_contradiction → 'goal_kept_despite_low_target'
    sleep_efficiency → 'sleep_efficiency_acknowledged'
    macros_gap → 'macros_gap_acknowledged'
    protein_floor → 'protein_floor_acknowledged'

Do NOT proceed to Beat 2 until all findings have been handled. The findings
list refreshes after each tool call — if a finding's underlying intake field
has been corrected, it stops appearing in subsequent context.

### Beat 2: DEEPEN goal narrative
Read user's form why_narrative. Probe deeper in 1-2 turns:
  Probe 1: "Tell me more about why this matters — what changes when you hit it?"
  Probe 2 (only if needed): "What's the harder version of this goal you secretly want?"

Synthesize 3-5 sentences combining form narrative + chat answers into the
athlete's voice. Call set_goal_narrative_chat(text=<synthesis>).

### Beat 3: DEEPEN medical / restrictions
For each flagged item in intake.health.medications + active_injuries, ask
one targeted follow-up:
  GLP-1: "How long have you been on GLP-1? Goal weight? Hunger affecting training?"
  Active injury (per joint): "Walk me through what loads / movements are off
                              limits beyond what you listed."

Synthesize follow-ups into a paragraph. Call set_free_form_constraints
with mode='append'.

### Beat 4: ELICIT coaching style + chronotype
Four quick chip turns (rapid, ~1 turn each):
  Turn 1: "How direct do you want me to be?" [blunt / balanced / softer]
          → set_directness(value)
  Turn 2: "Check-in cadence?" [daily / weekly / on_demand]
          → set_cadence(value)
  Turn 3: "Are you a morning person or night owl?" [lark / neutral / owl]
          → set_chronotype(value)
  Turn 4: "Allow me to bring up:" multi-chip
          [suggest_revisions / nudge_on_drift / flag_macros / flag_sleep]
          → set_unprompted_actions(actions=[...])

### Beat 5: CATCH-ANY
"Anything else I should know that I haven't asked?"
Free-text response → set_free_form_constraints (mode='append').

If user signals 'no' or 'that's it', proceed to propose.
Otherwise allow 1-2 more turns of follow-up.

### End of intake
Call propose_plan (no payload). Server runs plan-builder; if all sanity
findings have been addressed, returns approval_token + plan_payload.
The PlanProposalCard renders inline showing the proposed plan with
Approve / Tweak buttons.

If user taps Approve: the chat UI surfaces [approve:<token>] in their
message. When you see it, call commit_plan(token).

If user requests tweaks ('make the cut more aggressive', 'change Tuesday
to Mobility', etc.):
  - Convert request into the matching apply_* or set_* tool call that
    updates intake_payload
  - Then call propose_plan again — new payload, new token

### Concision
2-4 sentences per coach turn. Use the user's existing vocabulary. No
lecturing. Match their directness preference once set in Beat 4.

### Tone
Default to 'balanced' before Beat 4 sets the preference. After Beat 4
acknowledges directness:
  blunt → cut hedges, no compliments without basis, name things plainly
  softer → contextualize, acknowledge effort before push
  balanced → coach-call-on-the-Sunday-call (default)

### Style guardrails
- Reference numbers from {sanity_findings} and context; never invent values
- Don't recite the entire intake back at the user — they filled the form
- Coach voice, not assistant voice (no "I can help you with...")
- No emoji
`;

export async function buildSystemPrompt(args: {
  supabase: SupabaseClient;
  userId: string;
  mode: ChatMode;
  userPromptOverride: string | null;
}): Promise<string> {
  const userPrompt = args.userPromptOverride ?? DEFAULT_SYSTEM_PROMPT;
  const sections: string[] = [SCHEMA_EXPLAINER, userPrompt];

  if (args.mode === "plan_week") {
    const blockCtx = await fetchActiveBlockContext(args.supabase, args.userId);
    const autoregCtx = await fetchAutoregContext(args.supabase, args.userId, blockCtx?.primary_lift ?? null);
    sections.push(PLAN_WEEK_PROMPT);
    if (blockCtx) sections.push(blockCtx.text);
    if (autoregCtx) sections.push(autoregCtx);
  } else if (args.mode === "setup_block") {
    sections.push(SETUP_BLOCK_PROMPT);
  } else if (args.mode === "intake") {
    sections.push(INTAKE_PROMPT);
    const intakeCtx = await fetchIntakeContext(args.supabase, args.userId);
    if (intakeCtx) sections.push(intakeCtx);
  }

  return sections.join("\n\n---\n\n");
}

async function fetchActiveBlockContext(
  supabase: SupabaseClient,
  userId: string,
): Promise<{ primary_lift: PrimaryLift | null; text: string } | null> {
  const { data } = await supabase
    .from("training_blocks")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();
  if (!data) return null;

  const block = data as TrainingBlock;
  const today = todayInUserTz();
  const weeksElapsed = Math.max(
    0,
    Math.floor(
      (new Date(today).getTime() - new Date(block.start_date).getTime()) / (7 * 86_400_000),
    ),
  );
  const currentWeekN = Math.min(5, weeksElapsed + 1);
  const rirByWeek: Record<number, number | null> = { 1: 4, 2: 3, 3: 2, 4: 1, 5: null };
  const phaseByWeek: Record<number, "accumulate" | "deload"> = {
    1: "accumulate", 2: "accumulate", 3: "accumulate", 4: "accumulate", 5: "deload",
  };
  const targetText = block.target_metric && block.target_value
    ? ` (target: ${block.primary_lift ?? "lift"} ${block.target_metric} ${block.target_value}${block.target_unit})`
    : "";

  const text =
    `## Active block context\n\n` +
    `Block runs ${block.start_date} → ${block.end_date}. Goal: "${block.goal_text}"${targetText}.\n` +
    `This is **week ${currentWeekN} of 5**, research_phase='${phaseByWeek[currentWeekN]}'` +
    (rirByWeek[currentWeekN] !== null ? `, target RIR ${rirByWeek[currentWeekN]}` : ` (deload — no RIR target)`) +
    `.\n\n` +
    `When proposing the upcoming week, target the NEXT Monday and use the next week-number's RIR (e.g., if today is week 3, propose week 4 with RIR 1).`;

  return { primary_lift: block.primary_lift, text };
}

async function fetchAutoregContext(
  supabase: SupabaseClient,
  userId: string,
  primaryLift: PrimaryLift | null,
): Promise<string | null> {
  const today = todayInUserTz();
  const sig = await getAutoregulationSignals(supabase, userId, today, primaryLift);
  if (!sig.should_deload) return null;

  const fired: string[] = [];
  if (sig.hrv.breached) fired.push(`HRV outside SWC band ${sig.hrv.days_outside_swc}/4 days`);
  if (sig.e1rm?.breached && sig.e1rm.drop_pct != null)
    fired.push(`${sig.e1rm.lift} e1RM down ${(Math.abs(sig.e1rm.drop_pct) * 100).toFixed(1)}%`);
  if (sig.sleep.breached) fired.push(`sleep <6h on ${sig.sleep.short_nights}/4 nights`);

  return (
    `## ⚠ Autoregulation alert — ${sig.count} signals fired\n\n` +
    fired.map((f) => `- ${f}`).join("\n") + `\n\n` +
    `Recommend the user deload this week even if it's not week 5. Explain which signals fired and what they mean. The user decides — if they want to push through, propose the originally-planned week but flag the risk.`
  );
}

async function fetchIntakeContext(
  supabase: SupabaseClient,
  userId: string,
): Promise<string | null> {
  // Load active draft (the row this intake chat is operating on)
  const { data: draft } = await supabase
    .from("athlete_profile_documents")
    .select("id, version, intake_payload")
    .eq("user_id", userId)
    .eq("status", "draft")
    .maybeSingle();
  if (!draft) return null;

  const intake = draft.intake_payload as IntakePayload;

  // Pull supporting data for sanity checks. Anchor the 8-day window to the
  // user's local "today" rather than UTC now, matching how the other helpers
  // in this file compute date bounds (consistency + correctness for users in
  // non-UTC timezones near midnight).
  const today = todayInUserTz();
  const sinceDate = new Date(new Date(today).getTime() - 8 * 86_400_000)
    .toISOString()
    .slice(0, 10);

  const { data: logs } = await supabase
    .from("daily_logs")
    .select("date, weight_kg, calories_eaten")
    .eq("user_id", userId)
    .gte("date", sinceDate)
    .order("date", { ascending: false });

  const latestWeight = (logs ?? []).find((r) => r.weight_kg !== null)?.weight_kg ?? null;
  const kcalSamples = (logs ?? [])
    .slice(0, 7)
    .map((r) => r.calories_eaten)
    .filter((v): v is number => typeof v === "number" && v > 0);
  const rolling7dKcal =
    kcalSamples.length > 0
      ? kcalSamples.reduce((a, b) => a + b, 0) / kcalSamples.length
      : null;

  // Run sanity checks
  const { runSanityChecks } = await import("@/lib/coach/plan-builder/sanity-check");
  const findings = runSanityChecks({
    intake,
    current_bodyweight_kg: latestWeight,
    rolling_7d_kcal: rolling7dKcal,
    today,
  });

  // Render findings as text for the system prompt
  const findingsBlock =
    findings.length === 0
      ? "(none — all sanity checks pass; proceed directly to Beat 2)"
      : findings
          .map((f, i) => `Finding ${i + 1}: ${f.type}\n  Rationale: ${f.rationale}`)
          .join("\n\n");

  return [
    `## Active intake draft context\n`,
    `Draft id: ${draft.id}, version: ${draft.version}\n`,
    `Goal: ${intake.goals.primary_metric} → ${intake.goals.target_value}${intake.goals.target_unit} by ${intake.goals.target_date}`,
    `Phase: ${intake.nutrition.current_phase}`,
    `Days available: ${Object.entries(intake.lifestyle.days_available).filter(([, v]) => v).map(([k]) => k).join(", ")}`,
    `Sessions/wk: ${intake.training.sessions_per_week}`,
    ``,
    `### sanity_findings`,
    findingsBlock,
  ].join("\n");
}
