# Logger: load propagation, and removing voice entry

**Date:** 2026-08-11
**Status:** approved
**Branch:** `feat/logger-load-propagation`

Two changes to the in-app workout logger, shipped together because both land in
`SetRow.tsx` and `ExerciseCard.tsx`:

1. **Load propagation** — a weight typed into one set carries down to the sets
   below it in the same exercise.
2. **Voice removal** — the per-set 🎤 never worked reliably; deleting it makes
   the logger lighter and the first change smaller.

---

## Part 1 — Load propagation

### The problem

Every working set of an exercise is pre-filled with the prescription's
`baseKg`. When the athlete goes heavier than prescribed — or corrects a load
mid-exercise — they retype the same number into every remaining set by hand.
Four sets of a bumped load is three redundant keyboard trips, mid-workout,
between sets.

### The rule

> When a `kg` value is written into a non-warmup set, every following set that
> still **agreed** with that set's previous value follows it. The chain stops at
> the first set that had already diverged.

That divergence is the record of a deliberate choice — a back-off, a drop set —
and it is the only signal needed. No dirty flags, no extra state on
`ExerciseSetDraft`, no schema change: the values themselves carry the intent.

**Candidate** = uncommitted **and** non-warmup.

Non-candidates are *skipped*: never overwritten, and they never break the chain.

- A **committed** set is history, not a plan. It must not be rewritten, but a
  committed set sitting between two pending ones must not sever propagation
  either.
- A **warmup** row is the athlete's ramp, not a working load. Warmups are
  essentially always at the top of an exercise, but a mid-list one (a re-added
  set, a badge toggled by hand) must not stop the chain to the sets below it.

### Worked example

Athlete edits set 2 from 100 → 110:

```
before              after
S1  100 ✓           S1  100 ✓    committed → skipped, not overwritten
S2  100             S2  110      the edit
S3  100             S3  110      agreed with old 100 → follows
S4  100             S4  110      agreed with old 100 → follows
S5   90             S5   90      diverged → chain stops here
S6  100             S6  100      below the stop, untouched
```

### Guards

| Condition | Behaviour | Why |
|---|---|---|
| `sets[fromIndex].warmup` | no-op | A warmup load says nothing about the working sets. |
| `newKg === oldKg` | no-op | A focus-then-blur with no typing must not rewrite anything. |
| `newKg === null` (field cleared) | no-op | Clearing one field must not wipe the exercise. |
| `oldKg === null` | **valid anchor** | Bodyweight-to-loaded: candidates holding `null` follow. |

### Where it lives

```ts
// lib/logger/propagate-load.ts
export function propagateLoad(
  sets: readonly ExerciseSetDraft[],
  fromIndex: number,
  newKg: number | null,
): ExerciseSetDraft[]
```

Pure — no React, no clock, no I/O — and identity-preserving: returns the **same
array reference** when nothing propagates, and the same objects for sets it does
not touch, so `ExerciseCard`'s memo survives.

It is a `lib/` module rather than a helper inside the component because this
repo's vitest setup is node-environment and scans `lib/**/__tests__` only.
Anything in a `.tsx` is untestable by construction, and index arithmetic over a
set list is exactly the band that produced both must-fix bugs in the set-timing
arc. It sits beside [`apply-target.ts`](../../../lib/logger/apply-target.ts),
which answers the neighbouring "which set does the coach line write into?"
question.

### The seam

`patchSet` in `components/logger/ExerciseCard.tsx` applies propagation whenever
the incoming patch carries a `kg` key. Every kg write in the logger already
routes through it, so all three surfaces inherit the behaviour with no
per-surface code:

| Surface | Today | After |
|---|---|---|
| `SetRow` kg field blur | writes one set | writes the chain |
| `SetEntryRow` (post-set zoom) Save | writes one set | writes the chain |
| Coach-line one-tap apply | writes one later set | writes the chain from there |

The coach line is included deliberately. The intent behind "go up to 110" is
identical whether it is typed or tapped from Carter's suggestion; making the tap
stop short would be the surprising behaviour. It reaches propagation for free
because it already calls `patchSet(target, { kg })`.

**Edit mode is unaffected.** `hydrateWorkoutAsDraft` stamps `committed_at` on
every hydrated set, and the kg input is `disabled={committed}`, so no
propagation can fire while editing a saved workout.

### Supersets: intra-exercise only

Propagation is intra-exercise. Supersets are inter-exercise. `patchSet` operates
on one `ExerciseDraft`'s `sets`, and a group spans separate drafts, so the two
features do not interact.

**This is a rule, not an accident: propagation must never cross into a superset
partner.** Bumping the Arnold press does not touch the bicep curl. They are
independent loads that happen to share a round, and "helpfully" extending
propagation across a group would be a bug.

The hazard worth checking was propagating into a set already *performed* but not
yet committed — one with an open entry row, whose `work_seconds` and
`started_at` are already stamped. It is unreachable within a single exercise:
`ExerciseCard` resolves the open row as
`timer.pendingEntries.find((e) => e.exerciseIndex === exerciseIndex)`, at most
one per exercise, because `roundFromLead` picks at most one set per group
member. A downstream candidate is therefore always a set that has not happened
yet.

Consequently `propagateLoad` takes **no timer state**. The reasoning above goes
in the module header so a later reader does not add an unreachable guard — or,
worse, delete the reasoning and then add a reachable bug.

### Not in scope

- **Reps and RIR do not propagate.** Reps genuinely vary set to set under double
  progression, and RIR is an observation, not a plan.
- **No undo toast.** Every affected value is on screen and editable; a wrong
  propagation is one blur away from being fixed.

### Tests

`lib/logger/__tests__/propagate-load.test.ts`, in the fixture style of
`apply-target.test.ts`:

1. Plain increase from set 1 → all following working sets follow.
2. Mid-exercise increase (the set-2 case) → sets below follow, committed set
   above untouched.
3. Stop at a diverged back-off; sets below the stop untouched.
4. A warmup row between working sets is skipped, and does **not** break the
   chain.
5. A committed set between working sets is skipped, and does **not** break the
   chain.
6. Editing a warmup is a no-op.
7. `newKg === oldKg` is a no-op, and returns the same array reference.
8. Clearing the field (`newKg === null`) is a no-op.
9. `oldKg === null` anchors correctly — candidates holding `null` follow.
10. Editing the last set is a no-op (nothing below).

---

## Part 2 — Removing voice entry

The per-set 🎤 does not work reliably in practice. Rather than carry a dead
affordance, delete it.

### Deleted outright

- `components/logger/VoiceMicButton.tsx` — Web Speech API wrapper
- `lib/logger/parse-voice.ts` — regex parser
- `lib/logger/parse-voice-llm.ts` — Haiku 4.5 fallback
- `app/api/logger/parse-voice/route.ts` — the fallback's endpoint
- `scripts/parse-voice-smoke.mjs` — its CLI smoke check

Nothing else imports any of them. Removing the route also takes an Anthropic
call out of the mid-workout path.

### Edited

- **`SetRow.tsx`** — drop the import, the `onUnparsedVoice` prop, and the mic
  `<td>`.
- **`ExerciseCard.tsx`** — drop the `unparsedBanner` state, the amber
  "Heard … — type it instead?" banner, and the prop it passed down.

### The load-bearing detail: column count

The mic was a table **column**. Removing it changes the table's arity, and
`colSpan` mismatches do not error — the browser silently clips or pads.

| | Before | After |
|---|---|---|
| Rep-based row | Set, Target/prev, kg, Reps, RIR, ✓, 🎤 = **7** | **6** |
| Time-based row | Set, target, (blank), Seconds, ✓, 🎤 = **6** | **5** |

Three coordinated edits:

1. Both `<thead>` variants lose their trailing `<th></th>`.
2. The time-based row loses its trailing spacer `<td>` (the mic slot) — **not**
   the earlier blank `<td>` that holds the kg column's place.
3. `columnCount` becomes `timeBased ? 5 : 6`.

`columnCount` is the `colSpan` for the entry-row zoom, the coach line, and the
"Start this set" button. All three are verified against the headers after the
edit.

`SetEntryRow` is unaffected — it renders inside a full-width `colSpan` cell and
never had a mic.

### Documentation

`CLAUDE.md`'s in-app-workout-logger bullet loses its voice sentence; that file
is read as a description of current state.

Historical specs and plans under `docs/superpowers/` that describe voice stay
as they are. They are records of what was designed in May 2026, not live
documentation.

---

## Build order

Two commits, voice first:

1. **Remove voice.** It reshapes `SetRow` and `ExerciseCard`, so doing it first
   means propagation lands on the smaller files and the two changes stay
   separable in review.
2. **Add propagation.**

## Verification

- `npx vitest run` — the new fixture tests plus the existing logger suite.
- `npm run typecheck`.
- `npm run build` — non-negotiable here. This repo has no render-test harness
  (vitest is node-env, components are outside the test glob), so a
  component-level break passes both of the above and surfaces only in the
  production build.
- Exercise the logger locally: a plain increase on set 1, the mid-exercise
  bump, a back-off that must survive, and a Friday Arms superset round to
  confirm a bump on one member leaves its partner alone.
