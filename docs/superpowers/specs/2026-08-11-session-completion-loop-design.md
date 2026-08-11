# Session completion loop — design

**Date:** 2026-08-11
**Status:** approved, pending implementation

## Problem

On 2026-08-11 all three coaches opened the day by telling the athlete he had
skipped Monday's Legs session. He had not: `workouts` carries a 55-minute Legs
row for `2026-08-10` with a squat PR, and Carter had already written a debrief
card for it the previous morning.

The cause is a single wrong column name. `fetchOpenerContext`
([lib/coach/opener.ts](../../../lib/coach/opener.ts)) reads:

```ts
.from("workouts").select("session_type")
```

The column is `type`. PostgREST answers `42703 column workouts.session_type
does not exist` with HTTP 400, and the call site never inspects `.error` — it
reads `.data`, gets `null`, and sets `yesterdayTrained: null`. The context
block then renders

```
YESTERDAY: planned Legs, no session logged
```

and Haiku turns that into "You missed legs yesterday." A schema error
degraded into a confident false accusation, in three separate coach threads,
with nothing logged anywhere.

Verified against production data:

| query | result |
| --- | --- |
| `select session_type ... date=2026-08-10` | `{"code":"42703", ...}`, `data: null` |
| `select type ... date=2026-08-10` | `{"type":"Legs"}` |

`fetchOpenerContext` is the only bad read in the codebase; the snapshot
(`loadWorkouts`) and the morning brief both use `type` and were correct
throughout — the 2026-08-11 brief recorded `trained_yesterday: "Legs"`.
[recent-workouts-discovery.ts:9](../../../lib/coach/prescription/recent-workouts-discovery.ts)
already carries a warning comment about exactly this trap.

Beyond the bug, finishing a session propagates nowhere in the UI. The plan
card still says "Start session" after you have trained, the home tab's brief
gives no indication the day's work is done, and a session saved by mistake has
no removal path at all.

## Scope

Four outcomes, requested by the athlete:

1. All coaches are aware a session was completed.
2. The debrief is generated. *(Already works — no change.)*
3. The home tab's Today card reflects the completed session.
4. Today's session card shows as done, with a way to undo a session saved by
   mistake.

## Part 1 — Coach awareness

### 1.1 Fix the read, and make it fail loudly

`fetchOpenerContext` selects `type`. Every one of its five queries checks
`.error` and surfaces it rather than folding a failure into a `null` that
reads as an athlete behaviour. A missing column must not be expressible as
"you skipped your session".

The `.order("started_at", ...)` on the workouts query keeps `nullsFirst:
false`: `started_at` is nullable for pre-0053 logger rows and Strong imports,
and Postgres sorts NULLs first under `DESC` by default, which would prefer an
untimed row over a timed one on a two-session day.

### 1.2 Refresh the opener after a session

Each coach's opener is written once per thread per rolling 18h window, on
first chat open — typically ~04:30, hours before training. It never rewrites
itself, so a morning opener can never mention the session that follows it.

On session commit, the day's opener row in each of the four coach threads
(`peter`, `carter`, `nora`, `remi`) is deleted **only when the athlete has not
engaged the thread since local day start** — no `role: "user"` turn of
`kind: "coach"` in that thread today. The next visit to that coach regenerates
an opener that knows about the session.

The "no engagement" condition is the whole safety property, and it cannot be
read off `role === "user"` alone. The turn-creating RPC never stamps `kind` on
the assistant row it inserts (the column defaults to `'coach'`), so an
ordinary assistant reply is byte-identical to an opener on `(kind, role)` — a
"newest row is a coach/assistant row" check deletes the athlete's actual
answer, not a stale greeting, the moment the athlete replies and gets a
response. The kind scoping matters just as much: the morning-intake bot
echoes the athlete's check-in answers as `role: "user", kind: "morning_intake"`
rows in the `remi` thread, and every athlete who checks in produces one of
these daily — counting it as engagement would permanently disable Remi's
opener refresh. Non-coach *assistant* rows (e.g. a `workout_debrief` card)
still block clearing via the "newest remaining row" check: once any card has
landed in the thread, the greeting is history and there's nothing left to
regenerate for.

This runs in `POST /api/logger/session` alongside `evaluateAndStampTargetHit`
and `repatchRemainingWeek`, and is non-fatal in the same way — a failure here
costs a stale greeting, never the commit.

Deliberately **not** doing: writing a "session done" card into all four
threads. That is four near-duplicate notifications on top of the debrief card
the athlete already receives.

## Part 2 — Done state on the session cards

### 2.1 One hook, two consumers

`useTodaySessionStatus(userId, date)` resolves to a discriminated status:

- `logged` — a committed `workouts` row exists for the date, plus its summary
  (`workout_id`, `type`, `duration_min`, exercise count)
- `draft` — an uncommitted IndexedDB draft exists (existing
  `useExistingLoggerDraft`)
- `none`

Both states can hold at once (commit, then start a new draft); the card
renders both affordances rather than picking one.

Two consumers: [TodayPlanCard](../../../components/strength/TodayPlanCard.tsx)
on `/strength` and
[BriefSessionList](../../../components/morning/BriefSessionList.tsx) inside
the morning brief card on the home tab. Both already mount `LoggerSheet` and
both already call `useExistingLoggerDraft`; routing both through one hook is
what stops the two surfaces from disagreeing about whether the day is done.

### 2.2 What `logged` renders

A completion line — `✓ Chest logged · 50 min · 6 exercises` — linking to
`/coach/sessions/<workout_id>` for the debrief.

The single "Start session" button becomes up to three:

| action | behaviour |
| --- | --- |
| **Modify** | Reopens the logger on the saved session. Reuses the existing [EditSessionButton](../../../components/logger/EditSessionButton.tsx) hydration path (`hydrateWorkoutAsDraft` + `editMode`) — no new edit mechanism. |
| **Resume** | Shown only when an uncommitted draft also exists. Current behaviour, unchanged. |
| **Restart** | Part 3. |

## Part 3 — Restart: full unwind

`DELETE /api/logger/session/[workout_id]`, behind a confirm dialog that names
what will be removed.

A commit is not an isolated write. Two engine effects fire with it, and
neither reverses on its own:

- `repatchRemainingWeek` rewrites the rest of the week's prescribed loads —
  this is the `↻ Plan updated: Friday` line on the debrief cards.
- `evaluateAndStampTargetHit` stamps `training_blocks.target_hit_at_week`, and
  [only ever stamps](../../../lib/coach/prescription/target-hit-evaluator.ts).
  It early-returns whenever the block is already stamped.

So deleting only the row would leave the engine believing a PR happened. A
phantom `target_hit_at_week` flips the block into consolidation permanently,
and consolidation refuses further load increases on the primary lift for the
rest of the block. Undo has to reach the engine.

Order of operations:

1. Verify ownership and `source = 'logger'`. Strong CSV imports are not
   deletable through this path.
2. Clear `target_hit_at_week` on the active block.
3. Delete the `workouts` row. `exercises` and `exercise_sets` cascade
   (`schema.sql:60,67`).
4. Delete the `chat_messages` row with `kind='workout_debrief'` and
   `ui->>workout_id` matching.
5. Re-run `evaluateAndStampTargetHit`. A genuine crossing from a surviving
   session re-stamps; a phantom one does not.
6. Re-run `repatchRemainingWeek` so the remaining days recompute without the
   deleted session.

Steps 5 and 6 are ordered as they are for the same reason the commit path
orders them that way: a target-hit state change must settle before the week is
recomputed against it.

**Why the clear precedes the delete.** An earlier draft of this spec grouped
the clear with the re-evaluation, after the delete. Review found that ordering
leaves one unrecoverable state: if the request dies between the delete and the
clear, the workout is gone but the phantom stamp survives, the evaluator
early-returns on it forever, and the block stays locked in consolidation for
the rest of its run. Retrying the DELETE cannot repair it — the workout row no
longer exists, so the retry 404s before reaching the re-evaluation, and only a
manual database edit would clear it.

Clearing first removes the state rather than documenting it. The clear is safe
and idempotent in isolation: if the delete then fails, the block is momentarily
un-consolidated and the next ordinary commit re-stamps the identical value from
the surviving data — `pickQualifyingDate` picks the earliest qualifying date
and `blockWeekOf` derives the week from `start_date`, so the re-stamp is
deterministic. The symmetric failure (cleared, delete succeeded, re-evaluation
died) is likewise self-healing, because the evaluator's early return tests
`target_hit_at_week != null` and so does not fire on a cleared block. Both
surviving failure modes err toward an unlocked block rather than a falsely
locked one, which is the right direction: a missing consolidation lock costs
one session of load progression, a phantom one costs the rest of the block.

Nothing else needs unwinding. The logger writes no `daily_logs` columns —
strain is Garmin-owned — so day-level aggregates are unaffected.

## Testing

vitest runs node-environment over `lib/**/__tests__/**/*.test.ts` only, so
components are not reachable. Coverage goes on the pure and server seams:

- `fetchOpenerContext` returns the logged session type for a date with a
  committed workout — the exact case that broke — and surfaces query errors
  instead of returning `null`.
- The opener-clearing predicate: clears an untouched opener, preserves one the
  athlete has replied to.
- The block-week derivation the unwind depends on: a session on `start_date` is
  week 1, `start_date + 7d` is week 2, a date before the block start clamps to
  1, and the earliest qualifying date wins.

The unwind's step ordering is not unit-testable — it is a property of the route
handler, and vitest cannot reach `app/`. It is verified by typecheck and by the
manual walk in the plan's final task. Card states are verified the same way,
per the standing constraint that this repo has no render-test harness.

## Deliberate exclusions

- No push notifications on completion.
- No "session done" cards in the coach threads (§1.2).
- No undo for Strong CSV imports (§3, step 1).
- No change to debrief generation, which already works.
