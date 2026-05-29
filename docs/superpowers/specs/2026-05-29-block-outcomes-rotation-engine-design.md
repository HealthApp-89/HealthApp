# Block Outcomes + Rotation Engine — Design

**Date:** 2026-05-29
**Status:** Approved (awaiting implementation plan)
**Owner:** single-user app, Abdelouahed
**Relation to other work:** Direct extension of the Sunday Prescription System (spec [2026-05-28](2026-05-28-sunday-prescription-system-design.md), shipped PRs #119/#120/#121). The prescription system enforces the block-phase rules WITHIN a block; this spec covers what happens BETWEEN blocks — automated outcome capture, deterministic rotation recommendation, target calibration from real data, and a cross-block macrocycle view so the athlete can see whether programming is improving over time.

## Problem

The current block setup flow ([SETUP_BLOCK_PROMPT](../../../lib/coach/planning-prompts.ts) in `planning-prompts.ts:103`) just asks "which primary lift do you want to focus?" with no rotation logic, no historical-block lookup, and no recommendation. After a block closes (auto-resolved at read time when `today > end_date`), three failure modes surface:

1. **Athlete picks the same lift again.** The current block was 5 weeks of focused deadlift work; running another 5 weeks of focused deadlift immediately leaves the lift's prime movers unrecovered and creates volume debt on squat/bench/OHP that compounds across cycles. Standard intermediate-mistake territory (Israetel calls it "stress diffusion"; Helms calls it "ignoring the recovery prerequisite").

2. **Target for the next block is set from a guess, not from data.** The current block's target (115 kg deadlift) was set during a layoff-rebound window. End-of-block reality lands at ~100 kg. When deadlift comes back around in 15-20 weeks, there is no system memory of that calibration error — the athlete sets another aspirational round-number target ("125 kg this time"), creating a second off-pace block, and the pattern repeats.

3. **No cross-block visibility.** The athlete cannot see "Block 1 deadlift ended off-pace at 100; Block 5 deadlift hit 110 on-pace; Block 9 deadlift hit 117.5 hit_early" — the long-term trajectory and target-calibration learning are invisible. Every block feels isolated. Programming as a discipline is the WHOLE-MACROCYCLE shape, not the per-block decisions; without trajectory we cannot tell whether the discipline is working.

The Sunday Prescription System fixed the within-block discipline. This spec fixes the between-block discipline.

## Goals

1. **One row per closed block in `block_outcomes`.** Versioned by `(block_id)`, written by a deterministic evaluator after the block's `end_date` passes. Captures: target, end working kg, target_hit boolean, phase_at_end (hit_early / hit_on_pace / off_pace / underperformed), structured lessons jsonb, and the next-focus recommendation with a calibrated target.

2. **Daily cron sweep at 02:00 UTC** detects blocks whose end_date has passed and lack a `block_outcomes` row, runs the evaluator, writes the row, and writes a matching `chat_messages.kind='block_outcome'` row so the card surfaces in chat.

3. **4-lift rotation engine** as the default policy. `D → B → S → OHP → repeat`. Deterministic. Reads `profiles.rotation_priority_lift` for the persistent-priority injection pattern: when a priority lift is set, every other rotation slot becomes that lift (8-block cycle, priority lift gets 4 of 8 slots, no two priority focuses in a row).

4. **Target calibration from real data.** When a lift comes back around in rotation, the recommended target is `end_working_kg_of_last_focus_block + (observed_step_kg_per_wk × 4 accumulation weeks)` — derived from the lift's most recent focus block's actual progression rate, not from a fresh guess.

5. **SETUP_BLOCK_PROMPT extended.** ELICIT beat reads the most recent unacknowledged `block_outcomes` row, leads with the rotation recommendation, surfaces the calibrated target, and respects athlete override via an explicit `DeadlineConfirmChip` for consecutive-same-lift focus. Athlete overrides are auditable (persisted to `block_outcomes.lessons.athlete_overrode_rotation`).

6. **Persistent priority lift** as a single-value setting (`profiles.rotation_priority_lift`). Captured at intake (plan-builder goal beat) and editable on `/profile`. Default NULL means standard rotation. Setting one lift triggers the injection pattern.

7. **Cross-block trajectory analysis** via `lib/coach/block-outcomes/trajectory.ts`. All deterministic. Surfaces in two places: a "Macrocycle view" block on the block_outcome chat card (per-lift one-liner) AND a new "Block History" subsection on `/coach/trends?section=performance` (full chart + adherence + calibration trend).

8. **Carter's chat-context block extended.** `framework-state.ts` adds a "between blocks" fallback for when no active block exists but a recent unacknowledged outcome does. Surfaces the rotation recommendation and the NON-NEGOTIABLE rule (no consecutive same-lift focus) in his system prompt for ANY chat — default mode, plan_week mode, setup_block mode.

9. **Block outcomes feed Sunday plans.** Once a new block is committed, the previous block's outcome stays queryable so Sunday planning can reference it ("you're in block 2 of your post-deadlift cycle; bench focus continues 4 more weeks before squat focus").

10. **No AI in the data path.** Deterministic templating for lessons, deterministic algorithm for rotation, deterministic chart for trajectory. AI lives only in Carter's chat narration, where it READS the structured outcome and translates it into prose. Same separation as the morning brief's data-vs-advice split.

## Non-Goals

- **AI-narrated outcome narrative as a separate field.** The lessons jsonb is the structured artifact; Carter's chat narration handles prose. No Sonnet-call composer for the outcome itself.
- **Predictive end-of-block forecasting.** The evaluator only fires AFTER `end_date`. No "you'll likely hit 100 kg by block end" projection in the morning brief or mid-block.
- **Block early-close UI flow.** Athlete abandoning an off-pace block 2 weeks in is rare enough to not warrant a dedicated flow. Manual admin-tool deletion if needed.
- **Macrocycle review as a distinct chat card.** The trends-page surface IS the macrocycle review. Per-block outcome chat cards link to it via "View full block history →" deep-link.
- **Multi-priority lift support.** Single priority only. Two priorities create scheduling ambiguity. If you have two equally important lifts, the standard rotation gives them equal time.
- **Rotation customization beyond priority lift.** No "I want bench every 3 blocks instead of every 2" config. The injection pattern is one knob; the per-block override is the other. Enough.
- **Aggregating multiple users' block-outcome data.** Single-user app. No anonymized benchmarks, no comparisons.
- **Auto-creating the next block.** The cron writes the outcome + recommendation; the athlete still triggers `SETUP_BLOCK_PROMPT` and commits via the existing tool flow. No silent block creation.

## Architecture

### Data model

```sql
-- migration 0037_block_outcomes.sql

-- ── block_outcomes ──────────────────────────────────────────────────────────
create table public.block_outcomes (
  id uuid primary key default gen_random_uuid(),
  block_id uuid not null references training_blocks(id) on delete cascade,
  user_id uuid not null references auth.users on delete cascade,

  -- Frozen snapshot of what the block targeted
  primary_lift text not null check (primary_lift in ('squat','bench','deadlift','ohp')),
  target_value_kg numeric,
  target_metric text check (target_metric in ('e1rm','working_weight')),

  -- What actually happened
  end_working_kg numeric,                  -- highest clean (reps≥5, !warmup, !failure) working kg in the block window
  target_hit boolean not null,
  target_hit_at_week int,                  -- copied from training_blocks.target_hit_at_week at evaluation time
  block_phase_at_end text not null
    check (block_phase_at_end in ('hit_early','hit_on_pace','off_pace','underperformed')),

  -- Deterministic lessons
  lessons jsonb not null default '{}'::jsonb,

  -- Rotation recommendation for next block
  recommended_next_focus text
    check (recommended_next_focus in ('squat','bench','deadlift','ohp') or recommended_next_focus is null),
  recommended_target_value_kg numeric,

  -- Acknowledgment
  athlete_acknowledged_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (block_id)
);

create index if not exists block_outcomes_user_created_idx
  on public.block_outcomes (user_id, created_at desc);

alter table public.block_outcomes enable row level security;
create policy "block_outcomes self" on public.block_outcomes
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

comment on column public.block_outcomes.block_phase_at_end is
  'Four-way summary derived at evaluation time: hit_early (target reached before end_date — consolidation kicked in), hit_on_pace (target reached at or near end_date — clean execution), off_pace (end_working_kg < target × 0.90 — meaningful miss), underperformed (within 10% of target — narrow miss). Drives the lessons templating and the SETUP_BLOCK_PROMPT framing for the next block.';

comment on column public.block_outcomes.lessons is
  'Deterministically composed jsonb. Shape: { observed_step_kg_per_wk, projected_kg_at_end, gap_kg, gap_pct, calibration_note, secondary_lifts: [{lift, end_kg, clamp_held: boolean}], rotation_context: { ideal_next, athlete_overrode_rotation, ... } }. NO AI narrative — prose lives in Carter''s chat narration.';

-- ── chat_messages.kind allowlist widening ──────────────────────────────────
alter table chat_messages drop constraint chat_messages_kind_check;
alter table chat_messages add constraint chat_messages_kind_check
  check (kind in (
    'coach','morning_intake','morning_brief','weekly_review',
    'proactive_nudge','system_routing','meal_log','workout_debrief',
    'block_outcome'
  ));

-- ── profiles.rotation_priority_lift ────────────────────────────────────────
alter table public.profiles
  add column rotation_priority_lift text
  check (rotation_priority_lift in ('squat','bench','deadlift','ohp') or rotation_priority_lift is null);

comment on column public.profiles.rotation_priority_lift is
  'Optional persistent priority lift that biases the 4-lift rotation toward this lift. When NULL, standard D → B → S → OHP rotation. When set, injection pattern: every other rotation slot becomes the priority lift, with a non-priority lift between for recovery (e.g., priority=deadlift → D → B → D → S → D → OHP → D → ...). Captured at plan-builder intake and editable on /profile.';
```

That is the entire schema change. Trajectory analysis stays as derived data on top of `block_outcomes` rows.

### Evaluator module — `lib/coach/block-outcomes/`

Five pure-function modules + an orchestrator:

```
lib/coach/block-outcomes/
  ├── types.ts                  // BlockPhaseAtEnd, BlockOutcomePayload, RotationDecision
  ├── evaluator.ts              // evaluateBlockOutcome(block, workouts, todayIso) → core fact computation
  ├── rotation.ts               // recommendNextFocus(userBlocks, priorityLift, lastOutcome) → next focus + reasoning
  ├── recalibrate-target.ts     // recommendNextTargetKg(lift, outcomeHistory) → calibrated target
  ├── lessons.ts                // composeLessons(block, evaluatorOutput) → structured jsonb
  ├── trajectory.ts             // generateBlockTrajectory(userId, todayIso) → cross-block analysis
  └── index.ts                  // generateBlockOutcome(supabase, userId, blockId) → orchestrator
```

All six rule modules are pure functions with NO Supabase imports — the only Supabase consumer is `index.ts` (orchestrator) which loads data and threads it through.

#### `evaluator.ts`

```typescript
export function evaluateBlockOutcome(opts: {
  block: TrainingBlock;
  workouts: WorkoutSetSample[]; // clean working sets across the block window
  todayIso: string;
}): {
  end_working_kg: number | null;
  target_hit: boolean;
  block_phase_at_end: BlockPhaseAtEnd;
  observed_step_kg_per_wk: number | null;
  projected_kg_at_end: number | null;
  gap_kg: number | null;
  gap_pct: number | null;
};
```

Logic:
- `end_working_kg` = max clean kg in the block window (uses the same "clean set" filter from `maintenance-baseline.ts`: `reps ≥ 5 AND !warmup AND !failure`).
- `target_hit` = `end_working_kg >= target_value_kg`.
- `block_phase_at_end`:
  - `hit_early` if `target_hit && block.target_hit_at_week != null && block.target_hit_at_week < totalBlockWeeks`
  - `hit_on_pace` if `target_hit && block.target_hit_at_week is null OR target_hit_at_week == totalBlockWeeks`
  - `off_pace` if `!target_hit && end_working_kg < target × 0.90`
  - `underperformed` if `!target_hit && end_working_kg ≥ target × 0.90`
- `observed_step_kg_per_wk` = slope of (kg, weekN) across the block, computed via OLS over weekly max-clean-kg values.
- `projected_kg_at_end` = end_working_kg + observed_step × remaining_weeks (only non-null when block ended early).
- `gap_kg` = target_value_kg - end_working_kg.
- `gap_pct` = gap_kg / target_value_kg × 100.

#### `rotation.ts`

```typescript
const ROTATION_ORDER: PrimaryLift[] = ["deadlift", "bench", "squat", "ohp"];

export function recommendNextFocus(opts: {
  userBlocks: TrainingBlock[]; // all blocks for the user, newest-first
  priorityLift: PrimaryLift | null;
  lastOutcome: BlockOutcomePayload;
}): {
  recommended_lift: PrimaryLift;
  reasoning: "standard_rotation" | "priority_injection" | "off_pace_recovery_avoided" | "first_block";
  consecutive_focus_warning: boolean;
};
```

Logic:
- If `userBlocks.length === 0`: return `{ recommended_lift: "deadlift", reasoning: "first_block", ... }`.
- If `priorityLift == null`:
  - Find the index of `lastOutcome.primary_lift` in `ROTATION_ORDER`.
  - Recommended = `ROTATION_ORDER[(index + 1) % 4]`.
  - `consecutive_focus_warning` = false (rotation by design avoids consecutive same-lift focus).
  - `reasoning = "standard_rotation"`.
- If `priorityLift != null`:
  - If `lastOutcome.primary_lift === priorityLift`:
    - Recovery slot. Pick the next non-priority lift in `ROTATION_ORDER` (cycle from priority's index) that wasn't focused in the last 2 blocks.
    - `reasoning = "off_pace_recovery_avoided"` if `lastOutcome.block_phase_at_end === "off_pace"`, else `"priority_injection"`.
  - Else (last was non-priority):
    - Recommended = `priorityLift`.
    - `reasoning = "priority_injection"`.

The output always respects the no-consecutive-focus invariant. The `consecutive_focus_warning` flag is only set when the athlete EXPLICITLY overrides via SETUP_BLOCK_PROMPT.

#### `recalibrate-target.ts`

```typescript
export function recommendNextTargetKg(opts: {
  lift: PrimaryLift;
  outcomeHistory: BlockOutcomeRow[]; // all closed block_outcomes for this lift, newest-first
  fallbackWorkingKg: number | null;  // current working kg from recent workouts (used when no history)
}): number | null;
```

Logic:
- If `outcomeHistory` has entries for this lift: use the most recent. Target = `lastOutcome.end_working_kg + (lastOutcome.lessons.observed_step_kg_per_wk × 4)`.
- Else (lift has never been focused — Block 1 territory): use `fallbackWorkingKg + (2.5 × 4)` = `fallbackWorkingKg + 10`. Conservative; the first focus block always has imperfect calibration.
- Round to equipment grid (`step = 2.5` for barbell lifts) via the existing `resolveExercise` helper.

#### `lessons.ts`

Pure templating. Builds the structured `lessons` jsonb:

```typescript
type Lessons = {
  observed_step_kg_per_wk: number | null;
  projected_kg_at_end: number | null;
  gap_kg: number | null;
  gap_pct: number | null;
  calibration_note: string;        // e.g., "Target was set during layoff rebound — too aggressive for sustained progression."
  secondary_lifts: Array<{
    lift: PrimaryLift;
    end_kg: number | null;
    clamp_held: boolean;           // did baseKg stay ≤ 0.92 × maintenance for the block duration?
  }>;
  rotation_context: {
    ideal_next: PrimaryLift;
    athlete_overrode_rotation: boolean;
    override_reason: string | null;  // populated when athlete picks non-rotation lift in SETUP_BLOCK_PROMPT
  };
};
```

The `calibration_note` is generated by a small lookup table keyed by `(block_phase_at_end, target_metric, observed_step ratio)` — deterministic, ~12 cases, no AI.

#### `trajectory.ts`

```typescript
export async function generateBlockTrajectory(opts: {
  supabase: SupabaseClient;
  userId: string;
  todayIso: string;
}): Promise<BlockTrajectoryPayload>;

type BlockTrajectoryPayload = {
  per_lift: Array<{
    lift: PrimaryLift;
    blocks: Array<{
      block_id: string;
      window: { start_date: string; end_date: string };
      target_kg: number | null;
      end_working_kg: number | null;
      block_phase_at_end: BlockPhaseAtEnd;
      calibration_error_pct: number | null;  // (target - end) / target × 100
    }>;
    long_term_progression_kg_per_year: number | null;
    target_calibration_trend: "improving" | "stable" | "drifting";
    weeks_since_last_focus: number | null;
  }>;
  rotation_adherence: {
    ideal_sequence: PrimaryLift[];
    actual_sequence: PrimaryLift[];
    adherence_pct: number;
    deviations: Array<{ block_id: string; expected: PrimaryLift; actual: PrimaryLift; reason: "athlete_choice" | "priority_lift_injection" | "first_block" }>;
  };
  next_focus_due: PrimaryLift | null;
};
```

Reads `block_outcomes` table + falls back to the in-progress `training_blocks` row for the active block (so the trajectory is live even mid-block). `long_term_progression_kg_per_year` = OLS slope across `(end_date, end_working_kg)` per lift. `target_calibration_trend` = direction of `calibration_error_pct` over the last 3+ blocks per lift.

### Cron sweep — `app/api/coach/block-outcomes/sweep/route.ts`

```typescript
export async function GET(req: Request) {
  // CRON_SECRET-gated (matches existing cron pattern in /api/whoop/sync,
  // /api/coach/proactive/check, etc.)
  // 1. Find all training_blocks where end_date < today AND no matching block_outcomes row exists.
  // 2. For each, run generateBlockOutcome(supabase, userId, blockId).
  // 3. Insert block_outcomes row (unique-on-block_id covers concurrent fires).
  // 4. Insert chat_messages.kind='block_outcome' row with structured ui jsonb so the card surfaces.
  // 5. Continue on per-block failure; log + return totals.
}
```

`vercel.json` gets one new entry:

```json
{ "path": "/api/coach/block-outcomes/sweep", "schedule": "0 2 * * *" }
```

Daily at 02:00 UTC (mid-night Dubai, post-rollover for the user). Idempotent on `(block_id)` unique constraint. Failure on one block doesn't stop the sweep.

### SETUP_BLOCK_PROMPT update

Current beat structure stays (EXPLAIN / ELICIT / PROPOSE / COMMIT). Only ELICIT changes:

```
2. **ELICIT.** Before asking the user, check for an unacknowledged block_outcomes row
   (the most recent where athlete_acknowledged_at is null). If found, lead with the
   rotation recommendation.

   You will see (in your context block) the recent block_outcome with these fields:
     - primary_lift (just-finished lift)
     - block_phase_at_end (hit_early / hit_on_pace / off_pace / underperformed)
     - recommended_next_focus (computed from rotation engine)
     - recommended_target_value_kg (computed from real data)
     - profiles.rotation_priority_lift (if set, biases the rotation)

   Open with:
     "Your last block (<primary_lift>, <block_phase_at_end>) closed on <end_date>.
      The 4-lift rotation puts the next focus on <recommended_next_focus>
      (cycle: deadlift → bench → squat → OHP).
      My recommended target for <recommended_next_focus> is <recommended_target_value_kg> kg,
      derived from your last <recommended_next_focus> focus block's end working weight +
      4 weeks of normal +step.

      Want to go with that, or do you have a lift you want to prioritize?"

   On user override:
     - Athlete names a different lift in the next 2 in rotation → respect, log as
       athlete_choice, proceed to PROPOSE with the chosen lift.
     - Athlete names the same lift just finished → render DeadlineConfirmChip with
       the consecutive-focus warning. Hold until they confirm OR back off.
     - Athlete asks "why bench?" or similar → cite the rotation reasoning from
       lessons.rotation_context plus the recovery argument from the framework.
```

The block_outcome row gets `athlete_acknowledged_at` stamped when the SETUP_BLOCK_PROMPT flow reaches PROPOSE (so the card no longer surfaces as a "next step").

### Chat card surface — `components/chat/BlockOutcomeCard.tsx`

Rendered when a `chat_messages.kind='block_outcome'` row hits the chat thread. Structure (mockup in design discussion above; final markup matches existing card patterns):

- Header: "BLOCK COMPLETE" + block window + primary lift + block_phase_at_end (colored chip)
- Body: target vs reached, observed step rate vs required, calibration note
- Lessons: bullet list from `lessons` jsonb (calibration_note, secondary lifts status)
- **Macrocycle view block** (NEW from cross-block trajectory): per-lift one-line trajectory ("Deadlift: Block 1 → 100 off | trend tbd | next focus Block 5") + rotation adherence ratio + "next focus due" indicator
- Recommendation: next focus + calibrated target
- CTAs:
  - "Start <recommended_next_focus> block" → `/strength?tab=coach&mode=setup_block&prefill_focus=<lift>&prefill_target=<kg>`
  - "I have a different priority" → `/strength?tab=coach&mode=setup_block` (no prefill, drives ELICIT in normal mode)
  - "View full block history →" → `/coach/trends?section=performance#block-history`

`SETUP_BLOCK_PROMPT` route handler reads `prefill_focus` + `prefill_target` from the URL query (mirrors existing `mode=plan_week&week_start=...` URL convention) and surfaces them in the ELICIT beat.

### `/coach/trends` integration — `lib/coach/trends/compose-block-history.ts`

The existing `lib/coach/trends/` module has composers for strength / body / nutrition / recovery / cross. Add `compose-block-history.ts` as a new composer that wraps `generateBlockTrajectory`. The trends page renders it as a new card under Performance, below the existing per-lift e1RM trajectory.

Card surface (`components/coach/BlockHistoryCard.tsx`):
- Per-lift block sequence chart (timeline view, dots per block colored by `block_phase_at_end`)
- Rotation adherence ratio + deviations list ("Block 6 — chose deadlift over squat (athlete_choice)")
- Target calibration trend per lift (improving / stable / drifting)
- "Next focus due" indicator

Deep-linkable from the chat card via `#block-history` anchor.

### `framework-state.ts` extension

Current behavior: returns null when no active block. Extend:

```typescript
export async function buildFrameworkStateBlock(args: { supabase, userId }): Promise<string | null> {
  // … existing active-block path …

  // NEW: between-blocks path
  if (no active block) {
    // Look up the most recent unacknowledged block_outcomes row.
    const { data: outcomes } = await supabase
      .from("block_outcomes")
      .select("*")
      .eq("user_id", userId)
      .is("athlete_acknowledged_at", null)
      .order("created_at", { ascending: false })
      .limit(1);

    const outcome = outcomes?.[0];
    if (!outcome) return null;

    // Look up the priority lift.
    const { data: profile } = await supabase
      .from("profiles")
      .select("rotation_priority_lift")
      .eq("user_id", userId)
      .maybeSingle();

    // Render the between-blocks state.
    return renderBetweenBlocksState(outcome, profile?.rotation_priority_lift ?? null);
  }
  return null;
}
```

Between-blocks block carries the same NON-NEGOTIABLE-rule framing as the active-block phases (off_pace / consolidation / etc.). Sample output already shown in design discussion above.

### Persistent priority lift — UX and capture

**At intake** (plan-builder goal beat — `lib/coach/plan-builder/goal.ts` or wherever goal narrative is elicited):
- Carter asks: "Is there one lift you're prioritizing over the others — squat, bench, deadlift, or OHP? Or no specific priority?"
- If user names one, call a new tool `set_rotation_priority_lift({lift: "deadlift"})` that updates `profiles.rotation_priority_lift`.
- HMAC approval-token NOT required for this single setting (low risk; mirrors `set_directness` / `set_cadence` pattern from existing intake).

**On `/profile`** — add a dropdown in `components/profile/StrengthSection.tsx`:
- Label: "Priority lift (optional)"
- Options: None / Squat / Bench / Deadlift / OHP
- Default: None
- POST to `/api/profile/rotation-priority` with `{lift: "deadlift" | null}`.
- One-line description below the dropdown: "When set, this lift gets ~4 of every 8 block focuses instead of ~2 of 8. No two consecutive focuses on the same lift either way."

### Where the priority lift is read

| Reader | Path | Behavior when set |
|---|---|---|
| `rotation.ts` `recommendNextFocus` | block-end → `block_outcomes.recommended_next_focus` | Applies injection pattern; never two priority focuses in a row |
| `framework-state.ts` | Carter's chat system prompt | Surfaced as "Athlete priority lift: deadlift (rotation: D → B → D → S → D → OHP → ...)"; rule consequences in his prompt body |
| `SETUP_BLOCK_PROMPT` | ELICIT beat | Carter's recommendation aligns with priority-injected rotation; if athlete overrides, log as athlete_choice |
| `trajectory.ts` `ideal_sequence` | `/coach/trends` Block History | The ideal sequence shown reflects the priority-injected pattern, so adherence is measured against the right baseline |

## Edge cases

- **First-ever block.** No prior outcomes, no rotation history. `recommendNextFocus` returns deadlift (default starting point of `ROTATION_ORDER`). `recommendNextTargetKg` uses `fallbackWorkingKg + 10`. `lessons.rotation_context.ideal_next = "bench"`. No chat card surfaces because there's no `block_outcomes` row to surface yet.
- **Block ended with `target_hit_at_week` set (consolidation occurred).** `block_phase_at_end = "hit_early"`. `recommendNextFocus` proceeds normally (consolidation is success). Calibration note: "Target was conservative — block ended in consolidation at week N. Next <lift> block target raised more aggressively: <previous_target + (observed_step × 6)>." Yes, when the previous block hit early, the next-block target is recalibrated UP using a larger projection (the block had headroom).
- **Athlete explicitly overrode rotation last block.** `block_outcomes.lessons.rotation_context.athlete_overrode_rotation = true`. The NEXT rotation recommendation still computes from ideal sequence; the override doesn't cascade. Carter narrates: "Last block you chose squat over rotation's bench. The 4-lift cycle is still 4 lifts; bench is now overdue. I'd recommend bench."
- **Multiple active blocks.** Shouldn't happen (the unique `training_blocks_one_active_per_user` partial index from migration 0008 prevents it). Cron sweep handles whatever it finds; the active-block check assumes ≤1.
- **Block_outcomes row exists but chat_messages row failed.** The unique constraint on `block_outcomes(block_id)` makes the row authoritative. A separate idempotency check in the sweep (does a `chat_messages.ui->>'block_id'` row exist for this block?) handles the retry case.
- **Athlete deletes the chat_messages.block_outcome card.** The `block_outcomes` row stays. `athlete_acknowledged_at` is set when SETUP_BLOCK_PROMPT consumes the row, NOT when the card is dismissed. If they want to fully start over, they'd have to admin-delete the `block_outcomes` row.
- **Priority lift set mid-block.** Takes effect on the NEXT recommendation, not the current one. Active block continues unchanged.
- **Priority lift changed mid-rotation.** Same — affects the next recommendation. Existing block_outcomes don't get re-evaluated.
- **Rotation_priority_lift is set to the just-finished lift.** Recovery rule still applies. Recommendation will be the next non-priority lift; the priority-injection pattern resumes the block after.
- **Off-pace deadlift block when deadlift is the priority lift.** Recovery slot fires (no consecutive). Carter's narration in SETUP_BLOCK_PROMPT: "Your priority is deadlift, but we just closed an off-pace deadlift block. The framework needs a recovery block before deadlift comes back. Next focus is bench."
- **End_working_kg is null (no clean sets logged during the block).** Possible if athlete didn't log workouts. `block_phase_at_end = "underperformed"` (default), `target_hit = false`, `recommended_target_value_kg` uses `recommendNextTargetKg` with `outcomeHistory` lookup for the lift; if also empty, falls back to current SESSION_PLANS default `baseKg + 10`.
- **Two-priority desire.** Single-value column rejects ("constraint check failed"). The athlete is forced to choose one; if they want both, they alternate manually via per-block override.
- **Cron sweep runs while the athlete is mid-SETUP_BLOCK_PROMPT flow.** The unique constraint prevents duplicate insertion. SETUP_BLOCK_PROMPT reads the just-written row at next message exchange.

## Trade-offs explicitly considered and rejected

| Considered | Rejected because |
|---|---|
| **AI-narrated block outcome (Sonnet wrap)** | Adds latency, cost, fabrication risk for a single-row write that fires once per ~5 weeks. The lessons jsonb is deterministic and Carter's chat narrates from it. Matches the data-vs-prose discipline from the prescription system. |
| **Pre-end-of-block forecast** | Premature; the off-pace classification at week 3-4 would either match what `evaluateBlockPhase` already says (and is therefore redundant) or contradict it (creating two sources of truth). Wait for `end_date`. |
| **Block early-close UI** | Athlete-abandoned blocks are rare. Admin-tool deletion suffices. Adding flow surface costs more than it saves. |
| **Multi-priority lift support** | Two priorities create scheduling ambiguity that has no clean answer. Force single-priority; equal-priority pairs use standard rotation. |
| **Custom rotation cadence beyond priority injection** | "Bench every 3 blocks" → too many config knobs, too many edge cases. The two existing knobs (priority lift + per-block override) cover real-world needs. |
| **Macrocycle review as a separate chat card** | Duplicates the per-block-outcome card's data and the trends-page surface's data. Three places to maintain, one source of truth desired. |
| **Block_outcomes as immutable** (no edits ever) | An athlete legitimately overriding rotation should be logged. `lessons.rotation_context.athlete_overrode_rotation` mutates AFTER the row is written (when SETUP_BLOCK_PROMPT processes the override). Mutation is bounded to `athlete_acknowledged_at` + `lessons.rotation_context` fields. |
| **Auto-creating next block when current closes** | Removes the athlete's check-in moment. Programming should be a deliberate decision, not a silent transition. The chat card + SETUP_BLOCK_PROMPT flow IS the check-in. |
| **Tracking which workouts contributed to each lift's end_working_kg** | Audit trail nice-to-have; not load-bearing. The workouts are queryable directly via `workouts` table on `(user_id, date BETWEEN start_date AND end_date)`. |

## References

- Spec [2026-05-28 Sunday Prescription System](2026-05-28-sunday-prescription-system-design.md) — within-block discipline (this spec is between-block discipline)
- Spec [2026-05-15 Weekly Review Document](2026-05-15-weekly-review-document-design.md) — versioned recap pattern that `block_outcomes` mirrors
- Spec [2026-05-24 Peter Dashboard](2026-05-24-peter-dashboard-design.md) — same hybrid pattern (deterministic data + chat narration, no AI-generated facts)
- Independent expert coaching review (during brainstorm 2026-05-29): 4-lift rotation is the consensus for hypertrophy + general strength intermediates; 2-lift alternation is powerlifting-specific; D → B → S → OHP order optimizes systemic recovery alternation
- Renaissance Periodization volume landmark theory (Israetel) — rotate focus, address volume debt
- Helms hierarchical periodization — prioritize weakness, balance via rotation
- Issurin block periodization — sequential focus, recovery-window advantage on the just-focused lift in the following block
- Schoenfeld 2016/2019 frequency meta-analyses — 2× weekly maintenance volume preserves strength on non-focus lifts during focus blocks
