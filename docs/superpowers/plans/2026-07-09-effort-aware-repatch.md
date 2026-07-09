# Effort-Aware Engine + Mid-Week Feed-Forward Repatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The prescription engine consumes per-set RIR for its load-progression decisions, and every committed workout re-runs the engine for the remaining days of the current week.

**Architecture:** Extend the engine's clean/dirty predicates in `prescribe-week.ts` with an RIR guard (null collapses to legacy behavior). Add a `preserveDaysThrough` merge option to the single `upsertWeekPrescription` seam, wrap it in a new `repatchRemainingWeek` primitive that diffs future-day prescriptions and appends an audit entry to a new `training_weeks.repatch_log` jsonb column, and fire it non-fatally from the logger commit route after target-hit stamping. The workout debrief surfaces the diff as deterministic note lines.

**Tech Stack:** Next.js 15 (App Router), TypeScript strict, Supabase/Postgres, fixture-based audit scripts (no test runner for lib/coach; vitest only covers `lib/**/__tests__`).

**Spec:** [docs/superpowers/specs/2026-07-09-effort-aware-engine-midweek-repatch-design.md](../specs/2026-07-09-effort-aware-engine-midweek-repatch-design.md)

## Global Constraints

- `rir = null`/`undefined` anywhere MUST produce byte-identical legacy behavior.
- Weekdays ≤ today are NEVER rewritten by the repatch (stored state wins verbatim, including absence).
- Do NOT touch `lib/coach/e1rm.ts`, `bestComparisonValue`, or block-target semantics.
- No raw `new Date().toISOString().slice(0,10)` / `.getHours()` "today" computations — `node scripts/audit-timezone-usage.mjs` is the gate. Date *arithmetic* on a passed-in ISO string (the `currentBlockWeek` pattern) is fine.
- User-visible numbers go through `fmtNum()` from `lib/ui/score.ts` — never `.toFixed()` / raw interpolation of decimals.
- Audit scripts run via: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/<name>.mjs`
- Migration numbering: next free slot is **0048**. `supabase db push` may demand `--include-all` due to the duplicate-0026 history quirk — do NOT pass it (it re-runs bare CREATE TABLEs). If push balks, apply via Supabase Dashboard → SQL Editor and `supabase migration repair --status applied 0048`.
- Commits end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: Branch, migration 0048, and `RepatchLogEntry` types

**Files:**
- Create: `supabase/migrations/0048_repatch_log.sql`
- Modify: `lib/data/types.ts` (next to the `TrainingWeek` type, ~line 516)

**Interfaces:**
- Produces: `training_weeks.repatch_log jsonb` column; TS types `RepatchChange`, `RepatchLogEntry`; `TrainingWeek.repatch_log: RepatchLogEntry[] | null`.

- [ ] **Step 1: Create the feature branch**

Branch from the CURRENT branch (`chore/code-reduction-audit`) — it carries the spec + this plan; branching from `main` would drop them from the worktree:

```bash
git checkout -b feat/effort-aware-repatch
```

- [ ] **Step 2: Write the migration**

Create `supabase/migrations/0048_repatch_log.sql`:

```sql
-- 0048_repatch_log.sql
-- Mid-week feed-forward repatch audit trail. Append-only jsonb array of
-- { at, reason, workout_date, changes: [{weekday, exercise, field, from, to}] }.
-- Written by lib/coach/prescription/repatch-week.ts ONLY when a repatch
-- actually changed a future day's prescription. Read by the workout debrief
-- ("plan updated" note) and by audit tooling. NULL / absent = no repatches.

alter table public.training_weeks
  add column if not exists repatch_log jsonb;

comment on column public.training_weeks.repatch_log is
  'Append-only log of mid-week prescription repatches (engine re-runs triggered by workout commits). Each entry: {at, reason, workout_date, changes[]}. NULL = never repatched.';
```

- [ ] **Step 3: Add the TS types**

In `lib/data/types.ts`, directly above `export type TrainingWeek` (~line 516), add:

```ts
/** One field-level change produced by a mid-week repatch (see
 *  lib/coach/prescription/repatch-week.ts). `added`/`removed` carry the
 *  exercise name in `to`/`from` respectively; numeric fields carry numbers. */
export type RepatchChange = {
  weekday: WeekdayLong;
  exercise: string;
  field: "baseKg" | "baseReps" | "sets" | "rir" | "added" | "removed";
  from: number | string | null;
  to: number | string | null;
};

/** Append-only entry in training_weeks.repatch_log. */
export type RepatchLogEntry = {
  at: string; // ISO timestamp
  reason: string; // e.g. "workout_commit"
  workout_date: string | null; // YYYY-MM-DD of the triggering workout
  changes: RepatchChange[];
};
```

Inside `TrainingWeek`, after `session_prescriptions: SessionPrescriptions | null;` (~line 536), add:

```ts
  repatch_log: RepatchLogEntry[] | null;
```

- [ ] **Step 4: Typecheck; patch any `TrainingWeek` literals**

Run: `npm run typecheck`
Expected: likely PASS (the synthetic row in `upsert-week-prescription.ts` spreads `prior ?? ({} as TrainingWeek)` so the cast absorbs the new field). If any object-literal error surfaces (e.g. a test fixture constructing a full `TrainingWeek`), add `repatch_log: null,` to that literal.

- [ ] **Step 5: Apply the migration**

Run: `supabase db push`
Expected: applies `0048_repatch_log.sql`. If it demands `--include-all`, STOP — apply the SQL via Dashboard → SQL Editor instead, then `supabase migration repair --status applied 0048`.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0048_repatch_log.sql lib/data/types.ts
git commit -m "feat(db): training_weeks.repatch_log + RepatchLogEntry types (migration 0048)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: RIR-aware clean predicates in the engine

**Files:**
- Modify: `lib/coach/prescription/types.ts:12-20` (`WorkoutSetSample`)
- Modify: `lib/coach/prescription/prescribe-week.ts` (fetch ~560-597, predicates ~615-637, call sites ~275, 289-290, 312)
- Test: `scripts/audit-prescription-rules.mjs` (append fixtures)

**Interfaces:**
- Consumes: nothing from other tasks (independent of Task 1).
- Produces: `WorkoutSetSample.rir?: number | null` (optional — six other sample constructors across `lib/coach/tools.ts`, `weekly-review/`, `carter-context/framework-state.ts`, `block-outcomes/index.ts` stay untouched and behave legacy); exported `lastWeekClean(sets, ex, rirTarget)` and `consecutiveMisses(sets, ex, rirTarget)` from `prescribe-week.ts`.

- [ ] **Step 1: Write the failing fixtures**

Append to `scripts/audit-prescription-rules.mjs` (before the final `summary()` call), and add `lastWeekClean, consecutiveMisses` to the existing import from `"@/lib/coach/prescription/prescribe-week"`:

```js
console.log("\n## prescribe-week.ts — RIR-aware clean predicates\n");

{
  const ex = { name: "Squat (Barbell)", baseReps: 6, sets: 3, rir: 2 };
  const base = { exercise_name: "Squat (Barbell)", exercise_key: null, kg: 100, reps: 6, warmup: false, failure: false, performed_on: "2026-07-06" };

  assert("clean when recorded RIR meets prescription", lastWeekClean([{ ...base, rir: 2 }], ex, 2) === true);
  assert("dirty when recorded RIR below prescription (grind)", lastWeekClean([{ ...base, rir: 0 }], ex, 2) === false);
  assert("legacy: missing RIR keeps old verdict (clean)", lastWeekClean([base], ex, 2) === true);
  assert("legacy: missing RIR keeps old verdict (reps short = dirty)", lastWeekClean([{ ...base, reps: 4 }], ex, 2) === false);
  assert("per-exercise ex.rir overrides week rirTarget", lastWeekClean([{ ...base, rir: 2 }], { ...ex, rir: 3 }, 2) === false);
  assert("week rirTarget used when ex.rir absent", lastWeekClean([{ ...base, rir: 1 }], { name: ex.name, baseReps: 6, sets: 3 }, 2) === false);
  assert("failure dirty regardless of RIR", lastWeekClean([{ ...base, rir: 3, failure: true }], ex, 2) === false);
  assert("over-target RIR is still just clean (no double-step signal)", lastWeekClean([{ ...base, rir: 4 }], ex, 2) === true);

  assert(
    "consecutiveMisses counts RIR grinds",
    consecutiveMisses(
      [{ ...base, rir: 0 }, { ...base, rir: 1, performed_on: "2026-06-29" }],
      ex,
      2,
    ) === 2,
  );
  assert(
    "consecutiveMisses stops at first RIR-clean set",
    consecutiveMisses(
      [{ ...base, rir: 0 }, { ...base, rir: 2, performed_on: "2026-06-29" }],
      ex,
      2,
    ) === 1,
  );
  assert(
    "consecutiveMisses legacy path unchanged when RIR absent",
    consecutiveMisses([{ ...base, reps: 4 }, base], ex, 2) === 1,
  );
}
```

- [ ] **Step 2: Run to verify failure**

Run: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs`
Expected: FAIL — `lastWeekClean` is not exported (SyntaxError on import).

- [ ] **Step 3: Implement**

In `lib/coach/prescription/types.ts`, add to `WorkoutSetSample` after `failure: boolean;`:

```ts
  /** Reps in reserve recorded for this set. Optional: only the prescription
   *  engine's own fetch populates it; other sample constructors omit it and
   *  every consumer treats null/undefined as "not recorded" (legacy path). */
  rir?: number | null;
```

In `lib/coach/prescription/prescribe-week.ts`:

(a) `fetchRecentSets` select (~line 568) becomes:

```ts
    .select("date, exercises(name, exercise_sets(kg, reps, warmup, failure, rir))")
```

(b) `RawSet` (~line 574) becomes:

```ts
  type RawSet = { kg: number | null; reps: number | null; warmup: boolean | null; failure: boolean | null; rir: number | null };
```

(c) the `out.push` (~line 584) gains, after `failure: !!s.failure,`:

```ts
          rir: s.rir ?? null,
```

(d) Replace the two predicates (~lines 615-637) with exported, RIR-aware versions:

```ts
/** Returns true if the most-recent non-warmup set for this exercise was a
 *  clean working set: not failure, hit or exceeded prescribed reps, AND —
 *  when the set carries a recorded RIR — met the prescribed RIR
 *  (`ex.rir ?? rirTarget`). A set ground out below the prescribed RIR is
 *  dirty: the load was too heavy relative to plan, so the engine holds
 *  instead of stepping. `rir == null` collapses to the legacy verdict.
 *  Exported for scripts/audit-prescription-rules.mjs. */
export function lastWeekClean(
  sets: WorkoutSetSample[],
  ex: PlannedExercise,
  rirTarget: number,
): boolean {
  const matching = setsForExercise(sets, ex);
  const top = matching[0]; // recent-first
  if (top == null) return false;
  if (top.failure) return false;
  if (ex.baseReps != null && top.reps < ex.baseReps) return false;
  const prescribedRir = ex.rir ?? rirTarget;
  if (top.rir != null && top.rir < prescribedRir) return false;
  return true;
}

/** Count consecutive recent non-warmup sets that were dirty (failure, fell
 *  short of prescribed reps, or ground below the prescribed RIR when RIR was
 *  recorded). Walks newest-first; stops at first clean.
 *  Exported for scripts/audit-prescription-rules.mjs. */
export function consecutiveMisses(
  sets: WorkoutSetSample[],
  ex: PlannedExercise,
  rirTarget: number,
): number {
  const matching = setsForExercise(sets, ex);
  const prescribedRir = ex.rir ?? rirTarget;
  let misses = 0;
  for (const s of matching) {
    const clean =
      !s.failure &&
      (ex.baseReps == null || s.reps >= ex.baseReps) &&
      (s.rir == null || s.rir >= prescribedRir);
    if (clean) break;
    misses++;
  }
  return misses;
}
```

(e) Update the three call sites inside `prescribeWeek` to pass `rirTarget`:

- ~line 275: `lastWeekHitRirTargetCleanly: lastWeekClean(recentSets, baseEx, rirTarget),`
- ~line 289: `lastWeekHitRirTargetCleanly: lastWeekClean(recentSets, baseEx, rirTarget),` and ~line 290: `consecutiveRirMisses: consecutiveMisses(recentSets, baseEx, rirTarget),`
- ~line 312: `lastWeekHitRirTargetCleanly: lastWeekClean(recentSets, baseEx, rirTarget),`

- [ ] **Step 4: Run fixtures + full audit to verify pass (including untouched legacy assertions)**

Run: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs`
Expected: PASS, prior assertion count + 11 new.

- [ ] **Step 5: Typecheck + vitest**

Run: `npm run typecheck && npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/coach/prescription/types.ts lib/coach/prescription/prescribe-week.ts scripts/audit-prescription-rules.mjs
git commit -m "feat(engine): clean/dirty predicates consume per-set RIR

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `preserveDaysThrough` merge on the upsert seam

**Files:**
- Modify: `lib/coach/prescription/upsert-week-prescription.ts`
- Test: `scripts/audit-prescription-rules.mjs` (append fixtures)

**Interfaces:**
- Consumes: nothing new.
- Produces: exported pure `mergePreservedDays(opts: { computed: SessionPrescriptions; stored: SessionPrescriptions | null; weekStart: string; preserveDaysThrough: string }): SessionPrescriptions`; `upsertWeekPrescription` gains optional `preserveDaysThrough?: string` (ISO date; weekdays ≤ that date keep stored state verbatim, including absence).

- [ ] **Step 1: Write the failing fixtures**

Append to `scripts/audit-prescription-rules.mjs` (add `mergePreservedDays` to imports, from `"@/lib/coach/prescription/upsert-week-prescription"`):

```js
console.log("\n## upsert-week-prescription.ts — mergePreservedDays\n");

{
  const stored = {
    Monday: [{ name: "Squat (Barbell)", baseKg: 130, baseReps: 6, sets: 3 }],
    Thursday: [{ name: "Deadlift (Barbell)", baseKg: 132.5, baseReps: 6, sets: 3 }],
  };
  const computed = {
    Monday: [{ name: "Squat (Barbell)", baseKg: 135, baseReps: 6, sets: 3 }],
    Tuesday: [{ name: "Decline Bench Press (Barbell)", baseKg: 80, baseReps: 8, sets: 3 }],
    Thursday: [{ name: "Deadlift (Barbell)", baseKg: 130, baseReps: 6, sets: 3 }],
  };
  // week 2026-07-06 (Mon) … today is Tuesday 2026-07-07
  const merged = mergePreservedDays({ computed, stored, weekStart: "2026-07-06", preserveDaysThrough: "2026-07-07" });

  assert("past day keeps stored load verbatim", merged.Monday[0].baseKg === 130);
  assert("today keeps stored state — absence preserved (Tuesday deleted)", !("Tuesday" in merged));
  assert("future day takes computed load", merged.Thursday[0].baseKg === 130);
  assert("boundary before week start returns computed untouched",
    mergePreservedDays({ computed, stored, weekStart: "2026-07-06", preserveDaysThrough: "2026-07-05" }).Monday[0].baseKg === 135);
  assert("full-week boundary preserves everything stored",
    mergePreservedDays({ computed, stored, weekStart: "2026-07-06", preserveDaysThrough: "2026-07-12" }).Thursday[0].baseKg === 132.5);
  assert("null stored + preserve → computed days ≤ boundary removed",
    !("Monday" in mergePreservedDays({ computed, stored: null, weekStart: "2026-07-06", preserveDaysThrough: "2026-07-07" })));
}
```

- [ ] **Step 2: Run to verify failure**

Run: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs`
Expected: FAIL — `mergePreservedDays` not exported.

- [ ] **Step 3: Implement**

In `lib/coach/prescription/upsert-week-prescription.ts`:

(a) Add import: `import { daysBetweenIso } from "@/lib/time/dates";`

(b) Add the pure helper (above `upsertWeekPrescription`):

```ts
/** Merge freshly-computed prescriptions with the stored row so that weekdays
 *  ≤ `preserveDaysThrough` keep their stored state VERBATIM — including
 *  absence (a stored week with no Tuesday entry stays without one). Weekdays
 *  strictly after the boundary take the fresh computation. Pure; exported for
 *  scripts/audit-prescription-rules.mjs. Used by the mid-week repatch so past
 *  days remain the historical record of what was actually prescribed. */
export function mergePreservedDays(opts: {
  computed: SessionPrescriptions;
  stored: SessionPrescriptions | null;
  weekStart: string;
  preserveDaysThrough: string;
}): SessionPrescriptions {
  const idx = daysBetweenIso(opts.weekStart, opts.preserveDaysThrough);
  if (idx == null || idx < 0) return opts.computed;
  const out: SessionPrescriptions = { ...opts.computed };
  for (let i = 0; i <= Math.min(idx, 6); i++) {
    const day = WEEKDAY_LONG_ORDER[i];
    const storedDay = opts.stored?.[day];
    if (storedDay != null) out[day] = storedDay;
    else delete out[day];
  }
  return out;
}
```

Note: `WEEKDAY_LONG_ORDER` is declared at the bottom of this same file — `const` hoisting makes it usable here; if the executor prefers, move its declaration above the helper.

(c) Add the option to `upsertWeekPrescription`'s opts type, after `todayIso: string;`:

```ts
  /** When set (ISO date), weekdays ≤ this date keep the STORED row's
   *  prescriptions verbatim (including absence); only strictly-later weekdays
   *  take the fresh computation. Used by the mid-week repatch. Omitted →
   *  full-week write (Sunday cron / commit_week_plan behavior, unchanged). */
  preserveDaysThrough?: string;
```

(d) After `const prescription = await prescribeWeek({...});` (~line 137), add:

```ts
  const finalPrescription = opts.preserveDaysThrough
    ? mergePreservedDays({
        computed: prescription,
        stored: existing?.session_prescriptions ?? null,
        weekStart,
        preserveDaysThrough: opts.preserveDaysThrough,
      })
    : prescription;
```

(e) Replace the three uses of `prescription` below that point with `finalPrescription`: the `.update({ session_prescriptions: ... })`, the `.insert({ ... session_prescriptions: ... })`, and the `session_prescriptions:` field of the return value.

- [ ] **Step 4: Run fixtures to verify pass**

Run: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs`
Expected: PASS, +6 assertions.

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add lib/coach/prescription/upsert-week-prescription.ts scripts/audit-prescription-rules.mjs
git commit -m "feat(engine): preserveDaysThrough merge option on upsertWeekPrescription

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: `repatchRemainingWeek` primitive

**Files:**
- Create: `lib/coach/prescription/repatch-week.ts`
- Test: `scripts/audit-prescription-rules.mjs` (append fixtures for the pure helpers)

**Interfaces:**
- Consumes: `upsertWeekPrescription({ ..., preserveDaysThrough })` (Task 3), `RepatchChange`/`RepatchLogEntry` from `@/lib/data/types` (Task 1).
- Produces:
  - `mondayOfIso(iso: string): string` (pure, exported)
  - `diffFutureDays(opts: { stored: SessionPrescriptions; next: SessionPrescriptions; weekStart: string; todayIso: string }): RepatchChange[]` (pure, exported)
  - `formatRepatchNotes(entry: RepatchLogEntry): string[]` (pure, exported — consumed by Task 6)
  - `repatchRemainingWeek(opts: { supabase: SupabaseClient; userId: string; todayIso: string; reason: string; workoutDate?: string }): Promise<{ changed: boolean; changes: RepatchChange[] } | null>` (consumed by Task 5)

- [ ] **Step 1: Write the failing fixtures**

Append to `scripts/audit-prescription-rules.mjs` (import `mondayOfIso, diffFutureDays, formatRepatchNotes` from `"@/lib/coach/prescription/repatch-week"`):

```js
console.log("\n## repatch-week.ts — pure helpers\n");

{
  assert("mondayOfIso: Thursday → Monday", mondayOfIso("2026-07-09") === "2026-07-06");
  assert("mondayOfIso: Monday is identity", mondayOfIso("2026-07-06") === "2026-07-06");
  assert("mondayOfIso: Sunday belongs to preceding Monday", mondayOfIso("2026-07-12") === "2026-07-06");

  const stored = {
    Monday: [{ name: "Squat (Barbell)", baseKg: 130, baseReps: 6, sets: 3, rir: 2 }],
    Thursday: [
      { name: "Deadlift (Barbell)", baseKg: 60, baseReps: 8, sets: 2, warmup: true },
      { name: "Deadlift (Barbell)", baseKg: 132.5, baseReps: 6, sets: 3, rir: 2 },
      { name: "Lat Pulldown (Cable)", baseKg: 70, baseReps: 10, sets: 3, rir: 2 },
    ],
  };
  const next = {
    Monday: [{ name: "Squat (Barbell)", baseKg: 999, baseReps: 6, sets: 3, rir: 2 }], // past-day change must be IGNORED
    Thursday: [
      { name: "Deadlift (Barbell)", baseKg: 60, baseReps: 8, sets: 2, warmup: true },
      { name: "Deadlift (Barbell)", baseKg: 130, baseReps: 6, sets: 3, rir: 2 },
      { name: "Seated Row (Cable)", baseKg: 60, baseReps: 10, sets: 3, rir: 2 },
    ],
  };
  const changes = diffFutureDays({ stored, next, weekStart: "2026-07-06", todayIso: "2026-07-07" });

  assert("past days never diffed", changes.every((c) => c.weekday !== "Monday"));
  const kgChange = changes.find((c) => c.field === "baseKg");
  assert("load change detected on future day", kgChange && kgChange.exercise === "Deadlift (Barbell)" && kgChange.from === 132.5 && kgChange.to === 130);
  assert("warmup rows excluded from diff", changes.filter((c) => c.exercise === "Deadlift (Barbell)").length === 1);
  assert("removed exercise detected", changes.some((c) => c.field === "removed" && c.exercise === "Lat Pulldown (Cable)"));
  assert("added exercise detected", changes.some((c) => c.field === "added" && c.exercise === "Seated Row (Cable)"));
  assert("identical inputs → empty diff (idempotence)", diffFutureDays({ stored: next, next, weekStart: "2026-07-06", todayIso: "2026-07-07" }).length === 0);

  const notes = formatRepatchNotes({
    at: "2026-07-07T10:00:00Z",
    reason: "workout_commit",
    workout_date: "2026-07-07",
    changes,
  });
  assert("one note per changed weekday", notes.length === 1 && notes[0].startsWith("Plan updated for Thursday:"));
  assert("note formats load with fmtNum (no trailing zeros)", notes[0].includes("Deadlift (Barbell) 132.5 → 130 kg"));
}
```

- [ ] **Step 2: Run to verify failure**

Run: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs`
Expected: FAIL — module `repatch-week.ts` does not exist.

- [ ] **Step 3: Implement**

Create `lib/coach/prescription/repatch-week.ts`:

```ts
// lib/coach/prescription/repatch-week.ts
//
// Mid-week feed-forward: after a workout commits, re-run the deterministic
// engine for the REMAINING days of the current week and persist the result.
// Past days (≤ today) are never rewritten — they are the historical record of
// what was actually prescribed. When the recompute changes any future day, an
// audit entry is appended to training_weeks.repatch_log; the workout debrief
// surfaces it as a "Plan updated" note. Deterministic and idempotent: firing
// again with unchanged inputs produces an empty diff and writes nothing.
//
// Spec: docs/superpowers/specs/2026-07-09-effort-aware-engine-midweek-repatch-design.md

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  RepatchChange,
  RepatchLogEntry,
  SessionPrescriptions,
  WeekdayLong,
} from "@/lib/data/types";
import type { PlannedExercise } from "@/lib/coach/sessionPlans";
import { daysBetweenIso } from "@/lib/time/dates";
import {
  upsertWeekPrescription,
  WEEKDAY_LONG_ORDER,
} from "@/lib/coach/prescription/upsert-week-prescription";
import { fmtNum } from "@/lib/ui/score";

/** Monday (ISO date) of the week containing `iso`. Pure date arithmetic on a
 *  caller-supplied date — the caller owns the timezone question. */
export function mondayOfIso(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  const dow = (d.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

const NUMERIC_FIELDS = ["baseKg", "baseReps", "sets", "rir"] as const;

/** First non-warmup entry per exercise name (working-set row). Warmup rows
 *  are augmentation artifacts and excluded from the diff. */
function workingByName(day: PlannedExercise[]): Map<string, PlannedExercise> {
  const out = new Map<string, PlannedExercise>();
  for (const ex of day) {
    if (ex.warmup) continue;
    if (!out.has(ex.name)) out.set(ex.name, ex);
  }
  return out;
}

/** Field-level diff between stored and next prescriptions, restricted to
 *  weekdays STRICTLY AFTER todayIso. Pure; exported for the audit script. */
export function diffFutureDays(opts: {
  stored: SessionPrescriptions;
  next: SessionPrescriptions;
  weekStart: string;
  todayIso: string;
}): RepatchChange[] {
  const todayIdx = daysBetweenIso(opts.weekStart, opts.todayIso);
  if (todayIdx == null) return [];
  const changes: RepatchChange[] = [];

  for (let i = todayIdx + 1; i < WEEKDAY_LONG_ORDER.length; i++) {
    const weekday: WeekdayLong = WEEKDAY_LONG_ORDER[i];
    const storedDay = workingByName(opts.stored[weekday] ?? []);
    const nextDay = workingByName(opts.next[weekday] ?? []);

    for (const [name, s] of storedDay) {
      const n = nextDay.get(name);
      if (!n) {
        changes.push({ weekday, exercise: name, field: "removed", from: name, to: null });
        continue;
      }
      for (const field of NUMERIC_FIELDS) {
        const from = s[field] ?? null;
        const to = n[field] ?? null;
        if (from !== to) changes.push({ weekday, exercise: name, field, from, to });
      }
    }
    for (const name of nextDay.keys()) {
      if (!storedDay.has(name)) {
        changes.push({ weekday, exercise: name, field: "added", from: null, to: name });
      }
    }
  }
  return changes;
}

/** Deterministic "Plan updated" note lines for the workout debrief — one per
 *  changed weekday. Pure; exported for the audit script and Task 6. */
export function formatRepatchNotes(entry: RepatchLogEntry): string[] {
  const byDay = new Map<string, string[]>();
  for (const c of entry.changes) {
    let frag: string | null = null;
    if (c.field === "baseKg") frag = `${c.exercise} ${fmtNum(Number(c.from))} → ${fmtNum(Number(c.to))} kg`;
    else if (c.field === "sets") frag = `${c.exercise} ${fmtNum(Number(c.from))} → ${fmtNum(Number(c.to))} sets`;
    else if (c.field === "baseReps") frag = `${c.exercise} ${fmtNum(Number(c.from))} → ${fmtNum(Number(c.to))} reps`;
    else if (c.field === "rir") frag = `${c.exercise} RIR ${fmtNum(Number(c.from))} → ${fmtNum(Number(c.to))}`;
    else if (c.field === "added") frag = `${c.exercise} added`;
    else if (c.field === "removed") frag = `${c.exercise} removed`;
    if (!frag) continue;
    const list = byDay.get(c.weekday) ?? [];
    list.push(frag);
    byDay.set(c.weekday, list);
  }
  return [...byDay.entries()].map(
    ([day, frags]) => `Plan updated for ${day}: ${frags.join(", ")}`,
  );
}

/** Re-run the engine for the remaining days of the current week. Returns
 *  null when there is nothing committed to repatch (no training_weeks row or
 *  no stored session_prescriptions — the Sunday cron / commit flow owns first
 *  writes). Otherwise returns the field-level diff; appends a repatch_log
 *  entry only when the diff is non-empty. */
export async function repatchRemainingWeek(opts: {
  supabase: SupabaseClient;
  userId: string;
  /** Today in the USER's timezone (callers derive via getUserTimezone +
   *  todayInUserTz). Days ≤ today are never rewritten. */
  todayIso: string;
  reason: string;
  /** YYYY-MM-DD of the triggering workout, for the audit entry. */
  workoutDate?: string;
}): Promise<{ changed: boolean; changes: RepatchChange[] } | null> {
  const { supabase, userId, todayIso } = opts;
  const weekStart = mondayOfIso(todayIso);

  const { data: row, error } = await supabase
    .from("training_weeks")
    .select("session_prescriptions, repatch_log")
    .eq("user_id", userId)
    .eq("week_start", weekStart)
    .maybeSingle();
  if (error) throw error;

  const stored = (row?.session_prescriptions as SessionPrescriptions | null) ?? null;
  if (!row || !stored || Object.keys(stored).length === 0) return null;

  const result = await upsertWeekPrescription({
    supabase,
    userId,
    weekStart,
    todayIso,
    preserveDaysThrough: todayIso,
  });

  const changes = diffFutureDays({
    stored,
    next: result.session_prescriptions,
    weekStart,
    todayIso,
  });
  if (changes.length === 0) return { changed: false, changes: [] };

  const entry: RepatchLogEntry = {
    at: new Date().toISOString(),
    reason: opts.reason,
    workout_date: opts.workoutDate ?? null,
    changes,
  };
  const log = Array.isArray(row.repatch_log) ? (row.repatch_log as RepatchLogEntry[]) : [];
  const { error: logErr } = await supabase
    .from("training_weeks")
    .update({ repatch_log: [...log, entry] })
    .eq("user_id", userId)
    .eq("week_start", weekStart);
  if (logErr) throw logErr;

  return { changed: true, changes };
}
```

- [ ] **Step 4: Run fixtures to verify pass**

Run: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs`
Expected: PASS, +11 assertions.

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add lib/coach/prescription/repatch-week.ts scripts/audit-prescription-rules.mjs
git commit -m "feat(engine): repatchRemainingWeek primitive with future-day diff + audit log

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Trigger on workout commit

**Files:**
- Modify: `app/api/logger/session/route.ts`

**Interfaces:**
- Consumes: `repatchRemainingWeek` (Task 4), `getUserTimezone` from `@/lib/time/get-user-tz`, `todayInUserTz` from `@/lib/time`.
- Produces: nothing new — side effect only.

- [ ] **Step 1: Rewrite the POST handler's success path**

Replace the `try { const result = await commitSession(payload); ... }` block in `app/api/logger/session/route.ts` with (imports added at top: `import { repatchRemainingWeek } from "@/lib/coach/prescription/repatch-week"; import { getUserTimezone } from "@/lib/time/get-user-tz"; import { todayInUserTz } from "@/lib/time";`):

```ts
  try {
    const result = await commitSession(payload);

    const supabase = await createSupabaseServerClient();

    // Target-hit evaluator: scan active block for primary-lift PR ≥ target_value
    // and stamp training_blocks.target_hit_at_week. Non-fatal — retries next commit.
    // MUST run before the repatch so a freshly-crossed target flips the engine
    // into consolidation before the remaining days are recomputed.
    try {
      await evaluateAndStampTargetHit({ supabase, userId: payload.user_id });
    } catch (err) {
      console.error("[logger/session] evaluateAndStampTargetHit failed:", err);
    }

    // Mid-week feed-forward: re-run the engine for the remaining days of the
    // current week now that today's sets (and their RIR) exist. Non-fatal —
    // the Sunday cron is the backstop and next week is always freshly computed.
    try {
      const tz = await getUserTimezone(payload.user_id);
      const todayIso = todayInUserTz(new Date(), tz);
      await repatchRemainingWeek({
        supabase,
        userId: payload.user_id,
        todayIso,
        reason: "workout_commit",
        workoutDate: payload.date,
      });
    } catch (err) {
      console.error("[logger/session] repatchRemainingWeek failed:", err);
    }

    return NextResponse.json(result);
  } catch (e) {
```

(The rest of the handler — JSON parsing, field validation, the catch mapping auth errors to 401 — stays exactly as-is. Note the `createSupabaseServerClient()` call moves up one level so both hooks share one client.)

- [ ] **Step 2: Verify ordering + non-fatality by reading the final file**

Confirm: client created once; target-hit before repatch; each hook in its own try/catch; commit response unchanged on repatch failure.

- [ ] **Step 3: Typecheck + timezone audit**

Run: `npm run typecheck && node scripts/audit-timezone-usage.mjs`
Expected: both PASS (`todayInUserTz` is the sanctioned helper).

- [ ] **Step 4: Commit**

```bash
git add app/api/logger/session/route.ts
git commit -m "feat(logger): fire mid-week repatch after workout commit

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Debrief "plan updated" note

**Files:**
- Modify: `lib/coach/session-debrief/index.ts` (after the `composePrescription` call, ~line 123)

**Interfaces:**
- Consumes: `mondayOfIso`, `formatRepatchNotes` (Task 4); `RepatchLogEntry` (Task 1).
- Produces: `payload.prescription.notes` gains "Plan updated for <weekday>: …" lines. Notes already flow to the chat card and the narrative prompt — no payload-shape change.

- [ ] **Step 1: Add the loader**

In `lib/coach/session-debrief/index.ts`, add imports:

```ts
import { mondayOfIso, formatRepatchNotes } from "@/lib/coach/prescription/repatch-week";
import type { RepatchLogEntry } from "@/lib/data/types";
```

Add at module scope (near the other private loaders):

```ts
/** "Plan updated" notes from the mid-week repatch triggered by THIS workout.
 *  Reads training_weeks.repatch_log for the workout's week and formats the
 *  most recent entry matching the workout date. Best-effort: any failure or
 *  absence → empty array (debrief renders without the line). */
async function loadRepatchNotes(
  supabase: SupabaseClient,
  userId: string,
  workoutDate: string,
): Promise<string[]> {
  try {
    const { data } = await supabase
      .from("training_weeks")
      .select("repatch_log")
      .eq("user_id", userId)
      .eq("week_start", mondayOfIso(workoutDate))
      .maybeSingle();
    const log = data?.repatch_log;
    if (!Array.isArray(log)) return [];
    const entries = (log as RepatchLogEntry[]).filter((e) => e.workout_date === workoutDate);
    const latest = entries[entries.length - 1];
    if (!latest || !Array.isArray(latest.changes) || latest.changes.length === 0) return [];
    return formatRepatchNotes(latest);
  } catch {
    return [];
  }
}
```

(If the file has no `SupabaseClient` type import yet, it does — it's the orchestrator; match the existing import.)

- [ ] **Step 2: Wire it in**

Immediately after the `const prescription = composePrescription({ ... });` call (~line 123):

```ts
  // Mid-week repatch visibility: when THIS workout changed the remaining
  // week's numbers, say so — deterministic lines, no AI.
  const repatchNotes = await loadRepatchNotes(supabase, userId, workout.date as string);
  if (repatchNotes.length > 0) prescription.notes.push(...repatchNotes);
```

- [ ] **Step 3: Deterministic TLDR line**

The chat card renders only `tldr` + the narrative's first paragraph ([components/chat/WorkoutDebriefCard.tsx:46-57](../../../components/chat/WorkoutDebriefCard.tsx)); the narrative paraphrase is AI-authored. Mirror the signal deterministically: in `lib/coach/session-debrief/payload.ts`, inside `tldrFromPayload` just before the final `return lines.join("\n");`, add:

```ts
  // Line 3: mid-week repatch signal (deterministic — mirrors the
  // "Plan updated for <weekday>: …" notes written by loadRepatchNotes).
  const repatched = p.prescription.notes.filter((n) => n.startsWith("Plan updated for "));
  if (repatched.length > 0) {
    const days = repatched.map((n) => n.slice("Plan updated for ".length).split(":")[0]);
    lines.push(`↻ Plan updated: ${days.join(", ")}`);
  }
```

- [ ] **Step 4: Typecheck + vitest**

Run: `npm run typecheck && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/coach/session-debrief/index.ts lib/coach/session-debrief/payload.ts
git commit -m "feat(debrief): surface mid-week repatch as plan-updated notes + tldr line

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Carter prompt teaching + full verification

**Files:**
- Modify: `lib/coach/system-prompts.ts` (CARTER_BASE, directly after the `<this_weeks_prescription>` bullet at ~line 132)

**Interfaces:**
- Consumes: nothing — prose only.

- [ ] **Step 1: Add the teaching bullet**

After the line ending `Read from there before fabricating any number.` (~line 132), add:

```
- The engine re-runs for the REMAINING days of the current week after each committed session (effort-aware: a top set ground below its RIR target holds the next load instead of stepping). Mid-week numbers may therefore legitimately differ from Sunday's; the stored prescription in \`<this_weeks_prescription>\` is always canonical, and the change is logged in the week's repatch history.
```

- [ ] **Step 2: Full verification suite**

```bash
npm run typecheck
npx vitest run
node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs
node scripts/audit-timezone-usage.mjs
npm run build
```

Expected: all PASS (build is the render gate — no test harness covers components). Optionally, with live creds: `AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-sunday-prescription-e2e.mjs` — must still pass untouched (Sunday semantics unchanged).

- [ ] **Step 3: Commit**

```bash
git add lib/coach/system-prompts.ts
git commit -m "feat(coach): teach Carter the mid-week repatch semantics

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
