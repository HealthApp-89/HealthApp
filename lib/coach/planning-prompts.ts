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
import type { ChatMode, PrimaryLift, TrainingBlock } from "@/lib/data/types";

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
