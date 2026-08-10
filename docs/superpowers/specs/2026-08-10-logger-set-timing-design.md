# Logger set timing — design

**Date:** 2026-08-10
**Status:** Approved for planning

## Problem

The workout logger records *what* was lifted but not *when*. A set has no start
or end; `rest_seconds_actual` is back-derived from commit-to-commit timestamp
deltas, which measure rest **plus set execution** rather than rest — a fact
[rule-rest-discipline.ts](../../../lib/coach/live-session/rule-rest-discipline.ts)
already admits in its own header comment. Nothing anywhere captures how long
the athlete spent under load, so a 60-minute session and a 60-minute session
with twice the work density are indistinguishable to every downstream consumer.

Operationally the logger is also a two-handed device mid-set: to record a set
the athlete types into small inputs, and to time rest he reads a 3px progress
bar. There is no single control he can hit without looking.

Separately, the audio cue built to announce rest-end does not work. It
interrupts music playback indefinitely, and it only fires when the phone is
unlocked with the app foregrounded — precisely not the moment it is needed.

## Goals

1. Record true start and work duration for every set.
2. Accumulate work time across a session so density is analysable.
3. Give the logger one large, thumb-reachable control that drives the whole
   set/rest cycle.
4. Make `rest_seconds_actual` measure actual rest.
5. Remove the audio cue entirely.

## Non-goals

- Push notifications or any background alerting. The phone cannot wake itself
  for rest-end without a push infrastructure that does not exist here, and
  building one is out of scope. Rest-end signalling is visual only.
- Changing how loads are prescribed. This is a capture-layer change.
- Per-rep or tempo tracking. Work time is per-set.

## The core idea: back-date the set end

Every behaviour below derives from one constant and one anchor.

The athlete racks the bar, then picks up the phone, unlocks it, and taps stop.
That takes about five seconds, during which he is already resting. So:

```
PHONE_LAG_SECONDS = 5
set_ended_at = stop_press − PHONE_LAG_SECONDS
```

Two consequences fall out of the same fact:

- **Work time is honest.** `work_seconds = max(1, (stop_press − started_at) − 5)`.
  Without the correction every set inflates by ~5s; a 20-set session invents
  ~100s of work that never happened. Floored at 1s so a very short set cannot
  go negative.
- **Rest is anchored at the rack, not the tap.** The rest countdown seeds at
  `prescribed − 5`, because five seconds of rest have already elapsed by the
  time the stop press registers. A 3:00 prescription starts counting at 2:55.

The 5-second countdown at the *front* of a set is the athlete's walk-up to the
bar and is **not** counted as work. The work clock starts when the countdown
reaches zero.

## Interaction model

A single circular control docked above the sheet's bottom edge, always acting
on the active set. It is the only timing control in the logger; per-row timer
buttons and the thin rest bar are removed.

| Phase | Circle | Behaviour |
|---|---|---|
| `idle` | Green, `START` | Tap begins the countdown. |
| `countdown` | Amber, counts `5→1` | Tap skips to `running`. Work clock starts at zero. |
| `running` | Blue ring, work clock counting up, `STOP` | Tap stops the set. |
| `rest` | Green ring, counts down from `prescribed − 5` | Tap starts the next set early. |
| `rest`, past zero | **Solid red**, negative counter `−0:47` | Keeps counting; never auto-resets. |

Overtime is not its own phase — it is `rest` with elapsed past `restSeconds`,
so there is no transition to miss and no state to get stuck in.

The zoomed entry row is **not** a phase. It opens on stop and lives alongside
whatever the circle is doing: stopping a set starts rest *and* opens the zoom
in the same moment, and the athlete can start the next set with the zoom still
open. **Saving the set touches no timer.** Data entry is unhurried by
construction — the clock does not wait for typing, and typing does not steal
rest.

If the athlete never taps Save, pressing `START` for the next set auto-saves
whatever is in the fields. They are pre-filled from the prescription, so the
common case requires no typing at all and the flow can never deadlock on data
entry.

### The zoomed entry row

On stop, the active row inflates in place into a card carrying:

- The **set-type badge** at top-left (`W` / set number / `F`) with the existing
  popup, at a size that is hittable mid-session. Selecting `F` forces `rir = 0`
  and locks the field; leaving `F` releases it only when `rir` is still 0, so a
  hand-typed value survives badge fiddling. This is the coupling
  [SetRow.tsx `selectBadge`](../../../components/logger/SetRow.tsx) already
  implements — preserved exactly, rendered larger.
- A `◷ 0:33 work` chip showing the recorded work time.
- Large `kg` / `reps` / `RIR` fields, pre-filled from the prescription.
- A Save button, which writes the fields and collapses the row back to a normal
  committed row.

For a time-based exercise the three fields collapse to a single seconds field.

### Accumulated work time

The dock carries three counters for the whole session:

- **SESSION** — wall clock (existing elapsed timer)
- **WORK** — sum of every committed set's `work_seconds`
- **REST** — `SESSION − WORK`

Each committed row also keeps its own `0:33 work` stamp. The Finish summary
gains a work:rest ratio line.

## Data model — migration 0056

`exercise_sets` gains two nullable columns:

| Column | Meaning |
|---|---|
| `started_at timestamptz` | True set start — the moment the countdown hit zero. |
| `work_seconds int` | `max(1, stop_press − started_at − 5)`. |

`ended_at` is **not** stored; it is `started_at + work_seconds`. Session totals
derive by summing sets — no rollup column on `workouts`.

**`duration_seconds` is untouched.** It keeps its established "plank / carry /
hold duration" meaning, which
[derived.ts](../../../lib/coach/derived.ts) falls back to when no e1RM exists
and [snapshot.ts](../../../lib/coach/snapshot.ts) renders as `"45s hold"`.
Writing rep-set work time there would make the coach report a 38-second decline
bench hold. For a time-based exercise both columns are written and agree; for a
rep set only `work_seconds` is written.

`commit_logger_session` is re-declared to insert both columns, following the
same pattern as migration 0053.

Both columns are nullable and every consumer treats null as "not timed" — sets
logged by hand, Strong CSV imports, and all pre-migration rows behave
unchanged.

## `rest_seconds_actual` becomes real rest

With true anchors available, the value becomes:

```
rest_seconds_actual = next.started_at − (prev.started_at + prev.work_seconds)
```

Falling back to the existing commit-to-commit delta whenever either set lacks
timer data.

This changes the behaviour of a shipped coaching rule: `ruleRestDiscipline`
compares against `restPrescription(tier, reps).min * 0.6`, and its input was
previously inflated by set-execution time. The rule will now fire on genuinely
short rests it used to miss. This is the intended correction — the rule was
written against a proxy because nothing better existed. Its threshold constant
is unchanged.

## State architecture

Rest state currently lives **per-`ExerciseCard`**
([ExerciseCard.tsx](../../../components/logger/ExerciseCard.tsx):
`activeRestStartedAt`, `activeRestSeconds`, `restAfterSetIndex`). A
session-wide dock needs one owner, so this lifts to `LoggerSheet`, backed by a
new pure module `lib/logger/set-timer.ts`:

```ts
type SetRef = { exerciseIndex: number; setIndex: number };

type TimerState = {
  phase: 'idle' | 'countdown' | 'running' | 'rest';
  /** Absolute epoch ms the current phase started. Null when idle. */
  anchorMs: number | null;
  /** The set `phase` applies to: counting down / lifting / resting before. */
  activeSet: SetRef | null;
  /** prescribed − PHONE_LAG, for the rest currently running. */
  restSeconds: number;
  /** Zoomed entry row, open independently of `phase`. Null when closed. */
  pendingEntry: (SetRef & { workSeconds: number }) | null;
};
```

`pendingEntry` is deliberately **not** a phase. Entry and rest are concurrent,
and modelling entry as a phase value would make them mutually exclusive —
exactly the coupling this design removes. Saving writes the set and clears
`pendingEntry`, leaving `phase` untouched.

Overtime is likewise not a stored phase — it is `phase === 'rest'` with elapsed
past `restSeconds`, so there is no transition to miss or to get stuck in.

**No ticking value crosses a component boundary.** A clock passed down as a
prop would re-render every memoized `ExerciseCard` four times a second. The
reducer stores only absolute epoch anchors; each clock-displaying component
ticks locally off `Date.now() − anchor`, which is how `SetRow` already handles
its plank timer. Only the dock and the single active row re-render on tick.

This also makes backgrounding correct for free: nothing accumulates ticks, so a
locked screen or a backgrounded tab resumes at the right value rather than
drifting.

### Draft survival

`LoggerDraft` gains `timer: TimerState | null`, mirrored to IndexedDB with the
rest of the draft (12h TTL). Because anchors are absolute epoch ms, a reload
mid-set resumes the running clock exactly.

## Removing the audio cue

Deleted outright:

- `lib/logger/audio-cue.ts` (342 lines)
- `lib/logger/__tests__/audio-cue.test.ts` (283 lines)
- `components/profile/SoundCheckSection.tsx` (101 lines) and its mount in
  `ProfileClient.tsx` — a diagnostic surface built solely to chase this bug

Call sites cleared: `RestBar.tsx` (rest done), `SetRow.tsx` (plank target
reached), `ExerciseCard.tsx` (PR), `LoggerSheet.tsx` (`onPointerDown={unlockCue}`),
and the explanatory comment block in `rest-timer.ts`.

`CoachLine.cue` (boolean) is **kept** and repurposed from "play a sound" to
"emphasise visually". Existing tests asserting `cue === true` on PRs stay valid.

Unrelated and untouched: `PlannedExercise.cue` / `annotated.cue` are coaching
*text* strings rendered in `BriefSessionList` and `TodayPlanCard`. Different
concept, same word.

Rest-end signalling is now entirely visual: the circle flips solid red, the
counter goes negative, and the pending row turns red.

## What is preserved

- The manual `○` commit path. The timer is additive; a set can still be logged
  by hand, leaving `work_seconds` null.
- **Edit mode** runs no live timer. `work_seconds` and `started_at` are
  preserved from the hydrated row, the same preserved-across-edit pattern
  already used for `duration_min` and `session_started_at`.
- Voice entry, previous-set hints, the exercise menu, reorder, and
  save-as-default are unaffected.

## Edge cases

| Case | Behaviour |
|---|---|
| Set shorter than 5s | `work_seconds` floors at 1. |
| Rest prescription ≤ 5s | Seeds at 1s rather than 0 or negative. |
| Session pause during countdown/running | Pause control is disabled — pausing mid-set is meaningless. |
| Session pause during rest | Freezes the rest clock along with the session clock. |
| Uncommitting a timed set | Clears `work_seconds` and `started_at`; timer returns to `idle`. |
| Phone locked mid-rest | Clock is anchor-derived, so it reads correctly on unlock, including deep into overtime. |
| Switching exercises mid-rest | Rest keeps running; the dock continues to name the set it belongs to. |

## Verification

`lib/logger/set-timer.ts` is pure and gets real vitest coverage: reducer
transitions, the 5s back-dating, the 1s floor, rest-anchor math, the
overtime-as-derived-state property, and the `rest_seconds_actual` fallback when
timer data is absent.

Components cannot be unit-tested — vitest here is node-environment and scoped to
`lib/**/__tests__`, with no render harness. `npm run build` is therefore
**mandatory** before claiming completion, because hook-ordering faults surface
only in a production build.

Full gate: `npm run typecheck` + `npx vitest run` + `npm run build`, then
exercise a real session on a phone — start a set, background the app mid-rest,
return past the 3:00 mark, and confirm the counter reads correctly negative.
