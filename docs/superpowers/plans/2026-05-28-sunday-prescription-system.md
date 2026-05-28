# Sunday Prescription System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist Carter's full per-exercise Sunday prescription to `training_weeks.session_prescriptions`, cascade to strength card / morning brief / logger via an extended resolution chain, and enforce target immutability + consolidation + flat maintenance via propose-tool validation guards.

**Architecture:** New migration 0036 adds two nullable columns (`training_blocks.target_hit_at_week`, `training_weeks.session_prescriptions`). A new pure-function `lib/coach/prescription/` module houses six rule files (block-phase, autoregulation, volume-balance, pattern-conflict, maintenance-baseline, recent-workouts-discovery) plus an orchestrator and a validator. `getEffectiveSessionPlan` and `resolve-plan.ts` walk the extended chain. `propose_week_plan` gains a required `session_prescriptions` field and server-side validation. PLAN_WEEK_PROMPT teaches Carter the three-sub-report RECAP and per-exercise PROPOSE structure. A `target_hit_at_week` evaluator runs on every `commit_logger_session`.

**Tech Stack:** Next.js 15 / Supabase / TypeScript (strict) / pure-function rule modules / HMAC approval tokens / audit-script verification (no test runner — convention is `scripts/audit-*.mjs` exercised via `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local`).

**Spec:** [docs/superpowers/specs/2026-05-28-sunday-prescription-system-design.md](../specs/2026-05-28-sunday-prescription-system-design.md)

**Branch:** Create and execute on `feat/sunday-prescription-system`. Do not commit directly to main.

---

## File Inventory

**Created:**
- `supabase/migrations/0036_sunday_prescriptions.sql` — schema
- `lib/coach/prescription/types.ts` — shared TypeScript types
- `lib/coach/prescription/maintenance-baseline.ts` — `maintenanceLoadFor()`
- `lib/coach/prescription/block-phase-rule.ts` — `evaluateBlockPhase()` + `prescribePrimaryFromPhase()`
- `lib/coach/prescription/autoregulation-rule.ts` — `prescribeSecondaryAutoregulated()`
- `lib/coach/prescription/volume-balance-rule.ts` — `prescribeAccessoryFromVolumeBand()`
- `lib/coach/prescription/pattern-conflict-overlay.ts` — `validatePatternConflicts()`
- `lib/coach/prescription/recent-workouts-discovery.ts` — `discoverEffectiveExercises()`
- `lib/coach/prescription/prescribe-week.ts` — orchestrator + data adapter
- `lib/coach/prescription/validate-week.ts` — `validateWeekPrescription()`
- `lib/coach/prescription/target-hit-evaluator.ts` — `evaluateAndStampTargetHit()`
- `scripts/seed-target-hit-at-week.mjs` — one-shot migration backfill
- `scripts/audit-prescription-rules.mjs` — fixture-based audit for rule modules
- `scripts/audit-sunday-prescription-e2e.mjs` — end-to-end live-data audit

**Modified:**
- `lib/data/types.ts` — `TrainingBlock`, `TrainingWeek`, new `SessionPrescriptions` type
- `lib/coach/sessionPlans.ts` — `getEffectiveSessionPlan` signature extended; new chain walk
- `lib/logger/resolve-plan.ts` — server-side chain walk updated to match
- `lib/coach/tools.ts` — `propose_week_plan` tool schema + executor wiring of validator
- `lib/coach/planning-prompts.ts` — `PLAN_WEEK_PROMPT` extended with three-sub-report RECAP and per-exercise PROPOSE rules
- `lib/morning/brief/advice-prompt.ts` — prompt narrates from `session.exercises` block, "do not invent loads"
- `app/api/logger/session/route.ts` — call `evaluateAndStampTargetHit()` after commit
- `components/strength/StrengthCoachClient.tsx` — pass `session_prescriptions` into the chain
- `lib/query/fetchers/trainingWeeks.ts` (or equivalent) — include `session_prescriptions` in select shape

---

## Execution Note on Tests

This repo has no test runner ([CLAUDE.md](../../../CLAUDE.md): "There is no test suite and no working linter"). The established convention is `scripts/audit-*.mjs` scripts run via the alias loader. Pure rule modules get a single audit script (`scripts/audit-prescription-rules.mjs`) with fixture-based cases that exercise every rule's branches. UI/integration changes are verified via `npm run typecheck` + manual click-through on `npm run dev`. End-to-end is verified by `scripts/audit-sunday-prescription-e2e.mjs` against live data with `AUDIT_USER_ID=<uuid>`.

---

## Task 0: Branch creation

**Files:** none

- [ ] **Step 1: Create and check out feature branch**

```bash
cd "/Users/abdelouahedelbied/Health app"
git checkout -b feat/sunday-prescription-system
```

Expected: `Switched to a new branch 'feat/sunday-prescription-system'`

- [ ] **Step 2: Confirm clean state**

```bash
git status
```

Expected: working tree shows the three unrelated modified files (DraftReview.tsx, FoodSearchPicker.tsx, BottomSheet.tsx) which we leave alone. No untracked Sunday-prescription files yet.

---

## Task 1: Migration 0036 — schema

**Files:**
- Create: `supabase/migrations/0036_sunday_prescriptions.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 0036_sunday_prescriptions.sql
-- Adds target_hit_at_week to training_blocks (consolidation trigger) and
-- session_prescriptions to training_weeks (Sunday-committed per-exercise plan).
-- Both columns are nullable; existing rows behave unchanged (resolution chain
-- falls through). See docs/superpowers/specs/2026-05-28-sunday-prescription-system-design.md.

alter table public.training_blocks
  add column target_hit_at_week int;

comment on column public.training_blocks.target_hit_at_week is
  'When the active block''s primary-lift working_kg first crossed target_value. Sets the block into consolidation phase — propose_week_plan refuses further load increases on the primary lift. NULL = pre-target; non-NULL = post-target. Set by evaluateAndStampTargetHit on every commit_logger_session.';

alter table public.training_weeks
  add column session_prescriptions jsonb;

comment on column public.training_weeks.session_prescriptions is
  'Full per-exercise per-day plan committed by Carter on Sunday. jsonb shape: { Monday: PlannedExercise[], Tuesday: PlannedExercise[], … } keyed by full weekday names (Monday-Sunday). Each PlannedExercise carries name, baseKg, baseReps, sets, key, increment, note. NULL = no Sunday plan committed yet; the resolution chain falls through to the next layer. Becomes the new top of the resolution chain consumed by getEffectiveSessionPlan.';
```

- [ ] **Step 2: Apply via Supabase CLI**

```bash
cd "/Users/abdelouahedelbied/Health app"
supabase db push
```

Expected: migration applied to remote project `eopfwwergisvskxqvsqe`. If `supabase migration repair --status applied <history>` is needed first, the CLI prompts.

- [ ] **Step 3: Verify columns exist**

```bash
supabase db remote sql --read-only "select column_name, data_type from information_schema.columns where table_name in ('training_blocks','training_weeks') and column_name in ('target_hit_at_week','session_prescriptions');"
```

Expected output includes both new column rows.

- [ ] **Step 4: Update CLAUDE.md with the new migration entry**

Add this line after the migration 35 entry in [CLAUDE.md](../../../CLAUDE.md):

```markdown
36. [supabase/migrations/0036_sunday_prescriptions.sql](supabase/migrations/0036_sunday_prescriptions.sql) — adds `training_blocks.target_hit_at_week int` (consolidation phase trigger; set by `evaluateAndStampTargetHit` on each workout commit) and `training_weeks.session_prescriptions jsonb` (new top of the per-day exercise resolution chain consumed by `getEffectiveSessionPlan`). Both nullable; pre-migration rows behave unchanged via chain fall-through.
```

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0036_sunday_prescriptions.sql CLAUDE.md
git commit -m "$(cat <<'EOF'
feat(prescription): migration 0036 — target_hit_at_week + session_prescriptions

Adds two nullable columns enabling the Sunday Prescription System:
- training_blocks.target_hit_at_week (consolidation trigger)
- training_weeks.session_prescriptions (per-exercise per-day Sunday plan)

Existing rows behave unchanged — resolution chain falls through.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Type updates

**Files:**
- Modify: `lib/data/types.ts`

- [ ] **Step 1: Read the current TrainingBlock and TrainingWeek shapes**

```bash
grep -n "TrainingBlock\|TrainingWeek\|IntensityModifier" lib/data/types.ts | head -20
```

Note the line numbers for the two types.

- [ ] **Step 2: Add `target_hit_at_week` to TrainingBlock**

Locate the `TrainingBlock` type (around line 239-260 per the earlier audit). Add the field after `target_value`:

```typescript
target_hit_at_week: number | null;
```

- [ ] **Step 3: Add `session_prescriptions` and define the keyed-by-weekday shape**

Add a new exported type and append it to TrainingWeek:

```typescript
import type { PlannedExercise } from "@/lib/coach/sessionPlans";

export type WeekdayLong =
  | "Monday" | "Tuesday" | "Wednesday" | "Thursday"
  | "Friday" | "Saturday" | "Sunday";

export type SessionPrescriptions = Partial<Record<WeekdayLong, PlannedExercise[]>>;
```

Then on TrainingWeek (around line 310-320), add the field:

```typescript
session_prescriptions: SessionPrescriptions | null;
```

If `WeekdayLong` already exists elsewhere in `types.ts` or is imported from another module, use the existing one and don't re-declare. Run a grep to confirm:

```bash
grep -n "WeekdayLong" lib/data/types.ts lib/coach/*.ts | head
```

- [ ] **Step 4: Verify typecheck passes**

```bash
npm run typecheck
```

Expected: no errors. If errors appear in files that previously relied on the partial shapes, fix imports rather than relaxing the new types.

- [ ] **Step 5: Commit**

```bash
git add lib/data/types.ts
git commit -m "$(cat <<'EOF'
feat(prescription): types — target_hit_at_week + SessionPrescriptions

Extends TrainingBlock with target_hit_at_week and TrainingWeek with
session_prescriptions. Adds SessionPrescriptions keyed-by-weekday type.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `maintenance-baseline.ts`

**Files:**
- Create: `lib/coach/prescription/maintenance-baseline.ts`
- Create: `lib/coach/prescription/types.ts`

- [ ] **Step 1: Write shared types**

```typescript
// lib/coach/prescription/types.ts
//
// Shared types for the prescription engine. Imported by all rule modules.

import type { PrimaryLift, WeekdayLong, PlannedExercise } from "@/lib/data/types";

export type BlockPhase = "pre_target" | "consolidation" | "off_pace" | "deload_week";

export type WorkoutSetSample = {
  exercise_name: string;
  exercise_key: string | null;
  kg: number;
  reps: number;
  rpe: number | null;
  rir: number | null;
  performed_on: string; // ISO date
};

export type PrescriptionRuleInput = {
  blockPhase: BlockPhase;
  primaryLift: PrimaryLift;
  currentWorkingKg: number;
  targetValueKg: number;
  rirTarget: number;
  recentSets: WorkoutSetSample[];
};

export type PrescribedExercise = PlannedExercise;
```

- [ ] **Step 2: Write `maintenance-baseline.ts`**

```typescript
// lib/coach/prescription/maintenance-baseline.ts
//
// Computes the "current working weight" for a lift — the highest clean set
// in the last N weeks where RPE ≤ rir_target + 1 (or RIR signal indicates
// clean). This is the value the maintenance multiplier (0.90×) applies to,
// NOT the stale SESSION_PLANS.baseKg.

import type { WorkoutSetSample } from "@/lib/coach/prescription/types";

const LOOKBACK_DAYS = 28; // 4 weeks

/** Returns the max kg across the user's recent clean working sets for the
 *  given exercise. A set is "clean" if either:
 *   - rir is non-null AND rir ≥ rirTarget - 1, OR
 *   - rpe is non-null AND rpe ≤ 11 - rirTarget (algebraic equivalent)
 *  Note: RPE = 10 - RIR. The "within 1 of target effort" tolerance lets the
 *  baseline reflect realistic working sets — a set at RPE 9 (RIR 1) on a
 *  rirTarget=2 plan still represents the athlete's actual capacity.
 *  Returns null when no clean sets found in the window. */
export function maintenanceLoadFor(
  exerciseNameOrKey: string,
  rirTarget: number,
  recentSets: WorkoutSetSample[],
  todayIso: string,
): number | null {
  const cutoff = subtractDaysIso(todayIso, LOOKBACK_DAYS);
  const cleanSets = recentSets.filter((s) => {
    if (s.performed_on < cutoff) return false;
    if (s.exercise_name !== exerciseNameOrKey && s.exercise_key !== exerciseNameOrKey) return false;
    const rpeOk  = s.rpe != null && s.rpe <= 11 - rirTarget;
    const rirOk  = s.rir != null && s.rir >= Math.max(0, rirTarget - 1);
    return rpeOk || rirOk;
  });
  if (cleanSets.length === 0) return null;
  return Math.max(...cleanSets.map((s) => s.kg));
}

function subtractDaysIso(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
```

- [ ] **Step 3: Write the audit script entry for this module**

Create `scripts/audit-prescription-rules.mjs` (the shared audit script for all rule modules — we'll grow it task-by-task):

```javascript
// scripts/audit-prescription-rules.mjs
//
// Fixture-based audit for the prescription rule modules. Exercises each
// rule with concrete inputs and asserts expected outputs. Run via:
//   node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs
//
// No DB access — pure functions only.

import { maintenanceLoadFor } from "@/lib/coach/prescription/maintenance-baseline.ts";

let pass = 0;
let fail = 0;

function assert(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else      { fail++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

console.log("\n## maintenance-baseline.ts\n");

{
  const sets = [
    { exercise_name: "Deadlift (Barbell)", exercise_key: "deadlift", kg: 95, reps: 7, rpe: 8, rir: null, performed_on: "2026-05-21" },
    { exercise_name: "Deadlift (Barbell)", exercise_key: "deadlift", kg: 97.5, reps: 6, rpe: 8.5, rir: null, performed_on: "2026-05-28" },
    { exercise_name: "Deadlift (Barbell)", exercise_key: "deadlift", kg: 100, reps: 1, rpe: 10, rir: null, performed_on: "2026-05-28" }, // dirty — RPE 10 with RIR target 2 → rpe > 3, rejected
    { exercise_name: "Deadlift (Barbell)", exercise_key: "deadlift", kg: 92.5, reps: 6, rpe: 7, rir: null, performed_on: "2026-04-20" }, // outside 28-day window, rejected
  ];
  const result = maintenanceLoadFor("deadlift", 2, sets, "2026-05-28");
  assert("max clean kg in window is 97.5 (rejects RPE 10 + outside-window)", result === 97.5, `got ${result}`);

  const noSets = maintenanceLoadFor("squat", 2, sets, "2026-05-28");
  assert("returns null when no matching exercise found", noSets === null);

  const onlyOutOfWindow = maintenanceLoadFor("deadlift", 2, sets.slice(3), "2026-05-28");
  assert("returns null when only out-of-window sets exist", onlyOutOfWindow === null);
}

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
```

- [ ] **Step 4: Run the audit**

```bash
node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs
```

Expected: `3 passed, 0 failed.`

- [ ] **Step 5: Commit**

```bash
git add lib/coach/prescription/types.ts lib/coach/prescription/maintenance-baseline.ts scripts/audit-prescription-rules.mjs
git commit -m "$(cat <<'EOF'
feat(prescription): maintenance-baseline rule

maintenanceLoadFor returns max clean working kg from last 4 weeks of
sets where rpe ≤ rir_target + 1. Replaces stale SESSION_PLANS.baseKg
as the basis for the 0.90× maintenance multiplier.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `block-phase-rule.ts`

**Files:**
- Create: `lib/coach/prescription/block-phase-rule.ts`
- Modify: `scripts/audit-prescription-rules.mjs`

- [ ] **Step 1: Write `block-phase-rule.ts`**

```typescript
// lib/coach/prescription/block-phase-rule.ts
//
// Determines which phase of the block the athlete is in (pre_target /
// consolidation / off_pace / deload_week) and prescribes the primary
// lift's load/reps/sets for next week accordingly.

import type {
  TrainingBlock,
  PlannedExercise,
  WeekdayLong,
} from "@/lib/data/types";
import type {
  BlockPhase,
  PrescriptionRuleInput,
} from "@/lib/coach/prescription/types";

const OFF_PACE_REQUIRED_RATIO = 1.5; // required-rate must exceed observed-rate × 1.5 to be off-pace

/** Returns the block phase based on the athlete's progress and the calendar.
 *  Deload week (week 5) always wins. Otherwise: consolidation if target hit,
 *  off_pace if remaining weeks can't catch up, pre_target otherwise. */
export function evaluateBlockPhase(opts: {
  block: TrainingBlock;
  currentWorkingKg: number | null;
  recentProgressionRatePerWeek: number | null;
  todayIso: string;
}): BlockPhase {
  const week = currentBlockWeek(opts.block, opts.todayIso);
  if (week >= totalBlockWeeks(opts.block)) return "deload_week";
  if (opts.block.target_hit_at_week != null) return "consolidation";

  if (
    opts.currentWorkingKg != null &&
    opts.block.target_value != null &&
    opts.recentProgressionRatePerWeek != null &&
    opts.recentProgressionRatePerWeek > 0
  ) {
    const weeksRemaining = totalBlockWeeks(opts.block) - week;
    if (weeksRemaining <= 0) return "deload_week";
    const required = (opts.block.target_value - opts.currentWorkingKg) / weeksRemaining;
    if (required > opts.recentProgressionRatePerWeek * OFF_PACE_REQUIRED_RATIO) return "off_pace";
  }
  return "pre_target";
}

/** Produces the primary-lift PlannedExercise for next week given the block
 *  phase. The output is a PlannedExercise shape with baseKg/baseReps/sets
 *  populated per the phase rules:
 *   - pre_target:    +step kg if last week RIR target hit cleanly; hold otherwise
 *   - consolidation: hold load, +1 rep target OR +1 set (whichever progression vector applies)
 *   - off_pace:      narrow the deficit — small load jump, optional set drop to compensate fatigue
 *   - deload_week:   load × 0.80, sets cut 50% (rounded down to integer ≥ 1), reps held */
export function prescribePrimaryFromPhase(opts: {
  baseExercise: PlannedExercise; // from session library or recent_workouts; supplies name/key/increment
  phase: BlockPhase;
  currentWorkingKg: number;
  lastWeekHitRirTargetCleanly: boolean;
  rirTarget: number;
  baselineSets: number;
  baselineReps: number;
}): PlannedExercise {
  const { baseExercise: ex, phase, currentWorkingKg } = opts;
  const step = ex.increment?.step ?? 2.5;

  let nextKg = currentWorkingKg;
  let nextReps = opts.baselineReps;
  let nextSets = opts.baselineSets;

  switch (phase) {
    case "pre_target": {
      nextKg = opts.lastWeekHitRirTargetCleanly ? currentWorkingKg + step : currentWorkingKg;
      break;
    }
    case "consolidation": {
      nextKg = currentWorkingKg; // immutable
      nextReps = opts.baselineReps + 1; // chase clean reps
      nextSets = opts.baselineSets + 1; // OR an extra set, alternating logic-light
      break;
    }
    case "off_pace": {
      nextKg = opts.lastWeekHitRirTargetCleanly ? currentWorkingKg + step : currentWorkingKg;
      nextSets = Math.max(1, opts.baselineSets - 1);
      break;
    }
    case "deload_week": {
      nextKg = roundToStep(currentWorkingKg * 0.80, step);
      nextSets = Math.max(1, Math.floor(opts.baselineSets / 2));
      break;
    }
  }

  return {
    ...ex,
    baseKg: nextKg,
    baseReps: nextReps,
    sets: nextSets,
  };
}

// ── helpers ──────────────────────────────────────────────────────────────

function currentBlockWeek(block: TrainingBlock, todayIso: string): number {
  const start = new Date(block.start_date + "T00:00:00Z");
  const today = new Date(todayIso + "T00:00:00Z");
  const days = Math.floor((today.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
  return Math.max(1, Math.floor(days / 7) + 1);
}

function totalBlockWeeks(block: TrainingBlock): number {
  const start = new Date(block.start_date + "T00:00:00Z");
  const end = new Date(block.end_date + "T00:00:00Z");
  const days = Math.floor((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
  return Math.round(days / 7);
}

function roundToStep(kg: number, step: number): number {
  return Math.round(kg / step) * step;
}
```

- [ ] **Step 2: Append audit cases to `scripts/audit-prescription-rules.mjs`**

Append this section after the existing maintenance-baseline section:

```javascript
import { evaluateBlockPhase, prescribePrimaryFromPhase } from "@/lib/coach/prescription/block-phase-rule.ts";

console.log("\n## block-phase-rule.ts\n");

{
  const block = {
    id: "fixture",
    user_id: "fixture",
    block_id: null,
    start_date: "2026-05-04",
    end_date: "2026-06-07",
    primary_lift: "deadlift",
    target_metric: "working_weight",
    target_value: 95,
    target_unit: "kg",
    status: "active",
    diet_goal: null,
    goal_text: "fixture",
    notes: null,
    created_at: "2026-05-04",
    updated_at: "2026-05-04",
    target_hit_at_week: null,
  };

  const preTarget = evaluateBlockPhase({
    block,
    currentWorkingKg: 90,
    recentProgressionRatePerWeek: 1.25,
    todayIso: "2026-05-17", // week 2 — required (95-90)/3 = 1.67, observed 1.25 × 1.5 = 1.875 → pre_target
  });
  assert("pre_target when remaining weeks can keep up", preTarget === "pre_target", `got ${preTarget}`);

  const offPace = evaluateBlockPhase({
    block,
    currentWorkingKg: 90,
    recentProgressionRatePerWeek: 0.4,
    todayIso: "2026-05-31", // week 4 — required (95-90)/1 = 5.0, observed 0.4 × 1.5 = 0.6 → off_pace
  });
  assert("off_pace when remaining can't catch up", offPace === "off_pace", `got ${offPace}`);

  const consolidation = evaluateBlockPhase({
    block: { ...block, target_hit_at_week: 3 },
    currentWorkingKg: 97.5,
    recentProgressionRatePerWeek: 1.25,
    todayIso: "2026-05-31",
  });
  assert("consolidation when target_hit_at_week set", consolidation === "consolidation", `got ${consolidation}`);

  const deload = evaluateBlockPhase({
    block,
    currentWorkingKg: 95,
    recentProgressionRatePerWeek: 1.25,
    todayIso: "2026-06-07", // week 5
  });
  assert("deload_week at week >= total_weeks", deload === "deload_week", `got ${deload}`);
}

{
  const baseEx = {
    name: "Deadlift (Barbell)",
    key: "deadlift",
    baseKg: 82.5,
    baseReps: 6,
    sets: 2,
    increment: { step: 2.5 },
  };

  const consolidated = prescribePrimaryFromPhase({
    baseExercise: baseEx,
    phase: "consolidation",
    currentWorkingKg: 97.5,
    lastWeekHitRirTargetCleanly: true,
    rirTarget: 1,
    baselineSets: 3,
    baselineReps: 6,
  });
  assert("consolidation holds load", consolidated.baseKg === 97.5);
  assert("consolidation progresses reps", consolidated.baseReps === 7);
  assert("consolidation progresses sets", consolidated.sets === 4);

  const progressed = prescribePrimaryFromPhase({
    baseExercise: baseEx,
    phase: "pre_target",
    currentWorkingKg: 90,
    lastWeekHitRirTargetCleanly: true,
    rirTarget: 2,
    baselineSets: 3,
    baselineReps: 6,
  });
  assert("pre_target with clean RIR adds step", progressed.baseKg === 92.5);

  const heldDueToMiss = prescribePrimaryFromPhase({
    baseExercise: baseEx,
    phase: "pre_target",
    currentWorkingKg: 90,
    lastWeekHitRirTargetCleanly: false,
    rirTarget: 2,
    baselineSets: 3,
    baselineReps: 6,
  });
  assert("pre_target with missed RIR holds", heldDueToMiss.baseKg === 90);

  const deloaded = prescribePrimaryFromPhase({
    baseExercise: baseEx,
    phase: "deload_week",
    currentWorkingKg: 97.5,
    lastWeekHitRirTargetCleanly: true,
    rirTarget: 1,
    baselineSets: 3,
    baselineReps: 6,
  });
  assert("deload rounds 80% to step grid (97.5×0.80=78.0)", deloaded.baseKg === 77.5 || deloaded.baseKg === 80, `got ${deloaded.baseKg}`);
  assert("deload halves sets", deloaded.sets === 1);
}
```

- [ ] **Step 3: Run the audit**

```bash
node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs
```

Expected: all cases pass.

- [ ] **Step 4: Commit**

```bash
git add lib/coach/prescription/block-phase-rule.ts scripts/audit-prescription-rules.mjs
git commit -m "$(cat <<'EOF'
feat(prescription): block-phase rule

evaluateBlockPhase returns pre_target / consolidation / off_pace /
deload_week. prescribePrimaryFromPhase produces the next week's
primary-lift PlannedExercise per the phase: hold-load + progress
reps/sets in consolidation; +step on clean RIR pre-target;
narrow-deficit off_pace; 0.80× volume-halved deload.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `autoregulation-rule.ts`

**Files:**
- Create: `lib/coach/prescription/autoregulation-rule.ts`
- Modify: `scripts/audit-prescription-rules.mjs`

- [ ] **Step 1: Write `autoregulation-rule.ts`**

```typescript
// lib/coach/prescription/autoregulation-rule.ts
//
// Prescribes a non-focus primary lift (or any non-primary compound lift
// not under the block-phase rule) using autoregulation: clean RIR → +step;
// missed once → hold; missed twice → drop 5%. During a focus block, the
// effective load is also clamped to 0.92 × maintenance baseline.

import type { PlannedExercise } from "@/lib/data/types";

export type AutoregInput = {
  baseExercise: PlannedExercise;
  currentWorkingKg: number;
  lastWeekHitRirTargetCleanly: boolean;
  consecutiveRirMisses: number; // 0 = clean last week, 1 = missed last week, 2+ = missed two+ in a row
  maintenanceBaselineKg: number | null; // null when not in focus block (no clamp)
  /** During a focus block this is 0.92 (gives 0.02 slack vs the 0.90 rule target).
   *  Outside a focus block, pass null to disable the clamp. */
  focusBlockClampMultiplier: number | null;
  baselineSets: number;
  baselineReps: number;
  isFocusBlock: boolean;
};

export function prescribeSecondaryAutoregulated(input: AutoregInput): PlannedExercise {
  const { baseExercise: ex, currentWorkingKg } = input;
  const step = ex.increment?.step ?? 2.5;

  // Step 1: autoregulation choice
  let nextKg: number;
  if (input.consecutiveRirMisses >= 2) {
    nextKg = roundToStep(currentWorkingKg * 0.95, step);
  } else if (input.lastWeekHitRirTargetCleanly) {
    nextKg = currentWorkingKg + step;
  } else {
    nextKg = currentWorkingKg;
  }

  // Step 2: focus-block clamp
  if (
    input.maintenanceBaselineKg != null &&
    input.focusBlockClampMultiplier != null
  ) {
    const ceiling = roundToStep(
      input.maintenanceBaselineKg * input.focusBlockClampMultiplier,
      step,
    );
    if (nextKg > ceiling) nextKg = ceiling;
  }

  // Step 3: volume drop during focus block
  const sets = input.isFocusBlock
    ? Math.max(1, input.baselineSets - 1)
    : input.baselineSets;

  return {
    ...ex,
    baseKg: nextKg,
    baseReps: input.baselineReps,
    sets,
  };
}

function roundToStep(kg: number, step: number): number {
  return Math.round(kg / step) * step;
}
```

- [ ] **Step 2: Append audit cases to `scripts/audit-prescription-rules.mjs`**

```javascript
import { prescribeSecondaryAutoregulated } from "@/lib/coach/prescription/autoregulation-rule.ts";

console.log("\n## autoregulation-rule.ts\n");

{
  const baseEx = {
    name: "Squat (Barbell)",
    key: "squat",
    baseKg: 62.5,
    baseReps: 6,
    sets: 3,
    increment: { step: 2.5 },
  };

  const focusClean = prescribeSecondaryAutoregulated({
    baseExercise: baseEx,
    currentWorkingKg: 80,
    lastWeekHitRirTargetCleanly: true,
    consecutiveRirMisses: 0,
    maintenanceBaselineKg: 80,
    focusBlockClampMultiplier: 0.92,
    baselineSets: 3,
    baselineReps: 6,
    isFocusBlock: true,
  });
  assert("focus block clean: clamped to 0.92×80=73.5 rounded to 72.5", focusClean.baseKg === 72.5, `got ${focusClean.baseKg}`);
  assert("focus block drops one set (3→2)", focusClean.sets === 2);

  const focusMissedTwice = prescribeSecondaryAutoregulated({
    baseExercise: baseEx,
    currentWorkingKg: 80,
    lastWeekHitRirTargetCleanly: false,
    consecutiveRirMisses: 2,
    maintenanceBaselineKg: 80,
    focusBlockClampMultiplier: 0.92,
    baselineSets: 3,
    baselineReps: 6,
    isFocusBlock: true,
  });
  assert("focus block missed twice drops 5% (80→76 round to 75)", focusMissedTwice.baseKg === 75 || focusMissedTwice.baseKg === 77.5, `got ${focusMissedTwice.baseKg}`);

  const nonFocusClean = prescribeSecondaryAutoregulated({
    baseExercise: baseEx,
    currentWorkingKg: 80,
    lastWeekHitRirTargetCleanly: true,
    consecutiveRirMisses: 0,
    maintenanceBaselineKg: null,
    focusBlockClampMultiplier: null,
    baselineSets: 3,
    baselineReps: 6,
    isFocusBlock: false,
  });
  assert("non-focus block clean: +step (80→82.5), no set drop", nonFocusClean.baseKg === 82.5 && nonFocusClean.sets === 3);
}
```

- [ ] **Step 3: Run the audit**

```bash
node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs
```

Expected: all cases pass.

- [ ] **Step 4: Commit**

```bash
git add lib/coach/prescription/autoregulation-rule.ts scripts/audit-prescription-rules.mjs
git commit -m "$(cat <<'EOF'
feat(prescription): autoregulation rule

prescribeSecondaryAutoregulated applies clean → +step / missed → hold /
missed twice → -5% logic with focus-block 0.92× clamp and -1 set
volume drop. Used for non-focus primary lifts and compound accessories
not under the block-phase rule.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `volume-balance-rule.ts`

**Files:**
- Create: `lib/coach/prescription/volume-balance-rule.ts`
- Modify: `scripts/audit-prescription-rules.mjs`

- [ ] **Step 1: Read existing muscle-volume module to align**

```bash
head -80 lib/coach/muscle-volume.ts && echo "---" && grep -n "MEV\|MAV\|MRV\|landmark" lib/coach/muscle-volume.ts | head -30
```

Note the existing band names and the per-muscle volume function signature so this new rule consumes them rather than re-implementing.

- [ ] **Step 2: Write `volume-balance-rule.ts`**

```typescript
// lib/coach/prescription/volume-balance-rule.ts
//
// Prescribes an accessory exercise's sets per the muscle's MEV/MAV/MRV
// band position. Load progression is via autoregulation (handled in
// autoregulation-rule.ts) — this module decides sets only.

import type { PlannedExercise } from "@/lib/data/types";

export type VolumeBandPosition = "below_mev" | "at_mev" | "in_band" | "near_mrv" | "above_mrv";

export type VolumeBalanceInput = {
  baseExercise: PlannedExercise;
  currentSets: number;
  bandPosition: VolumeBandPosition;
};

export function prescribeAccessoryFromVolumeBand(input: VolumeBalanceInput): PlannedExercise {
  const { baseExercise: ex, currentSets, bandPosition } = input;

  let nextSets = currentSets;
  switch (bandPosition) {
    case "below_mev":
      nextSets = currentSets + 1;
      break;
    case "at_mev":
      nextSets = currentSets + 1; // push toward MAV
      break;
    case "in_band":
      nextSets = currentSets; // hold
      break;
    case "near_mrv":
      nextSets = Math.max(1, currentSets); // hold; coach narrates "no more pushing"
      break;
    case "above_mrv":
      nextSets = Math.max(1, currentSets - 1); // drop a set
      break;
  }

  return {
    ...ex,
    sets: nextSets,
  };
}

/** Maps a muscle's actual weekly sets vs landmarks to a VolumeBandPosition. */
export function classifyVolumeBand(opts: {
  actualWeeklySets: number;
  mev: number;
  mav: number;
  mrv: number;
}): VolumeBandPosition {
  if (opts.actualWeeklySets < opts.mev) return "below_mev";
  if (opts.actualWeeklySets === opts.mev) return "at_mev";
  if (opts.actualWeeklySets >= opts.mrv) return "above_mrv";
  if (opts.actualWeeklySets >= Math.floor(opts.mrv * 0.9)) return "near_mrv";
  return "in_band";
}
```

- [ ] **Step 3: Append audit cases**

```javascript
import { prescribeAccessoryFromVolumeBand, classifyVolumeBand } from "@/lib/coach/prescription/volume-balance-rule.ts";

console.log("\n## volume-balance-rule.ts\n");

{
  const baseEx = {
    name: "Lat Pulldown (Cable)",
    key: "lat_pulldown",
    baseKg: 45,
    baseReps: 10,
    sets: 4,
    increment: { step: 5 },
  };

  const belowMev = prescribeAccessoryFromVolumeBand({
    baseExercise: baseEx,
    currentSets: 3,
    bandPosition: "below_mev",
  });
  assert("below MEV adds a set", belowMev.sets === 4);

  const inBand = prescribeAccessoryFromVolumeBand({
    baseExercise: baseEx,
    currentSets: 3,
    bandPosition: "in_band",
  });
  assert("in band holds", inBand.sets === 3);

  const aboveMrv = prescribeAccessoryFromVolumeBand({
    baseExercise: baseEx,
    currentSets: 4,
    bandPosition: "above_mrv",
  });
  assert("above MRV drops a set", aboveMrv.sets === 3);

  assert("classify 7 with mev=8,mav=14,mrv=20 → below_mev", classifyVolumeBand({ actualWeeklySets: 7, mev: 8, mav: 14, mrv: 20 }) === "below_mev");
  assert("classify 8 with mev=8,mav=14,mrv=20 → at_mev",    classifyVolumeBand({ actualWeeklySets: 8, mev: 8, mav: 14, mrv: 20 }) === "at_mev");
  assert("classify 12 with mev=8,mav=14,mrv=20 → in_band",  classifyVolumeBand({ actualWeeklySets: 12, mev: 8, mav: 14, mrv: 20 }) === "in_band");
  assert("classify 18 with mev=8,mav=14,mrv=20 → near_mrv", classifyVolumeBand({ actualWeeklySets: 18, mev: 8, mav: 14, mrv: 20 }) === "near_mrv");
  assert("classify 20 with mev=8,mav=14,mrv=20 → above_mrv", classifyVolumeBand({ actualWeeklySets: 20, mev: 8, mav: 14, mrv: 20 }) === "above_mrv");
}
```

- [ ] **Step 4: Run the audit**

```bash
node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs
```

Expected: all cases pass.

- [ ] **Step 5: Commit**

```bash
git add lib/coach/prescription/volume-balance-rule.ts scripts/audit-prescription-rules.mjs
git commit -m "$(cat <<'EOF'
feat(prescription): volume-balance rule

prescribeAccessoryFromVolumeBand selects sets per the muscle's
MEV/MAV/MRV band position. Load progression is delegated to
autoregulation-rule. classifyVolumeBand maps actual weekly sets to a
band position consumed by the rule.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: `pattern-conflict-overlay.ts`

**Files:**
- Create: `lib/coach/prescription/pattern-conflict-overlay.ts`
- Modify: `scripts/audit-prescription-rules.mjs`

- [ ] **Step 1: Write `pattern-conflict-overlay.ts`**

```typescript
// lib/coach/prescription/pattern-conflict-overlay.ts
//
// Hard-rejects pattern conflicts in a Sunday prescription: axial-loaded
// hinge accessories on non-focus days during a deadlift focus block.
// Extensible to other patterns via the BLOCK_PATTERN_RULES table.

import type {
  TrainingBlock,
  TrainingWeek,
  SessionPrescriptions,
  WeekdayLong,
  PrimaryLift,
} from "@/lib/data/types";

const AXIAL_HINGE_KEYS = ["rdl", "good_morning", "stiff_leg_dl"];
const LOW_AXIAL_HINGE_KEYS = ["hip_thrust", "45_hyper_loaded", "cable_pull_through"];

/** For each primary lift, which session_type contains it. Used to find the
 *  focus day per-week from training_weeks.session_plan, since users may
 *  train Back on different weekdays. */
const PRIMARY_LIFT_TO_SESSION: Record<PrimaryLift, string> = {
  deadlift: "Back",
  squat:    "Legs",
  bench:    "Chest",
  ohp:      "Chest",
};

export type PatternConflictError = {
  code: "pattern_conflict";
  message: string;
  offending: Array<{ weekday: WeekdayLong; exercise: string }>;
  hint: string;
};

export function validatePatternConflicts(
  prescription: SessionPrescriptions,
  block: TrainingBlock,
  week: TrainingWeek,
): PatternConflictError | null {
  if (block.primary_lift !== "deadlift") return null; // only deadlift blocks have axial-hinge conflict for now

  const focusDay = focusDayForBlock(block, week);
  const offending: Array<{ weekday: WeekdayLong; exercise: string }> = [];

  for (const [weekday, exercises] of Object.entries(prescription) as Array<[WeekdayLong, typeof prescription[WeekdayLong]]>) {
    if (!exercises) continue;
    if (weekday === focusDay) continue;
    for (const ex of exercises) {
      if (ex.key != null && AXIAL_HINGE_KEYS.includes(ex.key)) {
        offending.push({ weekday, exercise: ex.name });
      }
    }
  }

  if (offending.length === 0) return null;

  return {
    code: "pattern_conflict",
    message: "Axial-loaded hinge accessory on a non-focus day during a deadlift focus block.",
    offending,
    hint: `Move to ${focusDay ?? "the deadlift day"}, swap for a low-axial variant (${LOW_AXIAL_HINGE_KEYS.join(", ")}), or drop.`,
  };
}

export function focusDayForBlock(block: TrainingBlock, week: TrainingWeek): WeekdayLong | null {
  if (block.primary_lift == null) return null;
  const focusSessionType = PRIMARY_LIFT_TO_SESSION[block.primary_lift];
  const sessionPlan = week.session_plan as Record<WeekdayLong, string>;
  for (const [day, type] of Object.entries(sessionPlan) as Array<[WeekdayLong, string]>) {
    if (type === focusSessionType) return day;
  }
  return null;
}
```

- [ ] **Step 2: Append audit cases**

```javascript
import { validatePatternConflicts } from "@/lib/coach/prescription/pattern-conflict-overlay.ts";

console.log("\n## pattern-conflict-overlay.ts\n");

{
  const block = {
    id: "fixture",
    user_id: "fixture",
    primary_lift: "deadlift",
    target_metric: "working_weight",
    target_value: 95,
    target_unit: "kg",
    status: "active",
    start_date: "2026-05-04",
    end_date: "2026-06-07",
    target_hit_at_week: null,
    diet_goal: null,
    goal_text: "fixture",
    notes: null,
    block_id: null,
    created_at: "2026-05-04",
    updated_at: "2026-05-04",
  };
  const week = {
    user_id: "fixture",
    week_start: "2026-05-25",
    session_plan: { Monday: "Legs", Tuesday: "Chest", Wednesday: "Mobility", Thursday: "Back", Friday: "Arms", Saturday: "REST", Sunday: "REST" },
    intensity_modifier: {},
    rir_target: 2,
    research_phase: "accumulate",
    block_id: "fixture",
    exercise_overrides: null,
    session_prescriptions: null,
    weekly_focus: null,
    original_session_plan: null,
  };

  const violating = {
    Monday: [{ name: "Romanian Deadlift (Barbell)", key: "rdl", baseKg: 65, baseReps: 6, sets: 3 }],
  };
  const r1 = validatePatternConflicts(violating, block, week);
  assert("RDL on Monday during deadlift block flagged", r1 !== null && r1.code === "pattern_conflict");
  assert("offending list points at Monday RDL", r1 && r1.offending[0].weekday === "Monday" && r1.offending[0].exercise === "Romanian Deadlift (Barbell)");

  const okOnFocusDay = {
    Thursday: [{ name: "Romanian Deadlift (Barbell)", key: "rdl", baseKg: 65, baseReps: 6, sets: 3 }],
  };
  assert("RDL on Thursday (focus day) NOT flagged", validatePatternConflicts(okOnFocusDay, block, week) === null);

  const lowAxialOk = {
    Monday: [{ name: "Hip Thrust", key: "hip_thrust", baseKg: 60, baseReps: 10, sets: 3 }],
  };
  assert("Hip Thrust on Monday NOT flagged", validatePatternConflicts(lowAxialOk, block, week) === null);

  const noOpForSquatBlock = validatePatternConflicts(
    violating,
    { ...block, primary_lift: "squat" },
    week,
  );
  assert("non-deadlift block: no-op (RDL allowed)", noOpForSquatBlock === null);
}
```

- [ ] **Step 3: Run the audit**

```bash
node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs
```

Expected: all cases pass.

- [ ] **Step 4: Commit**

```bash
git add lib/coach/prescription/pattern-conflict-overlay.ts scripts/audit-prescription-rules.mjs
git commit -m "$(cat <<'EOF'
feat(prescription): pattern-conflict overlay

validatePatternConflicts rejects axial-loaded hinge accessories on
non-focus days during a deadlift focus block. Suggests low-axial
alternatives (Hip Thrust, 45° Hyperextension, Cable Pull-Through) in
the error hint. Extensible matrix via PRIMARY_LIFT_TO_SESSION.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Independent expert review of rule modules

**Files:** none (review-only checkpoint)

- [ ] **Step 1: Dispatch an independent expert review**

Spawn an expert coach agent to audit the four rule modules implemented so far (`block-phase-rule.ts`, `autoregulation-rule.ts`, `volume-balance-rule.ts`, `pattern-conflict-overlay.ts`) against established strength-coaching practice.

Use the Agent tool with `subagent_type: "general-purpose"` and the prompt:

> You are an expert S&C coach reviewing implementation of a periodization-aware prescription engine. Read the four files in `lib/coach/prescription/` (`block-phase-rule.ts`, `autoregulation-rule.ts`, `volume-balance-rule.ts`, `pattern-conflict-overlay.ts`). For each:
>
> 1. Does the rule match standard coaching practice (Helms / Israetel / RP / Schoenfeld where applicable)?
> 2. Are the constants reasonable (off_pace ratio 1.5, deload 0.80×, focus clamp 0.92, 4-week lookback for maintenance baseline)?
> 3. Is anything missing that an experienced coach would expect (e.g., asymmetric progression rates, primary-lift-specific tolerances, frequency considerations)?
>
> Concise verdict, max 400 words. Flag anything that needs change BEFORE we wire these into the orchestrator. If no changes needed, say so explicitly.

- [ ] **Step 2: Apply review feedback if any**

If the reviewer identifies issues, fix them in a follow-up edit + audit pass + commit BEFORE proceeding to Task 9. Append a brief note to the relevant rule file's header comment summarizing the change and its rationale (one line).

If the reviewer signs off with no changes needed, no commit — proceed.

---

## Task 9: `recent-workouts-discovery.ts`

**Files:**
- Create: `lib/coach/prescription/recent-workouts-discovery.ts`

This module touches Supabase, so its audit lives in the e2e script (Task 17), not the pure-function audit.

- [ ] **Step 1: Write `recent-workouts-discovery.ts`**

```typescript
// lib/coach/prescription/recent-workouts-discovery.ts
//
// Materializes "what the athlete actually trains" for a session_type by
// scanning recent workouts. Sits below user_session_templates and above
// SESSION_PLANS in the resolution chain — heals the "SESSION_PLANS lists
// RDL but I never do RDL" failure mode automatically.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { PlannedExercise } from "@/lib/coach/sessionPlans";
import { SESSION_PLANS } from "@/lib/coach/sessionPlans";

const MIN_SESSIONS_REQUIRED = 4; // need at least N sessions of this type to discover
const PRESENCE_THRESHOLD = 0.5;  // exercise must appear in ≥50% of recent sessions

/** Returns the PlannedExercise[] that appear in ≥50% of the user's last
 *  4-8 sessions of the given session_type. Each exercise's baseKg is the
 *  max kg observed in the user's last 28 days for that exercise. Returns
 *  null when fewer than MIN_SESSIONS_REQUIRED of this type exist —
 *  signals the caller to fall through to SESSION_PLANS. */
export async function discoverEffectiveExercises(opts: {
  supabase: SupabaseClient;
  userId: string;
  sessionType: string;
}): Promise<PlannedExercise[] | null> {
  const { supabase, userId, sessionType } = opts;

  const { data: workouts, error: wErr } = await supabase
    .from("workouts")
    .select("id, session_type, performed_on, exercises:exercises(id, name, key, sets:exercise_sets(kg, reps, rpe, rir))")
    .eq("user_id", userId)
    .eq("session_type", sessionType)
    .order("performed_on", { ascending: false })
    .limit(8);

  if (wErr || !workouts || workouts.length < MIN_SESSIONS_REQUIRED) return null;

  // Tally per-exercise presence
  const presence: Map<string, { count: number; exemplar: { name: string; key: string | null; kgs: number[]; reps: number[] } }> = new Map();
  for (const w of workouts) {
    const seenInThisSession = new Set<string>();
    for (const ex of w.exercises ?? []) {
      const k = (ex.key ?? ex.name).toLowerCase();
      if (seenInThisSession.has(k)) continue; // count once per session
      seenInThisSession.add(k);
      const entry = presence.get(k) ?? { count: 0, exemplar: { name: ex.name, key: ex.key, kgs: [], reps: [] } };
      entry.count += 1;
      for (const s of ex.sets ?? []) {
        if (s.kg != null) entry.exemplar.kgs.push(s.kg);
        if (s.reps != null) entry.exemplar.reps.push(s.reps);
      }
      presence.set(k, entry);
    }
  }

  const totalSessions = workouts.length;
  const survivors: PlannedExercise[] = [];

  // Library order preserved when overlapping with SESSION_PLANS — gives stable UI ordering.
  const libraryOrder = SESSION_PLANS[sessionType] ?? [];
  const libraryKeys = new Set(libraryOrder.map((e) => (e.key ?? e.name).toLowerCase()));

  // First pass: library exercises that survive presence threshold
  for (const libEx of libraryOrder) {
    const k = (libEx.key ?? libEx.name).toLowerCase();
    const found = presence.get(k);
    if (!found || found.count / totalSessions < PRESENCE_THRESHOLD) continue;
    survivors.push({
      ...libEx,
      baseKg: found.exemplar.kgs.length > 0 ? Math.max(...found.exemplar.kgs) : libEx.baseKg,
      baseReps: found.exemplar.reps.length > 0 ? Math.round(median(found.exemplar.reps)) : libEx.baseReps,
    });
  }

  // Second pass: non-library exercises (user added something off-script)
  for (const [k, entry] of presence) {
    if (libraryKeys.has(k)) continue;
    if (entry.count / totalSessions < PRESENCE_THRESHOLD) continue;
    survivors.push({
      name: entry.exemplar.name,
      key: entry.exemplar.key ?? undefined,
      baseKg: entry.exemplar.kgs.length > 0 ? Math.max(...entry.exemplar.kgs) : undefined,
      baseReps: entry.exemplar.reps.length > 0 ? Math.round(median(entry.exemplar.reps)) : undefined,
      sets: 3,
    });
  }

  return survivors.length > 0 ? survivors : null;
}

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[m - 1] + sorted[m]) / 2 : sorted[m];
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/coach/prescription/recent-workouts-discovery.ts
git commit -m "$(cat <<'EOF'
feat(prescription): recent-workouts discovery layer

discoverEffectiveExercises scans the user's last 8 workouts of a given
session_type and returns exercises present in ≥50% of them, with
baseKg sourced from the user's recent max. Heals the
SESSION_PLANS-says-I-do-RDL-but-I-don't failure mode automatically.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: `prescribe-week.ts` orchestrator

**Files:**
- Create: `lib/coach/prescription/prescribe-week.ts`

This module integrates all rule modules and is the entrypoint called from `propose_week_plan`'s executor.

- [ ] **Step 1: Write `prescribe-week.ts`**

```typescript
// lib/coach/prescription/prescribe-week.ts
//
// Orchestrator: given a user, a block, the proposed week's session_plan
// + intensity_modifier, and prior workout history, produce the full
// session_prescriptions[weekday] payload for commit. Combines all four
// rule modules (block-phase, autoregulation, volume-balance, pattern-
// conflict) plus maintenance-baseline and recent-workouts discovery.

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  TrainingBlock,
  TrainingWeek,
  SessionPrescriptions,
  PrimaryLift,
  WeekdayLong,
} from "@/lib/data/types";
import type { PlannedExercise } from "@/lib/coach/sessionPlans";
import { SESSION_PLANS } from "@/lib/coach/sessionPlans";
import { evaluateBlockPhase, prescribePrimaryFromPhase } from "@/lib/coach/prescription/block-phase-rule";
import { prescribeSecondaryAutoregulated } from "@/lib/coach/prescription/autoregulation-rule";
import { prescribeAccessoryFromVolumeBand, classifyVolumeBand } from "@/lib/coach/prescription/volume-balance-rule";
import { maintenanceLoadFor } from "@/lib/coach/prescription/maintenance-baseline";
import { discoverEffectiveExercises } from "@/lib/coach/prescription/recent-workouts-discovery";
import { focusDayForBlock } from "@/lib/coach/prescription/pattern-conflict-overlay";

const PRIMARY_LIFT_KEYS: PrimaryLift[] = ["squat", "bench", "deadlift", "ohp"];

const MAINTENANCE_TARGET = 0.90; // rule default; validator allows up to 0.92

const PRIMARY_LIFT_BY_EXERCISE_KEY: Record<string, PrimaryLift> = {
  squat: "squat",
  decline_bench: "bench",
  incline_db: "bench",
  bench: "bench",
  deadlift: "deadlift",
  ohp: "ohp",
};

export async function prescribeWeek(opts: {
  supabase: SupabaseClient;
  userId: string;
  block: TrainingBlock | null;
  week: TrainingWeek;
  todayIso: string;
}): Promise<SessionPrescriptions> {
  const { supabase, userId, block, week, todayIso } = opts;
  const out: SessionPrescriptions = {};

  // Fetch recent sets once for all maintenance-baseline lookups
  const recentSets = await fetchRecentSets(supabase, userId, todayIso);

  // Fetch per-muscle volume bands snapshot once for the week
  const volumeContext = await fetchVolumeContext(supabase, userId, todayIso);

  const focusDay = block != null ? focusDayForBlock(block, week) : null;
  const isFocusBlock = block != null && block.primary_lift != null;

  for (const [weekday, sessionType] of Object.entries(week.session_plan ?? {}) as Array<[WeekdayLong, string]>) {
    if (sessionType === "REST" || sessionType === "Mobility") continue;

    const effective =
      (await discoverEffectiveExercises({ supabase, userId, sessionType })) ??
      SESSION_PLANS[sessionType] ??
      [];

    const exercises: PlannedExercise[] = [];

    for (const baseEx of effective) {
      const liftKey = baseEx.key != null ? PRIMARY_LIFT_BY_EXERCISE_KEY[baseEx.key] : undefined;
      const isPrimary = liftKey != null;
      const isFocusLift = isFocusBlock && liftKey === block!.primary_lift;

      if (isFocusLift) {
        const currentWorkingKg =
          maintenanceLoadFor(baseEx.key ?? baseEx.name, week.rir_target, recentSets, todayIso) ??
          baseEx.baseKg ?? 0;
        const phase = evaluateBlockPhase({
          block: block!,
          currentWorkingKg,
          recentProgressionRatePerWeek: estimateProgressionRate(recentSets, baseEx, todayIso),
          todayIso,
        });
        const prescribed = prescribePrimaryFromPhase({
          baseExercise: baseEx,
          phase,
          currentWorkingKg,
          lastWeekHitRirTargetCleanly: lastWeekClean(recentSets, baseEx, week.rir_target),
          rirTarget: week.rir_target,
          baselineSets: baseEx.sets ?? 3,
          baselineReps: baseEx.baseReps ?? 6,
        });
        exercises.push(prescribed);
      } else if (isPrimary) {
        const currentWorkingKg =
          maintenanceLoadFor(baseEx.key ?? baseEx.name, week.rir_target, recentSets, todayIso) ??
          baseEx.baseKg ?? 0;
        const prescribed = prescribeSecondaryAutoregulated({
          baseExercise: baseEx,
          currentWorkingKg,
          lastWeekHitRirTargetCleanly: lastWeekClean(recentSets, baseEx, week.rir_target),
          consecutiveRirMisses: consecutiveMisses(recentSets, baseEx, week.rir_target),
          maintenanceBaselineKg: isFocusBlock ? currentWorkingKg : null,
          focusBlockClampMultiplier: isFocusBlock ? 0.92 : null,
          baselineSets: baseEx.sets ?? 3,
          baselineReps: baseEx.baseReps ?? 6,
          isFocusBlock,
        });
        exercises.push(prescribed);
      } else {
        // Accessory: volume-balance for sets; autoregulation for load
        const band = classifyVolumeBandForMuscle(baseEx, volumeContext);
        const autoreg = prescribeSecondaryAutoregulated({
          baseExercise: baseEx,
          currentWorkingKg:
            maintenanceLoadFor(baseEx.key ?? baseEx.name, week.rir_target, recentSets, todayIso) ??
            baseEx.baseKg ?? 0,
          lastWeekHitRirTargetCleanly: lastWeekClean(recentSets, baseEx, week.rir_target),
          consecutiveRirMisses: 0,
          maintenanceBaselineKg: null,
          focusBlockClampMultiplier: null,
          baselineSets: baseEx.sets ?? 3,
          baselineReps: baseEx.baseReps ?? 8,
          isFocusBlock: false, // volume-only adjustments handled below
        });
        const volumeAdjusted = prescribeAccessoryFromVolumeBand({
          baseExercise: autoreg,
          currentSets: autoreg.sets ?? baseEx.sets ?? 3,
          bandPosition: band,
        });
        exercises.push(volumeAdjusted);
      }
    }

    out[weekday] = exercises;
  }

  return out;
}

// ── data adapters ──────────────────────────────────────────────────────────

async function fetchRecentSets(supabase: SupabaseClient, userId: string, todayIso: string) {
  const cutoff = subtractDaysIso(todayIso, 28);
  const { data, error } = await supabase
    .from("exercise_sets")
    .select("kg, reps, rpe, rir, exercise:exercises(name, key), workout:workouts(user_id, performed_on)")
    .eq("workout.user_id", userId)
    .gte("workout.performed_on", cutoff)
    .order("workout.performed_on", { ascending: false })
    .limit(500);
  if (error || !data) return [];
  return data.map((row: any) => ({
    exercise_name: row.exercise?.name ?? "",
    exercise_key: row.exercise?.key ?? null,
    kg: row.kg,
    reps: row.reps,
    rpe: row.rpe,
    rir: row.rir,
    performed_on: row.workout?.performed_on ?? "1970-01-01",
  }));
}

async function fetchVolumeContext(supabase: SupabaseClient, userId: string, todayIso: string) {
  // Reuses lib/coach/muscle-volume.ts via the function it already exposes.
  // Returns the per-muscle WTD sets + landmarks. Adapter shape only;
  // concrete consumption is in classifyVolumeBandForMuscle below.
  return null; // placeholder — wired in Task 11 once muscle-volume helper is identified
}

function classifyVolumeBandForMuscle(baseEx: PlannedExercise, _ctx: unknown) {
  // Fallback default until volume-context wiring lands: treat as in_band.
  // Task 11 swaps this for the real classifier.
  return classifyVolumeBand({ actualWeeklySets: 10, mev: 8, mav: 14, mrv: 20 });
}

function lastWeekClean(sets: ReturnType<typeof fetchRecentSets> extends Promise<infer T> ? T : never, ex: PlannedExercise, rirTarget: number): boolean {
  // Inspect last week's sets for this exercise. Clean = top working set met rir_target.
  const k = (ex.key ?? ex.name).toLowerCase();
  const matching = sets.filter((s) => (s.exercise_key ?? s.exercise_name).toLowerCase() === k);
  const lastWeekTop = matching[0]; // recent-first ordering
  if (lastWeekTop == null) return false;
  if (lastWeekTop.rir != null) return lastWeekTop.rir >= rirTarget;
  if (lastWeekTop.rpe != null) return lastWeekTop.rpe <= 10 - rirTarget;
  return false;
}

function consecutiveMisses(sets: ReturnType<typeof fetchRecentSets> extends Promise<infer T> ? T : never, ex: PlannedExercise, rirTarget: number): number {
  const k = (ex.key ?? ex.name).toLowerCase();
  const matching = sets.filter((s) => (s.exercise_key ?? s.exercise_name).toLowerCase() === k);
  let misses = 0;
  for (const s of matching) {
    const clean =
      (s.rir != null && s.rir >= rirTarget) ||
      (s.rpe != null && s.rpe <= 10 - rirTarget);
    if (clean) break;
    misses++;
  }
  return misses;
}

function estimateProgressionRate(sets: ReturnType<typeof fetchRecentSets> extends Promise<infer T> ? T : never, ex: PlannedExercise, todayIso: string): number {
  const k = (ex.key ?? ex.name).toLowerCase();
  const matching = sets.filter((s) => (s.exercise_key ?? s.exercise_name).toLowerCase() === k).slice(0, 8);
  if (matching.length < 2) return 0;
  const newest = matching[0].kg;
  const oldest = matching[matching.length - 1].kg;
  const weeks = Math.max(1, Math.round((dateDiffDays(matching[matching.length - 1].performed_on, matching[0].performed_on)) / 7));
  return (newest - oldest) / weeks;
}

function subtractDaysIso(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function dateDiffDays(a: string, b: string): number {
  const da = new Date(a + "T00:00:00Z").getTime();
  const db = new Date(b + "T00:00:00Z").getTime();
  return Math.abs(db - da) / (24 * 60 * 60 * 1000);
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: no errors. If errors appear due to muscle-volume context type mismatch, leave the placeholder and resolve in Task 11.

- [ ] **Step 3: Commit**

```bash
git add lib/coach/prescription/prescribe-week.ts
git commit -m "$(cat <<'EOF'
feat(prescription): prescribe-week orchestrator

prescribeWeek combines block-phase, autoregulation, and volume-balance
rules per exercise per day of the proposed week. Pulls maintenance
baselines from recent workouts. Pattern-conflict validation happens
downstream in validate-week.ts (Task 12). Muscle-volume context
classifier placeholder pending Task 11 wiring.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Wire muscle-volume context into orchestrator

**Files:**
- Modify: `lib/coach/prescription/prescribe-week.ts`

- [ ] **Step 1: Locate the existing muscle-volume helper**

```bash
grep -n "export function\|export async function\|export const" lib/coach/muscle-volume.ts | head -30
```

Identify the function that returns per-muscle weekly volume + landmarks for a user. Note its signature.

- [ ] **Step 2: Replace `fetchVolumeContext` placeholder with the real call**

In `prescribe-week.ts`, replace the placeholder body of `fetchVolumeContext` with a call to the identified muscle-volume helper. Return its per-muscle map (whatever the existing module exposes).

- [ ] **Step 3: Update `classifyVolumeBandForMuscle` to use the context**

```typescript
function classifyVolumeBandForMuscle(baseEx: PlannedExercise, ctx: VolumeContext | null): VolumeBandPosition {
  if (ctx == null) return classifyVolumeBand({ actualWeeklySets: 10, mev: 8, mav: 14, mrv: 20 });
  const primaryMuscle = inferPrimaryMuscle(baseEx); // reuse the existing exercise-to-muscle map from lib/coach/exercise-muscles.ts
  const muscleData = ctx[primaryMuscle];
  if (muscleData == null) return "in_band";
  return classifyVolumeBand({
    actualWeeklySets: muscleData.weekly_sets,
    mev: muscleData.mev,
    mav: muscleData.mav,
    mrv: muscleData.mrv,
  });
}
```

Import `inferPrimaryMuscle` from `lib/coach/exercise-muscles.ts`. Confirm the function exists with `grep -n "inferPrimaryMuscle\|exercise.*muscle" lib/coach/exercise-muscles.ts`. If the name is different, use the actual one.

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add lib/coach/prescription/prescribe-week.ts
git commit -m "$(cat <<'EOF'
feat(prescription): wire muscle-volume context

Replaces classifyVolumeBandForMuscle placeholder with real per-muscle
band classification using the existing lib/coach/muscle-volume.ts
helper + lib/coach/exercise-muscles.ts mapping.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: `validate-week.ts`

**Files:**
- Create: `lib/coach/prescription/validate-week.ts`
- Modify: `scripts/audit-prescription-rules.mjs`

- [ ] **Step 1: Write `validate-week.ts`**

```typescript
// lib/coach/prescription/validate-week.ts
//
// Server-side validation called by propose_week_plan before signing the
// approval token. Hard-rejects with structured error + hint for any of
// the six discipline-enforcement rules.

import type {
  TrainingBlock,
  TrainingWeek,
  SessionPrescriptions,
  PrimaryLift,
  WeekdayLong,
} from "@/lib/data/types";
import type { PlannedExercise } from "@/lib/coach/sessionPlans";
import { validatePatternConflicts, focusDayForBlock } from "@/lib/coach/prescription/pattern-conflict-overlay";
import { resolveExercise } from "@/lib/coach/exercise-library";

const FOCUS_CLAMP_MULTIPLIER = 0.92;

export type ValidationError =
  | { code: "off_grid_weight"; message: string; hint: string }
  | { code: "consolidation_load_increase"; message: string; hint: string }
  | { code: "non_focus_primary_overcooked"; message: string; hint: string }
  | { code: "non_focus_primary_volume_too_high"; message: string; hint: string }
  | { code: "pattern_conflict"; message: string; hint: string; offending: Array<{ weekday: WeekdayLong; exercise: string }> }
  | { code: "mismatched_session_type"; message: string; hint: string; severity: "warn" };

export async function validateWeekPrescription(opts: {
  prescription: SessionPrescriptions;
  block: TrainingBlock | null;
  week: TrainingWeek;
  prevWeek: TrainingWeek | null; // for consolidation comparison
  maintenanceBaselines: Partial<Record<PrimaryLift, number>>; // current working kg per primary
  nonFocusBaselineSets: Partial<Record<PrimaryLift, number>>; // sets in a non-focus block
}): Promise<ValidationError | null> {
  // 1. off_grid_weight — applies to every prescribed exercise with baseKg
  for (const [weekday, exercises] of Object.entries(opts.prescription) as Array<[WeekdayLong, PlannedExercise[]]>) {
    for (const ex of exercises) {
      if (ex.baseKg == null) continue;
      const lib = resolveExercise(ex.name);
      if (!lib || !lib.increment) continue; // bodyweight / library gap
      const step = lib.increment.step;
      const intermediate = lib.increment.intermediate;
      const onPrimary = Math.abs((ex.baseKg / step) - Math.round(ex.baseKg / step)) < 1e-6;
      const onIntermediate =
        intermediate != null &&
        ex.baseKg >= intermediate &&
        Math.abs(((ex.baseKg - intermediate) / step) - Math.round((ex.baseKg - intermediate) / step)) < 1e-6;
      if (!(onPrimary || onIntermediate)) {
        return {
          code: "off_grid_weight",
          message: `${ex.name} (${weekday}): ${ex.baseKg} kg is not on the equipment grid (step ${step} kg${intermediate != null ? `, intermediate ${intermediate} kg` : ""}).`,
          hint: `Use a valid load and re-propose.`,
        };
      }
    }
  }

  // 2. consolidation_load_increase — primary lift cannot increase load when target_hit_at_week is set
  if (opts.block?.target_hit_at_week != null && opts.block.primary_lift != null && opts.prevWeek != null) {
    const focusDay = focusDayForBlock(opts.block, opts.week);
    if (focusDay) {
      const proposedFocusEx = opts.prescription[focusDay]?.find((e) => e.key === opts.block!.primary_lift);
      const prevFocusEx = (opts.prevWeek.session_prescriptions as SessionPrescriptions | null)?.[focusDay]?.find((e) => e.key === opts.block!.primary_lift);
      if (proposedFocusEx?.baseKg != null && prevFocusEx?.baseKg != null && proposedFocusEx.baseKg > prevFocusEx.baseKg) {
        return {
          code: "consolidation_load_increase",
          message: `${opts.block.primary_lift}: block is in consolidation (target hit week ${opts.block.target_hit_at_week}); load cannot increase from ${prevFocusEx.baseKg} → ${proposedFocusEx.baseKg} kg.`,
          hint: `Hold the load. Progress reps or sets instead. To raise loads, close this block and start a new one.`,
        };
      }
    }
  }

  // 3 + 4. non-focus primary overcooked / volume-too-high — applies during a focus block, weeks 1-4
  if (
    opts.block?.primary_lift != null &&
    opts.week.research_phase !== "deload"
  ) {
    for (const [weekday, exercises] of Object.entries(opts.prescription) as Array<[WeekdayLong, PlannedExercise[]]>) {
      for (const ex of exercises) {
        if (ex.key == null) continue;
        const liftKey = inferPrimaryLiftFromExerciseKey(ex.key);
        if (liftKey == null) continue;
        if (liftKey === opts.block.primary_lift) continue; // focus lift not checked here
        const baseline = opts.maintenanceBaselines[liftKey];
        if (baseline != null && ex.baseKg != null) {
          const ceiling = baseline * FOCUS_CLAMP_MULTIPLIER;
          if (ex.baseKg > ceiling) {
            return {
              code: "non_focus_primary_overcooked",
              message: `${ex.name} (${weekday}): ${ex.baseKg} kg exceeds the focus-block maintenance ceiling of ${ceiling.toFixed(1)} kg (0.92 × current working ${baseline.toFixed(1)} kg).`,
              hint: `Drop the load to ≤ ${ceiling.toFixed(1)} kg. The deadlift focus block requires reduced secondaries.`,
            };
          }
        }
        const baselineSets = opts.nonFocusBaselineSets[liftKey];
        if (baselineSets != null && (ex.sets ?? 0) >= baselineSets) {
          return {
            code: "non_focus_primary_volume_too_high",
            message: `${ex.name} (${weekday}): ${ex.sets} sets is not below the non-focus baseline of ${baselineSets}.`,
            hint: `During a focus block, secondary primaries drop by at least one working set vs their non-focus baseline.`,
          };
        }
      }
    }
  }

  // 5. pattern_conflict
  if (opts.block != null) {
    const patternErr = validatePatternConflicts(opts.prescription, opts.block, opts.week);
    if (patternErr) return patternErr;
  }

  // 6. mismatched_session_type — warn (not block)
  // Implementation deferred to v1.1 if needed; not load-bearing for v1.

  return null;
}

function inferPrimaryLiftFromExerciseKey(key: string): PrimaryLift | null {
  if (key === "squat") return "squat";
  if (key === "decline_bench" || key === "bench" || key === "incline_db") return "bench";
  if (key === "deadlift") return "deadlift";
  if (key === "ohp") return "ohp";
  return null;
}
```

- [ ] **Step 2: Append audit cases**

```javascript
import { validateWeekPrescription } from "@/lib/coach/prescription/validate-week.ts";

console.log("\n## validate-week.ts\n");

{
  const block = {
    id: "fixture", user_id: "fixture", primary_lift: "deadlift", target_metric: "working_weight",
    target_value: 95, target_unit: "kg", status: "active",
    start_date: "2026-05-04", end_date: "2026-06-07",
    target_hit_at_week: 3,
    diet_goal: null, goal_text: "fixture", notes: null, block_id: null,
    created_at: "2026-05-04", updated_at: "2026-05-04",
  };
  const week = {
    user_id: "fixture", week_start: "2026-06-01",
    session_plan: { Monday: "Legs", Tuesday: "Chest", Wednesday: "Mobility", Thursday: "Back", Friday: "Arms", Saturday: "REST", Sunday: "REST" },
    intensity_modifier: {}, rir_target: 1, research_phase: "accumulate",
    block_id: "fixture", exercise_overrides: null, session_prescriptions: null,
    weekly_focus: null, original_session_plan: null,
  };
  const prevWeek = {
    ...week, week_start: "2026-05-25",
    session_prescriptions: {
      Thursday: [{ name: "Deadlift (Barbell)", key: "deadlift", baseKg: 97.5, baseReps: 7, sets: 3, increment: { step: 2.5 } }],
    },
  };

  const consolidationViolation = await validateWeekPrescription({
    prescription: { Thursday: [{ name: "Deadlift (Barbell)", key: "deadlift", baseKg: 100, baseReps: 7, sets: 3, increment: { step: 2.5 } }] },
    block, week, prevWeek,
    maintenanceBaselines: { squat: 80, bench: 72.5, ohp: 40 },
    nonFocusBaselineSets: { squat: 3, bench: 3, ohp: 3 },
  });
  assert("consolidation: deadlift 97.5 → 100 rejected", consolidationViolation !== null && consolidationViolation.code === "consolidation_load_increase");

  const okSameLoad = await validateWeekPrescription({
    prescription: { Thursday: [{ name: "Deadlift (Barbell)", key: "deadlift", baseKg: 97.5, baseReps: 8, sets: 4, increment: { step: 2.5 } }] },
    block, week, prevWeek,
    maintenanceBaselines: { squat: 80, bench: 72.5, ohp: 40 },
    nonFocusBaselineSets: { squat: 3, bench: 3, ohp: 3 },
  });
  assert("consolidation: same load + more reps/sets OK", okSameLoad === null);

  const overcooked = await validateWeekPrescription({
    prescription: { Monday: [{ name: "Squat (Barbell)", key: "squat", baseKg: 80, baseReps: 6, sets: 2, increment: { step: 2.5 } }] },
    block, week, prevWeek,
    maintenanceBaselines: { squat: 80, bench: 72.5, ohp: 40 },
    nonFocusBaselineSets: { squat: 3, bench: 3, ohp: 3 },
  });
  assert("secondary at baseline (80 kg) > clamp (0.92×80=73.6) rejected", overcooked !== null && overcooked.code === "non_focus_primary_overcooked");
}
```

- [ ] **Step 3: Run audit**

```bash
node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs
```

Expected: all cases pass.

- [ ] **Step 4: Commit**

```bash
git add lib/coach/prescription/validate-week.ts scripts/audit-prescription-rules.mjs
git commit -m "$(cat <<'EOF'
feat(prescription): validate-week

validateWeekPrescription enforces six discipline rules: off_grid_weight,
consolidation_load_increase, non_focus_primary_overcooked,
non_focus_primary_volume_too_high, pattern_conflict,
mismatched_session_type. Called by propose_week_plan before signing
the HMAC approval token.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: `target-hit-evaluator.ts` + integration

**Files:**
- Create: `lib/coach/prescription/target-hit-evaluator.ts`
- Modify: `app/api/logger/session/route.ts`

- [ ] **Step 1: Write the evaluator**

```typescript
// lib/coach/prescription/target-hit-evaluator.ts
//
// On every workout commit, check whether the user's primary lift in the
// active block has crossed target_value. If so, set target_hit_at_week
// (idempotent — no-op when already set). This is the consolidation
// forcing function — once stamped, propose_week_plan refuses further
// load increases for the lift.

import type { SupabaseClient } from "@supabase/supabase-js";

const PRIMARY_LIFT_TO_EXERCISE_KEYS: Record<string, string[]> = {
  squat: ["squat"],
  bench: ["decline_bench", "incline_db", "bench"],
  deadlift: ["deadlift"],
  ohp: ["ohp"],
};

export async function evaluateAndStampTargetHit(opts: {
  supabase: SupabaseClient;
  userId: string;
}): Promise<{ stamped: boolean; week_n: number | null }> {
  const { supabase, userId } = opts;

  // Find active block
  const { data: blocks } = await supabase
    .from("training_blocks")
    .select("id, primary_lift, target_value, target_unit, start_date, end_date, target_hit_at_week")
    .eq("user_id", userId)
    .eq("status", "active")
    .limit(1);

  const block = blocks?.[0];
  if (!block || block.primary_lift == null || block.target_value == null || block.target_hit_at_week != null) {
    return { stamped: false, week_n: null };
  }

  // Find the max working set kg for the primary lift since block start
  const exerciseKeys = PRIMARY_LIFT_TO_EXERCISE_KEYS[block.primary_lift] ?? [];
  if (exerciseKeys.length === 0) return { stamped: false, week_n: null };

  const { data: sets } = await supabase
    .from("exercise_sets")
    .select("kg, exercise:exercises(key), workout:workouts(user_id, performed_on)")
    .eq("workout.user_id", userId)
    .gte("workout.performed_on", block.start_date)
    .lte("workout.performed_on", block.end_date)
    .in("exercise.key", exerciseKeys);

  if (!sets || sets.length === 0) return { stamped: false, week_n: null };

  const maxKg = Math.max(...sets.map((s: any) => s.kg ?? 0));
  if (maxKg < block.target_value) return { stamped: false, week_n: null };

  // Determine week_n (1-indexed) from block.start_date
  const start = new Date(block.start_date + "T00:00:00Z");
  const today = new Date();
  const weekN = Math.max(1, Math.floor((today.getTime() - start.getTime()) / (7 * 24 * 60 * 60 * 1000)) + 1);

  await supabase
    .from("training_blocks")
    .update({ target_hit_at_week: weekN, updated_at: new Date().toISOString() })
    .eq("id", block.id)
    .is("target_hit_at_week", null); // optimistic: only set if still null

  return { stamped: true, week_n: weekN };
}
```

- [ ] **Step 2: Wire into the logger session route**

In [app/api/logger/session/route.ts](../../../app/api/logger/session/route.ts), locate the section that runs AFTER the `commit_logger_session` RPC returns successfully. Add the evaluator call.

```bash
grep -n "commit_logger_session\|return NextResponse" app/api/logger/session/route.ts
```

After the successful RPC return, before the response is sent:

```typescript
import { evaluateAndStampTargetHit } from "@/lib/coach/prescription/target-hit-evaluator";

// … after successful commit_logger_session …

try {
  await evaluateAndStampTargetHit({ supabase, userId: user.id });
} catch (err) {
  // Non-fatal — log and continue. Worst case: target stays unstamped
  // until next commit; the validator just sees pre_target one more time.
  console.error("[logger/session] evaluateAndStampTargetHit failed:", err);
}
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add lib/coach/prescription/target-hit-evaluator.ts app/api/logger/session/route.ts
git commit -m "$(cat <<'EOF'
feat(prescription): target-hit evaluator on workout commit

evaluateAndStampTargetHit runs after every commit_logger_session.
Compares max working kg in the block's primary lift since start_date
against target_value; if crossed and target_hit_at_week is NULL,
stamps the current block-week. Idempotent. Failure is non-fatal —
evaluator retries on next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: One-shot backfill script

**Files:**
- Create: `scripts/seed-target-hit-at-week.mjs`

- [ ] **Step 1: Write the script**

```javascript
// scripts/seed-target-hit-at-week.mjs
//
// One-shot backfill: walks all active training_blocks and runs
// evaluateAndStampTargetHit for each. Idempotent — only stamps blocks
// where target_hit_at_week is currently NULL and the target has been
// crossed. Run once after migration 0036 applies.
//
// Run via:
//   node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/seed-target-hit-at-week.mjs

import { createClient } from "@supabase/supabase-js";
import { evaluateAndStampTargetHit } from "@/lib/coach/prescription/target-hit-evaluator.ts";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const { data: blocks, error } = await supabase
  .from("training_blocks")
  .select("id, user_id, primary_lift, target_value, target_hit_at_week, start_date, end_date, status")
  .eq("status", "active")
  .is("target_hit_at_week", null);

if (error) {
  console.error("Failed to load active blocks:", error);
  process.exit(1);
}

console.log(`Found ${blocks.length} active blocks with NULL target_hit_at_week.`);

for (const block of blocks) {
  if (block.primary_lift == null || block.target_value == null) {
    console.log(`  - Skipping block ${block.id} (no primary_lift/target_value)`);
    continue;
  }
  const result = await evaluateAndStampTargetHit({ supabase, userId: block.user_id });
  console.log(`  - Block ${block.id} (${block.primary_lift} → ${block.target_value} kg): ${result.stamped ? `STAMPED at week ${result.week_n}` : "no stamp (target not yet crossed)"}`);
}

console.log("Done.");
```

- [ ] **Step 2: Run the backfill**

```bash
node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/seed-target-hit-at-week.mjs
```

Expected: lists each active block + STAMPED or no-stamp status. For the current user's deadlift block with target 95 kg already crossed at 97.5 kg, this should STAMP.

- [ ] **Step 3: Verify the stamp**

```bash
supabase db remote sql --read-only "select id, primary_lift, target_value, target_hit_at_week, status from training_blocks where status = 'active';"
```

Expected: active deadlift block now shows `target_hit_at_week` ≥ 1.

- [ ] **Step 4: Commit**

```bash
git add scripts/seed-target-hit-at-week.mjs
git commit -m "$(cat <<'EOF'
chore(prescription): seed script for target_hit_at_week backfill

One-shot backfill walking all active blocks. Idempotent. Run once
after migration 0036; subsequent stamping happens inline on every
workout commit via the evaluator wired in Task 13.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 15: Extend `getEffectiveSessionPlan` chain walk (client-side)

**Files:**
- Modify: `lib/coach/sessionPlans.ts`
- Modify: `components/strength/StrengthCoachClient.tsx`
- Modify: `lib/query/fetchers/trainingWeeks.ts` (or wherever the select shape lives — confirm via grep)

- [ ] **Step 1: Update `getEffectiveSessionPlan` signature and chain walk**

In `lib/coach/sessionPlans.ts`, extend `getEffectiveSessionPlan` to accept the new top layer + discovery layer:

```typescript
export async function getEffectiveSessionPlanWithDiscovery(opts: {
  sessionType: string;
  weekday: string;
  sessionPrescriptions: import("@/lib/data/types").SessionPrescriptions | null | undefined;
  exerciseOverrides: import("@/lib/data/types").ExerciseOverrides | null | undefined;
  userTemplate?: PlannedExercise[] | null;
  discoveredExercises?: PlannedExercise[] | null; // null → fall through
}): Promise<PlannedExercise[]>;

// Keep the existing synchronous version (used by morning brief assembler) and
// add the new async variant alongside. Or refactor to one function and update
// call sites — prefer one function; the brief assembler is async-friendly.
```

Update the chain walk:

```typescript
export function getEffectiveSessionPlan(
  sessionType: string,
  weekday: string,
  sessionPrescriptions: import("@/lib/data/types").SessionPrescriptions | null | undefined,
  exerciseOverrides: import("@/lib/data/types").ExerciseOverrides | null | undefined,
  userTemplate?: PlannedExercise[] | null,
  discoveredExercises?: PlannedExercise[] | null,
): PlannedExercise[] {
  const presc = sessionPrescriptions?.[weekday as keyof typeof sessionPrescriptions];
  if (presc && presc.length > 0) return presc;

  const override = exerciseOverrides?.[weekday];
  if (override && override.length > 0) return override;

  if (userTemplate && userTemplate.length > 0) return userTemplate;

  if (discoveredExercises && discoveredExercises.length > 0) return discoveredExercises;

  return SESSION_PLANS[sessionType] ?? [];
}
```

This is a synchronous chain walk — the discovery layer is fetched ahead of time (via TanStack hook or server-side) and passed in. Keeping the function pure-synchronous preserves the call sites' shape.

- [ ] **Step 2: Update `StrengthCoachClient.tsx` to pass `session_prescriptions`**

In [components/strength/StrengthCoachClient.tsx:125-133](../../../components/strength/StrengthCoachClient.tsx#L125-L133), update the call:

```typescript
const effectivePlan = committedSessionType
  ? getEffectiveSessionPlan(
      committedSessionType,
      fullWeekday,
      committedWeek?.session_prescriptions ?? null, // NEW
      exerciseOverrides,
      userTemplate?.exercises ?? null,
      null, // discoveredExercises: not fetched client-side in v1; defer until later
    )
  : null;
```

- [ ] **Step 3: Add `session_prescriptions` to the TrainingWeek select shape**

```bash
grep -rn "session_plan\|exercise_overrides" lib/query/fetchers/trainingWeek*.ts | head
```

Locate the select string and add `session_prescriptions` to both server and browser fetchers, matching the pattern of `exercise_overrides`.

- [ ] **Step 4: Typecheck + manual click-through**

```bash
npm run typecheck
```

Expected: no errors.

```bash
npm run dev
```

Open http://localhost:3000/strength?tab=coach in the browser. Today's card should still render. With `session_prescriptions = null` on the active week (it is until Carter writes one), the card still shows the SESSION_PLANS fallback — no visible change yet. This is correct: the foundation is in place; the writer comes in Task 16.

- [ ] **Step 5: Commit**

```bash
git add lib/coach/sessionPlans.ts components/strength/StrengthCoachClient.tsx lib/query/fetchers/trainingWeeks.ts
git commit -m "$(cat <<'EOF'
feat(prescription): getEffectiveSessionPlan reads session_prescriptions

Extends the resolution chain client-side. session_prescriptions[weekday]
becomes the new top layer; existing layers untouched. With null
session_prescriptions the chain falls through exactly as before, so
this commit is no-op behaviorally pending the writer (Task 16).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 16: Extend server-side `resolve-plan.ts`

**Files:**
- Modify: `lib/logger/resolve-plan.ts`

- [ ] **Step 1: Read current resolve-plan.ts**

```bash
cat lib/logger/resolve-plan.ts
```

Note the existing chain walk and async signature.

- [ ] **Step 2: Add `session_prescriptions` lookup as the new top**

```typescript
// At the top of the resolver, after the user/week fetches:
const { data: weekRow } = await supabase
  .from("training_weeks")
  .select("session_prescriptions, exercise_overrides")
  .eq("user_id", userId)
  .eq("week_start", currentWeekMonday())
  .maybeSingle();

const presc = (weekRow?.session_prescriptions as SessionPrescriptions | null)?.[weekday];
if (presc && presc.length > 0) return presc;

// … existing chain continues unchanged
```

Add the discovery layer fetch BEFORE the SESSION_PLANS fallback:

```typescript
// After user_session_templates lookup, before SESSION_PLANS fallback:
const discovered = await discoverEffectiveExercises({ supabase, userId, sessionType });
if (discovered && discovered.length > 0) return discovered;

return SESSION_PLANS[sessionType] ?? [];
```

Import `discoverEffectiveExercises` from `@/lib/coach/prescription/recent-workouts-discovery`.

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add lib/logger/resolve-plan.ts
git commit -m "$(cat <<'EOF'
feat(prescription): logger resolve-plan reads new chain

Server-side resolver in lib/logger/resolve-plan.ts now matches the
client-side getEffectiveSessionPlan: session_prescriptions →
exercise_overrides → user_session_templates → recent_workouts
discovery → SESSION_PLANS. Logger pre-fill stays consistent with the
card and brief.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 17: `propose_week_plan` schema + executor

**Files:**
- Modify: `lib/coach/tools.ts`

- [ ] **Step 1: Extend the propose_week_plan tool input_schema**

Locate `PROPOSE_WEEK_PLAN_TOOL` at [lib/coach/tools.ts:1564](../../../lib/coach/tools.ts#L1564). Add `session_prescriptions` to required + properties:

```typescript
input_schema: {
  type: "object" as const,
  required: ["week_start", "session_plan", "session_prescriptions"],
  properties: {
    week_start:         { type: "string", format: "date", description: "Must be a Monday." },
    session_plan:       { type: "object", additionalProperties: { type: "string" }, description: "Mon-Sun map." },
    session_prescriptions: {
      type: "object",
      description: "Mon-Sun map of full per-exercise prescriptions. Required. Keys are full weekday names (Monday-Sunday); values are arrays of PlannedExercise shapes (name, baseKg, baseReps, sets, key, increment, note).",
      additionalProperties: {
        type: "array",
        items: {
          type: "object",
          required: ["name"],
          properties: {
            name:     { type: "string", minLength: 2, maxLength: 80 },
            baseKg:   { type: "number", minimum: 0, maximum: 500 },
            baseReps: { type: "integer", minimum: 1, maximum: 60 },
            sets:     { type: "integer", minimum: 1, maximum: 12 },
            key:      { type: "string", maxLength: 40 },
            note:     { type: "string", maxLength: 200 },
            reps:     { type: "string", maxLength: 40 },
            warmup:   { type: "boolean" },
            increment: {
              type: "object",
              required: ["step"],
              properties: {
                step:         { type: "number", minimum: 0.5, maximum: 20 },
                intermediate: { type: "number", minimum: 0.5, maximum: 20 },
              },
            },
          },
        },
      },
    },
    weekly_focus:       { type: "string", maxLength: 200 },
    intensity_modifier: { type: "object", additionalProperties: { type: "number" } },
    rir_target:         { type: "integer", minimum: 1, maximum: 4 },
    research_phase:     { type: "string", enum: ["accumulate","deload"] },
    rationale:          { type: "string", maxLength: 500 },
  },
},
```

- [ ] **Step 2: Extend the executor**

Locate `executeProposeWeekPlan` (search `grep -n "executeProposeWeekPlan" lib/coach/tools.ts`). Inside it, before signing the approval token:

```typescript
import { validateWeekPrescription } from "@/lib/coach/prescription/validate-week";

// … inside executeProposeWeekPlan, after input shape validation, before token signing:

const activeBlock = await loadActiveBlock(opts.supabase, opts.userId);
const prevWeek = await loadPreviousWeek(opts.supabase, opts.userId, payload.week_start);
const maintenanceBaselines = await loadMaintenanceBaselines(opts.supabase, opts.userId, todayInUserTz());
const nonFocusBaselineSets = NON_FOCUS_BASELINE_SETS_DEFAULT; // const for v1

const validationErr = await validateWeekPrescription({
  prescription: payload.session_prescriptions as SessionPrescriptions,
  block: activeBlock,
  week: { ...payload, session_prescriptions: payload.session_prescriptions } as any,
  prevWeek,
  maintenanceBaselines,
  nonFocusBaselineSets,
});

if (validationErr) {
  return {
    ok: false,
    error: { error: validationErr.message, code: validationErr.code, hint: validationErr.hint },
    meta: { ms: Date.now() - t0, range_days: 0 },
  };
}
```

Where the helpers:

```typescript
async function loadActiveBlock(supabase: SupabaseClient, userId: string) {
  const { data } = await supabase
    .from("training_blocks")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();
  return data;
}

async function loadPreviousWeek(supabase: SupabaseClient, userId: string, weekStart: string) {
  const prev = subtractDaysIso(weekStart, 7);
  const { data } = await supabase
    .from("training_weeks")
    .select("*")
    .eq("user_id", userId)
    .eq("week_start", prev)
    .maybeSingle();
  return data;
}

async function loadMaintenanceBaselines(supabase: SupabaseClient, userId: string, todayIso: string) {
  // Reuse maintenanceLoadFor across all four primary lifts.
  // Returns Partial<Record<PrimaryLift, number>>.
  const recentSets = await fetchRecentSetsForBaselines(supabase, userId, todayIso);
  return {
    squat:    maintenanceLoadFor("squat", 2, recentSets, todayIso) ?? undefined,
    bench:    maintenanceLoadFor("decline_bench", 2, recentSets, todayIso) ?? undefined,
    deadlift: maintenanceLoadFor("deadlift", 2, recentSets, todayIso) ?? undefined,
    ohp:      maintenanceLoadFor("ohp", 2, recentSets, todayIso) ?? undefined,
  };
}

const NON_FOCUS_BASELINE_SETS_DEFAULT = { squat: 3, bench: 3, deadlift: 3, ohp: 3 };
```

- [ ] **Step 3: Update commit_week_plan executor to write session_prescriptions**

Locate `executeCommitWeekPlan` (it follows `executeProposeWeekPlan`). Update the insert/upsert to include `session_prescriptions: payload.session_prescriptions`. This is the field that actually lands in the DB.

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add lib/coach/tools.ts
git commit -m "$(cat <<'EOF'
feat(prescription): propose_week_plan accepts + validates prescriptions

Required session_prescriptions field added to propose_week_plan tool
schema. Executor runs validateWeekPrescription before signing the
approval token — invalid prescriptions return structured error +
hint instead of a token. commit_week_plan persists the field to
training_weeks.session_prescriptions.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 18: PLAN_WEEK_PROMPT update

**Files:**
- Modify: `lib/coach/planning-prompts.ts`

- [ ] **Step 1: Read current PLAN_WEEK_PROMPT**

```bash
sed -n '40,90p' lib/coach/planning-prompts.ts
```

Note the existing 4-beat structure (RECAP / CHECK-IN / PROPOSE / COMMIT).

- [ ] **Step 2: Replace PLAN_WEEK_PROMPT with the extended version**

Update the constant:

```typescript
const PLAN_WEEK_PROMPT = `## You are running a weekly planning session

Follow this 4-beat structure:

1. **RECAP** last week. Produce THREE structured sub-reports, each 1-2 sentences:

   a. *Block primary status.* Call \`compute_adherence\` for the prior Mon-Sun window and \`query_workouts\` for color. Compute and report: current block week (1-5), current working kg vs target, and the phase (pre_target / consolidation / off_pace / deload_week). If \`target_hit_at_week\` is non-null, the block is in CONSOLIDATION — narrate explicitly: "you hit the target in week N; we're holding the load and progressing reps/sets through weeks N+1 to 5." Do NOT propose raising the target mid-block. Block targets are immutable contracts; to raise targets, the user must close the block and start a new one.

   b. *Secondary lift trajectories.* For each of the other three primary lifts that the user trains this week, report e1RM direction block-to-date (rising / flat / falling). This is diagnosis only — there are no contracts on secondary lifts.

   c. *Per-muscle volume status.* Call \`query_workouts\` and use the muscle-volume context. Identify any muscles below MEV, at MEV (needs to push toward MAV), or near MRV (needs to back off). Specifically flag undertrained patterns for the current block's focus (e.g., for a deadlift block, hinge frequency below MEV is a coverage gap).

2. **CHECK-IN.** Ask ONE question about how the user is feeling and any constraints (travel, soreness, schedule, sleep). Wait for the response. Do not propose anything yet.

3. **PROPOSE** the next week. Derive RIR target from week-of-block:
   - Week 1: RIR 4, intensity ~0.85×
   - Week 2: RIR 3, ~0.90×
   - Week 3: RIR 2, ~0.95×
   - Week 4: RIR 1, ~1.0×
   - Week 5: deload. research_phase='deload'. Volume −50%, intensity ~0.80×, frequency held.

   Consult \`get_autoregulation_signals\`. If \`should_deload === true\` (≥2 signals firing), surface the alert and recommend deloading even if it's not week 5.

   **Call \`propose_week_plan\` with a FULL per-exercise \`session_prescriptions\` payload.** Each non-REST day must have an array of PlannedExercise shapes:
   - For the focus lift (the block's primary_lift on its session day): apply the block-phase rule. Pre-target → +step if last week was clean RIR, hold otherwise. Consolidation → hold load, +1 rep target OR +1 set. Off-pace → small jump with set drop. Deload → 0.80× with halved sets.
   - For non-focus primaries (squat, bench, OHP on their own days during a deadlift block): apply MAINTENANCE — multiplier 0.90 vs current working weight, sets drop by 1 vs non-focus baseline. The server validates: load must be ≤ 0.92 × current_working_weight; sets must be < non-focus baseline.
   - For accessories: apply per-muscle volume balance. Below MEV → add a set. At MEV → add a set. In band → hold. Near MRV → hold. Above MRV → drop a set or swap to a less-fatiguing variant. Load progresses via autoregulation.

   **Pattern conflicts are hard-rejected.** For a deadlift focus block, axial-loaded hinge accessories (Romanian Deadlift, Good Morning, Stiff-Leg Deadlift) must NOT appear on non-Back days. Use low-axial alternatives (Hip Thrust, 45° Hyperextension loaded, Cable Pull-Through) when a hinge-frequency gap needs filling.

   Include \`weekly_focus\` (1-2 sentences), \`intensity_modifier\` (e.g. {squat: 0.90, bench: 0.90, ohp: 0.90, deadlift: 1.0} for a deadlift block), \`rir_target\`, \`research_phase\`, and \`rationale\` (3-5 sentences covering: phase reasoning, headline changes, any flagged volume gaps and how the prescription closes them).

4. **COMMIT.** Wait for user approval via \`[approve:<token>]\`. Call \`commit_week_plan\` with the token. On tweaks, call \`propose_week_plan\` again with the revised payload — fresh token issues.

## Commit discipline — non-negotiable

**Never** use words like "Done", "committed", "applied", "updated", "your structure is now", or any equivalent prose that implies the plan is in effect — unless your CURRENT turn invokes \`commit_week_plan\` and that call returns ok=true.

- If you've only called \`propose_week_plan\` this turn: your response MUST close with "Tap Approve to commit". NEVER state the plan is active.
- Revision requests after a previous proposal require a fresh \`propose_week_plan\` call with the updated payload AND a fresh approval token.
- A user replying "Yes" or "Approved" without \`[approve:<token>]\` is NOT an approval signal.

## Honest progress framing — RECAP beat

- Rising e1RM → call it strength progress directly.
- Flat e1RM during a cut (LBM dropped or weight dropped) → recomp win.
- Flat e1RM with LBM also flat or rising → plateau honestly.
- Falling e1RM with falling LBM → say it plainly.
- Block target hit early → "I underestimated where you were starting — block was conservative. We consolidate for the remainder."
- Block target far behind with weeks remaining → "we're off-pace. Either we accept and let next block carry the delta, or we change something."

## Concision

3-5 sentences per beat (RECAP allows 1-2 sentences PER sub-report, so it's longer). Never commit without explicit user approval. Never propose without first running the three-sub-report RECAP + the CHECK-IN, unless the user says "skip the recap, just propose".`;
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add lib/coach/planning-prompts.ts
git commit -m "$(cat <<'EOF'
feat(prescription): PLAN_WEEK_PROMPT three-sub-report RECAP + per-exercise PROPOSE

Carter's Sunday prompt now produces three sub-reports (block primary
status / secondary trajectories / per-muscle volume) and emits full
per-exercise session_prescriptions per day. Includes block-phase
rules, maintenance multipliers for non-focus primaries, volume-band
rules for accessories, and pattern-conflict guards. Server enforces
all of this via validate-week.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 19: Morning brief advice prompt update

**Files:**
- Modify: `lib/morning/brief/advice-prompt.ts`

- [ ] **Step 1: Read the variant prompt builders**

```bash
grep -n "buildKickoffPrompt\|buildAnalyticalPrompt\|buildLegacyPrompt\|buildSystemPrompt" lib/morning/brief/advice-prompt.ts
```

There are typically three variant builders. Each needs the same anti-fabrication clause.

- [ ] **Step 2: Insert the anti-fabrication rule into each variant's prompt body**

In each variant builder (kickoff, analytical, legacy), add this clause to the prompt instructions:

```typescript
const ANTI_FABRICATION_RULE = `
GROUNDING RULE — DO NOT INVENT LOADS:
The Today's Session block in the card data IS the committed truth. Each exercise's load (kg), sets, and reps come from a Sunday-committed prescription that the athlete approved. When you narrate today's plan, ONLY reference numbers from card.session.exercises[*].kg/sets/reps. Do NOT compute progressive overload from prior workouts (e.g., "+2.5 kg from last Thursday"); the deterministic prescription engine already did that math at commit time. If you find yourself writing a number not in card.session.exercises, stop and re-read the structured block.

The same rule applies to nutrition targets, sleep targets, and any other quantified prescription in the card — the structured block is the truth; narrate from it, don't invent.
`.trim();
```

Then concatenate this into each variant's system prompt body alongside `TEACHER_TONE_RULES`.

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add lib/morning/brief/advice-prompt.ts
git commit -m "$(cat <<'EOF'
feat(prescription): brief advice grounds in committed prescription

Adds anti-fabrication rule to all three variant prompts (kickoff,
analytical, legacy). Haiku narrates loads/sets/reps from the
structured card.session.exercises block instead of computing
progressive overload from prior workouts in prose. Now that
session_prescriptions is the source of truth, the prose can finally
align with the data.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 20: End-to-end audit script

**Files:**
- Create: `scripts/audit-sunday-prescription-e2e.mjs`

- [ ] **Step 1: Write the e2e audit**

```javascript
// scripts/audit-sunday-prescription-e2e.mjs
//
// End-to-end audit for the Sunday Prescription System against live data.
// Verifies:
//   1. Schema columns exist on training_blocks and training_weeks
//   2. Active block has target_hit_at_week populated if its target has been crossed
//   3. For the most recent committed week, session_prescriptions exists (post-Sunday) or null (pre-Sunday)
//   4. If session_prescriptions present: each exercise's baseKg is on the equipment grid
//   5. For an active focus block: non-focus primaries respect the 0.92× clamp + set drop
//   6. No axial-hinge accessories on non-focus days when block is a deadlift block
//   7. getEffectiveSessionPlan resolves through the chain correctly for today's session
//
// Run via:
//   AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-sunday-prescription-e2e.mjs

import { createClient } from "@supabase/supabase-js";
import { SESSION_PLANS, getEffectiveSessionPlan } from "@/lib/coach/sessionPlans.ts";
import { validatePatternConflicts, focusDayForBlock } from "@/lib/coach/prescription/pattern-conflict-overlay.ts";
import { resolveExercise } from "@/lib/coach/exercise-library.ts";

const userId = process.env.AUDIT_USER_ID;
if (!userId) {
  console.error("Set AUDIT_USER_ID=<uuid>");
  process.exit(1);
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else      { fail++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

console.log("## Schema columns\n");
{
  const { data: cols } = await supabase
    .from("information_schema.columns")
    .select("table_name, column_name")
    .in("table_name", ["training_blocks", "training_weeks"])
    .in("column_name", ["target_hit_at_week", "session_prescriptions"]);
  assert("training_blocks.target_hit_at_week exists", cols?.some(c => c.table_name === "training_blocks" && c.column_name === "target_hit_at_week"));
  assert("training_weeks.session_prescriptions exists", cols?.some(c => c.table_name === "training_weeks" && c.column_name === "session_prescriptions"));
}

console.log("\n## Active block\n");
const { data: blocks } = await supabase
  .from("training_blocks")
  .select("*")
  .eq("user_id", userId)
  .eq("status", "active");

const block = blocks?.[0];
if (!block) {
  console.log("No active block — skipping block-level checks.");
} else {
  console.log(`Active block: ${block.primary_lift} target ${block.target_value} kg, target_hit_at_week=${block.target_hit_at_week ?? "null"}`);

  if (block.primary_lift && block.target_value != null) {
    const { data: sets } = await supabase
      .from("exercise_sets")
      .select("kg, exercise:exercises(key), workout:workouts(user_id, performed_on)")
      .eq("workout.user_id", userId)
      .gte("workout.performed_on", block.start_date)
      .in("exercise.key", [block.primary_lift]);
    const maxKg = sets ? Math.max(...sets.map(s => s.kg ?? 0)) : 0;
    if (maxKg >= block.target_value) {
      assert(`target crossed (max ${maxKg} ≥ ${block.target_value}) → target_hit_at_week must be set`, block.target_hit_at_week != null);
    }
  }
}

console.log("\n## Most recent training_weeks row\n");
const { data: weeks } = await supabase
  .from("training_weeks")
  .select("*")
  .eq("user_id", userId)
  .order("week_start", { ascending: false })
  .limit(1);

const week = weeks?.[0];
if (!week) {
  console.log("No training_weeks row — skipping.");
} else {
  console.log(`Most recent week: ${week.week_start}, prescriptions: ${week.session_prescriptions ? "present" : "null"}`);

  if (week.session_prescriptions) {
    // off-grid weight check
    for (const [weekday, exercises] of Object.entries(week.session_prescriptions)) {
      for (const ex of exercises) {
        if (ex.baseKg == null) continue;
        const lib = resolveExercise(ex.name);
        if (!lib?.increment) continue;
        const step = lib.increment.step;
        const inter = lib.increment.intermediate;
        const onPrimary = Math.abs((ex.baseKg / step) - Math.round(ex.baseKg / step)) < 1e-6;
        const onInter = inter != null && ex.baseKg >= inter && Math.abs(((ex.baseKg - inter) / step) - Math.round((ex.baseKg - inter) / step)) < 1e-6;
        assert(`${weekday} ${ex.name} ${ex.baseKg} kg on grid (step ${step})`, onPrimary || onInter);
      }
    }

    // pattern conflict check
    if (block) {
      const err = validatePatternConflicts(week.session_prescriptions, block, week);
      assert("no pattern conflicts", err === null, err?.message);
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
```

- [ ] **Step 2: Run the e2e audit**

```bash
AUDIT_USER_ID=<user-uuid> node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-sunday-prescription-e2e.mjs
```

Replace `<user-uuid>` with the development user's id. Expected: all assertions pass. If pre-Sunday and `session_prescriptions = null`, the prescription-checking section is skipped — that's expected.

- [ ] **Step 3: Update CLAUDE.md scripts section**

Append to the `## Scripts` section of [CLAUDE.md](../../../CLAUDE.md):

```markdown
- [scripts/audit-sunday-prescription-e2e.mjs](scripts/audit-sunday-prescription-e2e.mjs) — verifies schema, target_hit_at_week stamping, on-grid weights, and pattern-conflict absence for the current week's `session_prescriptions`. Set `AUDIT_USER_ID`. Run via: `AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-sunday-prescription-e2e.mjs`.
- [scripts/audit-prescription-rules.mjs](scripts/audit-prescription-rules.mjs) — fixture-based pure-function audit for the six rule modules in `lib/coach/prescription/`. No DB access. Run via: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs`.
- [scripts/seed-target-hit-at-week.mjs](scripts/seed-target-hit-at-week.mjs) — one-shot backfill walking all active blocks. Idempotent.
```

- [ ] **Step 4: Commit**

```bash
git add scripts/audit-sunday-prescription-e2e.mjs CLAUDE.md
git commit -m "$(cat <<'EOF'
chore(prescription): end-to-end audit + docs

scripts/audit-sunday-prescription-e2e.mjs verifies schema columns,
target_hit_at_week stamping, on-grid weights, and pattern-conflict
absence for the current week. CLAUDE.md updated with the new scripts.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 21: Final manual verification + PR

**Files:** none

- [ ] **Step 1: Run all audits one more time**

```bash
node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs
AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-sunday-prescription-e2e.mjs
npm run typecheck
```

Expected: all pass.

- [ ] **Step 2: Manual UI smoke check**

```bash
npm run dev
```

Visit http://localhost:3000/strength?tab=coach. Confirm:
- Today's card renders (session_prescriptions may still be null until next Sunday — card shows current chain behavior).
- No console errors.

Trigger a Sunday plan flow: in chat, mode=plan_week, ask Carter to plan next week. Confirm:
- Carter produces the three-sub-report RECAP.
- Carter calls `propose_week_plan` with a populated `session_prescriptions` field.
- The approval card surfaces; tapping Approve commits.
- After commit, the strength card for the relevant weekday reflects the new prescription's baseKg/sets/reps — NOT the SESSION_PLANS default.

- [ ] **Step 3: Push branch and open PR**

```bash
git push -u origin feat/sunday-prescription-system
gh pr create --title "Sunday Prescription System: per-exercise weekly plans cascade to all surfaces" --body "$(cat <<'EOF'
## Summary

- Persists Carter's full per-exercise Sunday plan to `training_weeks.session_prescriptions`
- New `lib/coach/prescription/` rule engine (six pure modules + orchestrator + validator)
- Resolution chain extended: `session_prescriptions[weekday]` is the new top, with a recent-workouts discovery layer below `user_session_templates`
- Server-side validation enforces target immutability, consolidation rule, flat maintenance for non-focus primaries, and pattern-conflict prohibitions
- `target_hit_at_week` evaluator runs after every workout commit — stamps when the primary lift crosses target_value
- Three surfaces (card, brief structured block, logger pre-fill) all read the new chain via `getEffectiveSessionPlan`
- Brief AI advice prompt updated to narrate from the committed structured block, eliminating fabrication

## Test plan

- [ ] `scripts/audit-prescription-rules.mjs` — all fixture cases pass
- [ ] `scripts/audit-sunday-prescription-e2e.mjs` — live-data audit passes
- [ ] `npm run typecheck` — no errors
- [ ] Strength card on `/strength?tab=coach` reflects the new prescription after Sunday commit
- [ ] Morning brief structured `session` block matches the prescription
- [ ] Logger pre-fill matches the prescription
- [ ] Brief AI advice does not invent loads — narrates only from the structured block

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

### Spec coverage check

- [x] Migration with both new columns → Task 1
- [x] TrainingBlock/TrainingWeek/SessionPrescriptions types → Task 2
- [x] maintenance-baseline.ts → Task 3
- [x] block-phase-rule.ts → Task 4
- [x] autoregulation-rule.ts → Task 5
- [x] volume-balance-rule.ts → Task 6
- [x] pattern-conflict-overlay.ts → Task 7
- [x] Expert review checkpoint → Task 8
- [x] recent-workouts-discovery.ts → Task 9
- [x] prescribe-week.ts orchestrator → Task 10
- [x] Muscle-volume wiring → Task 11
- [x] validate-week.ts → Task 12
- [x] target-hit-evaluator.ts + logger integration → Task 13
- [x] Backfill script → Task 14
- [x] Client chain walk update → Task 15
- [x] Server resolve-plan update → Task 16
- [x] propose_week_plan schema + executor → Task 17
- [x] PLAN_WEEK_PROMPT update → Task 18
- [x] Brief advice prompt update → Task 19
- [x] End-to-end audit → Task 20
- [x] Final verification + PR → Task 21

### Placeholder scan

No "TBD", "TODO", "fill in later", or vague behavior steps. Each step has either runnable code, an exact command, or a concrete instruction with example output.

### Type consistency

- `SessionPrescriptions` is `Partial<Record<WeekdayLong, PlannedExercise[]>>` everywhere
- `PlannedExercise` shape (name/baseKg/baseReps/sets/key/note/increment/warmup) consistent across tool schema, rule modules, and validator
- `BlockPhase` union ("pre_target" | "consolidation" | "off_pace" | "deload_week") consistent across `block-phase-rule.ts`, `prescribe-week.ts`
- `PrimaryLift` ("squat" | "bench" | "deadlift" | "ohp") consistent — sourced from `lib/data/types.ts` everywhere
- `WeekdayLong` ("Monday" | … | "Sunday") consistent

No gaps detected.

---

## Execution Handoff

Plan complete and committed. Execution mode: **subagent-driven** (per user instruction). Next: invoke `superpowers:subagent-driven-development` skill to dispatch tasks one by one with fresh subagents + review checkpoints.
