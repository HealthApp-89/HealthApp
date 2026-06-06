# Weekly-Review Engine Collapse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the weekly review's parallel prescription engine into the canonical block-phase engine so Carter chat, the Sunday cron, the weekly review, and Peter's review narrative all cite the same numbers.

**Architecture:** The weekly-review composer currently runs a second, block-unaware engine (`compose-prescription.ts`, 425 lines of MEV/MAV/MRV rules) that disagrees with the canonical `prescribeWeek` engine that Carter and the Sunday cron use. The Sunday cron writes `training_weeks.session_prescriptions` at 03:30 UTC; the weekly-review cron fires 30 min later at 04:00 UTC. Replace the bespoke composer with a thin reader that consumes that fresh row (fall-through: run `prescribeWeek` inline if missing), and switch the header/phase taxonomy from `WeeklyPhase` (mev/mav/mrv/deload) to the canonical `BlockPhase` (pre_target/consolidation/off_pace/deload_week). Implement `computeOnPace` via `bestComparisonValue` against `training_blocks.target_value` + `target_metric`. Widen types (not replace) and bump `schema_version: 2` so historical v1 rows render correctly via UI back-compat shims.

**Tech Stack:** TypeScript 5, Next.js 15 App Router, Supabase (service role for cron), Anthropic SDK (narrative wrap). No test framework in this repo per CLAUDE.md — verify via `npm run typecheck` + new audit script + manual exercise of `/coach/weeks/[week_start]` locally.

**Background diagnosis:** Root-cause investigation lives in conversation context — the smoking guns are (1) [lib/coach/weekly-review/compose-prescription.ts](../../../lib/coach/weekly-review/compose-prescription.ts) running rules like `cutting_hold`/`recovery_hold`/`mev_to_mav_clearance` that never read `training_blocks.target_value` / `target_hit_at_week`, and (2) [lib/coach/weekly-review/index.ts:202-211](../../../lib/coach/weekly-review/index.ts#L202-L211) hardcoding `computeOnPace` to `return null`. Canonical engine: [lib/coach/prescription/prescribe-week.ts](../../../lib/coach/prescription/prescribe-week.ts).

---

## File Structure

**DELETE** (after Task 13 verifies all readers migrated):
- `lib/coach/weekly-review/compose-prescription.ts` (425 lines — the bespoke engine)
- `lib/coach/weekly-review/phase-mapping.ts` (mev/mav/mrv mapper, no longer needed)

**CREATE:**
- `lib/coach/weekly-review/read-prescription.ts` — reads `training_weeks.session_prescriptions` for next Monday, falls through to `prescribeWeek`
- `lib/coach/weekly-review/payload-mapper.ts` — converts `SessionPrescriptions` (weekday → exercises) to `WeeklyReviewPayload.prescription.per_lift` (one row per primary lift)
- `lib/coach/weekly-review/compute-on-pace.ts` — block-phase + target read using `bestComparisonValue`
- `lib/coach/weekly-review/rationale-tags.ts` — re-derives BlockPhase-aligned rationale tags from engine output
- `scripts/audit-weekly-review-vs-engine.mjs` — bytes-equal property check: weekly-review `prescription.per_lift` must match the `training_weeks.session_prescriptions` row for the same `next_week_start`

**MODIFY:**
- `lib/data/types.ts` — widen `WeeklyPhase` union to `WeeklyPhase | BlockPhase`; bump `schema_version: 2`; add new rationale-tag literals
- `lib/coach/weekly-review/index.ts` — replace composer wiring; call read-prescription + payload-mapper + compute-on-pace
- `lib/coach/weekly-review/narrative-prompt.ts` — add engine-narration discipline; widen allowed phase strings in fabrication validator
- `lib/coach/glossary.ts` — add JargonPill entries for `pre_target` / `consolidation` / `off_pace` / `deload_week` + new rationale tags
- `app/api/coach/weekly-review/sync/route.ts` — response payload echo uses widened types
- `components/coach/WeeklyReviewHeader.tsx` — render widened phase taxonomy
- `components/coach/WeeklyReviewPrescription.tsx` — `getRationaleTagSpeaker` covers new BlockPhase tags
- `components/chat/WeeklyReviewCard.tsx` — widen `ui` shape
- `lib/morning/brief/assembler.ts` — phase-transition detection tolerates both taxonomies
- `lib/morning/brief/flags.ts` — same

**UNCHANGED but verified:**
- `components/coach/WeeklyReviewActions.tsx` — reads `prescription.session_plan` (`Record<string, string>`); unchanged shape
- `lib/morning/brief/yesterday-vs-plan.ts` — reads `prescription.rir_target` (still nullable number)
- `lib/coach/trends/compose-strength.ts` — uses `WeeklyPhase` as `StrengthTrend.block_phase_now`; the union widening covers it

---

## Conventions

- **Verification.** This repo has no test framework. After each task: `npm run typecheck` must pass. The audit script (Task 14) is the bytes-equal property check that replaces unit tests.
- **Commits.** One commit per task. Co-author tag matches the repo convention (see `git log -5 --format='%B'` for the live signature).
- **Path alias.** Use `@/*` per [tsconfig.json](../../../tsconfig.json); no relative climbs out of `lib/coach/weekly-review/`.
- **Number formatting.** All user-visible numbers route through `fmtNum()` from `@/lib/ui/score` (memory: `feedback_number_formatting`).

---

### Task 1: Widen `WeeklyPhase` and bump schema_version

**Files:**
- Modify: `lib/data/types.ts:1245-1266` (the `WeeklyPhase` + `PrescriptionRationaleTag` block)
- Modify: `lib/data/types.ts:1268-1275` (the `WeeklyReviewPayload` header)

- [ ] **Step 1: Widen `WeeklyPhase` to include BlockPhase variants and import BlockPhase**

Edit `lib/data/types.ts` at the import block near the top (add the BlockPhase re-export if not already present — verify with `grep -n "^export type BlockPhase\|export.*BlockPhase" lib/data/types.ts`). If `BlockPhase` is not exported from `lib/data/types.ts`, add this near the other type re-exports (the existing `WeekdayLong` export pattern around line ~430 is a good neighbour):

```typescript
export type { BlockPhase } from "@/lib/coach/prescription/types";
```

Then change the `WeeklyPhase` declaration:

```typescript
/** Weekly-review phase taxonomy. v1 rows carry MEV/MAV/MRV volume-landmark
 *  labels written by the (now-removed) bespoke composer. v2 rows carry the
 *  canonical BlockPhase from lib/coach/prescription/types.ts. Discriminator:
 *  WeeklyReviewPayload.schema_version. */
export type WeeklyPhase =
  | "mev" | "mav" | "mrv" | "deload"                                  // v1 (historical)
  | "pre_target" | "consolidation" | "off_pace" | "deload_week";       // v2 (new)
```

- [ ] **Step 2: Add new rationale-tag literals**

In the `PrescriptionRationaleTag` union (currently at lib/data/types.ts:1251-1266), add the BlockPhase-aligned tags before the open-string fallback:

```typescript
export type PrescriptionRationaleTag =
  | "block_start_baseline"
  | "cutting_hold"
  | "recovery_hold"
  | "plateau_deload_reset"
  | "plateau_rep_shift"
  | "rep_completion_miss"
  | "rir_missed_twice"
  | "rir_missed"
  | "form_hold"
  | "mev_to_mav_clearance"
  | "mav_to_mav_step"
  | "mav_to_mrv_advance"
  | "mrv_volume_drive"
  | "deload_load_volume_cut"
  // v2 (BlockPhase-aligned) — emitted by lib/coach/weekly-review/rationale-tags.ts
  | "pre_target_step"
  | "pre_target_hold"
  | "consolidation_hold_progress_reps"
  | "off_pace_hold"
  | "deload_floor"
  | (string & Record<never, never>);
```

- [ ] **Step 3: Bump `schema_version` literal to `1 | 2`**

Change the `WeeklyReviewPayload` declaration:

```typescript
export type WeeklyReviewPayload = {
  schema_version: 1 | 2;  // v1 = MEV/MAV/MRV phase; v2 = BlockPhase + engine-bound prescription
  header: { /* ... unchanged shape; field values widen via WeeklyPhase widening */ };
  // ... rest unchanged
};
```

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck
```

Expected: PASS (the WeeklyPhase widening is a superset; every existing literal still satisfies the union).

- [ ] **Step 5: Commit**

```bash
git add lib/data/types.ts
git commit -m "$(cat <<'EOF'
types: widen WeeklyPhase to include BlockPhase + bump schema_version to 2

Foundation for the weekly-review engine collapse. WeeklyPhase now accepts
both the v1 volume-landmark labels (mev/mav/mrv/deload) and the v2 BlockPhase
labels (pre_target/consolidation/off_pace/deload_week). schema_version
discriminates so the UI can render historical v1 rows alongside fresh v2.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Add JargonPill glossary entries for BlockPhase + new rationale tags

**Files:**
- Modify: `lib/coach/glossary.ts:14-30` (the `JargonTermKey` union and entries map)

- [ ] **Step 1: Read the existing glossary structure**

```bash
sed -n '1,90p' lib/coach/glossary.ts
```

Note the union and the entries object — both need additions.

- [ ] **Step 2: Add BlockPhase + new rationale-tag keys to the `JargonTermKey` union**

Add these literals to the union (insertion point: after the existing `mrv_volume_drive` line in the union):

```typescript
  | "pre_target"
  | "consolidation"
  | "off_pace"
  | "deload_week"
  | "pre_target_step"
  | "pre_target_hold"
  | "consolidation_hold_progress_reps"
  | "off_pace_hold"
  | "deload_floor"
```

- [ ] **Step 3: Add entries to the JARGON map**

After the existing `deload_load_volume_cut` entry, append:

```typescript
  pre_target: {
    term: "Pre-target",
    short: "Block is still progressing toward the primary-lift target.",
    full: "The athlete hasn't hit the block's target_value yet and is on pace to reach it within the remaining weeks. Progression rule: +step kg on the primary lift when last week's RIR target was hit cleanly; hold otherwise.",
  },
  consolidation: {
    term: "Consolidation",
    short: "Target hit early; the rest of the block locks in the gain.",
    full: "training_blocks.target_hit_at_week was stamped before the final week. We hold the load and chase reps + sets to consolidate the adaptation. Don't raise the target mid-block — that requires closing the block and starting a new one.",
  },
  off_pace: {
    term: "Off pace",
    short: "Required weekly progress now exceeds the realistic per-week step.",
    full: "Remaining weeks × the lift's realistic progression rate < (target − current). The block won't hit target without forcing risky jumps. Hold load this week; revisit at block close (we'll inherit the delta into the next block, or close early).",
  },
  deload_week: {
    term: "Deload",
    short: "Last week of the block — volume + intensity cut to recover.",
    full: "Week 5 of the 5-week block. Load × 0.80, sets halved (MEV floor), reps held. The week exists to clear fatigue before the next block, not to chase another PR.",
  },
  pre_target_step: {
    term: "Step up",
    short: "Pre-target phase: clean RIR last week → +step kg.",
    full: "Last week's RIR target was hit cleanly on this lift. The engine adds the smallest valid grid increment for the lift (see increment.step).",
  },
  pre_target_hold: {
    term: "Hold",
    short: "Pre-target phase: RIR missed last week → hold load.",
    full: "Last week's RIR target was not met cleanly. Hold load this week and clear it before stepping up.",
  },
  consolidation_hold_progress_reps: {
    term: "Hold + reps",
    short: "Consolidation: hold load, push reps + sets.",
    full: "Target already hit. We're not chasing more weight this block — we lock in the load and grow volume by adding a rep and an extra set per session.",
  },
  off_pace_hold: {
    term: "Off-pace hold",
    short: "Off-pace verdict: hold load this week.",
    full: "Required weekly progress exceeds the realistic per-week step. Don't force a jump — hold load, finish the block honestly, and either close early or carry the delta into the next block.",
  },
  deload_floor: {
    term: "Deload floor",
    short: "Deload week: load × 0.80, sets halved.",
    full: "MEV-floor maintenance. Just enough stimulus to retain the adaptation while recovering for the next block.",
  },
```

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/coach/glossary.ts
git commit -m "$(cat <<'EOF'
glossary: BlockPhase + engine rationale-tag entries

Adds JargonPill entries for pre_target/consolidation/off_pace/deload_week
plus the five v2 rationale tags the weekly-review payload-mapper will emit.
Required before any UI surface starts rendering the widened payload.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Create `read-prescription.ts` — the thin reader

**Files:**
- Create: `lib/coach/weekly-review/read-prescription.ts`

- [ ] **Step 1: Write the reader**

```typescript
// lib/coach/weekly-review/read-prescription.ts
//
// Single seam for the weekly review to obtain next-week's deterministic
// prescription. Two-tier read:
//   1. Read training_weeks.session_prescriptions for next_week_start (the
//      Sunday cron at 03:30 UTC writes this 30 min before the weekly-review
//      cron at 04:00 UTC).
//   2. Fall through to prescribeWeek inline when the row is missing — keeps
//      the review robust if the cron failed or the user came up between blocks.
//
// Returns the canonical SessionPrescriptions shape. The payload-mapper
// downstream converts that into the per_lift array the WeeklyReviewPayload
// expects.

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  SessionPrescriptions,
  TrainingBlock,
  TrainingWeek,
} from "@/lib/data/types";
import { prescribeWeek } from "@/lib/coach/prescription/prescribe-week";

export type ReadPrescriptionResult = {
  prescription: SessionPrescriptions;
  /** "row" when read from training_weeks.session_prescriptions, "inline"
   *  when prescribeWeek was called as the fallback. Surfaced in the audit
   *  script + visible in observability. */
  source: "row" | "inline";
};

export async function readNextWeekPrescription(opts: {
  supabase: SupabaseClient;
  userId: string;
  nextWeekStart: string;
  todayIso: string;
}): Promise<ReadPrescriptionResult> {
  const { supabase, userId, nextWeekStart, todayIso } = opts;

  const { data: row } = await supabase
    .from("training_weeks")
    .select("session_prescriptions")
    .eq("user_id", userId)
    .eq("week_start", nextWeekStart)
    .maybeSingle();

  const stored = (row?.session_prescriptions as SessionPrescriptions | null) ?? null;
  if (stored && Object.keys(stored).length > 0) {
    return { prescription: stored, source: "row" };
  }

  // Fall-through: compute inline. Mirrors what upsert-week-prescription.ts
  // does — but read-only, no DB write, because the weekly-review composer
  // does not own the training_weeks row write path.
  const { data: blocks } = await supabase
    .from("training_blocks")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();
  const block = (blocks as TrainingBlock | null) ?? null;

  // Need a working TrainingWeek row to drive prescribeWeek. Prefer the
  // existing nextWeekStart row when present (only session_prescriptions
  // empty, the rest may be set); otherwise seed from the prior week.
  let workingRow: TrainingWeek;
  const { data: existingRow } = await supabase
    .from("training_weeks")
    .select("*")
    .eq("user_id", userId)
    .eq("week_start", nextWeekStart)
    .maybeSingle();

  if (existingRow) {
    workingRow = existingRow as TrainingWeek;
  } else {
    const { data: priorRows } = await supabase
      .from("training_weeks")
      .select("*")
      .eq("user_id", userId)
      .lt("week_start", nextWeekStart)
      .order("week_start", { ascending: false })
      .limit(1);
    const prior = (priorRows?.[0] as TrainingWeek | undefined) ?? null;
    workingRow = {
      ...(prior ?? ({} as TrainingWeek)),
      id: "",
      user_id: userId,
      block_id: block?.id ?? null,
      week_start: nextWeekStart,
      session_plan: prior?.session_plan ?? {},
      original_session_plan: null,
      exercise_overrides: null,
      session_prescriptions: null,
      weekly_focus: prior?.weekly_focus ?? null,
      intensity_modifier: prior?.intensity_modifier ?? {},
      rir_target: prior?.rir_target ?? null,
      research_phase: prior?.research_phase ?? null,
      proposed_by: "coach",
      chat_message_id: null,
      endurance_session_plan: prior?.endurance_session_plan ?? null,
      committed_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  }

  const prescription = await prescribeWeek({
    supabase,
    userId,
    block,
    week: workingRow,
    todayIso,
  });

  return { prescription, source: "inline" };
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add lib/coach/weekly-review/read-prescription.ts
git commit -m "$(cat <<'EOF'
weekly-review: add read-prescription seam

Reads training_weeks.session_prescriptions for next_week_start (cron-written),
falls through to prescribeWeek inline when missing. Single source of truth for
the weekly-review's next-week numbers — same engine Carter and the Sunday cron
already use.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Create `rationale-tags.ts` — engine output → BlockPhase tag mapper

**Files:**
- Create: `lib/coach/weekly-review/rationale-tags.ts`

- [ ] **Step 1: Write the rationale-tag deriver**

```typescript
// lib/coach/weekly-review/rationale-tags.ts
//
// Re-derives a v2 PrescriptionRationaleTag from the engine's output shape,
// for narration in the weekly-review payload. Pure function — given the
// block phase, last week's load, and the engine's prescribed load + rep
// targets, it picks the tag that names the rule the engine applied.
//
// Why re-derive in the mapper instead of mutating the engine output: the
// canonical engine emits PlannedExercise[], not annotated decisions. Adding
// a tag field to PrescribedExercise would leak the payload taxonomy into
// the rule layer. The phase + delta is enough to reconstruct the tag
// deterministically.

import type { BlockPhase } from "@/lib/coach/prescription/types";
import type { PrescriptionRationaleTag } from "@/lib/data/types";

export function deriveRationaleTag(opts: {
  blockPhase: BlockPhase;
  prescribedKg: number;
  prescribedReps: number;
  prescribedSets: number;
  lastWeekKg: number | null;
  lastWeekReps: number | null;
  lastWeekSets: number | null;
}): PrescriptionRationaleTag {
  const {
    blockPhase, prescribedKg, prescribedReps, prescribedSets,
    lastWeekKg, lastWeekReps, lastWeekSets,
  } = opts;

  if (blockPhase === "deload_week") return "deload_floor";

  if (blockPhase === "off_pace") return "off_pace_hold";

  if (blockPhase === "consolidation") {
    return "consolidation_hold_progress_reps";
  }

  // pre_target — step or hold
  if (lastWeekKg == null) return "pre_target_step"; // first observation; treat as a step

  // Tolerance: 0.01 kg covers float-rounding noise without masking real holds.
  const kgChanged = Math.abs(prescribedKg - lastWeekKg) > 0.01;
  if (kgChanged) return "pre_target_step";

  // Same kg — but maybe reps/sets bumped (still a meaningful step).
  if (lastWeekReps != null && prescribedReps > lastWeekReps) return "pre_target_step";
  if (lastWeekSets != null && prescribedSets > lastWeekSets) return "pre_target_step";

  return "pre_target_hold";
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add lib/coach/weekly-review/rationale-tags.ts
git commit -m "$(cat <<'EOF'
weekly-review: derive BlockPhase-aligned rationale tags from engine output

Pure mapper from (block_phase, prescribed kg/reps/sets, last week's kg/reps/sets)
to the v2 PrescriptionRationaleTag set. Keeps the rule-tagging concern at the
payload boundary so the canonical engine stays unannotated.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Create `payload-mapper.ts` — SessionPrescriptions → WeeklyReviewPayload.prescription

**Files:**
- Create: `lib/coach/weekly-review/payload-mapper.ts`

- [ ] **Step 1: Write the mapper**

```typescript
// lib/coach/weekly-review/payload-mapper.ts
//
// Converts the canonical SessionPrescriptions shape (per-weekday PlannedExercise[])
// into the WeeklyReviewPayload.prescription shape (per-lift summary array).
//
// Selection rule: for each lift we want to report, pick the first non-warmup
// entry across all weekdays whose name matches the lift's canonical name set.
// "First" by weekday order (Monday → Sunday) — matches how athletes encounter
// the prescription in the week.

import type { SessionPrescriptions, WeeklyReviewPayload } from "@/lib/data/types";
import type { BlockPhase } from "@/lib/coach/prescription/types";
import type { PlannedExercise } from "@/lib/coach/sessionPlans";
import { WEEKDAY_LONG_ORDER } from "@/lib/coach/prescription/upsert-week-prescription";
import { deriveRationaleTag } from "@/lib/coach/weekly-review/rationale-tags";

type LiftRecap = WeeklyReviewPayload["recap"]["per_lift"][number];
type LiftPlan = WeeklyReviewPayload["prescription"]["per_lift"][number];

export function buildPerLiftFromEngine(opts: {
  prescription: SessionPrescriptions;
  perLiftRecap: LiftRecap[];
  blockPhase: BlockPhase;
}): LiftPlan[] {
  const { prescription, perLiftRecap, blockPhase } = opts;
  const out: LiftPlan[] = [];

  for (const recap of perLiftRecap) {
    const engineEntry = findFirstByName(prescription, recap.lift);
    if (!engineEntry) continue; // lift not prescribed next week (rotation gap)

    const prescribedKg = engineEntry.baseKg ?? 0;
    const prescribedReps = engineEntry.baseReps ?? recap.top_set.reps;
    const prescribedSets = engineEntry.sets ?? recap.top_set.sets;
    const lastKg = recap.top_set.weight_kg;

    const tag = deriveRationaleTag({
      blockPhase,
      prescribedKg,
      prescribedReps,
      prescribedSets,
      lastWeekKg: lastKg,
      lastWeekReps: recap.top_set.reps,
      lastWeekSets: recap.top_set.sets,
    });

    out.push({
      lift: recap.lift,
      sets: prescribedSets,
      reps: prescribedReps,
      weight_kg: prescribedKg,
      delta_pct_from_last_week: lastKg > 0 ? (prescribedKg - lastKg) / lastKg : null,
      pr_rebase_applied: isNewPR(recap),
      rationale_tag: tag,
    });
  }

  return out;
}

function findFirstByName(
  prescription: SessionPrescriptions,
  liftName: string,
): PlannedExercise | null {
  for (const weekday of WEEKDAY_LONG_ORDER) {
    const exercises = prescription[weekday];
    if (!exercises) continue;
    const match = exercises.find(
      (e) => !e.warmup && e.name.toLowerCase() === liftName.toLowerCase(),
    );
    if (match) return match;
  }
  return null;
}

function isNewPR(recap: LiftRecap): boolean {
  if (recap.e1rm_kg == null || recap.e1rm_history_3wk.length === 0) return false;
  const prior = recap.e1rm_history_3wk.slice(0, -1);
  if (prior.length === 0) return false;
  return recap.e1rm_kg > Math.max(...prior);
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add lib/coach/weekly-review/payload-mapper.ts
git commit -m "$(cat <<'EOF'
weekly-review: SessionPrescriptions → per_lift payload mapper

Walks Monday→Sunday of the engine's SessionPrescriptions output, picks the
first non-warmup entry whose name matches each recap lift, and emits the
LiftPlan summary the WeeklyReviewPayload expects. delta_pct + pr_rebase
preserved; rationale_tag derived from BlockPhase.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Create `compute-on-pace.ts`

**Files:**
- Create: `lib/coach/weekly-review/compute-on-pace.ts`

- [ ] **Step 1: Write the on-pace evaluator**

```typescript
// lib/coach/weekly-review/compute-on-pace.ts
//
// Replaces the TODO(v2) stub in index.ts:202-211 that returned null. Reads
// training_blocks.target_value + target_metric + target_hit_at_week, plus
// the athlete's recent working sets, and computes whether the block is on
// pace to hit target by the final week.
//
// Reuses lib/coach/prescription/block-phase-rule.ts:evaluateBlockPhase so
// the on_pace verdict and Carter's framework_state block are derived from
// the same code path. Mapping:
//   pre_target / consolidation / deload_week → on_pace = true
//   off_pace                                 → on_pace = false

import type { SupabaseClient } from "@supabase/supabase-js";
import type { TrainingBlock } from "@/lib/data/types";
import type { WorkoutSetSample } from "@/lib/coach/prescription/types";
import { evaluateBlockPhase } from "@/lib/coach/prescription/block-phase-rule";
import {
  currentComparisonValueForLift,
  PRIMARY_LIFT_NAME_PATTERNS,
} from "@/lib/coach/prescription/current-comparison-value";
import { bestComparisonValue } from "@/lib/coach/e1rm";

export async function computeOnPace(opts: {
  supabase: SupabaseClient;
  userId: string;
  block: TrainingBlock | null;
  todayIso: string;
}): Promise<boolean | null> {
  const { supabase, userId, block, todayIso } = opts;
  if (!block || block.primary_lift == null || block.target_value == null) {
    return null;
  }

  // Recent working sets for the primary lift — last 28 days is plenty for
  // both the current comparison value and the progression-rate slope.
  const sinceIso = subtractDaysIso(todayIso, 28);
  const patterns = PRIMARY_LIFT_NAME_PATTERNS[block.primary_lift];
  const { data: setsRaw } = await supabase
    .from("exercise_sets")
    .select("kg, reps, warmup, exercise:exercises!inner(name, workout:workouts!inner(user_id, performed_at))")
    .gte("exercise.workout.performed_at", sinceIso)
    .eq("exercise.workout.user_id", userId);

  const sets: WorkoutSetSample[] = (setsRaw ?? [])
    .map((r: unknown) => {
      const row = r as { kg: number | null; reps: number | null; warmup: boolean | null; exercise: { name: string; workout: { performed_at: string } } };
      return {
        name: row.exercise.name,
        kg: row.kg,
        reps: row.reps,
        warmup: row.warmup ?? false,
        performed_at: row.exercise.workout.performed_at,
      };
    })
    .filter((s) => patterns.some((p) => s.name.toLowerCase() === p.toLowerCase()));

  const currentWorkingKg = currentComparisonValueForLift({
    lift: block.primary_lift,
    sets,
    targetMetric: block.target_metric,
  });

  const rate = estimateProgressionRatePerWeek(sets, block.target_metric);

  const phase = evaluateBlockPhase({
    block,
    currentWorkingKg,
    recentProgressionRatePerWeek: rate,
    todayIso,
  });

  return phase !== "off_pace";
}

function estimateProgressionRatePerWeek(
  sets: WorkoutSetSample[],
  targetMetric: TrainingBlock["target_metric"],
): number | null {
  if (sets.length === 0 || targetMetric == null) return null;
  // Group by week-of-year. Per-week max comparison value. Simple OLS slope.
  const byWeek = new Map<string, WorkoutSetSample[]>();
  for (const s of sets) {
    if (!s.performed_at) continue;
    const wk = isoWeekKey(s.performed_at);
    const arr = byWeek.get(wk) ?? [];
    arr.push(s);
    byWeek.set(wk, arr);
  }
  const points: Array<{ x: number; y: number }> = [];
  let i = 0;
  for (const [, wkSets] of [...byWeek.entries()].sort()) {
    const v = bestComparisonValue(wkSets, targetMetric ?? "working_weight");
    if (v != null) points.push({ x: i, y: v });
    i++;
  }
  if (points.length < 2) return null;
  const meanX = points.reduce((a, p) => a + p.x, 0) / points.length;
  const meanY = points.reduce((a, p) => a + p.y, 0) / points.length;
  let num = 0; let den = 0;
  for (const p of points) {
    num += (p.x - meanX) * (p.y - meanY);
    den += (p.x - meanX) ** 2;
  }
  return den > 0 ? num / den : null;
}

function isoWeekKey(iso: string): string {
  const d = new Date(iso);
  const yr = d.getUTCFullYear();
  const start = new Date(Date.UTC(yr, 0, 1));
  const wk = Math.floor((d.getTime() - start.getTime()) / (7 * 86_400_000));
  return `${yr}-${String(wk).padStart(2, "0")}`;
}

function subtractDaysIso(iso: string, days: number): string {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
```

- [ ] **Step 2: Verify the join syntax against existing code**

```bash
grep -rn "exercise:exercises!inner.*workout:workouts!inner" lib app 2>&1 | head -3
```

Expected: at least one match (the embedded join is used in other queries). If zero matches, fall back to two-step query: fetch workouts in window for user, then fetch sets keyed on those workout IDs.

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add lib/coach/weekly-review/compute-on-pace.ts
git commit -m "$(cat <<'EOF'
weekly-review: implement computeOnPace via evaluateBlockPhase

Replaces the v1 hardcoded null. Reads recent primary-lift sets, computes
the current comparison value (Brzycki e1RM or raw kg depending on
target_metric), estimates the per-week progression rate, and reuses the
canonical evaluateBlockPhase rule. on_pace = (phase !== off_pace).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Rewrite `lib/coach/weekly-review/index.ts` to wire the new modules

**Files:**
- Modify: `lib/coach/weekly-review/index.ts` (full rewrite of the composePrescription call site + header phase derivation + on-pace)

- [ ] **Step 1: Read the current file to preserve unrelated wiring**

```bash
wc -l lib/coach/weekly-review/index.ts && cat lib/coach/weekly-review/index.ts
```

Note: `composeRecap` / `composeTrends` / `composeVolume` / `composeTargets` / `composeReconfirm` calls and the `priorReview` fetch all stay. Only the prescription wiring, header phase, and on-pace change.

- [ ] **Step 2: Replace imports**

Edit the import block at the top of `lib/coach/weekly-review/index.ts`. Remove these imports:

```typescript
import { composePrescription } from "./compose-prescription";
import { weeklyPhaseFor, nextWeeklyPhaseFor } from "./phase-mapping";
```

Add these:

```typescript
import { readNextWeekPrescription } from "./read-prescription";
import { buildPerLiftFromEngine } from "./payload-mapper";
import { computeOnPace } from "./compute-on-pace";
import { evaluateBlockPhase } from "@/lib/coach/prescription/block-phase-rule";
import { currentComparisonValueForLift } from "@/lib/coach/prescription/current-comparison-value";
import type { BlockPhase, WorkoutSetSample } from "@/lib/coach/prescription/types";
import type { TrainingBlock } from "@/lib/data/types";
```

- [ ] **Step 3: Replace the phase-derivation block (replaces lines ~63-73)**

Replace this:

```typescript
  const researchPhase: ResearchPhase = (trainingWeek?.research_phase as ResearchPhase | null) ?? "accumulate";
  const weeklyPhaseCurrent = weeklyPhaseFor(weekN, totalWeeks, researchPhase);
  const weeklyPhaseNext = nextWeeklyPhaseFor(weekN, totalWeeks, researchPhase);
```

With this:

```typescript
  // Block phase NOW and NEXT — driven by the canonical evaluateBlockPhase rule
  // that Carter and the Sunday cron use. todayIso for "now"; +7 for "next".
  const blockTyped = block as unknown as TrainingBlock | null;
  const blockPhaseNow: BlockPhase = await deriveBlockPhase({
    supabase, userId, block: blockTyped, todayIso: weekStart,
  });
  const blockPhaseNext: BlockPhase = await deriveBlockPhase({
    supabase, userId, block: blockTyped, todayIso: shiftDays(weekStart, 7),
  });
```

Then add this helper after the `generateWeeklyReview` function body (above `shiftDays`):

```typescript
async function deriveBlockPhase(opts: {
  supabase: SupabaseClient;
  userId: string;
  block: TrainingBlock | null;
  todayIso: string;
}): Promise<BlockPhase> {
  const { supabase, userId, block, todayIso } = opts;
  if (!block || block.primary_lift == null) return "pre_target";

  // Recent sets for the focus lift to derive currentWorkingKg + slope.
  // Mirror compute-on-pace.ts so the two stay in lockstep.
  const sinceIso = (() => {
    const d = new Date(todayIso + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() - 28);
    return d.toISOString().slice(0, 10);
  })();

  const { data: setsRaw } = await supabase
    .from("exercise_sets")
    .select("kg, reps, warmup, exercise:exercises!inner(name, workout:workouts!inner(user_id, performed_at))")
    .gte("exercise.workout.performed_at", sinceIso)
    .eq("exercise.workout.user_id", userId);

  const sets: WorkoutSetSample[] = (setsRaw ?? []).map((r: unknown) => {
    const row = r as { kg: number | null; reps: number | null; warmup: boolean | null; exercise: { name: string; workout: { performed_at: string } } };
    return {
      name: row.exercise.name,
      kg: row.kg,
      reps: row.reps,
      warmup: row.warmup ?? false,
      performed_at: row.exercise.workout.performed_at,
    };
  });

  const currentWorkingKg = currentComparisonValueForLift({
    lift: block.primary_lift,
    sets,
    targetMetric: block.target_metric,
  });

  return evaluateBlockPhase({
    block,
    currentWorkingKg,
    recentProgressionRatePerWeek: null, // null is conservative: defers off_pace verdict unless target_hit_at_week or deload_week wins
    todayIso,
  });
}
```

- [ ] **Step 4: Replace the prescription composer call (replaces the `composePrescription` await block)**

Replace:

```typescript
  const prescription = await composePrescription({
    supabase,
    userId,
    nextWeekStart: shiftDays(weekStart, 7),
    weeklyPhaseCurrent,
    weeklyPhaseNext,
    rirTargetCurrent: trainingWeek?.rir_target ?? null,
    rirTargetNext: rirForPhase(weeklyPhaseNext),
    perLiftRecap: recap.per_lift,
    bodyWeightLossPctPerWk: deriveLossPct(...),
    sleepAvg7d: recap.sleep.avg_h,
    hrvFlag: false,
    isFirstWeekOfBlock: weekN === 1,
    intakeStartingLoads: null,
    weeklyFocus: trainingWeek?.weekly_focus ?? null,
  });
```

With:

```typescript
  const nextWeekStart = shiftDays(weekStart, 7);
  const { prescription: engineRx, source: rxSource } = await readNextWeekPrescription({
    supabase,
    userId,
    nextWeekStart,
    todayIso: nextWeekStart,
  });
  const perLift = buildPerLiftFromEngine({
    prescription: engineRx,
    perLiftRecap: recap.per_lift,
    blockPhase: blockPhaseNext,
  });
  // Diagnostic: surface inline-fallback in logs so cron misses are visible.
  if (rxSource === "inline") {
    console.warn("[weekly-review] read fell through to inline prescribeWeek", {
      userId, nextWeekStart,
    });
  }
  // Read the upcoming week's session_plan from the row the engine just
  // read/wrote, so the review's plan view matches what the logger sees.
  const { data: upcomingWeek } = await supabase
    .from("training_weeks")
    .select("session_plan, weekly_focus, rir_target")
    .eq("user_id", userId)
    .eq("week_start", nextWeekStart)
    .maybeSingle();

  const prescription = {
    next_week_start: nextWeekStart,
    phase: blockPhaseNext,
    rir_target: upcomingWeek?.rir_target ?? trainingWeek?.rir_target ?? null,
    session_plan: (upcomingWeek?.session_plan as Record<string, string> | null) ??
                  (trainingWeek?.session_plan as Record<string, string> | null) ?? {},
    weekly_focus: upcomingWeek?.weekly_focus ?? trainingWeek?.weekly_focus ?? null,
    per_lift: perLift,
  };
```

- [ ] **Step 5: Replace `computeOnPace` stub call**

Replace `const onPace = computeOnPace(block, recap);` with:

```typescript
  const onPace = await computeOnPace({
    supabase,
    userId,
    block: block as unknown as TrainingBlock | null,
    todayIso: weekStart,
  });
```

- [ ] **Step 6: Update payload assembly**

Set `schema_version: 2` in the returned payload, and use the new BlockPhase values:

```typescript
  const payload: WeeklyReviewPayload = {
    schema_version: 2,
    header: {
      week_n: weekN,
      total_weeks: totalWeeks,
      block_goal_text: block.goal_text,
      block_phase_now: blockPhaseNow,
      block_phase_next: blockPhaseNext,
      on_pace: onPace,
      weeks_remaining: Math.max(0, totalWeeks - weekN),
      late,
    },
    recap,
    reconfirm,
    trends,
    prescription,
    volume,
    targets,
  };
```

- [ ] **Step 7: Delete the now-unused local `computeOnPace` stub and `rirForPhase` helper**

Remove these from the bottom of the file (they're replaced by the new module):

```typescript
function rirForPhase(phase: "mev" | "mav" | "mrv" | "deload"): number | null { ... }
function computeOnPace(block: { goal_text: string }, _recap: WeeklyReviewPayload["recap"]): boolean | null { ... }
```

The `deriveLossPct` helper is no longer used by this file — confirm via `grep -n "deriveLossPct" lib/coach/weekly-review/index.ts` and remove if zero in-file references remain.

- [ ] **Step 8: Typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add lib/coach/weekly-review/index.ts
git commit -m "$(cat <<'EOF'
weekly-review: wire orchestrator to canonical engine

Replaces the bespoke composePrescription path with the new read-prescription
+ payload-mapper + compute-on-pace seams. Header phase derives via
evaluateBlockPhase so block_phase_now/next match what Carter and the Sunday
cron see. schema_version bumped to 2; v1 historical rows untouched.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Rewrite `narrative-prompt.ts` to enforce engine narration

**Files:**
- Modify: `lib/coach/weekly-review/narrative-prompt.ts` (the SYSTEM_PROMPT constant)

- [ ] **Step 1: Replace the SYSTEM_PROMPT block**

Replace the existing `SYSTEM_PROMPT` constant with:

```typescript
const SYSTEM_PROMPT = `You are an experienced strength coach reviewing a client's week. Voice: direct, concise, second person ("you"). Length: 120-180 words, single paragraph, no markdown headings.

TEACHING:
${jargonRuleForPrompt()}
- Prefer everyday language. Avoid textbook tone.

ENGINE-OWNED PRESCRIPTION:
The payload's prescription block is the deterministic output of the canonical block-phase engine — the same engine Carter quotes in chat and the Sunday cron writes to training_weeks.session_prescriptions. Your job is to narrate the engine's verdict, NEVER author your own progression.

- payload.header.block_phase_now / block_phase_next ∈ { pre_target, consolidation, off_pace, deload_week }. Name the phase the athlete is in and what it means in one line. Do NOT cite MEV/MAV/MRV — those belong to the v1 (historical) payload only.
- payload.header.on_pace is true / false / null. When true, say so plainly. When false, the engine has already classified the block as off-pace; surface it as the headline, not buried.
- payload.prescription.per_lift[].rationale_tag explains why each lift moved the way it did:
    pre_target_step                   — clean RIR last week → +step
    pre_target_hold                   — RIR missed → hold
    consolidation_hold_progress_reps  — target hit; volume drives now
    off_pace_hold                     — off-pace verdict; hold load
    deload_floor                      — deload week; 0.80× load
  Cite the tag's meaning, NEVER quote the snake_case string.

TRENDS DEEP CONTEXT (sub-project #5 — optional fields):
- payload.trends.per_lift_slope[] may be present — each entry has a 4w slope in pct/wk and an R² confidence value. When referring to a specific lift's trajectory, cite its slope_pct_per_wk_4w if available.
- payload.trends.plateau_spans[] flags lifts plateaued ≥ 3 weeks.
- payload.trends.cross_insights[] holds short English sentences describing nutrition × weight and volume × recovery correlations. When the prose touches body composition or recovery, you may reference these insights verbatim or paraphrase them.
- payload.trends.nutrition.top_items[] (optional) lists the week's most-used foods by frequency × kcal (name, frequency, total_kcal). When the prose touches nutrition patterns, you may reference these items by name (e.g. "your chicken-and-rice lunches stayed the anchor"). Numbers from this array are allowed in the narrative.
- All fields are OPTIONAL — when undefined, omit any reference to per-lift slope, correlation insights, or top items.

RULES:
1. Every numeric token you emit must appear in the payload EXACTLY as a value (or as that value rounded to 0, 1, or 2 decimals). Do NOT compute derived numbers — no differences, sums, ratios, or per-day extrapolations. If the payload doesn't carry a number, do not cite it.
2. When a numeric ratio is stored as a decimal (e.g. slope_pct_per_wk_4w: 0.07), you may cite it as "7%" — that conversion is allowed. Always round the percentage to an integer.
3. Lead with the most important per-lift change and the rationale_tag meaning.
4. Acknowledge reconfirm questions if any (but do not answer them — they're for the athlete).
5. Close with a single concrete cue for the upcoming week.
6. No bullet lists, no headers — flowing prose.
7. NEVER author a load not in payload.prescription.per_lift[].weight_kg. NEVER round to a "smoother" number. The engine's number is the contract.

The rationale_tag suffixes "_increment_floor" and "_increment_capped" mean the lift held because the smallest physical jump is bigger than the rule's target — explain this naturally without using the suffix term.`;
```

- [ ] **Step 2: Verify `validateNoFabricatedNumbers` still passes BlockPhase strings**

The validator walks all string fields and pulls out numeric substrings. Phase strings like `"pre_target"` contain no digits, so they don't poison the allow-list. Confirm with:

```bash
grep -n "validateNoFabricatedNumbers\|addNumber\|allowed.has" lib/coach/weekly-review/narrative-prompt.ts | head -5
```

No code change needed for the validator — the existing string-walking branch already handles arbitrary strings.

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add lib/coach/weekly-review/narrative-prompt.ts
git commit -m "$(cat <<'EOF'
weekly-review: teach narrator to cite engine output, not invent

Adds the ENGINE-OWNED PRESCRIPTION block to the narrative system prompt with
the same discipline the PLAN_WEEK_PROMPT enforces for Carter: never author a
load not in the payload, never quote raw rationale_tag strings, lead with the
phase verdict. Mirrors Carter's "the engine prescribes X — that's what the
rule says" pattern.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Update `WeeklyReviewPrescription.tsx` for new rationale tags

**Files:**
- Modify: `components/coach/WeeklyReviewPrescription.tsx:17-54` (the `getRationaleTagSpeaker` function)

- [ ] **Step 1: Extend the speaker-mapping to cover v2 tags**

Replace the existing `getRationaleTagSpeaker` body so it routes the new BlockPhase tags. Carter owns the lift-level execution tags; Peter owns block transitions:

```typescript
function getRationaleTagSpeaker(tag: PrescriptionRationaleTag): Speaker {
  const cleanTag = tag.replace(/_increment_floor|_increment_capped$/, "");

  // Carter: lifting mechanics, rep completions, RIR issues, MEV/MAV/MRV
  // progression (v1) AND the BlockPhase execution tags (v2).
  if (
    cleanTag === "cutting_hold" ||
    cleanTag === "recovery_hold" ||
    cleanTag === "rep_completion_miss" ||
    cleanTag === "rir_missed_twice" ||
    cleanTag === "rir_missed" ||
    cleanTag === "form_hold" ||
    cleanTag === "mev_to_mav_clearance" ||
    cleanTag === "mav_to_mav_step" ||
    cleanTag === "mav_to_mrv_advance" ||
    cleanTag === "mrv_volume_drive" ||
    cleanTag === "plateau_rep_shift" ||
    cleanTag === "pre_target_step" ||
    cleanTag === "pre_target_hold" ||
    cleanTag === "off_pace_hold"
  ) {
    return "carter";
  }

  // Peter: block structure, periodization, major phase transitions.
  if (
    cleanTag === "block_start_baseline" ||
    cleanTag === "plateau_deload_reset" ||
    cleanTag === "deload_load_volume_cut" ||
    cleanTag === "consolidation_hold_progress_reps" ||  // block-level "we hit target" verdict
    cleanTag === "deload_floor"                          // block-level "week 5" verdict
  ) {
    return "peter";
  }

  return "peter";
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add components/coach/WeeklyReviewPrescription.tsx
git commit -m "$(cat <<'EOF'
ui: weekly-review prescription routes v2 rationale tags to right speaker

Adds the five BlockPhase-aligned rationale tags to getRationaleTagSpeaker.
Carter takes within-week execution (pre_target_step/hold, off_pace_hold);
Peter takes block-level verdicts (consolidation_hold_progress_reps,
deload_floor).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Update `WeeklyReviewHeader.tsx` and `WeeklyReviewCard.tsx` — no code change but verify

**Files:**
- Read-only: `components/coach/WeeklyReviewHeader.tsx`
- Read-only: `components/chat/WeeklyReviewCard.tsx`

- [ ] **Step 1: Verify the type widening already covers these consumers**

```bash
grep -n "termKey={header.block_phase\|termKey={ui.block_phase" components/coach/WeeklyReviewHeader.tsx components/chat/WeeklyReviewCard.tsx
```

Both pass `header.block_phase_now`/`next` directly to `JargonPill termKey`. With the widened `WeeklyPhase` union (Task 1) and the glossary entries (Task 2), the v2 BlockPhase strings now have JargonPill entries. No code change needed.

- [ ] **Step 2: Sanity-render a v2 payload locally (manual)**

```bash
npm run dev
```

In a second terminal, hit `/coach/weeks/<this Sunday's date>` after the Sunday cron has run (or after Task 14's audit shows a v2 row exists). Confirm: header shows "PRE_TARGET" or "CONSOLIDATION" pill instead of "MEV"; prescription table shows the v2 rationale tag with a coloured speaker chip.

- [ ] **Step 3: Typecheck (sanity)**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: No commit** (no code change — this task is verification only)

---

### Task 11: Shim morning-brief consumers for the widened taxonomy

**Files:**
- Modify: `lib/morning/brief/flags.ts:113-114` (phase-transition detection)
- Modify: `lib/morning/brief/assembler.ts:519-526` (prescription-block readback)

- [ ] **Step 1: Verify current readers**

```bash
grep -n "block_phase_now\|block_phase_next\|payload.prescription" lib/morning/brief/flags.ts lib/morning/brief/assembler.ts
```

- [ ] **Step 2: Confirm the phase-transition comparison still works**

The existing code at `flags.ts:113`:

```typescript
inputs.thisWeekCommittedReview.payload.header.block_phase_now !==
  inputs.previousCommittedReview.payload.header.block_phase_now
```

This `!==` string comparison is unaffected by the widening — it correctly fires when v1's "mav" → v2's "consolidation" cross a schema boundary. That's a desirable signal (taxonomy migration IS a phase transition).

If you want to avoid spurious cross-schema fires (the v1 → v2 first-write triggers the flag once), add a discriminator guard:

```typescript
const thisV = inputs.thisWeekCommittedReview.payload.schema_version;
const prevV = inputs.previousCommittedReview.payload.schema_version;
const sameSchema = thisV === prevV;
const phaseChanged =
  sameSchema &&
  inputs.thisWeekCommittedReview.payload.header.block_phase_now !==
    inputs.previousCommittedReview.payload.header.block_phase_now;
```

Apply this edit if the false-positive matters; otherwise leave as-is (the noise is one-shot per user at migration time).

**Recommended:** apply the guard. It's three lines and removes a one-time spurious nudge for every user.

- [ ] **Step 3: Verify assembler.ts:519-526 doesn't break on v2**

```bash
sed -n '510,535p' lib/morning/brief/assembler.ts
```

The code at line 519 reads `review.payload.prescription` and at 526 reads `header.block_phase_now`. Both are string fields in v2; no code change needed if the downstream consumers (brief renderer) display them verbatim. Confirm with:

```bash
grep -n "phase_now\b" lib/morning/brief/assembler.ts
```

If the value flows into a glossary tooltip elsewhere, the Task 2 glossary entries cover both taxonomies — no shim needed.

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/morning/brief/flags.ts
git commit -m "$(cat <<'EOF'
brief: guard phase-transition flag with schema_version discriminator

Avoid a one-shot spurious "phase changed" fire when a user's prior weekly
review row is v1 (mev/mav/mrv) and the current is v2 (BlockPhase). Cross-
schema comparisons return "same schema = no transition signal".

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: Wire `app/api/coach/weekly-review/sync/route.ts` response echo to new payload

**Files:**
- Modify: `app/api/coach/weekly-review/sync/route.ts:122-126` (the response echo block)

- [ ] **Step 1: Read the echo block**

```bash
sed -n '110,140p' app/api/coach/weekly-review/sync/route.ts
```

- [ ] **Step 2: Verify type signatures still match**

The echo reads `result.payload.header.block_phase_now` (typed as `WeeklyPhase`, now widened) and `result.payload.prescription.per_lift[i].weight_kg / reps / sets`. Both shapes unchanged at the field level — only the allowed string values widened. No code change should be needed in the echo itself. Confirm:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Verify the summary string at line 172**

```bash
grep -n "block_phase_next.toUpperCase" app/api/coach/weekly-review/sync/route.ts
```

The summary string renders `block_phase_next.toUpperCase()` which on v2 yields "CONSOLIDATION" / "PRE_TARGET" / etc. — strictly an improvement over the v1 "MEV" / "MAV". No change needed.

- [ ] **Step 4: No commit** (verification only — types widened in Task 1 carry the route through)

---

### Task 13: Delete `compose-prescription.ts` and `phase-mapping.ts`

**Files:**
- Delete: `lib/coach/weekly-review/compose-prescription.ts`
- Delete: `lib/coach/weekly-review/phase-mapping.ts`

- [ ] **Step 1: Confirm zero importers remain**

```bash
grep -rn "from \"./compose-prescription\"\|from \"./phase-mapping\"\|from \"@/lib/coach/weekly-review/compose-prescription\"\|from \"@/lib/coach/weekly-review/phase-mapping\"" lib app components scripts 2>&1
```

Expected: zero matches. If any match remains, fix that consumer before proceeding.

- [ ] **Step 2: Delete the two files**

```bash
git rm lib/coach/weekly-review/compose-prescription.ts lib/coach/weekly-review/phase-mapping.ts
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -u lib/coach/weekly-review/
git commit -m "$(cat <<'EOF'
weekly-review: delete bespoke prescription engine + phase-mapping

425 + 30 lines removed. The canonical lib/coach/prescription/prescribe-week.ts
engine is now the sole owner of next-week loads, and the weekly review reads
the freshly-cron-written training_weeks.session_prescriptions row via
read-prescription.ts. One engine, one source of truth.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: Write the bytes-equal audit script

**Files:**
- Create: `scripts/audit-weekly-review-vs-engine.mjs`

- [ ] **Step 1: Write the audit script**

```javascript
// scripts/audit-weekly-review-vs-engine.mjs
//
// Verifies the property "weekly_reviews.payload.prescription.per_lift values
// equal the training_weeks.session_prescriptions row for the same
// next_week_start". This is the property the engine collapse establishes —
// if it ever fails again, someone reintroduced a parallel rule path.
//
// Usage:
//   AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs \
//     --experimental-strip-types --env-file=.env.local \
//     scripts/audit-weekly-review-vs-engine.mjs
//
// Exits 0 on success, 1 on any divergence. Read-only.

import { createClient } from "@supabase/supabase-js";

const userId = process.env.AUDIT_USER_ID;
if (!userId) {
  console.error("AUDIT_USER_ID env var required");
  process.exit(1);
}

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

// Pull the last 4 committed weekly reviews.
const { data: reviews, error: revErr } = await sb
  .from("weekly_reviews")
  .select("week_start, version, status, payload")
  .eq("user_id", userId)
  .eq("status", "committed")
  .order("week_start", { ascending: false })
  .limit(4);
if (revErr) { console.error("review fetch failed:", revErr); process.exit(1); }

let failed = 0;
for (const r of reviews ?? []) {
  const payload = r.payload;
  if (payload.schema_version !== 2) {
    console.log(`week_start=${r.week_start} v=${payload.schema_version} — skipping v1 historical row`);
    continue;
  }

  const nextWeekStart = payload.prescription.next_week_start;
  const { data: tw } = await sb
    .from("training_weeks")
    .select("session_prescriptions")
    .eq("user_id", userId)
    .eq("week_start", nextWeekStart)
    .maybeSingle();
  const stored = tw?.session_prescriptions ?? null;

  if (!stored) {
    console.warn(`week_start=${r.week_start} → next=${nextWeekStart}: NO training_weeks row (inline fallback was used)`);
    continue;
  }

  // Compare per_lift weights against the engine's emitted entries.
  for (const lp of payload.prescription.per_lift) {
    const engineEntry = findFirstByName(stored, lp.lift);
    if (!engineEntry) {
      console.error(`✗ ${nextWeekStart} ${lp.lift}: payload has prescription but engine row does not`);
      failed++;
      continue;
    }
    const engineKg = engineEntry.baseKg ?? 0;
    if (Math.abs(engineKg - lp.weight_kg) > 0.01) {
      console.error(`✗ ${nextWeekStart} ${lp.lift}: payload=${lp.weight_kg} engine=${engineKg}`);
      failed++;
    } else {
      console.log(`✓ ${nextWeekStart} ${lp.lift}: ${lp.weight_kg} kg`);
    }
  }
}

if (failed > 0) {
  console.error(`\n${failed} divergences`);
  process.exit(1);
}
console.log("\naudit passed");

function findFirstByName(prescription, liftName) {
  const order = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  for (const wd of order) {
    const list = prescription[wd];
    if (!list) continue;
    const m = list.find((e) => !e.warmup && e.name.toLowerCase() === liftName.toLowerCase());
    if (m) return m;
  }
  return null;
}
```

- [ ] **Step 2: Smoke-test the audit script**

```bash
AUDIT_USER_ID=<your user uuid> node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-weekly-review-vs-engine.mjs
```

Expected output: one of:
- All committed reviews are v1 → "skipping v1 historical row" for each (acceptable — no v2 row exists yet because the new cron hasn't fired)
- Some are v2 → ✓ lines per lift, "audit passed" tail, exit 0
- Any ✗ → fix the underlying mapper bug before the deploy

- [ ] **Step 3: Commit**

```bash
git add scripts/audit-weekly-review-vs-engine.mjs
git commit -m "$(cat <<'EOF'
audit: weekly-review vs engine bytes-equal property check

Asserts payload.prescription.per_lift[i].weight_kg equals the
training_weeks.session_prescriptions row's first matching baseKg for the
same next_week_start. v1 (historical) rows skipped via schema_version
discriminator. Read-only; exits 1 on any divergence.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 15: Document the audit + dev-fixture path in CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` (the `## Scripts` section)

- [ ] **Step 1: Add the audit-script entry to `## Scripts`**

After the existing `audit-block-outcomes-rules.mjs` entry, insert:

```markdown
- [scripts/audit-weekly-review-vs-engine.mjs](scripts/audit-weekly-review-vs-engine.mjs) — verifies committed v2 `weekly_reviews` rows' `prescription.per_lift` weights bytes-equal the `training_weeks.session_prescriptions` row for the same `next_week_start`. Skips v1 historical rows. Catches any reintroduction of a parallel prescription rule path. Set `AUDIT_USER_ID` env var. Run via: `AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-weekly-review-vs-engine.mjs`.
```

- [ ] **Step 2: Add an architecture note to `### Coach / AI`**

In the `Weekly Review Document` bullet, append the engine-collapse note:

```markdown
- **Engine collapse (2026-06-06):** the weekly review's bespoke `compose-prescription.ts` was deleted in favour of reading the just-cron-written `training_weeks.session_prescriptions` row via [lib/coach/weekly-review/read-prescription.ts](lib/coach/weekly-review/read-prescription.ts). Same engine as Carter + Sunday cron, same numbers, one source of truth. Header phase taxonomy migrated from `WeeklyPhase` (mev/mav/mrv/deload) to canonical `BlockPhase` (pre_target/consolidation/off_pace/deload_week); `WeeklyReviewPayload.schema_version` bumped to 2. Historical v1 rows render unchanged via UI back-compat. `computeOnPace` now reads `training_blocks.target_value`/`target_metric`/`target_hit_at_week` via `evaluateBlockPhase`. Audit script: [scripts/audit-weekly-review-vs-engine.mjs](scripts/audit-weekly-review-vs-engine.mjs).
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
docs: record weekly-review engine collapse in CLAUDE.md

Adds the audit-script reference + the architecture note explaining the one-
engine invariant the collapse establishes.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 16: End-to-end manual verification

**Files:** None — local exercise.

- [ ] **Step 1: Confirm Sunday cron + weekly review fire in order locally**

```bash
# Wake the Sunday cron route with the CRON_SECRET to populate training_weeks.session_prescriptions
curl -X GET "http://localhost:3000/api/coach/sunday-prescriptions/sync" \
  -H "Authorization: Bearer $CRON_SECRET"
```

Then:

```bash
# Wake the weekly-review cron — should hit the just-written row, source: "row"
curl -X GET "http://localhost:3000/api/coach/weekly-review/sync" \
  -H "Authorization: Bearer $CRON_SECRET"
```

Expected: both return 200 with JSON; weekly-review response includes the v2 phase strings.

- [ ] **Step 2: Open `/coach/weeks/<this Sunday's date>` in browser**

Verify:
- Header pill shows e.g. "PRE_TARGET → PRE_TARGET" with hover tooltips (JargonPill entries from Task 2)
- Prescription table per-lift rows render the engine's `baseKg`
- "WHY" column shows the BlockPhase-aligned tag with the matching speaker chip
- Narrative paragraph cites the phase by name and doesn't invent numbers

- [ ] **Step 3: Run the audit script**

```bash
AUDIT_USER_ID=<your uuid> node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-weekly-review-vs-engine.mjs
```

Expected: at least one v2 row, all ✓, "audit passed", exit 0.

- [ ] **Step 4: Spot-check Carter's chat**

In `/coach` chat (Carter speaker), ask: "what's my squat this week?" Confirm the number Carter quotes equals the number on the weekly review's NEXT WEEK PRESCRIPTION row.

- [ ] **Step 5: No commit** (verification only)

---

## Self-Review

**Spec coverage:**
- ✅ Replace bespoke composer with engine reader — Tasks 3, 5, 7, 13
- ✅ Replace WeeklyPhase taxonomy with BlockPhase — Tasks 1, 7
- ✅ Implement computeOnPace — Task 6, 7
- ✅ Narrative discipline — Task 8
- ✅ UI shimming for v1 + v2 — Tasks 9, 10
- ✅ Glossary entries — Task 2
- ✅ Morning brief shims — Task 11
- ✅ Audit script — Task 14
- ✅ Documentation — Task 15
- ✅ End-to-end verify — Task 16

**Placeholder scan:** no TBD/TODO/fill-in-later left. Every step has the code that goes there.

**Type consistency:**
- `BlockPhase` is re-exported from `lib/data/types.ts` (Task 1) so all consumers can import from one place
- `PrescriptionRationaleTag` union widening (Task 1) is the source of truth used by mapper (Task 5) and UI (Task 9)
- `WeeklyPhase` widening (Task 1) covers header + prescription.phase fields in the same payload type
- `findFirstByName` signature is identical in payload-mapper.ts (Task 5) and audit script (Task 14) — both walk `WEEKDAY_LONG_ORDER`, both match case-insensitively

**Risk notes:**
- The `consolidation_hold_progress_reps` tag goes to Peter, not Carter — block-level "we hit target" is the head-coach's lane. If you disagree, flip in Task 9 before commit.
- The inline-fallback path in `read-prescription.ts` (Task 3) means a cron miss doesn't break the weekly review; it just runs `prescribeWeek` on-the-fly with the same inputs. The audit script (Task 14) treats "no training_weeks row" as a warning, not a failure, so this stays observable without blocking.
- Historical v1 rows are not migrated. They render correctly via the widened types + glossary, but anyone diffing v1 vs v2 will see different rule sets. That's intentional — we're not rewriting history.

---

**Plan complete. Saved to `docs/superpowers/plans/2026-06-06-weekly-review-engine-collapse.md`.**
