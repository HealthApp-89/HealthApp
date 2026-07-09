# Effort-Aware Engine + Mid-Week Feed-Forward Repatch — Design

**Date:** 2026-07-09
**Status:** Approved
**Arc:** Adaptive-loop tightening, sub-project 1 of 2 (sub-project 2 — morning-intake prescription patches — hooks into the primitive built here)

## Problem

Two gaps between what the app promises (adaptive prescriptions) and what the code does:

1. **The prescription engine never reads per-set RIR.** Migration 0045 added `exercise_sets.rir`, the logger captures it, and the debrief compares effort-adjusted e1RM — but the engine's load-progression predicate is still a proxy. `lastWeekClean` / `consecutiveMisses` in [lib/coach/prescription/prescribe-week.ts](../../../lib/coach/prescription/prescribe-week.ts) (≈ lines 617–637) read only `failure` + `reps ≥ baseReps`, and `fetchRecentSets` (≈ line 568) doesn't even select `rir`. A top set ground out at RIR 0 against a 2-RIR prescription reads as "clean" and earns a +step next week — the exact miscall the RIR arc was meant to prevent, and the function name `lastWeekHitRirTargetCleanly` has always over-promised.

2. **The engine only speaks on Sundays.** `prescribeWeek` runs via the Sunday cron, the propose/commit tools, and the activity-adjustment path. A committed workout changes nothing about the rest of the week: a session where every set ground out does not lighten Thursday, even though the engine's autoregulation rules would prescribe exactly that if they were re-run.

## Goals

- The engine's clean/dirty progression decisions consume real RIR when present.
- Every committed workout re-runs the engine for the **remaining** days of the current week and persists the result.
- The athlete can see that (and why) the plan changed, without a new approval surface.
- Legacy behavior is byte-identical when `rir` is null everywhere.

## Non-goals (explicitly out of scope)

- Morning-intake / reactive-ladder prescription patches (next arc; consumes the primitive built here).
- In-session live adjustment inside the logger.
- Missed-session detection and rescheduling.
- Any change to `lib/coach/e1rm.ts`, `bestComparisonValue`, or block-target semantics (audited invariants).
- Double-step progression when RIR comes in above target ("too easy"). One equipment step per week remains the ceiling.

## Design

### 1. RIR-aware clean predicates (engine core)

- `WorkoutSetSample` (lib/coach/prescription/types.ts) gains `rir: number | null`.
- `fetchRecentSets` adds `rir` to its `exercise_sets(...)` select.
- `lastWeekClean` and `consecutiveMisses` get a prescribed-RIR parameter (per-exercise `ex.rir ?? week rirTarget`, threaded from callers where `rirTarget` is already in scope). New predicate, symmetric-guard style:

  ```
  clean := !failure
        && (baseReps == null || reps >= baseReps)
        && (rir == null || rir >= prescribedRir)
  ```

  `rir == null` collapses to today's exact behavior — legacy rows, skipped entries, and Strong-imported history are unaffected. A recorded RIR *below* the prescription marks the set dirty → the engine **holds** load instead of stepping. RIR above target changes nothing (see non-goals).
- `prescribePrimaryFromPhase` is untouched; only the truthiness of `lastWeekHitRirTargetCleanly` feeding it changes.

### 2. New primitive: `repatchRemainingWeek`

New module `lib/coach/prescription/repatch-week.ts`:

```
repatchRemainingWeek({ supabase, userId, todayIso, reason })
  → { changed: boolean, changes: RepatchChange[] } | null
```

- Loads the current `training_weeks` row (Monday-keyed, user timezone). No row or no stored `session_prescriptions` → return null (no-op; nothing committed to repatch).
- Re-runs `prescribeWeek` with fresh data via the existing single seam, extended: `upsertWeekPrescription` gains an optional `preserveDaysThrough: todayIso` param. When set, the freshly computed output is merged with the stored row — **weekdays ≤ today keep their stored prescriptions verbatim; only strictly-future weekdays take the new computation.** Past days are the historical record of what was actually prescribed; they are never rewritten. The "single seam, single invariants" contract in upsert-week-prescription.ts stays intact (still never accepts a Carter-supplied payload).
- Computes a field-level diff (`{ weekday, exercise, field, from, to }[]`) between the stored and new future-day prescriptions.
- Appends an entry to `training_weeks.repatch_log` (see §3) **only when the diff is non-empty**.
- Deterministic and idempotent: re-firing with unchanged inputs produces an empty diff and writes nothing.

### 3. Migration 0048 — `training_weeks.repatch_log`

```sql
alter table public.training_weeks
  add column if not exists repatch_log jsonb;
```

Nullable, append-only array of `{ at, reason, workout_date, changes: RepatchChange[] }`. Serves two consumers: the debrief's "plan updated" line (§5) and audit/inspection (Carter or a script can answer "why is Thursday different from Sunday's number?"). No RLS change needed (column rides the existing row policies). Apply via `supabase db push` after history repair if needed, or Dashboard SQL Editor per house convention.

### 4. Trigger: workout commit

In [app/api/logger/session/route.ts](../../../app/api/logger/session/route.ts), after the existing `evaluateAndStampTargetHit` call and in the same non-fatal style:

```ts
try {
  await repatchRemainingWeek({ supabase, userId: payload.user_id, todayIso, reason: "workout_commit" });
} catch (err) {
  console.error("[logger/session] repatchRemainingWeek failed:", err);
}
```

- Ordering matters: target-hit stamping runs first so a freshly-crossed target flips the engine into consolidation before the repatch computes the remaining days.
- Failure is non-fatal to the commit; the Sunday cron remains the backstop and next week is always freshly computed regardless.
- `todayIso` derives from `getUserTimezone(userId)` per the timezone SSOT rule — no raw `new Date().toISOString().slice(0,10)`.

### 5. Athlete visibility — no new approval gate

The engine already writes without approval (Sunday cron); a repatch is the same deterministic authority on a different clock, and its changes are conservative by construction (hold vs. progress, lighten vs. push). Two existing surfaces carry the news:

- **Workout debrief:** the debrief generator ([app/api/coach/workout-debrief/route.ts](../../../app/api/coach/workout-debrief/route.ts) + sweep) reads `repatch_log` entries whose `workout_date` matches the debrief's workout and, when present, renders a "plan updated" line in the payload + narrative — e.g. *"Thursday's deadlift holds at 130 kg — today's top set was RIR 0 against a 2-RIR target."* The narrative prompt gets the diff as structured facts; the existing fabrication-check conventions apply.
- **Carter:** `<this_weeks_prescription>` reads stored `session_prescriptions`, so Carter quotes the repatched numbers automatically. CARTER_BASE gains one sentence teaching that mid-week numbers may legitimately differ from Sunday's ("the engine repatches remaining days after each committed session; the stored row is always canonical").

No chip, no modal, no push.

### 6. Error handling

- Repatch never throws into the commit path (try/catch, logged, commit response unaffected).
- `upsertWeekPrescription` failures inside repatch leave the stored row untouched (upsert is atomic per row).
- Missing block / between-blocks: `prescribeWeek` already degrades; repatch returns an empty diff and writes nothing (same observable no-op as the `null` early-return in §2).
- Malformed/absent `repatch_log` on old rows: readers treat null/non-array as empty.

### 7. Testing & verification

House style — no new test runner:

- Extend [scripts/audit-prescription-rules.mjs](../../../scripts/audit-prescription-rules.mjs) with fixtures: RIR-below-target top set → hold; RIR-at-target + reps met → +step; `rir: null` → legacy verdicts byte-identical; per-exercise `ex.rir` overriding week `rirTarget`.
- New fixture cases for the merge: repatch output never differs from stored prescriptions for weekdays ≤ today; empty diff → no `repatch_log` append; idempotent re-fire → empty diff.
- `npm run typecheck`, `npx vitest run`, `npm run build` (render gate — hooks rule), plus a live-data pass of `AUDIT_USER_ID=<uuid> … scripts/audit-sunday-prescription-e2e.mjs`.

## Invariants preserved

- `session_prescriptions` is always engine output via the single upsert seam; Carter never authors loads.
- Block-target comparison semantics (`bestComparisonValue`, Brzycki window, target_metric branching) untouched.
- Sunday cron behavior unchanged (it computes *next* week; repatch touches only the *current* week's future days).
- `rir = null` everywhere ⇒ system behaves exactly as before this change.
