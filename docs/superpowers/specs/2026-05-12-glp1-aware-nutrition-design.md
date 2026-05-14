# GLP-1-aware nutrition module — design

**Status:** spec
**Author:** Apex Health OS (working with Abdelouahed)
**Date:** 2026-05-12
**Builds on:** Phase 2 — AI plan generation (shipped 2026-05-11, PR #47)
**Successor of:** the "phase-of-phases" Tier 2-A item from Phase 2's expert review

## Problem

Phase 2's coaching plan models nutrition as a single steady-state — one `kcal_target`, one set of macros, one `phase`. The expert review (Phase 2 spec Section 2) flagged two related deferrals: scheduled diet breaks every 8 weeks of cutting, and a reverse-diet ramp at the end. The original Tier 2-A pitch was to land both as a `phase_sequence` over time.

Live testing surfaced that the user (the one we are designing for) is on a **GLP-1 agonist** (Mounjaro / tirzepatide 2.5 mg/wk, Sunday PM injection, week 5 of a 4-month plan with progressive taper). A literature review (see `Research synthesis`, below) showed the classic RD/bodybuilding playbook does **not** transfer cleanly to GLP-1-mediated weight loss:

- Scheduled diet breaks lack mechanistic justification — the leptin/ghrelin signals refeeds restore are pharmacologically modulated by semaglutide/tirzepatide, so a planned +400 kcal day fights the medication.
- Reverse dieting still matters at end-of-treatment (regain after discontinuation is well documented: STEP-1 11.6pp regain in 1 yr; SURMOUNT-4 82.5% regain ≥25% in 1 yr) but its shape is **dose-taper-anchored**, not calendar-driven.
- The protein floor (1.6 g/kg actual BW from the user's doctor) is at or below the lower bound for GLP-1 + resistance training contexts; the converging evidence is 1.8-2.2 g/kg actual BW or 2.0-2.4 g/kg FFM with ≥25 g per meal.
- The dominant LBM-loss risk on GLP-1 is not "no diet breaks" — it is **unintentionally aggressive deficits** driven by appetite suppression running unsupervised. The intervention is a deficit-magnitude alarm, not a refeed.
- A handful of secondary items the doctor likely is not running: B12/vit D/magnesium/ferritin labs, grip-strength as a function proxy, hydration on training days.

But the user will be off the medication in ~4 months. Post-discontinuation he is back to willpower-based dieting where the classic playbook *does* apply. So the module must support **both** worlds.

## Goals

- Model nutrition with a **dual-mode** schema: GLP-1-aware or classical. Both shapes are first-class.
- Implement the GLP-1-aware mode (`glp1_active`, `glp1_tapering`) for the user's current 4-month treatment window.
- Land the classical phase-of-phases mode (scheduled diet breaks + reverse-diet ramp + training/rest-day deltas) so post-GLP-1 plans use it.
- Surface the four ancillary modules the research flagged: lab-prompt card, hydration block on training days, protein floor with FFM cross-check, medication+dose intake capture.
- Preserve full backward compatibility with Phase 2 plans (no migration; nullable jsonb extensions only).

## Non-goals

### Deferred to Phase 3 (drift detection layer)

- Automatic detection of taper start from `daily_logs.calories_eaten` rebound (vs. user-triggered).
- Automatic deficit-correction proposals (vs. flagging in Advice block).
- Grip strength as an automated function-decline signal — Phase 3 reads it but the logging UI is in-scope here.
- Stale-doc nudge using the Phase 3 12-week badge.
- Adaptive caloric drift logic (drop kcal after N stalled cut weeks).

### Tier 2 deferred items not covered here

- Per-muscle-group volume tracking (MEV/MAV/MRV) — v3.
- Session-type flexibility (drop the 5-type enum, support PPL/U-L/full body) — v3.
- Typed `progression_rule` (replace free-text with discriminated union) — post-Phase-3 polish.
- Goal decomposition (outcome / process / leading indicators) — separate brainstorm.

### Out of scope entirely

- Encoding the doctor's actual taper schedule into the app. The doctor owns the dose ramp; the app tracks `taper_started_on` as a milestone and adjusts Advice context accordingly.
- Mid-plan hot-edit of `glp1` or `classical_phases` fields. Mode changes durably via a new plan version (Phase 1 immutability invariant).
- Carb cycling beyond training-day uplift / rest-day delta. The case for per-day carb periodization beyond the existing fields is weak.
- Diet breaks during GLP-1-active phase. The research is clear; we explicitly exclude them.

## Research synthesis (what informed this design)

The full research output is captured in this session's conversation log; the design-relevant findings:

1. **Joint ACLM/ASN/OMA/TOS advisory (AJCN 2025)** — protein floor 1.0-1.5 g/kg adjusted BW for GLP-1 patients; resistance training ≥2×/wk non-negotiable; no mention of diet breaks.
2. **Obesity Pillars 2024 — muscle preservation on incretin drugs** — bodybuilding-adjacent practitioners converge on 1.8-2.2 g/kg actual BW with ≥25 g per meal; 2/3 of GLP-1 patients in the 2025 PMC12536186 case series *gained* lean mass when paired with resistance training at this protein intake.
3. **STEP-1 extension & SURMOUNT-4 post-hoc** — regain after discontinuation is the dominant clinical concern; dose tapering over ~9 weeks (2024 ECO data) is what works, not fixed calorie ramps.
4. **Cell Reports Medicine 2026** — GLP-1 LBM loss is proportional to total weight loss in users with adequate protein + resistance training; the bad headline figures (26-40%) come from sedentary trial cohorts.
5. **PubMed 40203836 (2025)** — tirzepatide does not bypass adaptive thermogenesis nor restore it. The classic T3-restoration rationale for diet breaks has no GLP-1 evidence.
6. **medRxiv 2026** — tirzepatide causes ~1-2% more LBM loss than semaglutide at matched time points; protein target tightens 0.1-0.2 g/kg if on tirzepatide.

Sources are linked in the conversation log; the design encodes the conclusions, not the citations.

## Architecture

### Mode model

`plan_payload.nutrition` has two new optional top-level fields. **Presence of `glp1` selects GLP-1-aware logic; presence of `classical_phases` selects the phase-of-phases playbook.** Both can coexist on a single plan version, in which case the active resolution order is: `glp1` first, then `classical_phases`, then fallback to top-level steady-state fields.

```ts
// lib/data/types.ts — additions to PlanPayload['nutrition']

type Glp1Config = {
  medication: "semaglutide" | "tirzepatide" | "compounded";
  dose_mg: number;
  injection_day: "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";
  injection_time: "morning" | "evening" | "night";
  started_on: string;                      // ISO YYYY-MM-DD
  expected_taper_start: string | null;     // milestone the user planned for
  taper_started_on: string | null;         // flipped by set_glp1_taper_started tool
  expected_end: string | null;             // planned discontinuation
  // tunable thresholds
  deficit_alarm_pct: number;               // default 0.25
  deficit_alarm_kcal: number;              // default 700
  protein_g_per_kg_bw: number;             // dose-tiered — see computeGlp1ProteinFloor
  per_meal_protein_floor_g: number;        // default 25
  hydration_training_day_ml: number;       // default 3500
  sodium_training_day_mg: number;          // default 1000
};

type PhaseStep = {
  start_week: number;                      // 0-indexed from acknowledged_at
  end_week: number;                        // exclusive
  mode: "cut" | "diet_break" | "reverse" | "maintain";
  kcal: number;                            // absolute (not delta — keeps getTodayTargets simple)
  protein_g: number;
  carb_g: number;
  fat_g: number;
  rationale: string;                       // shown in PlanProposalCard / brief Advice
};

type RestDayDelta = {
  kcal: number;                            // negative on cuts, e.g. -100
  carb_g: number;                          // negative, e.g. -25
  fat_g: number;                           // can be positive (replaces some carb with fat)
};

// extended PlanPayload['nutrition']
nutrition: {
  // existing top-level — describe TODAY (resolved by getTodayTargets at read time)
  phase: NutritionPhase;
  kcal_target: number;
  kcal_range: [number, number];
  protein_g: number;
  carb_g: number;
  fat_g: number;
  protein_g_per_kg_bw: number;
  
  // NEW: GLP-1 mode config — non-null means GLP-1-aware logic runs
  glp1: Glp1Config | null;
  
  // NEW: classical phase-of-phases — non-null means scheduled breaks/reverse logic runs
  classical_phases: PhaseStep[] | null;
  
  // NEW: rest-day delta (classical mode; for GLP-1 mode, defaults null)
  rest_day_delta: RestDayDelta | null;
  
  // existing
  training_day_uplift: { kcal: number; carb_g: number } | null;
  refeed_cadence_days: number | null;
  refeed_uplift: { kcal: number; carb_g: number } | null;
  hard_rules: HardRules;
  notes: string | null;
};
```

### Runtime mode resolution

`getTodayTargets(supabase, userId)` extends to compute the **runtime mode** from the plan + current date:

```ts
type ResolvedMode =
  | "glp1_active"
  | "glp1_tapering"
  | "classical"
  | "steady_state";

function resolveMode(plan, today): ResolvedMode {
  if (plan.nutrition.glp1) {
    return plan.nutrition.glp1.taper_started_on
      ? "glp1_tapering"
      : "glp1_active";
  }
  if (plan.nutrition.classical_phases?.length) {
    return "classical";
  }
  return "steady_state";
}
```

For each mode, `getTodayTargets` returns the resolved daily numbers + a `mode` discriminator:

```ts
// Existing TodayTargets type gets new fields
type TodayTargets = {
  // existing
  kcal: number; protein_g: number; carb_g: number; fat_g: number;
  bedtime: string; sleep_hours_target: number;
  phase: NutritionPhase;
  source: "plan" | "intake";
  
  // NEW
  mode: ResolvedMode;
  is_training_day: boolean;                // resolved from training_weeks.session_plan
  deficit_alarm: {                         // populated for glp1_* modes
    threshold_kcal_per_day: number;
    rolling_7d_avg_intake: number | null;
    rolling_7d_avg_deficit: number | null;
    triggered: boolean;
  } | null;
  hydration_target_ml: number | null;      // populated on training days in glp1_active
  sodium_target_mg: number | null;
};
```

### Mode-specific behaviors

**`glp1_active`** (current default for new GLP-1 user):
- `kcal` = plan.nutrition.kcal_target (no training-day uplift; no rest-day delta).
- `protein_g` = max(actual_bw × glp1.protein_g_per_kg_bw, FFM × 2.0) when Withings FFM <14d old. Else actual_bw × glp1.protein_g_per_kg_bw.
- `deficit_alarm.triggered` fires when 7d-avg deficit > glp1.deficit_alarm_kcal OR >25% of estimated TDEE. **TDEE estimate** uses Mifflin-St Jeor RMR × activity factor 1.5 (intermediate lifter training 3-4×/wk): `RMR = 10 × kg + 6.25 × cm − 5 × age + 5`. Inputs from `intake.lifestyle` (age, height) + most recent `daily_logs.weight_kg`. Cached on the plan in `nutrition.glp1.tdee_estimate_kcal` at composer time so the brief doesn't recompute daily.
- `hydration_target_ml` = glp1.hydration_training_day_ml when `is_training_day`; null on rest.
- `sodium_target_mg` = same pattern.

**`glp1_tapering`** (between `taper_started_on` and `expected_end`):
- `protein_g` constant (same as active).
- `kcal` ramps with appetite — implementation: linear ramp from active-phase target to estimated post-taper maintenance over the period `taper_started_on → expected_end`. If `expected_end` is null, hold at active-phase kcal +5% as a conservative default.
- `deficit_alarm.threshold_kcal_per_day` relaxes to glp1.deficit_alarm_kcal × 0.85 (e.g. 600 if active was 700).
- Hydration block stays on.

**`classical`** (post-GLP-1 or non-GLP-1 cuts):
- Find the active `PhaseStep` where `start_week ≤ elapsed_weeks < end_week`.
- `kcal` = step.kcal; macros = step.protein_g / step.carb_g / step.fat_g.
- Apply `is_training_day ? training_day_uplift : rest_day_delta` if non-null.
- `deficit_alarm = null` (classical playbook handles this via scheduled breaks).
- `hydration_target_ml = null`.

**`steady_state`** (fallback — Phase 2 plans with neither config):
- Current Phase 2 behavior unchanged.

### Mode transitions

Two new chat tools, both HMAC-free single-field writes (mirrors Phase 2 sanity-corrector pattern):

**`set_glp1_taper_started`** — input `{ taper_started_on: string (YYYY-MM-DD) }`. Writes to the active plan_payload (not the draft; this is a mid-plan in-place modification, justified because taper is a milestone not a re-plan). Updates `plan_payload.nutrition.glp1.taper_started_on`. The plan's `version` and `acknowledged_at` are NOT changed — this is a milestone update on the existing active version, not a new revision. (Phase 1's immutability invariant applies to the *acknowledged intake + plan*; milestone fields like `taper_started_on` are explicitly mutable state on the active doc, same model as a future Phase 3 `last_drift_check_at`.) Triggers brief regen tomorrow morning so the user sees the new banner.

**`mark_glp1_discontinued`** — input `{ end_date: string }`. Updates `plan_payload.nutrition.glp1.expected_end` if not already set, then surfaces a chat prompt: *"GLP-1 era done. Want to plan your next phase? Start a fresh intake for maintenance, reverse diet, or a classical cut."* Does NOT mutate `glp1` to null — the historical record stays. The user generates a new plan via the existing `/profile → Generate plan` CTA; the new plan's composer reads `intake.health.glp1_status.expected_end != null` and produces a classical plan instead of GLP-1.

These two tools intentionally bypass the propose/commit HMAC flow. They're single-field state transitions on the active plan, not re-plans, and replicating the HMAC machinery would force a full re-acknowledgment for a milestone-style update. Risk: the model can't fabricate a taper_started_on date the user didn't intend. Mitigation: tool description explicitly demands user confirmation in the conversation; same pattern as Phase 2's `set_directness` / `set_cadence`.

### Plan-builder composer changes

`lib/coach/plan-builder/compose-nutrition.ts` branches on `intake.health.glp1_status`:

```
if intake.health.glp1_status?.active:
    nutrition.glp1 = composeGlp1Config(intake.health.glp1_status, intake.nutrition)
    nutrition.classical_phases = null
    nutrition.rest_day_delta = null  // not used in GLP-1 modes
    nutrition.training_day_uplift = null
    // top-level fields = first-day GLP-1-active resolution
else:
    nutrition.glp1 = null
    nutrition.classical_phases = composePhaseSequence(intake.nutrition, intake.goals)
    nutrition.rest_day_delta = composeRestDayDelta(intake.nutrition.current_phase, intake.training.training_age)
    nutrition.training_day_uplift = composeTrainingUplift(intake.nutrition.current_phase, intake.training.training_age)
    // top-level fields = first-day classical resolution (phase[0].kcal etc.)
```

**`composeGlp1Config(glp1_status, nutrition)`:**
- `medication` ← from intake
- `dose_mg`, `injection_day`, `injection_time` ← from intake
- `protein_g_per_kg_bw` ← dose-tiered (see `computeGlp1ProteinFloor`): semaglutide & compounded flat at 1.8; tirzepatide tiers 1.8 (≤2.5 mg/wk) / 1.9 (5–7.5 mg/wk) / 2.0 (≥10 mg/wk) per medRxiv 2026 dose-response slope
- `deficit_alarm_pct = 0.25`, `deficit_alarm_kcal = 700`, `per_meal_protein_floor_g = 25`
- `hydration_training_day_ml = 3500`, `sodium_training_day_mg = 1000`
- `started_on`, `expected_taper_start`, `expected_end` ← from intake
- `taper_started_on = null` (filled later by chat tool)

**`composePhaseSequence(nutrition, goals)`** (classical):

Given `current_phase = "cut"`, `target_date`, and `training_age`, produce:

```
weeks_to_goal = (target_date - acknowledged_at) / 7
Plan a sequence:
  - cut blocks of 8 weeks
  - diet_break of 2 weeks between consecutive cut blocks
  - reverse of 4 weeks at end (last cut block ends → reverse)
  - maintain from reverse_end onward
```

For `current_phase != "cut"`, return null (no phase sequence; the existing single-phase steady-state stays). `lean_bulk` and `recomp` get no classical phases by design.

**`composeRestDayDelta(current_phase, training_age)`:**
- Cut + intermediate/advanced: `{ kcal: -100, carb_g: -25, fat_g: 0 }`
- Cut + beginner: `{ kcal: -50, carb_g: -15, fat_g: 0 }` (more conservative)
- Non-cut: null

### Intake chat extensions

`INTAKE_PROMPT` Beat 3 (deepen medical / restrictions) gets a GLP-1-specific follow-up template:

```
If intake.health.medications contains GLP-1 / semaglutide / tirzepatide / Ozempic / Wegovy / Mounjaro / Zepbound:
  Ask 3 questions in one turn:
    1. Which med + dose + day? (semaglutide vs tirzepatide; mg/wk; injection day)
    2. When did you start, and are you planning to taper off? When?
    3. Has your doctor mentioned diet breaks, refeeds, or specific protein targets?

  Synthesize into intake.health.glp1_status via set_glp1_status tool:
    { medication, dose_mg, injection_day, injection_time, started_on,
      expected_taper_start, expected_end, doctor_protocol_notes }
```

New tool: **`set_glp1_status`** — `{ medication, dose_mg, injection_day, injection_time, started_on, expected_taper_start?, expected_end?, doctor_protocol_notes? }`. Writes to `intake_payload.health.glp1_status` on the draft. Same single-field-write pattern as Beat 1/4 setters.

### Morning brief integration

`lib/morning/brief/get-today-targets.ts` → already returns `phase`; gains `mode`, `is_training_day`, `deficit_alarm`, `hydration_target_ml`, `sodium_target_mg` as above.

`lib/morning/brief/flags.ts` (existing GLP-1 flag) extends:
```ts
glp1: {
  active: boolean;
  medication: string | null;
  dose_mg: number | null;
  mode: ResolvedMode | null;             // NEW
  deficit_alarm_triggered: boolean;      // NEW
  rolling_7d_avg_deficit: number | null; // NEW
}
```

The Advice block prompt (`lib/morning/brief/index.ts`) gains 3 conditional context lines:
- If `mode === "glp1_active"` and `deficit_alarm_triggered`: *"7-day deficit averaging ~X kcal/day. GLP-1 appetite suppression can run too aggressive — add ~30g protein + a carb-heavy meal around tomorrow's session."*
- If `mode === "glp1_tapering"`: *"Tapering. Hold protein constant, let carbs ramp with appetite. Coordinate dose schedule with your doctor."*
- If `mode === "classical"` and `phase === "diet_break"`: *"Diet break week. Leptin restoration; appetite likely to rebound — that's the point. +400 kcal vs cut, all to carbs."*
- If `mode === "classical"` and `phase === "reverse"`: *"Reverse phase. Metabolic recovery; scale may drift up 0.3-0.5 kg from glycogen + water, not fat."*

The brief renders a new optional **Hydration block** above the Macros block when `hydration_target_ml != null`: *"Aim 3.5L water today; add ~1g sodium around session."* Hidden on rest days; hidden in all non-GLP-1 modes for v1.

### Lab-prompt card on /profile

New component: `components/profile/LabPromptCard.tsx`. Compact card listing items the user can ask their doctor for:

```
Labs at next check-up:
  □ B12 (baseline + 6mo)
  □ Vitamin D (baseline + 6mo)
  □ Magnesium (baseline + 6mo)
  □ Ferritin (baseline + 6mo)
  □ Lipids + CMP + HbA1c (probably already running)

Quarterly checks:
  □ Grip strength (cheap dynamometer — function decline often precedes mass decline)

If cut >12 months:
  □ Bone density (DXA) — GLP-1 + sustained deficit fracture-risk signal
```

Each item has a "✓ asked / done" toggle persisted in a new DB column or `profiles.lab_acknowledgments jsonb` (deferring exact persistence to the implementation plan). Items don't repeat in the card once acknowledged; a "show acknowledged" toggle reveals them again. The card is hidden entirely when `glp1 = null` and the user has acknowledged all items at least once — i.e., once the GLP-1 era is done and they've checked the box once, the nag is gone.

Conditional rendering: shown when active plan's `nutrition.glp1 != null`, hidden otherwise. (Phase 3 will extend visibility rules — e.g. show during reverse diet too.)

### PlanProposalCard updates

Mode-conditional Nutrition section in `components/chat/PlanProposalCard.tsx`:

**GLP-1 mode:**
```
Nutrition · GLP-1-aware
  Medication      tirzepatide 2.5mg/wk (Sun PM) — Mounjaro
  Phase           cut
  Calories        1850 kcal (alarm at >2550 deficit; relaxed during taper)
  Protein         206g (2.0 g/kg BW; tirzepatide elevated floor — cross-check 2.0 g/kg FFM)
  Carbs / Fat     180g / 55g
  Hydration       3.5L + 1g Na on training days
  Started         2026-04-07 · Expected taper: 2026-08-10 · End: 2026-09-12
```

**Classical mode:**
```
Nutrition · classical phase-of-phases
  Phase           cut → diet_break → cut → reverse → maintain
  Sequence        W1-7 cut · W8-9 break · W10-15 cut · W16-19 reverse · W20+ maintain
  Calories        1850 kcal (cut); 2250 (break); ramp +75 kcal/wk during reverse
  Protein         165g (1.6 g/kg BW)
  Carbs / Fat     180g / 55g (cut baseline)
  Rest-day delta  −100 kcal / −25g carbs
  Refeed          every 6 days
```

**Steady-state mode:** unchanged from Phase 2.

### Profile renderer

`renderProfileMarkdown` gains GLP-1 awareness in `renderPlanNutritionSection`:

- When `plan.nutrition.glp1`, render: medication, dose, schedule, taper milestones, deficit alarm threshold, hydration block.
- When `plan.nutrition.classical_phases`, render the phase sequence as a markdown table.

Existing single-phase rendering remains for steady-state.

## Schema migration

**None.** All additions are nullable jsonb extensions on existing nullable columns:
- `athlete_profile_documents.intake_payload.health.glp1_status` (optional object)
- `athlete_profile_documents.plan_payload.nutrition.glp1` (nullable object)
- `athlete_profile_documents.plan_payload.nutrition.classical_phases` (nullable array)
- `athlete_profile_documents.plan_payload.nutrition.rest_day_delta` (nullable object)

For the lab-prompt acknowledgments: `profiles.lab_acknowledgments jsonb` (default `{}`). This **does** require a migration:

```sql
-- supabase/migrations/0012_lab_acknowledgments.sql
ALTER TABLE profiles ADD COLUMN lab_acknowledgments jsonb NOT NULL DEFAULT '{}'::jsonb;
```

One additive nullable column, no data backfill needed.

## Phase 1 → GLP-1-aware Phase 2 transition for the existing user

The user already has an active Phase 2 plan from yesterday's PR #47. That plan was generated **without** GLP-1 awareness, so it has `nutrition.glp1 = null` and `nutrition.classical_phases = null` — i.e., it's in `steady_state` mode.

Path forward for the existing user:
1. `/profile` shows a "Re-generate plan with GLP-1 awareness" CTA when active plan has `nutrition.glp1 = null` AND `intake_payload.health.medications` mentions a GLP-1.
2. Click → `startPlanIntake()` (existing server action) → new draft → intake chat.
3. Intake chat Beat 3 GLP-1 follow-up captures medication, dose, schedule, taper milestones.
4. `propose_plan` → composer reads `glp1_status` and produces a `glp1`-mode plan.
5. `commit_plan` → new plan version active, prior superseded.

Subsequent transitions:
- User starts taper → chat tool `set_glp1_taper_started` mutates the active plan in place (no new version).
- User discontinues → chat tool `mark_glp1_discontinued` surfaces a CTA to regenerate as a classical or steady-state plan.

## Lifecycle

```
Day 0 (today):
  user.active_plan = phase-2-plan (steady_state mode, no GLP-1 awareness)
  
Day 0 → Day N:
  user clicks "Re-generate plan with GLP-1 awareness"
  intake chat captures glp1_status
  new plan committed: nutrition.glp1 = { medication, dose, started_on=2026-04-07, expected_end=2026-09-12, ... }
  mode resolved at runtime = glp1_active
  
Day ~95 (around 2026-08-10):
  user (in chat) tells coach "I'm starting my taper this Sunday"
  AI calls set_glp1_taper_started(date)
  plan in-place updated: nutrition.glp1.taper_started_on = "2026-08-10"
  mode now resolves to glp1_tapering
  
Day ~125 (around 2026-09-12):
  user (in chat) tells coach "I took my last dose"
  AI calls mark_glp1_discontinued(date)
  plan in-place updated: nutrition.glp1.expected_end = "2026-09-12"
  AI surfaces CTA: "Plan your next phase?"
  
Day ~125 → ?:
  user generates fresh plan (no GLP-1)
  intake.health.glp1_status.expected_end is set (history preserved)
  composer produces classical plan (or steady-state if user chose maintenance)
  new plan committed
```

## Files affected

### New files
- `components/profile/LabPromptCard.tsx`
- `supabase/migrations/0012_lab_acknowledgments.sql`

### Modified
- `lib/data/types.ts` — `Glp1Config`, `PhaseStep`, `RestDayDelta` types; `PlanPayload['nutrition']` extension; `IntakePayload.health.glp1_status` field; `TodayTargets` extension with `mode`, `is_training_day`, `deficit_alarm`, `hydration_target_ml`, `sodium_target_mg`.
- `lib/coach/plan-builder/compose-nutrition.ts` — branch on `intake.health.glp1_status`; new helpers `composeGlp1Config`, `composePhaseSequence`, `composeRestDayDelta`, `composeTrainingUplift`.
- `lib/morning/brief/get-today-targets.ts` — `resolveMode` helper; per-mode resolution; deficit-alarm computation (reads last 7 daily_logs for rolling kcal).
- `lib/morning/brief/flags.ts` — extend `glp1` flag with `mode`, `deficit_alarm_triggered`, `rolling_7d_avg_deficit`.
- `lib/morning/brief/index.ts` — Advice block prompt gains mode-conditional context lines; brief renderer adds optional Hydration block.
- `lib/coach/tools.ts` — three new tools: `set_glp1_status` (intake), `set_glp1_taper_started` (active plan in-place), `mark_glp1_discontinued` (active plan in-place).
- `lib/coach/chat-stream.ts` — register the three new tools in `intake` mode; `set_glp1_taper_started` and `mark_glp1_discontinued` also registered in `default` mode (they apply during normal chat, not just intake).
- `lib/coach/planning-prompts.ts` — INTAKE_PROMPT Beat 3 gets GLP-1 follow-up template; DEFAULT_SYSTEM_PROMPT gains a paragraph on taper/discontinuation tool usage.
- `components/chat/PlanProposalCard.tsx` — mode-conditional Nutrition section (three branches).
- `lib/coach/profile-renderer.ts` — `renderPlanNutritionSection` mode-branched.
- `components/profile/AthleteProfilePanel.tsx` — "Re-generate plan with GLP-1 awareness" CTA when active plan lacks GLP-1 awareness AND intake mentions a GLP-1.
- `app/profile/page.tsx` (or wherever the panel composes) — render `LabPromptCard` when conditions match.

### Removed
- Nothing. Phase 2's existing fields stay.

## Cost / risk

- ~300-400 LOC across 12 files (a few of them small).
- Migration: 1 additive column, no backfill.
- New tools: 3 (one intake setter, two active-plan in-place mutators).
- Anthropic API cost: unchanged. The brief's single Haiku call gains conditional context but no new API call. Plan-builder narrative still one Sonnet 4.6 call.
- Backward compatibility: full. Phase 2 plans without `glp1` or `classical_phases` keep working as steady-state via the resolveMode fallback.
- Estimated 4-day plan to implement following the same subagent-driven-development flow as Phase 2.

## Phase 2 → Phase 3 design constraints carried forward

When Phase 3 ships, the GLP-1-aware module will benefit from:
- **Automatic taper-start detection** from `daily_logs.calories_eaten` rebound trend (replaces user-triggered `set_glp1_taper_started`).
- **Automatic discontinuation detection** from absence of injection-day log entries or self-report.
- **Adaptive deficit alarm tuning** — Phase 3 drift detection can adjust `deficit_alarm_kcal` based on actual LBM trajectory from Withings.
- **Grip-strength logging UI** lives here (in scope), but Phase 3 reads it for the function-decline signal.

## Open question for review

The lab-prompt card persistence: a `profiles.lab_acknowledgments jsonb` column is the cleanest mechanism, but it does require a migration (one nullable additive column). Alternative: store acknowledgments in `localStorage` so no migration; downside is cross-device-loss. The migration is trivial; **default: do the migration**.

## Implementation handoff

After spec approval, transition to writing-plans skill to produce a task-by-task implementation plan saved to `docs/superpowers/plans/2026-05-12-glp1-aware-nutrition.md`. Then subagent-driven-development executes.
