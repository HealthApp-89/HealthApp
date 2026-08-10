# Logger Set Timing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture true start and work duration for every logged set, drive the whole set/rest cycle from one docked circular control, and delete the broken audio cue.

**Architecture:** A pure reducer module (`lib/logger/set-timer.ts`) owns the timer state machine and every time derivation; `LoggerSheet` holds one instance of that state for the whole session and passes only absolute epoch anchors downward, so no ticking value ever crosses a memo boundary. A single constant `PHONE_LAG_SECONDS = 5` back-dates each set's end to the moment the bar was racked, from which both honest work time and the rest countdown seed derive.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript (strict), Tailwind v4, Supabase (Postgres + RLS), vitest (node environment), IndexedDB via `idb`.

**Spec:** [docs/superpowers/specs/2026-08-10-logger-set-timing-design.md](../specs/2026-08-10-logger-set-timing-design.md)

## Global Constraints

- `PHONE_LAG_SECONDS = 5` and `COUNTDOWN_SECONDS = 5`. Both live in `lib/logger/set-timer.ts` and are imported everywhere else — never re-declared or inlined.
- `work_seconds` floors at **1**. `restSeedSeconds` floors at **1**. Neither may be 0 or negative.
- The **5-second countdown is not work.** The work clock anchors at countdown end, not at the START tap.
- `exercise_sets.duration_seconds` keeps its existing "plank / carry / hold duration" meaning. Never write rep-set work time to it.
- Every new DB column is **nullable**; every consumer treats null as "not timed". Pre-migration rows, hand-logged sets, and Strong CSV imports must behave exactly as before.
- **No ticking value may be passed as a prop into `ExerciseCard`** (it is `memo`-wrapped; a per-tick prop re-renders every card 4×/second). Components that display a clock own their own `setInterval` and read `Date.now() - anchorMs`.
- Never call `new Date().toISOString().slice(0,10)` or `d.getHours()` — repo-wide rule enforced by `scripts/audit-timezone-usage.mjs`.
- User-visible numbers use `fmtNum()` from `lib/ui/score.ts`. Clock strings (`m:ss`) are exempt — they use the local `fmtMmSs` helpers.
- Next free migration slot is **0056**.
- Verification gate for every task: `npm run typecheck` + `npx vitest run`. Tasks 5–9 additionally require `npm run build` (vitest is node-environment and scans `lib/**/__tests__` only — component hook-order faults surface *only* in a production build).

---

### Task 1: Remove the audio cue

Pure deletion, no dependencies. Done first so later tasks aren't dragging dead imports through the files they touch.

**Files:**
- Delete: `lib/logger/audio-cue.ts` (342 lines)
- Delete: `lib/logger/__tests__/audio-cue.test.ts` (283 lines)
- Delete: `components/profile/SoundCheckSection.tsx` (101 lines)
- Modify: `components/profile/ProfileClient.tsx:28` (import), `:198` (mount)
- Modify: `components/logger/RestBar.tsx:5,18`
- Modify: `components/logger/SetRow.tsx:9,71,80-86,146`
- Modify: `components/logger/ExerciseCard.tsx:13,98`
- Modify: `components/logger/LoggerSheet.tsx:13,527-530`
- Modify: `lib/logger/rest-timer.ts:79-82` (comment block)

**Interfaces:**
- Consumes: nothing.
- Produces: `fireCue` / `unlockCue` / `releaseCue` no longer exist. `CoachLine.cue` (boolean) survives untouched — it now means "emphasise visually" rather than "play a sound".

**Do NOT touch:** `PlannedExercise.cue` / `annotated.cue` in `lib/coach/session-structure/annotate.ts`, `components/morning/BriefSessionList.tsx`, `components/strength/TodayPlanCard.tsx`. Those are coaching **text** strings — same word, unrelated concept.

- [ ] **Step 1: Delete the three files**

```bash
cd "/Users/abdelouahedelbied/Health app"
rm lib/logger/audio-cue.ts lib/logger/__tests__/audio-cue.test.ts components/profile/SoundCheckSection.tsx
```

- [ ] **Step 2: Unmount the sound check from the profile page**

In `components/profile/ProfileClient.tsx`, delete the import line:

```tsx
import { SoundCheckSection } from "@/components/profile/SoundCheckSection";
```

and delete the mount (line ~198):

```tsx
        <SoundCheckSection />
```

- [ ] **Step 3: Clear the RestBar call site**

In `components/logger/RestBar.tsx`, delete the import of `fireCue` and change the `onDone` wrapper so it no longer fires a cue:

```tsx
  const { remaining_seconds, elapsed_seconds, isRunning } = useRestCountdown({
    duration_seconds,
    started_at,
    onDone,
  });
```

- [ ] **Step 4: Clear the SetRow call site**

In `components/logger/SetRow.tsx`, delete the `fireCue` import, the `cueFiredRef` declaration, the whole `useEffect` that fires the cue at target reach (lines ~80-86), and the `cueFiredRef.current = false;` line inside `onStart`. `onStart` becomes:

```tsx
    const onStart = () => {
      setTimerStartedAt(Date.now());
    };
```

- [ ] **Step 5: Clear the ExerciseCard call site**

In `components/logger/ExerciseCard.tsx`, delete the `fireCue` import and the line `if (line?.cue) fireCue();` at the end of `commitSet`. Leave `setCoachLine(line)` and `setCoachLineSetIndex(...)` exactly as they are.

- [ ] **Step 6: Clear the LoggerSheet call site**

In `components/logger/LoggerSheet.tsx`, delete the `import { unlockCue, releaseCue }` line and remove the `onPointerDown` handler together with its four-line explanatory comment, leaving:

```tsx
    <div className="fixed inset-0 bg-black z-40 flex flex-col">
```

Also search the file for any other `releaseCue()` call (there is one in the close/cleanup path) and delete it.

- [ ] **Step 7: Fix the stale comment in rest-timer.ts**

Replace the comment block at `lib/logger/rest-timer.ts:79-82` with:

```ts
// Rest-end signalling is visual only. An audio cue was tried and removed: on
// iOS it ducked background music indefinitely and it only fired when the phone
// was already unlocked with the app foregrounded — precisely not the moment it
// was needed. Waking a locked phone needs push infrastructure this app has not
// got, so the dock goes red instead.
```

- [ ] **Step 8: Verify nothing references the deleted module**

Run:

```bash
cd "/Users/abdelouahedelbied/Health app" && grep -rn "fireCue\|unlockCue\|releaseCue\|audio-cue\|SoundCheckSection" --include="*.ts" --include="*.tsx" lib components app
```

Expected: **no output**.

- [ ] **Step 9: Run the full gate**

```bash
cd "/Users/abdelouahedelbied/Health app" && npm run typecheck && npx vitest run && npm run build
```

Expected: all pass. The vitest suite loses the 283-line audio-cue file; every other test still passes.

- [ ] **Step 10: Commit**

```bash
git add -A && git commit -m "feat(logger): remove the audio cue

It ducked background music indefinitely and only fired with the phone
unlocked and the app foregrounded — never at the moment rest actually
ended. Rest-end signalling becomes visual only. Deletes 726 lines
including the /profile sound-check section built to diagnose it.

CoachLine.cue survives as a visual-emphasis flag."
```

---

### Task 2: Migration 0056 — `started_at` + `work_seconds`

**Files:**
- Create: `supabase/migrations/0056_set_timing.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: `exercise_sets.started_at timestamptz` (nullable), `exercise_sets.work_seconds int` (nullable). `commit_logger_session(payload jsonb)` now reads `st->>'started_at'` and `st->>'work_seconds'` from each set object.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0056_set_timing.sql`. The function body is byte-identical to 0053's except the `exercise_sets` INSERT gains two columns:

```sql
-- 0056_set_timing.sql
--
-- Adds per-set timing to exercise_sets:
--   started_at  — true set start: the moment the logger's 5s countdown hit
--                 zero. NOT the START tap (that 5s is the walk-up to the bar).
--   work_seconds— honest time under load: (stop_press - started_at) - 5s.
--
-- The 5s deduction is PHONE_LAG_SECONDS (lib/logger/set-timer.ts): the athlete
-- racks the bar, then picks up the phone, unlocks it, and taps stop. He is
-- already resting during those seconds. Back-dating the set end by 5s makes
-- work time honest AND anchors the rest countdown at the rack rather than the
-- tap — the same fact seen from two sides. Floored at 1s.
--
-- duration_seconds is deliberately NOT reused: lib/coach/derived.ts falls back
-- to it when no e1RM exists and lib/coach/snapshot.ts renders it as "45s hold".
-- Writing rep-set work time there would make the coach report a 38-second
-- decline bench hold. Time-based exercises write both columns (they agree);
-- rep-based sets write only work_seconds.
--
-- Both nullable: hand-logged sets, Strong CSV imports, and all pre-0056 rows
-- stay NULL and every consumer treats NULL as "not timed".

alter table public.exercise_sets add column if not exists started_at timestamptz;
alter table public.exercise_sets add column if not exists work_seconds int;

comment on column public.exercise_sets.started_at is
  'True set start (logger countdown end). NULL for hand-logged sets, Strong CSV imports, and pre-0056 rows.';
comment on column public.exercise_sets.work_seconds is
  'Time under load in seconds: (stop_press - started_at) - 5s phone lag, floored at 1. NULL when the set was not timed.';

-- Re-declare commit_logger_session to persist both. Body is identical to 0053
-- except the exercise_sets INSERT column list and VALUES list.
create or replace function public.commit_logger_session(payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  payload_user_id uuid;
  new_workout_id  uuid;
  ex              jsonb;
  st              jsonb;
  new_exercise_id uuid;
begin
  payload_user_id := (payload->>'user_id')::uuid;

  -- Defence: caller must match the authenticated user.
  if auth.uid() is null or auth.uid() <> payload_user_id then
    raise exception 'commit_logger_session: auth.uid() mismatch';
  end if;

  -- Defensive shape checks.
  if jsonb_array_length(payload->'exercises') > 30 then
    raise exception 'commit_logger_session: too many exercises (>30)';
  end if;

  -- workouts row.
  insert into workouts (
    user_id, external_id, date, type, duration_min, started_at, source, created_at
  ) values (
    payload_user_id,
    payload->>'external_id',
    (payload->>'date')::date,
    payload->>'type',
    nullif(payload->>'duration_min', '')::int,
    nullif(payload->>'started_at', '')::timestamptz,
    'logger',
    now()
  )
  on conflict (user_id, external_id) where external_id is not null do update
    set type = excluded.type,
        duration_min = excluded.duration_min,
        started_at = excluded.started_at
  returning id into new_workout_id;

  -- Clear any pre-existing exercises for this workout (idempotent retry).
  delete from exercises where workout_id = new_workout_id;

  -- Exercises + sets.
  for ex in select * from jsonb_array_elements(payload->'exercises') loop
    if jsonb_array_length(ex->'sets') > 30 then
      raise exception 'commit_logger_session: too many sets for one exercise (>30)';
    end if;

    insert into exercises (workout_id, name, position)
    values (
      new_workout_id,
      ex->>'name',
      (ex->>'position')::int
    )
    returning id into new_exercise_id;

    for st in select * from jsonb_array_elements(ex->'sets') loop
      insert into exercise_sets (
        exercise_id, set_index, kg, reps, duration_seconds, warmup, failure,
        rest_seconds_actual, rir, started_at, work_seconds
      ) values (
        new_exercise_id,
        (st->>'set_index')::int,
        nullif(st->>'kg', '')::numeric,
        nullif(st->>'reps', '')::int,
        nullif(st->>'duration_seconds', '')::int,
        coalesce((st->>'warmup')::boolean, false),
        coalesce((st->>'failure')::boolean, false),
        nullif(st->>'rest_seconds_actual', '')::int,
        nullif(st->>'rir', '')::smallint,
        nullif(st->>'started_at', '')::timestamptz,
        nullif(st->>'work_seconds', '')::int
      );
    end loop;
  end loop;

  return new_workout_id;
end;
$$;

revoke all on function public.commit_logger_session(jsonb) from public;
grant execute on function public.commit_logger_session(jsonb) to authenticated;
```

- [ ] **Step 2: Apply the migration**

```bash
cd "/Users/abdelouahedelbied/Health app" && supabase db push
```

Expected: `0056_set_timing.sql` applies cleanly. The CLI is linked (project ref `eopfwwergisvskxqvsqe`) and migration history was reconciled on 2026-07-09, so plain `db push` works.

- [ ] **Step 3: Verify the columns exist**

```bash
cd "/Users/abdelouahedelbied/Health app" && supabase db push --dry-run
```

Expected: reports no pending migrations.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0056_set_timing.sql && git commit -m "feat(db): add exercise_sets.started_at + work_seconds (0056)

Per-set timing for the logger's docked timer. work_seconds is time under
load with the 5s phone-lag deducted; started_at is the countdown end, not
the START tap. Both nullable — untimed sets stay NULL.

duration_seconds is left alone: the coach layer reads it as hold duration."
```

---

### Task 3: `lib/logger/set-timer.ts` — the pure state machine

The heart of the feature, and the only part that gets real test coverage. Full TDD.

**Files:**
- Create: `lib/logger/set-timer.ts`
- Test: `lib/logger/__tests__/set-timer.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `PHONE_LAG_SECONDS: 5`, `COUNTDOWN_SECONDS: 5`
  - `type SetRef = { exerciseIndex: number; setIndex: number }`
  - `type TimerPhase = "idle" | "countdown" | "running" | "rest"`
  - `type TimerState = { phase; anchorMs: number|null; activeSet: SetRef|null; restSeconds: number; pendingEntry: (SetRef & {workSeconds:number})|null }`
  - `IDLE_TIMER: TimerState`
  - `timerReducer(state: TimerState, action: TimerAction): TimerState`
  - `workSecondsFor(startAnchorMs, stopPressMs): number`
  - `restSeedSeconds(prescribedRestSeconds): number`
  - `countdownRemaining(state, nowMs): number`
  - `elapsedWorkSeconds(state, nowMs): number`
  - `restRemaining(state, nowMs): number` — **signed**; negative means overtime
  - `isRestOvertime(state, nowMs): boolean`
  - `sameSet(a: SetRef|null, b: SetRef|null): boolean`

- [ ] **Step 1: Write the failing test file**

Create `lib/logger/__tests__/set-timer.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  PHONE_LAG_SECONDS,
  COUNTDOWN_SECONDS,
  IDLE_TIMER,
  timerReducer,
  workSecondsFor,
  restSeedSeconds,
  countdownRemaining,
  elapsedWorkSeconds,
  restRemaining,
  isRestOvertime,
  sameSet,
  type TimerState,
} from "@/lib/logger/set-timer";

const T0 = 1_700_000_000_000; // fixed epoch ms; no Date.now() in tests
const SET_A = { exerciseIndex: 0, setIndex: 1 };
const SET_B = { exerciseIndex: 0, setIndex: 2 };

/** Drive the machine to `running` with the set start anchored at `startMs`. */
function running(startMs: number): TimerState {
  const s1 = timerReducer(IDLE_TIMER, { type: "press_start", set: SET_A, nowMs: startMs - COUNTDOWN_SECONDS * 1000 });
  return timerReducer(s1, { type: "countdown_elapsed", nowMs: startMs });
}

describe("constants", () => {
  it("pins the phone lag and countdown at 5s each", () => {
    expect(PHONE_LAG_SECONDS).toBe(5);
    expect(COUNTDOWN_SECONDS).toBe(5);
  });
});

describe("workSecondsFor", () => {
  it("deducts the phone lag from raw elapsed", () => {
    // 38s on the clock, 5s of which was fumbling for the phone.
    expect(workSecondsFor(T0, T0 + 38_000)).toBe(33);
  });

  it("floors at 1 for a set shorter than the lag", () => {
    expect(workSecondsFor(T0, T0 + 3_000)).toBe(1);
  });

  it("floors at 1 when start and stop coincide", () => {
    expect(workSecondsFor(T0, T0)).toBe(1);
  });

  it("truncates sub-second remainders rather than rounding up", () => {
    expect(workSecondsFor(T0, T0 + 38_900)).toBe(33);
  });
});

describe("restSeedSeconds", () => {
  it("seeds a 3:00 prescription at 2:55", () => {
    expect(restSeedSeconds(180)).toBe(175);
  });

  it("floors at 1 for a prescription at or below the lag", () => {
    expect(restSeedSeconds(5)).toBe(1);
    expect(restSeedSeconds(3)).toBe(1);
    expect(restSeedSeconds(0)).toBe(1);
  });
});

describe("timerReducer — press_start", () => {
  it("moves idle to countdown and records the set", () => {
    const s = timerReducer(IDLE_TIMER, { type: "press_start", set: SET_A, nowMs: T0 });
    expect(s.phase).toBe("countdown");
    expect(s.anchorMs).toBe(T0);
    expect(s.activeSet).toEqual(SET_A);
  });

  it("clears a pending entry (the caller persists it first)", () => {
    const stopped = timerReducer(running(T0), {
      type: "press_stop", nowMs: T0 + 38_000, prescribedRestSeconds: 180,
    });
    expect(stopped.pendingEntry).not.toBeNull();
    const restarted = timerReducer(stopped, { type: "press_start", set: SET_B, nowMs: T0 + 60_000 });
    expect(restarted.pendingEntry).toBeNull();
  });

  it("is ignored while a set is already running", () => {
    const r = running(T0);
    expect(timerReducer(r, { type: "press_start", set: SET_B, nowMs: T0 + 1_000 })).toBe(r);
  });
});

describe("timerReducer — countdown_elapsed", () => {
  it("anchors the work clock at countdown end, not at the START tap", () => {
    const s1 = timerReducer(IDLE_TIMER, { type: "press_start", set: SET_A, nowMs: T0 });
    const s2 = timerReducer(s1, { type: "countdown_elapsed", nowMs: T0 + 5_000 });
    expect(s2.phase).toBe("running");
    expect(s2.anchorMs).toBe(T0 + 5_000);
  });

  it("is ignored from any phase but countdown", () => {
    const r = running(T0);
    expect(timerReducer(r, { type: "countdown_elapsed", nowMs: T0 + 1_000 })).toBe(r);
    expect(timerReducer(IDLE_TIMER, { type: "countdown_elapsed", nowMs: T0 })).toBe(IDLE_TIMER);
  });
});

describe("timerReducer — press_stop", () => {
  it("anchors rest at the rack, five seconds before the stop press", () => {
    const s = timerReducer(running(T0), {
      type: "press_stop", nowMs: T0 + 38_000, prescribedRestSeconds: 180,
    });
    expect(s.phase).toBe("rest");
    expect(s.anchorMs).toBe(T0 + 38_000 - PHONE_LAG_SECONDS * 1000);
    expect(s.restSeconds).toBe(175);
  });

  it("opens a pending entry carrying the honest work time", () => {
    const s = timerReducer(running(T0), {
      type: "press_stop", nowMs: T0 + 38_000, prescribedRestSeconds: 180,
    });
    expect(s.pendingEntry).toEqual({ ...SET_A, workSeconds: 33 });
  });

  it("is ignored when no set is running", () => {
    expect(
      timerReducer(IDLE_TIMER, { type: "press_stop", nowMs: T0, prescribedRestSeconds: 180 }),
    ).toBe(IDLE_TIMER);
  });
});

describe("timerReducer — save_entry", () => {
  it("clears the entry without disturbing the running rest clock", () => {
    const rest = timerReducer(running(T0), {
      type: "press_stop", nowMs: T0 + 38_000, prescribedRestSeconds: 180,
    });
    const saved = timerReducer(rest, { type: "save_entry" });
    expect(saved.pendingEntry).toBeNull();
    expect(saved.phase).toBe("rest");
    expect(saved.anchorMs).toBe(rest.anchorMs);
    expect(saved.restSeconds).toBe(rest.restSeconds);
  });
});

describe("timerReducer — clear_for_set", () => {
  it("returns to idle when the cleared set is the active one", () => {
    const s = timerReducer(running(T0), { type: "clear_for_set", set: SET_A });
    expect(s).toEqual(IDLE_TIMER);
  });

  it("leaves state alone when a different set is cleared", () => {
    const r = running(T0);
    expect(timerReducer(r, { type: "clear_for_set", set: SET_B })).toBe(r);
  });
});

describe("timerReducer — reset", () => {
  it("returns to idle from any phase", () => {
    expect(timerReducer(running(T0), { type: "reset" })).toEqual(IDLE_TIMER);
  });
});

describe("derivations", () => {
  it("counts the countdown down and clamps at zero", () => {
    const s = timerReducer(IDLE_TIMER, { type: "press_start", set: SET_A, nowMs: T0 });
    expect(countdownRemaining(s, T0)).toBe(5);
    expect(countdownRemaining(s, T0 + 2_400)).toBe(3);
    expect(countdownRemaining(s, T0 + 9_000)).toBe(0);
  });

  it("counts work time up from the anchor", () => {
    const r = running(T0);
    expect(elapsedWorkSeconds(r, T0)).toBe(0);
    expect(elapsedWorkSeconds(r, T0 + 27_400)).toBe(27);
  });

  it("returns signed rest remaining so overtime is negative", () => {
    const rest = timerReducer(running(T0), {
      type: "press_stop", nowMs: T0 + 38_000, prescribedRestSeconds: 180,
    });
    const stopPress = T0 + 38_000;
    // 5s already elapsed at the moment of the press.
    expect(restRemaining(rest, stopPress)).toBe(170);
    expect(isRestOvertime(rest, stopPress)).toBe(false);
    // 175s of countdown from the rack = 170s after the press.
    expect(restRemaining(rest, stopPress + 170_000)).toBe(0);
    expect(restRemaining(rest, stopPress + 217_000)).toBe(-47);
    expect(isRestOvertime(rest, stopPress + 217_000)).toBe(true);
  });

  it("reports zero for derivations that do not apply to the current phase", () => {
    expect(countdownRemaining(running(T0), T0)).toBe(0);
    expect(elapsedWorkSeconds(IDLE_TIMER, T0)).toBe(0);
    expect(restRemaining(IDLE_TIMER, T0)).toBe(0);
    expect(isRestOvertime(IDLE_TIMER, T0)).toBe(false);
  });

  it("stays correct across a long background gap (anchor-derived, not accumulated)", () => {
    const rest = timerReducer(running(T0), {
      type: "press_stop", nowMs: T0 + 38_000, prescribedRestSeconds: 180,
    });
    // Phone locked for 20 minutes.
    expect(restRemaining(rest, T0 + 38_000 + 1_200_000)).toBe(-1030);
  });
});

describe("sameSet", () => {
  it("compares by value and treats null as unequal", () => {
    expect(sameSet(SET_A, { exerciseIndex: 0, setIndex: 1 })).toBe(true);
    expect(sameSet(SET_A, SET_B)).toBe(false);
    expect(sameSet(null, null)).toBe(false);
    expect(sameSet(SET_A, null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd "/Users/abdelouahedelbied/Health app" && npx vitest run lib/logger/__tests__/set-timer.test.ts
```

Expected: FAIL — `Failed to resolve import "@/lib/logger/set-timer"`.

- [ ] **Step 3: Write the implementation**

Create `lib/logger/set-timer.ts`:

```ts
// lib/logger/set-timer.ts
//
// The logger's set/rest state machine. Pure — no React, no Date.now(), no I/O.
// Every "now" arrives as a parameter so the whole thing is testable and so the
// UI can re-derive from an absolute anchor after the phone has been locked.
//
// The load-bearing idea is PHONE_LAG_SECONDS. The athlete racks the bar, then
// picks up the phone, unlocks it, and taps stop — about five seconds during
// which he is already resting. Back-dating the set end by that lag makes work
// time honest AND anchors the rest countdown at the rack instead of the tap.
// They are the same fact seen from two sides, which is why one constant drives
// both and neither is allowed to re-declare it.

/** Seconds between racking the bar and the stop press actually registering. */
export const PHONE_LAG_SECONDS = 5;

/** Walk-up countdown after START. Deliberately NOT counted as work. */
export const COUNTDOWN_SECONDS = 5;

export type SetRef = { exerciseIndex: number; setIndex: number };

export type TimerPhase = "idle" | "countdown" | "running" | "rest";

export type TimerState = {
  phase: TimerPhase;
  /** Absolute epoch ms the current phase started. Null only when idle.
   *  For `rest` this is the RACK time, already back-dated by the phone lag. */
  anchorMs: number | null;
  /** The set the phase concerns: counting down to it, lifting it, or resting
   *  after it. */
  activeSet: SetRef | null;
  /** Seeded rest length for the rest currently running (prescribed − lag). */
  restSeconds: number;
  /** Zoomed entry row. Deliberately NOT a phase: entry and rest are
   *  concurrent, and making entry a phase value would make them mutually
   *  exclusive — exactly the coupling this design removes. */
  pendingEntry: (SetRef & { workSeconds: number }) | null;
};

export const IDLE_TIMER: TimerState = {
  phase: "idle",
  anchorMs: null,
  activeSet: null,
  restSeconds: 0,
  pendingEntry: null,
};

export type TimerAction =
  | { type: "press_start"; set: SetRef; nowMs: number }
  /** Countdown reached zero, or the athlete tapped to skip it. */
  | { type: "countdown_elapsed"; nowMs: number }
  | { type: "press_stop"; nowMs: number; prescribedRestSeconds: number }
  | { type: "save_entry" }
  /** A set was uncommitted or deleted. */
  | { type: "clear_for_set"; set: SetRef }
  | { type: "reset" };

export function sameSet(a: SetRef | null, b: SetRef | null): boolean {
  if (!a || !b) return false;
  return a.exerciseIndex === b.exerciseIndex && a.setIndex === b.setIndex;
}

/** Honest time under load. Floored at 1 so a very short set cannot go
 *  negative once the lag is deducted. Truncates rather than rounds — a set is
 *  not credited with a second it did not complete. */
export function workSecondsFor(startAnchorMs: number, stopPressMs: number): number {
  const raw = Math.floor((stopPressMs - startAnchorMs) / 1000) - PHONE_LAG_SECONDS;
  return Math.max(1, raw);
}

/** Rest is already PHONE_LAG_SECONDS old when the stop press registers. */
export function restSeedSeconds(prescribedRestSeconds: number): number {
  return Math.max(1, prescribedRestSeconds - PHONE_LAG_SECONDS);
}

export function timerReducer(state: TimerState, action: TimerAction): TimerState {
  switch (action.type) {
    case "press_start": {
      // Starting a new set while one is mid-flight is not a thing the UI
      // offers (the circle reads STOP), so treat it as a no-op rather than
      // silently discarding an in-progress set's anchor.
      if (state.phase === "countdown" || state.phase === "running") return state;
      return {
        phase: "countdown",
        anchorMs: action.nowMs,
        activeSet: action.set,
        restSeconds: 0,
        // Caller persists any open entry BEFORE dispatching — see the
        // auto-save in LoggerSheet's handleStart.
        pendingEntry: null,
      };
    }

    case "countdown_elapsed": {
      if (state.phase !== "countdown") return state;
      return { ...state, phase: "running", anchorMs: action.nowMs };
    }

    case "press_stop": {
      if (state.phase !== "running" || state.anchorMs === null || state.activeSet === null) {
        return state;
      }
      const workSeconds = workSecondsFor(state.anchorMs, action.nowMs);
      return {
        phase: "rest",
        // Anchor at the rack, not the tap.
        anchorMs: action.nowMs - PHONE_LAG_SECONDS * 1000,
        activeSet: state.activeSet,
        restSeconds: restSeedSeconds(action.prescribedRestSeconds),
        pendingEntry: { ...state.activeSet, workSeconds },
      };
    }

    case "save_entry": {
      if (state.pendingEntry === null) return state;
      return { ...state, pendingEntry: null };
    }

    case "clear_for_set": {
      if (sameSet(state.activeSet, action.set)) return IDLE_TIMER;
      if (state.pendingEntry && sameSet(state.pendingEntry, action.set)) {
        return { ...state, pendingEntry: null };
      }
      return state;
    }

    case "reset":
      return IDLE_TIMER;
  }
}

function elapsedSecondsSinceAnchor(state: TimerState, nowMs: number): number {
  if (state.anchorMs === null) return 0;
  return Math.floor((nowMs - state.anchorMs) / 1000);
}

/** Whole seconds left in the walk-up countdown. Zero outside `countdown`. */
export function countdownRemaining(state: TimerState, nowMs: number): number {
  if (state.phase !== "countdown") return 0;
  return Math.max(0, COUNTDOWN_SECONDS - elapsedSecondsSinceAnchor(state, nowMs));
}

/** Seconds under load so far. Zero outside `running`. */
export function elapsedWorkSeconds(state: TimerState, nowMs: number): number {
  if (state.phase !== "running") return 0;
  return Math.max(0, elapsedSecondsSinceAnchor(state, nowMs));
}

/** SIGNED seconds left in rest — negative once the athlete is over. Deliberately
 *  unclamped: overtime is information, not an error state, and the dock renders
 *  it as a negative counter. Zero outside `rest`. */
export function restRemaining(state: TimerState, nowMs: number): number {
  if (state.phase !== "rest") return 0;
  return state.restSeconds - elapsedSecondsSinceAnchor(state, nowMs);
}

export function isRestOvertime(state: TimerState, nowMs: number): boolean {
  return state.phase === "rest" && restRemaining(state, nowMs) < 0;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd "/Users/abdelouahedelbied/Health app" && npx vitest run lib/logger/__tests__/set-timer.test.ts
```

Expected: PASS, all cases green.

- [ ] **Step 5: Run typecheck**

```bash
cd "/Users/abdelouahedelbied/Health app" && npm run typecheck
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add lib/logger/set-timer.ts lib/logger/__tests__/set-timer.test.ts
git commit -m "feat(logger): pure set-timer state machine

One constant (PHONE_LAG_SECONDS) back-dates the set end to the rack, from
which both honest work time and the rest countdown seed derive. Overtime is
derived state, not a phase, so there is no transition to miss. Entry is a
concurrent field rather than a phase value — rest and data entry must not be
mutually exclusive.

All derivations are anchor-based, so a locked phone resumes exact."
```

---

### Task 4: Honest `rest_seconds_actual`

**Files:**
- Modify: `lib/logger/set-timer.ts` (append `restBetweenSets`)
- Modify: `lib/logger/__tests__/set-timer.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `PHONE_LAG_SECONDS` from Task 3.
- Produces: `restBetweenSets(prev, next): number | null` — consumed by `LoggerSheet.commitNow` in Task 7.

- [ ] **Step 1: Append the failing test**

Add to `lib/logger/__tests__/set-timer.test.ts` (and add `restBetweenSets` to the import list at the top of the file):

```ts
describe("restBetweenSets", () => {
  const iso = (ms: number) => new Date(ms).toISOString();

  it("measures true rest: next start minus previous end", () => {
    const prev = { started_at: iso(T0), work_seconds: 33, committed_at: iso(T0 + 38_000) };
    // Previous set truly ended at T0+33s. Next set starts 175s later.
    const next = { started_at: iso(T0 + 33_000 + 175_000), committed_at: iso(T0 + 260_000) };
    expect(restBetweenSets(prev, next)).toBe(175);
  });

  it("excludes set-execution time that the commit-delta proxy included", () => {
    const prev = { started_at: iso(T0), work_seconds: 40, committed_at: iso(T0 + 45_000) };
    const next = { started_at: iso(T0 + 100_000), committed_at: iso(T0 + 140_000) };
    // Commit-to-commit would say 95s. True rest is 100 - 40 = 60s.
    expect(restBetweenSets(prev, next)).toBe(60);
  });

  it("falls back to the commit delta when the previous set was not timed", () => {
    const prev = { started_at: null, work_seconds: null, committed_at: iso(T0) };
    const next = { started_at: iso(T0 + 120_000), committed_at: iso(T0 + 150_000) };
    expect(restBetweenSets(prev, next)).toBe(150);
  });

  it("falls back to the commit delta when the next set was not timed", () => {
    const prev = { started_at: iso(T0), work_seconds: 30, committed_at: iso(T0 + 35_000) };
    const next = { started_at: null, committed_at: iso(T0 + 155_000) };
    expect(restBetweenSets(prev, next)).toBe(120);
  });

  it("returns null when there is no commit timestamp to fall back on", () => {
    expect(
      restBetweenSets(
        { started_at: null, work_seconds: null, committed_at: null },
        { started_at: null, committed_at: iso(T0) },
      ),
    ).toBeNull();
  });

  it("clamps a negative result to zero rather than emitting nonsense", () => {
    const prev = { started_at: iso(T0), work_seconds: 200, committed_at: iso(T0 + 205_000) };
    const next = { started_at: iso(T0 + 100_000), committed_at: iso(T0 + 130_000) };
    expect(restBetweenSets(prev, next)).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd "/Users/abdelouahedelbied/Health app" && npx vitest run lib/logger/__tests__/set-timer.test.ts
```

Expected: FAIL — `restBetweenSets is not exported`.

- [ ] **Step 3: Append the implementation to `lib/logger/set-timer.ts`**

```ts
/** The two set shapes restBetweenSets needs. Structural so both
 *  ExerciseSetDraft and a plain DB row satisfy it. */
type RestPrevSet = {
  started_at?: string | null;
  work_seconds?: number | null;
  committed_at: string | null;
};
type RestNextSet = {
  started_at?: string | null;
  committed_at: string | null;
};

/**
 * Seconds of ACTUAL rest between two consecutive committed sets.
 *
 * Preferred path uses true anchors: the previous set ended at
 * `started_at + work_seconds`, so rest is the gap from there to the next set's
 * start. The legacy path — commit timestamp deltas — measured rest PLUS set
 * execution, which is why ruleRestDiscipline's own header called it a proxy.
 *
 * Falls back to that proxy whenever either side lacks timer data, so
 * hand-logged sets, Strong imports, and pre-0056 rows keep their old value
 * rather than silently becoming null.
 */
export function restBetweenSets(prev: RestPrevSet, next: RestNextSet): number | null {
  if (prev.started_at && prev.work_seconds != null && next.started_at) {
    const prevEnd = Date.parse(prev.started_at) + prev.work_seconds * 1000;
    const nextStart = Date.parse(next.started_at);
    if (Number.isFinite(prevEnd) && Number.isFinite(nextStart)) {
      return Math.max(0, Math.round((nextStart - prevEnd) / 1000));
    }
  }

  if (prev.committed_at && next.committed_at) {
    const delta = Date.parse(next.committed_at) - Date.parse(prev.committed_at);
    if (!Number.isFinite(delta) || delta < 0) return null;
    return Math.round(delta / 1000);
  }

  return null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd "/Users/abdelouahedelbied/Health app" && npx vitest run lib/logger/__tests__/set-timer.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/logger/set-timer.ts lib/logger/__tests__/set-timer.test.ts
git commit -m "feat(logger): restBetweenSets — real rest from true anchors

Previous set ended at started_at + work_seconds, so rest is the gap from
there to the next set's start. The old commit-to-commit delta measured rest
plus set execution. Falls back to that delta whenever either side lacks
timer data so untimed sets keep their existing value."
```

---

### Task 5: Timer state in `LoggerSheet` + the docked circle

The big structural task. Rest state moves out of `ExerciseCard` (where it is per-card) into `LoggerSheet` (where it is per-session), and the dock becomes the only timing control.

At the end of this task the circle drives a full cycle and **commits the set directly on stop** using whatever values are pre-filled. Task 6 replaces that with the zoomed entry row.

**Files:**
- Create: `components/logger/SetTimerDock.tsx`
- Modify: `lib/logger/types.ts` (add `timer` to `LoggerDraft`; add `started_at` / `work_seconds` to `ExerciseSetDraft` and `CommitSessionPayload`)
- Modify: `components/logger/LoggerSheet.tsx`
- Modify: `components/logger/ExerciseCard.tsx` (remove local rest state, accept timer props)
- Delete: `components/logger/RestBar.tsx`

**Interfaces:**
- Consumes: everything from Task 3.
- Produces:
  - `<SetTimerDock state activeLabel targetLabel workSecondsTotal sessionElapsedMs onStart onSkipCountdown onCountdownElapsed onStop />`
  - `ExerciseCard` gains props: `timer: TimerState`, `onTimerStart(set: SetRef)`, `onSetCleared(set: SetRef)`.

- [ ] **Step 1: Extend the draft types**

In `lib/logger/types.ts`, add to `ExerciseSetDraft`:

```ts
  /** True set start (logger countdown end), ISO. Undefined/null when the set
   *  was not timed — hand-logged sets and pre-0056 hydrated rows. */
  started_at?: string | null;
  /** Honest time under load in seconds, phone lag already deducted. */
  work_seconds?: number | null;
```

add to `LoggerDraft`:

```ts
  /** Docked timer state, mirrored to IndexedDB so a reload mid-set resumes the
   *  running clock. Anchors are absolute epoch ms, so resume is exact. */
  timer?: import("@/lib/logger/set-timer").TimerState | null;
```

and add to the `sets` object inside `CommitSessionPayload`:

```ts
      started_at: string | null;
      work_seconds: number | null;
```

- [ ] **Step 2: Write the dock component**

Create `components/logger/SetTimerDock.tsx`. Visual reference: the approved mockup at `.superpowers/brainstorm/*/content/set-timer-v2.html`.

```tsx
"use client";

import { useEffect, useState } from "react";
import {
  COUNTDOWN_SECONDS,
  countdownRemaining,
  elapsedWorkSeconds,
  restRemaining,
  isRestOvertime,
  type TimerState,
} from "@/lib/logger/set-timer";

type Props = {
  state: TimerState;
  /** e.g. "Decline Bench · set 2" */
  activeLabel: string;
  /** e.g. "85 kg × 8 @ RIR 2" */
  targetLabel: string;
  /** Sum of committed work_seconds so far this session. */
  workSecondsTotal: number;
  /** Session wall clock in ms, from LoggerSheet's existing getElapsedMs. */
  sessionElapsedMs: number;
  onStart: () => void;
  onCountdownElapsed: () => void;
  onStop: () => void;
};

function mmss(totalSeconds: number): string {
  const neg = totalSeconds < 0;
  const s = Math.abs(Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${neg ? "−" : ""}${m}:${r.toString().padStart(2, "0")}`;
}

export function SetTimerDock({
  state, activeLabel, targetLabel, workSecondsTotal, sessionElapsedMs,
  onStart, onCountdownElapsed, onStop,
}: Props) {
  // This component owns the tick. Nothing time-varying is passed down from
  // LoggerSheet, so the memoized ExerciseCards never re-render on it.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const ticking = state.phase !== "idle";

  useEffect(() => {
    if (!ticking) return;
    const id = setInterval(() => setNowMs(Date.now()), 250);
    return () => clearInterval(id);
  }, [ticking]);

  // Fire the countdown-end transition from the display that is already
  // watching the clock, rather than from a second timer that could drift.
  const cdLeft = countdownRemaining(state, nowMs);
  useEffect(() => {
    if (state.phase === "countdown" && cdLeft === 0) onCountdownElapsed();
  }, [state.phase, cdLeft, onCountdownElapsed]);

  const overtime = isRestOvertime(state, nowMs);
  const restLeft = restRemaining(state, nowMs);

  const circle = (() => {
    switch (state.phase) {
      case "idle":
        return {
          onClick: onStart,
          className: "bg-green-500 text-green-950 shadow-[0_0_0_4px_rgba(34,197,94,0.16)]",
          big: "START", bigClass: "text-base", sub: "begin set",
          aria: "Start set",
        };
      case "countdown":
        return {
          onClick: onCountdownElapsed,
          className: "bg-stone-900 text-yellow-300 shadow-[0_0_0_4px_rgba(250,204,21,0.14)]",
          big: String(Math.max(1, cdLeft)), bigClass: "text-4xl", sub: "tap to skip",
          aria: "Skip countdown",
        };
      case "running":
        return {
          onClick: onStop,
          className: "bg-zinc-900 text-zinc-50 shadow-[0_0_0_4px_rgba(59,130,246,0.14)]",
          big: mmss(elapsedWorkSeconds(state, nowMs)), bigClass: "text-2xl", sub: "stop",
          aria: "Stop set",
        };
      case "rest":
        return overtime
          ? {
              onClick: onStart,
              className: "bg-red-500 text-red-950 shadow-[0_0_0_4px_rgba(239,68,68,0.2)]",
              big: mmss(restLeft), bigClass: "text-xl", sub: "start next",
              aria: "Start next set",
            }
          : {
              onClick: onStart,
              className: "bg-zinc-950 text-green-400 shadow-[0_0_0_4px_rgba(34,197,94,0.12)]",
              big: mmss(restLeft), bigClass: "text-xl", sub: "start early",
              aria: "Start next set early",
            };
    }
  })();

  const restSecondsTotal = Math.max(0, Math.floor(sessionElapsedMs / 1000) - workSecondsTotal);

  return (
    <div className="absolute bottom-0 inset-x-0 border-t border-zinc-800 bg-zinc-950/95 backdrop-blur px-3 pt-3 pb-[max(0.875rem,env(safe-area-inset-bottom))] flex items-center gap-3">
      <button
        type="button"
        onClick={circle.onClick}
        aria-label={circle.aria}
        className={`w-[78px] h-[78px] rounded-full flex-none flex flex-col items-center justify-center ${circle.className}`}
      >
        <span className={`font-mono tabular-nums font-semibold leading-none ${circle.bigClass}`}>
          {circle.big}
        </span>
        <span className="text-[8px] uppercase tracking-widest font-bold mt-0.5 opacity-70">
          {circle.sub}
        </span>
      </button>

      <div className="flex-1 min-w-0">
        <div className="text-[11px] font-semibold truncate">{activeLabel}</div>
        <div className="text-[9.5px] text-zinc-500 font-mono truncate">{targetLabel}</div>
        <div className="flex gap-2.5 mt-1.5">
          <div className="text-[8px] text-zinc-600 tracking-wide">
            SESSION
            <span className="block font-mono tabular-nums text-[11px] text-zinc-300">
              {mmss(Math.floor(sessionElapsedMs / 1000))}
            </span>
          </div>
          <div className="text-[8px] text-zinc-600 tracking-wide">
            WORK
            <span className="block font-mono tabular-nums text-[11px] text-blue-400">
              {mmss(workSecondsTotal)}
            </span>
          </div>
          <div className="text-[8px] text-zinc-600 tracking-wide">
            REST
            <span className="block font-mono tabular-nums text-[11px] text-zinc-400">
              {mmss(restSecondsTotal)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
```

Note `COUNTDOWN_SECONDS` is imported for the type-level contract with the reducer even though the display reads `countdownRemaining`; if the linter objects to the unused import, drop it.

- [ ] **Step 3: Strip rest state out of ExerciseCard**

In `components/logger/ExerciseCard.tsx`:

1. Delete the `RestBar` and `useRestCountdown` imports.
2. Delete the state declarations `activeRestStartedAt`, `activeRestSeconds`, `restAfterSetIndex` (lines ~44-46).
3. Delete the `<RestBar .../>` block in the render (lines ~248-257).
4. In `commitSet`, delete the three lines that started the local rest timer:

```tsx
    setRestAfterSetIndex(setIndex);
    setActiveRestSeconds(effectiveRest);
    setActiveRestStartedAt(now);
```

   and the now-unused `const now = Date.now();`.
5. In `uncommitSet`, delete the `if (restAfterSetIndex === setIndex) {...}` block and drop `restAfterSetIndex` from the dependency array.
6. Add three props to the `Props` type and destructure them:

```tsx
  /** Session-wide timer state, read-only here. */
  timer: TimerState;
  /** Athlete tapped START on a specific set row. */
  onTimerStart: (set: SetRef) => void;
  /** A set was uncommitted or deleted — clears timer state pointing at it. */
  onSetCleared: (set: SetRef) => void;
```

   with `import type { TimerState, SetRef } from "@/lib/logger/set-timer";`.
7. In `uncommitSet` and `removeSet`, call `onSetCleared({ exerciseIndex, setIndex })`.
8. Keep `effectiveRest` and the `RestTimeDialog` — the prescribed rest is now read by `LoggerSheet` when dispatching `press_stop`. Export it upward by calling a new prop on change:

```tsx
  onRestOverrideChange: (exerciseIndex: number, seconds: number) => void;
```

   invoked from the dialog's `onConfirm` alongside the existing `setRestOverrideSeconds`.

- [ ] **Step 4: Delete RestBar**

```bash
cd "/Users/abdelouahedelbied/Health app" && rm components/logger/RestBar.tsx
```

- [ ] **Step 5: Wire the timer into LoggerSheet**

In `components/logger/LoggerSheet.tsx`:

1. Import:

```tsx
import {
  IDLE_TIMER, timerReducer, workSecondsFor, sameSet,
  type TimerState, type SetRef,
} from "@/lib/logger/set-timer";
import { SetTimerDock } from "@/components/logger/SetTimerDock";
```

2. Hold timer state on the draft so it persists with everything else. Add a helper next to `getElapsedMs`:

```tsx
function timerOf(draft: LoggerDraft | null): TimerState {
  return draft?.timer ?? IDLE_TIMER;
}

/** Apply a timer action and persist it with the draft. */
function withTimer(draft: LoggerDraft, next: TimerState): LoggerDraft {
  return { ...draft, timer: next, updated_at: new Date().toISOString() };
}
```

3. Add per-exercise rest overrides beside the existing state:

```tsx
const [restOverrides, setRestOverrides] = useState<Record<number, number>>({});
```

4. Add the handlers (all use functional `setDraft` so the stable-callback contract with memoized `ExerciseCard` holds):

```tsx
  const handleTimerStart = useCallback((set: SetRef) => {
    setDraft((prev) => {
      if (!prev) return prev;
      // Auto-save any open entry first: the fields are pre-filled from the
      // prescription, so the athlete can start the next set without ever
      // touching them and nothing is lost.
      const withEntrySaved = commitPendingEntry(prev);
      return withTimer(
        withEntrySaved,
        timerReducer(timerOf(withEntrySaved), { type: "press_start", set, nowMs: Date.now() }),
      );
    });
  }, []);

  const handleCountdownElapsed = useCallback(() => {
    setDraft((prev) => {
      if (!prev) return prev;
      const nowMs = Date.now();
      const next = timerReducer(timerOf(prev), { type: "countdown_elapsed", nowMs });
      if (next === timerOf(prev)) return prev;
      // Stamp the true set start on the draft set itself.
      const ref = next.activeSet;
      if (!ref) return withTimer(prev, next);
      const exercises = prev.exercises.map((ex, ei) =>
        ei !== ref.exerciseIndex ? ex : {
          ...ex,
          sets: ex.sets.map((s, si) =>
            si !== ref.setIndex ? s : { ...s, started_at: new Date(nowMs).toISOString() },
          ),
        },
      );
      return withTimer({ ...prev, exercises }, next);
    });
  }, []);

  const handleStop = useCallback(() => {
    setDraft((prev) => {
      if (!prev) return prev;
      const cur = timerOf(prev);
      const ref = cur.activeSet;
      if (cur.phase !== "running" || !ref || cur.anchorMs === null) return prev;
      const nowMs = Date.now();
      const workSeconds = workSecondsFor(cur.anchorMs, nowMs);
      const prescribedRest =
        restOverrides[ref.exerciseIndex]
        ?? annotatedRestFor(prev, ref.exerciseIndex);
      const next = timerReducer(cur, { type: "press_stop", nowMs, prescribedRestSeconds: prescribedRest });
      // Task 5 commits straight away; Task 6 moves this into the zoom's Save.
      const exercises = prev.exercises.map((ex, ei) =>
        ei !== ref.exerciseIndex ? ex : {
          ...ex,
          sets: ex.sets.map((s, si) =>
            si !== ref.setIndex ? s : {
              ...s,
              work_seconds: workSeconds,
              committed_at: new Date(nowMs).toISOString(),
            },
          ),
        },
      );
      return withTimer({ ...prev, exercises }, timerReducer(next, { type: "save_entry" }));
    });
  }, [restOverrides]);

  const handleSetCleared = useCallback((set: SetRef) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const exercises = prev.exercises.map((ex, ei) =>
        ei !== set.exerciseIndex ? ex : {
          ...ex,
          sets: ex.sets.map((s, si) =>
            si !== set.setIndex ? s : { ...s, started_at: null, work_seconds: null },
          ),
        },
      );
      return withTimer({ ...prev, exercises }, timerReducer(timerOf(prev), { type: "clear_for_set", set }));
    });
  }, []);

  const handleRestOverrideChange = useCallback((exerciseIndex: number, seconds: number) => {
    setRestOverrides((prev) => ({ ...prev, [exerciseIndex]: seconds }));
  }, []);
```

   `commitPendingEntry(draft)` is a stub returning `draft` unchanged in this task — Task 6 implements it. Add it as a module-level function with that body and a `// Task 6 fills this in.` comment.

   `annotatedRestFor(draft, exerciseIndex)` is a module-level helper mirroring `ExerciseCard`'s existing computation:

```tsx
function annotatedRestFor(draft: LoggerDraft, exerciseIndex: number): number {
  const list = draft.exercises.map((e) => e.prescribed);
  const s = annotateSession(list);
  return s.exercises[exerciseIndex]?.rest_seconds.min ?? 120;
}
```

   with `import { annotateSession } from "@/lib/coach/session-structure/annotate";`.

5. Compute the dock's inputs (plain derivations, no hooks needed beyond `useMemo`):

```tsx
  const workSecondsTotal = useMemo(() => {
    if (!draft) return 0;
    let total = 0;
    for (const ex of draft.exercises) {
      for (const s of ex.sets) {
        if (s.committed_at && s.work_seconds != null) total += s.work_seconds;
      }
    }
    return total;
  }, [draft]);
```

   plus `activeLabel` / `targetLabel` derived from `timerOf(draft).activeSet` (falling back to the first uncommitted set when idle) — exercise name, working-set number, and the prescribed `kg × reps @RIR` string.

6. Render the dock at the end of the sheet, hidden in edit mode:

```tsx
      {!props.editMode && (
        <SetTimerDock
          state={timerOf(draft)}
          activeLabel={activeLabel}
          targetLabel={targetLabel}
          workSecondsTotal={workSecondsTotal}
          sessionElapsedMs={getElapsedMs(draft, Date.now())}
          onStart={() => handleTimerStart(nextSetRef)}
          onCountdownElapsed={handleCountdownElapsed}
          onStop={handleStop}
        />
      )}
```

   `sessionElapsedMs` is read once per render here; the dock re-reads the wall clock itself on each tick, so this is only the initial value — pass `draft.started_at`, `draft.paused_at` and `draft.paused_ms_total` through instead if the counter appears to freeze.

7. Disable pause mid-set. The Pause button's `disabled` becomes:

```tsx
disabled={timerOf(draft).phase === "countdown" || timerOf(draft).phase === "running"}
```

   with `disabled:opacity-40` added to its className.

8. Bump the scroll container's bottom padding from `pb-32` to `pb-44` so the dock does not cover the last exercise.

9. Pass the three new props to `<ExerciseCard>`:

```tsx
            timer={timerOf(draft)}
            onTimerStart={handleTimerStart}
            onSetCleared={handleSetCleared}
            onRestOverrideChange={handleRestOverrideChange}
```

- [ ] **Step 6: Backfill the timer field on old drafts**

In `lib/logger/draft-store.ts`, extend the backfill block in `loadDraft`:

```ts
  const draft: LoggerDraft = {
    ...raw,
    paused_at: raw.paused_at ?? null,
    paused_ms_total: raw.paused_ms_total ?? 0,
    timer: raw.timer ?? null,
  };
```

- [ ] **Step 7: Run the full gate**

```bash
cd "/Users/abdelouahedelbied/Health app" && npm run typecheck && npx vitest run && npm run build
```

Expected: all pass. `npm run build` is non-negotiable here — this task moves hooks between components, and hook-order faults pass typecheck and the unit suite while crashing only in a production build.

- [ ] **Step 8: Exercise it in the browser**

```bash
cd "/Users/abdelouahedelbied/Health app" && npm run dev
```

Open the logger, tap START, confirm: countdown runs 5→1, work clock counts up, STOP commits the set and starts rest at `prescribed − 5`, the circle goes solid red with a negative counter past zero, and the WORK counter increases by the set's work time.

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "feat(logger): docked set timer replaces per-card rest state

Rest state moves from per-ExerciseCard to per-session in LoggerSheet, so one
circle drives the whole cycle. Only absolute epoch anchors cross component
boundaries — the dock owns its tick, so memoized exercise cards do not
re-render 4x/second. Timer state persists on the draft, making a reload
mid-set resume exact.

Pause is disabled mid-set. RestBar is deleted."
```

---

### Task 6: The zoomed entry row

Splits commit out of stop. After this task, stopping a set opens the zoom while rest runs underneath, and Save writes the numbers without touching any clock.

**Files:**
- Create: `components/logger/SetEntryRow.tsx`
- Modify: `components/logger/ExerciseCard.tsx`
- Modify: `components/logger/LoggerSheet.tsx` (implement `commitPendingEntry`, stop committing in `handleStop`)

**Interfaces:**
- Consumes: `TimerState.pendingEntry` from Task 3, `handleStop` from Task 5.
- Produces: `<SetEntryRow set workingSetNumber workSeconds canRemove onChange onSave onRemove />`.

- [ ] **Step 1: Write the entry row component**

Create `components/logger/SetEntryRow.tsx`. The set-type badge and its `F ⇒ RIR 0` coupling are lifted verbatim from `SetRow`'s `selectBadge` — same semantics, larger targets.

```tsx
"use client";

import { useState } from "react";
import type { ExerciseSetDraft } from "@/lib/logger/types";
import { selectOnFocus } from "@/lib/ui/inputs";

type Props = {
  set: ExerciseSetDraft;
  workingSetNumber: number;
  workSeconds: number;
  /** Time-based exercise: show a single seconds field instead of kg/reps/RIR. */
  timeBased: boolean;
  canRemove: boolean;
  onChange: (patch: Partial<ExerciseSetDraft>) => void;
  onSave: () => void;
  onRemove: () => void;
};

function mmss(total: number): string {
  const m = Math.floor(total / 60);
  const r = total % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

export function SetEntryRow({
  set, workingSetNumber, workSeconds, timeBased, canRemove, onChange, onSave, onRemove,
}: Props) {
  const [badgeOpen, setBadgeOpen] = useState(false);
  const [draftKg, setDraftKg] = useState(set.kg !== null ? String(set.kg) : "");
  const [draftReps, setDraftReps] = useState(set.reps !== null ? String(set.reps) : "");
  const [draftRir, setDraftRir] = useState(
    set.rir !== null && set.rir !== undefined ? String(set.rir) : "",
  );
  const [draftSecs, setDraftSecs] = useState(
    set.duration_seconds !== null ? String(set.duration_seconds) : String(workSeconds),
  );

  // Identical coupling to SetRow.selectBadge: F means zero reps in reserve by
  // definition, so it auto-fills rir=0. Leaving F undoes the auto-fill ONLY
  // when rir is still 0, so a hand-typed value survives badge fiddling.
  const selectBadge = (next: { warmup: boolean; failure: boolean }) => {
    if (next.failure) {
      onChange({ ...next, rir: 0 });
      setDraftRir("0");
    } else if (set.failure && set.rir === 0) {
      onChange({ ...next, rir: null });
      setDraftRir("");
    } else {
      onChange(next);
    }
    setBadgeOpen(false);
  };

  const label = set.warmup ? "W" : set.failure ? "F" : String(workingSetNumber);
  const failed = set.failure;

  return (
    <div className={`rounded-xl p-2.5 my-1.5 border ${
      failed ? "bg-stone-950 border-red-500/50" : "bg-stone-900 border-blue-500/50"
    }`}>
      <div className="flex items-center gap-2 mb-2 relative">
        <button
          type="button"
          onClick={() => setBadgeOpen((v) => !v)}
          aria-label="Change set type"
          aria-haspopup="menu"
          aria-expanded={badgeOpen}
          className={`w-[26px] h-[26px] rounded-lg text-[13px] font-bold flex-none ${
            failed ? "bg-red-500/20 text-red-400 ring-1 ring-red-500/45" : "bg-zinc-800 text-zinc-50 ring-1 ring-zinc-700"
          }`}
        >
          {label}
        </button>
        {badgeOpen && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setBadgeOpen(false)} aria-hidden />
            <div className="absolute left-0 top-8 z-20 bg-zinc-800 border border-zinc-700 rounded-lg p-1 flex flex-col gap-0.5" role="menu">
              <button type="button" role="menuitem" onClick={() => selectBadge({ warmup: false, failure: false })} className="w-9 h-7 rounded text-[11px] font-bold bg-zinc-700 text-zinc-50">{workingSetNumber}</button>
              <button type="button" role="menuitem" onClick={() => selectBadge({ warmup: true, failure: false })} className="w-9 h-7 rounded text-[11px] font-bold bg-yellow-500/20 text-yellow-300">W</button>
              <button type="button" role="menuitem" onClick={() => selectBadge({ warmup: false, failure: true })} className="w-9 h-7 rounded text-[11px] font-bold bg-red-500/20 text-red-400">F</button>
              <button
                type="button"
                role="menuitem"
                aria-label="Delete set"
                disabled={!canRemove}
                onClick={() => { onRemove(); setBadgeOpen(false); }}
                className="w-9 h-7 rounded text-[11px] font-bold bg-zinc-900 text-zinc-400 border-t border-zinc-700 mt-0.5 disabled:opacity-30"
              >✕</button>
            </div>
          </>
        )}
        <span className={`text-[10px] uppercase tracking-wide font-semibold flex-1 ${failed ? "text-red-400" : "text-zinc-400"}`}>
          {failed ? "to failure" : "log it"}
        </span>
        <span className={`font-mono text-[10.5px] px-2 py-0.5 rounded-full whitespace-nowrap ${
          failed ? "text-red-300 bg-red-500/15" : "text-blue-300 bg-blue-500/15"
        }`}>
          ◷ {mmss(workSeconds)} work
        </span>
      </div>

      {timeBased ? (
        <div className="bg-zinc-950 border border-zinc-700 rounded-xl px-2 py-2 text-center">
          <div className="text-[8px] uppercase tracking-widest text-zinc-500 mb-0.5">seconds</div>
          <input
            inputMode="numeric"
            value={draftSecs}
            onFocus={selectOnFocus}
            onChange={(e) => setDraftSecs(e.target.value)}
            onBlur={() => {
              const n = draftSecs === "" ? null : parseInt(draftSecs, 10);
              onChange({ duration_seconds: Number.isFinite(n as number) ? (n as number) : null });
            }}
            className="bg-transparent border-none w-full text-center font-mono tabular-nums text-[21px] text-zinc-50"
          />
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-2">
          <div className="bg-zinc-950 border border-zinc-700 rounded-xl px-1 py-2 text-center">
            <div className="text-[8px] uppercase tracking-widest text-zinc-500 mb-0.5">kg</div>
            <input
              inputMode="decimal"
              value={draftKg}
              onFocus={selectOnFocus}
              onChange={(e) => setDraftKg(e.target.value)}
              onBlur={() => {
                const n = draftKg === "" ? null : parseFloat(draftKg);
                onChange({ kg: Number.isFinite(n as number) ? (n as number) : null });
              }}
              className="bg-transparent border-none w-full text-center font-mono tabular-nums text-[21px] text-zinc-50"
            />
          </div>
          <div className="bg-zinc-950 border border-blue-500 rounded-xl px-1 py-2 text-center">
            <div className="text-[8px] uppercase tracking-widest text-zinc-500 mb-0.5">reps</div>
            <input
              inputMode="numeric"
              value={draftReps}
              onFocus={selectOnFocus}
              onChange={(e) => setDraftReps(e.target.value)}
              onBlur={() => {
                const n = draftReps === "" ? null : parseInt(draftReps, 10);
                onChange({ reps: Number.isFinite(n as number) ? (n as number) : null });
              }}
              className="bg-transparent border-none w-full text-center font-mono tabular-nums text-[21px] text-blue-400"
            />
          </div>
          <div className={`bg-zinc-950 rounded-xl px-1 py-2 text-center border ${
            failed ? "border-red-500/45" : "border-zinc-700"
          }`}>
            <div className="text-[8px] uppercase tracking-widest text-zinc-500 mb-0.5">rir</div>
            <input
              inputMode="numeric"
              value={draftRir}
              disabled={failed}
              aria-label="Reps in reserve"
              onFocus={selectOnFocus}
              onChange={(e) => setDraftRir(e.target.value)}
              onBlur={() => {
                const n = draftRir === "" ? null : parseInt(draftRir, 10);
                const clamped = n === null || !Number.isFinite(n) ? null : Math.max(0, Math.min(10, n));
                onChange({ rir: clamped });
              }}
              className={`bg-transparent border-none w-full text-center font-mono tabular-nums text-[21px] ${
                failed ? "text-red-400" : "text-zinc-50"
              }`}
            />
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={onSave}
        className={`mt-2 w-full rounded-lg py-2 text-[11.5px] font-bold ${
          failed ? "bg-red-500/20 text-red-300" : "bg-green-500 text-green-950"
        }`}
      >
        ✓ {failed ? "Save as failure" : "Save"}
      </button>

      {failed && (
        <p className="text-[9px] text-red-400 mt-1.5 text-center italic">
          F ⇒ RIR 0 by definition · leaving F releases it
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Render it from ExerciseCard**

In `components/logger/ExerciseCard.tsx`, inside the `exercise.sets.map` loop, replace the normal `<SetRow>` with `<SetEntryRow>` when the timer's `pendingEntry` points at this set:

```tsx
{timer.pendingEntry
  && timer.pendingEntry.exerciseIndex === exerciseIndex
  && timer.pendingEntry.setIndex === i ? (
  <tr><td colSpan={7} className="p-0">
    <SetEntryRow
      set={s}
      workingSetNumber={exercise.sets.slice(0, i).filter((x) => !x.warmup).length + 1}
      workSeconds={timer.pendingEntry.workSeconds}
      timeBased={exercise.prescribed.duration_seconds != null}
      canRemove={exercise.sets.length > 1}
      onChange={(patch) => patchSet(i, patch)}
      onSave={() => onEntrySave({ exerciseIndex, setIndex: i })}
      onRemove={() => removeSet(i)}
    />
  </td></tr>
) : (
  <SetRow ... />   // unchanged, existing props
)}
```

Add `onEntrySave: (set: SetRef) => void` to `Props` and destructure it.

- [ ] **Step 3: Stop committing on stop; commit on save**

In `components/logger/LoggerSheet.tsx`, in `handleStop`, delete `committed_at` from the set patch and delete the trailing `timerReducer(next, { type: "save_entry" })` wrapper. The patch becomes:

```tsx
            si !== ref.setIndex ? s : { ...s, work_seconds: workSeconds },
```

and the return becomes `return withTimer({ ...prev, exercises }, next);`.

Then implement `commitPendingEntry` (the Task 5 stub):

```tsx
/** Commit whatever is in the open entry row and close it. Called by the Save
 *  button and, implicitly, by pressing START on the next set — the fields are
 *  pre-filled from the prescription, so the flow never blocks on typing. */
function commitPendingEntry(draft: LoggerDraft): LoggerDraft {
  const timer = draft.timer ?? IDLE_TIMER;
  const entry = timer.pendingEntry;
  if (!entry) return draft;
  const exercises = draft.exercises.map((ex, ei) =>
    ei !== entry.exerciseIndex ? ex : {
      ...ex,
      sets: ex.sets.map((s, si) =>
        si !== entry.setIndex || s.committed_at ? s : {
          ...s,
          committed_at: new Date().toISOString(),
        },
      ),
    },
  );
  return {
    ...draft,
    exercises,
    timer: timerReducer(timer, { type: "save_entry" }),
  };
}
```

and add the Save handler:

```tsx
  const handleEntrySave = useCallback(() => {
    setDraft((prev) => (prev ? commitPendingEntry(prev) : prev));
  }, []);
```

passing `onEntrySave={handleEntrySave}` to `<ExerciseCard>`.

- [ ] **Step 4: Move live coaching to the save moment**

`ExerciseCard.commitSet` still runs `evaluateSet`. It is no longer reached for timer-driven sets, because commit now happens in `LoggerSheet`. Move the evaluation into `commitPendingEntry`'s caller: in `handleEntrySave` and `handleTimerStart`, after the draft update, run the same `evaluateSet` call that `commitSet` performs, using the just-committed set. Keep `commitSet`'s copy intact for the manual `○` path.

Extract the shared logic into a module-level helper in `LoggerSheet.tsx` so both call sites agree:

```tsx
function evaluateCommittedSet(
  draft: LoggerDraft,
  ref: SetRef,
  liveContext: LiveSessionContext | undefined,
): CoachLine | null {
  if (!liveContext) return null;
  const ex = draft.exercises[ref.exerciseIndex];
  const set = ex?.sets[ref.setIndex];
  if (!ex || !set) return null;
  const sessionSets: SessionSetRef[] = draft.exercises.flatMap((e) =>
    e.sets.filter((s) => !s.warmup && s.committed_at != null).map((s) => ({ exerciseName: e.name, set: s })),
  );
  return evaluateSet({ set, exercise: ex, sessionSets, context: liveContext });
}
```

Hold the resulting line in `LoggerSheet` state (`coachLine` + `coachLineSet: SetRef | null`) and pass it down to `ExerciseCard` so the existing `CoachLineRow` renders under the right row.

- [ ] **Step 5: Run the full gate**

```bash
cd "/Users/abdelouahedelbied/Health app" && npm run typecheck && npx vitest run && npm run build
```

Expected: all pass.

- [ ] **Step 6: Exercise the decoupling in the browser**

With `npm run dev`, confirm all four:
1. Stop opens the zoom **and** the rest countdown starts in the same moment.
2. Typing in the zoom does not pause, reset, or otherwise disturb the rest clock.
3. Tapping Save collapses the row to a committed green row; rest keeps running.
4. Ignoring the zoom entirely and tapping START commits the set with its pre-filled values.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(logger): zoomed entry row, decoupled from rest

Stop opens the entry row and starts rest in the same moment; Save writes the
numbers and touches no clock. Pressing START on the next set auto-saves the
open entry, so the flow never blocks on typing.

The set-type badge and its F => RIR 0 coupling come across from SetRow
unchanged, at a size that is hittable mid-session."
```

---

### Task 7: Send timing to the server

**Files:**
- Modify: `components/logger/LoggerSheet.tsx:417-453` (`commitNow`)
- Modify: `lib/logger/hydrate-from-workout.ts`
- Modify: `lib/logger/__tests__/hydrate-from-workout.test.ts`
- Modify: `app/api/logger/session/route.ts` (Zod schema)

**Interfaces:**
- Consumes: `restBetweenSets` (Task 4), the payload type extension (Task 5 Step 1).
- Produces: sets on the wire carry `started_at` and `work_seconds`; `rest_seconds_actual` is computed from true anchors.

- [ ] **Step 1: Extend the route's validation schema**

In `app/api/logger/session/route.ts`, add to the per-set Zod object:

```ts
      started_at: z.string().datetime().nullable(),
      work_seconds: z.number().int().positive().nullable(),
```

- [ ] **Step 2: Carry the columns across edit-mode hydration**

In `lib/logger/hydrate-from-workout.ts`, add to the mapped set object (beside the existing `rest_seconds_actual` line):

```ts
      started_at: s.started_at,
      work_seconds: s.work_seconds,
```

and add both to the row type the function reads.

- [ ] **Step 3: Extend the hydration test**

In `lib/logger/__tests__/hydrate-from-workout.test.ts`, add `started_at: "2026-08-10T09:15:00.000Z"` and `work_seconds: 33` to the fixture set alongside the existing `rest_seconds_actual: 150`, and assert both survive onto the draft:

```ts
    expect(draft.exercises[0].sets[0].started_at).toBe("2026-08-10T09:15:00.000Z");
    expect(draft.exercises[0].sets[0].work_seconds).toBe(33);
```

- [ ] **Step 4: Run it to verify it fails**

```bash
cd "/Users/abdelouahedelbied/Health app" && npx vitest run lib/logger/__tests__/hydrate-from-workout.test.ts
```

Expected: FAIL — `expected undefined to be "2026-08-10T09:15:00.000Z"` if Step 2 was skipped; PASS if Step 2 is already in. If it passes immediately, confirm the assertion is actually reading the hydrated draft and not a fixture echo.

- [ ] **Step 5: Rewrite the payload mapping in `commitNow`**

Replace the `restActual` derivation block (lines ~422-451) with one that uses true anchors and falls back exactly as before:

```tsx
          .map((s, sIdx, arr) => {
            // Prefer the value already on the draft set (came from hydration of
            // a saved workout).
            let restActual: number | null;
            if (s.rest_seconds_actual !== undefined) {
              restActual = s.rest_seconds_actual;
            } else if (props.editMode) {
              // New set added during edit — no real timer ran. Null is correct;
              // deriving would compare against a workout created days ago.
              restActual = null;
            } else {
              const prev = arr[sIdx - 1];
              restActual = prev ? restBetweenSets(prev, s) : null;
            }
            return {
              set_index: s.set_index,
              kg: s.kg,
              reps: s.reps,
              duration_seconds: s.duration_seconds,
              warmup: s.warmup,
              failure: s.failure,
              rir: s.rir,
              rest_seconds_actual: restActual,
              started_at: s.started_at ?? null,
              work_seconds: s.work_seconds ?? null,
            };
          }),
```

adding `restBetweenSets` to the `set-timer` import.

- [ ] **Step 6: Run the full gate**

```bash
cd "/Users/abdelouahedelbied/Health app" && npm run typecheck && npx vitest run && npm run build
```

Expected: all pass.

- [ ] **Step 7: Commit a real session and verify the round-trip**

With `npm run dev`, log a short session using the timer, tap Finish, then confirm the values landed:

```bash
cd "/Users/abdelouahedelbied/Health app" && supabase db push --dry-run
```

Then in the Supabase SQL editor:

```sql
select es.set_index, es.kg, es.reps, es.started_at, es.work_seconds, es.rest_seconds_actual
from exercise_sets es
join exercises e on e.id = es.exercise_id
join workouts w on w.id = e.workout_id
where w.source = 'logger'
order by w.created_at desc, e.position, es.set_index
limit 20;
```

Expected: `started_at` and `work_seconds` populated on timed sets; `rest_seconds_actual` on set N+1 approximately equals wall-clock rest **excluding** set execution.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat(logger): persist per-set timing

started_at and work_seconds go over the wire to commit_logger_session, and
rest_seconds_actual is now computed from true anchors instead of
commit-to-commit deltas. Edit mode preserves both, same pattern as
duration_min and session_started_at."
```

---

### Task 8: Time-based exercises join the dock

**Files:**
- Modify: `components/logger/SetRow.tsx` (delete the inline timer branch)
- Modify: `components/logger/LoggerSheet.tsx` (`handleStop` writes `duration_seconds` too)

**Interfaces:**
- Consumes: everything above.
- Produces: no new exports. The dock is now live on every exercise type.

- [ ] **Step 1: Delete the inline timer branch from SetRow**

In `components/logger/SetRow.tsx`, delete the entire `if (targetDurationSeconds != null) { ... }` block (lines ~131-228) along with the now-unused `timerStartedAt` / `tick` state, its `useEffect`, `elapsedSeconds`, and the `fmtMmSs` helper. Keep the `targetDurationSeconds` prop — it still drives the header label — and render the standard row for every exercise. Committed time-based rows show `duration_seconds` in place of `kg × reps`.

- [ ] **Step 2: Write both columns on stop for time-based exercises**

In `handleStop` in `LoggerSheet.tsx`, extend the set patch so a time-based exercise also gets `duration_seconds`:

```tsx
            si !== ref.setIndex ? s : {
              ...s,
              work_seconds: workSeconds,
              // Time-based work keeps duration_seconds as its own coach-facing
              // "hold duration" — same number here, different consumer. Rep
              // sets must never write it (lib/coach/derived.ts reads it as a
              // hold and would report a 33-second bench press).
              duration_seconds:
                prev.exercises[ref.exerciseIndex].prescribed.duration_seconds != null
                  ? workSeconds
                  : s.duration_seconds,
            },
```

- [ ] **Step 3: Run the full gate**

```bash
cd "/Users/abdelouahedelbied/Health app" && npm run typecheck && npx vitest run && npm run build
```

Expected: all pass.

- [ ] **Step 4: Exercise a plank in the browser**

Open a session containing a time-based exercise (planks / dead hangs). Confirm the dock drives it, the zoom shows a single seconds field, and the committed row shows the held seconds.

- [ ] **Step 5: Verify rep sets still leave duration_seconds null**

In the Supabase SQL editor after committing a mixed session:

```sql
select e.name, es.set_index, es.reps, es.duration_seconds, es.work_seconds
from exercise_sets es
join exercises e on e.id = es.exercise_id
join workouts w on w.id = e.workout_id
where w.source = 'logger'
order by w.created_at desc, e.position, es.set_index
limit 30;
```

Expected: rep-based rows have `duration_seconds` NULL with `work_seconds` populated. This is the regression that would otherwise make the coach report a 33-second bench press.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(logger): time-based exercises run through the dock

Deletes SetRow's inline play/stop branch so the circle is never dead. A
time-based set writes both work_seconds and duration_seconds (same number,
different consumers); rep sets still write only work_seconds so the coach
layer's hold-duration reads stay honest."
```

---

### Task 9: Work:rest ratio in the finish summary

**Files:**
- Modify: `components/logger/FinishSummary.tsx`

**Interfaces:**
- Consumes: `work_seconds` on committed sets.
- Produces: nothing downstream.

- [ ] **Step 1: Add the ratio line**

`FinishSummary` already receives the draft. Add the derivation and render it beneath the existing summary lines:

```tsx
  const workSeconds = draft.exercises.reduce(
    (t, ex) => t + ex.sets.reduce(
      (s, set) => s + (set.committed_at && set.work_seconds != null ? set.work_seconds : 0), 0,
    ), 0,
  );
  const sessionSeconds = Math.max(1, Math.round(getElapsedMs(draft, Date.now()) / 1000));
  const restSeconds = Math.max(0, sessionSeconds - workSeconds);
```

```tsx
      {workSeconds > 0 && (
        <div className="text-[11px] text-zinc-400 font-mono tabular-nums">
          Work {Math.floor(workSeconds / 60)}:{(workSeconds % 60).toString().padStart(2, "0")}
          {" · rest "}
          {Math.floor(restSeconds / 60)}:{(restSeconds % 60).toString().padStart(2, "0")}
          {" · ratio 1:"}
          {fmtNum(restSeconds / workSeconds)}
        </div>
      )}
```

`getElapsedMs` must be exported from `LoggerSheet.tsx` (or moved to `lib/logger/set-timer.ts` and imported by both — prefer the move, it is pure). `fmtNum` comes from `@/lib/ui/score` per the repo-wide number-formatting rule.

The `workSeconds > 0` guard matters: a session logged entirely by hand has no timing data, and a `1:Infinity` ratio would be worse than no line at all.

- [ ] **Step 2: Run the full gate**

```bash
cd "/Users/abdelouahedelbied/Health app" && npm run typecheck && npx vitest run && npm run build
```

Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat(logger): work:rest ratio on the finish summary

Hidden when no set was timed — a hand-logged session would otherwise show
an infinite ratio."
```

---

### Task 10: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add the migration entry**

In the "Database migrations" list, after the 0055 entry:

```markdown
49. [supabase/migrations/0056_set_timing.sql](supabase/migrations/0056_set_timing.sql) — adds `exercise_sets.started_at timestamptz` (true set start = the logger's 5s countdown end, NOT the START tap) and `exercise_sets.work_seconds int` (time under load, phone lag deducted, floored at 1); re-declares `commit_logger_session` to insert both. `duration_seconds` is deliberately NOT reused — [lib/coach/derived.ts](lib/coach/derived.ts) falls back to it when no e1RM exists and [lib/coach/snapshot.ts](lib/coach/snapshot.ts) renders it as `"45s hold"`, so rep-set work time there would make the coach report a 38-second bench hold. Both nullable; hand-logged sets, Strong CSV imports, and pre-0056 rows stay NULL.
```

and update the "Next free slot" line at the end of the section to **0057**.

- [ ] **Step 2: Extend the workout-logger architecture bullet**

Append to the **In-app workout logger** bullet:

```markdown
Set timing is driven by a single docked circular control ([components/logger/SetTimerDock.tsx](components/logger/SetTimerDock.tsx)) backed by the pure state machine in [lib/logger/set-timer.ts](lib/logger/set-timer.ts): green START → 5s walk-up countdown → work clock → stop → rest countdown → red negative overtime. `PHONE_LAG_SECONDS = 5` back-dates each set's end to the rack (the athlete is already resting while picking up the phone), which is the single source of BOTH honest `work_seconds` and the rest seed of `prescribed − 5`. Overtime is derived state (`phase === 'rest'` with elapsed past `restSeconds`), not a phase. `pendingEntry` is a field rather than a phase value because entry and rest are concurrent — stopping a set opens the zoomed entry row ([components/logger/SetEntryRow.tsx](components/logger/SetEntryRow.tsx)) AND starts rest in the same moment, and Save touches no clock. Pressing START on the next set auto-saves any open entry. `rest_seconds_actual` is computed by `restBetweenSets` from true anchors (`next.started_at − (prev.started_at + prev.work_seconds)`), falling back to the legacy commit-to-commit delta for untimed sets — the old proxy measured rest PLUS set execution, so `ruleRestDiscipline` now fires on short rests it used to miss. **No ticking value crosses a component boundary**: the reducer stores absolute epoch anchors and each clock-displaying component owns its own interval, so memoized `ExerciseCard`s don't re-render 4×/second and a locked phone resumes exact. There is no audio cue — one was tried and removed (ducked background music indefinitely; only fired with the phone unlocked and app foregrounded). Spec: [docs/superpowers/specs/2026-08-10-logger-set-timing-design.md](docs/superpowers/specs/2026-08-10-logger-set-timing-design.md).
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md && git commit -m "docs: CLAUDE.md — logger set timing + migration 0056"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| `PHONE_LAG_SECONDS` back-dating, 1s floors | 3 |
| Countdown not counted as work | 3 (anchor set at `countdown_elapsed`), 5 |
| Docked circle, six visual states | 5 |
| Overtime as derived state | 3, 5 |
| Zoomed entry row + badge + `F ⇒ RIR 0` | 6 |
| Rest decoupled from Save | 6 |
| Auto-save on next START | 5 (stub), 6 (implementation) |
| Accumulated WORK / REST counters | 5 |
| Migration 0056, `duration_seconds` untouched | 2, 8 |
| `rest_seconds_actual` from true anchors | 4, 7 |
| State lifted to `LoggerSheet`, no ticking props | 5 |
| Draft survival of timer state | 5 |
| Audio cue removal (726 lines) | 1 |
| Manual `○` path preserved | 5, 6 |
| Edit mode preserves timing, no live timer | 5, 7 |
| Pause disabled mid-set | 5 |
| Time-based exercises in the dock | 8 |
| Finish summary work:rest ratio | 9 |

**Type consistency:** `SetRef`, `TimerState`, `TimerAction`, `IDLE_TIMER`, `timerReducer`, `workSecondsFor`, `restSeedSeconds`, `restBetweenSets`, `countdownRemaining`, `elapsedWorkSeconds`, `restRemaining`, `isRestOvertime`, `sameSet` are defined in Task 3/4 and used under those exact names in Tasks 5–9. Draft fields `started_at` / `work_seconds` / `timer` are declared in Task 5 Step 1 and consumed under those names in 5–9.

**Known ordering constraint:** Task 5 leaves `commitPendingEntry` as a stub returning its input unchanged, and commits sets directly in `handleStop`. Task 6 implements the stub and removes the direct commit. Task 5 is independently shippable — the logger works end-to-end after it, just without the zoom.
