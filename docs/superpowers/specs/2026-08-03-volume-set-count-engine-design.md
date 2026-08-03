# Volume set-count engine — closing the loop

**Date:** 2026-08-03
**Status:** Draft for review
**Area:** `lib/coach/prescription/`

## Problem

The athlete asked why some exercises are prescribed at 4 or 5 sets. The audit found the
rule is deterministic and correctly implemented, but sits on top of two defects that make
it prescribe volume the athlete never performs.

### The rule

`prescribeAccessoryFromVolumeBand` ([volume-balance-rule.ts](../../../lib/coach/prescription/volume-balance-rule.ts))
compares each muscle's 8-week rolling set volume to RP-style MEV/MAV/MRV landmarks and
adjusts the accessory's set count:

| Band position | Effect |
| --- | --- |
| `below_mev` / `at_mev` | `+1 set` |
| `in_band` / `near_mrv` | hold |
| `above_mrv` | `−1 set` |

Measured state on 2026-08-03:

| Muscle | 8wk avg sets | MEV | Position | Effect |
| --- | --- | --- | --- | --- |
| Lats | 7.5 | 10 | below MEV | +1 |
| RearDelts | 3.3 | 8 | below MEV | +1 |
| Quads | 6.8 | 8 | below MEV | +1 |
| Biceps | 5.6 | 8 | below MEV | +1 |
| Calves | 3.9 | 8 | below MEV | +1 |
| Chest | 11.5 | 10 | in band | hold |
| Hams / Glutes / Traps / Triceps | 6.4 / 7.5 / 8.5 / 7.4 | — | in band | hold |

Every prescribed 4 is a 3-set library default on a below-MEV muscle. The single 5
(Lat Pulldown) is a 4-set library default on a below-MEV muscle. The bump is flat `+1`
and cannot compound.

### Defect 1 — the feedback loop is open

`discoverEffectiveExercises` ([recent-workouts-discovery.ts](../../../lib/coach/prescription/recent-workouts-discovery.ts))
derives `baseKg` from the athlete's realized max and `baseReps` from the realized median,
but **never derives `sets`**. Library exercises inherit `sets` from `SESSION_PLANS`;
off-script exercises are hardcoded to `sets: 3`.

So the `currentSets` that volume-balance adds `+1` to is always the static library value,
never what the athlete performed. The athlete does 3 sets, the engine computes `3 + 1 = 4`,
the athlete does 3 again, the engine computes 4 again — indefinitely. It cannot run away,
but it can never converge.

A secondary bug lives in the same function: the per-session `seenInThisSession` guard
`continue`s on the second row of a repeated exercise name, discarding it entirely. Warmup
ramp entries are stored as separate `exercises` rows sharing the working entry's name, so
for a lift like Squat the function reads only the first (warmup) row.

### Defect 2 — the volume rule is blind to effort

There are no references to `rir` or `failure` anywhere in `volume-landmarks.ts`,
`muscleVolume.ts`, or `volume-balance-rule.ts`. Sets are counted as interchangeable units.

MEV/MAV/MRV landmarks assume sets taken at roughly 0–4 RIR *without* systematic failure;
failure training compresses MRV substantially. This athlete takes a large share of sets to
`failure: true` / `rir: 0`. The engine reads "below MEV, add volume" from a lifter whose
actual problem is excessive per-set effort.

### Defect 3 — the measurement is self-defeating

Rolling volume is below MEV *because* only 3 sets are performed. The engine's response is
to prescribe a 4th set, which is not performed, so the rolling average never rises, so the
bump repeats forever. Prescription and measurement never close the loop.

The underlying constraint is **frequency, not per-session sets**: Quads sit at 6.8 sets/week
because legs are trained once weekly. Reaching an 8-set MEV that way means 8 quad sets in a
single session. The engine is applying a per-session-sets lever to a frequency problem.

### Ordering finding (verified, affects design)

`fetchRecentSets` orders `workouts` by `date` descending but places no explicit order on the
embedded `exercise_sets`. Empirically PostgREST returns them by `set_index` **ascending**.
So `setsForExercise(...)[0]` is the *first* working set of the most recent session, not the
most recent set.

This contradicts the documented intent of both `lastWeekClean` ("the most-recent non-warmup
set") and `consecutiveMisses` ("Walks newest-first"). Consequence: a session that opens
clean and then collapses reads as clean.

**This spec does not change those predicates** — their load-progression behaviour is
established and separately audited, and re-pointing them is a behaviour change deserving its
own spec. The new effort gate is therefore designed to be **order-independent** rather than
built on top of them. The mismatch is recorded here and listed under Follow-ups.

## Goals

1. Make the engine's set-count input reflect what the athlete actually performs.
2. Stop adding volume to muscles being trained past failure.
3. Stop repeating a bump that is demonstrably ignored, and surface the real (frequency)
   recommendation instead.

## Non-goals

- Changing MEV/MAV/MRV landmark values or the tier scalar.
- Changing load or rep progression (double-progression, autoregulation, block-phase rules).
- Re-pointing `lastWeekClean` / `consecutiveMisses` (see Follow-ups).
- Any change to primary or secondary lift set counts — this spec touches the accessory
  volume-band path only.

## Design

### Change 1 — discovery derives `sets` from realized data

**File:** `lib/coach/prescription/recent-workouts-discovery.ts`

Extend the presence exemplar with per-session working-set counts:

```ts
type PresenceEntry = {
  count: number;
  exemplar: { name: string; kgs: number[]; reps: number[]; setsPerSession: number[] };
};
```

Restructure the per-session accumulation so that presence is still tallied **once** per
session per exercise name, but sets are accumulated from **every** row bearing that name in
that session. This fixes the warmup-split-row bug as a side effect: `baseKg` and `baseReps`
now also see the working rows of lifts whose warmups are stored as separate same-name rows.

For each session, push the count of non-warmup sets observed for that name into
`setsPerSession` (skip sessions contributing zero non-warmup sets — an all-warmup
appearance is not evidence of working volume).

Resolve the discovered set count as:

```ts
sets: entry.exemplar.setsPerSession.length > 0
  ? Math.round(median(entry.exemplar.setsPerSession))
  : (libEx.sets ?? 3)
```

Median, not max — consistent with `baseReps`, and robust to a single outlier session.
Off-script exercises use the same expression with a fallback of 3.

**Expected effect:** `currentSets` becomes truthful. Lat Pulldown drops from 5 to 4
(library 4 → realized 3, then `+1`). No other current exercise changes, because the
athlete's realized count already matches the library default of 3.

### Change 2 — effort gate on the volume bump

**New pure helper** in `lib/coach/prescription/effort-quality.ts`:

```ts
export type EffortQuality = { totalSets: number; hardSets: number; hardRate: number };

export function recentEffortQuality(
  exerciseName: string,
  recentSets: WorkoutSetSample[],
  todayIso: string,
): EffortQuality
```

Over a 28-day window (matching `maintenanceLoadFor`'s `LOOKBACK_DAYS`), across non-warmup
sets matching the exercise name, a set is **hard** when `failure === true || rir === 0`.
`hardRate = hardSets / totalSets`; `hardRate` is 0 when `totalSets === 0`.

Deliberately order-independent — it is a proportion over a window, so the PostgREST
ordering finding above cannot affect it.

**Wire into `prescribeAccessoryFromVolumeBand`** via two new optional fields on
`VolumeBalanceInput`:

```ts
hardRate?: number;        // from recentEffortQuality
totalSets?: number;       // sample size guard
```

Gate:

```ts
const HARD_RATE_SUPPRESS_THRESHOLD = 1 / 3;
const MIN_SETS_FOR_EFFORT_GATE = 3;

const effortSuppressed =
  (bandPosition === "below_mev" || bandPosition === "at_mev") &&
  (input.totalSets ?? 0) >= MIN_SETS_FOR_EFFORT_GATE &&
  (input.hardRate ?? 0) > HARD_RATE_SUPPRESS_THRESHOLD;
```

When `effortSuppressed`, hold sets instead of `+1`.

**Threshold rationale:** with 3-set exercises, one hard finishing set is 33% and is
accepted practice. The gate fires strictly *above* one-third, i.e. from two hard sets in
three. `MIN_SETS_FOR_EFFORT_GATE` prevents a single logged set from suppressing a bump.

**Honest expected effect: this changes nothing in the athlete's current plan.** Measured
28-day hard-rates for the below-MEV exercises are Lat Pulldown 33%, Seated Row 33%,
Leg Extension 17%, Pullover / Leg Press Single Leg / Seated Calf Raise / face pull 0%.
None exceed the threshold. The exercises that *do* exceed it (Overhead Press 50%, Incline
Bench 67%, Decline Bench 67%) sit on muscles already `in_band`, so they have no bump to
suppress. Change 2 is a forward guardrail, not a fix for today's numbers.

### Change 3 — adherence-aware escalation

This is the change that actually addresses the athlete's complaint.

**New pure module** `lib/coach/prescription/volume-adherence.ts`:

```ts
export type SetAdherence = { prescribed: number; realizedMedian: number; ignoredExposures: number };

export function setAdherenceFor(
  exerciseName: string,
  priorPrescribedSets: number | null,
  recentSets: WorkoutSetSample[],
  todayIso: string,
): SetAdherence
```

`ignoredExposures` counts consecutive recent sessions of that exercise where the realized
non-warmup set count was strictly less than `priorPrescribedSets`.

`priorPrescribedSets` is read from the previous week's stored
`training_weeks.session_prescriptions` entry for the same exercise name — the engine
already loads the prior week row in `upsert-week-prescription.ts`, so this needs plumbing,
not a new query.

**Gate in `prescribeAccessoryFromVolumeBand`:**

```ts
const IGNORED_EXPOSURES_LIMIT = 2;
```

When band position is `below_mev`/`at_mev` and `ignoredExposures >= IGNORED_EXPOSURES_LIMIT`,
hold sets at `realizedMedian` and emit a frequency signal instead of the bump.

**Frequency signal.** `prescribeWeek` accumulates one entry per affected muscle:

```ts
type VolumeFrequencySignal = {
  muscle: TargetedMuscleGroup;
  weekly_sets: number;
  mev: number;
  weekly_exposures: number;      // sessions/week currently hitting this muscle
  suppressed_exercises: string[];
};
```

Persisted to a new nullable `training_weeks.volume_signals jsonb` column (**migration 0054**,
the next free slot). Nullable, so pre-migration rows behave unchanged.

**Consumer:** a `<volume_signals>` block in Carter's prompt assembly, alongside the existing
`<this_weeks_prescription>` block ([this-weeks-prescription.ts](../../../lib/coach/carter-context/this-weeks-prescription.ts)).
`CARTER_BASE` gains a short rule: when a muscle is below MEV at one exposure per week,
recommend a second exposure rather than more sets per session. Carter narrates; the engine
does not restructure the split on its own.

**Expected effect on the athlete's current plan** (cumulative across Changes 1 and 3;
Change 2 contributes nothing at today's effort profile, as noted above):

| Day | Now | After |
| --- | --- | --- |
| Legs | 21 | 18 |
| Chest | 16 | 16 |
| Back | 26 | 21 |
| Arms | 33 | 29 |
| **Weekly total** | **96** | **84** |

Every removed set is one that was prescribed and not performed.

## Phasing

- **Phase 1** — Changes 1 and 2. Pure-function work plus one call-site edit in
  `prescribe-week.ts`. No migration, no prompt change, no UI.
- **Phase 2** — Change 3. Adds migration 0054, the `volume_signals` plumbing, and the
  Carter prompt block.

Phase 1 is independently shippable and independently useful (truthful inputs + the
forward guardrail). Phase 2 delivers the visible set-count reduction.

## Testing

- **Unit** (`lib/coach/prescription/__tests__/`, vitest, node env):
  - `recent-workouts-discovery.test.ts` — extend: realized median set count; warmup-split
    rows aggregate into one exemplar; all-warmup appearance falls back to library value;
    off-script fallback of 3.
  - New `effort-quality.test.ts` — hard-set classification via `failure` and via `rir === 0`;
    28-day window boundary; empty-sample returns `hardRate` 0.
  - New `volume-adherence.test.ts` — `ignoredExposures` counting; null `priorPrescribedSets`
    yields 0.
- **Fixture audit** (`scripts/audit-prescription-rules.mjs`, no DB access):
  add cases for the effort gate (fires above one-third, holds at exactly one-third, respects
  `MIN_SETS_FOR_EFFORT_GATE`) and for the adherence gate at the `IGNORED_EXPOSURES_LIMIT`
  boundary.
- **E2E, read-only**: extend `scripts/audit-sunday-prescription-e2e.mjs` to assert no
  prescribed accessory set count exceeds `realizedMedian + 1`.
- **Verification gate**: `npm run typecheck` + `npx vitest run` + both audit scripts.

## Risks

- **Change 1 alters `baseKg`/`baseReps` for warmup-split lifts.** Previously only the first
  (warmup) row was read, so those lifts silently fell back to library values. After the fix
  they read realized working data. This is the intended correction, but it will move
  numbers on first run — the e2e audit above is the check.
- **Change 3 can hold a genuinely under-volumed muscle below MEV.** Mitigated by the
  frequency signal: the engine stops issuing a bump it knows will be ignored and hands the
  decision to Carter and the athlete, rather than silently dropping the concern.
- **`median` of an even-length sample rounds via `Math.round`.** A 3/4 split resolves to 4.
  Acceptable; documented so it is not read as a bug.

## Follow-ups (not in scope)

- Re-point `lastWeekClean` / `consecutiveMisses` to genuinely read most-recent-first, or
  correct their docstrings to describe the first-set-of-session semantics they actually
  implement. Requires deciding which is intended and re-auditing load progression.
- Add an explicit `.order("set_index")` on the embedded `exercise_sets` in `fetchRecentSets`
  so ordering is contractual rather than incidental.
- Tier-aware volume bands: `classifyVolumeBandForMuscle` hardcodes the `intermediate` tier
  because no per-user training age is plumbed into `prescribeWeek`.
