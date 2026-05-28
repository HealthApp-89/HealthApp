# Sunday Prescription System — Design

**Date:** 2026-05-28
**Status:** Approved (awaiting implementation plan)
**Owner:** single-user app, Abdelouahed
**Relation to other work:** Builds on weekly-planning v1 (migration `0008_weekly_planning.sql`), session-structure coaching (spec 2026-05-19), schedule flexibility (migration `0012`), and the Carter coherence work (spec 2026-05-26). Replaces the prose-only progressive-overload narration with a structured, persisted per-exercise prescription that cascades to every surface the athlete sees.

## Problem

The strength card on `/strength` shows static weights from `lib/coach/sessionPlans.ts` (Deadlift 82.5 kg × 6 × 2) while Coach Carter is prescribing 97.5 kg × 6-8 × 3 in chat and the morning brief is narrating the same. The athlete sees three different numbers for the same lift on the same day depending on which surface they look at, and the card is wrong on all of them.

Root cause: **there is no persistence path for per-exercise prescriptions**. The current write tools cover narrow cases:

- `commit_session_today` ([lib/coach/tools.ts:1922](../../../lib/coach/tools.ts#L1922)) — for mid-block exceptions only ("pain, equipment, illness, boredom"); explicitly NOT for routine progression.
- `commit_session_template` ([lib/coach/tools.ts:2159](../../../lib/coach/tools.ts#L2159)) — for first-time setup or block-boundary accessory rotation, not weekly progression.
- `commit_week_plan` ([lib/coach/tools.ts:1591](../../../lib/coach/tools.ts#L1591)) — writes session-type names + a per-primary-lift `intensity_modifier` multiplier (only 4 lifts; not per-exercise).

The Sunday weekly-planning ritual ends with a `training_weeks` row that knows session types but does not know weights, sets, or reps for any individual exercise. Carter's per-exercise advice lives in chat prose only — `chat_messages` content, never structured fields.

Three concrete symptoms:

1. **Card stale forever.** [lib/coach/sessionPlans.ts:38](../../../lib/coach/sessionPlans.ts#L38) `SESSION_PLANS` constants were ported from the prototype with year-old `baseKg` values. Deadlift sits at 82.5 kg; the athlete actually pulls 97.5+ kg. Three surfaces (card, brief structured block, logger pre-fill) all bottom out here.
2. **Brief AI advice fabricates.** Haiku 4.5 reads `query_workouts` history and freely narrates "+2.5 kg from last Thursday's 95 kg × 7" in `advice_md`, but the structured `session` block underneath still says 82.5 — the prose contradicts the data block, and neither is the source of truth for the next surface.
3. **No coaching discipline encoded.** When the block target is exceeded mid-block (deadlift block target 95 kg hit in week 3 at 97.5 kg), there is no system mechanism to enforce consolidation. Carter could narrate "let's push to 100 next week" and nothing stops him. The DB doesn't refuse — it has no opinion.

This spec covers the Sunday Prescription System: a new top-of-chain layer that captures Carter's full weekly prescription per-exercise, with server-side validation that enforces standard strength-coaching discipline (target immutability, consolidation on early target-hit, flat maintenance for non-focus primaries, pattern-conflict overlays). All three surfaces read from the new layer.

## Goals

1. **One persisted per-exercise prescription per day per week.** New `training_weeks.session_prescriptions jsonb` column: `{ Monday: PlannedExercise[], Tuesday: …, … }`. Generated and committed during the Sunday planning ritual; read by card, brief, and logger.
2. **Extended resolution chain with discovery layer.** `session_prescriptions[weekday]` is the new top; below it sits the existing `exercise_overrides[weekday]`, then `user_session_templates[session_type]`, then a NEW `recent_workouts(session_type, last 4-8)` discovery layer that materializes what the athlete actually trains; `SESSION_PLANS` is the last-resort fallback.
3. **Block target immutability + consolidation rule encoded.** New nullable `training_blocks.target_hit_at_week int` field captures when working_kg crossed `target_value`. Once non-null, the propose-tool refuses load increases on the primary lift for the remainder of the block.
4. **Flat maintenance for non-focus primaries during a focus block.** During weeks 1-4 of a focus block, non-focus primary multipliers default to **0.90** in the rule output, and `propose_week_plan` validates that the committed value is **≤ 0.92** (the 0.02 slack accommodates equipment-grid rounding when 0.90 × current_working_weight lands between increments). Their working-set count drops by ≥1 vs their non-focus baseline. Week 5 deload drops everyone to ~0.80.
5. **Maintenance baseline read from recent workouts.** `maintenanceLoadFor(lift, today)` returns `max(working_kg in last 4 weeks where rpe ≤ rir_target + 1)`. Falls through to `user_session_templates`, then `SESSION_PLANS`. No more multiplying stale `baseKg` from code.
6. **Pattern-conflict overlay.** Axial-loaded hinge accessories (RDL, Good Morning, Stiff-Leg DL) blocked on non-focus days during a deadlift focus block. Low-axial hinges (Hip Thrust, 45° Hyperextension, Cable Pull-Through) allowed and recommended when hinge frequency is below MEV. Extensible to other patterns (high-axial squat variants in squat blocks, etc.).
7. **Sunday ritual structural change.** `propose_week_plan` schema gains a required `session_prescriptions` field. The PLAN_WEEK_PROMPT teaches Carter to produce three sub-reports (block primary phase, secondary lift trajectories, per-muscle volume) and emit the full per-exercise plan. Cannot reach commit without producing a valid prescription set.
8. **Deterministic numbers, AI-narrated only.** Per-exercise loads/sets/reps are computed by three pure rule modules (block-phase, autoregulation, volume-balance) from workout history + block state. Carter's prose narrates the numbers; he does not invent them. Same pattern as the morning brief's structured/advice split — proven low-fabrication.
9. **All three surfaces read the new chain.** `getEffectiveSessionPlan` ([lib/coach/sessionPlans.ts:127](../../../lib/coach/sessionPlans.ts#L127)) absorbs the new top layer + the discovery layer. Card, brief structured block, logger pre-fill all update with no per-surface code changes beyond what `getEffectiveSessionPlan` returns.
10. **Backward compatible.** Weeks with `session_prescriptions = null` continue to render exactly as today (fall through to existing chain). Migration adds no defaults. Existing committed weeks are not retro-populated.

## Non-Goals

- **Multi-target blocks.** One primary lift per block stays the rule. Powerlifting-style multi-target blocks out of scope.
- **Mutating `target_value` mid-block.** No path to revise a block's target. To raise targets, close the block and start a new one. This is by design (preserves the honest-projection audit trail).
- **Phase-gated maintenance for non-focus primaries.** Flat 0.90× from week 1-4, deload at week 5. Phase-gating (full autoregulation weeks 1-2, back off weeks 3-4) is explicitly rejected — the simpler version matches Renaissance Periodization / Helms consensus and avoids the "feel-good week 1 burns recovery for week 3-4" failure mode.
- **AI-generated per-exercise prescriptions.** Numbers are deterministic. Carter cannot freestyle a number — `propose_week_plan` validation refuses off-grid weights, out-of-band multipliers, and pattern conflicts. Only the surrounding narrative is AI.
- **A new dedicated "Block Pulse" page.** Sunday review continues to live in chat + the existing `weekly_reviews` document. No new screen.
- **Auto-bumping `user_session_templates` from logger commits.** Considered (option B from the brainstorm) but deferred — `session_prescriptions` becomes the canonical weekly source and `user_session_templates` retains its current "save deviations as my default" role, written explicitly by the user. The discovery layer (recent workouts) covers the "what does the athlete actually train" question without conflating it with "what's their saved default."
- **A separate `commit_exercise_baseline` tool.** Per-exercise persistence happens via `session_prescriptions` inside `commit_week_plan`. No standalone write surface for individual exercises.

## Architecture

### Data model

```sql
-- migration 0036_sunday_prescriptions.sql

alter table training_blocks
  add column target_hit_at_week int;  -- nullable; the week_n (1-indexed within block) when working_kg first crossed target_value

alter table training_weeks
  add column session_prescriptions jsonb;  -- nullable; { Monday: PlannedExercise[], Tuesday: …, … } keyed by full weekday name (en-US)

comment on column training_blocks.target_hit_at_week is
  'When the active block''s primary-lift working_kg first crossed target_value. Sets the block into consolidation phase — propose_week_plan refuses further load increases on the primary lift. NULL = pre-target; non-NULL = post-target. Set by the block-progress evaluator on workout commit.';

comment on column training_weeks.session_prescriptions is
  'Full per-exercise per-day plan committed by Carter on Sunday. jsonb shape: { Monday: PlannedExercise[], Tuesday: PlannedExercise[], … } keyed by full weekday names (Monday-Sunday). Each PlannedExercise carries name, baseKg, baseReps, sets, key, increment, note. NULL = no Sunday plan committed yet; the resolution chain falls through to the next layer. Becomes the new top of the resolution chain consumed by getEffectiveSessionPlan.';
```

That is the entire schema change. Secondary-lift trajectories, per-muscle volume, and block phase are derived data — computed on demand from `workouts`, `exercise_sets`, `training_blocks`, `training_weeks`. No new tables.

### Resolution chain

`getEffectiveSessionPlan` ([lib/coach/sessionPlans.ts:127](../../../lib/coach/sessionPlans.ts#L127)) and its server-side twin in [lib/logger/resolve-plan.ts](../../../lib/logger/resolve-plan.ts) update to walk this chain:

```
training_weeks.session_prescriptions[weekday]    ← Sunday-committed plan (NEW TOP)
  ↓ (null/missing → fall through)
training_weeks.exercise_overrides[weekday]       ← mid-week one-off swap (existing)
  ↓
user_session_templates[session_type]             ← "save deviations as my default" (existing)
  ↓
recent_workouts(session_type, last 4-8 sessions) ← what the athlete actually trains (NEW DISCOVERY)
  ↓
SESSION_PLANS[session_type]                      ← code default (demoted to last resort)
```

The **discovery layer** is computed: for a given `session_type` (e.g., "Legs"), find the last 4-8 `workouts` rows of that type for the user, aggregate the distinct `exercises.name` values that appear in ≥50% of them, and emit them as a `PlannedExercise[]` with `baseKg = max(working_kg in last 4 weeks where RPE ≤ rir_target + 1)`. This layer heals the "SESSION_PLANS says I do RDL but I haven't done it in months" failure mode automatically.

Discovery layer caching: cached in TanStack Query at the page level (5-minute staleness is fine). Server-side resolve-plan computes on demand; the cost is one indexed query per session_type per render.

### Sunday ritual — three sub-analyses + three rule sets

The 4-beat structure from [planning-prompts.ts:43](../../../lib/coach/planning-prompts.ts#L43) keeps its shape (RECAP / CHECK-IN / PROPOSE / COMMIT). The content of each beat sharpens:

**RECAP beat — three sub-reports.**

1. *Block primary status.* Computed by a new `evaluateBlockPhase(block, workouts)` function returning one of: `pre_target` / `consolidation` / `off_pace` / `deload_week`. The phase determines how the next week's primary-lift prescription is generated. Includes block-to-date trajectory of the primary lift's working weight and e1RM.
2. *Secondary lift trajectories.* For each of the other 3 primary lifts, e1RM slope across the block's weeks-to-date. Reported as rising / flat / falling. No contract — diagnosis only.
3. *Per-muscle volume status.* Computed by the existing [lib/coach/muscle-volume.ts](../../../lib/coach/muscle-volume.ts) module against MEV/MAV/MRV landmarks. Identifies undertrained muscles (the hinge-frequency gap insight comes from this) and overtrained ones (MRV proximity).

**PROPOSE beat — full per-exercise prescription emission.**

For each non-REST day, Carter calls `propose_week_plan` with `session_prescriptions[weekday] = PlannedExercise[]`. Each exercise's `baseKg`/`baseReps`/`sets` is determined by which rule applies:

| Layer | Rule | Inputs | Output fields set |
|---|---|---|---|
| Block primary (deadlift in current block) | **Block-phase rule** | block.target_hit_at_week, current working weight, weeks remaining | baseKg per phase; baseReps per phase; sets per phase |
| Other primaries (squat, bench, OHP) | **Autoregulation rule** + 0.92× cap during focus block | last 2-4 weeks of working weight + RIR achieved, intensity_modifier | baseKg ≤ 0.92 × current_working_weight; baseReps; sets dropped 1 vs baseline |
| Accessories | **Volume-balance rule** | per-muscle weekly sets actual vs MEV/MAV/MRV, accessory's own kg history | sets per band position; baseKg via autoregulation; substitution allowed at block boundary only |

A fourth overlay applies on top: **pattern-conflict guard**. For a deadlift focus block, prescriptions containing axial-loaded hinges (RDL, Good Morning, Stiff-Leg DL) on non-Thursday days are rejected. Low-axial hinges allowed.

**COMMIT beat — unchanged shape, new payload size.**

`commit_week_plan` writes the `training_weeks` row including `session_prescriptions`. HMAC approval-token discipline ([commit-discipline rules in PLAN_WEEK_PROMPT](../../../lib/coach/planning-prompts.ts#L64)) unchanged.

### Rule modules

New pure-function module per rule, each with a typed input/output shape:

```
lib/coach/prescription/
  ├── block-phase-rule.ts        // evaluateBlockPhase + prescribePrimaryFromPhase
  ├── autoregulation-rule.ts     // prescribeSecondaryAutoregulated (with 0.92× cap)
  ├── volume-balance-rule.ts     // prescribeAccessoryFromVolumeBand
  ├── pattern-conflict-overlay.ts // validatePatternConflicts (post-prescription, pre-validation)
  ├── maintenance-baseline.ts    // maintenanceLoadFor(lift, userId, today)
  ├── recent-workouts-discovery.ts // discoverEffectiveExercises(sessionType, userId, todayIso)
  └── prescribe-week.ts          // top-level orchestrator called by propose_week_plan executor
```

All six rule modules are pure functions with no Supabase imports — data is passed in. Data fetching sits in the thin adapter `lib/coach/prescription/prescribe-week.ts`, which is the only file in this directory that touches Supabase. Tests trivial: feed a fixture week + workout history, assert output shape.

### Propose-tool guards (server-side validation)

`executeProposeWeekPlan` runs `validateWeekPrescription(payload, block, recentWorkouts)` before signing the approval token. Hard rejects with structured error + hint:

1. **off_grid_weight** — any `baseKg` not on the equipment grid (reuse the guard from `executeProposeSessionToday` lines 1969-2021; extract into shared helper).
2. **consolidation_load_increase** — when `block.target_hit_at_week != null` and primary-lift `baseKg` proposed > previous week's primary-lift `baseKg`.
3. **non_focus_primary_overcooked** — during a focus block, a non-focus primary's effective load > 0.92 × `maintenanceLoadFor(...)`.
4. **non_focus_primary_volume_too_high** — during a focus block, a non-focus primary's `sets` ≥ its non-focus baseline. Must drop by ≥1.
5. **pattern_conflict** — axial-loaded hinge accessory on a non-focus day during a deadlift focus block. (Symmetric rule for other block-pattern combinations as added.)
6. **mismatched_session_type** — exercises in `session_prescriptions[weekday]` that don't belong to the `session_plan[weekday]` session type (e.g., Squat in a Chest day). Soft warning, not hard reject — allow user customization but flag in the rationale shown to the athlete.

Each rejection returns a JSON error Carter narrates back to the user. He cannot land an invalid week. The DB refuses it.

### Block-phase evaluator (the consolidation forcing function)

```ts
type BlockPhase = 'pre_target' | 'consolidation' | 'off_pace' | 'deload_week';

function evaluateBlockPhase(
  block: TrainingBlock,
  workouts: Workout[],
  todayIso: string,
): BlockPhase {
  if (currentBlockWeek(block, todayIso) === 5) return 'deload_week';
  if (block.target_hit_at_week != null) return 'consolidation';

  const weeksRemaining = totalBlockWeeks(block) - currentBlockWeek(block, todayIso);
  const currentWorkingKg = primaryLiftWorkingKg(block, workouts);
  const requiredProgressionRate = (block.target_value - currentWorkingKg) / weeksRemaining;
  const observedProgressionRate = recentProgressionRate(block, workouts);

  if (requiredProgressionRate > observedProgressionRate * 1.5) return 'off_pace';
  return 'pre_target';
}
```

`target_hit_at_week` is set by a small evaluator that runs on workout commit: after `commit_logger_session`, check whether the new working set for the block's primary lift crossed `target_value`. If so, UPDATE `training_blocks.target_hit_at_week = currentBlockWeek(...)` for the active block. Idempotent — only sets if currently NULL.

### Pattern-conflict overlay

```ts
const AXIAL_HINGE_KEYS = ['rdl', 'good_morning', 'stiff_leg_dl'];
const LOW_AXIAL_HINGE_KEYS = ['hip_thrust', '45_hyper_loaded', 'cable_pull_through'];

// Maps each primary lift to the session_type it lives in. Used to find which
// weekday is the "focus day" by looking up the user's session_plan for the
// current week. e.g., deadlift lives in 'Back'; if session_plan[Thursday] = 'Back',
// then Thursday is the focus day for a deadlift block. Resolved per-week from
// training_weeks.session_plan, NOT hardcoded — different users may train Back
// on different days.
const PRIMARY_LIFT_TO_SESSION: Record<PrimaryLift, string> = {
  deadlift: 'Back',
  squat:    'Legs',
  bench:    'Chest',
  ohp:      'Chest',  // shares the day with bench in this athlete's split
};

function focusDayForBlock(block: TrainingBlock, week: TrainingWeek): WeekdayLong | null {
  if (block.primary_lift == null) return null;
  const focusSessionType = PRIMARY_LIFT_TO_SESSION[block.primary_lift];
  const sessionPlan = week.session_plan as Record<WeekdayLong, string>;
  return (Object.entries(sessionPlan).find(([_, st]) => st === focusSessionType)?.[0] as WeekdayLong) ?? null;
}

function validatePatternConflicts(
  prescription: SessionPrescriptions,
  block: TrainingBlock,
  week: TrainingWeek,
): PatternConflictError | null {
  if (block.primary_lift !== 'deadlift') return null;

  const focusDay = focusDayForBlock(block, week);
  for (const [weekday, exercises] of Object.entries(prescription)) {
    if (weekday === focusDay) continue;

    const offending = exercises.filter(e => AXIAL_HINGE_KEYS.includes(e.key ?? ''));
    if (offending.length > 0) {
      return {
        code: 'pattern_conflict',
        message: 'Axial-loaded hinge accessory on a non-focus day during a deadlift focus block.',
        offending: offending.map(e => ({ weekday, exercise: e.name })),
        hint: `Move to ${focusDay}, swap for a low-axial variant (${LOW_AXIAL_HINGE_KEYS.join(', ')}), or drop.`,
      };
    }
  }
  return null;
}
```

Block-pattern matrix extensible: when `primary_lift === 'squat'`, axial squat variants like Front Squat or High-Bar Squat on non-focus-day weekdays trigger the same conflict. The `PRIMARY_LIFT_TO_SESSION` map is the single point of customization for future patterns.

### `target_hit_at_week` evaluator — where it runs

The evaluator is a thin server-side helper: `evaluateAndStampTargetHit(userId, block, supabase)`. It compares the highest working-set kg in the block's primary lift across all `workouts` since `block.start_date` against `block.target_value`. If crossed and `target_hit_at_week` is currently NULL, it UPDATEs the row with the current block week index. Idempotent — no-op when already set.

Two invocation sites:

1. **On every `commit_logger_session` call** (in [/api/logger/session](../../../app/api/logger/session/route.ts)) — after the workout commits, run the evaluator inline. Cheap (one query, one optional update). Catches the moment the target is crossed.
2. **One-shot migration script** (`scripts/seed-target-hit-at-week.mjs`) — after migration 0036 applies, walk all active blocks and run the evaluator once to backfill any blocks whose primary already crossed their target.

### Surfaces — what changes per consumer

| Surface | File | Change |
|---|---|---|
| `/strength` card | [components/strength/TodayPlanCard.tsx](../../../components/strength/TodayPlanCard.tsx) | None — reads `getEffectiveSessionPlan(...)` which now returns prescription-derived exercises |
| Morning brief structured `session` block | [lib/morning/brief/assembler.ts:318](../../../lib/morning/brief/assembler.ts#L318) | None — same `getEffectiveSessionPlan` upstream |
| Morning brief AI advice | [lib/morning/brief/advice-prompt.ts](../../../lib/morning/brief/advice-prompt.ts) | Prompt updated: "Narrate the committed `session.exercises` block. Do not invent loads — the structured block IS the truth." Fabrication risk drops because the numbers are now committed Sunday |
| Logger pre-fill | [lib/logger/resolve-plan.ts](../../../lib/logger/resolve-plan.ts) | Chain updated to include `session_prescriptions[weekday]` as top layer + `recent_workouts` discovery as fallback |
| Sunday chat (Carter, `mode='plan_week'`) | [lib/coach/planning-prompts.ts](../../../lib/coach/planning-prompts.ts) | PLAN_WEEK_PROMPT extended with three-sub-report RECAP + per-exercise PROPOSE instructions + consolidation/maintenance/pattern-conflict rules in the system prompt |
| `propose_week_plan` schema | [lib/coach/tools.ts:1564](../../../lib/coach/tools.ts#L1564) | Required `session_prescriptions` field added; validation hooks `validateWeekPrescription` added |
| Day-swap sheet | [components/strength/DaySwapSheet.tsx](../../../components/strength/DaySwapSheet.tsx) | None — writes `exercise_overrides[weekday]`, which still sits one layer below `session_prescriptions` |

### Initial seeding for the current block + week

On migration apply, three one-shot writes against the current active state:

1. **Set `target_hit_at_week`** by evaluating the active block's primary lift against `target_value` from existing workout history. The evaluator runs once during migration to populate; subsequent updates happen on workout commit.
2. **Drop RDL from the user's effective Monday Legs** via the discovery layer healing automatically — no explicit write needed. The next Sunday plan will be built from observed workout history, which contains no RDL.
3. **Seed next Sunday's prescription** with Hip Thrust 60 kg × 10 × 3 RIR 3 added to Monday Legs. Either the next manual Sunday plan call by the user OR a one-shot script that fires after migration apply.

The migration itself only touches schema. Application-level seeding is handled by Carter's next Sunday ritual (the new prompt will surface the hinge-frequency gap and add Hip Thrust as part of the standard volume-balance rule application).

## Edge cases

- **First week with no Sunday plan.** `session_prescriptions = null` → chain falls through. Same UX as today. No regression.
- **Sunday plan partially specifies days.** `session_prescriptions = { Monday: [...], Thursday: [...] }` (missing Tue/Fri) → those days fall through to the existing chain. Each weekday key is independently optional.
- **Block has no primary_lift.** Maintenance multipliers don't apply; autoregulation rule runs for all primaries. Volume-balance rule covers accessories. Pattern-conflict overlay short-circuits.
- **Block target hit in week 1.** Block target was severely underset. `target_hit_at_week = 1` is recorded. Carter narrates: "You hit the target immediately — block was massively underset. We consolidate for weeks 2-5 and set next block much higher. We do not retro-revise this block." Block continues normally with consolidation rules engaged from week 2.
- **Deload week (week 5).** `evaluateBlockPhase` returns `'deload_week'` regardless of `target_hit_at_week`. All multipliers drop to 0.80 (configurable). Volume cut 50%. Standard deload.
- **Athlete revises a Sunday plan mid-week.** They explicitly call Carter and re-run `propose_week_plan` for the same `week_start`. Idempotent on `(user_id, week_start)` — UPDATE replaces. New approval token required. `original_session_plan` audit field (from migration 0012) gets COALESCE'd with the new payload at first revision.
- **A Mobility or REST day.** `session_prescriptions[Wednesday]` likely null — Mobility doesn't need a prescription; falls through to `SESSION_PLANS.Mobility`. Carter may still emit a prescription if the user requests structured mobility work.
- **Discovery layer disagrees with `user_session_templates`.** `user_session_templates` wins (higher in chain). The discovery layer only activates when the user has no saved template.
- **Discovery layer for a new gym / first 8 weeks.** Falls through to `SESSION_PLANS`. Carter's first Sunday plans operate from `SESSION_PLANS` defaults until enough workout history accumulates (≥4 sessions of the same type).

## Trade-offs explicitly considered and rejected

| Considered | Rejected because |
|---|---|
| Multi-target blocks (squat + bench + deadlift contracts) | Real lifters credibly prioritize one lift; multi-target dilutes intent. Coaching consensus (Helms, Israetel) is sequential blocks. |
| Phase-gated maintenance (autoreg weeks 1-2, back off weeks 3-4) | Fatigue doesn't accumulate linearly; athletes burn recovery in week 1 and crash week 3-4. Flat 0.90× is simpler and matches RP/Helms. |
| Mutating `target_value` mid-block | Destroys the honest-projection audit trail. Closed system. Raise targets next block. |
| Auto-bump `user_session_templates` from logger | Conflates "user's saved default" with "this week's prescription." Discovery layer handles the freshness question without overloading semantics. |
| Standalone `commit_exercise_baseline` tool | Per-exercise persistence happens through Sunday `commit_week_plan`. Separate tool would be a second source of truth. |
| AI-generated per-exercise loads | Fabrication risk too high. Numbers from deterministic rules; AI narrates only. |
| Per-block "Block Pulse" dashboard page | Sunday review lives in chat + `weekly_reviews` doc. No new page. |
| RDL/Good Morning on Monday during deadlift block | Independent expert coach (consulted 2026-05-28) confirms: axial-load stacking costs > stimulus benefit during consolidation. Low-axial hinges (Hip Thrust, 45° Hyper) recommended instead. |

## References

- Brainstorm transcript: this turn-by-turn conversation 2026-05-28
- Independent expert coaching review (Sonnet 4.6, 2026-05-28): hinge frequency verdict — add Hip Thrust 3×8-10 RIR 2-3 on Monday during deadlift focus blocks
- Schoenfeld 2016/2019 meta-analyses (Sports Med): 2× weekly frequency > 1× when total volume equated
- Israetel et al., Renaissance Periodization volume landmarks (MEV/MAV/MRV)
- Helms et al., The Muscle and Strength Pyramids — secondary-lift maintenance during focus blocks
- Bickel et al. 2011, Spiering et al. 2021 — volume threshold for strength maintenance (~1/3 of growth volume)
- Contreras EMG work — Hip Thrust glute activation vs conventional deadlift
- Related shipped specs:
  - `2026-05-15-weekly-review-document-design.md` — Sunday recap-and-prescribe pattern this builds on
  - `2026-05-19-session-structure-coaching-design.md` — per-exercise annotation upstream of card rendering
  - `2026-05-26-carter-coherence-design.md` — coherence rules and off-grid weight guard
