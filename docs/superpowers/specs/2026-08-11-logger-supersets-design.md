# Supersets in the workout logger

**Date:** 2026-08-11
**Status:** design approved, implementation not started
**Scope:** Friday Arms session first; the mechanism is session-agnostic.

## Problem

Friday's Arms session is performed as three supersets — two exercises back to
back, rest only after the second:

| Group | Exercises |
|-------|-----------|
| A | Arnold Press (Dumbbell) + Bicep Curl (Dumbbell) |
| B | Front Raise (Dumbbell) + Hammer Curl (Dumbbell) |
| C | Lateral Raise (Dumbbell) + Triceps Pushdown (Cable) |

The remaining four — Cable External Rotation, Cable Internal Rotation, Rear Delt
Fly, Reverse Crunch — are performed alone.

The logger's timer treats every set as an independent unit: START → 5s walk-up
countdown → work clock → STOP → rest countdown. A superset has one work interval
covering two exercises and one rest at the end, which the current state machine
cannot express. Logging it today means either stopping the clock mid-superset
(breaking the continuity that is the point of the technique) or leaving the pair
untimed.

## Decisions

Made during the design conversation, with the reasoning that produced them:

1. **The pairing is plan metadata**, not an in-logger construction. It rides the
   existing resolution chain, so the logger, the morning brief and the strength
   card all read one source.
2. **Two taps per round — START and STOP — with an even work split.** The
   alternative (a hand-off tap between the two exercises) buys measured per-set
   work time, but no consumer spends that precision, and it costs a phone
   interaction at the one moment a superset is meant to be continuous.
3. **The pairing persists to the database.** A grouped exercise's recorded
   timing is not comparable to a solo exercise's, and history cannot be
   retrofitted (see [Persistence](#persistence)).
4. **UI is two normal cards joined by a rail**, not one merged card. Each
   exercise keeps its per-set history, voice entry and ⋯ menu; the grouping is
   purely additive.

## Data model

### `PlannedExercise.superset`

```ts
/** Superset tag. Adjacent exercises sharing a tag are performed back-to-back
 *  as one round, with rest only after the last member. Absent = solo. */
superset?: string;   // "A" | "B" | "C" …
```

**A group is the maximal contiguous run of equal tags.** This one rule covers
every edit case without validation code and without an invalid state to guard:

- a reorder that separates two members dissolves the group into solo exercises;
- removing a member leaves the survivor solo;
- two same-tagged exercises that end up non-adjacent are simply two groups of
  one.

`SESSION_PLANS.Arms` already lists the exercises in the pairing order, so the
change there is three tags and no reordering.

The code path handles a run of N members. The Arms plan uses pairs; triples are
not planned and not exercised by tests.

### Field survival through the resolution chain

`PlannedExercise` flows intact through every layer above the code default:
`prescribeWeek` spreads `...ex`, `applyOrderingOverride` carries ordering only,
`applyManualSessionEdits` merges per-exercise, and `user_session_templates`
stores whole entries. No layer needs to learn about the field.

One exception, and it is a trap:
`augmentFirstLoadedCompoundWithWarmups` ([prescribe-week.ts](../../../lib/coach/prescription/prescribe-week.ts))
builds the two Arnold warmup entries with `{...compound}`, so they would inherit
tag A and be dragged into the pair. **The warmup entries must strip the tag** —
the athlete ramps the Arnold press solo, then the rounds begin.

### Transition

`training_weeks.session_prescriptions` for the current week was snapshotted
before the field existed and sits at the top of the resolution chain, so the
tags will not appear until that row is regenerated. Re-run the Sunday
prescription for the current week once
(`/api/coach/sunday-prescriptions/sync`); after that the weekly cron carries the
tags forward. No backfill of historical rows — the field is forward-looking.

## Logger mechanics

### Grouping helper

New pure module `lib/logger/superset-groups.ts`:

- `groupsOf(exercises) → { tag: string | null; indices: number[] }[]` —
  maximal contiguous runs; a solo exercise is a one-member group.
- `nextRound(draft, skip: SetRef[]) → SetRef[]` — replaces `firstPendingSet`.
  Finds the first uncommitted set in draft order, takes its group, and returns
  each member's first uncommitted set in group order. A member with no
  uncommitted set left is omitted, so an unequal pair (3 sets vs 2) ends with a
  solo round and needs no special case. `skip` is the set of refs whose entry
  row is still open — the list form of what `firstPendingSet` skips today.

Pure and in `lib/`, so vitest reaches it — components in this repo cannot be
tested by construction.

### Timer state

`TimerState` generalises; it does **not** grow a parallel superset path. A
second copy of an engine rule drifting out of sync with the first is this
repo's documented recurring failure, and the timer is an engine.

- `activeSet: SetRef | null` → `activeSets: SetRef[]` (empty = none)
- `pendingEntry: (SetRef & { workSeconds }) | null` →
  `pendingEntries: (SetRef & { workSeconds })[]`
- `remapTimerSets` / `remapTimerExercises` map over the arrays, keeping their
  existing rule for a vanished target: if a member is gone, drop that member;
  if the whole round is gone, drop the timer.
- `press_start` takes `sets: SetRef[]`; `save_entry` takes the ref of the entry
  being saved and removes just that member.

A solo exercise is a one-member round, so today's behaviour runs the same code.

### Round timing

New constant beside `PHONE_LAG_SECONDS`, in `lib/logger/set-timer.ts`:

```ts
/** Dumbbell swap / walk to the next station inside a superset. Deducted once
 *  per transition, so it is not credited as time under load. */
export const SUPERSET_TRANSITION_SECONDS = 5;
```

New pure function:

```
splitRoundWork(startAnchorMs, stopPressMs, memberCount) → number[]

raw    = floor((stopPressMs − startAnchorMs) / 1000)
         − PHONE_LAG_SECONDS
         − SUPERSET_TRANSITION_SECONDS × (memberCount − 1)
share  = max(1, floor(raw / memberCount)) for each member,
         with raw % memberCount added to the FIRST member
```

The members' shares sum to `raw` by construction, which is what keeps the dock's
WORK counter, the finish summary's work:rest ratio and rest-between-rounds true
even though the per-exercise split is an even estimate rather than a
measurement.

`started_at` per member: member 0 is stamped at `countdown_elapsed` (unchanged
behaviour); members 1..N−1 are stamped at `press_stop` by walking forward from
the round start through each earlier member's share plus
`SUPERSET_TRANSITION_SECONDS`.

Rest seeds from the group's rest = the maximum over members of
`restOverrides[i] ?? annotatedRestFor(draft, i)`, then `restSeedSeconds` applies
the phone lag as today.

### UI

Layout is **two cards joined by a rail** (mockup option B):

- a `Superset 1` chip above the group with a `3 rounds · rest after B` caption;
- a coloured left rail spanning the members' cards;
- each `ExerciseCard` unchanged internally — per-set history, voice entry,
  Replace / Remove / Edit rest time, "+ Add set".

After STOP, **both members zoom their own set row at once**. `SetEntryRow` is
unchanged: each Save commits its own set and closes its own zoom, and pressing
START on the next round auto-saves whatever is still open — the existing
auto-save rule, applied to a list.

The dock reads `Superset 1 · round 2` with target
`Arnold 24×15 → Curl 20×15`; `describeSet` generalises to describe a round.

"+ Add set" stays per-card. Because rounds are derived rather than stored,
adding a set to one member simply makes the final round solo for that member —
the same path as an unequal prescription.

The ⋯ menu gains **Ungroup**: clears `prescribed.superset` on that exercise in
the draft only, for the night someone is camped on the cable station. One-way
for the session; regrouping in the logger is out of scope.

### Between-sets coaching

A round commits two sets, and `evaluateSet` returns at most one line per set.
The sheet evaluates each committed set of the round in group order and displays
the first non-null line, anchored to that set. The existing single-line-at-a-
time contract is unchanged.

## Persistence

### Why

`commitNow` derives `rest_seconds_actual` from the previous committed set **of
the same exercise**, so the within-pair gap is never recorded. The distortion
runs the other way: Arnold set 2's recorded rest silently contains the curl
set's work, so it reads *longer* than the true inter-round rest, and its
`work_seconds` is a split estimate rather than a measurement. Nothing downstream
can distinguish those numbers from honest ones unless the grouping is stored,
and history cannot be retrofitted.

### Migration 0057

```sql
alter table public.exercises add column if not exists superset_group text;
```

Nullable; NULL for every ungrouped exercise, every Strong CSV import and all
pre-0057 rows. The column comment states both distortions above so a future
reader does not have to rediscover them.

`commit_logger_session` is re-declared with the column added to the `exercises`
INSERT — same body otherwise, including the idempotent
delete-exercises-then-insert on retry. `CommitSessionPayload.exercises[]` gains
`superset_group: string | null`.

### Reading it back

`fetch-workout-for-edit` selects the column and `hydrate-from-workout` restores
it onto `prescribed.superset`, so editing a saved Friday keeps the pairs instead
of flattening the session into ten independent exercises. The `exercises` row
mirror in [lib/data/types.ts](../../../lib/data/types.ts) gains the field, per
the repo's keep-DB-columns-and-TS-types-in-sync rule.

## Consumers in this arc

Deliberately few:

- **`ruleRestDiscipline`** returns null for an exercise in a group. It compares
  against `restPrescription`, which describes inter-working-set rest for a lift
  performed alone; a grouped exercise's gap is a different quantity. Arnold
  Press is tier 2, so the rule genuinely reaches it.
- **Morning brief session list** and **strength card plan list** render a small
  `SS1` chip. Both already map over `PlannedExercise`; this is a label, not a
  new data path.

Coach-facing prose — workout debrief, Carter, the snapshot prefix — is out of
scope. The column is written now so the history exists when that lands.

## Testing

Pure modules, under `lib/logger/__tests__/`:

- `superset-groups`: contiguous-run grouping including the split-by-reorder and
  removed-member cases; `nextRound` with equal and unequal set counts, with an
  open entry row to skip, and when every set is committed.
- `set-timer`: `splitRoundWork` sums to `raw` for 1..3 members and for durations
  short enough to hit the 1-second floor; member `started_at` derivation;
  `remapTimerSets` / `remapTimerExercises` over multi-member rounds under
  reorder, member removal and ungroup.

Components remain unverifiable in this repo's node-environment vitest setup, so
`npm run build` guards the hook-order failure class and the Friday session is
the end-to-end check.

## Out of scope

- Regrouping inside the logger (ungroup is one-way for the day).
- Superset awareness in the prescription engine — loads, set counts and rest
  prescriptions are unchanged by grouping.
- Triples or larger groups in plan data.
- Coach prose about supersets.
- Retrofitting the marker onto historical workouts.
