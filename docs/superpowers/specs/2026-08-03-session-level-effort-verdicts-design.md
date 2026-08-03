# Session-level effort verdicts for primary and secondary lifts

**Date:** 2026-08-03
**Status:** Draft for review
**Area:** `lib/coach/prescription/`

## Problem

`lastWeekClean` and `consecutiveMisses` in [prescribe-week.ts](../../../lib/coach/prescription/prescribe-week.ts)
judge effort from a **single set**, and not the set they claim to.

`fetchRecentSets` orders `workouts` by `date` descending but places no explicit order on the
embedded `exercise_sets`. PostgREST returns those by `set_index` **ascending** (verified
2026-08-03 against production rows: `idx0 idx1 idx2`). So `setsForExercise(...)[0]` is the
**first working set of the most recent session** — not the most recent set.

That contradicts both docstrings:

- `lastWeekClean` — "the most-recent non-warmup set"
- `consecutiveMisses` — "Walks newest-first"

**Consequence:** a session that opens clean and then collapses reads as clean. The athlete
earns a load increase for a session he failed.

### Verified on production data

| Lift | Most recent session | Current verdict |
| --- | --- | --- |
| Deadlift (Barbell) | `90×8 @2, 90×8 @1, 90×8 FAIL @0` | **clean → +step** |
| Overhead Press (Barbell) | `30×10 @2, 30×10 FAIL @0, 30×9 FAIL @0` | **clean → +step** |

Both sessions ended in failure at RIR 0. Both read clean because the opening set was clean.

### Measured blast radius

Patching the predicates to session-level semantics and diffing `prescribeWeek` output for
the current week changes exactly **one** prescription:

```
- Tuesday|Overhead Press (Barbell)|30x10x3
+ Tuesday|Overhead Press (Barbell)|25x10x3
```

Deadlift is unchanged because the 0.92× focus-block clamp in
[autoregulation-rule.ts](../../../lib/coach/prescription/autoregulation-rule.ts) already
caps it at 82.5 kg regardless of the verdict. **The bug is masked in output today by the
clamp — it is not masked outside a focus block, where no clamp applies.**

### Scope of the defect

| Consumer | Path | Affected? |
| --- | --- | --- |
| Focus lift | `prescribePrimaryFromPhase` ← `lastWeekClean` | **yes** |
| Secondary primaries | `prescribeSecondaryAutoregulated` ← both predicates | **yes** |
| Accessories | `prescribeAccessoryDoubleProgression` | no — already session-grouped |
| Session debrief | `compose-prescription.ts` | no — uses its own `lift.tag === "PR"` proxy |

The accessory rule already does this correctly: `sessionsFor()` groups by `performed_on`,
sorts sessions newest-first, and judges whole sessions. The primary and secondary predicates
are the only ones that never got that treatment.

## Design

### The asymmetry

The two predicates answer different questions and must not share one definition of "clean":

| Predicate | Gates | Semantics | Rationale |
| --- | --- | --- | --- |
| `lastWeekClean` | a load **increase** (+step) | **all working sets clean** | Earning a step should be strict: prescribed reps hit, target RIR met, no failure. |
| `consecutiveMisses` | a **10% load cut** | consecutive **strained** sessions | Cutting should be conservative: only genuine grinding counts. |

A set is **clean** when `!failure && reps >= repsThreshold && (rir == null || rir >= prescribedRir)`.

A set is **strained** when `failure || (rir != null && rir < prescribedRir)`.

The distinction is load-bearing and already documented in the accessory rule: *"Reps-short
with high (or unrecorded) RIR means the athlete CHOSE to stop (lighten compliance, time cap)
— that holds, it never descends."* A session where the athlete stopped at 8 of 10 prescribed
reps at RIR 3 is **not clean** (no step earned) but is **not strained** (no cut warranted).

Both semantics are computed with `every` / `some` over a session's sets, so they are
**order-independent**. The PostgREST ordering ambiguity cannot affect them.

### Rejected alternative

Judging on the session's **top set** (heaviest, tie-broken by reps) was considered and
rejected: on both Deadlift and Overhead Press the heaviest set *is* the clean opening set, so
it reproduces the current false-clean exactly.

### Shared session-grouping module

Extract the grouping and predicate helpers from `double-progression-rule.ts` into a new
`lib/coach/prescription/session-grouping.ts`:

```ts
export type ExerciseSession = { date: string; sets: WorkoutSetSample[] };

/** Non-warmup sets for `exerciseName`, grouped by date, sessions newest-first. */
export function sessionsForExercise(
  recentSets: WorkoutSetSample[],
  exerciseName: string,
): ExerciseSession[];

/** Completed, hit the reps threshold, and met prescribed RIR when recorded. */
export function isCleanSet(s: WorkoutSetSample, repsThreshold: number, prescribedRir: number): boolean;

/** Genuinely hard: taken to failure, or ground below prescribed RIR. */
export function isStrainedSet(s: WorkoutSetSample, prescribedRir: number): boolean;
```

`double-progression-rule.ts` then imports these instead of defining its own. **This must be a
pure extraction** — identical logic, no behaviour change. The accessory rule's existing unit
tests and audit assertions are the proof; any diff in their results means the extraction was
not faithful and must be corrected, not accommodated.

`repsThreshold` stays an explicit parameter because the accessory rule passes rep-range
bottom/top while the primary predicates pass `ex.baseReps`.

### Rewritten predicates

```ts
export function lastWeekClean(
  sets: WorkoutSetSample[],
  ex: PlannedExercise,
  rirTarget: number,
): boolean {
  const last = sessionsForExercise(sets, ex.name)[0];
  if (last == null) return false;
  const prescribedRir = ex.rir ?? rirTarget;
  return last.sets.every((s) => isCleanSet(s, ex.baseReps ?? 0, prescribedRir));
}

export function consecutiveMisses(
  sets: WorkoutSetSample[],
  ex: PlannedExercise,
  rirTarget: number,
): number {
  const prescribedRir = ex.rir ?? rirTarget;
  let misses = 0;
  for (const session of sessionsForExercise(sets, ex.name)) {
    if (!session.sets.some((s) => isStrainedSet(s, prescribedRir))) break;
    misses++;
  }
  return misses;
}
```

Note the unit change: `consecutiveMisses` now counts **sessions**, not sets. The
`>= 2` threshold in `autoregulation-rule.ts` is unchanged in value but now means "two
consecutive strained sessions" — which is what the rule's own comment
(`missed twice → drop 10%`) always described.

### Ordering hardening

Add an explicit order to the embedded resource in `fetchRecentSets`:

```ts
.select("date, exercises(name, exercise_sets(kg, reps, warmup, failure, rir, set_index))")
.order("set_index", { referencedTable: "exercises.exercise_sets", ascending: true })
```

Verified working against production on supabase-js 2.105.1: the two-level embed path is
accepted and the order is genuinely applied (`ascending: false` returns `idx2 idx1 idx0`).
Use `referencedTable`, not the deprecated `foreignTable` alias — both are accepted today but
only the former is current.

Not load-bearing for this design — both new semantics are order-independent — but it makes
the payload's ordering contractual so this class of bug cannot recur silently. `set_index`
must be added to the selected columns for the order to be expressible.

### Rollout

No migration, no grandfathering, no one-shot state. `fetchRecentSets` already bounds history
to a **28-day window**, so the corrected verdict can only reflect recent sessions, and the
measured impact is a single lift. The corrected answer simply applies from the next engine
run onward.

## Goals

1. A session that collapses after a clean opening set must not earn a load increase.
2. Load cuts fire only on genuine strain, never on compliant reps-short sessions.
3. One definition of "sessions for an exercise" across the whole prescription engine.

## Non-goals

- Changing the `>= 2` cut threshold, the 10% cut magnitude, or the 0.92× focus-block clamp.
- Changing accessory double-progression behaviour (the extraction must be behaviour-neutral).
- Changing `compose-prescription.ts`'s independent `lift.tag === "PR"` proxy.
- Any change to volume/set-count rules (shipped separately in PR #159).

## Testing

- **New unit suite** `lib/coach/prescription/__tests__/session-grouping.test.ts`:
  grouping by date; newest-first ordering; warmup exclusion; name matching case/whitespace
  insensitive; `isCleanSet` reps/RIR/failure branches incl. `rir == null` legacy degradation;
  `isStrainedSet` distinguishing failure and sub-target RIR from compliant reps-short.
- **New unit suite** `lib/coach/prescription/__tests__/effort-verdicts.test.ts`, with the two
  production regressions as named fixtures:
  - `90×8 @2, 90×8 @1, 90×8 fail @0` → `lastWeekClean === false` (was `true`)
  - `30×10 @2, 30×10 fail @0, 30×9 fail @0` → `lastWeekClean === false` (was `true`)
  - compliant reps-short (`reps < baseReps`, `rir >= target`, no failure) → not clean, and
    contributes **zero** to `consecutiveMisses`
  - `consecutiveMisses` counts sessions and stops at the first unstrained session
  - empty history → `lastWeekClean === false`, `consecutiveMisses === 0`
- **Existing audit assertions** in `scripts/audit-prescription-rules.mjs` (the
  `lastWeekClean` / `consecutiveMisses` block): all eight `lastWeekClean` assertions are
  single-set fixtures and remain valid under session semantics — a one-set session. Two of
  the three `consecutiveMisses` assertions also hold. Do not rewrite an assertion to make it
  pass, with **one deliberate exception**:

  ```js
  assert(
    "consecutiveMisses legacy path unchanged when RIR absent",
    consecutiveMisses([{ ...base, reps: 4 }, base], ex, 2) === 1,
  );
  ```

  Both fixture sets share `performed_on: "2026-07-06"`, so they are **one session**, and
  neither is strained: `reps: 4` is short of the prescribed 6, but `rir` is absent, so
  `isStrainedSet` is false. Under semantic C the expected value becomes **0** — reps-short
  with unrecorded RIR is exactly the "athlete chose to stop" case that must hold rather than
  descend. This assertion must be updated to `=== 0` and its name changed to reflect the new
  rule (e.g. `"reps-short with no recorded RIR does not count as a miss"`). It is the only
  existing assertion whose expected value changes; any other change means the implementation
  is wrong.
- Add session-level assertions alongside the existing block.
- **Behaviour-neutrality check for the extraction:** the accessory double-progression tests
  and audit assertions must pass **unchanged**.
- **Verification gate:** `npm run typecheck`, `npx vitest run`,
  `scripts/audit-prescription-rules.mjs`, and `scripts/audit-sunday-prescription-e2e.mjs`.
- **End-to-end confirmation:** re-run the prescribe diff and confirm the only change is
  Overhead Press 30 → 25 kg.

## Risks

- **Overhead Press drops 30 → 25 kg on the next run.** This is the rule working as intended
  after months of grinding 30 × 10 at RIR 0, but it is a visible change and should be
  narrated to the athlete rather than appearing unexplained.
- **The extraction could silently alter accessory behaviour.** Mitigated by requiring the
  accessory suites to pass unchanged.
- **`consecutiveMisses` changes unit from sets to sessions.** A lift trained twice in one week
  now accumulates misses twice as fast in calendar terms. Accepted: this matches the rule's
  documented intent, and the 28-day window bounds the count.

## Follow-ups (not in scope)

- `compose-prescription.ts` uses `lift.tag === "PR"` as its own cleanliness proxy. Worth
  auditing for the same class of defect, but it feeds the debrief narrative rather than
  stored prescriptions.
- Three exercises fail the e2e on-grid check (Rear Delt Fly 29.3 kg, Hip Abductor 61 kg,
  Chest Fly 32 kg) — realized machine pin weights not matching declared library steps.
  Pre-existing and unrelated.
