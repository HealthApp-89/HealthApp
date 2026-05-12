# GLP-1-aware nutrition module — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a GLP-1-aware nutrition mode to `plan_payload`, plus the classical phase-of-phases (diet breaks + reverse) for post-GLP-1 plans, plus three runtime modes + three chat tools + a /profile lab-prompt card.

**Architecture:** `plan_payload.nutrition` gains two nullable top-level fields (`glp1` and `classical_phases`). `getTodayTargets()` resolves the runtime mode (`glp1_active | glp1_tapering | classical | steady_state`) from those fields + today's date + day-type. Brief, plan card, and profile renderer branch on mode. New chat tools handle mode transitions.

**Tech Stack:** TypeScript strict, Next.js 15 App Router, Supabase, Anthropic SDK (Sonnet 4.6 / Haiku 4.5), Tailwind v4. No new deps.

**Spec:** [docs/superpowers/specs/2026-05-12-glp1-aware-nutrition-design.md](docs/superpowers/specs/2026-05-12-glp1-aware-nutrition-design.md)

**Branch:** `feat/glp1-aware-nutrition` (already cut from main as of spec commit).

---

## Task 1: Migration 0012 — `profiles.lab_acknowledgments`

**Files:**
- Create: `supabase/migrations/0012_lab_acknowledgments.sql`

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/0012_lab_acknowledgments.sql
-- Adds a jsonb column to profiles holding lab/check acknowledgment state
-- for the GLP-1 lab-prompt card. Shape:
--   {
--     "b12_baseline": "2026-05-12",          -- ISO timestamp when acknowledged
--     "vit_d_baseline": "2026-05-12",
--     "magnesium_baseline": "2026-05-12",
--     "ferritin_baseline": "2026-05-12",
--     "b12_6mo": null,                        -- not yet acknowledged
--     "grip_strength_2026_q2": "2026-05-15",  -- quarterly slot
--     "bone_density_12mo": null
--   }
--
-- Keys are app-defined; the column is a free-form jsonb to allow Phase 3
-- to add new check slots without schema changes.

ALTER TABLE profiles
  ADD COLUMN lab_acknowledgments jsonb NOT NULL DEFAULT '{}'::jsonb;
```

- [ ] **Step 2: Apply via supabase CLI**

```bash
cd "/Users/abdelouahedelbied/Health app"
supabase db push
```

Expected: migration applied successfully. If repair is needed, run `supabase migration repair --status applied <history>` per CLAUDE.md.

- [ ] **Step 3: Verify via DB**

```bash
cd "/Users/abdelouahedelbied/Health app"
# Manual: in Supabase Dashboard SQL Editor:
# select column_name, data_type, column_default from information_schema.columns
# where table_name='profiles' and column_name='lab_acknowledgments';
```

Expected one row: `lab_acknowledgments | jsonb | '{}'::jsonb`.

- [ ] **Step 4: Commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
git add supabase/migrations/0012_lab_acknowledgments.sql
git commit -m "feat(db): 0012 — profiles.lab_acknowledgments jsonb column

Stores acknowledgment timestamps for the GLP-1 lab-prompt card's
slots (B12, vit D, Mg, ferritin, grip strength, bone density).
Free-form jsonb so Phase 3 can add new check slots without
schema changes.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: TypeScript types — Glp1Config, PhaseStep, RestDayDelta, IntakePayload extension, PlanPayload.nutrition extension, TodayTargets extension

**Files:**
- Modify: `lib/data/types.ts`

- [ ] **Step 1: Add new types after existing PlanPayload definitions**

Find the `IntakePayload` definition (`grep -n "export type IntakePayload" lib/data/types.ts`). Extend `health` block:

```ts
// Inside IntakePayload['health']:
  glp1_status?: {
    medication: "semaglutide" | "tirzepatide" | "compounded";
    dose_mg: number;
    injection_day: "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";
    injection_time: "morning" | "evening" | "night";
    started_on: string;                  // ISO YYYY-MM-DD
    expected_taper_start: string | null;
    expected_end: string | null;
    doctor_protocol_notes: string | null;
  } | null;
```

- [ ] **Step 2: Extend PlanPayload.nutrition**

Find the `nutrition` block inside `PlanPayload` (around line 519). Add three new fields:

```ts
// Inside PlanPayload['nutrition'], add after the existing fields:
    glp1: {
      medication: "semaglutide" | "tirzepatide" | "compounded";
      dose_mg: number;
      injection_day: "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";
      injection_time: "morning" | "evening" | "night";
      started_on: string;
      expected_taper_start: string | null;
      taper_started_on: string | null;
      expected_end: string | null;
      deficit_alarm_pct: number;
      deficit_alarm_kcal: number;
      protein_g_per_kg_bw: number;
      per_meal_protein_floor_g: number;
      hydration_training_day_ml: number;
      sodium_training_day_mg: number;
      tdee_estimate_kcal: number;        // cached at composer time
    } | null;

    classical_phases: Array<{
      start_week: number;
      end_week: number;
      mode: "cut" | "diet_break" | "reverse" | "maintain";
      kcal: number;
      protein_g: number;
      carb_g: number;
      fat_g: number;
      rationale: string;
    }> | null;

    rest_day_delta: {
      kcal: number;
      carb_g: number;
      fat_g: number;
    } | null;
```

- [ ] **Step 3: Export named types for re-use across modules**

At the top of `lib/data/types.ts` after the existing exports, add:

```ts
export type Glp1Config = NonNullable<PlanPayload["nutrition"]["glp1"]>;
export type Glp1Status = NonNullable<IntakePayload["health"]["glp1_status"]>;
export type PhaseStep = NonNullable<PlanPayload["nutrition"]["classical_phases"]>[number];
export type RestDayDelta = NonNullable<PlanPayload["nutrition"]["rest_day_delta"]>;
export type ResolvedNutritionMode = "glp1_active" | "glp1_tapering" | "classical" | "steady_state";
```

- [ ] **Step 4: Extend TodayTargets in `lib/morning/brief/get-today-targets.ts` types-only**

Open `lib/morning/brief/get-today-targets.ts`. Extend the `TodayTargets` type:

```ts
import type { ResolvedNutritionMode } from "@/lib/data/types";

export type TodayTargets = {
  // existing
  kcal: number;
  protein_g: number;
  carb_g: number;
  fat_g: number;
  bedtime: string;
  sleep_hours_target: number;
  phase: "cut" | "maintain" | "lean_bulk" | "recomp" | "unsure";
  source: "plan" | "intake";

  // NEW
  mode: ResolvedNutritionMode;
  is_training_day: boolean;
  deficit_alarm: {
    threshold_kcal_per_day: number;
    rolling_7d_avg_intake: number | null;
    rolling_7d_avg_deficit: number | null;
    triggered: boolean;
  } | null;
  hydration_target_ml: number | null;
  sodium_target_mg: number | null;
};
```

The actual resolution logic comes in Task 4; this step is types-only.

- [ ] **Step 5: Run typecheck**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
```

Expected: callers of `TodayTargets` in `lib/morning/brief/assembler.ts` may now show missing-property errors for the new fields. That's intentional; Task 4 fixes them. For this commit, populate the new fields with reasonable defaults in the existing fallback paths in `get-today-targets.ts` so typecheck passes:

```ts
// In the Phase 1 fallback branch (no plan_payload):
return {
  // ... existing fields ...
  mode: "steady_state",
  is_training_day: false,
  deficit_alarm: null,
  hydration_target_ml: null,
  sodium_target_mg: null,
};

// In the Phase 2 fallback branch (plan but no glp1/classical):
return {
  // ... existing fields ...
  mode: "steady_state",
  is_training_day: false,
  deficit_alarm: null,
  hydration_target_ml: null,
  sodium_target_mg: null,
};
```

Re-run typecheck. Must pass clean.

- [ ] **Step 6: Commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
git add lib/data/types.ts lib/morning/brief/get-today-targets.ts
git commit -m "feat(types): GLP-1-aware nutrition — Glp1Config, PhaseStep, RestDayDelta

IntakePayload.health.glp1_status: optional structured object captured
in Beat 3 of the intake chat. Tracks medication, dose, schedule,
expected taper milestones.

PlanPayload.nutrition gains 3 nullable fields:
  - glp1: GLP-1 mode config (present → glp1_active or glp1_tapering)
  - classical_phases: phase sequence (present → classical mode)
  - rest_day_delta: training/rest day macro shift (classical mode)

TodayTargets extends with:
  - mode (ResolvedNutritionMode discriminator)
  - is_training_day
  - deficit_alarm (GLP-1 mode only)
  - hydration_target_ml + sodium_target_mg (GLP-1 + training day)

Schema_version stays at 1 — all additions are nullable jsonb fields.
Existing Phase 2 plans without glp1/classical_phases resolve to
steady_state at runtime.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: compose-nutrition.ts — branch on glp1_status + 4 new helpers

**Files:**
- Modify: `lib/coach/plan-builder/compose-nutrition.ts`

- [ ] **Step 1: Read existing composer to confirm shape**

```bash
cd "/Users/abdelouahedelbied/Health app"
wc -l lib/coach/plan-builder/compose-nutrition.ts
grep -nE "^export function|^function" lib/coach/plan-builder/compose-nutrition.ts
```

The existing `composeNutrition(intake)` (or whatever name it bears) returns the full `nutrition` sub-object. We're adding a branch at the top.

- [ ] **Step 2: Add `composeGlp1Config` helper**

Append to `lib/coach/plan-builder/compose-nutrition.ts`:

```ts
import type { Glp1Status, Glp1Config, IntakePayload } from "@/lib/data/types";

function estimateTdeeKcal(intake: IntakePayload, currentBodyweightKg: number): number {
  // Mifflin-St Jeor RMR for males:
  //   RMR = 10 × kg + 6.25 × cm − 5 × age + 5
  // Apply activity factor 1.5 (intermediate lifter, 3-4×/wk).
  // If age or height missing, fall back to a conservative 32 × kg.
  const age = (intake as { age?: number }).age ?? null;
  const heightCm = (intake.lifestyle as { height_cm?: number }).height_cm ?? null;
  if (age == null || heightCm == null) {
    return Math.round(32 * currentBodyweightKg);
  }
  const rmr = 10 * currentBodyweightKg + 6.25 * heightCm - 5 * age + 5;
  return Math.round(rmr * 1.5);
}

export function composeGlp1Config(
  status: Glp1Status,
  intake: IntakePayload,
  currentBodyweightKg: number,
): Glp1Config {
  // Protein floor by medication:
  //   semaglutide → 1.8 g/kg actual BW
  //   tirzepatide → 2.0 g/kg actual BW
  //   compounded  → 1.8 (conservative — assume semaglutide-like)
  const proteinFloor =
    status.medication === "tirzepatide" ? 2.0 : 1.8;

  return {
    medication: status.medication,
    dose_mg: status.dose_mg,
    injection_day: status.injection_day,
    injection_time: status.injection_time,
    started_on: status.started_on,
    expected_taper_start: status.expected_taper_start,
    taper_started_on: null,
    expected_end: status.expected_end,
    deficit_alarm_pct: 0.25,
    deficit_alarm_kcal: 700,
    protein_g_per_kg_bw: proteinFloor,
    per_meal_protein_floor_g: 25,
    hydration_training_day_ml: 3500,
    sodium_training_day_mg: 1000,
    tdee_estimate_kcal: estimateTdeeKcal(intake, currentBodyweightKg),
  };
}
```

- [ ] **Step 3: Add `composePhaseSequence` helper**

```ts
import type { PhaseStep } from "@/lib/data/types";

export function composePhaseSequence(args: {
  current_phase: "cut" | "maintain" | "lean_bulk" | "recomp" | "unsure";
  goal_target_date: string;
  acknowledged_on: string | null;
  bodyweight_kg: number;
  bodyweight_kg_protein_factor: number;  // 1.6 default (post-GLP-1 user is back on doctor's number)
}): PhaseStep[] | null {
  // Only cut gets a phase sequence; other phases stay single-state.
  if (args.current_phase !== "cut") return null;

  const ackDate = args.acknowledged_on
    ? new Date(args.acknowledged_on)
    : new Date();
  const targetDate = new Date(args.goal_target_date);
  const weeksToGoal = Math.max(
    4,
    Math.floor((targetDate.getTime() - ackDate.getTime()) / (7 * 86_400_000)),
  );

  // Baseline cut macros (1.6 g/kg BW protein for classical mode).
  const proteinG = Math.round(args.bodyweight_kg * args.bodyweight_kg_protein_factor);
  const cutKcal = Math.round(estimateMaintenance(args.bodyweight_kg) * 0.80);  // 20% deficit
  const cutCarbG = Math.round((cutKcal - proteinG * 4 - 55 * 9) / 4);
  const cutFatG = 55;

  // Build sequence: 8-week cut blocks separated by 2-week diet breaks,
  // ending in a 4-week reverse, then maintain.
  const out: PhaseStep[] = [];
  let week = 0;
  let cutBlockNo = 0;

  // Reserve last 4 weeks for reverse + open-ended maintain.
  const cuttingWindow = Math.max(0, weeksToGoal - 4);

  while (week < cuttingWindow) {
    const cutEnd = Math.min(week + 8, cuttingWindow);
    out.push({
      start_week: week,
      end_week: cutEnd,
      mode: "cut",
      kcal: cutKcal,
      protein_g: proteinG,
      carb_g: cutCarbG,
      fat_g: cutFatG,
      rationale: cutBlockNo === 0
        ? "Cut phase — 20% deficit, protein floor 1.6 g/kg BW"
        : `Cut block ${cutBlockNo + 1} — sustained deficit after diet break`,
    });
    cutBlockNo += 1;
    week = cutEnd;

    // Insert a diet break if there's enough runway for another cut block.
    if (week + 2 < cuttingWindow) {
      out.push({
        start_week: week,
        end_week: week + 2,
        mode: "diet_break",
        kcal: cutKcal + 400,                  // entirely to carbs
        protein_g: proteinG,
        carb_g: cutCarbG + 100,
        fat_g: cutFatG,
        rationale: "Diet break — leptin/T3 restoration, +400 kcal to carbs, 2 weeks",
      });
      week += 2;
    }
  }

  // Reverse phase (4 weeks at +75 kcal/wk)
  if (week < weeksToGoal) {
    const maintenanceKcal = estimateMaintenance(args.bodyweight_kg);
    out.push({
      start_week: week,
      end_week: week + 4,
      mode: "reverse",
      kcal: Math.round((cutKcal + maintenanceKcal) / 2),  // midpoint as average
      protein_g: proteinG,
      carb_g: cutCarbG + 50,
      fat_g: cutFatG + 5,
      rationale: "Reverse diet — gradual +75 kcal/wk over 4 weeks to maintenance",
    });
    week += 4;
  }

  // Open-ended maintenance from end of reverse onward
  out.push({
    start_week: week,
    end_week: 999,
    mode: "maintain",
    kcal: estimateMaintenance(args.bodyweight_kg),
    protein_g: proteinG,
    carb_g: cutCarbG + 100,
    fat_g: cutFatG + 10,
    rationale: "Maintenance — protein floor preserved, calories at TDEE",
  });

  return out;
}

function estimateMaintenance(bodyweight_kg: number): number {
  // Conservative single-input maintenance estimate when full TDEE inputs absent.
  // 32 kcal/kg × bw is a reasonable intermediate-lifter average.
  return Math.round(32 * bodyweight_kg);
}
```

- [ ] **Step 4: Add `composeRestDayDelta` and `composeTrainingUplift` helpers**

```ts
import type { RestDayDelta } from "@/lib/data/types";

export function composeRestDayDelta(
  phase: "cut" | "maintain" | "lean_bulk" | "recomp" | "unsure",
  training_age: "beginner" | "intermediate" | "advanced",
): RestDayDelta | null {
  if (phase !== "cut") return null;
  if (training_age === "beginner") {
    return { kcal: -50, carb_g: -15, fat_g: 0 };
  }
  return { kcal: -100, carb_g: -25, fat_g: 0 };
}

export function composeTrainingUplift(
  phase: "cut" | "maintain" | "lean_bulk" | "recomp" | "unsure",
  training_age: "beginner" | "intermediate" | "advanced",
): { kcal: number; carb_g: number } | null {
  // Existing logic from Phase 2; preserve it. Cut + intermediate/advanced only.
  if (phase !== "cut") return null;
  if (training_age === "beginner") return null;
  return { kcal: 200, carb_g: 50 };
}
```

- [ ] **Step 5: Update the top-level `composeNutrition` to branch on `glp1_status`**

Replace the body of the existing `composeNutrition` (find via `grep -n "^export function composeNutrition" lib/coach/plan-builder/compose-nutrition.ts`) with branch logic:

```ts
export function composeNutrition(args: {
  intake: IntakePayload;
  goal: PlanPayload["goal"];
  bodyweight_kg: number;
  acknowledged_on: string | null;
}): PlanPayload["nutrition"] {
  const { intake, goal, bodyweight_kg, acknowledged_on } = args;
  const status = intake.health.glp1_status ?? null;
  const phase = intake.nutrition.current_phase;

  // GLP-1 branch — produces glp1 config, leaves classical fields null
  if (status && !isPastEnd(status.expected_end)) {
    const glp1 = composeGlp1Config(status, intake, bodyweight_kg);
    return {
      phase: phase === "unsure" ? "maintain" : phase,
      kcal_target: deriveTodayKcalGlp1(glp1, intake, phase, bodyweight_kg),
      kcal_range: deriveKcalRangeGlp1(glp1, intake, phase, bodyweight_kg),
      protein_g_per_kg_bw: glp1.protein_g_per_kg_bw,
      protein_g: Math.round(bodyweight_kg * glp1.protein_g_per_kg_bw),
      carb_g: derivePhaseCarbsGlp1(intake, phase, bodyweight_kg, glp1),
      fat_g: derivePhaseFatGlp1(intake, phase, bodyweight_kg, glp1),
      training_day_uplift: null,           // GLP-1 mode does not uplift
      refeed_cadence_days: null,
      refeed_uplift: null,
      glp1,
      classical_phases: null,
      rest_day_delta: null,
      hard_rules: composeHardRules(intake),
      notes: null,
    };
  }

  // Classical branch — produces classical_phases sequence, leaves glp1 null
  const classical_phases = composePhaseSequence({
    current_phase: phase,
    goal_target_date: goal.target_date,
    acknowledged_on,
    bodyweight_kg,
    bodyweight_kg_protein_factor: 1.6,
  });

  // Top-level fields = first PhaseStep's resolution (today)
  const today = classical_phases?.[0] ?? null;
  const fallbackProtein = Math.round(bodyweight_kg * 1.6);

  return {
    phase: phase === "unsure" ? "maintain" : phase,
    kcal_target: today?.kcal ?? estimateMaintenance(bodyweight_kg),
    kcal_range: today
      ? [Math.round(today.kcal * 0.95), Math.round(today.kcal * 1.05)]
      : [Math.round(estimateMaintenance(bodyweight_kg) * 0.95), Math.round(estimateMaintenance(bodyweight_kg) * 1.05)],
    protein_g_per_kg_bw: 1.6,
    protein_g: today?.protein_g ?? fallbackProtein,
    carb_g: today?.carb_g ?? 200,
    fat_g: today?.fat_g ?? 60,
    training_day_uplift: composeTrainingUplift(phase, intake.training.training_age),
    refeed_cadence_days: phase === "cut" ? 6 : null,
    refeed_uplift: phase === "cut" ? { kcal: 400, carb_g: 100 } : null,
    glp1: null,
    classical_phases,
    rest_day_delta: composeRestDayDelta(phase, intake.training.training_age),
    hard_rules: composeHardRules(intake),
    notes: null,
  };
}

function isPastEnd(expected_end: string | null): boolean {
  if (!expected_end) return false;
  return new Date(expected_end).getTime() < Date.now();
}
```

The helper functions `composeHardRules`, `deriveTodayKcalGlp1`, `deriveKcalRangeGlp1`, `derivePhaseCarbsGlp1`, `derivePhaseFatGlp1` need stubs if they don't exist. Use the existing Phase 2 logic for `composeHardRules` (it's already in the file). For the GLP-1 derivers, use:

```ts
function deriveTodayKcalGlp1(
  glp1: Glp1Config,
  intake: IntakePayload,
  phase: "cut" | "maintain" | "lean_bulk" | "recomp" | "unsure",
  bw: number,
): number {
  if (phase === "cut") {
    return Math.round(glp1.tdee_estimate_kcal * 0.80);          // 20% deficit
  }
  if (phase === "lean_bulk") return Math.round(glp1.tdee_estimate_kcal * 1.05);
  return glp1.tdee_estimate_kcal;
}

function deriveKcalRangeGlp1(
  glp1: Glp1Config,
  intake: IntakePayload,
  phase: "cut" | "maintain" | "lean_bulk" | "recomp" | "unsure",
  bw: number,
): [number, number] {
  const target = deriveTodayKcalGlp1(glp1, intake, phase, bw);
  return [Math.round(target * 0.95), Math.round(target * 1.05)];
}

function derivePhaseCarbsGlp1(
  intake: IntakePayload,
  phase: "cut" | "maintain" | "lean_bulk" | "recomp" | "unsure",
  bw: number,
  glp1: Glp1Config,
): number {
  const proteinG = bw * glp1.protein_g_per_kg_bw;
  const proteinKcal = proteinG * 4;
  const fatKcal = bw * 0.8 * 9;        // ~0.8 g/kg fat as baseline floor
  const target = deriveTodayKcalGlp1(glp1, intake, phase, bw);
  return Math.max(0, Math.round((target - proteinKcal - fatKcal) / 4));
}

function derivePhaseFatGlp1(
  intake: IntakePayload,
  phase: "cut" | "maintain" | "lean_bulk" | "recomp" | "unsure",
  bw: number,
  glp1: Glp1Config,
): number {
  return Math.round(bw * 0.8);
}
```

- [ ] **Step 6: Run typecheck**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
```

Expected: clean. If `composeHardRules` doesn't already exist in compose-nutrition.ts, copy its definition from where Phase 2 placed it (likely already inline). If conflicts arise, fix them inline rather than restructuring the file.

- [ ] **Step 7: Commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
git add lib/coach/plan-builder/compose-nutrition.ts
git commit -m "feat(plan-builder): compose-nutrition branches on glp1_status

When intake.health.glp1_status exists and not past expected_end:
  → produces nutrition.glp1 config; classical_phases left null
  → top-level kcal/protein/carb/fat reflect GLP-1-mode resolution
  → no training_day_uplift, no refeed (would fight the medication)

When no glp1_status (or past end_date):
  → produces nutrition.classical_phases array
  → 8-week cut blocks separated by 2-week diet breaks
  → 4-week reverse phase, then open-ended maintenance
  → training_day_uplift + refeed_cadence preserved for cuts

estimateTdeeKcal uses Mifflin-St Jeor with activity 1.5, cached on
the plan for cheap brief-time deficit-alarm computation.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: getTodayTargets — resolveMode + deficit-alarm rolling computation

**Files:**
- Modify: `lib/morning/brief/get-today-targets.ts`

- [ ] **Step 1: Add `resolveMode` helper at the top of the file**

```ts
import type { ResolvedNutritionMode, Glp1Config, PhaseStep } from "@/lib/data/types";

function resolveMode(
  glp1: Glp1Config | null,
  classical_phases: PhaseStep[] | null,
): ResolvedNutritionMode {
  if (glp1) {
    return glp1.taper_started_on ? "glp1_tapering" : "glp1_active";
  }
  if (classical_phases?.length) return "classical";
  return "steady_state";
}
```

- [ ] **Step 2: Compute is_training_day from training_weeks.session_plan**

Add a helper that reads the active `training_weeks` row for the current week and returns whether today is a training day:

```ts
async function isTrainingDay(
  supabase: SupabaseClient,
  userId: string,
  today: string,
): Promise<boolean> {
  // Week start: Monday-anchored. Compute the Monday of the current week.
  const todayD = new Date(`${today}T00:00:00Z`);
  const dayOfWeek = todayD.getUTCDay();             // 0=Sun, 1=Mon, ...
  const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const mondayD = new Date(todayD);
  mondayD.setUTCDate(mondayD.getUTCDate() - daysSinceMonday);
  const weekStart = mondayD.toISOString().slice(0, 10);

  const { data } = await supabase
    .from("training_weeks")
    .select("session_plan")
    .eq("user_id", userId)
    .eq("week_start", weekStart)
    .maybeSingle();
  if (!data?.session_plan) return false;

  // session_plan is { Mon: "Chest", Tue: "Legs", ..., Sun: "REST" }
  const labels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const todayLabel = labels[daysSinceMonday];
  const session = (data.session_plan as Record<string, string>)[todayLabel] ?? "REST";
  return session.toUpperCase() !== "REST";
}
```

- [ ] **Step 3: Compute rolling 7-day kcal deficit**

```ts
async function rolling7dDeficit(
  supabase: SupabaseClient,
  userId: string,
  today: string,
  tdee_estimate_kcal: number,
): Promise<{ avg_intake: number | null; avg_deficit: number | null }> {
  const sevenDaysAgo = new Date(`${today}T00:00:00Z`);
  sevenDaysAgo.setUTCDate(sevenDaysAgo.getUTCDate() - 7);
  const since = sevenDaysAgo.toISOString().slice(0, 10);

  const { data: logs } = await supabase
    .from("daily_logs")
    .select("date, calories_eaten")
    .eq("user_id", userId)
    .gte("date", since)
    .lt("date", today)
    .order("date", { ascending: false });

  const samples = (logs ?? [])
    .map((r) => r.calories_eaten)
    .filter((v): v is number => typeof v === "number" && v > 0);

  if (samples.length === 0) return { avg_intake: null, avg_deficit: null };
  const avg_intake = samples.reduce((a, b) => a + b, 0) / samples.length;
  const avg_deficit = tdee_estimate_kcal - avg_intake;
  return {
    avg_intake: Math.round(avg_intake),
    avg_deficit: Math.round(avg_deficit),
  };
}
```

- [ ] **Step 4: Rewrite the main `getTodayTargets` to branch on resolved mode**

```ts
export async function getTodayTargets(
  supabase: SupabaseClient,
  userId: string,
): Promise<TodayTargets | null> {
  const { data, error } = await supabase
    .from("athlete_profile_documents")
    .select("intake_payload, plan_payload")
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const today = todayInUserTz();          // import from @/lib/time

  // Phase 2 path: plan_payload exists
  if (data.plan_payload) {
    const plan = data.plan_payload as PlanPayload;
    const glp1 = plan.nutrition.glp1 ?? null;
    const classical = plan.nutrition.classical_phases ?? null;
    const mode = resolveMode(glp1, classical);
    const is_training_day = await isTrainingDay(supabase, userId, today);

    if (mode === "glp1_active" && glp1) {
      const def = await rolling7dDeficit(supabase, userId, today, glp1.tdee_estimate_kcal);
      const threshold = Math.max(
        glp1.deficit_alarm_kcal,
        Math.round(glp1.tdee_estimate_kcal * glp1.deficit_alarm_pct),
      );
      return {
        kcal: plan.nutrition.kcal_target,
        protein_g: plan.nutrition.protein_g,
        carb_g: plan.nutrition.carb_g,
        fat_g: plan.nutrition.fat_g,
        bedtime: plan.sleep.bedtime_target,
        sleep_hours_target: (plan.sleep.target_hours_min + plan.sleep.target_hours_max) / 2,
        phase: plan.nutrition.phase,
        source: "plan",
        mode: "glp1_active",
        is_training_day,
        deficit_alarm: {
          threshold_kcal_per_day: threshold,
          rolling_7d_avg_intake: def.avg_intake,
          rolling_7d_avg_deficit: def.avg_deficit,
          triggered: def.avg_deficit !== null && def.avg_deficit > threshold,
        },
        hydration_target_ml: is_training_day ? glp1.hydration_training_day_ml : null,
        sodium_target_mg: is_training_day ? glp1.sodium_training_day_mg : null,
      };
    }

    if (mode === "glp1_tapering" && glp1) {
      const def = await rolling7dDeficit(supabase, userId, today, glp1.tdee_estimate_kcal);
      const threshold = Math.round(glp1.deficit_alarm_kcal * 0.85);  // relaxed during taper
      return {
        kcal: plan.nutrition.kcal_target,    // composer leaves this at active-phase value
        protein_g: plan.nutrition.protein_g,
        carb_g: plan.nutrition.carb_g,
        fat_g: plan.nutrition.fat_g,
        bedtime: plan.sleep.bedtime_target,
        sleep_hours_target: (plan.sleep.target_hours_min + plan.sleep.target_hours_max) / 2,
        phase: plan.nutrition.phase,
        source: "plan",
        mode: "glp1_tapering",
        is_training_day,
        deficit_alarm: {
          threshold_kcal_per_day: threshold,
          rolling_7d_avg_intake: def.avg_intake,
          rolling_7d_avg_deficit: def.avg_deficit,
          triggered: def.avg_deficit !== null && def.avg_deficit > threshold,
        },
        hydration_target_ml: is_training_day ? glp1.hydration_training_day_ml : null,
        sodium_target_mg: is_training_day ? glp1.sodium_training_day_mg : null,
      };
    }

    if (mode === "classical" && classical) {
      const ack = data.intake_payload && (data as { acknowledged_at?: string }).acknowledged_at;
      const elapsedWeeks = ack
        ? Math.floor((Date.parse(today) - Date.parse(ack)) / (7 * 86_400_000))
        : 0;
      const step =
        classical.find((s) => s.start_week <= elapsedWeeks && elapsedWeeks < s.end_week) ??
        classical[classical.length - 1];

      const delta = is_training_day
        ? plan.nutrition.training_day_uplift
        : plan.nutrition.rest_day_delta;
      const kcal = step.kcal + (delta?.kcal ?? 0);
      const carb_g = step.carb_g + (delta?.carb_g ?? 0);
      const fat_g = step.fat_g + ((delta as { fat_g?: number })?.fat_g ?? 0);

      return {
        kcal,
        protein_g: step.protein_g,
        carb_g,
        fat_g,
        bedtime: plan.sleep.bedtime_target,
        sleep_hours_target: (plan.sleep.target_hours_min + plan.sleep.target_hours_max) / 2,
        phase: step.mode === "cut" ? "cut" :
               step.mode === "diet_break" ? "cut" :     // still in a cut context
               step.mode === "reverse" ? "maintain" :
               "maintain",
        source: "plan",
        mode: "classical",
        is_training_day,
        deficit_alarm: null,
        hydration_target_ml: null,
        sodium_target_mg: null,
      };
    }

    // steady_state fallback: existing Phase 2 behavior
    return {
      kcal: plan.nutrition.kcal_target,
      protein_g: plan.nutrition.protein_g,
      carb_g: plan.nutrition.carb_g,
      fat_g: plan.nutrition.fat_g,
      bedtime: plan.sleep.bedtime_target,
      sleep_hours_target: (plan.sleep.target_hours_min + plan.sleep.target_hours_max) / 2,
      phase: plan.nutrition.phase,
      source: "plan",
      mode: "steady_state",
      is_training_day,
      deficit_alarm: null,
      hydration_target_ml: null,
      sodium_target_mg: null,
    };
  }

  // Phase 1 fallback: intake_payload only
  const payload = data.intake_payload as IntakePayload;
  return {
    kcal: payload.nutrition.current_kcal,
    protein_g: payload.nutrition.current_macros.protein_g,
    carb_g: payload.nutrition.current_macros.carb_g,
    fat_g: payload.nutrition.current_macros.fat_g,
    bedtime: payload.sleep_recovery.typical_bedtime,
    sleep_hours_target: payload.sleep_recovery.avg_sleep_hours,
    phase: payload.nutrition.current_phase,
    source: "intake",
    mode: "steady_state",
    is_training_day: false,
    deficit_alarm: null,
    hydration_target_ml: null,
    sodium_target_mg: null,
  };
}
```

- [ ] **Step 5: Run typecheck and commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
git add lib/morning/brief/get-today-targets.ts
git commit -m "feat(brief): getTodayTargets resolves mode + computes deficit alarm

resolveMode branches on plan.nutrition.glp1 + classical_phases presence:
  glp1 present + no taper       → glp1_active
  glp1 present + taper started  → glp1_tapering
  classical_phases present       → classical (with PhaseStep lookup by week)
  neither                        → steady_state (Phase 2 behavior unchanged)

GLP-1 modes compute 7-day rolling deficit from daily_logs.calories_eaten
vs cached tdee_estimate_kcal. Deficit alarm threshold = max(absolute kcal,
% of TDEE).

Training-day detection reads training_weeks.session_plan for the current
Monday-anchored week.

Classical mode applies training_day_uplift / rest_day_delta to the active
PhaseStep at read time.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: brief/flags.ts — extend `glp1` flag

**Files:**
- Modify: `lib/morning/brief/flags.ts`

- [ ] **Step 1: Read the existing flag shape**

```bash
cd "/Users/abdelouahedelbied/Health app"
grep -nE "glp1|GLP" lib/morning/brief/flags.ts | head -10
```

- [ ] **Step 2: Extend the `glp1` flag computation**

Find the existing GLP-1 flag (it sets `active: boolean` and possibly `medication`). Extend to include mode + deficit info from `getTodayTargets`:

```ts
// In computeFlags() or wherever glp1 is computed:
import type { TodayTargets } from "@/lib/morning/brief/get-today-targets";

function computeGlp1Flag(
  intake: IntakePayload,
  targets: TodayTargets | null,
): {
  active: boolean;
  medication: string | null;
  dose_mg: number | null;
  mode: TodayTargets["mode"] | null;
  deficit_alarm_triggered: boolean;
  rolling_7d_avg_deficit: number | null;
} {
  const status = intake.health.glp1_status ?? null;
  if (!status) {
    return {
      active: false,
      medication: null,
      dose_mg: null,
      mode: targets?.mode ?? null,
      deficit_alarm_triggered: false,
      rolling_7d_avg_deficit: null,
    };
  }
  return {
    active: true,
    medication: status.medication,
    dose_mg: status.dose_mg,
    mode: targets?.mode ?? null,
    deficit_alarm_triggered: targets?.deficit_alarm?.triggered ?? false,
    rolling_7d_avg_deficit: targets?.deficit_alarm?.rolling_7d_avg_deficit ?? null,
  };
}
```

Wire it into the existing `computeFlags()` aggregate. The caller passes the result of `getTodayTargets()` so we don't re-query daily_logs.

- [ ] **Step 3: Run typecheck + commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
git add lib/morning/brief/flags.ts
git commit -m "feat(brief): glp1 flag carries mode + deficit alarm state

Brief Advice prompt now has access to:
  mode                       — glp1_active | glp1_tapering | classical | steady_state
  deficit_alarm_triggered    — boolean from 7d rolling deficit check
  rolling_7d_avg_deficit     — kcal/day for the prompt's number reference

Plumbs through computeFlags so the Advice prompt can branch contextually
without re-querying daily_logs.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: brief/index.ts — Advice context lines + Hydration block

**Files:**
- Modify: `lib/morning/brief/index.ts`
- Modify: `lib/data/types.ts` (MorningBriefCard.blocks may need a "hydration" block variant)

- [ ] **Step 1: Add Hydration block to MorningBriefCard shape**

In `lib/data/types.ts`, find `MorningBriefCard` (grep). Extend `blocks` discriminated union with a hydration variant:

```ts
| {
    kind: "hydration";
    title: "Hydration";
    water_ml: number;
    sodium_mg: number;
    note: string;  // e.g. "GLP-1 + training day — fluid & sodium emphasis"
  }
```

- [ ] **Step 2: Modify the brief assembler to emit a Hydration block when conditions met**

In `lib/morning/brief/assembler.ts` (or wherever blocks are composed), insert hydration before the Macros block when:

```ts
if (targets?.hydration_target_ml != null && targets.is_training_day) {
  blocks.push({
    kind: "hydration",
    title: "Hydration",
    water_ml: targets.hydration_target_ml,
    sodium_mg: targets.sodium_target_mg ?? 0,
    note: "GLP-1 can suppress thirst — front-load water & sodium around session.",
  });
}
```

- [ ] **Step 3: Extend the Advice prompt with mode-conditional context lines**

In `lib/morning/brief/index.ts`, find the Advice prompt assembly (search for `"## Today's coaching"` or wherever the Haiku prompt is built). Add context:

```ts
// Inside buildAdvicePrompt() or the inline prompt construction:
if (flags.glp1.mode === "glp1_active" && flags.glp1.deficit_alarm_triggered) {
  context += `\nGLP-1 deficit alarm: 7-day average deficit ~${flags.glp1.rolling_7d_avg_deficit} kcal/day, above the ${targets.deficit_alarm?.threshold_kcal_per_day} threshold. Surface this in the Advice block — recommend adding ~30g protein + a carb-heavy meal around tomorrow's session. Don't recommend a "diet break".`;
}
if (flags.glp1.mode === "glp1_tapering") {
  context += `\nGLP-1 tapering: appetite returning. Hold protein constant; let carbs ramp to appetite. Reference the user's dose-tapering schedule with their doctor.`;
}
if (flags.glp1.mode === "classical" && targets?.phase === "cut" && /* current PhaseStep is diet_break */ false) {
  // Diet-break detection: read targets.kcal vs typical phase kcal; or pass step.mode through
  context += `\nDiet break week: +400 kcal vs cut, mostly to carbs. Mention leptin restoration; remind that appetite will rebound and that's the intended physiology.`;
}
```

Cleaner: pass the active `PhaseStep.mode` through `TodayTargets` as an additional discriminator. Add `today_phase_mode: "cut" | "diet_break" | "reverse" | "maintain" | null` to `TodayTargets` and populate it in the classical branch of `getTodayTargets`. Use that in the Advice prompt.

- [ ] **Step 4: Render the Hydration block in the brief card component**

`components/morning/MorningBriefCard.tsx` (or whatever renders the card). Add a hydration-block case:

```tsx
if (block.kind === "hydration") {
  return (
    <div className="brief-block hydration-block" key={i}>
      <div className="brief-block-title">{block.title}</div>
      <div className="hydration-numbers">
        <span>{block.water_ml} ml water</span>
        <span>+{block.sodium_mg} mg Na</span>
      </div>
      <div className="brief-block-note">{block.note}</div>
    </div>
  );
}
```

(Adapt to existing styling conventions in the file.)

- [ ] **Step 5: Run typecheck and commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
git add lib/data/types.ts lib/morning/brief/index.ts lib/morning/brief/assembler.ts components/morning/MorningBriefCard.tsx lib/morning/brief/get-today-targets.ts
git commit -m "feat(brief): hydration block + mode-conditional advice context

MorningBriefCard.blocks gains a hydration variant rendered above Macros
on training days when GLP-1 mode is active.

Advice prompt receives mode-aware context lines:
  glp1_active + deficit_alarm_triggered → 'add 30g protein + carbs'
  glp1_tapering → 'appetite returning, protein constant'
  classical + diet_break → 'leptin restoration, appetite will rebound'
  classical + reverse → 'metabolic recovery, scale may drift up'

TodayTargets gains today_phase_mode discriminator for the classical-mode
PhaseStep so the prompt can branch on diet_break / reverse.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: tools.ts — 3 new chat tools (set_glp1_status, set_glp1_taper_started, mark_glp1_discontinued)

**Files:**
- Modify: `lib/coach/tools.ts`

- [ ] **Step 1: Add `SET_GLP1_STATUS_TOOL` + executor (intake-time)**

Append to `lib/coach/tools.ts` after the existing Phase 2 setter tools:

```ts
export const SET_GLP1_STATUS_TOOL = {
  name: "set_glp1_status",
  description:
    "Beat 3 GLP-1 follow-up. Captures medication, dose, schedule, and taper milestones into intake_payload.health.glp1_status. Required when user mentions semaglutide, tirzepatide, Ozempic, Wegovy, Mounjaro, Zepbound, or compounded GLP-1.",
  input_schema: {
    type: "object",
    properties: {
      medication: { type: "string", enum: ["semaglutide", "tirzepatide", "compounded"] },
      dose_mg: { type: "number", minimum: 0.1, maximum: 20 },
      injection_day: {
        type: "string",
        enum: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
      },
      injection_time: { type: "string", enum: ["morning", "evening", "night"] },
      started_on: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
      expected_taper_start: { type: ["string", "null"], pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
      expected_end: { type: ["string", "null"], pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
      doctor_protocol_notes: { type: ["string", "null"] },
    },
    required: ["medication", "dose_mg", "injection_day", "injection_time", "started_on"],
  },
} as const;

export async function executeSetGlp1Status(opts: {
  supabase: SupabaseClient;
  userId: string;
  draftDocId: string;
  input: unknown;
}): Promise<ToolResult<{ ok: true }>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;

  // Validate enums
  const meds = ["semaglutide", "tirzepatide", "compounded"];
  if (!meds.includes(i.medication as string)) {
    return { ok: false, error: { error: "invalid medication" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  // ... similar validation for injection_day, injection_time
  // (Adapt from existing setter validation patterns.)

  const result = await patchIntake(opts, (intake) => ({
    ...intake,
    health: {
      ...intake.health,
      glp1_status: {
        medication: i.medication as "semaglutide" | "tirzepatide" | "compounded",
        dose_mg: Number(i.dose_mg),
        injection_day: i.injection_day as "Mon"|"Tue"|"Wed"|"Thu"|"Fri"|"Sat"|"Sun",
        injection_time: i.injection_time as "morning"|"evening"|"night",
        started_on: String(i.started_on),
        expected_taper_start: (i.expected_taper_start as string | null) ?? null,
        expected_end: (i.expected_end as string | null) ?? null,
        doctor_protocol_notes: (i.doctor_protocol_notes as string | null) ?? null,
      },
    },
  }));
  if (!result.ok) {
    return { ok: false, error: { error: result.error }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  return {
    ok: true,
    data: { ok: true },
    meta: { ms: Date.now() - t0, result_rows: 1, range_days: 0, truncated: false },
  };
}
```

- [ ] **Step 2: Add `SET_GLP1_TAPER_STARTED_TOOL` + executor (active plan, in-place)**

```ts
export const SET_GLP1_TAPER_STARTED_TOOL = {
  name: "set_glp1_taper_started",
  description:
    "Mutates the ACTIVE plan in place to mark GLP-1 taper as starting. Call when the user signals 'I'm starting my taper this Sunday' or similar. Does NOT create a new plan version — taper is a milestone update on the existing acknowledged plan.",
  input_schema: {
    type: "object",
    properties: {
      taper_started_on: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    },
    required: ["taper_started_on"],
  },
} as const;

export async function executeSetGlp1TaperStarted(opts: {
  supabase: SupabaseClient;
  userId: string;
  input: unknown;
}): Promise<ToolResult<{ ok: true; doc_id: string }>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;
  const taperOn = String(i.taper_started_on);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(taperOn)) {
    return { ok: false, error: { error: "taper_started_on must be YYYY-MM-DD" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }

  // Load the active plan
  const { data: active, error: loadErr } = await opts.supabase
    .from("athlete_profile_documents")
    .select("id, plan_payload")
    .eq("user_id", opts.userId)
    .eq("status", "active")
    .maybeSingle();
  if (loadErr) {
    return { ok: false, error: { error: loadErr.message }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  if (!active || !active.plan_payload) {
    return { ok: false, error: { error: "no active plan with plan_payload" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }

  const payload = active.plan_payload as PlanPayload;
  if (!payload.nutrition.glp1) {
    return { ok: false, error: { error: "active plan is not GLP-1 mode" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }

  const newPayload: PlanPayload = {
    ...payload,
    nutrition: {
      ...payload.nutrition,
      glp1: {
        ...payload.nutrition.glp1,
        taper_started_on: taperOn,
      },
    },
  };

  const { error: updErr } = await opts.supabase
    .from("athlete_profile_documents")
    .update({ plan_payload: newPayload, updated_at: new Date().toISOString() })
    .eq("id", active.id)
    .eq("user_id", opts.userId)
    .eq("status", "active");
  if (updErr) {
    return { ok: false, error: { error: updErr.message }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }

  return {
    ok: true,
    data: { ok: true, doc_id: active.id },
    meta: { ms: Date.now() - t0, result_rows: 1, range_days: 0, truncated: false },
  };
}
```

- [ ] **Step 3: Add `MARK_GLP1_DISCONTINUED_TOOL` + executor**

Same pattern — mutates active plan's `nutrition.glp1.expected_end` if not already set:

```ts
export const MARK_GLP1_DISCONTINUED_TOOL = {
  name: "mark_glp1_discontinued",
  description:
    "Mutates the ACTIVE plan in place to record GLP-1 discontinuation. Call when the user says 'I took my last dose' or similar. Surfaces a CTA in chat to regenerate the plan as classical or steady-state.",
  input_schema: {
    type: "object",
    properties: {
      end_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    },
    required: ["end_date"],
  },
} as const;

export async function executeMarkGlp1Discontinued(opts: {
  supabase: SupabaseClient;
  userId: string;
  input: unknown;
}): Promise<ToolResult<{ ok: true; doc_id: string; cta: string }>> {
  // Mirror the set_glp1_taper_started pattern. Update glp1.expected_end if null,
  // and return a `cta` string for the AI to surface in chat.
  // ...
}
```

- [ ] **Step 4: Run typecheck and commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
git add lib/coach/tools.ts
git commit -m "feat(tools): 3 GLP-1 chat tools

set_glp1_status (intake, draft doc): captures medication, dose,
  schedule, and taper milestones from Beat 3 GLP-1 follow-up.

set_glp1_taper_started (active plan, in-place): mutates the active
  plan's nutrition.glp1.taper_started_on. Phase 1 immutability invariant
  applies to acknowledged intake+plan; milestone fields are explicitly
  mutable state on the active doc (same model as planned Phase 3
  last_drift_check_at).

mark_glp1_discontinued (active plan, in-place): mutates
  nutrition.glp1.expected_end and returns a CTA string for the AI to
  surface in chat ('plan your next phase').

All three follow the security invariants: tool input never contains
user_id; executors scope queries with .eq('user_id', userId).
set_glp1_status additionally scopes to (id=draftDocId, status='draft').

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: chat-stream.ts — register tools in intake and default modes

**Files:**
- Modify: `lib/coach/chat-stream.ts`

- [ ] **Step 1: Add imports for the new tool schemas + executors**

```ts
import {
  // ... existing ...
  SET_GLP1_STATUS_TOOL,
  SET_GLP1_TAPER_STARTED_TOOL,
  MARK_GLP1_DISCONTINUED_TOOL,
  executeSetGlp1Status,
  executeSetGlp1TaperStarted,
  executeMarkGlp1Discontinued,
} from "@/lib/coach/tools";
```

- [ ] **Step 2: Add to `allTools`**

```ts
const allTools = [
  // ... existing 23 tools ...
  SET_GLP1_STATUS_TOOL,
  SET_GLP1_TAPER_STARTED_TOOL,
  MARK_GLP1_DISCONTINUED_TOOL,
];
```

- [ ] **Step 3: Update `toolsForMode` partitioning**

```ts
if (opts.mode === "intake") {
  toolsForMode = allTools.filter(t =>
    /* existing intake tools */ ||
    t.name === "set_glp1_status"
    // set_glp1_taper_started + mark_glp1_discontinued NOT here — they
    // operate on the ACTIVE plan, not the draft, so they belong in
    // default mode (where the user is chatting normally with the coach).
  );
} else if (opts.mode === "default") {
  toolsForMode = allTools.filter(t =>
    /* existing default tools, e.g. read tools */ ||
    t.name === "set_glp1_taper_started" ||
    t.name === "mark_glp1_discontinued"
  );
}
```

(Adapt to the exact filter logic — review Phase 2's existing branches and slot the new tools cleanly.)

- [ ] **Step 4: Add executor dispatch branches**

```ts
} else if (block.name === "set_glp1_status") {
  result = await executeSetGlp1Status({
    supabase: opts.sr,
    userId: opts.userId,
    draftDocId,
    input: block.input,
  });
} else if (block.name === "set_glp1_taper_started") {
  result = await executeSetGlp1TaperStarted({
    supabase: opts.sr,
    userId: opts.userId,
    input: block.input,
  });
} else if (block.name === "mark_glp1_discontinued") {
  result = await executeMarkGlp1Discontinued({
    supabase: opts.sr,
    userId: opts.userId,
    input: block.input,
  });
}
```

- [ ] **Step 5: Extend `ToolCallLog.name` union in `lib/data/types.ts`**

Same pattern as Phase 2: add `"set_glp1_status" | "set_glp1_taper_started" | "mark_glp1_discontinued"` to the union.

- [ ] **Step 6: Run typecheck + commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
git add lib/coach/chat-stream.ts lib/data/types.ts
git commit -m "feat(chat-stream): register 3 GLP-1 tools in intake/default modes

set_glp1_status                → intake mode (writes to draft)
set_glp1_taper_started         → default mode (writes to active plan)
mark_glp1_discontinued         → default mode (writes to active plan)

Two active-plan tools are intentionally in default mode (not intake)
because they apply during normal coach chat, not during a re-plan
ceremony. The user says 'I started my taper Sunday' in regular coach
conversation; the AI calls set_glp1_taper_started without forcing a
re-intake.

ToolCallLog.name union extended with the 3 new tool names.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: planning-prompts.ts — INTAKE_PROMPT Beat 3 + DEFAULT_SYSTEM_PROMPT taper paragraph

**Files:**
- Modify: `lib/coach/planning-prompts.ts`
- Modify: `lib/coach/system-prompts.ts` (or wherever DEFAULT_SYSTEM_PROMPT lives)

- [ ] **Step 1: Extend INTAKE_PROMPT Beat 3 with GLP-1 follow-up**

In `lib/coach/planning-prompts.ts`, find the existing Beat 3 section. Add a sub-section:

```
### Beat 3: DEEPEN medical / restrictions (continued)

If intake.health.medications mentions GLP-1, semaglutide, tirzepatide,
Ozempic, Wegovy, Mounjaro, Zepbound, or compounded GLP-1:

  Ask in ONE turn (3 questions bundled):
    1. "Which med + dose + injection day? (e.g. semaglutide 1mg/wk on Sunday)"
    2. "When did you start, and when do you plan to taper off?"
    3. "Has your doctor mentioned diet breaks, refeeds, or specific protein targets?"

  Synthesize answers into a call to set_glp1_status with:
    - medication: "semaglutide" | "tirzepatide" | "compounded"
    - dose_mg: number
    - injection_day, injection_time: from user's answer
    - started_on: ISO date (compute if user gives weeks-since)
    - expected_taper_start, expected_end: ISO date or null
    - doctor_protocol_notes: free-text capture of doctor's guidance

  After set_glp1_status returns ok, proceed to Beat 4.

  Do NOT lecture the user about diet breaks, refeeds, protein floors,
  or anything else — the plan-builder will derive the right targets
  from the captured status.
```

- [ ] **Step 2: Add a taper paragraph to DEFAULT_SYSTEM_PROMPT**

In `lib/coach/system-prompts.ts`, find `DEFAULT_SYSTEM_PROMPT`. Append:

```
## GLP-1 taper / discontinuation handling

If the user (during normal coach chat) signals they're starting their
GLP-1 taper ("I'm starting my taper this Sunday", "I dropped to 0.5mg
yesterday", etc.), call set_glp1_taper_started with the date.

If the user signals they've discontinued ("I took my last dose", "I
stopped GLP-1"), call mark_glp1_discontinued with the date. After the
tool returns, surface the CTA string from the tool result verbatim in
your reply.

These are in-place milestone updates on the active plan — they do not
require a re-plan ceremony. Use them whenever the user mentions the
transition; don't ask them to repeat the information in /profile.
```

- [ ] **Step 3: Run typecheck + commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
git add lib/coach/planning-prompts.ts lib/coach/system-prompts.ts
git commit -m "feat(prompts): INTAKE_PROMPT Beat 3 GLP-1 follow-up + taper guidance

Beat 3 medical/restrictions deepening gains a GLP-1-specific sub-beat:
detect the medication in intake.health.medications, ask 3 bundled
questions about dose/schedule/timeline, synthesize via set_glp1_status.

DEFAULT_SYSTEM_PROMPT gains a paragraph documenting the two active-plan
tools (set_glp1_taper_started, mark_glp1_discontinued) so the coach
recognizes these milestone-update moments in normal chat without
requiring the user to navigate to /profile.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: PlanProposalCard — mode-conditional Nutrition section

**Files:**
- Modify: `components/chat/PlanProposalCard.tsx`

- [ ] **Step 1: Detect mode at component level**

```tsx
import type { PlanPayload } from "@/lib/data/types";

function modeOfPlan(plan: PlanPayload): "glp1" | "classical" | "steady" {
  if (plan.nutrition.glp1) return "glp1";
  if (plan.nutrition.classical_phases?.length) return "classical";
  return "steady";
}
```

- [ ] **Step 2: Branch the Nutrition PlanSection**

Replace the existing Nutrition section with:

```tsx
const mode = modeOfPlan(plan);

<PlanSection title="Nutrition">
  {mode === "glp1" && plan.nutrition.glp1 && (
    <>
      <KeyVal label="Mode" value={`GLP-1-aware · ${plan.nutrition.glp1.medication} ${plan.nutrition.glp1.dose_mg}mg/wk`} />
      <KeyVal label="Phase" value={plan.nutrition.phase} />
      <KeyVal
        label="Calories"
        value={`${plan.nutrition.kcal_target} kcal (alarm at >${plan.nutrition.glp1.deficit_alarm_kcal} deficit)`}
      />
      <KeyVal
        label="Protein"
        value={`${plan.nutrition.protein_g}g (${plan.nutrition.glp1.protein_g_per_kg_bw} g/kg BW)`}
      />
      <KeyVal label="Carbs / Fat" value={`${plan.nutrition.carb_g}g / ${plan.nutrition.fat_g}g`} />
      <KeyVal
        label="Hydration"
        value={`${plan.nutrition.glp1.hydration_training_day_ml} ml + ${plan.nutrition.glp1.sodium_training_day_mg} mg Na on training days`}
      />
      {plan.nutrition.glp1.expected_taper_start && (
        <KeyVal label="Expected taper" value={plan.nutrition.glp1.expected_taper_start} />
      )}
      {plan.nutrition.glp1.expected_end && (
        <KeyVal label="Expected end" value={plan.nutrition.glp1.expected_end} />
      )}
    </>
  )}

  {mode === "classical" && plan.nutrition.classical_phases && (
    <>
      <KeyVal label="Mode" value="Classical phase-of-phases" />
      <KeyVal label="Phase today" value={plan.nutrition.phase} />
      <KeyVal label="Calories" value={`${plan.nutrition.kcal_target} kcal`} />
      <KeyVal
        label="Protein"
        value={`${plan.nutrition.protein_g}g (${plan.nutrition.protein_g_per_kg_bw} g/kg BW)`}
      />
      <KeyVal label="Carbs / Fat" value={`${plan.nutrition.carb_g}g / ${plan.nutrition.fat_g}g`} />
      <KeyVal
        label="Sequence"
        value={plan.nutrition.classical_phases
          .map((s) => `W${s.start_week}-${s.end_week} ${s.mode}`)
          .join(" · ")}
      />
      {plan.nutrition.refeed_cadence_days && (
        <KeyVal label="Refeed" value={`every ${plan.nutrition.refeed_cadence_days} days`} />
      )}
      {plan.nutrition.rest_day_delta && (
        <KeyVal
          label="Rest-day delta"
          value={`${plan.nutrition.rest_day_delta.kcal} kcal / ${plan.nutrition.rest_day_delta.carb_g}g carbs`}
        />
      )}
    </>
  )}

  {mode === "steady" && (
    <>
      {/* existing steady-state rendering unchanged */}
    </>
  )}
</PlanSection>
```

- [ ] **Step 3: Run typecheck + commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
git add components/chat/PlanProposalCard.tsx
git commit -m "feat(chat): PlanProposalCard nutrition section mode-conditional

Three branches: glp1 (medication + dose + deficit alarm + hydration),
classical (phase sequence + refeed cadence + rest-day delta), steady
(unchanged Phase 2 rendering).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: profile-renderer.ts — renderPlanNutritionSection mode-branched

**Files:**
- Modify: `lib/coach/profile-renderer.ts`

- [ ] **Step 1: Replace renderPlanNutritionSection with a mode-aware version**

In `lib/coach/profile-renderer.ts`, find `renderPlanNutritionSection`. Replace body:

```ts
function renderPlanNutritionSection(n: PlanPayload["nutrition"]): string {
  if (n.glp1) {
    return renderGlp1NutritionMarkdown(n);
  }
  if (n.classical_phases?.length) {
    return renderClassicalNutritionMarkdown(n);
  }
  return renderSteadyNutritionMarkdown(n);   // existing implementation
}

function renderGlp1NutritionMarkdown(n: PlanPayload["nutrition"]): string {
  const g = n.glp1!;
  return [
    "## Nutrition (GLP-1-aware)",
    "",
    `**Medication:** ${g.medication} ${g.dose_mg}mg/wk on ${g.injection_day} ${g.injection_time}`,
    `**Started:** ${g.started_on}` +
      (g.expected_taper_start ? ` · **expected taper:** ${g.expected_taper_start}` : "") +
      (g.expected_end ? ` · **expected end:** ${g.expected_end}` : ""),
    "",
    `**Phase:** ${n.phase}`,
    `**Calories:** ${n.kcal_target} kcal (range ${n.kcal_range[0]}-${n.kcal_range[1]})`,
    `**Protein:** ${n.protein_g}g (${g.protein_g_per_kg_bw} g/kg BW, ≥${g.per_meal_protein_floor_g}g per meal)`,
    `**Carbs · Fat:** ${n.carb_g}g · ${n.fat_g}g`,
    `**Deficit alarm:** > ${g.deficit_alarm_kcal} kcal/day or > ${(g.deficit_alarm_pct * 100).toFixed(0)}% of TDEE (${g.tdee_estimate_kcal} kcal)`,
    `**Hydration (training days):** ${g.hydration_training_day_ml} ml water + ${g.sodium_training_day_mg} mg sodium`,
    `**Alcohol:** ${n.hard_rules.alcohol_policy.replace(/_/g, " ")}`,
  ].join("\n");
}

function renderClassicalNutritionMarkdown(n: PlanPayload["nutrition"]): string {
  const phases = n.classical_phases!;
  const phaseStrip = phases.map((s) => `W${s.start_week}-${s.end_week} ${s.mode}`).join(" · ");
  return [
    "## Nutrition (classical phase-of-phases)",
    "",
    `**Sequence:** ${phaseStrip}`,
    "",
    `**Today's targets**`,
    `- Phase: ${n.phase}`,
    `- Calories: ${n.kcal_target} kcal`,
    `- Protein: ${n.protein_g}g (${n.protein_g_per_kg_bw} g/kg BW)`,
    `- Carbs · Fat: ${n.carb_g}g · ${n.fat_g}g`,
    ...(n.training_day_uplift ? [`- Training day uplift: +${n.training_day_uplift.kcal} kcal / +${n.training_day_uplift.carb_g}g carbs`] : []),
    ...(n.rest_day_delta ? [`- Rest day delta: ${n.rest_day_delta.kcal} kcal / ${n.rest_day_delta.carb_g}g carbs / ${n.rest_day_delta.fat_g}g fat`] : []),
    ...(n.refeed_cadence_days && n.refeed_uplift ? [`- Refeed every ${n.refeed_cadence_days} days: +${n.refeed_uplift.kcal} kcal`] : []),
    `- Alcohol: ${n.hard_rules.alcohol_policy.replace(/_/g, " ")}`,
  ].join("\n");
}
```

Keep `renderSteadyNutritionMarkdown` as the existing Phase 2 implementation, renamed if it didn't have a distinct name before.

- [ ] **Step 2: Run typecheck + commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
git add lib/coach/profile-renderer.ts
git commit -m "feat(profile-renderer): renderPlanNutritionSection mode-branched

GLP-1 mode renders medication + dose + schedule + taper milestones +
deficit alarm threshold + hydration block.

Classical mode renders the phase sequence strip + today's resolved
macros + training_day_uplift / rest_day_delta / refeed cadence.

Steady-state (existing Phase 2) unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: LabPromptCard component + lab_acknowledgments hooks

**Files:**
- Create: `components/profile/LabPromptCard.tsx`
- Create: `lib/query/hooks/useLabAcknowledgments.ts`
- Create: `lib/query/fetchers/labAcknowledgments.ts`

- [ ] **Step 1: Create the fetcher**

`lib/query/fetchers/labAcknowledgments.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";

export type LabAcks = Record<string, string | null>;

export async function fetchLabAcknowledgmentsBrowser(
  supabase: SupabaseClient,
  userId: string,
): Promise<LabAcks> {
  const { data, error } = await supabase
    .from("profiles")
    .select("lab_acknowledgments")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return (data?.lab_acknowledgments ?? {}) as LabAcks;
}

export async function fetchLabAcknowledgmentsServer(
  supabase: SupabaseClient,
  userId: string,
): Promise<LabAcks> {
  return fetchLabAcknowledgmentsBrowser(supabase, userId);
}
```

- [ ] **Step 2: Create the query hook**

`lib/query/hooks/useLabAcknowledgments.ts`:

```ts
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { queryKeys } from "@/lib/query/keys";
import { fetchLabAcknowledgmentsBrowser, type LabAcks } from "@/lib/query/fetchers/labAcknowledgments";

export function useLabAcknowledgments(userId: string) {
  return useQuery({
    queryKey: queryKeys.labAcks.one(userId),
    queryFn: () => fetchLabAcknowledgmentsBrowser(createSupabaseBrowserClient(), userId),
  });
}

export function useAckLabItem(userId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ key, ackedOn }: { key: string; ackedOn: string | null }) => {
      const supabase = createSupabaseBrowserClient();
      const { data: existing } = await supabase
        .from("profiles")
        .select("lab_acknowledgments")
        .eq("user_id", userId)
        .maybeSingle();
      const current = (existing?.lab_acknowledgments ?? {}) as LabAcks;
      const next = { ...current, [key]: ackedOn };
      const { error } = await supabase
        .from("profiles")
        .update({ lab_acknowledgments: next })
        .eq("user_id", userId);
      if (error) throw error;
      return next;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.labAcks.one(userId) });
    },
  });
}
```

Add to `lib/query/keys.ts`:

```ts
labAcks: {
  one: (userId: string) => ["labAcks", userId] as const,
},
```

- [ ] **Step 3: Create the LabPromptCard component**

`components/profile/LabPromptCard.tsx`:

```tsx
"use client";
import { useMemo } from "react";
import { COLOR } from "@/lib/ui/theme";
import { Card } from "@/components/ui/Card";
import { useLabAcknowledgments, useAckLabItem } from "@/lib/query/hooks/useLabAcknowledgments";

type LabItem = {
  key: string;
  label: string;
  detail: string;
  category: "baseline" | "6mo" | "quarterly" | "yearly";
};

const ITEMS: LabItem[] = [
  { key: "b12_baseline", label: "B12", detail: "Baseline + 6mo", category: "baseline" },
  { key: "vit_d_baseline", label: "Vitamin D", detail: "Baseline + 6mo", category: "baseline" },
  { key: "magnesium_baseline", label: "Magnesium", detail: "Baseline + 6mo", category: "baseline" },
  { key: "ferritin_baseline", label: "Ferritin", detail: "Baseline + 6mo", category: "baseline" },
  { key: "grip_strength_q", label: "Grip strength", detail: "Quarterly — cheap dynamometer, function decline often precedes mass decline", category: "quarterly" },
  { key: "bone_density_12mo", label: "Bone density (DXA)", detail: "If cut extends >12 months — SELECT trial fracture-risk signal", category: "yearly" },
];

export function LabPromptCard({ userId }: { userId: string }) {
  const { data: acks = {} } = useLabAcknowledgments(userId);
  const ackMut = useAckLabItem(userId);

  const pending = useMemo(
    () => ITEMS.filter((it) => !acks[it.key]),
    [acks],
  );

  if (pending.length === 0) return null;

  return (
    <Card variant="compact" style={{ borderColor: COLOR.accent }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: COLOR.textStrong }}>
          Ask your doctor at the next check-up
        </div>
        <div style={{ fontSize: 11, color: COLOR.textMuted }}>
          Standard GLP-1 monitoring is loose. These checks fill the gap.
        </div>
        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
          {pending.map((it) => (
            <li key={it.key} style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
              <button
                type="button"
                onClick={() => ackMut.mutate({ key: it.key, ackedOn: new Date().toISOString().slice(0, 10) })}
                disabled={ackMut.isPending}
                style={{
                  background: "transparent",
                  border: `1px solid ${COLOR.divider}`,
                  borderRadius: 4,
                  width: 18, height: 18,
                  cursor: "pointer",
                  flexShrink: 0,
                }}
                aria-label={`Mark ${it.label} as acknowledged`}
              />
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: COLOR.textStrong }}>{it.label}</div>
                <div style={{ fontSize: 11, color: COLOR.textMid }}>{it.detail}</div>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}
```

- [ ] **Step 4: Run typecheck + commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
git add components/profile/LabPromptCard.tsx lib/query/hooks/useLabAcknowledgments.ts lib/query/fetchers/labAcknowledgments.ts lib/query/keys.ts
git commit -m "feat(profile): LabPromptCard component + lab_acknowledgments hooks

Surfaces 6 lab/check items the GLP-1 user can ask their doctor for:
B12, vit D, magnesium, ferritin (baseline + 6mo), grip strength
(quarterly), bone density DXA (>12mo). Acknowledgment tracked in
profiles.lab_acknowledgments jsonb. Acked items disappear from the
card. Card hides entirely when all items acked.

Browser + server fetchers follow the hybrid SSR-hydrate pattern from
CLAUDE.md's client cache section.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: AthleteProfilePanel — re-generate-with-GLP-1 CTA

**Files:**
- Modify: `components/profile/AthleteProfilePanel.tsx`

- [ ] **Step 1: Add a CTA when the active plan lacks GLP-1 awareness but intake mentions a GLP-1**

In `components/profile/AthleteProfilePanel.tsx`, alongside the existing "Generate plan" CTA:

```tsx
{active && active.plan_payload?.nutrition.glp1 == null && hasGlp1InMedications(active.intake_payload.health.medications) && (
  <RegeneratePlanWithGlp1Cta />
)}
```

Add the helper at the bottom of the file:

```ts
function hasGlp1InMedications(meds: string): boolean {
  const re = /\b(glp-?1|semaglutide|tirzepatide|ozempic|wegovy|mounjaro|zepbound)\b/i;
  return re.test(meds);
}

function RegeneratePlanWithGlp1Cta() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <Card variant="compact" style={{ borderColor: COLOR.accent, background: COLOR.accentSoft }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: COLOR.textStrong }}>
          Your plan isn't GLP-1-aware yet
        </div>
        <div style={{ fontSize: 12, color: COLOR.textMid, lineHeight: 1.5 }}>
          Your intake mentions a GLP-1 medication, but your current coaching plan was generated before GLP-1-aware logic existed. Regenerate to get protein floor raised to 1.8 g/kg BW, deficit alarm, hydration prompts, and lab-prompt module.
        </div>
        <button
          type="button"
          onClick={() => {
            startTransition(async () => {
              const result = await startPlanIntake();
              if (!result.ok) {
                alert(`Could not start: ${result.error}`);
                return;
              }
              router.push(`/coach?mode=intake&doc=${result.doc_id}`);
            });
          }}
          disabled={pending}
          style={{
            marginTop: 4,
            padding: "8px 14px",
            background: COLOR.accent,
            color: "#fff",
            border: "none",
            borderRadius: 999,
            fontSize: 12,
            fontWeight: 700,
            cursor: pending ? "wait" : "pointer",
            alignSelf: "flex-start",
          }}
        >
          {pending ? "Starting…" : "Regenerate with GLP-1 awareness →"}
        </button>
      </div>
    </Card>
  );
}
```

- [ ] **Step 2: Run typecheck + commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
git add components/profile/AthleteProfilePanel.tsx
git commit -m "feat(profile): regenerate-with-GLP-1 CTA

Surfaces when active plan lacks GLP-1 awareness but intake mentions a
GLP-1 medication. Click → startPlanIntake server action → redirect to
intake chat. Beat 3 GLP-1 follow-up captures the dose/schedule/timeline;
composer produces a glp1-mode plan.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 14: profile page — render LabPromptCard

**Files:**
- Modify: `app/profile/page.tsx` (or wherever AthleteProfilePanel is composed)

- [ ] **Step 1: Conditionally render LabPromptCard**

```bash
cd "/Users/abdelouahedelbied/Health app"
grep -n "AthleteProfilePanel" app/profile/page.tsx
```

Add LabPromptCard rendering when the active plan has `nutrition.glp1 != null`. Server-fetch the active plan to gate this; pass the user id to the card.

```tsx
import { LabPromptCard } from "@/components/profile/LabPromptCard";
import { fetchActiveAthleteProfileServer } from "@/lib/query/fetchers/athleteProfile";

// Inside the server component:
const active = await fetchActiveAthleteProfileServer(serverClient, user.id);
const showLabCard = active?.plan_payload?.nutrition?.glp1 != null;

// In the JSX:
{showLabCard && <LabPromptCard userId={user.id} />}
```

- [ ] **Step 2: Run typecheck + commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
git add app/profile/page.tsx
git commit -m "feat(profile): render LabPromptCard when active plan is GLP-1-mode

Server-checks active plan's nutrition.glp1 != null. Card renders only
when the user is in GLP-1 mode; hidden in classical / steady-state.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 15: CLAUDE.md update + final smoke

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add migration line and Coach/AI bullet**

In the Database migrations section, append:

```
11. [supabase/migrations/0012_lab_acknowledgments.sql](supabase/migrations/0012_lab_acknowledgments.sql) — adds `profiles.lab_acknowledgments jsonb` for the GLP-1 lab-prompt card.
```

In the Coach/AI section, append:

```
- **GLP-1-aware nutrition** lives across [lib/coach/plan-builder/compose-nutrition.ts](lib/coach/plan-builder/compose-nutrition.ts) (branches on `intake.health.glp1_status`), [lib/morning/brief/get-today-targets.ts](lib/morning/brief/get-today-targets.ts) (`resolveMode` returns `glp1_active | glp1_tapering | classical | steady_state`), and 3 new tools in [lib/coach/tools.ts](lib/coach/tools.ts). GLP-1 mode raises protein floor to 1.8 g/kg BW (2.0 for tirzepatide), drops scheduled diet breaks (research-driven; would fight the medication), adds a deficit-magnitude alarm and training-day hydration prompts. Post-discontinuation, the composer produces a classical phase-of-phases plan (8-week cut blocks separated by 2-week diet breaks, 4-week reverse, then maintain). The /profile page surfaces a lab-prompt card listing items the doctor likely isn't running (B12, vit D, Mg, ferritin, grip strength, bone density). See [docs/superpowers/specs/2026-05-12-glp1-aware-nutrition-design.md](docs/superpowers/specs/2026-05-12-glp1-aware-nutrition-design.md) for the full design.
```

- [ ] **Step 2: Final typecheck + build**

```bash
cd "/Users/abdelouahedelbied/Health app"
npm run typecheck
npm run build 2>&1 | tail -10
```

Both clean.

- [ ] **Step 3: Commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
git add CLAUDE.md
git commit -m "docs(claude): document GLP-1-aware nutrition module

Migration 0012, lib/coach/plan-builder/compose-nutrition.ts dual branch,
3 new tools, /profile lab-prompt card.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Self-review

After completing all 15 tasks:

**1. Spec coverage:** Walk the spec's "Files affected" section vs the plan's task list. Each modified file has a task that touches it. Tasks 1-4 cover the core schema + composer + runtime; 5-6 cover the brief; 7-9 cover the chat layer; 10-13 cover the UI; 14-15 finalize.

**2. Placeholder scan:** No "TBD", "TODO", "fill in later", or vague-validation placeholders. Where the existing helpers (`composeHardRules`) need to be located in the source file, the plan instructs `grep` to find them rather than guessing.

**3. Type consistency:** `Glp1Config`, `PhaseStep`, `RestDayDelta`, `ResolvedNutritionMode` defined in Task 2 and used uniformly downstream. `TodayTargets` extension propagates through Tasks 4, 5, 6. `ToolCallLog.name` union extended in Task 8 to accept the 3 new tool names.

**4. Known acceptable deviations from spec:**
- The spec mentions "today_phase_mode" in `TodayTargets` for classical-mode diet-break detection; the plan introduces this in Task 6 Step 3 as an inline addition. Documented in commit message.
- The spec's "Phase 2 → Phase 3 design constraints carried forward" is informational; no task is required for it.

## Execution Handoff

Plan saved to `docs/superpowers/plans/2026-05-12-glp1-aware-nutrition.md`. Execution via subagent-driven-development (REQUIRED sub-skill per the plan header).
