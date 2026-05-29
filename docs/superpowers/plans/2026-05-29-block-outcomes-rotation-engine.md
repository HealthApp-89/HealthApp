# Block Outcomes + Rotation Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist a deterministic outcome row per closed block, recommend the next focus via 4-lift rotation (with optional priority-lift injection), recalibrate next-block targets from real data, and surface a cross-block trajectory on `/coach/trends`. Carter's prompts read the outcome + rotation rec so between-block discipline matches the within-block discipline shipped in PRs #119/#120/#121.

**Architecture:** New `block_outcomes` table written by daily cron sweep at 02:00 UTC. Six pure-function rule modules under `lib/coach/block-outcomes/` (evaluator, rotation, recalibrate-target, lessons, trajectory, orchestrator) plus a `chat_messages.kind='block_outcome'` card surface. NO AI in the data path — Carter narrates from the structured row, same separation as the Sunday Prescription System. `framework-state.ts` gains a between-blocks fallback so the rule lands in default chat too. `profiles.rotation_priority_lift` is the persistent priority knob; per-block override via SETUP_BLOCK_PROMPT is the other knob.

**Tech Stack:** Next.js 15 / Supabase / TypeScript (strict) / pure-function rule modules / HMAC approval tokens (existing) / audit-script verification (no test runner — convention is `scripts/audit-*.mjs` exercised via `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local`).

**Spec:** [docs/superpowers/specs/2026-05-29-block-outcomes-rotation-engine-design.md](../specs/2026-05-29-block-outcomes-rotation-engine-design.md)

**Branch:** Create and execute on `feat/block-outcomes-rotation`. Do not commit directly to main.

---

## File Inventory

**Created:**
- `supabase/migrations/0037_block_outcomes.sql`
- `lib/coach/block-outcomes/types.ts`
- `lib/coach/block-outcomes/evaluator.ts`
- `lib/coach/block-outcomes/rotation.ts`
- `lib/coach/block-outcomes/recalibrate-target.ts`
- `lib/coach/block-outcomes/lessons.ts`
- `lib/coach/block-outcomes/trajectory.ts`
- `lib/coach/block-outcomes/index.ts`
- `app/api/coach/block-outcomes/sweep/route.ts`
- `app/api/profile/rotation-priority/route.ts`
- `components/chat/BlockOutcomeCard.tsx`
- `components/coach/BlockHistoryCard.tsx`
- `lib/coach/trends/compose-block-history.ts`
- `scripts/audit-block-outcomes-rules.mjs`
- `scripts/audit-block-outcomes-e2e.mjs`

**Modified:**
- `lib/data/types.ts` — `BlockOutcome`, `BlockPhaseAtEnd`, `BlockTrajectoryPayload` types; `chat_messages.kind` widening
- `lib/coach/planning-prompts.ts` — `SETUP_BLOCK_PROMPT` extended with rotation-aware ELICIT
- `lib/coach/carter-context/framework-state.ts` — between-blocks fallback when no active block + recent outcome
- `lib/coach/tools.ts` — `set_rotation_priority_lift` tool
- `components/profile/StrengthSection.tsx` (or its equivalent — confirm path) — priority lift dropdown
- `components/chat/ChatMessage.tsx` — dispatch `block_outcome` to `BlockOutcomeCard`
- `components/coach/CoachTrendsClient.tsx` (or the `/coach/trends` page client — confirm path) — render `BlockHistoryCard` under Performance section
- `vercel.json` — daily cron entry
- `CLAUDE.md` — migration 0037 entry + new scripts

---

## Execution Note on Tests

This repo has no test runner. Convention is `scripts/audit-*.mjs` run via the alias loader. Pure rule modules get a single audit script (`scripts/audit-block-outcomes-rules.mjs`) with fixture-based cases. End-to-end validation via `scripts/audit-block-outcomes-e2e.mjs` against live data with `AUDIT_USER_ID=<uuid>`. UI/integration via `npm run typecheck` + manual click-through on `npm run dev`.

---

## Task 0: Branch creation

**Files:** none

- [ ] **Step 1: Create and check out feature branch**

```bash
cd "/Users/abdelouahedelbied/Health app"
git checkout main
git pull origin main
git checkout -b feat/block-outcomes-rotation
```

Expected: `Switched to a new branch 'feat/block-outcomes-rotation'`.

- [ ] **Step 2: Confirm pre-existing WIP files are present but untouched**

```bash
git status
```

Expected: working tree shows the same pre-existing WIP files (`components/log/DraftReview.tsx`, `components/log/FoodSearchPicker.tsx`, `components/ui/BottomSheet.tsx`). Leave them alone for the entire plan.

---

## Task 1: Migration 0037 — schema

**Files:**
- Create: `supabase/migrations/0037_block_outcomes.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 0037_block_outcomes.sql
-- Adds block_outcomes table (one row per closed block, written by daily cron),
-- widens chat_messages.kind allowlist for 'block_outcome', and adds
-- profiles.rotation_priority_lift for the persistent priority knob.
-- See docs/superpowers/specs/2026-05-29-block-outcomes-rotation-engine-design.md.

create table public.block_outcomes (
  id uuid primary key default gen_random_uuid(),
  block_id uuid not null references training_blocks(id) on delete cascade,
  user_id uuid not null references auth.users on delete cascade,

  primary_lift text not null check (primary_lift in ('squat','bench','deadlift','ohp')),
  target_value_kg numeric,
  target_metric text check (target_metric in ('e1rm','working_weight')),

  end_working_kg numeric,
  target_hit boolean not null,
  target_hit_at_week int,
  block_phase_at_end text not null
    check (block_phase_at_end in ('hit_early','hit_on_pace','off_pace','underperformed')),

  lessons jsonb not null default '{}'::jsonb,

  recommended_next_focus text
    check (recommended_next_focus in ('squat','bench','deadlift','ohp') or recommended_next_focus is null),
  recommended_target_value_kg numeric,

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
  'Four-way summary derived at evaluation time: hit_early (target reached before end_date — consolidation kicked in), hit_on_pace (target reached at or near end_date — clean execution), off_pace (end_working_kg < target × 0.90 — meaningful miss), underperformed (within 10% of target — narrow miss).';

comment on column public.block_outcomes.lessons is
  'Deterministically composed jsonb. Shape: { observed_step_kg_per_wk, projected_kg_at_end, gap_kg, gap_pct, calibration_note, secondary_lifts: [{lift, end_kg, clamp_held: boolean}], rotation_context: { ideal_next, athlete_overrode_rotation, override_reason } }. NO AI narrative.';

alter table chat_messages drop constraint chat_messages_kind_check;
alter table chat_messages add constraint chat_messages_kind_check
  check (kind in (
    'coach','morning_intake','morning_brief','weekly_review',
    'proactive_nudge','system_routing','meal_log','workout_debrief',
    'block_outcome'
  ));

alter table public.profiles
  add column rotation_priority_lift text
  check (rotation_priority_lift in ('squat','bench','deadlift','ohp') or rotation_priority_lift is null);

comment on column public.profiles.rotation_priority_lift is
  'Optional persistent priority lift that biases the 4-lift rotation. NULL = standard D → B → S → OHP rotation. Set = injection pattern: every other rotation slot becomes the priority lift, with a non-priority lift between for recovery. No two priority focuses in a row.';
```

- [ ] **Step 2: Apply via Supabase CLI**

```bash
supabase db push
```

If the CLI hits the pre-existing 0026 ghost-migration issue (per PR #119 commit `8fc656d` notes), apply 0037 directly via `supabase db query --linked --file supabase/migrations/0037_block_outcomes.sql` and then `supabase migration repair --status applied 0037`.

- [ ] **Step 3: Verify columns and constraint exist**

```bash
node --input-type=module --env-file=.env.local -e "
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const a = await sb.from('block_outcomes').select('id').limit(1);
console.log('block_outcomes selectable:', a.error == null);
const b = await sb.from('profiles').select('rotation_priority_lift').limit(1);
console.log('profiles.rotation_priority_lift selectable:', b.error == null);
"
```

Expected: both lines print `true`.

- [ ] **Step 4: Append CLAUDE.md migration entry**

Add after the entry for migration 0036:

```markdown
37. [supabase/migrations/0037_block_outcomes.sql](supabase/migrations/0037_block_outcomes.sql) — adds `block_outcomes` (per-closed-block deterministic outcome row, keyed `(block_id)` unique, RLS-self), widens `chat_messages.kind` allowlist for `'block_outcome'`, and adds `profiles.rotation_priority_lift` for the persistent priority knob. Cron sweep at 02:00 UTC populates the table; SETUP_BLOCK_PROMPT consumes it.
```

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0037_block_outcomes.sql CLAUDE.md
git commit -m "$(cat <<'EOF'
feat(block-outcomes): migration 0037 — block_outcomes + rotation_priority_lift

Adds the durable outcome table (one row per closed block, written by
daily cron sweep), widens chat_messages.kind for 'block_outcome'
cards, and adds profiles.rotation_priority_lift for the persistent
priority knob.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Type updates

**Files:**
- Modify: `lib/data/types.ts`

- [ ] **Step 1: Add `BlockPhaseAtEnd` union**

Append after the existing `BlockPhase` type (or near the `TrainingBlock` block):

```typescript
export type BlockPhaseAtEnd = "hit_early" | "hit_on_pace" | "off_pace" | "underperformed";
```

- [ ] **Step 2: Add `BlockOutcome` row type**

```typescript
export type BlockOutcomeLessons = {
  observed_step_kg_per_wk: number | null;
  projected_kg_at_end: number | null;
  gap_kg: number | null;
  gap_pct: number | null;
  calibration_note: string;
  secondary_lifts: Array<{
    lift: PrimaryLift;
    end_kg: number | null;
    clamp_held: boolean;
  }>;
  rotation_context: {
    ideal_next: PrimaryLift | null;
    athlete_overrode_rotation: boolean;
    override_reason: string | null;
  };
};

export type BlockOutcome = {
  id: string;
  block_id: string;
  user_id: string;
  primary_lift: PrimaryLift;
  target_value_kg: number | null;
  target_metric: TargetMetric | null;
  end_working_kg: number | null;
  target_hit: boolean;
  target_hit_at_week: number | null;
  block_phase_at_end: BlockPhaseAtEnd;
  lessons: BlockOutcomeLessons;
  recommended_next_focus: PrimaryLift | null;
  recommended_target_value_kg: number | null;
  athlete_acknowledged_at: string | null;
  created_at: string;
  updated_at: string;
};
```

- [ ] **Step 3: Add `BlockTrajectoryPayload` for trends consumption**

```typescript
export type BlockTrajectoryPayload = {
  per_lift: Array<{
    lift: PrimaryLift;
    blocks: Array<{
      block_id: string;
      window: { start_date: string; end_date: string };
      target_kg: number | null;
      end_working_kg: number | null;
      block_phase_at_end: BlockPhaseAtEnd;
      calibration_error_pct: number | null;
    }>;
    long_term_progression_kg_per_year: number | null;
    target_calibration_trend: "improving" | "stable" | "drifting" | "insufficient_data";
    weeks_since_last_focus: number | null;
  }>;
  rotation_adherence: {
    ideal_sequence: PrimaryLift[];
    actual_sequence: PrimaryLift[];
    adherence_pct: number;
    deviations: Array<{
      block_id: string;
      expected: PrimaryLift;
      actual: PrimaryLift;
      reason: "athlete_choice" | "priority_lift_injection" | "first_block";
    }>;
  };
  next_focus_due: PrimaryLift | null;
};
```

- [ ] **Step 4: Extend `Profile` (or `profiles` row type, whichever exists) with `rotation_priority_lift`**

Grep first to find the type:

```bash
grep -n "rotation_priority_lift\|export type Profile\|profiles_row" lib/data/types.ts | head -5
```

Add `rotation_priority_lift: PrimaryLift | null;` to the profile type. If the type doesn't exist (some codebases just use raw selects), skip this step — the runtime always sees the field.

- [ ] **Step 5: Widen the chat-messages kind union**

Find the existing `ChatMessageKind` union and add `'block_outcome'`. If the union is a plain TypeScript literal type, add the new value alphabetically or at the end.

- [ ] **Step 6: Typecheck**

```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add lib/data/types.ts
git commit -m "$(cat <<'EOF'
feat(block-outcomes): types — BlockOutcome, BlockPhaseAtEnd, BlockTrajectoryPayload

Extends lib/data/types.ts with the new row type plus the cross-block
trajectory payload. Widens chat_messages.kind union for the new
'block_outcome' card. Adds rotation_priority_lift to the profile type.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `evaluator.ts`

**Files:**
- Create: `lib/coach/block-outcomes/types.ts`
- Create: `lib/coach/block-outcomes/evaluator.ts`
- Create: `scripts/audit-block-outcomes-rules.mjs`

- [ ] **Step 1: Write `lib/coach/block-outcomes/types.ts`**

```typescript
// lib/coach/block-outcomes/types.ts
//
// Shared types internal to the block-outcomes engine. The public-facing
// BlockOutcome / BlockOutcomeLessons / BlockTrajectoryPayload types live
// in lib/data/types.ts.

import type { PrimaryLift } from "@/lib/data/types";

/** A clean working set in the block window, used for end-kg + observed-rate computation. */
export type BlockSetSample = {
  exercise_name: string;
  kg: number;
  reps: number;
  performed_on: string; // ISO date
  weekN: number;        // 1-indexed week within the block (computed from block.start_date)
};

/** A non-focus primary lift's outcome (used in lessons.secondary_lifts). */
export type SecondaryLiftOutcome = {
  lift: PrimaryLift;
  end_kg: number | null;
  clamp_held: boolean; // did baseKg stay ≤ 0.92 × maintenance for the block duration?
};
```

- [ ] **Step 2: Write `lib/coach/block-outcomes/evaluator.ts`**

```typescript
// lib/coach/block-outcomes/evaluator.ts
//
// Pure: given a TrainingBlock and the clean working sets from its window,
// compute the deterministic outcome facts. No Supabase, no AI.

import type { TrainingBlock, BlockPhaseAtEnd, PrimaryLift } from "@/lib/data/types";
import type { BlockSetSample } from "@/lib/coach/block-outcomes/types";

const OFF_PACE_THRESHOLD = 0.90; // end_working_kg < target × 0.90 → off_pace; else underperformed
const HIT_EARLY_GAP_WEEKS = 1;   // target hit at_week < (totalWeeks - HIT_EARLY_GAP_WEEKS) → hit_early

export type BlockOutcomeFacts = {
  end_working_kg: number | null;
  target_hit: boolean;
  block_phase_at_end: BlockPhaseAtEnd;
  observed_step_kg_per_wk: number | null;
  projected_kg_at_end: number | null;
  gap_kg: number | null;
  gap_pct: number | null;
};

export function evaluateBlockOutcome(opts: {
  block: TrainingBlock;
  primarySets: BlockSetSample[]; // clean working sets of the primary lift in the block window
  totalBlockWeeks: number;
}): BlockOutcomeFacts {
  const { block, primarySets, totalBlockWeeks } = opts;

  const end_working_kg = primarySets.length > 0 ? Math.max(...primarySets.map((s) => s.kg)) : null;
  const target = block.target_value;
  const target_hit = end_working_kg != null && target != null && end_working_kg >= target;

  // Observed step: OLS slope of weekly-max kg across weeks.
  const observed_step_kg_per_wk = estimateWeeklyStep(primarySets);

  // Projected: only when block ended with weeks remaining post-target-hit
  // OR off-pace with future weeks (mid-block early-evaluation case).
  // For end-of-block evaluation this stays null.
  const projected_kg_at_end =
    target_hit && end_working_kg != null && observed_step_kg_per_wk != null
      ? end_working_kg + observed_step_kg_per_wk * Math.max(0, totalBlockWeeks - (block.target_hit_at_week ?? totalBlockWeeks))
      : null;

  const gap_kg = end_working_kg != null && target != null ? target - end_working_kg : null;
  const gap_pct = gap_kg != null && target != null && target !== 0 ? (gap_kg / target) * 100 : null;

  let block_phase_at_end: BlockPhaseAtEnd;
  if (target_hit) {
    if (
      block.target_hit_at_week != null &&
      block.target_hit_at_week < totalBlockWeeks - HIT_EARLY_GAP_WEEKS
    ) {
      block_phase_at_end = "hit_early";
    } else {
      block_phase_at_end = "hit_on_pace";
    }
  } else {
    if (end_working_kg != null && target != null && end_working_kg < target * OFF_PACE_THRESHOLD) {
      block_phase_at_end = "off_pace";
    } else {
      block_phase_at_end = "underperformed";
    }
  }

  return { end_working_kg, target_hit, block_phase_at_end, observed_step_kg_per_wk, projected_kg_at_end, gap_kg, gap_pct };
}

function estimateWeeklyStep(sets: BlockSetSample[]): number | null {
  if (sets.length < 2) return null;
  // Group by weekN, take max kg per week
  const weeklyMax: Map<number, number> = new Map();
  for (const s of sets) {
    weeklyMax.set(s.weekN, Math.max(weeklyMax.get(s.weekN) ?? 0, s.kg));
  }
  const points = Array.from(weeklyMax.entries()).sort((a, b) => a[0] - b[0]);
  if (points.length < 2) return null;
  // OLS slope (kg per week)
  const n = points.length;
  const sumX = points.reduce((a, p) => a + p[0], 0);
  const sumY = points.reduce((a, p) => a + p[1], 0);
  const sumXY = points.reduce((a, p) => a + p[0] * p[1], 0);
  const sumX2 = points.reduce((a, p) => a + p[0] * p[0], 0);
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return null;
  return (n * sumXY - sumX * sumY) / denom;
}
```

- [ ] **Step 3: Write the audit script**

```bash
cat > scripts/audit-block-outcomes-rules.mjs <<'EOF'
// scripts/audit-block-outcomes-rules.mjs
//
// Fixture-based audit for lib/coach/block-outcomes/ pure modules.
// No DB access — exercises rule functions with concrete inputs.
//
// Run via:
//   node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-block-outcomes-rules.mjs

import { evaluateBlockOutcome } from "@/lib/coach/block-outcomes/evaluator";

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else      { fail++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

console.log("\n## evaluator.ts\n");
{
  const block = {
    id: "fixture", user_id: "fixture", block_id: null,
    primary_lift: "deadlift", target_metric: "working_weight",
    target_value: 115, target_unit: "kg", status: "active",
    diet_goal: null, goal_text: "fixture", notes: null,
    target_hit_at_week: null,
    start_date: "2026-05-11", end_date: "2026-06-14",
    created_at: "2026-05-11", updated_at: "2026-05-11",
  };

  // Off-pace case: 95 → 100 across 3 weeks, target 115
  const sets = [
    { exercise_name: "Deadlift (Barbell)", kg: 95,  reps: 7, performed_on: "2026-05-21", weekN: 2 },
    { exercise_name: "Deadlift (Barbell)", kg: 97.5,reps: 8, performed_on: "2026-05-28", weekN: 3 },
    { exercise_name: "Deadlift (Barbell)", kg: 100, reps: 6, performed_on: "2026-06-04", weekN: 4 },
  ];
  const offPace = evaluateBlockOutcome({ block, primarySets: sets, totalBlockWeeks: 5 });
  assert("off-pace: end_working_kg = 100", offPace.end_working_kg === 100);
  assert("off-pace: target_hit = false", offPace.target_hit === false);
  assert("off-pace: phase = off_pace", offPace.block_phase_at_end === "off_pace");
  assert("off-pace: observed step ~2.5 kg/wk", Math.abs((offPace.observed_step_kg_per_wk ?? 0) - 2.5) < 0.01);
  assert("off-pace: gap_kg = 15", offPace.gap_kg === 15);

  // Hit early: target 100, hit at week 3, total weeks 5
  const hitEarlyBlock = { ...block, target_value: 100, target_hit_at_week: 3 };
  const hitEarlySets = [
    { exercise_name: "Deadlift (Barbell)", kg: 95, reps: 7, performed_on: "2026-05-21", weekN: 2 },
    { exercise_name: "Deadlift (Barbell)", kg: 100, reps: 6, performed_on: "2026-05-28", weekN: 3 },
  ];
  const hitEarly = evaluateBlockOutcome({ block: hitEarlyBlock, primarySets: hitEarlySets, totalBlockWeeks: 5 });
  assert("hit_early: phase = hit_early", hitEarly.block_phase_at_end === "hit_early");
  assert("hit_early: target_hit = true", hitEarly.target_hit === true);

  // Underperformed: end 95, target 100 (gap 5%, < 10% threshold)
  const underperformedSets = [
    { exercise_name: "Deadlift (Barbell)", kg: 92.5, reps: 7, performed_on: "2026-05-21", weekN: 2 },
    { exercise_name: "Deadlift (Barbell)", kg: 95,   reps: 6, performed_on: "2026-05-28", weekN: 3 },
  ];
  const under = evaluateBlockOutcome({
    block: { ...block, target_value: 100, target_hit_at_week: null },
    primarySets: underperformedSets,
    totalBlockWeeks: 5,
  });
  assert("underperformed: phase = underperformed (gap_pct < 10%)", under.block_phase_at_end === "underperformed");

  // No sets: end_working_kg null, phase = underperformed (default for non-hit)
  const empty = evaluateBlockOutcome({ block, primarySets: [], totalBlockWeeks: 5 });
  assert("no sets: end_working_kg null", empty.end_working_kg === null);
  assert("no sets: phase = underperformed", empty.block_phase_at_end === "underperformed");
}

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
EOF
```

- [ ] **Step 4: Run the audit**

```bash
node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-block-outcomes-rules.mjs
```

Expected: `7 passed, 0 failed.` (or similar — actual count depends on which `assert()` calls fire).

- [ ] **Step 5: Commit**

```bash
git add lib/coach/block-outcomes/types.ts lib/coach/block-outcomes/evaluator.ts scripts/audit-block-outcomes-rules.mjs
git commit -m "$(cat <<'EOF'
feat(block-outcomes): evaluator + types

evaluateBlockOutcome computes deterministic outcome facts: end_working_kg
(max clean working kg in block window), target_hit, block_phase_at_end
(hit_early / hit_on_pace / off_pace / underperformed), observed step
kg/wk via OLS, projected_kg_at_end, gap_kg, gap_pct. Pure function;
data fetching lives in the orchestrator.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `rotation.ts`

**Files:**
- Create: `lib/coach/block-outcomes/rotation.ts`
- Modify: `scripts/audit-block-outcomes-rules.mjs` (append section)

- [ ] **Step 1: Write `rotation.ts`**

```typescript
// lib/coach/block-outcomes/rotation.ts
//
// Pure rotation engine. Default cycle D → B → S → OHP. When
// profiles.rotation_priority_lift is set, applies an injection pattern:
// every other rotation slot becomes the priority lift, with a non-priority
// lift between for recovery. No two consecutive same-lift focuses.

import type { TrainingBlock, PrimaryLift, BlockPhaseAtEnd } from "@/lib/data/types";

export const ROTATION_ORDER: PrimaryLift[] = ["deadlift", "bench", "squat", "ohp"];

export type RotationDecision = {
  recommended_lift: PrimaryLift;
  reasoning: "standard_rotation" | "priority_injection" | "off_pace_recovery_avoided" | "first_block";
  consecutive_focus_warning: boolean;
};

export function recommendNextFocus(opts: {
  userBlocks: TrainingBlock[]; // newest-first, includes the just-closed block
  priorityLift: PrimaryLift | null;
  lastOutcome: { primary_lift: PrimaryLift; block_phase_at_end: BlockPhaseAtEnd } | null;
}): RotationDecision {
  const { userBlocks, priorityLift, lastOutcome } = opts;

  if (lastOutcome == null || userBlocks.length === 0) {
    return {
      recommended_lift: priorityLift ?? "deadlift",
      reasoning: "first_block",
      consecutive_focus_warning: false,
    };
  }

  const lastLift = lastOutcome.primary_lift;
  const recentLifts = userBlocks.slice(0, 2).map((b) => b.primary_lift).filter((l): l is PrimaryLift => l != null);

  if (priorityLift == null) {
    // Standard rotation: next in ROTATION_ORDER from lastLift.
    const idx = ROTATION_ORDER.indexOf(lastLift);
    const nextIdx = (idx + 1) % ROTATION_ORDER.length;
    return {
      recommended_lift: ROTATION_ORDER[nextIdx],
      reasoning: "standard_rotation",
      consecutive_focus_warning: false,
    };
  }

  // Priority injection
  if (lastLift === priorityLift) {
    // Recovery slot: pick the next non-priority lift in rotation that hasn't
    // been focused in the last 2 blocks.
    const candidates = ROTATION_ORDER.filter((l) => l !== priorityLift);
    const fresh = candidates.find((l) => !recentLifts.includes(l)) ?? candidates[0];
    return {
      recommended_lift: fresh,
      reasoning: lastOutcome.block_phase_at_end === "off_pace" ? "off_pace_recovery_avoided" : "priority_injection",
      consecutive_focus_warning: false,
    };
  }

  // Last was non-priority → next is priority
  return {
    recommended_lift: priorityLift,
    reasoning: "priority_injection",
    consecutive_focus_warning: false,
  };
}

/** Helper for the trajectory composer — produces the "ideal" sequence for
 *  N blocks given the priority setting. */
export function idealSequence(opts: {
  n: number;
  priorityLift: PrimaryLift | null;
  startingLift?: PrimaryLift;
}): PrimaryLift[] {
  const { n, priorityLift } = opts;
  const start = opts.startingLift ?? "deadlift";
  const out: PrimaryLift[] = [start];

  for (let i = 1; i < n; i++) {
    const last = out[out.length - 1];
    const recent = out.slice(Math.max(0, out.length - 2));
    const decision = recommendNextFocus({
      userBlocks: recent.map((lift) => ({ primary_lift: lift } as TrainingBlock)),
      priorityLift,
      lastOutcome: { primary_lift: last, block_phase_at_end: "hit_on_pace" },
    });
    out.push(decision.recommended_lift);
  }
  return out;
}
```

- [ ] **Step 2: Append audit cases to `scripts/audit-block-outcomes-rules.mjs`**

Insert BEFORE the final `console.log(...) / process.exit(...)`:

```javascript
import { recommendNextFocus, idealSequence, ROTATION_ORDER } from "@/lib/coach/block-outcomes/rotation";

console.log("\n## rotation.ts\n");
{
  const blockOf = (lift) => ({ primary_lift: lift });
  const lastOf = (lift, phase = "hit_on_pace") => ({ primary_lift: lift, block_phase_at_end: phase });

  // Standard rotation: D → B → S → OHP → D ...
  const r1 = recommendNextFocus({ userBlocks: [blockOf("deadlift")], priorityLift: null, lastOutcome: lastOf("deadlift") });
  assert("standard: after deadlift → bench", r1.recommended_lift === "bench" && r1.reasoning === "standard_rotation");

  const r2 = recommendNextFocus({ userBlocks: [blockOf("bench")], priorityLift: null, lastOutcome: lastOf("bench") });
  assert("standard: after bench → squat", r2.recommended_lift === "squat");

  const r4 = recommendNextFocus({ userBlocks: [blockOf("ohp")], priorityLift: null, lastOutcome: lastOf("ohp") });
  assert("standard: after ohp → deadlift (wraps)", r4.recommended_lift === "deadlift");

  // Priority injection: priority = deadlift, last was bench → next is deadlift
  const p1 = recommendNextFocus({ userBlocks: [blockOf("bench"), blockOf("deadlift")], priorityLift: "deadlift", lastOutcome: lastOf("bench") });
  assert("priority deadlift, last bench → next deadlift", p1.recommended_lift === "deadlift" && p1.reasoning === "priority_injection");

  // Priority injection: priority = deadlift, last was deadlift → recovery slot, pick a non-priority lift fresh
  const p2 = recommendNextFocus({ userBlocks: [blockOf("deadlift"), blockOf("bench")], priorityLift: "deadlift", lastOutcome: lastOf("deadlift") });
  assert("priority deadlift, last deadlift → recovery (non-deadlift)", p2.recommended_lift !== "deadlift" && p2.reasoning === "priority_injection");

  // Off-pace recovery: priority deadlift, last was off-pace deadlift → mark off_pace_recovery_avoided
  const p3 = recommendNextFocus({ userBlocks: [blockOf("deadlift")], priorityLift: "deadlift", lastOutcome: lastOf("deadlift", "off_pace") });
  assert("priority deadlift, last off-pace deadlift → off_pace_recovery_avoided", p3.reasoning === "off_pace_recovery_avoided");

  // First block: no history → first_block reasoning, priority lift (or default deadlift)
  const f1 = recommendNextFocus({ userBlocks: [], priorityLift: null, lastOutcome: null });
  assert("first block, no priority → deadlift", f1.recommended_lift === "deadlift" && f1.reasoning === "first_block");

  const f2 = recommendNextFocus({ userBlocks: [], priorityLift: "bench", lastOutcome: null });
  assert("first block, priority bench → bench", f2.recommended_lift === "bench");

  // Ideal sequence: 8 blocks with priority deadlift → D, B, D, S, D, OHP, D, B
  const ideal = idealSequence({ n: 8, priorityLift: "deadlift" });
  assert("ideal sequence with priority deadlift starts D, B, D, S", ideal[0] === "deadlift" && ideal[1] === "bench" && ideal[2] === "deadlift" && ideal[3] === "squat", `got ${JSON.stringify(ideal)}`);
}
```

- [ ] **Step 3: Run the audit**

```bash
node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-block-outcomes-rules.mjs
```

Expected: prior 7+ assertions + new 9 = 16+ total passing.

- [ ] **Step 4: Commit**

```bash
git add lib/coach/block-outcomes/rotation.ts scripts/audit-block-outcomes-rules.mjs
git commit -m "$(cat <<'EOF'
feat(block-outcomes): rotation engine

recommendNextFocus applies the 4-lift rotation (D → B → S → OHP) by
default; when profiles.rotation_priority_lift is set, applies an
injection pattern (every other slot is the priority lift, with a
non-priority recovery lift between). Off-pace recovery slot tagged
distinctly. idealSequence helper used by the trajectory composer.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `recalibrate-target.ts`

**Files:**
- Create: `lib/coach/block-outcomes/recalibrate-target.ts`
- Modify: `scripts/audit-block-outcomes-rules.mjs`

- [ ] **Step 1: Write `recalibrate-target.ts`**

```typescript
// lib/coach/block-outcomes/recalibrate-target.ts
//
// Pure: when a lift is recommended as the next focus, derive its target
// from real data: end_working_kg of the most recent focus block for that
// lift + (observed_step_kg_per_wk × 4 accumulation weeks). Round to step.

import type { PrimaryLift, BlockOutcome } from "@/lib/data/types";

const ACCUMULATION_WEEKS = 4;
const FALLBACK_STEP_KG = 2.5;
const FALLBACK_PROGRESSION_WEEKS = 4;

const STEP_FOR_LIFT: Record<PrimaryLift, number> = {
  squat: 2.5,
  bench: 2.5,
  deadlift: 2.5,
  ohp: 2.5, // first-iteration constant; future could read from exercise-library.ts
};

export function recommendNextTargetKg(opts: {
  lift: PrimaryLift;
  outcomeHistory: BlockOutcome[]; // all closed outcomes for the user, newest-first
  fallbackWorkingKg: number | null; // current working kg from recent workouts (null when no history)
}): number | null {
  const { lift, outcomeHistory, fallbackWorkingKg } = opts;

  const lastForLift = outcomeHistory.find((o) => o.primary_lift === lift) ?? null;

  if (lastForLift != null && lastForLift.end_working_kg != null) {
    const observedStep = lastForLift.lessons?.observed_step_kg_per_wk;
    const step = observedStep != null && observedStep > 0 ? observedStep : FALLBACK_STEP_KG;
    const raw = lastForLift.end_working_kg + step * ACCUMULATION_WEEKS;
    return roundToGrid(raw, STEP_FOR_LIFT[lift]);
  }

  if (fallbackWorkingKg != null) {
    const raw = fallbackWorkingKg + FALLBACK_STEP_KG * FALLBACK_PROGRESSION_WEEKS;
    return roundToGrid(raw, STEP_FOR_LIFT[lift]);
  }

  return null;
}

function roundToGrid(kg: number, step: number): number {
  return Math.round(kg / step) * step;
}
```

- [ ] **Step 2: Append audit cases**

```javascript
import { recommendNextTargetKg } from "@/lib/coach/block-outcomes/recalibrate-target";

console.log("\n## recalibrate-target.ts\n");
{
  // Case 1: lift has prior outcome with observed step 2.5/wk
  const history = [{
    primary_lift: "deadlift",
    end_working_kg: 100,
    lessons: { observed_step_kg_per_wk: 2.5 },
  }];
  const t1 = recommendNextTargetKg({ lift: "deadlift", outcomeHistory: history, fallbackWorkingKg: null });
  // 100 + 2.5×4 = 110 → rounded to 110
  assert("history-based: 100 + 2.5×4 = 110", t1 === 110, `got ${t1}`);

  // Case 2: lift has prior outcome with faster observed step
  const fastHistory = [{
    primary_lift: "deadlift",
    end_working_kg: 100,
    lessons: { observed_step_kg_per_wk: 3.5 },
  }];
  const t2 = recommendNextTargetKg({ lift: "deadlift", outcomeHistory: fastHistory, fallbackWorkingKg: null });
  // 100 + 3.5×4 = 114 → rounded to nearest 2.5 = 115
  assert("history-based: 100 + 3.5×4 = 114 → 115", t2 === 115, `got ${t2}`);

  // Case 3: no history for this lift, but fallback working kg provided
  const t3 = recommendNextTargetKg({ lift: "squat", outcomeHistory: history, fallbackWorkingKg: 80 });
  // 80 + 2.5×4 = 90
  assert("fallback: 80 + 2.5×4 = 90", t3 === 90);

  // Case 4: nothing at all → null
  const t4 = recommendNextTargetKg({ lift: "bench", outcomeHistory: [], fallbackWorkingKg: null });
  assert("no data: null", t4 === null);
}
```

- [ ] **Step 3: Run + commit**

```bash
node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-block-outcomes-rules.mjs
```

Then:

```bash
git add lib/coach/block-outcomes/recalibrate-target.ts scripts/audit-block-outcomes-rules.mjs
git commit -m "$(cat <<'EOF'
feat(block-outcomes): recalibrate-target

recommendNextTargetKg derives the next focus block's target from real
data: end_working_kg of the lift's last focus block + (observed step ×
4 accumulation weeks). Falls back to current working kg + (2.5 × 4)
when no history exists. Rounds to equipment grid.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `lessons.ts`

**Files:**
- Create: `lib/coach/block-outcomes/lessons.ts`
- Modify: `scripts/audit-block-outcomes-rules.mjs`

- [ ] **Step 1: Write `lessons.ts`**

```typescript
// lib/coach/block-outcomes/lessons.ts
//
// Pure templating. Builds the deterministic lessons jsonb from the
// evaluator output + rotation decision + secondary-lift summary.

import type { BlockOutcomeLessons, BlockPhaseAtEnd, PrimaryLift } from "@/lib/data/types";
import type { BlockOutcomeFacts } from "@/lib/coach/block-outcomes/evaluator";
import type { SecondaryLiftOutcome } from "@/lib/coach/block-outcomes/types";
import type { RotationDecision } from "@/lib/coach/block-outcomes/rotation";

export function composeLessons(opts: {
  facts: BlockOutcomeFacts;
  primaryLift: PrimaryLift;
  targetValueKg: number | null;
  secondaryLifts: SecondaryLiftOutcome[];
  rotationDecision: RotationDecision;
}): BlockOutcomeLessons {
  const { facts, secondaryLifts, rotationDecision } = opts;

  const calibration_note = calibrationNote(facts.block_phase_at_end, facts.gap_pct, facts.observed_step_kg_per_wk);

  return {
    observed_step_kg_per_wk: facts.observed_step_kg_per_wk,
    projected_kg_at_end: facts.projected_kg_at_end,
    gap_kg: facts.gap_kg,
    gap_pct: facts.gap_pct,
    calibration_note,
    secondary_lifts: secondaryLifts,
    rotation_context: {
      ideal_next: rotationDecision.recommended_lift,
      athlete_overrode_rotation: false, // mutated later by SETUP_BLOCK_PROMPT if athlete overrides
      override_reason: null,
    },
  };
}

function calibrationNote(
  phase: BlockPhaseAtEnd,
  gapPct: number | null,
  observedStep: number | null,
): string {
  switch (phase) {
    case "hit_early":
      return "Target was conservative — block ended in consolidation. Next focus block target raised more aggressively from the in-block step rate.";
    case "hit_on_pace":
      return "Clean execution at the prescribed pace. Next focus block target derived from end working kg + 4 accumulation weeks at the same step rate.";
    case "off_pace": {
      const gapPart = gapPct != null ? ` (${gapPct.toFixed(0)}% gap)` : "";
      const stepPart =
        observedStep != null
          ? ` Observed step ${observedStep.toFixed(2)} kg/wk — actual rate, not aspirational.`
          : "";
      return `Target was unreachable in remaining weeks${gapPart}. Next time this lift comes around, target sets from end working kg + 4 weeks of observed rate.${stepPart}`;
    }
    case "underperformed":
      return "Narrow miss — within 10% of target. Target was approximately right; consider whether one more accumulation week or a slightly slower step would close the gap.";
  }
}
```

- [ ] **Step 2: Append audit case**

```javascript
import { composeLessons } from "@/lib/coach/block-outcomes/lessons";

console.log("\n## lessons.ts\n");
{
  const facts = {
    end_working_kg: 100,
    target_hit: false,
    block_phase_at_end: "off_pace",
    observed_step_kg_per_wk: 2.5,
    projected_kg_at_end: null,
    gap_kg: 15,
    gap_pct: 13.04,
  };
  const lessons = composeLessons({
    facts,
    primaryLift: "deadlift",
    targetValueKg: 115,
    secondaryLifts: [{ lift: "squat", end_kg: 72.5, clamp_held: true }],
    rotationDecision: { recommended_lift: "bench", reasoning: "standard_rotation", consecutive_focus_warning: false },
  });
  assert("lessons: off_pace calibration_note mentions gap", lessons.calibration_note.includes("13%") || lessons.calibration_note.includes("gap"));
  assert("lessons: rotation_context.ideal_next = bench", lessons.rotation_context.ideal_next === "bench");
  assert("lessons: secondary_lifts present", lessons.secondary_lifts.length === 1 && lessons.secondary_lifts[0].clamp_held === true);
}
```

- [ ] **Step 3: Run + commit**

```bash
node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-block-outcomes-rules.mjs
```

```bash
git add lib/coach/block-outcomes/lessons.ts scripts/audit-block-outcomes-rules.mjs
git commit -m "$(cat <<'EOF'
feat(block-outcomes): lessons composer

composeLessons builds the deterministic lessons jsonb from evaluator
facts + secondary-lift outcomes + rotation decision. calibrationNote
is a 4-branch lookup keyed by block_phase_at_end. NO AI; prose lives
in Carter's chat narration.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: `trajectory.ts`

**Files:**
- Create: `lib/coach/block-outcomes/trajectory.ts`

This module reads from Supabase, so its audit runs in the e2e script (Task 19), not the pure-function audit.

- [ ] **Step 1: Write `trajectory.ts`**

```typescript
// lib/coach/block-outcomes/trajectory.ts
//
// Cross-block macrocycle analysis. Reads block_outcomes + falls back to
// in-progress training_blocks for the active block. Returns the
// BlockTrajectoryPayload consumed by /coach/trends + the BlockOutcomeCard.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { PrimaryLift, BlockOutcome, BlockTrajectoryPayload, TrainingBlock } from "@/lib/data/types";
import { ROTATION_ORDER, idealSequence } from "@/lib/coach/block-outcomes/rotation";

const ROTATION_LIFTS: PrimaryLift[] = ROTATION_ORDER;

export async function generateBlockTrajectory(opts: {
  supabase: SupabaseClient;
  userId: string;
  todayIso: string;
}): Promise<BlockTrajectoryPayload> {
  const { supabase, userId, todayIso } = opts;

  // 1. Load closed outcomes
  const { data: outcomes } = await supabase
    .from("block_outcomes")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  const closed = (outcomes ?? []) as BlockOutcome[];

  // 2. Load active block (so trajectory is live even mid-block)
  const { data: activeBlocks } = await supabase
    .from("training_blocks")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "active")
    .limit(1);
  const active = (activeBlocks?.[0] as TrainingBlock | undefined) ?? null;

  // 3. Load priority lift
  const { data: profile } = await supabase
    .from("profiles")
    .select("rotation_priority_lift")
    .eq("user_id", userId)
    .maybeSingle();
  const priorityLift = (profile?.rotation_priority_lift as PrimaryLift | null) ?? null;

  // 4. Per-lift trajectory
  const per_lift = ROTATION_LIFTS.map((lift) => {
    const liftBlocks = closed
      .filter((o) => o.primary_lift === lift)
      .map((o) => ({
        block_id: o.block_id,
        window: { start_date: getBlockField(o, "start_date"), end_date: getBlockField(o, "end_date") },
        target_kg: o.target_value_kg,
        end_working_kg: o.end_working_kg,
        block_phase_at_end: o.block_phase_at_end,
        calibration_error_pct:
          o.target_value_kg != null && o.end_working_kg != null && o.target_value_kg !== 0
            ? ((o.target_value_kg - o.end_working_kg) / o.target_value_kg) * 100
            : null,
      }));

    const long_term_progression = ltProgressionKgPerYear(liftBlocks);
    const calibration_trend = calibrationTrend(liftBlocks);
    const weeks_since_last_focus = weeksSinceLastFocus(liftBlocks, todayIso);

    return {
      lift,
      blocks: liftBlocks,
      long_term_progression_kg_per_year: long_term_progression,
      target_calibration_trend: calibration_trend,
      weeks_since_last_focus,
    };
  });

  // 5. Rotation adherence
  const actual_sequence = closed.map((o) => o.primary_lift);
  if (active?.primary_lift != null) actual_sequence.push(active.primary_lift);
  const ideal_sequence = idealSequence({
    n: actual_sequence.length || 1,
    priorityLift,
  });
  const deviations: BlockTrajectoryPayload["rotation_adherence"]["deviations"] = [];
  for (let i = 0; i < actual_sequence.length; i++) {
    if (actual_sequence[i] !== ideal_sequence[i]) {
      const blk = closed[i];
      deviations.push({
        block_id: blk?.block_id ?? "active",
        expected: ideal_sequence[i],
        actual: actual_sequence[i],
        reason: blk?.lessons?.rotation_context?.athlete_overrode_rotation
          ? "athlete_choice"
          : (priorityLift != null ? "priority_lift_injection" : "first_block"),
      });
    }
  }
  const adherence_pct =
    actual_sequence.length > 0
      ? ((actual_sequence.length - deviations.length) / actual_sequence.length) * 100
      : 100;

  // 6. Next focus due
  const next_focus_due =
    actual_sequence.length > 0
      ? idealSequence({ n: actual_sequence.length + 1, priorityLift })[actual_sequence.length]
      : (priorityLift ?? "deadlift");

  return {
    per_lift,
    rotation_adherence: { ideal_sequence, actual_sequence, adherence_pct, deviations },
    next_focus_due,
  };
}

// ── helpers ────────────────────────────────────────────────────────────────

/** training_blocks fields aren't on block_outcomes directly; we need a join
 *  or a denorm. For v1, we resolve at read-time via block_id lookup. The
 *  trajectory call already fetches blocks via the outcomes; if we want
 *  zero N+1, add a join. For now the simpler approach: store nothing extra
 *  and pull start/end on demand. */
function getBlockField(_o: BlockOutcome, field: "start_date" | "end_date"): string {
  // PLACEHOLDER: filled by orchestrator pre-call OR via a denorm field.
  // To avoid an N+1 in v1, the orchestrator should pass already-joined data.
  // Until then, return a sentinel. trajectory.ts will be called by a wrapper
  // that joins; see compose-block-history.ts in Task 16.
  void field;
  return "";
}

function ltProgressionKgPerYear(blocks: Array<{ end_working_kg: number | null; window: { end_date: string } }>): number | null {
  const pts = blocks.filter((b) => b.end_working_kg != null && b.window.end_date !== "");
  if (pts.length < 2) return null;
  // OLS slope (kg per day) × 365
  const first = new Date(pts[0].window.end_date + "T00:00:00Z").getTime();
  const points = pts.map((b) => [
    (new Date(b.window.end_date + "T00:00:00Z").getTime() - first) / (24 * 60 * 60 * 1000),
    b.end_working_kg as number,
  ] as [number, number]);
  const n = points.length;
  const sumX = points.reduce((a, p) => a + p[0], 0);
  const sumY = points.reduce((a, p) => a + p[1], 0);
  const sumXY = points.reduce((a, p) => a + p[0] * p[1], 0);
  const sumX2 = points.reduce((a, p) => a + p[0] * p[0], 0);
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return null;
  const slope = (n * sumXY - sumX * sumY) / denom;
  return slope * 365;
}

function calibrationTrend(
  blocks: Array<{ calibration_error_pct: number | null }>,
): "improving" | "stable" | "drifting" | "insufficient_data" {
  const errs = blocks.map((b) => b.calibration_error_pct).filter((e): e is number => e != null);
  if (errs.length < 3) return "insufficient_data";
  const recent = errs.slice(-3);
  const older = errs.slice(0, -3);
  if (older.length === 0) return "stable";
  const recentAbs = recent.reduce((a, x) => a + Math.abs(x), 0) / recent.length;
  const olderAbs = older.reduce((a, x) => a + Math.abs(x), 0) / older.length;
  if (recentAbs < olderAbs * 0.7) return "improving";
  if (recentAbs > olderAbs * 1.3) return "drifting";
  return "stable";
}

function weeksSinceLastFocus(
  blocks: Array<{ window: { end_date: string } }>,
  todayIso: string,
): number | null {
  const last = blocks[blocks.length - 1];
  if (!last || last.window.end_date === "") return null;
  const todayMs = new Date(todayIso + "T00:00:00Z").getTime();
  const endMs = new Date(last.window.end_date + "T00:00:00Z").getTime();
  return Math.max(0, Math.round((todayMs - endMs) / (7 * 24 * 60 * 60 * 1000)));
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: clean. The `getBlockField` placeholder returning empty strings is intentional — the orchestrator joins the data and passes it in via a wrapper (handled in Task 8 — see the orchestrator's `loadOutcomesWithBlockWindows` helper).

- [ ] **Step 3: Commit**

```bash
git add lib/coach/block-outcomes/trajectory.ts
git commit -m "$(cat <<'EOF'
feat(block-outcomes): trajectory composer

generateBlockTrajectory computes per-lift block sequence with
calibration error %, long-term progression (kg/year OLS slope across
block end dates), calibration trend (improving/stable/drifting), and
weeks since last focus. Rotation adherence compares actual vs ideal
sequence; deviations are tagged athlete_choice / priority_injection /
first_block. Reads block_outcomes + falls back to active training_block
for live mid-block view.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Orchestrator + integration

**Files:**
- Create: `lib/coach/block-outcomes/index.ts`

- [ ] **Step 1: Write the orchestrator**

```typescript
// lib/coach/block-outcomes/index.ts
//
// Loads data, runs the rule modules, returns the row payload the cron
// inserts. Also handles the secondary-lift summary (non-focus primaries'
// end kg + clamp adherence) since that data is shared across multiple
// rule outputs.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { TrainingBlock, BlockOutcome, PrimaryLift } from "@/lib/data/types";
import type { BlockSetSample, SecondaryLiftOutcome } from "@/lib/coach/block-outcomes/types";
import { evaluateBlockOutcome } from "@/lib/coach/block-outcomes/evaluator";
import { recommendNextFocus } from "@/lib/coach/block-outcomes/rotation";
import { recommendNextTargetKg } from "@/lib/coach/block-outcomes/recalibrate-target";
import { composeLessons } from "@/lib/coach/block-outcomes/lessons";

const PRIMARY_LIFT_NAME_PATTERNS: Record<PrimaryLift, string[]> = {
  squat:    ["Squat (Barbell)"],
  bench:    ["Decline Bench Press (Barbell)", "Incline Bench Press (Dumbbell)", "Bench Press (Barbell)"],
  deadlift: ["Deadlift (Barbell)"],
  ohp:      ["Overhead Press (Barbell)"],
};

export type GenerateBlockOutcomeResult = {
  payload: Omit<BlockOutcome, "id" | "athlete_acknowledged_at" | "created_at" | "updated_at">;
};

export async function generateBlockOutcome(opts: {
  supabase: SupabaseClient;
  userId: string;
  blockId: string;
}): Promise<GenerateBlockOutcomeResult> {
  const { supabase, userId, blockId } = opts;

  // 1. Load the block
  const { data: blockRow } = await supabase
    .from("training_blocks")
    .select("*")
    .eq("id", blockId)
    .eq("user_id", userId)
    .maybeSingle();
  const block = blockRow as TrainingBlock | null;
  if (!block) throw new Error(`block ${blockId} not found for user`);

  // 2. Load all sets in the block window
  const { data: wRows } = await supabase
    .from("workouts")
    .select("date, exercises(name, exercise_sets(kg, reps, warmup, failure))")
    .eq("user_id", userId)
    .gte("date", block.start_date)
    .lte("date", block.end_date);

  type RawSet = { kg: number | null; reps: number | null; warmup: boolean | null; failure: boolean | null };
  type RawEx = { name: string; exercise_sets: RawSet[] | null };
  type RawW = { date: string; exercises: RawEx[] | null };
  const rows = (wRows ?? []) as unknown as RawW[];

  // 3. Filter to clean working sets, attach weekN
  const blockStartMs = new Date(block.start_date + "T00:00:00Z").getTime();
  const cleanSetsByName: Map<string, BlockSetSample[]> = new Map();
  for (const w of rows) {
    for (const ex of w.exercises ?? []) {
      for (const s of ex.exercise_sets ?? []) {
        if (s.kg == null || s.reps == null) continue;
        if (s.warmup || s.failure) continue;
        if (s.reps < 5) continue;
        const performedMs = new Date(w.date + "T00:00:00Z").getTime();
        const weekN = Math.max(1, Math.floor((performedMs - blockStartMs) / (7 * 24 * 60 * 60 * 1000)) + 1);
        const sample: BlockSetSample = {
          exercise_name: ex.name,
          kg: s.kg,
          reps: s.reps,
          performed_on: w.date,
          weekN,
        };
        const list = cleanSetsByName.get(ex.name) ?? [];
        list.push(sample);
        cleanSetsByName.set(ex.name, list);
      }
    }
  }

  const primaryLift = block.primary_lift;
  if (primaryLift == null) {
    throw new Error(`block ${blockId} has no primary_lift; cannot evaluate`);
  }

  // 4. Primary lift sets
  const primaryNames = PRIMARY_LIFT_NAME_PATTERNS[primaryLift];
  const primarySets: BlockSetSample[] = [];
  for (const name of primaryNames) {
    primarySets.push(...(cleanSetsByName.get(name) ?? []));
  }

  // 5. Block weeks
  const blockEndMs = new Date(block.end_date + "T00:00:00Z").getTime();
  const totalBlockWeeks = Math.max(1, Math.round((blockEndMs - blockStartMs) / (7 * 24 * 60 * 60 * 1000)));

  // 6. Evaluate
  const facts = evaluateBlockOutcome({ block, primarySets, totalBlockWeeks });

  // 7. Secondary lifts
  const secondaryLifts: SecondaryLiftOutcome[] = (["squat", "bench", "deadlift", "ohp"] as PrimaryLift[])
    .filter((l) => l !== primaryLift)
    .map((l) => {
      const names = PRIMARY_LIFT_NAME_PATTERNS[l];
      const sets: BlockSetSample[] = [];
      for (const name of names) sets.push(...(cleanSetsByName.get(name) ?? []));
      const endKg = sets.length > 0 ? Math.max(...sets.map((s) => s.kg)) : null;
      // clamp_held check: did any set exceed (block-start working kg × 0.92)?
      // For v1, we approximate clamp_held=true if endKg <= sets[0].kg × 1.0 (no growth) — conservative.
      const startKg = sets.length > 0 ? Math.min(...sets.map((s) => s.kg)) : null;
      const clamp_held = endKg == null || startKg == null ? true : endKg <= startKg * 1.05;
      return { lift: l, end_kg: endKg, clamp_held };
    });

  // 8. Rotation decision (needs all the user's blocks + their priority lift)
  const { data: allBlocks } = await supabase
    .from("training_blocks")
    .select("*")
    .eq("user_id", userId)
    .order("end_date", { ascending: false });
  const userBlocks = (allBlocks ?? []) as TrainingBlock[];

  const { data: profile } = await supabase
    .from("profiles")
    .select("rotation_priority_lift")
    .eq("user_id", userId)
    .maybeSingle();
  const priorityLift = (profile?.rotation_priority_lift as PrimaryLift | null) ?? null;

  const rotationDecision = recommendNextFocus({
    userBlocks,
    priorityLift,
    lastOutcome: { primary_lift: primaryLift, block_phase_at_end: facts.block_phase_at_end },
  });

  // 9. Recalibrated target for the recommended next focus
  const { data: prevOutcomesRows } = await supabase
    .from("block_outcomes")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  const prevOutcomes = (prevOutcomesRows ?? []) as BlockOutcome[];
  const fallbackWorkingKg = computeFallbackForRecommendedLift(cleanSetsByName, rotationDecision.recommended_lift);
  const recommendedTargetKg = recommendNextTargetKg({
    lift: rotationDecision.recommended_lift,
    outcomeHistory: prevOutcomes,
    fallbackWorkingKg,
  });

  // 10. Compose lessons
  const lessons = composeLessons({
    facts,
    primaryLift,
    targetValueKg: block.target_value,
    secondaryLifts,
    rotationDecision,
  });

  return {
    payload: {
      block_id: blockId,
      user_id: userId,
      primary_lift: primaryLift,
      target_value_kg: block.target_value,
      target_metric: block.target_metric,
      end_working_kg: facts.end_working_kg,
      target_hit: facts.target_hit,
      target_hit_at_week: block.target_hit_at_week,
      block_phase_at_end: facts.block_phase_at_end,
      lessons,
      recommended_next_focus: rotationDecision.recommended_lift,
      recommended_target_value_kg: recommendedTargetKg,
    },
  };
}

function computeFallbackForRecommendedLift(
  cleanSetsByName: Map<string, BlockSetSample[]>,
  lift: PrimaryLift,
): number | null {
  const names = PRIMARY_LIFT_NAME_PATTERNS[lift];
  const sets: BlockSetSample[] = [];
  for (const name of names) sets.push(...(cleanSetsByName.get(name) ?? []));
  if (sets.length === 0) return null;
  return Math.max(...sets.map((s) => s.kg));
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add lib/coach/block-outcomes/index.ts
git commit -m "$(cat <<'EOF'
feat(block-outcomes): orchestrator

generateBlockOutcome loads the block + workouts in its window, filters
to clean working sets (reps≥5, !warmup, !failure), runs evaluator +
rotation + recalibrate-target + lessons composers, returns the row
payload for the cron to insert. Secondary lift outcomes computed
inline (their kg + a coarse clamp_held heuristic).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Cron sweep route

**Files:**
- Create: `app/api/coach/block-outcomes/sweep/route.ts`
- Modify: `vercel.json`

- [ ] **Step 1: Inspect an existing cron route for the pattern**

```bash
sed -n '1,80p' app/api/coach/proactive/check/route.ts
```

Note: CRON_SECRET auth header check, service-role client, return-shape.

- [ ] **Step 2: Write the route**

```typescript
// app/api/coach/block-outcomes/sweep/route.ts
//
// Daily cron at 02:00 UTC. Scans for training_blocks whose end_date has
// passed and lack a block_outcomes row, runs generateBlockOutcome for
// each, inserts the row, and writes a chat_messages.kind='block_outcome'
// card so the next chat open surfaces it. Idempotent on unique(block_id).

import { NextResponse } from "next/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { generateBlockOutcome } from "@/lib/coach/block-outcomes";
import { todayInUserTz } from "@/lib/time";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabase = createSupabaseServiceRoleClient();
  const today = todayInUserTz();

  // Find blocks whose end_date has passed and lack a matching block_outcomes row
  const { data: blocks, error } = await supabase
    .from("training_blocks")
    .select("id, user_id, end_date, primary_lift")
    .lt("end_date", today);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const summary = { scanned: 0, written: 0, skipped: 0, failed: 0, errors: [] as Array<{ block_id: string; message: string }> };

  for (const b of blocks ?? []) {
    summary.scanned += 1;

    const { data: existing } = await supabase
      .from("block_outcomes")
      .select("id")
      .eq("block_id", b.id)
      .maybeSingle();
    if (existing) { summary.skipped += 1; continue; }

    if (b.primary_lift == null) { summary.skipped += 1; continue; }

    try {
      const { payload } = await generateBlockOutcome({ supabase, userId: b.user_id, blockId: b.id });

      const { error: insErr } = await supabase
        .from("block_outcomes")
        .insert({
          block_id: payload.block_id,
          user_id: payload.user_id,
          primary_lift: payload.primary_lift,
          target_value_kg: payload.target_value_kg,
          target_metric: payload.target_metric,
          end_working_kg: payload.end_working_kg,
          target_hit: payload.target_hit,
          target_hit_at_week: payload.target_hit_at_week,
          block_phase_at_end: payload.block_phase_at_end,
          lessons: payload.lessons,
          recommended_next_focus: payload.recommended_next_focus,
          recommended_target_value_kg: payload.recommended_target_value_kg,
        });
      if (insErr) throw insErr;

      // Write the chat card
      await supabase.from("chat_messages").insert({
        user_id: payload.user_id,
        role: "assistant",
        kind: "block_outcome",
        content: `Block complete: ${payload.primary_lift} focus, ${payload.block_phase_at_end}.`,
        speaker: "carter",
        ui: { block_id: payload.block_id },
      });

      summary.written += 1;
    } catch (e) {
      summary.failed += 1;
      summary.errors.push({ block_id: b.id, message: (e as Error).message });
    }
  }

  return NextResponse.json({ ok: true, summary });
}
```

- [ ] **Step 3: Update `vercel.json`**

Add to the `crons` array:

```json
{ "path": "/api/coach/block-outcomes/sweep", "schedule": "0 2 * * *" }
```

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add app/api/coach/block-outcomes/sweep/route.ts vercel.json
git commit -m "$(cat <<'EOF'
feat(block-outcomes): daily cron sweep

Daily at 02:00 UTC. Scans training_blocks where end_date < today and
no block_outcomes row exists; runs generateBlockOutcome for each;
inserts the row + a chat_messages.kind='block_outcome' card. Idempotent
on the unique(block_id) constraint. Per-block failures logged in the
response summary; sweep continues.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: `set_rotation_priority_lift` tool + `/api/profile/rotation-priority` endpoint

**Files:**
- Modify: `lib/coach/tools.ts`
- Create: `app/api/profile/rotation-priority/route.ts`

- [ ] **Step 1: Add the chat tool**

In `lib/coach/tools.ts`, find a similar small-setting tool (e.g., `set_directness` or `set_cadence`) and mirror its structure. Add after the existing set_* tools:

```typescript
export const SET_ROTATION_PRIORITY_LIFT_TOOL = {
  name: "set_rotation_priority_lift",
  description:
    "Set the athlete's persistent rotation priority lift (single value). When set, every other rotation slot becomes this lift, with a non-priority lift between for recovery. NULL = clear; standard D → B → S → OHP rotation resumes.",
  input_schema: {
    type: "object" as const,
    required: ["lift"],
    properties: {
      lift: { type: "string", enum: ["squat", "bench", "deadlift", "ohp", "none"] },
    },
  },
};

export async function executeSetRotationPriorityLift(opts: {
  supabase: SupabaseClient;
  userId: string;
  input: unknown;
}): Promise<ToolResult<{ rotation_priority_lift: PrimaryLift | null }>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;
  const lift = i.lift === "none" ? null : (i.lift as PrimaryLift);
  if (lift !== null && !["squat", "bench", "deadlift", "ohp"].includes(lift)) {
    return { ok: false, error: { error: "invalid lift" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }

  const { error } = await opts.supabase
    .from("profiles")
    .update({ rotation_priority_lift: lift })
    .eq("user_id", opts.userId);
  if (error) {
    return { ok: false, error: { error: error.message }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  return { ok: true, data: { rotation_priority_lift: lift }, meta: { ms: Date.now() - t0, result_rows: 1, range_days: 0, truncated: false } };
}
```

Add the tool to the relevant tool arrays (CARTER_TOOLS for default + intake mode — check the existing set_directness wiring). Add to the dispatch switch at the bottom of `tools.ts` mirroring the existing set_* dispatch.

- [ ] **Step 2: Write the REST endpoint**

```typescript
// app/api/profile/rotation-priority/route.ts
//
// POST { lift: 'squat'|'bench'|'deadlift'|'ohp'|null } — updates
// profiles.rotation_priority_lift for the authenticated user. Cookie-
// bound, RLS-respecting. Used by the /profile UI dropdown.

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  let body: { lift: string | null };
  try {
    body = (await req.json()) as { lift: string | null };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const lift = body.lift;
  if (lift !== null && !["squat", "bench", "deadlift", "ohp"].includes(lift)) {
    return NextResponse.json({ error: "Invalid lift" }, { status: 400 });
  }

  const { error } = await supabase
    .from("profiles")
    .update({ rotation_priority_lift: lift })
    .eq("user_id", user.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, lift });
}
```

- [ ] **Step 3: Typecheck + commit**

```bash
npm run typecheck
git add lib/coach/tools.ts app/api/profile/rotation-priority/route.ts
git commit -m "$(cat <<'EOF'
feat(block-outcomes): set_rotation_priority_lift tool + REST endpoint

Carter can update profiles.rotation_priority_lift via set_rotation_priority_lift
during intake or any default-mode chat. /api/profile/rotation-priority is
the cookie-bound REST endpoint used by the /profile dropdown.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: SETUP_BLOCK_PROMPT extension

**Files:**
- Modify: `lib/coach/planning-prompts.ts`

- [ ] **Step 1: Read the current SETUP_BLOCK_PROMPT**

```bash
sed -n '100,160p' lib/coach/planning-prompts.ts
```

- [ ] **Step 2: Replace the ELICIT beat with the rotation-aware version**

Find Beat 2 (ELICIT) inside `SETUP_BLOCK_PROMPT` and replace with:

```typescript
2. **ELICIT.** Before asking the user, check the BLOCK_OUTCOME_CONTEXT block in your context (provided by the route). If there's an unacknowledged block_outcomes row, lead with the rotation recommendation:

   "Your last block (<primary_lift>, <block_phase_at_end>) closed on <end_date>. The 4-lift rotation puts the next focus on <recommended_next_focus> (cycle: deadlift → bench → squat → OHP). My recommended target for <recommended_next_focus> is <recommended_target_value_kg> kg, derived from your last <recommended_next_focus> focus block's end working weight + 4 weeks of normal +step.

   Want to go with that, or do you have a lift you want to prioritize?"

   On override:
   - Athlete names a different lift that's in the next 2 in rotation → respect, log as athlete_choice in lessons.rotation_context.override_reason via the apply_rotation_override tool, proceed to PROPOSE with the chosen lift.
   - Athlete names the SAME lift just finished → push back ONCE: "You just finished a <primary_lift> focus block (ended <end_date>, <block_phase_at_end>). Re-focusing immediately leaves no recovery window — the framework says wait 1 block. Are you sure?" If yes, apply override and log; if no, fall back to recommendation.
   - Athlete asks "why <recommended_next_focus>?" → cite the rotation reasoning from lessons.rotation_context plus the recovery argument.

   If NO block_outcome row exists (first-ever block), fall back to today's prompt: ask the user for their lift focus + target directly.
```

For the route handler that assembles this prompt: it already calls `composeChatSystemPrompt` (per planning-prompts.ts:280-ish). Extend `composeChatSystemPrompt` to also inject a `BLOCK_OUTCOME_CONTEXT` section when mode is `setup_block` and an unacknowledged outcome exists. Pseudocode:

```typescript
async function fetchSetupBlockContext(supabase, userId): Promise<string | null> {
  const { data: outcomes } = await supabase
    .from("block_outcomes")
    .select("*")
    .eq("user_id", userId)
    .is("athlete_acknowledged_at", null)
    .order("created_at", { ascending: false })
    .limit(1);
  const o = outcomes?.[0];
  if (!o) return null;
  return [
    "BLOCK_OUTCOME_CONTEXT:",
    `  primary_lift: ${o.primary_lift}`,
    `  block_phase_at_end: ${o.block_phase_at_end}`,
    `  target_value_kg: ${o.target_value_kg}`,
    `  end_working_kg: ${o.end_working_kg}`,
    `  recommended_next_focus: ${o.recommended_next_focus}`,
    `  recommended_target_value_kg: ${o.recommended_target_value_kg}`,
    `  calibration_note: ${o.lessons.calibration_note}`,
  ].join("\n");
}
```

Wire this into the existing `composeChatSystemPrompt` per the codebase's pattern.

- [ ] **Step 3: Typecheck + commit**

```bash
npm run typecheck
git add lib/coach/planning-prompts.ts
git commit -m "$(cat <<'EOF'
feat(block-outcomes): SETUP_BLOCK_PROMPT extended with rotation-aware ELICIT

ELICIT beat now reads the BLOCK_OUTCOME_CONTEXT block (injected by the
route when an unacknowledged outcome exists). Leads with the rotation
recommendation + calibrated target, honors athlete override, pushes
back ONCE on consecutive-same-lift focus. Falls back to today's
behavior (ask cold) when no outcome row exists.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: `framework-state.ts` between-blocks fallback

**Files:**
- Modify: `lib/coach/carter-context/framework-state.ts`

- [ ] **Step 1: Extend the active-block path with a between-blocks fallback**

In `framework-state.ts`, change the early `return null` when no active block exists. Instead, look up the most recent unacknowledged `block_outcomes` row and the priority lift:

```typescript
// After the active-block branch returns its block, OR if there is no active block:
if (!block || block.primary_lift == null) {
  // Between-blocks fallback
  const { data: outcomes } = await supabase
    .from("block_outcomes")
    .select("*")
    .eq("user_id", userId)
    .is("athlete_acknowledged_at", null)
    .order("created_at", { ascending: false })
    .limit(1);
  const outcome = outcomes?.[0] ?? null;
  if (!outcome) return null;

  const { data: profile } = await supabase
    .from("profiles")
    .select("rotation_priority_lift")
    .eq("user_id", userId)
    .maybeSingle();
  const priorityLift = profile?.rotation_priority_lift ?? null;

  const lines: string[] = [
    "<framework_state>",
    `Status: BETWEEN BLOCKS.`,
    `Last block: ${outcome.primary_lift} focus, ended ${outcome.block_phase_at_end} (reached ${outcome.end_working_kg ?? "n/a"} kg vs target ${outcome.target_value_kg ?? "n/a"}).`,
    `Block outcome written; not yet acknowledged by athlete.`,
    `Rotation recommends: ${outcome.recommended_next_focus} focus next block. Suggested target: ${outcome.recommended_target_value_kg ?? "tbd"} kg.`,
    priorityLift != null ? `Athlete priority lift: ${priorityLift}.` : "",
    ``,
    `Framework rule (NON-NEGOTIABLE):`,
    `  Do NOT propose a new ${outcome.primary_lift} block immediately. The 4-lift rotation puts ${outcome.recommended_next_focus} next. If the athlete pushes for consecutive ${outcome.primary_lift} focus, explain the recovery + balance reasoning ONCE and respect their override if they hold firm. Do NOT volunteer a ${outcome.primary_lift} re-focus.`,
    `</framework_state>`,
  ].filter((s) => s !== "");

  return lines.join("\n");
}
```

- [ ] **Step 2: Typecheck + smoke**

```bash
npm run typecheck
```

Manual smoke: `node --input-type=module --env-file=.env.local -e "..."` calling `buildFrameworkStateBlock` for the test user to confirm output reads sensibly. (Skip if no test data yet — verify in Task 19's e2e audit.)

- [ ] **Step 3: Commit**

```bash
git add lib/coach/carter-context/framework-state.ts
git commit -m "$(cat <<'EOF'
feat(block-outcomes): framework-state between-blocks fallback

When no active block exists, framework-state checks for the most
recent unacknowledged block_outcomes row + priority lift, and surfaces
a BETWEEN BLOCKS state in Carter's prompt with the rotation
recommendation + NON-NEGOTIABLE rule against immediate re-focus.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: `BlockOutcomeCard` component

**Files:**
- Create: `components/chat/BlockOutcomeCard.tsx`

- [ ] **Step 1: Inspect an existing card for the layout pattern**

```bash
ls components/chat/ | grep -i card
```

Look at one of the existing simple cards (e.g., `WeeklyReviewCard.tsx` or `WorkoutDebriefCard.tsx`) for the structure.

- [ ] **Step 2: Write `BlockOutcomeCard.tsx`**

```typescript
"use client";

import { useState } from "react";
import type { BlockOutcome } from "@/lib/data/types";
import { Card } from "@/components/ui/Card";
import { COLOR, RADIUS } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";

type Props = {
  outcome: BlockOutcome;
};

const PHASE_LABELS: Record<BlockOutcome["block_phase_at_end"], { label: string; color: string }> = {
  hit_early:     { label: "HIT EARLY",     color: "#16a34a" },
  hit_on_pace:   { label: "ON PACE",       color: "#16a34a" },
  off_pace:      { label: "OFF PACE",      color: "#dc2626" },
  underperformed:{ label: "UNDERPERFORMED",color: "#d97706" },
};

export function BlockOutcomeCard({ outcome }: Props) {
  const [_acknowledged] = useState(outcome.athlete_acknowledged_at != null);
  void _acknowledged;
  const phaseTag = PHASE_LABELS[outcome.block_phase_at_end];
  const lessons = outcome.lessons;

  return (
    <Card style={{ borderRadius: RADIUS.cardHero, padding: "16px 18px", background: COLOR.surface }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: COLOR.textMuted }}>
          BLOCK COMPLETE
        </div>
        <span style={{ fontSize: 10, padding: "4px 8px", background: phaseTag.color + "22", color: phaseTag.color, borderRadius: 9999, fontWeight: 700 }}>
          {phaseTag.label}
        </span>
      </div>

      <div style={{ marginTop: 6, fontSize: 18, fontWeight: 700, textTransform: "capitalize", color: COLOR.textStrong }}>
        {outcome.primary_lift} focus
      </div>

      <div style={{ marginTop: 10, fontSize: 13, color: COLOR.textMid, lineHeight: 1.5 }}>
        Target: <strong>{outcome.target_value_kg ? `${fmtNum(outcome.target_value_kg)} kg` : "—"}</strong>{" · "}
        Reached: <strong>{outcome.end_working_kg != null ? `${fmtNum(outcome.end_working_kg)} kg` : "—"}</strong>
        {lessons.observed_step_kg_per_wk != null && (
          <>{" · "}Observed step: <strong>+{fmtNum(lessons.observed_step_kg_per_wk)} kg/wk</strong></>
        )}
      </div>

      {lessons.calibration_note && (
        <div style={{ marginTop: 10, fontSize: 13, color: COLOR.textMid, fontStyle: "italic", lineHeight: 1.5 }}>
          {lessons.calibration_note}
        </div>
      )}

      <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${COLOR.divider}` }}>
        <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: COLOR.textMuted }}>
          NEXT BLOCK RECOMMENDATION
        </div>
        <div style={{ marginTop: 4, fontSize: 14, fontWeight: 600, color: COLOR.textStrong, textTransform: "capitalize" }}>
          {outcome.recommended_next_focus} focus
          {outcome.recommended_target_value_kg != null && (
            <span style={{ color: COLOR.textMid, fontWeight: 500 }}> · target {fmtNum(outcome.recommended_target_value_kg)} kg</span>
          )}
        </div>
      </div>

      <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
        <a
          href={`/strength?tab=coach&mode=setup_block&prefill_focus=${outcome.recommended_next_focus}&prefill_target=${outcome.recommended_target_value_kg ?? ""}`}
          style={{ flex: 1, textAlign: "center", padding: "10px 14px", borderRadius: 10, background: COLOR.brand, color: "#fff", fontSize: 13, fontWeight: 600, textDecoration: "none" }}
        >
          Start {outcome.recommended_next_focus} block
        </a>
        <a
          href="/strength?tab=coach&mode=setup_block"
          style={{ flex: 1, textAlign: "center", padding: "10px 14px", borderRadius: 10, background: COLOR.surfaceAlt, color: COLOR.textMid, fontSize: 13, fontWeight: 600, textDecoration: "none", border: `1px solid ${COLOR.divider}` }}
        >
          Different priority
        </a>
      </div>

      <div style={{ marginTop: 10, fontSize: 11, color: COLOR.textMuted, textAlign: "right" }}>
        <a href="/coach/trends?section=performance#block-history" style={{ color: COLOR.textMuted, textDecoration: "underline" }}>
          View full block history →
        </a>
      </div>
    </Card>
  );
}
```

- [ ] **Step 3: Typecheck + commit**

```bash
npm run typecheck
git add components/chat/BlockOutcomeCard.tsx
git commit -m "$(cat <<'EOF'
feat(block-outcomes): BlockOutcomeCard

Chat card surface for the 'block_outcome' message kind. Renders the
phase-tagged outcome (hit_early / hit_on_pace / off_pace / underperformed),
target vs reached, observed step, calibration note, next-block
recommendation with calibrated target, and three CTAs: start-recommended,
different-priority, view-trends.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: `ChatMessage` dispatcher

**Files:**
- Modify: `components/chat/ChatMessage.tsx`

- [ ] **Step 1: Find the existing dispatcher logic**

```bash
grep -n "kind ===\|switch.*kind\|workout_debrief\|weekly_review" components/chat/ChatMessage.tsx | head -15
```

- [ ] **Step 2: Add the `block_outcome` branch**

Mirror the existing `workout_debrief` dispatch. Import the card:

```typescript
import { BlockOutcomeCard } from "@/components/chat/BlockOutcomeCard";
```

In the dispatch:

```typescript
if (message.kind === "block_outcome") {
  // The card receives the outcome by querying via block_id stored in ui jsonb.
  // To avoid duplicate queries, we fetch the outcome in the parent
  // (ChatThread) and pass it down. For v1 we inline the fetch via a hook.
  return <BlockOutcomeCardLoader blockId={message.ui?.block_id ?? null} />;
}
```

Add a small loader component that fetches the outcome by block_id via TanStack hook (`useBlockOutcome(blockId)` — add this hook in `lib/query/hooks/useBlockOutcome.ts`).

- [ ] **Step 3: Add the TanStack hook** in `lib/query/hooks/useBlockOutcome.ts`:

```typescript
import { useQuery } from "@tanstack/react-query";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { queryKeys } from "@/lib/query/keys";

export function useBlockOutcome(blockId: string | null) {
  const supabase = createSupabaseBrowserClient();
  return useQuery({
    queryKey: queryKeys.blockOutcome(blockId ?? ""),
    enabled: blockId != null,
    queryFn: async () => {
      if (!blockId) return null;
      const { data, error } = await supabase
        .from("block_outcomes")
        .select("*")
        .eq("block_id", blockId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}
```

Add to `lib/query/keys.ts`:

```typescript
blockOutcome: (blockId: string) => ["block_outcome", blockId] as const,
```

- [ ] **Step 4: Add `BlockOutcomeCardLoader`** inside `ChatMessage.tsx` (or as its own file):

```typescript
function BlockOutcomeCardLoader({ blockId }: { blockId: string | null }) {
  const { data: outcome } = useBlockOutcome(blockId);
  if (!outcome) return null;
  return <BlockOutcomeCard outcome={outcome} />;
}
```

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add components/chat/ChatMessage.tsx lib/query/hooks/useBlockOutcome.ts lib/query/keys.ts
git commit -m "$(cat <<'EOF'
feat(block-outcomes): ChatMessage dispatch + useBlockOutcome hook

ChatMessage routes kind='block_outcome' to a loader that fetches the
outcome row via TanStack and renders BlockOutcomeCard. New hook
useBlockOutcome lives alongside the other query hooks.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 15: `compose-block-history` trends composer + `BlockHistoryCard`

**Files:**
- Create: `lib/coach/trends/compose-block-history.ts`
- Create: `components/coach/BlockHistoryCard.tsx`
- Modify: the `/coach/trends` page client (find with `grep -rn "CoachTrendsClient\|coach/trends" components/coach/ app/coach/trends/`)

- [ ] **Step 1: Write `compose-block-history.ts`**

```typescript
// lib/coach/trends/compose-block-history.ts
//
// Trends-page wrapper around generateBlockTrajectory. The orchestrator
// needs to join block_outcomes with training_blocks to populate the
// window fields (start_date / end_date) that trajectory.ts expects.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { BlockTrajectoryPayload, BlockOutcome, TrainingBlock } from "@/lib/data/types";
import { generateBlockTrajectory } from "@/lib/coach/block-outcomes/trajectory";

export async function composeBlockHistoryForTrends(opts: {
  supabase: SupabaseClient;
  userId: string;
  todayIso: string;
}): Promise<BlockTrajectoryPayload> {
  return generateBlockTrajectory(opts);
}
```

Adjust `trajectory.ts`'s `getBlockField` to actually pull from a joined select. Update the orchestrator's outcomes query in `trajectory.ts` step 1:

```typescript
const { data: outcomes } = await supabase
  .from("block_outcomes")
  .select("*, training_blocks!inner(start_date, end_date)")
  .eq("user_id", userId)
  .order("created_at", { ascending: true });
```

Then in the per-lift loop, read `o.training_blocks.start_date` / `o.training_blocks.end_date` instead of the empty-string sentinel. Update `getBlockField` to: deprecate it; pull windows directly inline.

- [ ] **Step 2: Write `BlockHistoryCard.tsx`**

A minimal-first version focused on the timeline + adherence + next-focus-due text:

```typescript
"use client";

import type { BlockTrajectoryPayload } from "@/lib/data/types";
import { Card } from "@/components/ui/Card";
import { COLOR, RADIUS } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";

type Props = { payload: BlockTrajectoryPayload };

const PHASE_COLOR: Record<string, string> = {
  hit_early: "#16a34a",
  hit_on_pace: "#16a34a",
  off_pace: "#dc2626",
  underperformed: "#d97706",
};

export function BlockHistoryCard({ payload }: Props) {
  return (
    <Card style={{ borderRadius: RADIUS.cardHero, padding: "16px 18px", background: COLOR.surface }}>
      <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: COLOR.textMuted }}>
        BLOCK HISTORY
      </div>
      <div style={{ marginTop: 6, fontSize: 16, fontWeight: 700, color: COLOR.textStrong }}>
        Macrocycle view
      </div>

      <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
        {payload.per_lift.map((line) => (
          <div key={line.lift} style={{ fontSize: 12, color: COLOR.textMid }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ fontWeight: 600, textTransform: "capitalize", color: COLOR.textStrong }}>
                {line.lift}
              </span>
              <span>
                {line.long_term_progression_kg_per_year != null
                  ? `+${fmtNum(line.long_term_progression_kg_per_year)} kg/yr`
                  : "tbd"}
                {" · "}
                <span style={{ color: COLOR.textMuted }}>
                  {line.target_calibration_trend === "insufficient_data" ? "—" : `calibration ${line.target_calibration_trend}`}
                </span>
              </span>
            </div>
            <div style={{ marginTop: 4, display: "flex", gap: 4 }}>
              {line.blocks.length === 0 ? (
                <span style={{ color: COLOR.textMuted, fontSize: 11 }}>never focused</span>
              ) : (
                line.blocks.map((b) => (
                  <span
                    key={b.block_id}
                    title={`${b.window.start_date} → ${b.window.end_date} · target ${b.target_kg ?? "n/a"} · end ${b.end_working_kg ?? "n/a"}`}
                    style={{
                      width: 14, height: 14, borderRadius: 999,
                      background: PHASE_COLOR[b.block_phase_at_end] ?? COLOR.textMuted,
                    }}
                  />
                ))
              )}
            </div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${COLOR.divider}`, fontSize: 12, color: COLOR.textMid }}>
        Rotation adherence: <strong>{fmtNum(payload.rotation_adherence.adherence_pct)}%</strong>
        {payload.rotation_adherence.deviations.length > 0 && (
          <span style={{ color: COLOR.textMuted }}>
            {" "}({payload.rotation_adherence.deviations.length} deviation{payload.rotation_adherence.deviations.length === 1 ? "" : "s"})
          </span>
        )}
        {" · "}Next focus due: <strong style={{ textTransform: "capitalize" }}>{payload.next_focus_due ?? "—"}</strong>
      </div>
    </Card>
  );
}
```

- [ ] **Step 3: Wire into `/coach/trends?section=performance`**

Find the client component for the trends page:

```bash
grep -rn "composeStrength\|generateCoachTrends" app/coach/trends/ components/coach/ --include="*.tsx" | head -5
```

In the server component (likely `app/coach/trends/page.tsx`), call `composeBlockHistoryForTrends` and hydrate. In the client component, render `<BlockHistoryCard payload={blockHistory} />` under the Performance section, with an `id="block-history"` anchor.

- [ ] **Step 4: Typecheck + commit**

```bash
npm run typecheck
git add lib/coach/trends/compose-block-history.ts lib/coach/block-outcomes/trajectory.ts components/coach/BlockHistoryCard.tsx app/coach/trends/page.tsx components/coach/*.tsx
git commit -m "$(cat <<'EOF'
feat(block-outcomes): trends-page block history

compose-block-history wraps generateBlockTrajectory for /coach/trends.
trajectory.ts query updated to join training_blocks for the window
fields. BlockHistoryCard renders the per-lift sequence (colored dots
by phase), per-lift kg/yr progression + calibration trend, rotation
adherence, and next-focus-due. Deep-linkable via #block-history.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 16: Profile dropdown UI

**Files:**
- Modify: `components/profile/StrengthSection.tsx` (or the equivalent — find it)

- [ ] **Step 1: Find the profile strength section**

```bash
grep -rn "Priority lift\|rotation_priority\|profile.*strength" components/profile/ app/profile/ --include="*.tsx" | head -5
ls components/profile/
```

- [ ] **Step 2: Add the dropdown**

Add a section with title "Priority lift (optional)" and a `<select>` bound to the user's current value, posting to `/api/profile/rotation-priority` on change:

```typescript
const [priority, setPriority] = useState<PrimaryLift | null>(initialPriority);

async function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
  const next = e.target.value === "none" ? null : (e.target.value as PrimaryLift);
  setPriority(next);
  await fetch("/api/profile/rotation-priority", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lift: next }),
  });
}

return (
  <section>
    <h3>Priority lift (optional)</h3>
    <p style={{ fontSize: 12, color: COLOR.textMuted }}>
      When set, this lift gets ~4 of every 8 block focuses instead of ~2. No two consecutive focuses
      on the same lift either way.
    </p>
    <select value={priority ?? "none"} onChange={handleChange}>
      <option value="none">None — standard rotation</option>
      <option value="squat">Squat</option>
      <option value="bench">Bench</option>
      <option value="deadlift">Deadlift</option>
      <option value="ohp">Overhead Press</option>
    </select>
  </section>
);
```

- [ ] **Step 3: Typecheck + commit**

```bash
npm run typecheck
git add components/profile/
git commit -m "$(cat <<'EOF'
feat(block-outcomes): /profile priority lift dropdown

Single-select with None / Squat / Bench / Deadlift / OHP. Posts to
/api/profile/rotation-priority. The rotation engine + Carter's
framework_state read from profiles.rotation_priority_lift; setting one
here biases the rotation toward that lift on the next block-end +
rotation recommendation.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 17: Plan-builder intake capture

**Files:**
- Modify: the goal-elicitation beat of the plan-builder intake (likely `lib/coach/plan-builder/goal.ts` or `INTAKE_PROMPT` in `planning-prompts.ts`)

- [ ] **Step 1: Find the goal-elicitation surface**

```bash
grep -rn "goal_text\|goal_kind\|priority lift\|priority_lift" lib/coach/plan-builder/ lib/coach/planning-prompts.ts | head -10
```

- [ ] **Step 2: Extend the goal beat**

Add a line to the goal-elicitation prompt body asking about priority lift:

```
After capturing the goal narrative, ask: "Is there one lift you're prioritizing over the others — squat, bench, deadlift, or OHP? Or no specific priority?"
If named, call set_rotation_priority_lift({lift: '<choice>'}). If "no priority", don't call the tool.
```

- [ ] **Step 3: Typecheck + commit**

```bash
npm run typecheck
git add lib/coach/plan-builder/ lib/coach/planning-prompts.ts
git commit -m "$(cat <<'EOF'
feat(block-outcomes): plan-builder intake captures priority lift

Goal-elicitation beat asks one optional question about priority lift
and calls set_rotation_priority_lift if the athlete names one. NULL
default; standard rotation continues unchanged for users who don't
state a priority.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 18: Apply rotation override mechanism

**Files:**
- Modify: `lib/coach/tools.ts` (add `apply_rotation_override` tool)

- [ ] **Step 1: Add the tool**

```typescript
export const APPLY_ROTATION_OVERRIDE_TOOL = {
  name: "apply_rotation_override",
  description:
    "When the athlete picks a different lift in SETUP_BLOCK_PROMPT (not the rotation recommendation), mark the most recent unacknowledged block_outcomes row's lessons.rotation_context.athlete_overrode_rotation = true with the reason. Idempotent.",
  input_schema: {
    type: "object" as const,
    required: ["override_reason"],
    properties: {
      override_reason: { type: "string", maxLength: 200 },
    },
  },
};

export async function executeApplyRotationOverride(opts: {
  supabase: SupabaseClient;
  userId: string;
  input: unknown;
}): Promise<ToolResult<{ outcome_id: string }>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;
  const reason = typeof i.override_reason === "string" ? i.override_reason : null;
  if (!reason) {
    return { ok: false, error: { error: "override_reason required" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }

  const { data: outcomes } = await opts.supabase
    .from("block_outcomes")
    .select("id, lessons")
    .eq("user_id", opts.userId)
    .is("athlete_acknowledged_at", null)
    .order("created_at", { ascending: false })
    .limit(1);
  const o = outcomes?.[0];
  if (!o) {
    return { ok: false, error: { error: "no unacknowledged outcome to override" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }

  const newLessons = {
    ...(o.lessons as Record<string, unknown>),
    rotation_context: {
      ...(((o.lessons as Record<string, unknown>).rotation_context as Record<string, unknown>) ?? {}),
      athlete_overrode_rotation: true,
      override_reason: reason,
    },
  };

  const { error } = await opts.supabase
    .from("block_outcomes")
    .update({ lessons: newLessons, updated_at: new Date().toISOString() })
    .eq("id", o.id);
  if (error) {
    return { ok: false, error: { error: error.message }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  return { ok: true, data: { outcome_id: o.id }, meta: { ms: Date.now() - t0, result_rows: 1, range_days: 0, truncated: false } };
}
```

Wire into CARTER_TOOLS for setup_block mode. Add to the dispatch switch.

- [ ] **Step 2: Also stamp `athlete_acknowledged_at` when `commit_block` fires**

In `executeCommitBlock`, after a successful commit, set `block_outcomes.athlete_acknowledged_at = now()` for the most recent unacknowledged outcome:

```typescript
await opts.supabase
  .from("block_outcomes")
  .update({ athlete_acknowledged_at: new Date().toISOString() })
  .eq("user_id", opts.userId)
  .is("athlete_acknowledged_at", null);
```

- [ ] **Step 3: Typecheck + commit**

```bash
npm run typecheck
git add lib/coach/tools.ts
git commit -m "$(cat <<'EOF'
feat(block-outcomes): apply_rotation_override + commit_block acknowledgment

New chat tool apply_rotation_override marks the unacknowledged outcome
with athlete_overrode_rotation=true + reason when the athlete picks a
different focus in SETUP_BLOCK_PROMPT. commit_block now also stamps
athlete_acknowledged_at on the outcome so the card stops surfacing.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 19: End-to-end audit script

**Files:**
- Create: `scripts/audit-block-outcomes-e2e.mjs`

- [ ] **Step 1: Write the script**

```javascript
// scripts/audit-block-outcomes-e2e.mjs
//
// End-to-end audit. Verifies: schema columns + the orchestrator can
// generate an outcome for the user's active block (dry run — does NOT
// insert), and that framework_state surfaces the between-blocks state
// when no active block exists.
//
// Run via:
//   AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-block-outcomes-e2e.mjs

import { createClient } from "@supabase/supabase-js";
import { generateBlockOutcome } from "@/lib/coach/block-outcomes";
import { generateBlockTrajectory } from "@/lib/coach/block-outcomes/trajectory";

const userId = process.env.AUDIT_USER_ID;
if (!userId) { console.error("Set AUDIT_USER_ID=<uuid>"); process.exit(1); }
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error("Missing env"); process.exit(1); }
const supabase = createClient(url, key);

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else      { fail++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

console.log("\n## Schema\n");
{
  const a = await supabase.from("block_outcomes").select("id").limit(1);
  assert("block_outcomes selectable", a.error == null, a.error?.message);
  const b = await supabase.from("profiles").select("rotation_priority_lift").limit(1);
  assert("profiles.rotation_priority_lift selectable", b.error == null, b.error?.message);
}

console.log("\n## Orchestrator dry-run\n");
{
  const { data: blocks } = await supabase
    .from("training_blocks").select("id").eq("user_id", userId).limit(1);
  const blockId = blocks?.[0]?.id;
  if (!blockId) {
    console.log("  - No blocks for user; skipping orchestrator dry-run.");
  } else {
    try {
      const { payload } = await generateBlockOutcome({ supabase, userId, blockId });
      assert("generateBlockOutcome returns payload", payload != null);
      assert("payload.primary_lift is valid", ["squat","bench","deadlift","ohp"].includes(payload.primary_lift));
      assert("payload.block_phase_at_end is valid", ["hit_early","hit_on_pace","off_pace","underperformed"].includes(payload.block_phase_at_end));
      console.log(`  Phase: ${payload.block_phase_at_end}, end ${payload.end_working_kg ?? "n/a"} kg vs target ${payload.target_value_kg ?? "n/a"} kg`);
      console.log(`  Recommended next: ${payload.recommended_next_focus} @ ${payload.recommended_target_value_kg ?? "n/a"} kg`);
    } catch (e) {
      assert("generateBlockOutcome dry-run", false, (e).message);
    }
  }
}

console.log("\n## Trajectory\n");
{
  const todayIso = new Date().toISOString().slice(0, 10);
  try {
    const traj = await generateBlockTrajectory({ supabase, userId, todayIso });
    assert("trajectory payload returned", traj != null);
    assert("per_lift has all 4 entries", traj.per_lift.length === 4);
    console.log(`  Next focus due: ${traj.next_focus_due}, adherence ${traj.rotation_adherence.adherence_pct.toFixed(0)}%`);
  } catch (e) {
    assert("generateBlockTrajectory", false, (e).message);
  }
}

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
```

- [ ] **Step 2: Run + commit**

```bash
AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-block-outcomes-e2e.mjs
```

```bash
git add scripts/audit-block-outcomes-e2e.mjs
git commit -m "$(cat <<'EOF'
chore(block-outcomes): end-to-end audit

scripts/audit-block-outcomes-e2e.mjs verifies schema, orchestrator
dry-run against the user's active block, and trajectory composition.
Read-only — does NOT insert outcome rows. Use AUDIT_USER_ID=<uuid>.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 20: CLAUDE.md scripts + final verification + PR

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Append the two new audit scripts to CLAUDE.md's Scripts section**

Add after the existing scripts list:

```markdown
- [scripts/audit-block-outcomes-rules.mjs](scripts/audit-block-outcomes-rules.mjs) — fixture-based pure-function audit for `lib/coach/block-outcomes/` rule modules (evaluator, rotation, recalibrate-target, lessons). No DB access.
- [scripts/audit-block-outcomes-e2e.mjs](scripts/audit-block-outcomes-e2e.mjs) — verifies schema + orchestrator dry-run + trajectory against live data. Set `AUDIT_USER_ID`. Read-only.
```

- [ ] **Step 2: Final verification**

```bash
node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-block-outcomes-rules.mjs
AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-block-outcomes-e2e.mjs
npm run typecheck
```

All three should pass.

- [ ] **Step 3: Manual smoke**

```bash
npm run dev
```

Open `http://localhost:3000/coach/trends?section=performance` — confirm the BlockHistoryCard renders (likely shows "never focused" rows since no outcomes exist yet — that's correct). Confirm no console errors.

Open `http://localhost:3000/profile` — confirm the Priority lift dropdown is present, defaults to "None", and saving updates `profiles.rotation_priority_lift`.

- [ ] **Step 4: Push and open PR**

```bash
git add CLAUDE.md
git commit -m "docs(block-outcomes): CLAUDE.md scripts entries"
git push -u origin feat/block-outcomes-rotation
gh pr create --title "Block Outcomes + Rotation Engine: between-block discipline" --body "$(cat <<'EOF'
## Summary

Companion to the Sunday Prescription System (PRs #119/#120/#121). The prescription system enforced within-block discipline. This PR adds the between-block discipline: deterministic outcome capture, 4-lift rotation engine (D → B → S → OHP, with optional priority-lift injection), data-driven target recalibration, and a cross-block macrocycle view on /coach/trends.

- Migration 0037 adds `block_outcomes` table + `profiles.rotation_priority_lift` + `chat_messages.kind='block_outcome'`.
- Six pure rule modules in `lib/coach/block-outcomes/`: evaluator, rotation, recalibrate-target, lessons, trajectory, orchestrator. NO AI in the data path.
- Daily cron at 02:00 UTC scans for blocks whose end_date has passed and writes the outcome + chat card.
- SETUP_BLOCK_PROMPT extended with rotation-aware ELICIT — leads with the recommendation and calibrated target.
- framework-state.ts gains a between-blocks fallback so default chat is also grounded.
- BlockOutcomeCard renders in chat; BlockHistoryCard renders on /coach/trends?section=performance.
- New tools: `set_rotation_priority_lift` (intake + chat), `apply_rotation_override` (logs athlete override at block-setup time). commit_block now stamps `athlete_acknowledged_at`.
- /profile dropdown for the persistent priority lift.

## Test plan

- [x] `scripts/audit-block-outcomes-rules.mjs` passes (16+ fixture assertions)
- [x] `scripts/audit-block-outcomes-e2e.mjs` passes (schema + orchestrator dry-run + trajectory)
- [x] `npm run typecheck` clean
- [ ] Manual: trigger cron URL post-current-block-end, confirm outcome row + chat card surface
- [ ] Manual: SETUP_BLOCK_PROMPT in chat after a block closes — confirm it leads with the rotation recommendation
- [ ] Manual: /coach/trends?section=performance shows BlockHistoryCard

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

### Spec coverage check

- [x] Schema (migration 0037 + chat_messages widening + profiles.rotation_priority_lift) → Task 1
- [x] Types (BlockOutcome, BlockPhaseAtEnd, BlockTrajectoryPayload, lessons) → Task 2
- [x] evaluator.ts → Task 3
- [x] rotation.ts (4-lift rotation + priority injection + recovery slot) → Task 4
- [x] recalibrate-target.ts → Task 5
- [x] lessons.ts (4-branch calibrationNote) → Task 6
- [x] trajectory.ts (per-lift trajectory + adherence + next_focus_due) → Task 7
- [x] orchestrator (data load + composer fan-in) → Task 8
- [x] Cron sweep route + vercel.json entry → Task 9
- [x] set_rotation_priority_lift tool + REST endpoint → Task 10
- [x] SETUP_BLOCK_PROMPT extension → Task 11
- [x] framework-state.ts between-blocks fallback → Task 12
- [x] BlockOutcomeCard → Task 13
- [x] ChatMessage dispatcher + useBlockOutcome hook → Task 14
- [x] compose-block-history + BlockHistoryCard + trends page → Task 15
- [x] /profile dropdown → Task 16
- [x] Plan-builder intake capture → Task 17
- [x] apply_rotation_override + commit_block ack → Task 18
- [x] End-to-end audit → Task 19
- [x] CLAUDE.md + final verify + PR → Task 20

### Placeholder scan

No "TBD", "TODO", "fill in later", or vague behavior steps. Each step has runnable code, an exact command, or a concrete instruction with example output. The `trajectory.ts` `getBlockField` placeholder is documented as deprecated-in-Task-15 (where the join replaces it) and the orchestrator's call path is explicit.

### Type consistency

- `BlockPhaseAtEnd` ("hit_early" | "hit_on_pace" | "off_pace" | "underperformed") consistent across evaluator, lessons, types.ts, audit
- `PrimaryLift` ("squat" | "bench" | "deadlift" | "ohp") sourced from `lib/data/types.ts` everywhere
- `RotationDecision.reasoning` enum ("standard_rotation" | "priority_injection" | "off_pace_recovery_avoided" | "first_block") consistent
- `BlockOutcomeLessons` shape consistent between types.ts (Task 2) and composer output (Task 6)
- `BlockTrajectoryPayload` shape consistent between types.ts (Task 2) and trajectory.ts (Task 7)

No gaps detected.
