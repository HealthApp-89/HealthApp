# Athlete Profile Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Phase 1's intake-only athlete profile into a full coaching plan with prescribed targets across nutrition, sleep, periodization, strength template, recovery, and coaching agreement — via a 5-beat chat intake (sanity check → deepen goal → deepen medical → elicit style + chronotype → catch-any), a deterministic plan-builder, and a single AI narrative pass.

**Architecture:** New `mode='intake'` chat mode joins the existing `default | plan_week | setup_block` system. Beat 1 surfaces deterministic sanity findings (goal contradiction, sleep efficiency gap, macros gap, protein-floor violation) with chip-driven Accept/Override flow. Plan-builder is a pure function from `intake_payload` + bodyweight + recent e1RMs + active block; AI's only role is generating narrative wrappers (goal summary, strength notes, nutrition notes). Eleven new HMAC-aware or single-slot tools. Eight per-section composers populate the typed `plan_payload jsonb`. No DB migration — `plan_payload` and `rendered_md` columns already nullable from Phase 1's migration 0010. Morning brief integration is a 10-line patch to `get-today-targets.ts` reading `plan_payload.nutrition` first.

**Tech Stack:** Next.js 15 App Router, Supabase (RLS-respecting server client + service-role for state transitions), Anthropic via existing `lib/anthropic/client.ts` wrapper (Sonnet 4.6 throughout, prompt caching enabled), no new runtime dependencies.

**Spec:** [docs/superpowers/specs/2026-05-11-athlete-profile-phase-2-design.md](../specs/2026-05-11-athlete-profile-phase-2-design.md)

**Verification posture:** This codebase has no test runner (per CLAUDE.md). Each task ends with `npm run typecheck` plus targeted manual checks. Pure modules (`sanity-check.ts`, the eight `compose-*.ts` files, `narrative-prompt.ts`) are exercised via one-shot probe scripts (`scripts/probe-*.mjs`) that print known-input/known-output pairs for visual confirmation; scripts are deleted after verification.

**Migration:** none. `plan_payload jsonb` and `rendered_md text` columns are already nullable on `athlete_profile_documents` from migration `0010_athlete_profile.sql`. Phase 2 just populates them.

**Branching:** Implementer is on `feat/athlete-profile-phase-2` (cut from main at `c93fe7a` which has the spec merged). Commits land per task.

---

## File Structure

**New files (15):**
- `lib/coach/plan-builder/index.ts` — `buildPlanPayload(supabase, userId, intake)` orchestrator
- `lib/coach/plan-builder/sanity-check.ts` — `runSanityChecks()` (4 deterministic checks)
- `lib/coach/plan-builder/compose-snapshot.ts` — `composeSnapshot()`
- `lib/coach/plan-builder/compose-goal.ts` — `composeGoal()`
- `lib/coach/plan-builder/compose-periodization.ts` — `composePeriodization()`
- `lib/coach/plan-builder/compose-strength.ts` — `composeStrengthTemplate()`
- `lib/coach/plan-builder/compose-nutrition.ts` — `composeNutrition()` (BW-based protein, refeed)
- `lib/coach/plan-builder/compose-sleep.ts` — `composeSleep()` (wake-anchored, hygiene defaults)
- `lib/coach/plan-builder/compose-recovery.ts` — `composeRecovery()`
- `lib/coach/plan-builder/compose-coaching-agreement.ts` — `composeCoachingAgreement()`
- `lib/coach/plan-builder/narrative-prompt.ts` — `generatePlanNarrative()` (single Sonnet call)
- `components/chat/PlanProposalCard.tsx` — renders proposed `plan_payload` inline in chat

**Modified files (9):**
- `lib/data/types.ts` — `IntakePayload` schema_version 1→2, new optional groups (`goal_narrative_chat`, `coaching_preferences`, `free_form_constraints`, `sanity_overrides`, `chronotype`), `PlanPayload` typed shape, `SanityFinding`, `ChatMode` extension
- `lib/coach/approval-token.ts` — extend `action` type to include `"plan"`
- `lib/coach/tools.ts` — 11 new tool definitions + executors
- `lib/coach/planning-prompts.ts` — `INTAKE_PROMPT` + `buildSystemPrompt` branch for `mode='intake'`
- `lib/coach/profile-renderer.ts` — `renderProfileMarkdown` extension for plan sections when `plan_payload` is populated
- `app/api/chat/messages/route.ts` — accept `mode='intake'`, persist on messages
- `components/chat/ChatPanel.tsx` — chip routing for `accept_sanity_correction`, `override_sanity_finding`, `set_*` chip values, render branch for plan proposal card
- `components/profile/AthleteProfilePanel.tsx` — conditional "Generate plan" CTA when `active.plan_payload === null`
- `lib/morning/brief/get-today-targets.ts` — read `plan_payload.nutrition` first, fall back to `intake_payload.nutrition`

**Untouched:**
- `training_blocks` / `training_weeks` schemas (strength template references read-only)
- Phase 1 form wizard (intake form unchanged)
- Morning brief assembler / advice prompt / sub-components (consume targets via `get-today-targets()` abstraction)
- Migration `0010_athlete_profile.sql`

**Env additions:** none — `COACH_TOOL_SECRET` already exists from weekly-planning v1.

---

## Task index (20 tasks)

- Task 1: TypeScript types — IntakePayload v2, PlanPayload, SanityFinding, ChatMode extension
- Task 2: Approval token — extend action union to include "plan"
- Task 3: Sanity check module + probe
- Task 4: compose-snapshot + compose-goal
- Task 5: compose-periodization
- Task 6: compose-strength-template
- Task 7: compose-nutrition (BW-based protein, refeed, hard_rules)
- Task 8: compose-sleep (wake-anchored, hygiene defaults)
- Task 9: compose-recovery + compose-coaching-agreement
- Task 10: Plan-builder orchestrator
- Task 11: Narrative prompt (Sonnet) + probe
- Task 12: Tools (11 new) — apply_* sanity correctors, set_* slot setters, propose_plan, commit_plan
- Task 13: INTAKE_PROMPT + planning-prompts.ts extension
- Task 14: Profile renderer extension (full plan markdown)
- Task 15: Chat API mode resolution (accept `mode='intake'`)
- Task 16: ChatPanel chip routing + reducer extensions + render PlanProposalCard
- Task 17: PlanProposalCard component
- Task 18: AthleteProfilePanel "Generate plan" CTA + draft-creation server action
- Task 19: Morning brief `get-today-targets.ts` swap to read plan_payload.nutrition first
- Task 20: End-to-end manual smoke + CLAUDE.md polish

---

### Task 1: TypeScript types

**Files:**
- Modify: `lib/data/types.ts`

- [ ] **Step 1: Widen `IntakePayload` to schema_version 2 (additive)**

Open `lib/data/types.ts`. Find the existing `IntakePayload` type from Phase 1. Make these changes:

1. Widen the `schema_version` field from `1` to `1 | 2`.
2. Add optional `chronotype` to `sleep_recovery` block:

```ts
sleep_recovery: {
  // Phase 1 fields unchanged
  avg_sleep_hours: number;
  typical_bedtime: string;
  typical_wake_time: string;
  sleep_latency_minutes: number;
  awakenings: "none" | "1_2" | "3_plus";
  mobility_work: string;
  soreness_frequency: "rare" | "common" | "always";
  // NEW Phase 2 field — populated by Beat 4 chat
  chronotype?: "lark" | "neutral" | "owl";
};
```

3. Append four new optional top-level groups at the end of the `IntakePayload` type:

```ts
// ── New in Phase 2 (optional; populated by chat) ─────────────────────────
goal_narrative_chat?: string;

coaching_preferences?: {
  directness: "blunt" | "balanced" | "softer";
  cadence: "daily" | "weekly" | "on_demand";
  unprompted_actions: Array<
    "suggest_revisions" | "nudge_on_drift" | "flag_macros" | "flag_sleep"
  >;
};

free_form_constraints?: string;

sanity_overrides?: {
  goal_kept_despite_low_target?: boolean;
  sleep_efficiency_acknowledged?: boolean;
  macros_gap_acknowledged?: boolean;
  protein_floor_acknowledged?: boolean;
};
```

- [ ] **Step 2: Extend `ChatMode` to include `'intake'`**

In `lib/data/types.ts`, find the existing `ChatMode` type:

```ts
export type ChatMode = "default" | "plan_week" | "setup_block";
```

Replace with:

```ts
export type ChatMode = "default" | "plan_week" | "setup_block" | "intake";
```

- [ ] **Step 3: Add `SanityFinding` discriminated union**

Append after the IntakePayload type:

```ts
// ── Sanity-check finding from plan-builder (Beat 1 input) ───────────────────
export type SanityFinding =
  | {
      type: "goal_contradiction";
      current_e1rm: number;
      target_value: number;
      proposed_target: number;
      target_unit: string;
      lift: "squat" | "bench" | "deadlift" | "ohp";
      months_to_target: number;
      rationale: string;
    }
  | {
      type: "sleep_efficiency";
      time_in_bed_h: number;
      avg_sleep_h: number;
      current_efficiency: number;
      proposed_bedtime: string;
      rationale: string;
    }
  | {
      type: "macros_gap";
      target_kcal: number;
      actual_7d_kcal: number;
      gap_pct: number;
      options: Array<"match_actual" | "hit_target">;
      rationale: string;
    }
  | {
      type: "protein_floor";
      current_protein_g: number;
      current_per_kg_bw: number;
      floor: 1.6;
      bodyweight: number;
      proposed_protein_g: number;
      proposed_fat_g: number;
      rationale: string;
    };
```

- [ ] **Step 4: Add `PlanPayload` typed shape**

Append after `SanityFinding`:

```ts
// ── PlanPayload — Phase 2 prescribed coaching plan jsonb ────────────────────

export type PlanPayload = {
  schema_version: 1;

  athlete_snapshot: {
    name: string | null;
    age: number | null;
    height_cm: number | null;
    training_age: "beginner" | "intermediate" | "advanced";
    derived_at: string;       // ISO timestamp
  };

  goal: {
    type: "strength" | "body_comp" | "performance" | "health";
    primary_metric: string;
    target_value: number;
    target_unit: string;
    target_date: string;
    narrative_summary: string;
    feasibility_note: string | null;
  };

  periodization: {
    block_length_weeks: number;
    blocks_to_goal_date: number;
    deload_cadence_weeks: number;
    rir_arc: Array<{ week: number; rir: number | null }>;
    rotation_rule: "fixed_split" | "rotate_primary" | "specialization";
  };

  strength: {
    sessions_per_week: number;
    day_pattern: { [weekday: string]: string };
    template_session_types: Array<
      "Chest" | "Legs" | "Back" | "Mobility" | "REST"
    >;
    weekly_volume_targets: {
      [primary_lift: string]: { reps_per_week: number; sets_per_week: number };
    };
    progression_rule: string;
    notes: string | null;
  };

  nutrition: {
    phase: "cut" | "maintain" | "lean_bulk" | "recomp";
    kcal_target: number;
    kcal_range: [number, number];
    protein_g_per_kg_bw: number;
    protein_g: number;
    carb_g: number;
    fat_g: number;
    training_day_uplift: { kcal: number; carb_g: number } | null;
    refeed_cadence_days: number | null;
    refeed_uplift: { kcal: number; carb_g: number } | null;
    hard_rules: {
      alcohol_policy: "none" | "training_day_only" | "weekend_allowed";
      caffeine_cap_mg_per_day: number;
      caffeine_last_dose_hours_before_bed: number;
      tracking_tolerance_missed_days_per_week: number;
    };
    notes: string | null;
  };

  sleep: {
    chronotype: "lark" | "neutral" | "owl";
    target_hours_min: number;
    target_hours_max: number;
    wake_target: string;
    bedtime_target: string;
    efficiency_target: number;
    latency_target_min: number;
    hygiene_rules: {
      caffeine_cutoff_hours_before_bed: number;
      alcohol_cutoff_hours_before_bed: number;
      last_meal_cutoff_hours_before_bed: number;
      screen_cutoff_minutes_before_bed: number;
      intense_exercise_cutoff_hours_before_bed: number;
      morning_light_exposure_minutes: number;
      weekend_consistency_within_minutes: number;
    };
    concern_triggers: {
      avg_sleep_below_h: number;
      efficiency_below: number;
      latency_above_min: number;
      consecutive_short_nights: number;
    };
  };

  recovery: {
    mobility_minutes_per_week: number;
    deload_triggers: string[];
    reactivity_protocol: string;
  };

  coaching_agreement: {
    cadence: "daily" | "weekly" | "on_demand";
    directness: "blunt" | "balanced" | "softer";
    unprompted_actions_allowed: string[];
    re_evaluation_cadence_weeks: number;
  };
};
```

- [ ] **Step 5: Run typecheck**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
```

Expected: PASS. Types are additive at the top-level (new optional groups, new union members) — existing Phase 1 readers still work.

If typecheck fails on an exhaustiveness check anywhere that switches on `IntakeState`, `ChatMode`, etc., add the new variant case with a passthrough or sensible default. The morning bot's `lib/morning/state.ts` already handles its new IntakeState cases from Phase 1 work; ChatMode extension may affect chat route handlers similarly. Address any failures by extending the switch.

- [ ] **Step 6: Commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
git add lib/data/types.ts lib/morning/state.ts 2>/dev/null
git commit -m "feat(types): phase 2 — IntakePayload v2, PlanPayload, SanityFinding, ChatMode extend

IntakePayload schema_version bump 1 → 2, additive only. New optional groups:
  - goal_narrative_chat (chat-elicited expansion of the form why_narrative)
  - coaching_preferences (directness, cadence, unprompted_actions)
  - free_form_constraints (catch-any text)
  - sanity_overrides (per-finding override flags)
  - chronotype on sleep_recovery (Beat 4 chip question)

PlanPayload typed shape with 8 sub-objects: athlete_snapshot, goal,
periodization, strength (template only), nutrition (BW-based protein +
refeed), sleep (wake-anchored + structured hygiene), recovery,
coaching_agreement.

SanityFinding discriminated union for the 4 deterministic checks
(goal_contradiction, sleep_efficiency, macros_gap, protein_floor).

ChatMode extended with 'intake' for the new chat flow.

No DB migration — plan_payload jsonb column already nullable from
0010_athlete_profile.sql.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Approval token — extend action union

**Files:**
- Modify: `lib/coach/approval-token.ts`

- [ ] **Step 1: Read current shape**

```bash
cd "/Users/abdelouahedelbied/Health app"
grep -nE "action: |\"block\" \\| \"week\"" lib/coach/approval-token.ts
```

The `action` parameter on `signApprovalToken()` and `verifyApprovalToken()` accepts `"block" | "week"`. Extend to `"block" | "week" | "plan"`.

- [ ] **Step 2: Apply the change**

In `lib/coach/approval-token.ts`, find every occurrence of `"block" | "week"` (likely 2-3 — the type alias plus function signatures) and replace with `"block" | "week" | "plan"`.

If the type is aliased (e.g., `type Action = "block" | "week";`), update the alias.

- [ ] **Step 3: Run typecheck**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
```

Expected: PASS. No existing callers need to change because they pass `"block"` or `"week"` literals which remain valid.

- [ ] **Step 4: Commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
git add lib/coach/approval-token.ts
git commit -m "feat(approval-token): extend action union to include 'plan'

Phase 2's propose_plan / commit_plan tools reuse the existing HMAC
approval-token pattern from weekly-planning v1. Token action='plan'
binds the propose_plan output's payload hash to the matching commit_plan
verification — same shape as 'block' and 'week' tokens.

No behavioral change for existing block/week tokens.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Sanity check module + probe

**Files:**
- Create: `lib/coach/plan-builder/sanity-check.ts`
- Test: `scripts/probe-sanity-check.mjs` (deleted after running)

- [ ] **Step 1: Create the sanity check module**

Write `lib/coach/plan-builder/sanity-check.ts`:

```ts
// lib/coach/plan-builder/sanity-check.ts
//
// Deterministic sanity checks run BEFORE the chat narrative deepening.
// Surfaces findings in Beat 1 of the intake chat with proposed corrections.
// User can Accept (apply_* tool fires) or Override (set_sanity_override fires).
//
// All checks are pure functions over IntakePayload + supporting data.
// No I/O inside the check functions themselves; the orchestrator loads
// supporting data and passes it in.

import type { IntakePayload, SanityFinding } from "@/lib/data/types";

const PRIMARY_LIFT_REGEX: Record<"squat" | "bench" | "deadlift" | "ohp", RegExp> = {
  squat: /\b(back\s+squat|squat)\b/i,
  bench: /\b(bench\s+press|bench)\b/i,
  deadlift: /\b(deadlift|conventional\s+deadlift|sumo\s+deadlift)\b/i,
  ohp: /\b(overhead\s+press|ohp|military\s+press|strict\s+press)\b/i,
};

export type SanityCheckInputs = {
  intake: IntakePayload;
  current_bodyweight_kg: number | null;
  rolling_7d_kcal: number | null;
  today: string; // YYYY-MM-DD in user tz
};

export function runSanityChecks(inputs: SanityCheckInputs): SanityFinding[] {
  const findings: SanityFinding[] = [];
  const goal = checkGoalContradiction(inputs);
  if (goal) findings.push(goal);
  const sleep = checkSleepEfficiency(inputs);
  if (sleep) findings.push(sleep);
  const macros = checkMacrosGap(inputs);
  if (macros) findings.push(macros);
  const protein = checkProteinFloor(inputs);
  if (protein) findings.push(protein);
  return findings;
}

// ── 1. Goal contradiction ────────────────────────────────────────────────────

function checkGoalContradiction(inputs: SanityCheckInputs): SanityFinding | null {
  const { intake } = inputs;
  // Skip if already overridden
  if (intake.sanity_overrides?.goal_kept_despite_low_target === true) return null;
  if (intake.goals.primary_type !== "strength") return null;

  // Infer the lift from primary_metric
  const lift = inferLiftFromMetric(intake.goals.primary_metric);
  if (!lift) return null;

  const currentE1rm = intake.training.current_e1rm[lift];
  if (currentE1rm === null || currentE1rm === undefined) return null;

  // Fires when target_value <= current_e1rm
  if (intake.goals.target_value > currentE1rm) return null;

  // Compute proposed target: current × (1 + months × 0.04)
  const targetDate = new Date(intake.goals.target_date);
  const today = new Date(inputs.today);
  const days = Math.max(0, (targetDate.getTime() - today.getTime()) / 86_400_000);
  const months = days / 30.4;
  const proposedRaw = currentE1rm * (1 + months * 0.04);
  // Round to nearest 2.5kg (plate-loadable)
  const proposed = Math.round(proposedRaw / 2.5) * 2.5;

  return {
    type: "goal_contradiction",
    current_e1rm: currentE1rm,
    target_value: intake.goals.target_value,
    proposed_target: proposed,
    target_unit: intake.goals.target_unit,
    lift,
    months_to_target: Math.round(months * 10) / 10,
    rationale: `Current e1RM ${currentE1rm}${intake.goals.target_unit} already meets or exceeds the stated target ${intake.goals.target_value}${intake.goals.target_unit}. Suggested ${proposed}${intake.goals.target_unit} = current × (1 + ${months.toFixed(1)}mo × 4%/mo), a conservative intermediate-lifter progression.`,
  };
}

function inferLiftFromMetric(metric: string): "squat" | "bench" | "deadlift" | "ohp" | null {
  for (const lift of ["squat", "bench", "deadlift", "ohp"] as const) {
    if (PRIMARY_LIFT_REGEX[lift].test(metric)) return lift;
  }
  return null;
}

// ── 2. Sleep efficiency ──────────────────────────────────────────────────────

function checkSleepEfficiency(inputs: SanityCheckInputs): SanityFinding | null {
  const { intake } = inputs;
  if (intake.sanity_overrides?.sleep_efficiency_acknowledged === true) return null;

  const bedtime = intake.sleep_recovery.typical_bedtime;
  const wake = intake.sleep_recovery.typical_wake_time;
  const avgSleep = intake.sleep_recovery.avg_sleep_hours;

  const timeInBed = computeTimeInBed(bedtime, wake);
  if (timeInBed === null || avgSleep <= 0) return null;

  const gap = timeInBed - avgSleep;
  if (gap <= 1) return null;

  const efficiency = avgSleep / timeInBed;
  // Propose bedtime that closes the gap: same wake time, bedtime shifted later
  // to reduce time-in-bed to (avgSleep + 0.5h buffer)
  const desiredTimeInBed = avgSleep + 0.5;
  const proposedBedtime = subtractHoursFromHHmm(wake, desiredTimeInBed);

  return {
    type: "sleep_efficiency",
    time_in_bed_h: Math.round(timeInBed * 10) / 10,
    avg_sleep_h: avgSleep,
    current_efficiency: Math.round(efficiency * 100) / 100,
    proposed_bedtime: proposedBedtime,
    rationale: `${timeInBed.toFixed(1)}h in bed but only ${avgSleep}h asleep (efficiency ${(efficiency * 100).toFixed(0)}%). Either push bedtime to ${proposedBedtime} to align time-in-bed with actual sleep, or address sleep latency separately.`,
  };
}

function computeTimeInBed(bedtime: string, wake: string): number | null {
  const bParts = bedtime.split(":");
  const wParts = wake.split(":");
  if (bParts.length !== 2 || wParts.length !== 2) return null;
  const bh = Number(bParts[0]);
  const bm = Number(bParts[1]);
  const wh = Number(wParts[0]);
  const wm = Number(wParts[1]);
  if ([bh, bm, wh, wm].some((n) => !Number.isFinite(n))) return null;
  let minutes = wh * 60 + wm - (bh * 60 + bm);
  if (minutes < 0) minutes += 24 * 60;
  return minutes / 60;
}

function subtractHoursFromHHmm(hhmm: string, hours: number): string {
  const [h, m] = hhmm.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return hhmm;
  let totalMinutes = h * 60 + m - Math.round(hours * 60);
  while (totalMinutes < 0) totalMinutes += 24 * 60;
  const newH = Math.floor(totalMinutes / 60);
  const newM = totalMinutes % 60;
  return `${String(newH).padStart(2, "0")}:${String(newM).padStart(2, "0")}`;
}

// ── 3. Macros gap ────────────────────────────────────────────────────────────

function checkMacrosGap(inputs: SanityCheckInputs): SanityFinding | null {
  const { intake, rolling_7d_kcal } = inputs;
  if (intake.sanity_overrides?.macros_gap_acknowledged === true) return null;
  if (rolling_7d_kcal === null) return null;

  const target = intake.nutrition.current_kcal;
  if (target <= 0) return null;

  const gap = (target - rolling_7d_kcal) / target;
  if (Math.abs(gap) <= 0.1) return null; // within 10% — close enough

  return {
    type: "macros_gap",
    target_kcal: target,
    actual_7d_kcal: Math.round(rolling_7d_kcal),
    gap_pct: Math.round(gap * 1000) / 10, // e.g., -12.5
    options: ["match_actual", "hit_target"],
    rationale: `Stated target ${target} kcal, but rolling 7d actual ${Math.round(rolling_7d_kcal)} kcal (${gap >= 0 ? "+" : ""}${(gap * 100).toFixed(0)}%). Either lower target to match reality, or commit to hitting the stated target as a behavior change.`,
  };
}

// ── 4. Protein floor (cuts only) ─────────────────────────────────────────────

function checkProteinFloor(inputs: SanityCheckInputs): SanityFinding | null {
  const { intake, current_bodyweight_kg } = inputs;
  if (intake.sanity_overrides?.protein_floor_acknowledged === true) return null;
  if (intake.nutrition.current_phase !== "cut") return null;
  if (current_bodyweight_kg === null || current_bodyweight_kg <= 0) return null;

  const protein = intake.nutrition.current_macros.protein_g;
  const perKgBw = protein / current_bodyweight_kg;
  const FLOOR = 1.6;

  if (perKgBw >= FLOOR) return null;

  const proposedProteinG = Math.round(current_bodyweight_kg * FLOOR);
  const proteinDeltaG = proposedProteinG - protein;
  // Maintain kcal stable by reducing fat proportionally:
  // protein kcal change = proteinDeltaG × 4
  // fat kcal change = -proteinDeltaG × 4
  // fat g change = -(proteinDeltaG × 4) / 9
  const fatDeltaG = -(proteinDeltaG * 4) / 9;
  const proposedFatG = Math.max(
    20,
    Math.round(intake.nutrition.current_macros.fat_g + fatDeltaG),
  );

  return {
    type: "protein_floor",
    current_protein_g: protein,
    current_per_kg_bw: Math.round(perKgBw * 100) / 100,
    floor: FLOOR,
    bodyweight: current_bodyweight_kg,
    proposed_protein_g: proposedProteinG,
    proposed_fat_g: proposedFatG,
    rationale: `Current protein ${protein}g is ${perKgBw.toFixed(2)} g/kg BW, below the 1.6 g/kg clinical floor for cuts. Suggested ${proposedProteinG}g protein with ${proposedFatG}g fat to keep kcal stable.`,
  };
}
```

- [ ] **Step 2: Create probe script**

Write `scripts/probe-sanity-check.mjs`:

```js
// scripts/probe-sanity-check.mjs
import { runSanityChecks } from "../lib/coach/plan-builder/sanity-check.ts";

function intake(overrides = {}) {
  return {
    schema_version: 2,
    health: {
      conditions: { cardiac: false, hypertension: false, diabetes: "none",
                    autoimmune: false, joint_surgeries: [], other: "" },
      medications: "", recent_illness_injury: "",
      active_injuries: [], allergies: "",
    },
    training: {
      years_lifting: 5, training_age: "intermediate", sessions_per_week: 4,
      typical_session_minutes: 75,
      equipment: { barbell: true, rack: true, bench: true, dumbbells: true,
                   cables: true, machines: true, platform: true, ghd: true,
                   sled: true, treadmill: true, rower: true, bike: true,
                   kettlebells: true, bands: true, other: "" },
      current_e1rm: { squat: 93, bench: 84, deadlift: 102, ohp: 38 },
      best_ever_pr: { squat: 96, bench: null, deadlift: 110, ohp: null },
      previous_programs: "", recent_plateaus: "",
    },
    lifestyle: {
      job_demands: "mixed", commute_minutes: 0, has_dependents: false,
      dependent_notes: "", stress_self_rating: 3,
      days_available: { mon: true, tue: true, wed: true, thu: true,
                        fri: true, sat: false, sun: false },
      earliest_session_time: "06:00", latest_session_time: "21:00",
      travel_frequency: "rare",
    },
    nutrition: {
      current_phase: "cut", current_kcal: 2085,
      current_macros: { protein_g: 168, carb_g: 145, fat_g: 87 },
      tracking_experience: "consistent", restrictions: "",
      alcohol_drinks_per_week: 0, caffeine_mg_per_day: 200, supplements: "",
      ...overrides.nutrition,
    },
    sleep_recovery: {
      avg_sleep_hours: 7,
      typical_bedtime: "21:30", typical_wake_time: "06:30",
      sleep_latency_minutes: 15, awakenings: "1_2",
      mobility_work: "", soreness_frequency: "common",
      ...overrides.sleep_recovery,
    },
    goals: {
      primary_type: "strength", primary_metric: "Deadlift e1RM",
      target_value: 100, target_unit: "kg", target_date: "2026-08-08",
      why_narrative: "powerlifting meet",
      ...overrides.goals,
    },
    sanity_overrides: overrides.sanity_overrides ?? undefined,
  };
}

const cases = [
  {
    label: "live user — should fire goal_contradiction + sleep_efficiency",
    inputs: {
      intake: intake(),
      current_bodyweight_kg: 103.5,
      rolling_7d_kcal: 2085,
      today: "2026-05-11",
    },
    expectedTypes: ["goal_contradiction", "sleep_efficiency"],
  },
  {
    label: "goal target above current — no goal_contradiction",
    inputs: {
      intake: intake({ goals: { target_value: 130 } }),
      current_bodyweight_kg: 103.5,
      rolling_7d_kcal: 2085,
      today: "2026-05-11",
    },
    expectedNotTypes: ["goal_contradiction"],
  },
  {
    label: "good sleep efficiency — no sleep finding",
    inputs: {
      intake: intake({
        sleep_recovery: { typical_bedtime: "23:00", typical_wake_time: "06:30", avg_sleep_hours: 7.2 },
      }),
      current_bodyweight_kg: 103.5,
      rolling_7d_kcal: 2085,
      today: "2026-05-11",
    },
    expectedNotTypes: ["sleep_efficiency"],
  },
  {
    label: "macros gap — actual 1700 vs target 2085 (-18%)",
    inputs: {
      intake: intake(),
      current_bodyweight_kg: 103.5,
      rolling_7d_kcal: 1700,
      today: "2026-05-11",
    },
    expectedTypes: ["macros_gap"],
  },
  {
    label: "protein floor — 100g / 80kg = 1.25 g/kg, below 1.6 floor",
    inputs: {
      intake: intake({ nutrition: { current_macros: { protein_g: 100, carb_g: 220, fat_g: 75 } } }),
      current_bodyweight_kg: 80,
      rolling_7d_kcal: 2085,
      today: "2026-05-11",
    },
    expectedTypes: ["protein_floor"],
  },
  {
    label: "sanity overrides — none should fire when overridden",
    inputs: {
      intake: intake({
        sanity_overrides: {
          goal_kept_despite_low_target: true,
          sleep_efficiency_acknowledged: true,
          macros_gap_acknowledged: true,
          protein_floor_acknowledged: true,
        },
      }),
      current_bodyweight_kg: 103.5,
      rolling_7d_kcal: 2085,
      today: "2026-05-11",
    },
    expectedTypes: [],
  },
];

let pass = 0, fail = 0;
for (const c of cases) {
  const findings = runSanityChecks(c.inputs);
  const types = findings.map((f) => f.type);
  let ok = true;
  if (c.expectedTypes) {
    for (const t of c.expectedTypes) {
      if (!types.includes(t)) ok = false;
    }
    if (types.length !== c.expectedTypes.length) ok = false;
  }
  if (c.expectedNotTypes) {
    for (const t of c.expectedNotTypes) {
      if (types.includes(t)) ok = false;
    }
  }
  console.log(`${ok ? "✓" : "✗"} ${c.label}`);
  if (!ok) {
    console.log(`  expected: ${c.expectedTypes?.join(",") ?? "(any)"}, not: ${c.expectedNotTypes?.join(",") ?? "(none)"}`);
    console.log(`  got:      ${types.join(",") || "(none)"}`);
    fail++;
  } else {
    pass++;
  }
}
console.log(`\n${pass} pass / ${fail} fail`);
```

- [ ] **Step 3: Run probe**

```bash
cd "/Users/abdelouahedelbied/Health app"
npx tsx scripts/probe-sanity-check.mjs
```

(If Node 25 / tsx ESM loader hits the known bug from prior tasks, fall back to `.mts` + `--experimental-strip-types` as established in the morning brief work.)

Expected output: 6/6 pass.

- [ ] **Step 4: Delete probe + run typecheck**

```bash
cd "/Users/abdelouahedelbied/Health app"
rm scripts/probe-sanity-check.mjs
npm run typecheck
```

Expected: clean typecheck.

- [ ] **Step 5: Commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
git add lib/coach/plan-builder/sanity-check.ts
git commit -m "feat(coach): plan-builder sanity-check module (4 deterministic checks)

runSanityChecks() returns SanityFinding[] for Beat 1 of intake chat:
  - goal_contradiction: strength target <= current e1RM; proposes
    current × (1 + months × 4%/mo), rounded to nearest 2.5kg
  - sleep_efficiency: time-in-bed > avg_sleep + 1h; proposes bedtime
    that aligns time-in-bed with avg_sleep + 30min buffer (wake stays anchored)
  - macros_gap: |stated_target - rolling_7d| / target > 10%; offers
    two paths (match_actual or hit_target)
  - protein_floor: cuts only, current protein < 1.6 g/kg BW; proposes
    bumping protein to floor and reducing fat to keep kcal stable

Each check respects intake.sanity_overrides[*] flags (skip if already
overridden).

Probe-tested with 6 cases including the live user's v1 intake.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: compose-snapshot + compose-goal

**Files:**
- Create: `lib/coach/plan-builder/compose-snapshot.ts`
- Create: `lib/coach/plan-builder/compose-goal.ts`

Two small pure composers grouped together.

- [ ] **Step 1: Create `compose-snapshot.ts`**

```ts
// lib/coach/plan-builder/compose-snapshot.ts
//
// Composes athlete_snapshot section of plan_payload from intake_payload.
// Pure function, no I/O.

import type { IntakePayload, PlanPayload, Profile } from "@/lib/data/types";

export function composeSnapshot(
  intake: IntakePayload,
  profile: Pick<Profile, "name" | "age" | "height_cm"> | null,
): PlanPayload["athlete_snapshot"] {
  return {
    name: profile?.name ?? null,
    age: profile?.age ?? null,
    height_cm: profile?.height_cm ?? null,
    training_age: intake.training.training_age,
    derived_at: new Date().toISOString(),
  };
}
```

- [ ] **Step 2: Create `compose-goal.ts`**

```ts
// lib/coach/plan-builder/compose-goal.ts
//
// Composes goal section of plan_payload from intake_payload.
// narrative_summary is left empty here — populated by generatePlanNarrative()
// during the AI pass. feasibility_note is set if sanity_overrides indicate
// the user kept a goal target below current.

import type { IntakePayload, PlanPayload } from "@/lib/data/types";

export function composeGoal(intake: IntakePayload): PlanPayload["goal"] {
  let feasibility_note: string | null = null;
  if (intake.sanity_overrides?.goal_kept_despite_low_target === true) {
    feasibility_note =
      "User acknowledged target is below current e1RM — proceeding against stated value.";
  }
  return {
    type: intake.goals.primary_type,
    primary_metric: intake.goals.primary_metric,
    target_value: intake.goals.target_value,
    target_unit: intake.goals.target_unit,
    target_date: intake.goals.target_date,
    narrative_summary: "", // populated by AI narrative pass
    feasibility_note,
  };
}
```

- [ ] **Step 3: Run typecheck**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
git add lib/coach/plan-builder/compose-snapshot.ts lib/coach/plan-builder/compose-goal.ts
git commit -m "feat(plan-builder): compose-snapshot + compose-goal

Two small pure composers. Snapshot pulls identity (name, age, height)
from profile + training_age from intake. Goal copies metric/target/date
from intake.goals and sets feasibility_note when sanity_overrides flag
the goal-kept-despite-low-target case. narrative_summary stays empty
(populated by the AI narrative pass).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: compose-periodization

**Files:**
- Create: `lib/coach/plan-builder/compose-periodization.ts`

- [ ] **Step 1: Create the composer**

```ts
// lib/coach/plan-builder/compose-periodization.ts
//
// Composes periodization section of plan_payload.
// Fixed defaults for v1: 5-week blocks ending in deload, RIR step-down
// 4→3→2→1→deload, rotation rule = fixed_split.

import type { IntakePayload, PlanPayload } from "@/lib/data/types";

export function composePeriodization(
  intake: IntakePayload,
): PlanPayload["periodization"] {
  const today = new Date();
  const targetDate = new Date(intake.goals.target_date);
  const daysToTarget = Math.max(
    0,
    (targetDate.getTime() - today.getTime()) / 86_400_000,
  );
  const blocksToGoalDate = Math.ceil(daysToTarget / 7 / 5);

  return {
    block_length_weeks: 5,
    blocks_to_goal_date: blocksToGoalDate,
    deload_cadence_weeks: 5,
    rir_arc: [
      { week: 1, rir: 4 },
      { week: 2, rir: 3 },
      { week: 3, rir: 2 },
      { week: 4, rir: 1 },
      { week: 5, rir: null }, // deload
    ],
    rotation_rule: "fixed_split",
  };
}
```

- [ ] **Step 2: Run typecheck + commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
git add lib/coach/plan-builder/compose-periodization.ts
git commit -m "feat(plan-builder): compose-periodization

Fixed v1 defaults: 5-week blocks, RIR step-down 4→3→2→1→deload,
rotation_rule='fixed_split'. blocks_to_goal_date computed from
intake.goals.target_date.

Tier 2 deferrals documented in spec: 6-week blocks, rotate_primary,
specialization splits.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: compose-strength-template

**Files:**
- Create: `lib/coach/plan-builder/compose-strength.ts`

- [ ] **Step 1: Create the composer**

```ts
// lib/coach/plan-builder/compose-strength.ts
//
// Composes strength TEMPLATE section of plan_payload. Per-block weights
// remain in training_blocks; per-week schedule in training_weeks. This
// section is the durable contract for what the user's strength practice
// looks like at the plan level.

import type { IntakePayload, PlanPayload, TrainingBlock } from "@/lib/data/types";

export type RecentE1RMsForStrength = {
  squat: number | null;
  bench: number | null;
  deadlift: number | null;
  ohp: number | null;
};

export function composeStrengthTemplate(
  intake: IntakePayload,
  activeBlock: Pick<TrainingBlock, "primary_lift"> | null,
  recentE1RMs: RecentE1RMsForStrength,
): PlanPayload["strength"] {
  const sessionsPerWeek = intake.training.sessions_per_week;
  const dayPattern = composeDayPattern(intake, sessionsPerWeek);
  const sessionTypes = Array.from(new Set(Object.values(dayPattern))) as Array<
    "Chest" | "Legs" | "Back" | "Mobility" | "REST"
  >;

  return {
    sessions_per_week: sessionsPerWeek,
    day_pattern: dayPattern,
    template_session_types: sessionTypes,
    weekly_volume_targets: composeVolumeTargets(
      intake,
      activeBlock?.primary_lift ?? null,
    ),
    progression_rule: composeProgressionRule(intake.training.training_age),
    notes: null, // populated by AI narrative pass
  };
}

/** Builds a Mon-Sun map of session types from intake.lifestyle.days_available.
 *  Defaults to a Chest/Legs/Back/Mobility rotation when the user has 4 available
 *  days, scaled up/down by sessions_per_week. */
function composeDayPattern(
  intake: IntakePayload,
  sessions: number,
): { [weekday: string]: string } {
  const days = intake.lifestyle.days_available;
  const orderedDays: Array<[keyof typeof days, string]> = [
    ["mon", "Monday"],
    ["tue", "Tuesday"],
    ["wed", "Wednesday"],
    ["thu", "Thursday"],
    ["fri", "Friday"],
    ["sat", "Saturday"],
    ["sun", "Sunday"],
  ];

  // Session-type rotation: prioritize Legs (primary lift goal often hinges on this),
  // then Back, then Chest, then Mobility for the 4-day case.
  const rotation = ["Legs", "Chest", "Back", "Mobility"];
  const pattern: { [weekday: string]: string } = {};

  let sessionIdx = 0;
  for (const [key, weekday] of orderedDays) {
    if (days[key] && sessionIdx < sessions) {
      pattern[weekday] = rotation[sessionIdx % rotation.length];
      sessionIdx++;
    } else {
      pattern[weekday] = "REST";
    }
  }
  return pattern;
}

/** Volume targets per primary lift, scaled by training_age. */
function composeVolumeTargets(
  intake: IntakePayload,
  primaryLift: "squat" | "bench" | "deadlift" | "ohp" | null,
): { [lift: string]: { reps_per_week: number; sets_per_week: number } } {
  const targets: { [lift: string]: { reps_per_week: number; sets_per_week: number } } = {};
  const lifts = primaryLift
    ? [primaryLift]
    : (["squat", "bench", "deadlift", "ohp"] as const);
  const profile = volumeProfileForAge(intake.training.training_age);
  for (const lift of lifts) {
    targets[lift] = { ...profile };
  }
  return targets;
}

function volumeProfileForAge(
  age: "beginner" | "intermediate" | "advanced",
): { reps_per_week: number; sets_per_week: number } {
  switch (age) {
    case "beginner":
      return { reps_per_week: 50, sets_per_week: 10 };
    case "intermediate":
      return { reps_per_week: 70, sets_per_week: 14 };
    case "advanced":
      return { reps_per_week: 90, sets_per_week: 18 };
  }
}

function composeProgressionRule(
  age: "beginner" | "intermediate" | "advanced",
): string {
  switch (age) {
    case "beginner":
      return "Add 2.5kg to primary lifts every session when all working reps are clean.";
    case "intermediate":
      return "Add 2.5kg to primary lifts when last set ≥ target RIR + 2 reps for 2 consecutive sessions.";
    case "advanced":
      return "Wave loading per block; reassess at block end against e1RM trajectory.";
  }
}
```

- [ ] **Step 2: Run typecheck + commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
git add lib/coach/plan-builder/compose-strength.ts
git commit -m "feat(plan-builder): compose-strength-template

Sessions/wk from intake. Day pattern uses full weekday names ('Monday',
matches live training_weeks convention) with rotation Legs → Chest →
Back → Mobility filling available days. Volume targets per primary lift
keyed to training_age (beginner 50r/10s, intermediate 70r/14s, advanced
90r/18s reps/wk). Progression rule templated by training_age.

Per-block weights stay in training_blocks; this section is template-only.

Tier 2 deferrals: per-muscle volume tracking (MEV/MAV/MRV), PPL/U/L splits.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: compose-nutrition (BW-based protein, refeed, hard_rules)

**Files:**
- Create: `lib/coach/plan-builder/compose-nutrition.ts`

- [ ] **Step 1: Create the composer**

```ts
// lib/coach/plan-builder/compose-nutrition.ts
//
// Composes nutrition section of plan_payload. Protein expressed g/kg BW
// per user's clinical recommendation (floor 1.6 across all phases).
// Refeed cadence enforced for cuts. Hard rules typed.

import type { IntakePayload, PlanPayload } from "@/lib/data/types";

export function composeNutrition(
  intake: IntakePayload,
  current_bodyweight_kg: number,
): PlanPayload["nutrition"] {
  const phase = intake.nutrition.current_phase === "unsure"
    ? "maintain" // safe default when user is unsure
    : intake.nutrition.current_phase;

  const proteinPerKg = proteinTargetForPhase(phase);
  const proteinG = Math.round(current_bodyweight_kg * proteinPerKg);

  const kcalTarget = intake.nutrition.current_kcal;
  const kcalLow = Math.round(kcalTarget * 0.95);
  const kcalHigh = Math.round(kcalTarget * 1.05);

  // Remaining kcal after protein (4 kcal/g) goes to carb+fat split.
  const proteinKcal = proteinG * 4;
  const remainingKcal = Math.max(0, kcalTarget - proteinKcal);

  // Carb/fat split by phase:
  //   cut: 50/50 of remaining (more carbs to preserve training output)
  //   maintain: 60/40 carb/fat
  //   lean_bulk: 70/30 carb/fat
  //   recomp: 55/45 carb/fat
  const splits: Record<typeof phase, [number, number]> = {
    cut: [0.5, 0.5],
    maintain: [0.6, 0.4],
    lean_bulk: [0.7, 0.3],
    recomp: [0.55, 0.45],
  };
  const [carbRatio, fatRatio] = splits[phase];
  const carbG = Math.round((remainingKcal * carbRatio) / 4);
  const fatG = Math.round((remainingKcal * fatRatio) / 9);

  // Training day uplift: cut + intermediate or higher training_age → +150 kcal carb-led
  const trainingDayUplift =
    phase === "cut" &&
    (intake.training.training_age === "intermediate" ||
      intake.training.training_age === "advanced")
      ? { kcal: 150, carb_g: 35 }
      : null;

  // Refeed cadence: cuts → 6 days; otherwise null
  const refeedCadence = phase === "cut" ? 6 : null;
  const refeedUplift = phase === "cut" ? { kcal: 500, carb_g: 100 } : null;

  return {
    phase,
    kcal_target: kcalTarget,
    kcal_range: [kcalLow, kcalHigh],
    protein_g_per_kg_bw: proteinPerKg,
    protein_g: proteinG,
    carb_g: carbG,
    fat_g: fatG,
    training_day_uplift: trainingDayUplift,
    refeed_cadence_days: refeedCadence,
    refeed_uplift: refeedUplift,
    hard_rules: composeHardRules(intake),
    notes: null, // populated by AI narrative pass
  };
}

/** Phase-defaults protein target. Floor 1.6 g/kg BW for all per user's clinical
 *  guidance. Higher prescriptions are optional follow-ups via user feedback. */
function proteinTargetForPhase(
  phase: "cut" | "maintain" | "lean_bulk" | "recomp",
): number {
  return 1.6; // unified across all phases
}

function composeHardRules(
  intake: IntakePayload,
): PlanPayload["nutrition"]["hard_rules"] {
  const drinksPerWeek = intake.nutrition.alcohol_drinks_per_week;
  let alcoholPolicy: "none" | "training_day_only" | "weekend_allowed";
  if (drinksPerWeek === 0) alcoholPolicy = "none";
  else if (drinksPerWeek <= 5) alcoholPolicy = "training_day_only";
  else alcoholPolicy = "weekend_allowed";

  return {
    alcohol_policy: alcoholPolicy,
    caffeine_cap_mg_per_day: Math.min(400, intake.nutrition.caffeine_mg_per_day || 400),
    caffeine_last_dose_hours_before_bed: 8,
    tracking_tolerance_missed_days_per_week: 1,
  };
}
```

- [ ] **Step 2: Run typecheck + commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
git add lib/coach/plan-builder/compose-nutrition.ts
git commit -m "feat(plan-builder): compose-nutrition (BW-based protein, refeed)

Protein at 1.6 g/kg BW across all phases (clinical floor per user's
doctor — unified across cut/maintain/lean_bulk/recomp).

kcal_range tightened to ±5% (was ±10% in initial draft).

Phase-dependent carb/fat splits of remaining kcal after protein:
  cut: 50/50 (more carbs to preserve training)
  maintain: 60/40
  lean_bulk: 70/30
  recomp: 55/45

training_day_uplift: +150 kcal carb-led for cuts on
intermediate/advanced lifters (LBM preservation during cut).
refeed_cadence_days: 6 for cuts, +500 kcal/+100g carbs.

hard_rules typed struct: alcohol_policy from drinks/wk threshold,
caffeine cap 400mg, caffeine cutoff 8h before bed.

Tier 2 deferrals: diet break / reverse dieting, training_age-specific
protein adjustments, micronutrient layer.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: compose-sleep (wake-anchored, hygiene defaults)

**Files:**
- Create: `lib/coach/plan-builder/compose-sleep.ts`

- [ ] **Step 1: Create the composer**

```ts
// lib/coach/plan-builder/compose-sleep.ts
//
// Composes sleep section of plan_payload. Wake-anchored (sleep medicine
// convention) — wake_target stays fixed, bedtime_target derived. Hygiene
// rules typed with time-relative-to-bedtime defaults. Chronotype-aware
// when set in Beat 4; otherwise neutral.

import type { IntakePayload, PlanPayload } from "@/lib/data/types";

export function composeSleep(intake: IntakePayload): PlanPayload["sleep"] {
  const chronotype = intake.sleep_recovery.chronotype ?? "neutral";

  // Default target: 7.5-8.5h. Chronotype can shift the wake/bed targets but
  // not the duration band in v1.
  const targetHoursMin = 7.5;
  const targetHoursMax = 8.5;

  // Use intake's typical_wake_time as the wake anchor (or chronotype default
  // if unspecified).
  const wakeTarget = intake.sleep_recovery.typical_wake_time || defaultWake(chronotype);

  // Bedtime derived from wake - target_hours_max
  const bedtimeTarget = subtractHoursFromHHmm(wakeTarget, targetHoursMax);

  return {
    chronotype,
    target_hours_min: targetHoursMin,
    target_hours_max: targetHoursMax,
    wake_target: wakeTarget,
    bedtime_target: bedtimeTarget,
    efficiency_target: 0.85,
    latency_target_min: 20,
    hygiene_rules: {
      caffeine_cutoff_hours_before_bed: 8,
      alcohol_cutoff_hours_before_bed: 3,
      last_meal_cutoff_hours_before_bed: 2,
      screen_cutoff_minutes_before_bed: 60,
      intense_exercise_cutoff_hours_before_bed: 3,
      morning_light_exposure_minutes: 10,
      weekend_consistency_within_minutes: 60,
    },
    concern_triggers: {
      avg_sleep_below_h: 6.5,
      efficiency_below: 0.80,
      latency_above_min: 30,
      consecutive_short_nights: 2,
    },
  };
}

function defaultWake(chronotype: "lark" | "neutral" | "owl"): string {
  switch (chronotype) {
    case "lark":
      return "05:30";
    case "owl":
      return "08:00";
    case "neutral":
      return "06:30";
  }
}

function subtractHoursFromHHmm(hhmm: string, hours: number): string {
  const [h, m] = hhmm.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return "22:30";
  let totalMinutes = h * 60 + m - Math.round(hours * 60);
  while (totalMinutes < 0) totalMinutes += 24 * 60;
  const newH = Math.floor(totalMinutes / 60);
  const newM = totalMinutes % 60;
  return `${String(newH).padStart(2, "0")}:${String(newM).padStart(2, "0")}`;
}
```

- [ ] **Step 2: Run typecheck + commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
git add lib/coach/plan-builder/compose-sleep.ts
git commit -m "feat(plan-builder): compose-sleep (wake-anchored, structured hygiene)

Sleep medicine convention: wake_target is the anchor, bedtime derived
from wake - target_hours_max.

Chronotype-aware defaults when user picks lark/neutral/owl in Beat 4
(lark wake 05:30, owl 08:00, neutral 06:30) — only used when intake's
typical_wake_time is empty.

Hygiene rules typed: caffeine 8h before bed, alcohol 3h, last meal 2h,
screens 60min, intense exercise 3h, morning light 10min, weekend
consistency within 60min.

Concern triggers: avg sleep <6.5h, efficiency <80%, latency >30min,
consecutive short nights 2/4.

Tier 2 deferrals: nap protocols, sleep banking, chronotype-band tuning.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: compose-recovery + compose-coaching-agreement

**Files:**
- Create: `lib/coach/plan-builder/compose-recovery.ts`
- Create: `lib/coach/plan-builder/compose-coaching-agreement.ts`

Two small composers grouped together.

- [ ] **Step 1: Create `compose-recovery.ts`**

```ts
// lib/coach/plan-builder/compose-recovery.ts

import type { IntakePayload, PlanPayload } from "@/lib/data/types";

export function composeRecovery(intake: IntakePayload): PlanPayload["recovery"] {
  // Mobility minutes/week: parse from intake.sleep_recovery.mobility_work if
  // it mentions a frequency; default 30.
  const mobilityWork = intake.sleep_recovery.mobility_work.toLowerCase();
  let mobilityMin = 30;
  const perWeekMatch = mobilityWork.match(/(\d+)\s*(min|minute|minutes)\s*(?:per\s*)?week/);
  const daysMatch = mobilityWork.match(/(\d+)\s*(per|\/)\s*week/);
  if (perWeekMatch) {
    mobilityMin = parseInt(perWeekMatch[1], 10);
  } else if (daysMatch) {
    // Assume ~15 min per session if user says e.g. "3 per week"
    mobilityMin = parseInt(daysMatch[1], 10) * 15;
  }

  return {
    mobility_minutes_per_week: mobilityMin,
    deload_triggers: [
      "HRV outside SWC band 2/4 days",
      "Sleep <6h on 2/4 nights",
      "e1RM drop ≥3% over 2 weeks",
    ],
    reactivity_protocol:
      "If today's readiness < 33%: drop intensity 10%, keep volume. Don't skip the session.",
  };
}
```

- [ ] **Step 2: Create `compose-coaching-agreement.ts`**

```ts
// lib/coach/plan-builder/compose-coaching-agreement.ts

import type { IntakePayload, PlanPayload } from "@/lib/data/types";

export function composeCoachingAgreement(
  intake: IntakePayload,
): PlanPayload["coaching_agreement"] {
  const prefs = intake.coaching_preferences;
  return {
    cadence: prefs?.cadence ?? "weekly",
    directness: prefs?.directness ?? "balanced",
    unprompted_actions_allowed: prefs?.unprompted_actions ?? [],
    re_evaluation_cadence_weeks: 8,
  };
}
```

- [ ] **Step 3: Run typecheck + commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
git add lib/coach/plan-builder/compose-recovery.ts lib/coach/plan-builder/compose-coaching-agreement.ts
git commit -m "feat(plan-builder): compose-recovery + compose-coaching-agreement

Recovery: parse mobility_minutes_per_week from intake.sleep_recovery.mobility_work
free-text using two regex patterns (X minutes per week, X per week).
deload_triggers: standard autoregulation defaults (HRV SWC, sleep <6h, e1RM drop).
reactivity_protocol: standard 'drop 10% intensity on low readiness, don't skip'.

Coaching agreement: 1:1 mapping from intake.coaching_preferences (Beat 4).
Defaults: balanced directness, weekly cadence, no unprompted actions, 8wk re-eval.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Plan-builder orchestrator

**Files:**
- Create: `lib/coach/plan-builder/index.ts`

- [ ] **Step 1: Create the orchestrator**

```ts
// lib/coach/plan-builder/index.ts
//
// Orchestrates plan_payload generation:
//   1. Fetch supporting data in parallel (latest bodyweight, recent e1RMs,
//      active block, profile basics, rolling 7d kcal).
//   2. Run sanity checks (deterministic) — caller decides whether to surface
//      them in chat or proceed.
//   3. Compose all 8 sections (deterministic).
//   4. Single AI call to populate narrative fields (goal_summary,
//      strength_notes, nutrition_notes).
//   5. Return full PlanPayload.
//
// Cost: ~$0.018 per call (one Sonnet 4.6 call for narrative).

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  IntakePayload,
  PlanPayload,
  Profile,
  TrainingBlock,
  SanityFinding,
} from "@/lib/data/types";
import { runSanityChecks } from "@/lib/coach/plan-builder/sanity-check";
import { composeSnapshot } from "@/lib/coach/plan-builder/compose-snapshot";
import { composeGoal } from "@/lib/coach/plan-builder/compose-goal";
import { composePeriodization } from "@/lib/coach/plan-builder/compose-periodization";
import { composeStrengthTemplate, type RecentE1RMsForStrength } from "@/lib/coach/plan-builder/compose-strength";
import { composeNutrition } from "@/lib/coach/plan-builder/compose-nutrition";
import { composeSleep } from "@/lib/coach/plan-builder/compose-sleep";
import { composeRecovery } from "@/lib/coach/plan-builder/compose-recovery";
import { composeCoachingAgreement } from "@/lib/coach/plan-builder/compose-coaching-agreement";
import { generatePlanNarrative } from "@/lib/coach/plan-builder/narrative-prompt";
import { todayInUserTz } from "@/lib/time";

export type BuildPlanResult = {
  plan_payload: PlanPayload;
  /** Sanity findings detected during build. Caller surfaces in chat Beat 1
   *  OR returns an error if findings exist and haven't been addressed
   *  (overridden or corrected). */
  sanity_findings: SanityFinding[];
};

export async function buildPlanPayload(
  supabase: SupabaseClient,
  userId: string,
  intake: IntakePayload,
): Promise<BuildPlanResult> {
  const today = todayInUserTz();

  // Parallel fetches
  const [profileRes, recentLogsRes, recentE1RMs, activeBlockRes] = await Promise.all([
    supabase
      .from("profiles")
      .select("name, age, height_cm")
      .eq("user_id", userId)
      .maybeSingle(),
    supabase
      .from("daily_logs")
      .select("date, weight_kg, calories_eaten")
      .eq("user_id", userId)
      .order("date", { ascending: false })
      .limit(30),
    fetchRecentE1RMs(supabase, userId),
    supabase
      .from("training_blocks")
      .select("primary_lift")
      .eq("user_id", userId)
      .eq("status", "active")
      .maybeSingle(),
  ]);

  if (profileRes.error) throw profileRes.error;
  if (recentLogsRes.error) throw recentLogsRes.error;
  if (activeBlockRes.error) throw activeBlockRes.error;

  const profile = profileRes.data as Pick<Profile, "name" | "age" | "height_cm"> | null;
  const recentLogs = recentLogsRes.data ?? [];
  const activeBlock = activeBlockRes.data as Pick<TrainingBlock, "primary_lift"> | null;

  // Latest bodyweight: first non-null weight_kg in the 30-day window
  const latestWeight = recentLogs.find((r) => r.weight_kg !== null)?.weight_kg ?? null;
  const currentBodyweight = latestWeight ?? null;

  // Rolling 7d kcal avg
  const last7 = recentLogs.slice(0, 7);
  const kcalSamples = last7
    .map((r) => r.calories_eaten)
    .filter((v): v is number => typeof v === "number" && v > 0);
  const rolling7dKcal =
    kcalSamples.length > 0
      ? kcalSamples.reduce((a, b) => a + b, 0) / kcalSamples.length
      : null;

  // Sanity checks
  const sanityFindings = runSanityChecks({
    intake,
    current_bodyweight_kg: currentBodyweight,
    rolling_7d_kcal: rolling7dKcal,
    today,
  });

  // Bodyweight needed for nutrition composer. If missing, estimate from intake.
  const bodyweightForComposers = currentBodyweight ?? 80;

  // Deterministic skeleton
  const athlete_snapshot = composeSnapshot(intake, profile);
  const goal = composeGoal(intake);
  const periodization = composePeriodization(intake);
  const strength = composeStrengthTemplate(intake, activeBlock, recentE1RMs);
  const nutrition = composeNutrition(intake, bodyweightForComposers);
  const sleep = composeSleep(intake);
  const recovery = composeRecovery(intake);
  const coaching_agreement = composeCoachingAgreement(intake);

  // AI narrative pass
  const narrative = await generatePlanNarrative({
    intake,
    skeleton: { goal, strength, nutrition, sleep, recovery, coaching_agreement },
  });

  const plan_payload: PlanPayload = {
    schema_version: 1,
    athlete_snapshot,
    goal: { ...goal, narrative_summary: narrative.goal_summary },
    periodization,
    strength: { ...strength, notes: narrative.strength_notes },
    nutrition: { ...nutrition, notes: narrative.nutrition_notes },
    sleep,
    recovery,
    coaching_agreement,
  };

  return { plan_payload, sanity_findings: sanityFindings };
}

/** Pull top working-set e1RM per primary lift over last 8 weeks. Reuses the
 *  pattern from lib/query/fetchers/recentE1RMs.ts. */
async function fetchRecentE1RMs(
  supabase: SupabaseClient,
  userId: string,
): Promise<RecentE1RMsForStrength> {
  const eightWeeksAgo = new Date();
  eightWeeksAgo.setUTCDate(eightWeeksAgo.getUTCDate() - 56);
  const since = eightWeeksAgo.toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from("workouts")
    .select("id, exercises (name, sets:exercise_sets (kg, reps, warmup))")
    .eq("user_id", userId)
    .gte("date", since);
  if (error) throw error;

  const regex: Record<keyof RecentE1RMsForStrength, RegExp> = {
    squat: /\b(back\s+squat|squat)\b/i,
    bench: /\b(bench\s+press|bench)\b/i,
    deadlift: /\b(deadlift|conventional\s+deadlift|sumo\s+deadlift)\b/i,
    ohp: /\b(overhead\s+press|ohp|military\s+press|strict\s+press)\b/i,
  };

  const out: RecentE1RMsForStrength = { squat: null, bench: null, deadlift: null, ohp: null };

  for (const w of data ?? []) {
    for (const e of (w as any).exercises ?? []) {
      const lift = (Object.entries(regex) as Array<[keyof RecentE1RMsForStrength, RegExp]>)
        .find(([_, re]) => re.test(e.name))?.[0];
      if (!lift) continue;
      for (const s of e.sets ?? []) {
        if (s.warmup) continue;
        if (s.kg === null || s.reps === null) continue;
        if (s.reps > 12) continue;
        const e1rm = Math.round(s.kg * (1 + s.reps / 30));
        if (out[lift] === null || e1rm > out[lift]!) out[lift] = e1rm;
      }
    }
  }

  return out;
}
```

- [ ] **Step 2: Run typecheck + commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
git add lib/coach/plan-builder/index.ts
git commit -m "feat(plan-builder): orchestrator buildPlanPayload

Single entry point: parallel data fetch → sanity checks → compose 8
sections (deterministic) → single Sonnet narrative call → return full
PlanPayload + sanity_findings.

Caller decides what to do with sanity_findings:
  - chat route: surface in Beat 1 if propose_plan was attempted without
    findings addressed
  - probe scripts: assert specific findings present

Bodyweight estimate fallback (80kg) when no daily_logs.weight_kg yet —
allows generation even for users without Withings sync.

Reuses recentE1RMs pattern from lib/query/fetchers/recentE1RMs.ts.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Narrative prompt (Sonnet) + probe

**Files:**
- Create: `lib/coach/plan-builder/narrative-prompt.ts`
- Test: `scripts/probe-narrative-prompt.mjs` (deleted after running)

- [ ] **Step 1: Create the narrative prompt module**

```ts
// lib/coach/plan-builder/narrative-prompt.ts
//
// Single Sonnet 4.6 call producing the three short narrative fields
// (goal_summary, strength_notes, nutrition_notes) that wrap the
// deterministic plan_payload skeleton. JSON output for clean parsing.
//
// Cost: ~$0.018 per call. Prompt caching enabled (system prompt is
// cacheable; varies only with intake + skeleton inputs).

import { callClaude } from "@/lib/anthropic/client";
import type { IntakePayload, PlanPayload } from "@/lib/data/types";

const MODEL = "claude-sonnet-4-6";
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
  let parsed: any;
  try {
    parsed = JSON.parse(s);
  } catch (e) {
    throw new Error(`Failed to parse narrative JSON: ${(e as Error).message}\nRaw: ${raw.slice(0, 200)}`);
  }
  if (
    typeof parsed.goal_summary !== "string" ||
    typeof parsed.strength_notes !== "string" ||
    typeof parsed.nutrition_notes !== "string"
  ) {
    throw new Error(`Narrative JSON missing required fields: ${JSON.stringify(parsed)}`);
  }
  return {
    goal_summary: parsed.goal_summary.trim(),
    strength_notes: parsed.strength_notes.trim(),
    nutrition_notes: parsed.nutrition_notes.trim(),
  };
}
```

- [ ] **Step 2: Create probe script (one Sonnet call, ~$0.018)**

```js
// scripts/probe-narrative-prompt.mjs
import "dotenv/config";
import { generatePlanNarrative } from "../lib/coach/plan-builder/narrative-prompt.ts";

const intake = {
  schema_version: 2,
  health: {
    conditions: { cardiac: false, hypertension: false, diabetes: "none",
                  autoimmune: false, joint_surgeries: [], other: "" },
    medications: "GLP-1 2.5mg once per week", recent_illness_injury: "",
    active_injuries: [], allergies: "",
  },
  training: {
    years_lifting: 5, training_age: "intermediate", sessions_per_week: 4,
    typical_session_minutes: 75,
    equipment: { barbell: true, rack: true, bench: true, dumbbells: true,
                 cables: true, machines: true, platform: true, ghd: true,
                 sled: true, treadmill: true, rower: true, bike: true,
                 kettlebells: true, bands: true, other: "" },
    current_e1rm: { squat: 93, bench: 84, deadlift: 102, ohp: 38 },
    best_ever_pr: { squat: 96, bench: null, deadlift: 110, ohp: null },
    previous_programs: "", recent_plateaus: "",
  },
  lifestyle: {
    job_demands: "mixed", commute_minutes: 0, has_dependents: false,
    dependent_notes: "", stress_self_rating: 3,
    days_available: { mon: true, tue: true, wed: true, thu: true,
                      fri: true, sat: false, sun: false },
    earliest_session_time: "06:00", latest_session_time: "21:00",
    travel_frequency: "rare",
  },
  nutrition: {
    current_phase: "cut", current_kcal: 2085,
    current_macros: { protein_g: 168, carb_g: 145, fat_g: 87 },
    tracking_experience: "consistent", restrictions: "",
    alcohol_drinks_per_week: 0, caffeine_mg_per_day: 200, supplements: "",
  },
  sleep_recovery: {
    avg_sleep_hours: 7, typical_bedtime: "22:30", typical_wake_time: "06:30",
    sleep_latency_minutes: 15, awakenings: "1_2",
    mobility_work: "", soreness_frequency: "common",
    chronotype: "neutral",
  },
  goals: {
    primary_type: "strength", primary_metric: "Deadlift e1RM",
    target_value: 115, target_unit: "kg", target_date: "2026-08-08",
    why_narrative: "Setting up for first powerlifting meet",
  },
  goal_narrative_chat:
    "I want to walk into the meet feeling like the strongest version of myself in years. The number isn't the point — the discipline to hit it is. After hitting 115, I want to test a real 1RM and chase 125 next block.",
  coaching_preferences: {
    directness: "balanced",
    cadence: "weekly",
    unprompted_actions: ["flag_macros", "flag_sleep"],
  },
};

const skeleton = {
  goal: {
    type: "strength",
    primary_metric: "Deadlift e1RM",
    target_value: 115,
    target_unit: "kg",
    target_date: "2026-08-08",
    narrative_summary: "",
    feasibility_note: null,
  },
  strength: {
    sessions_per_week: 4,
    day_pattern: { Monday: "Legs", Tuesday: "Chest", Wednesday: "Back", Thursday: "Mobility", Friday: "REST", Saturday: "REST", Sunday: "REST" },
    template_session_types: ["Legs", "Chest", "Back", "Mobility", "REST"],
    weekly_volume_targets: { deadlift: { reps_per_week: 70, sets_per_week: 14 } },
    progression_rule: "Add 2.5kg to primary lifts when last set ≥ target RIR + 2 reps for 2 consecutive sessions.",
    notes: null,
  },
  nutrition: {
    phase: "cut",
    kcal_target: 2085,
    kcal_range: [1981, 2189],
    protein_g_per_kg_bw: 1.6,
    protein_g: 166,
    carb_g: 178,
    fat_g: 79,
    training_day_uplift: { kcal: 150, carb_g: 35 },
    refeed_cadence_days: 6,
    refeed_uplift: { kcal: 500, carb_g: 100 },
    hard_rules: {
      alcohol_policy: "none",
      caffeine_cap_mg_per_day: 400,
      caffeine_last_dose_hours_before_bed: 8,
      tracking_tolerance_missed_days_per_week: 1,
    },
    notes: null,
  },
  sleep: {
    chronotype: "neutral",
    target_hours_min: 7.5,
    target_hours_max: 8.5,
    wake_target: "06:30",
    bedtime_target: "22:00",
    efficiency_target: 0.85,
    latency_target_min: 20,
    hygiene_rules: {
      caffeine_cutoff_hours_before_bed: 8,
      alcohol_cutoff_hours_before_bed: 3,
      last_meal_cutoff_hours_before_bed: 2,
      screen_cutoff_minutes_before_bed: 60,
      intense_exercise_cutoff_hours_before_bed: 3,
      morning_light_exposure_minutes: 10,
      weekend_consistency_within_minutes: 60,
    },
    concern_triggers: {
      avg_sleep_below_h: 6.5,
      efficiency_below: 0.8,
      latency_above_min: 30,
      consecutive_short_nights: 2,
    },
  },
  recovery: {
    mobility_minutes_per_week: 30,
    deload_triggers: ["HRV outside SWC band 2/4 days", "Sleep <6h on 2/4 nights", "e1RM drop ≥3% over 2 weeks"],
    reactivity_protocol: "If today's readiness < 33%: drop intensity 10%, keep volume. Don't skip the session.",
  },
  coaching_agreement: {
    cadence: "weekly",
    directness: "balanced",
    unprompted_actions_allowed: ["flag_macros", "flag_sleep"],
    re_evaluation_cadence_weeks: 8,
  },
};

console.log("=== Calling Sonnet 4.6 ===\n(Cost ~$0.018, ~3-5 seconds.)\n");
const narrative = await generatePlanNarrative({ intake, skeleton });

console.log("=== goal_summary ===");
console.log(narrative.goal_summary);
console.log("\n=== strength_notes ===");
console.log(narrative.strength_notes);
console.log("\n=== nutrition_notes ===");
console.log(narrative.nutrition_notes);

console.log("\n=== Verification checklist ===");
console.log("- goal_summary mentions target 115kg by Aug 8 + meet narrative: visual check");
console.log("- strength_notes references deadlift focus, 4 sessions/wk, progression: visual check");
console.log("- nutrition_notes mentions cut + GLP-1 hunger cue + protein floor + refeed: visual check");
console.log("- Coach voice, no exclamation points, no emoji: visual check");
console.log("- All three fields are 1-3 sentences max: visual check");
```

- [ ] **Step 3: Run probe**

```bash
cd "/Users/abdelouahedelbied/Health app"
npx tsx scripts/probe-narrative-prompt.mjs
```

(Or `.mts` + `--experimental-strip-types` if Node 25 / tsx hits the ESM loader bug.)

Expected: three narrative fields output, coach-voiced, within sentence limits, no fabricated numbers. Cost ~$0.018.

If the output isn't coach-voiced or fabricates numbers, iterate on the prompt (tone instructions, "DO NOT REPRODUCE NUMBERS" warning) before committing.

- [ ] **Step 4: Delete probe + commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
rm scripts/probe-narrative-prompt.mjs
npm run typecheck
git add lib/coach/plan-builder/narrative-prompt.ts
git commit -m "feat(plan-builder): narrative prompt — single Sonnet 4.6 call

generatePlanNarrative() produces goal_summary + strength_notes +
nutrition_notes as JSON. System prompt receives intake context (with
chat-deepened narrative if present) + deterministic skeleton + style
preferences (directness from intake.coaching_preferences).

Sonnet 4.6 with cacheSystem=true (system prompt is cacheable; only
intake/skeleton inputs vary). Max 600 tokens, temp 0.4. Cost ~\$0.018.

Conditional prompt rules:
  - GLP-1 in medications → emphasize protein floor + hunger reminders
  - Active injuries → modify-per-restriction guidance
  - Refeed cadence set → reference in nutrition_notes

JSON parsing: strips code fences, validates three required string fields,
trims whitespace.

Probe-tested against the live API with the test user's intake.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: Tools (11 new) — apply_*, set_*, propose_plan, commit_plan

**Files:**
- Modify: `lib/coach/tools.ts`

This is the largest single task. Eleven new tool schemas + executors. Follow the existing pattern in the file (each tool is a `{name, input_schema, ...}` object, executor is a separate async function).

- [ ] **Step 1: Read existing tools.ts to confirm pattern**

```bash
cd "/Users/abdelouahedelbied/Health app"
grep -nE "^export const \w+_TOOL|^async function exec_\w+|^export async function exec\w+" lib/coach/tools.ts | head -30
```

Existing tools follow a `<NAME>_TOOL` const + paired `exec_<name>` async function pattern. Mirror that for the 11 new tools.

- [ ] **Step 2: Add the 11 tool schemas to `lib/coach/tools.ts`**

Append after the existing tool definitions:

```ts
// ────────────────────────────────────────────────────────────────────────────
// Phase 2 — coaching plan intake tools
// ────────────────────────────────────────────────────────────────────────────

// ── Beat 1: Sanity correction tools (no HMAC — single-field writes) ─────────

export const APPLY_GOAL_TARGET_TOOL = {
  name: "apply_goal_target",
  description:
    "Beat 1 sanity-correction tool. Apply a corrected goal target (from the goal_contradiction finding's proposed_target) to intake_payload.goals. Use when user taps 'Use proposed target' chip.",
  input_schema: {
    type: "object",
    properties: {
      target_value: { type: "number" },
      target_unit: { type: "string" },
      rationale: {
        type: "string",
        description: "Brief rationale (1 sentence) appended to goals.why_narrative as audit trail.",
      },
    },
    required: ["target_value", "target_unit", "rationale"],
  },
} as const;

export const APPLY_BEDTIME_CORRECTION_TOOL = {
  name: "apply_bedtime_correction",
  description:
    "Beat 1 sanity-correction tool. Apply a corrected typical_bedtime (from the sleep_efficiency finding's proposed_bedtime) to intake_payload.sleep_recovery.",
  input_schema: {
    type: "object",
    properties: {
      typical_bedtime: { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" },
    },
    required: ["typical_bedtime"],
  },
} as const;

export const APPLY_MACROS_CORRECTION_TOOL = {
  name: "apply_macros_correction",
  description:
    "Beat 1 sanity-correction tool. Apply corrected macros (from the macros_gap finding) to intake_payload.nutrition. Either 'match actual' (uses rolling 7d kcal) or 'hit target' (keeps stated values).",
  input_schema: {
    type: "object",
    properties: {
      kcal: { type: "number" },
      protein_g: { type: "number" },
      carb_g: { type: "number" },
      fat_g: { type: "number" },
    },
    required: ["kcal", "protein_g", "carb_g", "fat_g"],
  },
} as const;

export const APPLY_PROTEIN_CORRECTION_TOOL = {
  name: "apply_protein_correction",
  description:
    "Beat 1 sanity-correction tool. Apply corrected protein + fat (from protein_floor finding) to intake_payload.nutrition.current_macros. Keeps kcal stable.",
  input_schema: {
    type: "object",
    properties: {
      protein_g: { type: "number" },
      fat_g: { type: "number" },
    },
    required: ["protein_g", "fat_g"],
  },
} as const;

export const SET_SANITY_OVERRIDE_TOOL = {
  name: "set_sanity_override",
  description:
    "Beat 1 sanity-correction tool. User chose to override (not apply) a finding. Writes the matching flag to intake_payload.sanity_overrides.",
  input_schema: {
    type: "object",
    properties: {
      key: {
        type: "string",
        enum: [
          "goal_kept_despite_low_target",
          "sleep_efficiency_acknowledged",
          "macros_gap_acknowledged",
          "protein_floor_acknowledged",
        ],
      },
    },
    required: ["key"],
  },
} as const;

// ── Beats 2-5: Slot setters (no HMAC — single-field writes) ─────────────────

export const SET_GOAL_NARRATIVE_CHAT_TOOL = {
  name: "set_goal_narrative_chat",
  description:
    "Beat 2 slot setter. Write the chat-deepened goal narrative (3-5 sentences synthesizing form why_narrative + chat answers) to intake_payload.goal_narrative_chat.",
  input_schema: {
    type: "object",
    properties: { text: { type: "string", minLength: 20 } },
    required: ["text"],
  },
} as const;

export const SET_DIRECTNESS_TOOL = {
  name: "set_directness",
  description:
    "Beat 4 slot setter. Write coach directness preference to intake_payload.coaching_preferences.directness.",
  input_schema: {
    type: "object",
    properties: { value: { type: "string", enum: ["blunt", "balanced", "softer"] } },
    required: ["value"],
  },
} as const;

export const SET_CADENCE_TOOL = {
  name: "set_cadence",
  description:
    "Beat 4 slot setter. Write check-in cadence preference to intake_payload.coaching_preferences.cadence.",
  input_schema: {
    type: "object",
    properties: { value: { type: "string", enum: ["daily", "weekly", "on_demand"] } },
    required: ["value"],
  },
} as const;

export const SET_CHRONOTYPE_TOOL = {
  name: "set_chronotype",
  description:
    "Beat 4 slot setter. Write chronotype (lark/neutral/owl) to intake_payload.sleep_recovery.chronotype.",
  input_schema: {
    type: "object",
    properties: { value: { type: "string", enum: ["lark", "neutral", "owl"] } },
    required: ["value"],
  },
} as const;

export const SET_UNPROMPTED_ACTIONS_TOOL = {
  name: "set_unprompted_actions",
  description:
    "Beat 4 slot setter. Write allowed unprompted coach actions to intake_payload.coaching_preferences.unprompted_actions.",
  input_schema: {
    type: "object",
    properties: {
      actions: {
        type: "array",
        items: {
          type: "string",
          enum: ["suggest_revisions", "nudge_on_drift", "flag_macros", "flag_sleep"],
        },
      },
    },
    required: ["actions"],
  },
} as const;

export const SET_FREE_FORM_CONSTRAINTS_TOOL = {
  name: "set_free_form_constraints",
  description:
    "Beat 3 or Beat 5 slot setter. Write or append to intake_payload.free_form_constraints. Use mode='append' to add after existing text; 'replace' to overwrite.",
  input_schema: {
    type: "object",
    properties: {
      text: { type: "string", minLength: 1 },
      mode: { type: "string", enum: ["append", "replace"] },
    },
    required: ["text", "mode"],
  },
} as const;

// ── End-of-intake — HMAC-gated ──────────────────────────────────────────────

export const PROPOSE_PLAN_TOOL = {
  name: "propose_plan",
  description:
    "Terminal-of-intake tool. Server runs plan-builder from current intake_payload state. Validates all sanity findings have been addressed (each has apply_* OR sanity_override). On success: writes plan_payload + rendered_md to the draft athlete_profile_documents row and returns an HMAC approval_token. On unresolved sanity findings: returns error listing the unaddressed findings.",
  input_schema: { type: "object", properties: {}, required: [] },
} as const;

export const COMMIT_PLAN_TOOL = {
  name: "commit_plan",
  description:
    "Atomic acknowledge tool. Verifies HMAC token from propose_plan. Flips draft athlete_profile_documents row to active; supersedes any prior active row. revalidatePath /profile, /coach, /onboarding.",
  input_schema: {
    type: "object",
    properties: { token: { type: "string", minLength: 32 } },
    required: ["token"],
  },
} as const;
```

- [ ] **Step 3: Add executor functions**

Below the tool schemas in `lib/coach/tools.ts`, append the 11 executors. Each writes to `athlete_profile_documents` (the user's draft row) using the service-role client passed by the route handler:

```ts
// ── Executors for Phase 2 tools ─────────────────────────────────────────────

import type { IntakePayload, PlanPayload } from "@/lib/data/types";
import { buildPlanPayload } from "@/lib/coach/plan-builder";
import { renderProfileMarkdown } from "@/lib/coach/profile-renderer";

type ToolCtx = {
  supabase: SupabaseClient;
  userId: string;
  /** The draft athlete_profile_documents row id this intake chat is bound to.
   *  Resolved from the chat session's URL param ?doc=<id> by the route. */
  draftDocId: string;
};

/** Helper: load current draft's intake_payload, modify, write back. */
async function patchIntake(
  ctx: ToolCtx,
  patcher: (intake: IntakePayload) => IntakePayload,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data, error } = await ctx.supabase
    .from("athlete_profile_documents")
    .select("intake_payload")
    .eq("id", ctx.draftDocId)
    .eq("user_id", ctx.userId)
    .eq("status", "draft")
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "draft not found" };
  const current = data.intake_payload as IntakePayload;
  const next = patcher(current);
  const { error: updErr } = await ctx.supabase
    .from("athlete_profile_documents")
    .update({ intake_payload: next, updated_at: new Date().toISOString() })
    .eq("id", ctx.draftDocId)
    .eq("user_id", ctx.userId)
    .eq("status", "draft");
  if (updErr) return { ok: false, error: updErr.message };
  return { ok: true };
}

export async function exec_apply_goal_target(
  ctx: ToolCtx,
  input: { target_value: number; target_unit: string; rationale: string },
) {
  return patchIntake(ctx, (intake) => ({
    ...intake,
    goals: {
      ...intake.goals,
      target_value: input.target_value,
      target_unit: input.target_unit,
      why_narrative: `${intake.goals.why_narrative}\n\n[Updated target during intake: ${input.rationale}]`,
    },
  }));
}

export async function exec_apply_bedtime_correction(
  ctx: ToolCtx,
  input: { typical_bedtime: string },
) {
  return patchIntake(ctx, (intake) => ({
    ...intake,
    sleep_recovery: { ...intake.sleep_recovery, typical_bedtime: input.typical_bedtime },
  }));
}

export async function exec_apply_macros_correction(
  ctx: ToolCtx,
  input: { kcal: number; protein_g: number; carb_g: number; fat_g: number },
) {
  return patchIntake(ctx, (intake) => ({
    ...intake,
    nutrition: {
      ...intake.nutrition,
      current_kcal: input.kcal,
      current_macros: { protein_g: input.protein_g, carb_g: input.carb_g, fat_g: input.fat_g },
    },
  }));
}

export async function exec_apply_protein_correction(
  ctx: ToolCtx,
  input: { protein_g: number; fat_g: number },
) {
  return patchIntake(ctx, (intake) => ({
    ...intake,
    nutrition: {
      ...intake.nutrition,
      current_macros: {
        ...intake.nutrition.current_macros,
        protein_g: input.protein_g,
        fat_g: input.fat_g,
      },
    },
  }));
}

export async function exec_set_sanity_override(
  ctx: ToolCtx,
  input: {
    key:
      | "goal_kept_despite_low_target"
      | "sleep_efficiency_acknowledged"
      | "macros_gap_acknowledged"
      | "protein_floor_acknowledged";
  },
) {
  return patchIntake(ctx, (intake) => ({
    ...intake,
    sanity_overrides: { ...(intake.sanity_overrides ?? {}), [input.key]: true },
  }));
}

export async function exec_set_goal_narrative_chat(ctx: ToolCtx, input: { text: string }) {
  return patchIntake(ctx, (intake) => ({ ...intake, goal_narrative_chat: input.text }));
}

export async function exec_set_directness(
  ctx: ToolCtx,
  input: { value: "blunt" | "balanced" | "softer" },
) {
  return patchIntake(ctx, (intake) => ({
    ...intake,
    coaching_preferences: {
      directness: input.value,
      cadence: intake.coaching_preferences?.cadence ?? "weekly",
      unprompted_actions: intake.coaching_preferences?.unprompted_actions ?? [],
    },
  }));
}

export async function exec_set_cadence(
  ctx: ToolCtx,
  input: { value: "daily" | "weekly" | "on_demand" },
) {
  return patchIntake(ctx, (intake) => ({
    ...intake,
    coaching_preferences: {
      directness: intake.coaching_preferences?.directness ?? "balanced",
      cadence: input.value,
      unprompted_actions: intake.coaching_preferences?.unprompted_actions ?? [],
    },
  }));
}

export async function exec_set_chronotype(
  ctx: ToolCtx,
  input: { value: "lark" | "neutral" | "owl" },
) {
  return patchIntake(ctx, (intake) => ({
    ...intake,
    sleep_recovery: { ...intake.sleep_recovery, chronotype: input.value },
  }));
}

export async function exec_set_unprompted_actions(
  ctx: ToolCtx,
  input: {
    actions: Array<"suggest_revisions" | "nudge_on_drift" | "flag_macros" | "flag_sleep">;
  },
) {
  return patchIntake(ctx, (intake) => ({
    ...intake,
    coaching_preferences: {
      directness: intake.coaching_preferences?.directness ?? "balanced",
      cadence: intake.coaching_preferences?.cadence ?? "weekly",
      unprompted_actions: input.actions,
    },
  }));
}

export async function exec_set_free_form_constraints(
  ctx: ToolCtx,
  input: { text: string; mode: "append" | "replace" },
) {
  return patchIntake(ctx, (intake) => ({
    ...intake,
    free_form_constraints:
      input.mode === "replace"
        ? input.text
        : `${intake.free_form_constraints ?? ""}${intake.free_form_constraints ? "\n\n" : ""}${input.text}`,
  }));
}

// ── propose_plan + commit_plan (HMAC-gated) ────────────────────────────────

export async function exec_propose_plan(
  ctx: ToolCtx,
): Promise<
  | { ok: true; approval_token: string; plan_payload: PlanPayload }
  | { ok: false; error: string; sanity_findings_unaddressed?: string[] }
> {
  // Load current intake from draft row
  const { data: draft, error: loadErr } = await ctx.supabase
    .from("athlete_profile_documents")
    .select("intake_payload, version")
    .eq("id", ctx.draftDocId)
    .eq("user_id", ctx.userId)
    .eq("status", "draft")
    .maybeSingle();
  if (loadErr) return { ok: false, error: loadErr.message };
  if (!draft) return { ok: false, error: "draft not found" };

  const intake = draft.intake_payload as IntakePayload;

  // Build plan + check sanity status
  const { plan_payload, sanity_findings } = await buildPlanPayload(
    ctx.supabase,
    ctx.userId,
    intake,
  );

  // Validate all sanity findings are addressed (either corrected via apply_*
  // which clears the finding via subsequent runSanityChecks, OR overridden).
  // runSanityChecks already skips findings whose override flag is true, so any
  // remaining findings are unaddressed.
  if (sanity_findings.length > 0) {
    return {
      ok: false,
      error: "sanity_findings_unaddressed",
      sanity_findings_unaddressed: sanity_findings.map((f) => f.type),
    };
  }

  // Persist plan_payload + render markdown
  const renderedMd = renderProfileMarkdown({
    intake,
    plan: plan_payload,
    version: draft.version,
    acknowledgedAt: null,
  });

  const { error: updErr } = await ctx.supabase
    .from("athlete_profile_documents")
    .update({
      plan_payload,
      rendered_md: renderedMd,
      updated_at: new Date().toISOString(),
    })
    .eq("id", ctx.draftDocId)
    .eq("user_id", ctx.userId)
    .eq("status", "draft");
  if (updErr) return { ok: false, error: updErr.message };

  const token = signApprovalToken({
    userId: ctx.userId,
    action: "plan",
    payload: { doc_id: ctx.draftDocId, plan_payload },
  });

  return { ok: true, approval_token: token, plan_payload };
}

export async function exec_commit_plan(
  ctx: ToolCtx,
  input: { token: string },
): Promise<{ ok: true; doc_id: string } | { ok: false; error: string }> {
  // Load draft to recompute payload hash
  const { data: draft } = await ctx.supabase
    .from("athlete_profile_documents")
    .select("plan_payload")
    .eq("id", ctx.draftDocId)
    .eq("user_id", ctx.userId)
    .eq("status", "draft")
    .maybeSingle();
  if (!draft) return { ok: false, error: "draft not found" };

  try {
    verifyApprovalToken({
      token: input.token,
      userId: ctx.userId,
      action: "plan",
      payload: { doc_id: ctx.draftDocId, plan_payload: draft.plan_payload },
    });
  } catch (e) {
    return { ok: false, error: `token invalid: ${(e as Error).message}` };
  }

  // Atomic transition: flip draft → active, supersede prior active
  const { data: priorActive } = await ctx.supabase
    .from("athlete_profile_documents")
    .select("id")
    .eq("user_id", ctx.userId)
    .eq("status", "active")
    .maybeSingle();

  const now = new Date().toISOString();
  if (priorActive) {
    await ctx.supabase
      .from("athlete_profile_documents")
      .update({ status: "superseded", superseded_at: now, superseded_by: ctx.draftDocId })
      .eq("id", priorActive.id)
      .eq("user_id", ctx.userId);
  }

  const { error: ackErr } = await ctx.supabase
    .from("athlete_profile_documents")
    .update({ status: "active", acknowledged_at: now })
    .eq("id", ctx.draftDocId)
    .eq("user_id", ctx.userId)
    .eq("status", "draft");
  if (ackErr) return { ok: false, error: ackErr.message };

  return { ok: true, doc_id: ctx.draftDocId };
}
```

- [ ] **Step 4: Register tools in the tool dispatcher**

In `lib/coach/tools.ts`, find the existing tool dispatcher / executor map (likely a switch statement or object mapping `tool.name` to executor functions). Add cases for the 11 new tools. Each maps `tool.name` to its `exec_<name>` function.

The exact location and shape depends on existing code structure. Search:

```bash
cd "/Users/abdelouahedelbied/Health app"
grep -nE "case \"propose_block\"|case \"commit_week_plan\"|tool\.name ===" lib/coach/tools.ts | head -10
```

Mirror the existing pattern.

- [ ] **Step 5: Run typecheck + commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
git add lib/coach/tools.ts
git commit -m "feat(tools): phase 2 — 11 new tools (sanity-correctors, slot setters, propose/commit)

Five Beat 1 sanity-correction tools (no HMAC, write to intake_payload):
  - apply_goal_target: updates goals.target_value + audit trail in why_narrative
  - apply_bedtime_correction: updates sleep_recovery.typical_bedtime
  - apply_macros_correction: updates nutrition.current_kcal + current_macros
  - apply_protein_correction: updates protein_g + fat_g keeping kcal stable
  - set_sanity_override: writes one of 4 override flags

Six Beats 2-5 slot setters (no HMAC, write to intake_payload):
  - set_goal_narrative_chat (Beat 2)
  - set_directness, set_cadence, set_chronotype, set_unprompted_actions (Beat 4)
  - set_free_form_constraints with append/replace mode (Beats 3 & 5)

Two HMAC-gated tools at end of intake:
  - propose_plan: runs plan-builder, validates sanity findings addressed,
    writes plan_payload + rendered_md to draft, returns approval_token
  - commit_plan: verifies token, atomic flip draft → active +
    supersede prior active

All executors scope writes to (id, user_id, status='draft') triple to
prevent cross-user or already-acknowledged corruption. patchIntake helper
abstracts the load-modify-write cycle.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: INTAKE_PROMPT + planning-prompts.ts extension

**Files:**
- Modify: `lib/coach/planning-prompts.ts`

- [ ] **Step 1: Add INTAKE_PROMPT constant**

Append to `lib/coach/planning-prompts.ts` after the existing `SETUP_BLOCK_PROMPT`:

```ts
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
  Turn 2: "Check-in cadence?" [daily / weekly / on-demand]
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
```

- [ ] **Step 2: Extend `buildSystemPrompt` to handle `mode='intake'`**

In the same file, find the existing `buildSystemPrompt` function. Find the existing chain that handles `plan_week` and `setup_block`. Add a new branch for `intake`:

```ts
  } else if (args.mode === "setup_block") {
    sections.push(SETUP_BLOCK_PROMPT);
  } else if (args.mode === "intake") {
    const intakeCtx = await fetchIntakeContext(args.supabase, args.userId);
    if (intakeCtx) {
      sections.push(INTAKE_PROMPT);
      sections.push(intakeCtx);
    }
  }
```

Add the `fetchIntakeContext` helper at the bottom of the file:

```ts
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

  const intake = draft.intake_payload;

  // Pull supporting data for sanity checks
  const today = todayInUserTz();
  const eightDaysAgo = new Date();
  eightDaysAgo.setUTCDate(eightDaysAgo.getUTCDate() - 8);
  const sinceDate = eightDaysAgo.toISOString().slice(0, 10);

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
      : findings.map((f, i) => `Finding ${i + 1}: ${f.type}\n  Rationale: ${f.rationale}`).join("\n\n");

  return [
    `## Active intake draft context\n`,
    `Draft id: ${draft.id}, version: ${draft.version}\n`,
    `Goal: ${intake.goals.primary_metric} → ${intake.goals.target_value}${intake.goals.target_unit} by ${intake.goals.target_date}`,
    `Phase: ${intake.nutrition.current_phase}`,
    `Days available: ${Object.entries(intake.lifestyle.days_available).filter(([_, v]) => v).map(([k]) => k).join(", ")}`,
    `Sessions/wk: ${intake.training.sessions_per_week}`,
    ``,
    `### sanity_findings`,
    findingsBlock,
  ].join("\n");
}
```

- [ ] **Step 3: Register the new tools as available in `intake` mode**

The route handler (Task 15) registers which tools are exposed to Anthropic per mode. Mention in the prompt that the available tools are: `apply_*` (5), `set_*` (6), `propose_plan`, `commit_plan`. The actual registration is in Task 15.

- [ ] **Step 4: Run typecheck + commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
git add lib/coach/planning-prompts.ts
git commit -m "feat(planning-prompts): INTAKE_PROMPT + mode='intake' branch in buildSystemPrompt

5-beat structured prompt:
  Beat 1: sanity check — for each finding in {sanity_findings}, surface
    one turn with chips; apply_* on accept, set_sanity_override on override
  Beat 2: deepen goal narrative — 1-2 probes → set_goal_narrative_chat
  Beat 3: deepen medical/restrictions — GLP-1 / injury follow-ups
    → set_free_form_constraints
  Beat 4: elicit coaching style + chronotype — 4 chip turns
    (directness, cadence, chronotype, unprompted_actions)
  Beat 5: catch-any → set_free_form_constraints
  Then propose_plan, then commit_plan on user approval

fetchIntakeContext helper loads draft + latest bodyweight + rolling 7d
kcal, runs sanity checks, renders findings into the system prompt
context block. Findings list refreshes between turns (each propose_plan
call re-runs sanity checks).

Tone branches on intake.coaching_preferences.directness once Beat 4 sets it.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: Profile renderer extension (full plan markdown)

**Files:**
- Modify: `lib/coach/profile-renderer.ts`

- [ ] **Step 1: Refactor renderProfileMarkdown signature**

The existing `renderProfileMarkdown` signature (from Phase 1) takes `intake_payload` and produces intake-only markdown. Extend to optionally accept a `plan_payload`. When provided, append the 8 plan sections to the rendered doc.

Change the function signature to:

```ts
export function renderProfileMarkdown(args: {
  intake: IntakePayload;
  plan?: PlanPayload | null;
  version: number;
  acknowledgedAt: string | null;
}): string {
  // ... existing intake rendering unchanged ...
  let md = renderIntakeSections(args.intake, args.version, args.acknowledgedAt);
  if (args.plan) {
    md += "\n\n---\n\n# Coaching plan\n\n";
    md += renderPlanSections(args.plan);
  }
  return md;
}
```

Existing callers (Phase 1 acknowledge action) currently call with positional args. Update them to use the new object-arg signature, passing `plan: null` for Phase 1 path (Phase 2 callers pass the populated plan).

- [ ] **Step 2: Add renderPlanSections helper**

Append to `lib/coach/profile-renderer.ts`:

```ts
function renderPlanSections(plan: PlanPayload): string {
  const sections = [
    renderGoalSection(plan.goal),
    renderPeriodizationSection(plan.periodization),
    renderStrengthSection(plan.strength),
    renderNutritionSection(plan.nutrition),
    renderSleepSection(plan.sleep),
    renderRecoverySection(plan.recovery),
    renderCoachingAgreementSection(plan.coaching_agreement),
  ];
  return sections.join("\n\n");
}

function renderGoalSection(goal: PlanPayload["goal"]): string {
  const feasibility = goal.feasibility_note ? `\n\n> ${goal.feasibility_note}` : "";
  return [
    "## Goal",
    "",
    `**${goal.primary_metric}** → **${goal.target_value}${goal.target_unit}** by ${goal.target_date}`,
    "",
    goal.narrative_summary,
    feasibility,
  ].join("\n");
}

function renderPeriodizationSection(p: PlanPayload["periodization"]): string {
  const rir = p.rir_arc
    .map((r) => `W${r.week}: ${r.rir === null ? "deload" : `RIR ${r.rir}`}`)
    .join(", ");
  return [
    "## Periodization",
    "",
    `**${p.block_length_weeks}-week blocks** ending in deload. ~${p.blocks_to_goal_date} blocks to goal date.`,
    `Rotation: ${p.rotation_rule.replace("_", " ")}`,
    `RIR arc: ${rir}`,
  ].join("\n");
}

function renderStrengthSection(s: PlanPayload["strength"]): string {
  const days = Object.entries(s.day_pattern)
    .filter(([_, v]) => v !== "REST")
    .map(([day, type]) => `- ${day}: ${type}`)
    .join("\n");
  const volume = Object.entries(s.weekly_volume_targets)
    .map(([lift, t]) => `- ${lift}: ${t.reps_per_week} reps/wk, ${t.sets_per_week} sets/wk`)
    .join("\n");
  return [
    "## Strength (template)",
    "",
    `**${s.sessions_per_week} sessions/wk**`,
    "",
    days,
    "",
    "**Weekly volume targets:**",
    volume,
    "",
    `**Progression:** ${s.progression_rule}`,
    s.notes ? `\n${s.notes}` : "",
  ].join("\n");
}

function renderNutritionSection(n: PlanPayload["nutrition"]): string {
  const refeed = n.refeed_cadence_days
    ? `\n**Refeed every ${n.refeed_cadence_days} days:** +${n.refeed_uplift?.kcal} kcal, +${n.refeed_uplift?.carb_g}g carbs`
    : "";
  const uplift = n.training_day_uplift
    ? `\n**Training day uplift:** +${n.training_day_uplift.kcal} kcal, +${n.training_day_uplift.carb_g}g carbs`
    : "";
  return [
    "## Nutrition",
    "",
    `**Phase:** ${n.phase}`,
    `**Calories:** ${n.kcal_target} kcal (range ${n.kcal_range[0]}-${n.kcal_range[1]})`,
    `**Protein:** ${n.protein_g}g (${n.protein_g_per_kg_bw} g/kg BW)`,
    `**Carbs:** ${n.carb_g}g · **Fat:** ${n.fat_g}g`,
    `**Alcohol:** ${n.hard_rules.alcohol_policy.replace(/_/g, " ")}`,
    `**Caffeine:** cap ${n.hard_rules.caffeine_cap_mg_per_day} mg/day, last dose ${n.hard_rules.caffeine_last_dose_hours_before_bed}h before bed`,
    refeed,
    uplift,
    n.notes ? `\n${n.notes}` : "",
  ].join("\n");
}

function renderSleepSection(sl: PlanPayload["sleep"]): string {
  const h = sl.hygiene_rules;
  return [
    "## Sleep",
    "",
    `**Target:** ${sl.target_hours_min}-${sl.target_hours_max}h (chronotype: ${sl.chronotype})`,
    `**Schedule:** wake ${sl.wake_target} → bed ${sl.bedtime_target}`,
    `**Efficiency target:** ${(sl.efficiency_target * 100).toFixed(0)}% · **latency:** <${sl.latency_target_min} min`,
    "",
    "**Hygiene rules:**",
    `- Caffeine cutoff: ${h.caffeine_cutoff_hours_before_bed}h before bed`,
    `- Alcohol cutoff: ${h.alcohol_cutoff_hours_before_bed}h before bed`,
    `- Last meal: ${h.last_meal_cutoff_hours_before_bed}h before bed`,
    `- Screens: stop ${h.screen_cutoff_minutes_before_bed} min before bed`,
    `- Morning light: ${h.morning_light_exposure_minutes} min within 30 min of waking`,
    `- Weekend bed/wake within ${h.weekend_consistency_within_minutes} min of weekday`,
  ].join("\n");
}

function renderRecoverySection(r: PlanPayload["recovery"]): string {
  return [
    "## Recovery",
    "",
    `**Mobility:** ${r.mobility_minutes_per_week} min/wk`,
    "",
    "**Deload triggers:**",
    ...r.deload_triggers.map((t) => `- ${t}`),
    "",
    `**Reactivity:** ${r.reactivity_protocol}`,
  ].join("\n");
}

function renderCoachingAgreementSection(c: PlanPayload["coaching_agreement"]): string {
  const unprompted = c.unprompted_actions_allowed.length === 0
    ? "(none)"
    : c.unprompted_actions_allowed.join(", ");
  return [
    "## Coaching agreement",
    "",
    `**Cadence:** ${c.cadence}`,
    `**Directness:** ${c.directness}`,
    `**Unprompted actions allowed:** ${unprompted}`,
    `**Re-evaluation:** every ${c.re_evaluation_cadence_weeks} weeks`,
  ].join("\n");
}
```

- [ ] **Step 3: Update callers**

Find existing callers of `renderProfileMarkdown` (likely in `app/onboarding/actions.ts` Phase 1 acknowledge action) and update them to the new object-arg signature.

```bash
cd "/Users/abdelouahedelbied/Health app"
grep -rn "renderProfileMarkdown(" app/ lib/ components/ 2>/dev/null
```

For Phase 1 callers (those passing only intake), wrap as:
```ts
renderProfileMarkdown({ intake, plan: null, version, acknowledgedAt })
```

- [ ] **Step 4: Run typecheck + commit**

```bash
cd "/Users/abdelouahedelbean/Health app"
npm run typecheck
git add lib/coach/profile-renderer.ts app/onboarding/actions.ts 2>/dev/null
git commit -m "feat(profile-renderer): extend with plan sections for v2+ docs

renderProfileMarkdown signature switches to object-arg: { intake,
plan?, version, acknowledgedAt }. When plan is null/absent: renders
Phase 1 intake-only markdown (backwards compatible). When populated:
appends 8 plan sections (Goal, Periodization, Strength, Nutrition,
Sleep, Recovery, Coaching agreement) after a horizontal rule.

Phase 1 callers updated to pass plan: null.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 15: Chat API mode resolution

**Files:**
- Modify: `app/api/chat/messages/route.ts`

- [ ] **Step 1: Accept `mode='intake'` and register tools per mode**

Find the existing mode-resolution logic in `app/api/chat/messages/route.ts`. Currently handles `default | plan_week | setup_block`. Extend to accept `intake`.

Also: when mode is `intake`, register the 13 Phase 2 tools (11 new + 2 existing query tools that may help: `query_daily_logs` and `query_workouts` for the AI to reference user data during chat).

Look for the tool list assembly (likely a switch on `mode` returning an array of tool schemas):

```bash
cd "/Users/abdelouahedelbied/Health app"
grep -nE "mode === |plan_week|setup_block|tool_choice" app/api/chat/messages/route.ts | head -10
```

Add the case:

```ts
case "intake":
  return [
    APPLY_GOAL_TARGET_TOOL,
    APPLY_BEDTIME_CORRECTION_TOOL,
    APPLY_MACROS_CORRECTION_TOOL,
    APPLY_PROTEIN_CORRECTION_TOOL,
    SET_SANITY_OVERRIDE_TOOL,
    SET_GOAL_NARRATIVE_CHAT_TOOL,
    SET_DIRECTNESS_TOOL,
    SET_CADENCE_TOOL,
    SET_CHRONOTYPE_TOOL,
    SET_UNPROMPTED_ACTIONS_TOOL,
    SET_FREE_FORM_CONSTRAINTS_TOOL,
    PROPOSE_PLAN_TOOL,
    COMMIT_PLAN_TOOL,
  ];
```

For the executor dispatch:

```ts
case "apply_goal_target":
  return exec_apply_goal_target(ctx, input);
case "apply_bedtime_correction":
  return exec_apply_bedtime_correction(ctx, input);
case "apply_macros_correction":
  return exec_apply_macros_correction(ctx, input);
case "apply_protein_correction":
  return exec_apply_protein_correction(ctx, input);
case "set_sanity_override":
  return exec_set_sanity_override(ctx, input);
case "set_goal_narrative_chat":
  return exec_set_goal_narrative_chat(ctx, input);
case "set_directness":
  return exec_set_directness(ctx, input);
case "set_cadence":
  return exec_set_cadence(ctx, input);
case "set_chronotype":
  return exec_set_chronotype(ctx, input);
case "set_unprompted_actions":
  return exec_set_unprompted_actions(ctx, input);
case "set_free_form_constraints":
  return exec_set_free_form_constraints(ctx, input);
case "propose_plan":
  return exec_propose_plan(ctx);
case "commit_plan":
  return exec_commit_plan(ctx, input);
```

- [ ] **Step 2: Resolve `draftDocId` from URL param**

The intake chat URL is `/coach?mode=intake&doc=<id>`. Parse the `doc` query param and inject it into the `ctx: ToolCtx` for the executors:

```ts
const docParam = req.nextUrl?.searchParams.get("doc")
  ?? new URL(req.url).searchParams.get("doc");
const ctx: ToolCtx = {
  supabase: serviceRoleClient,
  userId: user.id,
  draftDocId: docParam ?? "",  // empty string makes intake-only mode useful — exec_propose_plan etc. will reject "draft not found"
};
```

(Adapt to the existing route's request shape — `req.nextUrl` is a NextRequest convenience; raw `req.url` works for both.)

- [ ] **Step 3: Persist `mode='intake'` on the message row**

When inserting the user's message and the assistant's reply into `chat_messages`, write `mode='intake'` per the existing pattern for plan_week / setup_block.

- [ ] **Step 4: Run typecheck + commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
git add app/api/chat/messages/route.ts
git commit -m "feat(api): chat route accepts mode='intake' + Phase 2 tool dispatch

Mode resolution extends from default | plan_week | setup_block to include
'intake'. Tools registered for intake mode: 11 new (apply_*, set_*,
propose_plan, commit_plan) + 2 existing read tools (query_daily_logs,
query_workouts) for AI to reference user data during the chat.

draftDocId pulled from URL ?doc=<id> param and injected into ToolCtx
so executors can scope all writes to (id, user_id, status='draft').

chat_messages.mode='intake' written for both user and assistant turns
to support resuming the conversation mid-flow.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 16: ChatPanel chip routing + PlanProposalCard render branch

**Files:**
- Modify: `components/chat/ChatPanel.tsx`
- Modify: `components/chat/ChatThread.tsx` (render branch)

- [ ] **Step 1: Add chip action types for Phase 2**

In `components/chat/ChatPanel.tsx` (or wherever chip actions are dispatched), add cases for the new Phase 2 chip actions:

```ts
// Mirroring the morning brief retry_brief pattern from PR #41

async function onChipAction(action: string, payload: unknown) {
  switch (action) {
    // ... existing cases (retry_brief, etc.) ...

    case "apply_goal_target":
    case "apply_bedtime_correction":
    case "apply_macros_correction":
    case "apply_protein_correction":
    case "set_sanity_override":
    case "set_directness":
    case "set_cadence":
    case "set_chronotype":
    case "set_unprompted_actions": {
      // POST chip action as a tool_use to the chat API — the route handler
      // will recognize this came from a chip tap (not from the AI) and execute
      // the matching tool, then prompt the AI for the next coach turn.
      const res = await fetch("/api/chat/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "intake",
          doc: draftDocId,
          chip_action: action,
          chip_payload: payload,
        }),
      });
      if (!res.ok) {
        dispatch({ type: "show_error", error: "Failed to apply correction" });
        return;
      }
      const { messages } = await res.json();
      for (const m of messages) dispatch({ type: "add_message", message: m });
      return;
    }

    case "accept_plan_proposal": {
      // Sends [approve:<token>] as a user message — AI route picks up
      // commit_plan(token) when it sees the literal.
      const token = (payload as { token: string }).token;
      const text = `[approve:${token}]`;
      await sendMessage({ text, mode: "intake" });
      return;
    }

    // ... default case ...
  }
}
```

The route handler logic for `chip_action` is part of Task 15 — when present in the request body, the handler executes the matching tool directly (bypassing AI), then asks the AI for the next coach turn given the new intake state.

- [ ] **Step 2: Add `mode='intake'` URL handling**

When the chat opens with `?mode=intake&doc=<id>`, ChatPanel sets the initial chat mode and stores `draftDocId` in state. Pattern mirrors how `?mode=plan_week` is handled.

- [ ] **Step 3: Add PlanProposalCard render branch in ChatThread.tsx**

In `components/chat/ChatThread.tsx`, find where `WeekPlanProposalCard` is rendered. Add a parallel branch for the plan proposal:

```tsx
import { PlanProposalCard } from "@/components/chat/PlanProposalCard";

// ... inside the render loop:

if (m.ui?.plan_proposal) {
  return (
    <PlanProposalCard
      key={m.id}
      plan={m.ui.plan_proposal.plan_payload as PlanPayload}
      approval_token={m.ui.plan_proposal.approval_token}
      onApprove={(token) => onChipAction("accept_plan_proposal", { token })}
    />
  );
}
```

The `ui.plan_proposal` payload is written by the propose_plan executor's response to the chat route, which adds it to the assistant message's `ui` jsonb before persisting.

- [ ] **Step 4: Run typecheck + commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
git add components/chat/ChatPanel.tsx components/chat/ChatThread.tsx
git commit -m "feat(chat): Phase 2 chip routing + plan-proposal render branch

Chip actions for Beat 1 (apply_*, set_sanity_override) and Beat 4 (set_*
preference setters) POST to the chat API with chip_action + chip_payload.
Route handler bypasses AI for the tool execution, then asks the AI for
the next coach turn given the updated intake state.

accept_plan_proposal chip sends [approve:<token>] as a user message —
mirrors existing weekly-planning commit pattern.

ChatThread renders PlanProposalCard inline when message.ui.plan_proposal
is set (parallel to WeekPlanProposalCard rendering for propose_week_plan).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 17: PlanProposalCard component

**Files:**
- Create: `components/chat/PlanProposalCard.tsx`

- [ ] **Step 1: Read WeekPlanProposalCard for pattern**

```bash
cd "/Users/abdelouahedelbied/Health app"
cat components/chat/WeekPlanProposalCard.tsx | head -60
```

PlanProposalCard mirrors the shape but renders the 8-section plan payload.

- [ ] **Step 2: Create the component**

```tsx
"use client";
import { useState } from "react";
import { COLOR, RADIUS } from "@/lib/ui/theme";
import type { PlanPayload } from "@/lib/data/types";

export function PlanProposalCard({
  plan,
  approval_token,
  onApprove,
}: {
  plan: PlanPayload;
  approval_token: string;
  onApprove: (token: string) => void;
}) {
  return (
    <div
      style={{
        background: COLOR.surface,
        border: `1px solid ${COLOR.divider}`,
        borderRadius: RADIUS.cardMid,
        padding: 16,
        margin: "8px 0",
        maxWidth: 640,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          marginBottom: 12,
        }}
      >
        <div>
          <div
            style={{
              fontSize: 11,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              color: COLOR.textMuted,
              fontWeight: 600,
            }}
          >
            Proposed coaching plan
          </div>
          <h3 style={{ fontSize: 16, fontWeight: 600, margin: "4px 0 0", color: COLOR.textStrong }}>
            {plan.goal.primary_metric} → {plan.goal.target_value}{plan.goal.target_unit} by {plan.goal.target_date}
          </h3>
        </div>
      </div>

      {plan.goal.feasibility_note && (
        <div
          style={{
            fontSize: 12,
            color: COLOR.warning,
            background: COLOR.warningSoft,
            padding: "6px 10px",
            borderRadius: 6,
            marginBottom: 12,
          }}
        >
          {plan.goal.feasibility_note}
        </div>
      )}

      <PlanSection title="Goal">
        <p style={{ fontSize: 13, lineHeight: 1.5, color: COLOR.textMid, margin: 0 }}>
          {plan.goal.narrative_summary}
        </p>
      </PlanSection>

      <PlanSection title="Nutrition">
        <KeyVal label="Phase" value={plan.nutrition.phase} />
        <KeyVal label="Calories" value={`${plan.nutrition.kcal_target} kcal (${plan.nutrition.kcal_range[0]}-${plan.nutrition.kcal_range[1]})`} />
        <KeyVal label="Protein" value={`${plan.nutrition.protein_g}g (${plan.nutrition.protein_g_per_kg_bw} g/kg BW)`} />
        <KeyVal label="Carbs / Fat" value={`${plan.nutrition.carb_g}g / ${plan.nutrition.fat_g}g`} />
        {plan.nutrition.refeed_cadence_days && (
          <KeyVal label="Refeed" value={`every ${plan.nutrition.refeed_cadence_days} days (+${plan.nutrition.refeed_uplift?.kcal} kcal)`} />
        )}
        <KeyVal label="Alcohol" value={plan.nutrition.hard_rules.alcohol_policy.replace(/_/g, " ")} />
      </PlanSection>

      <PlanSection title="Sleep">
        <KeyVal
          label="Schedule"
          value={`${plan.sleep.target_hours_min}-${plan.sleep.target_hours_max}h, wake ${plan.sleep.wake_target} → bed ${plan.sleep.bedtime_target}`}
        />
        <KeyVal label="Efficiency target" value={`${(plan.sleep.efficiency_target * 100).toFixed(0)}%`} />
        <KeyVal label="Caffeine cutoff" value={`${plan.sleep.hygiene_rules.caffeine_cutoff_hours_before_bed}h before bed`} />
      </PlanSection>

      <PlanSection title="Strength template">
        <KeyVal label="Sessions/wk" value={String(plan.strength.sessions_per_week)} />
        <KeyVal
          label="Pattern"
          value={Object.entries(plan.strength.day_pattern)
            .filter(([_, v]) => v !== "REST")
            .map(([d, t]) => `${d.slice(0, 3)}=${t}`)
            .join(" · ")}
        />
        {Object.entries(plan.strength.weekly_volume_targets).map(([lift, t]) => (
          <KeyVal key={lift} label={lift} value={`${t.reps_per_week} reps/wk, ${t.sets_per_week} sets/wk`} />
        ))}
        <div style={{ fontSize: 12, color: COLOR.textMuted, marginTop: 6 }}>
          {plan.strength.progression_rule}
        </div>
      </PlanSection>

      <div style={{ display: "flex", gap: 8, marginTop: 16, justifyContent: "flex-end" }}>
        <button
          type="button"
          onClick={() => onApprove(approval_token)}
          style={{
            background: COLOR.accent,
            color: "#fff",
            border: "none",
            borderRadius: RADIUS.pill,
            padding: "8px 16px",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Approve plan
        </button>
      </div>
    </div>
  );
}

function PlanSection({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div style={{ marginBottom: 12 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          background: "transparent",
          border: "none",
          padding: 0,
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          color: COLOR.textMuted,
          fontWeight: 700,
          cursor: "pointer",
          marginBottom: 4,
        }}
      >
        {open ? "▼" : "▶"} {title}
      </button>
      {open && <div style={{ paddingLeft: 12 }}>{children}</div>}
    </div>
  );
}

function KeyVal({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", gap: 8, fontSize: 12.5, color: COLOR.textMid, marginBottom: 2 }}>
      <span style={{ minWidth: 100, color: COLOR.textMuted }}>{label}</span>
      <span style={{ color: COLOR.textStrong, fontWeight: 500 }}>{value}</span>
    </div>
  );
}
```

- [ ] **Step 3: Run typecheck + commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
git add components/chat/PlanProposalCard.tsx
git commit -m "feat(chat): PlanProposalCard component

Renders proposed plan_payload inline in chat with Approve button.
Mirrors WeekPlanProposalCard's shape and styling. Four expandable
sections by default visible (Goal narrative, Nutrition, Sleep, Strength
template); 4 more sections (Periodization, Recovery, Coaching agreement,
Athlete snapshot) collapsed/hidden in v1 — user can read the full plan
in /profile after acknowledgment.

feasibility_note (from sanity_overrides) surfaces as a warning band when
present.

Approve button calls onApprove(token) which dispatches the
[approve:<token>] user message via ChatPanel's chip handler.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 18: AthleteProfilePanel "Generate plan" CTA + draft creation server action

**Files:**
- Modify: `components/profile/AthleteProfilePanel.tsx`
- Create: `app/onboarding/start-plan-intake.ts` (server action)

- [ ] **Step 1: Create the draft-creation server action**

```ts
// app/onboarding/start-plan-intake.ts
"use server";

import { redirect } from "next/navigation";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/** Creates a fresh draft athlete_profile_documents row by cloning the active
 *  intake_payload, clearing chat-elicited fields (so Beat 2-5 re-elicit fresh).
 *  Returns the new draft id. Caller redirects to /coach?mode=intake&doc=<id>.
 *
 *  Called from /profile's "Generate plan" CTA.
 */
export async function startPlanIntake(): Promise<{ ok: true; doc_id: string } | { ok: false; error: string }> {
  const userClient = await createSupabaseServerClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return { ok: false, error: "unauthorized" };

  const sr = createSupabaseServiceRoleClient();

  // Load active doc to copy intake_payload from
  const { data: active, error: loadErr } = await sr
    .from("athlete_profile_documents")
    .select("intake_payload, version")
    .eq("user_id", user.id)
    .eq("status", "active")
    .maybeSingle();
  if (loadErr) return { ok: false, error: loadErr.message };
  if (!active) return { ok: false, error: "no active profile to base draft on" };

  // Strip chat-elicited fields so Beats 2-5 re-elicit fresh
  const baseIntake = active.intake_payload as any;
  const draftIntake = { ...baseIntake };
  delete draftIntake.goal_narrative_chat;
  delete draftIntake.coaching_preferences;
  delete draftIntake.free_form_constraints;
  delete draftIntake.sanity_overrides;
  // chronotype on sleep_recovery is preserved (durable preference)

  // Create the draft row
  const { data: draft, error: insErr } = await sr
    .from("athlete_profile_documents")
    .insert({
      user_id: user.id,
      version: active.version + 1,
      status: "draft",
      intake_payload: draftIntake,
    })
    .select("id")
    .single();
  if (insErr) return { ok: false, error: insErr.message };

  return { ok: true, doc_id: draft.id };
}
```

- [ ] **Step 2: Add CTA to AthleteProfilePanel**

In `components/profile/AthleteProfilePanel.tsx`, add the conditional CTA when `active && active.plan_payload === null`:

```tsx
"use client";

import Link from "next/link";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { startPlanIntake } from "@/app/onboarding/start-plan-intake";

// ... existing imports ...

// Inside the component, after rendering the existing active card:

{active && active.plan_payload === null && (
  <GeneratePlanCta />
)}
```

Then define the CTA component:

```tsx
function GeneratePlanCta() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function handleClick() {
    startTransition(async () => {
      const result = await startPlanIntake();
      if (!result.ok) {
        alert(`Could not start plan intake: ${result.error}`);
        return;
      }
      router.push(`/coach?mode=intake&doc=${result.doc_id}`);
    });
  }

  return (
    <div
      style={{
        background: COLOR.accentSoft,
        border: `1px solid ${COLOR.accent}`,
        borderRadius: 10,
        padding: 16,
        marginTop: 12,
      }}
    >
      <div
        style={{
          fontSize: 14,
          fontWeight: 600,
          color: COLOR.textStrong,
          marginBottom: 6,
        }}
      >
        Your profile is set — now generate the coaching plan.
      </div>
      <div style={{ fontSize: 12.5, color: COLOR.textMid, marginBottom: 12, lineHeight: 1.5 }}>
        A 10-minute chat turns Phase 1's intake into a coaching plan with
        prescribed sleep / nutrition / strength targets the AI references daily.
      </div>
      <button
        type="button"
        onClick={handleClick}
        disabled={pending}
        style={{
          background: COLOR.accent,
          color: "#fff",
          border: "none",
          borderRadius: 999,
          padding: "8px 16px",
          fontSize: 13,
          fontWeight: 600,
          cursor: pending ? "wait" : "pointer",
        }}
      >
        {pending ? "Starting…" : "Generate plan →"}
      </button>
    </div>
  );
}
```

- [ ] **Step 3: Run typecheck + commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
git add components/profile/AthleteProfilePanel.tsx app/onboarding/start-plan-intake.ts
git commit -m "feat(profile): 'Generate plan' CTA + startPlanIntake server action

CTA card renders in AthleteProfilePanel when active.plan_payload === null
(Phase 1 leftover users). Click → server action clones active intake into
a new draft (version + 1), strips chat-elicited fields (so Beats 2-5
re-elicit fresh), preserves chronotype as durable preference, and returns
the draft id.

Client redirects to /coach?mode=intake&doc=<id> for the 5-beat chat.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 19: Morning brief get-today-targets.ts swap

**Files:**
- Modify: `lib/morning/brief/get-today-targets.ts`

- [ ] **Step 1: Update the function to prefer plan_payload**

The current `getTodayTargets()` reads `intake_payload.nutrition`. Phase 2 makes it read `plan_payload.nutrition` first, falling back to intake_payload when plan is null.

Current shape:

```ts
export async function getTodayTargets(supabase, userId) {
  const { data } = await supabase
    .from("athlete_profile_documents")
    .select("intake_payload")
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();
  if (!data) return null;
  return {
    kcal_target: data.intake_payload.nutrition.current_kcal,
    protein_target_g: data.intake_payload.nutrition.current_macros.protein_g,
    // ...
  };
}
```

Updated shape:

```ts
export async function getTodayTargets(supabase, userId) {
  const { data } = await supabase
    .from("athlete_profile_documents")
    .select("intake_payload, plan_payload")
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();
  if (!data) return null;

  // Phase 2: prefer plan_payload prescriptions; Phase 1: fall back to intake baseline
  if (data.plan_payload) {
    const plan = data.plan_payload as PlanPayload;
    return {
      kcal_target: plan.nutrition.kcal_target,
      protein_target_g: plan.nutrition.protein_g,
      carb_target_g: plan.nutrition.carb_g,
      fat_target_g: plan.nutrition.fat_g,
      bedtime_target: plan.sleep.bedtime_target,
      wake_target: plan.sleep.wake_target,
      sleep_hours_target_min: plan.sleep.target_hours_min,
      sleep_hours_target_max: plan.sleep.target_hours_max,
      source: "plan" as const,
    };
  }

  // Phase 1 fallback (intake-only)
  return {
    kcal_target: data.intake_payload.nutrition.current_kcal,
    protein_target_g: data.intake_payload.nutrition.current_macros.protein_g,
    carb_target_g: data.intake_payload.nutrition.current_macros.carb_g,
    fat_target_g: data.intake_payload.nutrition.current_macros.fat_g,
    bedtime_target: data.intake_payload.sleep_recovery.typical_bedtime,
    wake_target: data.intake_payload.sleep_recovery.typical_wake_time,
    sleep_hours_target_min: 7.5,  // default band when plan absent
    sleep_hours_target_max: 8.5,
    source: "intake" as const,
  };
}
```

Add a `source: "plan" | "intake"` discriminator so downstream code can know which path fed the numbers (useful for the morning brief's Advice block to phrase differently).

- [ ] **Step 2: Update `TodayTargets` type**

Wherever `TodayTargets` is exported (likely in the same file or in `lib/data/types.ts`), add the new fields (`carb_target_g`, `fat_target_g`, `wake_target`, `sleep_hours_target_min`, `sleep_hours_target_max`, `source`) and confirm existing morning brief consumers handle them.

- [ ] **Step 3: Run typecheck + commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
git add lib/morning/brief/get-today-targets.ts lib/data/types.ts 2>/dev/null
git commit -m "feat(brief): swap to plan_payload.nutrition when active plan exists

get-today-targets now reads plan_payload.nutrition (Phase 2 prescriptions)
first, falls back to intake_payload.nutrition (Phase 1 baseline) when no
plan exists. Backwards compatible — Phase 1 users see no change.

TodayTargets gains carb_target_g, fat_target_g, wake_target,
sleep_hours_target_min/max, and a source: 'plan' | 'intake' discriminator
for morning brief Advice block phrasing.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 20: End-to-end manual smoke + CLAUDE.md polish

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Manual smoke — pre-Phase-2 transition**

1. Visit `/profile`. Verify the "Generate plan" CTA card appears for the test user (active v1, plan_payload === null).
2. Click the CTA. Verify redirect to `/coach?mode=intake&doc=<new-draft-id>`.
3. Check DB: a new draft row exists with version = v1.version + 1, chat-elicited fields cleared.

- [ ] **Step 2: Manual smoke — Beat 1 sanity checks**

For the test user (deadlift target 100 < current 102, sleep efficiency gap):
1. Chat opens, AI surfaces goal_contradiction first.
2. Verify chips: "Use proposed target (115kg)" and "Keep mine (override)".
3. Tap "Use proposed target". Verify chat acknowledges; sleep_efficiency finding surfaces next.
4. Tap "Use suggested bedtime (22:00)". Verify the bedtime was applied (check DB: `intake_payload.sleep_recovery.typical_bedtime = "22:00"`).
5. Verify Beat 2 (deepen goal narrative) begins.

- [ ] **Step 3: Manual smoke — Beats 2-5**

1. Beat 2: AI probes goal narrative. Answer in 2-3 sentences. Verify `intake_payload.goal_narrative_chat` is populated.
2. Beat 3: GLP-1 follow-up. Answer. Verify `intake_payload.free_form_constraints` is populated.
3. Beat 4: 4 chip turns (directness, cadence, chronotype, unprompted_actions). Pick balanced / weekly / neutral / [flag_macros, flag_sleep]. Verify all 4 fields populate.
4. Beat 5: "anything else?" Say "no". AI calls propose_plan.

- [ ] **Step 4: Manual smoke — Plan proposal + commit**

1. PlanProposalCard renders inline. Verify it shows goal (target 115kg), nutrition phase=cut, protein 166g (1.6 g/kg × 103.5kg), strength sessions/wk + day pattern.
2. Tap "Approve plan". User message shows `[approve:<token>]`.
3. AI calls commit_plan. Verify response acknowledges.
4. DB check:
   ```sql
   select version, status, plan_payload is not null as has_plan, acknowledged_at, superseded_at, superseded_by
   from athlete_profile_documents
   where user_id = '<user>' order by version desc limit 3;
   ```
   Expected: new v(N) row active with plan_payload populated; prior v(N-1) superseded with superseded_by pointing at v(N).

- [ ] **Step 5: Manual smoke — morning brief consumes plan_payload**

1. Walk through morning intake tomorrow (or trigger today's brief regeneration via the retry-brief endpoint if available).
2. Inspect the brief card: Macros section should show 166g protein (from plan_payload.nutrition.protein_g), kcal 2085, bedtime 22:00 (from plan_payload.sleep.bedtime_target), wake 06:30.
3. Confirm the brief's source switched: log a temporary console.log in `get-today-targets.ts` to print `source` before committing the smoke.

- [ ] **Step 6: Cross-feature smoke — coach default chat acknowledges plan**

1. Open `/coach` in default mode. Ask: "what does my plan say about cuts?"
2. AI should reference plan_payload.nutrition (phase=cut, refeed cadence, protein floor 1.6 g/kg BW). It can cite the plan because the snapshot prefix now includes plan_payload context via the existing SCHEMA_EXPLAINER (no additional change needed).

- [ ] **Step 7: Add Coach/AI section bullet to CLAUDE.md**

Append to the "Coach / AI" section:

```markdown
- **Athlete profile Phase 2 (AI plan generation)** lives in `lib/coach/plan-builder/`. A 5-beat chat intake (`mode='intake'` in chat_messages; URL `/coach?mode=intake&doc=<id>`) deepens Phase 1's form-captured intake via deterministic sanity checks and conversational elicitation. `lib/coach/plan-builder/sanity-check.ts` runs four checks (goal contradiction, sleep efficiency, macros gap, protein floor) before the AI gets to deepen narrative — Beat 1 surfaces findings with chip-driven Accept/Override flow. Eight composers (snapshot, goal, periodization, strength template, nutrition, sleep, recovery, coaching agreement) produce the typed `plan_payload jsonb`; `lib/coach/plan-builder/narrative-prompt.ts` is the single Sonnet 4.6 call wrapping the prescriptions in coach voice. Plan-builder is a pure function; AI doesn't fabricate prescriptions. HMAC `propose_plan` / `commit_plan` tools mirror weekly-planning v1. `lib/morning/brief/get-today-targets.ts` swaps source to `plan_payload.nutrition` when an active plan exists.
```

- [ ] **Step 8: Final typecheck + commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
git add CLAUDE.md
git commit -m "docs(claude): document phase 2 plan-builder architecture

Captures the lib/coach/plan-builder/ module structure, the 5-beat intake
chat mode, the four sanity checks, and the plan_payload integration
into the morning brief's get-today-targets abstraction.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 9: Verify the full implementation typechecks + builds**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
npm run build 2>&1 | tail -10
```

Both clean.

---

## Self-Review

After completing all 20 tasks, review against the spec:

**1. Spec coverage** — every section of the spec is implemented:
- IntakePayload v2 + PlanPayload + SanityFinding + ChatMode extension → Task 1
- Approval token extension → Task 2
- Sanity check (4 deterministic) → Task 3
- Eight composers (snapshot, goal, periodization, strength, nutrition, sleep, recovery, coaching agreement) → Tasks 4-9
- Plan-builder orchestrator → Task 10
- Narrative prompt (Sonnet) → Task 11
- 11 new tools → Task 12
- INTAKE_PROMPT + mode dispatch → Task 13
- Profile renderer extension → Task 14
- Chat API mode resolution → Task 15
- ChatPanel chip routing + PlanProposalCard render → Tasks 16, 17
- AthleteProfilePanel CTA + draft creation server action → Task 18
- Morning brief get-today-targets swap → Task 19
- End-to-end smoke + CLAUDE.md → Task 20

**2. Placeholder scan** — no TBD / TODO / FIXME / "fill in" / "implement later" patterns in the plan.

**3. Type consistency** — `IntakePayload`, `PlanPayload`, `SanityFinding`, `TodayTargets`, `RecentE1RMsForStrength`, `ToolCtx`, `NarrativeContext`, `PlanNarrative` shapes match across tasks.

---

## Phase 2 → Phase 3 handoff

When Phase 2 ships and the soak begins, Phase 3 design constraints to carry forward:

- `plan_payload.coaching_agreement.unprompted_actions_allowed` already enumerates Phase 3's drift-detection trigger actions.
- `plan_payload.sleep.concern_triggers` and `plan_payload.recovery.deload_triggers` are the data Phase 3 reads to fire drift alerts.
- `plan_payload.coaching_agreement.re_evaluation_cadence_weeks` drives Phase 3's stale-doc nudge.
- `training_blocks.athlete_profile_doc_id` FK (Phase 3 addition) will correlate blocks to plan versions.

The morning brief integration is the validation point: as the user lives with Phase 2 plan prescriptions over 2-3 weeks, watch for prescription drift (e.g., bodyweight changes → protein_g changes — but kcal stays static, eventually requiring a revision). Phase 3 hardens these into proactive drift detection.
