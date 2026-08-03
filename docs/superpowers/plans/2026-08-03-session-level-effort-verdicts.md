# Session-Level Effort Verdicts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `lastWeekClean` and `consecutiveMisses` judging effort from one set — a session that opens clean and then collapses must not earn a load increase.

**Architecture:** Extract the session-grouping and set-predicate helpers that already exist (privately) in `double-progression-rule.ts` into a shared `session-grouping.ts`, then rewrite the two primary/secondary predicates on top of it with **asymmetric** semantics: `lastWeekClean` requires ALL working sets of the latest session to be clean (gates load increases, strict); `consecutiveMisses` counts consecutive STRAINED sessions (gates 10% load cuts, conservative). Both use `every`/`some` over a session, so they are order-independent.

**Tech Stack:** TypeScript (strict), Supabase/PostgREST, vitest (node env).

## Global Constraints

- Path alias `@/*` → repo root. Use it; never relative climbs.
- Verification is `npm run typecheck` + `npx vitest run`. `npm run lint` is a no-op (unconfigured `next lint` that hangs) — do not run it.
- Unit tests live under `lib/**/__tests__/**/*.test.ts` — that glob is the only thing vitest scans.
- The extraction in Task 1 **must be behaviour-neutral** for accessories. The accessory audit assertions are the proof; if any changes result, the extraction is wrong — correct it, do not accommodate it.
- Do NOT change: the `>= 2` cut threshold, the 10% cut magnitude, the 0.92× focus-block clamp, accessory double-progression behaviour, or `compose-prescription.ts`.
- A set is **clean** when `!failure && reps >= repsThreshold && (rir == null || rir >= prescribedRir)`.
- A set is **strained** when `failure || (rir != null && rir < prescribedRir)`.
- `rir` is optional on `WorkoutSetSample` and may be `undefined` as well as `null` — `!= null` covers both. Preserve that legacy degradation exactly.
- Spec: [docs/superpowers/specs/2026-08-03-session-level-effort-verdicts-design.md](../specs/2026-08-03-session-level-effort-verdicts-design.md)

---

### Task 1: Extract the shared session-grouping module

`double-progression-rule.ts` privately defines `SessionSets`, `sessionsFor`, `isClean`, and `isStrained`. Move them to a shared module so the primary/secondary predicates use the same definitions. **Pure extraction — identical logic.**

**Files:**
- Create: `lib/coach/prescription/session-grouping.ts`
- Modify: `lib/coach/prescription/double-progression-rule.ts`
- Test: `lib/coach/prescription/__tests__/session-grouping.test.ts`

**Interfaces:**
- Consumes: `WorkoutSetSample` from `@/lib/coach/prescription/types`.
- Produces:
  - `type ExerciseSession = { date: string; sets: WorkoutSetSample[] }`
  - `sessionsForExercise(recentSets: WorkoutSetSample[], exerciseName: string): ExerciseSession[]`
  - `isCleanSet(s: WorkoutSetSample, repsThreshold: number, prescribedRir: number): boolean`
  - `isStrainedSet(s: WorkoutSetSample, prescribedRir: number): boolean`

- [ ] **Step 1: Write the failing test**

Create `lib/coach/prescription/__tests__/session-grouping.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  sessionsForExercise,
  isCleanSet,
  isStrainedSet,
} from "@/lib/coach/prescription/session-grouping";
import type { WorkoutSetSample } from "@/lib/coach/prescription/types";

function s(overrides: Partial<WorkoutSetSample> = {}): WorkoutSetSample {
  return {
    exercise_name: "Squat (Barbell)",
    exercise_key: null,
    kg: 100,
    reps: 6,
    warmup: false,
    failure: false,
    performed_on: "2026-07-06",
    rir: 2,
    ...overrides,
  };
}

describe("sessionsForExercise", () => {
  it("groups sets by date, newest session first", () => {
    const out = sessionsForExercise(
      [s({ performed_on: "2026-06-29" }), s({ performed_on: "2026-07-06" }), s({ performed_on: "2026-07-06" })],
      "Squat (Barbell)",
    );
    expect(out.map((x) => x.date)).toEqual(["2026-07-06", "2026-06-29"]);
    expect(out[0].sets).toHaveLength(2);
    expect(out[1].sets).toHaveLength(1);
  });

  it("excludes warmup sets", () => {
    const out = sessionsForExercise([s({ warmup: true }), s({})], "Squat (Barbell)");
    expect(out).toHaveLength(1);
    expect(out[0].sets).toHaveLength(1);
  });

  it("drops a session that contributed only warmup sets", () => {
    const out = sessionsForExercise(
      [s({ performed_on: "2026-06-29", warmup: true }), s({ performed_on: "2026-07-06" })],
      "Squat (Barbell)",
    );
    expect(out.map((x) => x.date)).toEqual(["2026-07-06"]);
  });

  it("matches the exercise name case- and whitespace-insensitively", () => {
    const out = sessionsForExercise([s({ exercise_name: "  SQUAT (BARBELL) " })], "Squat (Barbell)");
    expect(out).toHaveLength(1);
  });

  it("ignores other exercises", () => {
    const out = sessionsForExercise([s({ exercise_name: "Deadlift (Barbell)" })], "Squat (Barbell)");
    expect(out).toEqual([]);
  });

  it("returns an empty array for no history", () => {
    expect(sessionsForExercise([], "Squat (Barbell)")).toEqual([]);
  });
});

describe("isCleanSet", () => {
  it("is clean when reps and RIR both meet the prescription", () => {
    expect(isCleanSet(s({ reps: 6, rir: 2 }), 6, 2)).toBe(true);
  });

  it("is dirty on failure regardless of RIR", () => {
    expect(isCleanSet(s({ rir: 4, failure: true }), 6, 2)).toBe(false);
  });

  it("is dirty when reps fall short", () => {
    expect(isCleanSet(s({ reps: 4 }), 6, 2)).toBe(false);
  });

  it("is dirty when RIR is below the prescription", () => {
    expect(isCleanSet(s({ rir: 0 }), 6, 2)).toBe(false);
  });

  it("ignores RIR when it is null (legacy rows)", () => {
    expect(isCleanSet(s({ rir: null }), 6, 2)).toBe(true);
  });

  it("ignores RIR when the field is absent entirely", () => {
    const legacy = s();
    delete (legacy as { rir?: number | null }).rir;
    expect(isCleanSet(legacy, 6, 2)).toBe(true);
  });

  it("treats over-target RIR as merely clean", () => {
    expect(isCleanSet(s({ rir: 4 }), 6, 2)).toBe(true);
  });
});

describe("isStrainedSet", () => {
  it("is strained on failure", () => {
    expect(isStrainedSet(s({ failure: true }), 2)).toBe(true);
  });

  it("is strained when RIR is below the prescription", () => {
    expect(isStrainedSet(s({ rir: 0 }), 2)).toBe(true);
  });

  it("is NOT strained when reps fall short but RIR is fine (athlete chose to stop)", () => {
    expect(isStrainedSet(s({ reps: 2, rir: 3 }), 2)).toBe(false);
  });

  it("is NOT strained when RIR is unrecorded, even with short reps", () => {
    expect(isStrainedSet(s({ reps: 2, rir: null }), 2)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/coach/prescription/__tests__/session-grouping.test.ts`
Expected: FAIL — cannot resolve module `@/lib/coach/prescription/session-grouping`.

- [ ] **Step 3: Create the shared module**

Create `lib/coach/prescription/session-grouping.ts`. The bodies are copied verbatim from the private helpers in `double-progression-rule.ts` — do not "improve" them:

```ts
// lib/coach/prescription/session-grouping.ts
//
// Shared session model for the prescription engine. Effort verdicts are a
// SESSION-level question ("did the athlete own this load last time?"), not a
// single-set one — and the payload from fetchRecentSets cannot reliably
// express "the most recent set" anyway (PostgREST returns embedded
// exercise_sets set_index ASCENDING while workouts come back newest-first).
// Grouping by date and reducing with every/some makes every consumer
// order-independent.
//
// Extracted from double-progression-rule.ts so accessories and
// primaries/secondaries share one definition of clean vs strained.

import type { WorkoutSetSample } from "@/lib/coach/prescription/types";

export type ExerciseSession = { date: string; sets: WorkoutSetSample[] };

/** Non-warmup samples for the exercise, grouped per session date, newest first.
 *
 *  NOTE — dual-slot exercises (e.g. Lateral Raise appears on both Chest and
 *  Arms days): history is name-keyed, so sets from both days merge into the
 *  same session window only when they share a date. This is an ACCEPTED
 *  limitation carried over from the accessory rule; the worst case is a
 *  hold-biased verdict, never a phantom step-up. */
export function sessionsForExercise(
  recentSets: WorkoutSetSample[],
  exerciseName: string,
): ExerciseSession[] {
  const needle = exerciseName.trim().toLowerCase();
  const byDate = new Map<string, WorkoutSetSample[]>();
  for (const s of recentSets) {
    if (s.warmup) continue;
    if (s.exercise_name.trim().toLowerCase() !== needle) continue;
    const list = byDate.get(s.performed_on) ?? [];
    list.push(s);
    byDate.set(s.performed_on, list);
  }
  return [...byDate.entries()]
    .map(([date, sets]) => ({ date, sets }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

/** Clean = completed (not failure), hit the reps threshold, and — when RIR
 *  was recorded — met the prescribed RIR. Null/absent RIR degrades to
 *  reps-only (legacy rows predate migration 0045). */
export function isCleanSet(
  s: WorkoutSetSample,
  repsThreshold: number,
  prescribedRir: number,
): boolean {
  if (s.failure) return false;
  if (s.reps < repsThreshold) return false;
  if (s.rir != null && s.rir < prescribedRir) return false;
  return true;
}

/** Strain evidence: the set was genuinely hard — taken to failure or ground
 *  below the prescribed RIR. Reps-short with high (or unrecorded) RIR means
 *  the athlete CHOSE to stop (lighten compliance, time cap) — that holds, it
 *  never descends. Null-RIR history can therefore only descend via failure. */
export function isStrainedSet(s: WorkoutSetSample, prescribedRir: number): boolean {
  return s.failure || (s.rir != null && s.rir < prescribedRir);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/coach/prescription/__tests__/session-grouping.test.ts`
Expected: PASS (17 tests).

- [ ] **Step 5: Point double-progression-rule at the shared module**

In `lib/coach/prescription/double-progression-rule.ts`:

1. Delete the private `type SessionSets`, `function sessionsFor`, `function isClean`, and `function isStrained` declarations (keep `topSet`, `nextUpKg`, `nextDownKg` and everything else).
2. Add the import beside the existing imports:

```ts
import {
  sessionsForExercise,
  isCleanSet,
  isStrainedSet,
  type ExerciseSession,
} from "@/lib/coach/prescription/session-grouping";
```

3. Update the call sites and type references, keeping argument order identical:
   - `sessionsFor(input.recentSets, ex.name)` → `sessionsForExercise(input.recentSets, ex.name)`
   - `isClean(x, threshold, prescribedRir)` → `isCleanSet(x, threshold, prescribedRir)`
   - `isStrained(x, prescribedRir)` → `isStrainedSet(x, prescribedRir)`
   - any `SessionSets` type annotation → `ExerciseSession`

Use `grep -n "sessionsFor\|isClean\|isStrained\|SessionSets" lib/coach/prescription/double-progression-rule.ts` to find every occurrence and confirm none remain unconverted. Note `isCleanSet`/`isStrainedSet` contain `isClean`/`isStrained` as substrings — re-run the grep after editing and read the results rather than trusting a blind replace.

- [ ] **Step 6: Prove the extraction was behaviour-neutral**

Run: `npm run typecheck && npx vitest run && node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs`

Expected: no type errors, all vitest tests pass, and the audit reports the **same pass count as before this task with 0 failed**. The `double-progression-rule.ts` assertion block must be entirely green.

If any accessory assertion changed, the extraction was not faithful. Fix the extraction — do not edit the assertion.

- [ ] **Step 7: Commit**

```bash
git add lib/coach/prescription/session-grouping.ts lib/coach/prescription/double-progression-rule.ts lib/coach/prescription/__tests__/session-grouping.test.ts
git commit -m "refactor(prescription): extract shared session-grouping helpers

Pure extraction of sessionsFor/isClean/isStrained from
double-progression-rule so primaries and accessories share one definition
of clean vs strained. No behaviour change."
```

---

### Task 2: Rewrite the two predicates with asymmetric semantics

**Files:**
- Modify: `lib/coach/prescription/prescribe-week.ts` (the `lastWeekClean` and `consecutiveMisses` declarations, and the now-unused `setsForExercise` helper)
- Test: `lib/coach/prescription/__tests__/effort-verdicts.test.ts`

**Interfaces:**
- Consumes: `sessionsForExercise`, `isCleanSet`, `isStrainedSet` from Task 1.
- Produces: `lastWeekClean(sets, ex, rirTarget): boolean` and `consecutiveMisses(sets, ex, rirTarget): number` — signatures unchanged, semantics changed. `consecutiveMisses` now counts **sessions**, not sets.

- [ ] **Step 1: Write the failing test**

Create `lib/coach/prescription/__tests__/effort-verdicts.test.ts`. The first two cases are the exact production sessions that exposed the bug:

```ts
import { describe, expect, it } from "vitest";
import { lastWeekClean, consecutiveMisses } from "@/lib/coach/prescription/prescribe-week";
import type { WorkoutSetSample } from "@/lib/coach/prescription/types";
import type { PlannedExercise } from "@/lib/coach/sessionPlans";

function set(
  date: string,
  kg: number,
  reps: number,
  extra: Partial<WorkoutSetSample> = {},
): WorkoutSetSample {
  return {
    exercise_name: "X",
    exercise_key: null,
    kg,
    reps,
    warmup: false,
    failure: false,
    performed_on: date,
    rir: 2,
    ...extra,
  };
}

const EX: PlannedExercise = { name: "X", baseReps: 8, sets: 3, rir: 2 };

describe("lastWeekClean — production regressions", () => {
  it("is dirty when a deadlift session opens clean and ends in failure", () => {
    // 2026-07-23: 90x8 @2, 90x8 @1, 90x8 FAIL @0 — previously read CLEAN.
    const sets = [
      set("2026-07-23", 90, 8, { rir: 2 }),
      set("2026-07-23", 90, 8, { rir: 1 }),
      set("2026-07-23", 90, 8, { rir: 0, failure: true }),
    ];
    expect(lastWeekClean(sets, EX, 2)).toBe(false);
  });

  it("is dirty when an overhead press session collapses after set one", () => {
    // 2026-07-22: 30x10 @2, 30x10 FAIL @0, 30x9 FAIL @0 — previously read CLEAN.
    const ohp: PlannedExercise = { name: "X", baseReps: 10, sets: 3, rir: 2 };
    const sets = [
      set("2026-07-22", 30, 10, { rir: 2 }),
      set("2026-07-22", 30, 10, { rir: 0, failure: true }),
      set("2026-07-22", 30, 9, { rir: 0, failure: true }),
    ];
    expect(lastWeekClean(sets, ohp, 2)).toBe(false);
  });

  it("is clean when every working set of the latest session is clean", () => {
    const sets = [
      set("2026-07-23", 90, 8),
      set("2026-07-23", 90, 8),
      set("2026-07-23", 90, 8),
    ];
    expect(lastWeekClean(sets, EX, 2)).toBe(true);
  });

  it("judges only the latest session, ignoring older dirty ones", () => {
    const sets = [
      set("2026-07-23", 90, 8),
      set("2026-07-16", 90, 8, { failure: true }),
    ];
    expect(lastWeekClean(sets, EX, 2)).toBe(true);
  });

  it("is dirty with no history at all", () => {
    expect(lastWeekClean([], EX, 2)).toBe(false);
  });

  it("is dirty when a compliant reps-short set is present (no step earned)", () => {
    const sets = [set("2026-07-23", 90, 8), set("2026-07-23", 90, 5, { rir: 3 })];
    expect(lastWeekClean(sets, EX, 2)).toBe(false);
  });
});

describe("consecutiveMisses — counts strained sessions", () => {
  it("counts consecutive sessions containing a strained set", () => {
    const sets = [
      set("2026-07-23", 90, 8, { rir: 0 }),
      set("2026-07-16", 90, 8, { failure: true }),
      set("2026-07-09", 90, 8),
    ];
    expect(consecutiveMisses(sets, EX, 2)).toBe(2);
  });

  it("stops at the first unstrained session", () => {
    const sets = [
      set("2026-07-23", 90, 8, { rir: 0 }),
      set("2026-07-16", 90, 8),
      set("2026-07-09", 90, 8, { failure: true }),
    ];
    expect(consecutiveMisses(sets, EX, 2)).toBe(1);
  });

  it("does NOT count a compliant reps-short session as a miss", () => {
    // Athlete chose to stop: reps short, RIR at target, no failure.
    const sets = [set("2026-07-23", 90, 4, { rir: 3 })];
    expect(consecutiveMisses(sets, EX, 2)).toBe(0);
  });

  it("does NOT count reps-short with unrecorded RIR as a miss", () => {
    const sets = [set("2026-07-23", 90, 4, { rir: null })];
    expect(consecutiveMisses(sets, EX, 2)).toBe(0);
  });

  it("counts a whole session once even when several of its sets are strained", () => {
    const sets = [
      set("2026-07-23", 90, 8, { rir: 0 }),
      set("2026-07-23", 90, 8, { failure: true }),
    ];
    expect(consecutiveMisses(sets, EX, 2)).toBe(1);
  });

  it("returns 0 with no history", () => {
    expect(consecutiveMisses([], EX, 2)).toBe(0);
  });

  it("honours a per-exercise rir override above the week target", () => {
    const sets = [set("2026-07-23", 90, 8, { rir: 2 })];
    expect(consecutiveMisses(sets, { ...EX, rir: 3 }, 2)).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/coach/prescription/__tests__/effort-verdicts.test.ts`
Expected: FAIL. The two production-regression tests fail with `expected true to be false` — that is the bug reproducing. Several `consecutiveMisses` tests also fail because it currently counts sets.

- [ ] **Step 3: Rewrite the predicates**

In `lib/coach/prescription/prescribe-week.ts`, add the import beside the other prescription-rule imports:

```ts
import {
  sessionsForExercise,
  isCleanSet,
  isStrainedSet,
} from "@/lib/coach/prescription/session-grouping";
```

Replace the whole `lastWeekClean` function (including its docstring) with:

```ts
/** True when EVERY working set of the athlete's most recent session for this
 *  exercise was clean: not failure, hit the prescribed reps, and — when RIR
 *  was recorded — met the prescribed RIR (`ex.rir ?? rirTarget`).
 *
 *  Gates a load INCREASE, so it is deliberately strict: a session that opens
 *  clean and then collapses must not earn a step. Judged over the whole
 *  session via `every`, so it does not depend on set ordering (fetchRecentSets
 *  cannot reliably express "the most recent set" — see session-grouping.ts).
 *  Exported for scripts/audit-prescription-rules.mjs. */
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
```

Replace the whole `consecutiveMisses` function (including its docstring) with:

```ts
/** Count consecutive recent SESSIONS (newest first) in which the athlete
 *  showed strain on this exercise — a set taken to failure, or ground below
 *  the prescribed RIR. Stops at the first unstrained session.
 *
 *  Gates a 10% load CUT, so it is deliberately conservative: a compliant
 *  reps-short session (stopped early at or above target RIR, no failure) is
 *  NOT a miss. That mirrors the accessory ladder's step-down rule — the
 *  athlete choosing to stop holds the load, it never descends.
 *  Exported for scripts/audit-prescription-rules.mjs. */
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

- [ ] **Step 4: Remove the now-unused helper**

`setsForExercise` in `prescribe-week.ts` existed only to serve these two predicates. Run:

```bash
grep -n "setsForExercise" lib/coach/prescription/prescribe-week.ts
```

If the only remaining hit is its own declaration, delete the function. If any other caller exists, leave it alone and note which caller kept it alive.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run lib/coach/prescription/__tests__/effort-verdicts.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 6: Typecheck and full unit suite**

Run: `npm run typecheck && npx vitest run`
Expected: no type errors; all tests pass.

- [ ] **Step 7: Commit**

```bash
git add lib/coach/prescription/prescribe-week.ts lib/coach/prescription/__tests__/effort-verdicts.test.ts
git commit -m "fix(prescription): judge effort per session, not per set

lastWeekClean read setsForExercise(...)[0], which is the FIRST set of the
latest session (PostgREST returns embedded exercise_sets set_index
ascending), so a session that opened clean and then collapsed earned a
load increase. Verified on production: Deadlift 90x8@2/90x8@1/90x8 fail@0
and OHP 30x10@2/30x10 fail@0/30x9 fail@0 both read clean.

Asymmetric fix: lastWeekClean now requires ALL working sets of the latest
session to be clean (gates increases); consecutiveMisses counts
consecutive STRAINED sessions (gates cuts), so a compliant reps-short
session holds instead of descending."
```

---

### Task 3: Ordering hardening + audit assertions

**Files:**
- Modify: `lib/coach/prescription/prescribe-week.ts` (`fetchRecentSets`)
- Modify: `scripts/audit-prescription-rules.mjs`

**Interfaces:**
- Consumes: the predicates from Task 2.
- Produces: no new interfaces — regression coverage and a contractual ordering guarantee.

- [ ] **Step 1: Make the embedded set ordering contractual**

In `fetchRecentSets`, add `set_index` to the selected columns and order the embedded resource. Verified working on supabase-js 2.105.1 against production — `ascending: false` returns `idx2 idx1 idx0`, so the order genuinely applies two levels deep:

```ts
  const { data, error } = await supabase
    .from("workouts")
    .select("date, exercises(name, exercise_sets(kg, reps, warmup, failure, rir, set_index))")
    .eq("user_id", userId)
    .gte("date", cutoff)
    .order("date", { ascending: false })
    .order("set_index", { referencedTable: "exercises.exercise_sets", ascending: true });
```

Add `set_index: number | null` to the local `RawSet` type in that function so the added column typechecks. The mapping loop does not need to read it — this is a contract, not a behaviour change (both new predicates are order-independent). Use `referencedTable`, not the deprecated `foreignTable` alias.

- [ ] **Step 2: Update the one audit assertion whose expected value legitimately changes**

In `scripts/audit-prescription-rules.mjs`, find:

```js
  assert(
    "consecutiveMisses legacy path unchanged when RIR absent",
    consecutiveMisses([{ ...base, reps: 4 }, base], ex, 2) === 1,
  );
```

Both fixture sets share `performed_on: "2026-07-06"`, so they are ONE session, and neither is strained (`reps: 4` is short, but `rir` is absent). Under the new rule that is the "athlete chose to stop" case, which must hold rather than descend. Replace with:

```js
  assert(
    "reps-short with no recorded RIR does not count as a miss (athlete chose to stop)",
    consecutiveMisses([{ ...base, reps: 4 }, base], ex, 2) === 0,
  );
```

**This is the only existing assertion whose expected value changes.** All eight `lastWeekClean` assertions are single-set fixtures (a one-set session) and stay valid; the other two `consecutiveMisses` assertions use distinct `performed_on` dates and stay valid. If anything else fails, the implementation is wrong — fix the code, not the assertion.

- [ ] **Step 3: Add session-level audit assertions**

Append to the `## prescribe-week.ts — RIR-aware clean predicates` block in `scripts/audit-prescription-rules.mjs`, immediately after the existing assertions and inside the same `{ ... }` scope:

```js
  // Session-level semantics (2026-08-03). The two production regressions that
  // exposed the single-set bug, plus the asymmetry between the two gates.
  const dl = { name: "Deadlift (Barbell)", baseReps: 8, sets: 3, rir: 2 };
  const dlBase = { exercise_name: "Deadlift (Barbell)", exercise_key: null, kg: 90, warmup: false, failure: false, performed_on: "2026-07-23" };
  const collapsed = [
    { ...dlBase, reps: 8, rir: 2 },
    { ...dlBase, reps: 8, rir: 1 },
    { ...dlBase, reps: 8, rir: 0, failure: true },
  ];
  assert("collapsed session is dirty (was clean pre-fix)", lastWeekClean(collapsed, dl, 2) === false);
  assert("collapsed session counts as one strained session", consecutiveMisses(collapsed, dl, 2) === 1);

  const allClean = [
    { ...dlBase, reps: 8, rir: 2 },
    { ...dlBase, reps: 8, rir: 2 },
    { ...dlBase, reps: 8, rir: 2 },
  ];
  assert("all-clean session earns the step", lastWeekClean(allClean, dl, 2) === true);
  assert("all-clean session is not a miss", consecutiveMisses(allClean, dl, 2) === 0);

  // Asymmetry: compliant reps-short blocks the step but does NOT trigger a cut.
  const compliantShort = [{ ...dlBase, reps: 4, rir: 3 }];
  assert("compliant reps-short does not earn a step", lastWeekClean(compliantShort, dl, 2) === false);
  assert("compliant reps-short does not count as a miss", consecutiveMisses(compliantShort, dl, 2) === 0);

  // Only the latest session gates the step.
  const latestCleanOlderDirty = [
    { ...dlBase, reps: 8, rir: 2 },
    { ...dlBase, reps: 8, rir: 0, failure: true, performed_on: "2026-07-16" },
  ];
  assert("older dirty session does not block a clean latest session", lastWeekClean(latestCleanOlderDirty, dl, 2) === true);
  assert("empty history is dirty with zero misses", lastWeekClean([], dl, 2) === false && consecutiveMisses([], dl, 2) === 0);
```

- [ ] **Step 4: Run both audits**

Run:
```bash
node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs
AUDIT_USER_ID=94fee5c6-7d9a-4b05-be3a-8407505b5429 node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-sunday-prescription-e2e.mjs
```

Expected: `audit-prescription-rules` reports `0 failed`. The e2e audit reports the same 3 pre-existing on-grid failures it had before this branch (Rear Delt Fly 29.3 kg, Hip Abductor 61 kg, Chest Fly 32 kg) and no new ones — those are unrelated realized machine pin weights.

- [ ] **Step 5: Confirm the end-to-end blast radius**

Write this throwaway script to `scripts/_tmp-diff.mjs`, run it, and compare against the expectation below:

```js
import { createClient } from "@supabase/supabase-js";
import { prescribeWeek } from "@/lib/coach/prescription/prescribe-week";
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const u = "94fee5c6-7d9a-4b05-be3a-8407505b5429";
const { data: week } = await s.from("training_weeks").select("*").eq("user_id", u).eq("week_start", "2026-08-03").single();
const { data: block } = await s.from("training_blocks").select("*").eq("user_id", u).eq("status", "active").maybeSingle();
const out = await prescribeWeek({ supabase: s, userId: u, block, week, todayIso: "2026-08-03" });
const rows = [];
for (const [day, ex] of Object.entries(out)) for (const e of ex ?? []) if (!e.warmup) rows.push(`${day}|${e.name}|${e.baseKg}x${e.baseReps}x${e.sets}`);
console.log(rows.sort().join("\n"));
```

Run: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/_tmp-diff.mjs`

Expected: `Tuesday|Overhead Press (Barbell)|25x10x3`. Pre-fix this line read `30x10x3`; the drop is the autoregulation cut firing correctly after repeated grinding at RIR 0. **Every other line must be unchanged** — in particular `Thursday|Deadlift (Barbell)|82.5x8x3`, which the 0.92× focus-block clamp holds steady regardless of the verdict.

If any other line moved, stop and investigate before proceeding.

Then delete the script: `rm -f scripts/_tmp-diff.mjs`

- [ ] **Step 6: Full verification**

Run: `npm run typecheck && npx vitest run && node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs`
Expected: no type errors, all vitest tests pass, audit reports `0 failed`.

- [ ] **Step 7: Update the stale memory note**

`~/.claude/projects/-Users-abdelouahedelbied-Health-app/memory/reference_prescription_set_ordering.md` says "Still unfixed as of PR #159". Update that line to record that it was fixed on this branch, that the predicates are now session-grouped and order-independent, and that `fetchRecentSets` now orders the embed explicitly. Keep the rest of the file (the PostgREST ordering fact is still worth knowing).

- [ ] **Step 8: Commit**

```bash
git add lib/coach/prescription/prescribe-week.ts scripts/audit-prescription-rules.mjs
git commit -m "test(prescription): session-level verdict assertions + ordering contract

Adds an explicit set_index order to the embedded exercise_sets so the
payload's ordering is contractual rather than incidental, and covers the
two production regressions plus the clean/strained asymmetry.

Updates one existing assertion whose expected value legitimately changes:
reps-short with unrecorded RIR is now 0 misses, not 1 — the athlete chose
to stop, which holds rather than descends."
```

---

## Self-Review

**Spec coverage:**
- Asymmetric semantics (A for `lastWeekClean`, C for `consecutiveMisses`) → Task 2
- Shared session-grouping module + faithful extraction → Task 1 (behaviour-neutrality gate at Step 6)
- Rejected top-set alternative → no task needed (documented decision, not code)
- Ordering hardening with `referencedTable` → Task 3 Step 1
- Rollout: no migration, no grandfathering → nothing to build; the 28-day window in `fetchRecentSets` is unchanged
- Testing: new `session-grouping` suite → Task 1; new `effort-verdicts` suite → Task 2; the one changed assertion + new session-level assertions → Task 3; behaviour-neutrality check → Task 1 Step 6; e2e confirmation of OHP 30→25 → Task 3 Step 5
- Risks: OHP drop is asserted explicitly in Task 3 Step 5 so it cannot pass unnoticed

**Type consistency:** `sessionsForExercise` / `isCleanSet` / `isStrainedSet` / `ExerciseSession` are named identically in Tasks 1, 2 and 3. Argument order (`sets, exerciseName`; `set, repsThreshold, prescribedRir`; `set, prescribedRir`) matches the originals being replaced.

**Out of scope, deliberately:** `compose-prescription.ts`'s `lift.tag === "PR"` proxy; the three pre-existing off-grid machine weights; any change to cut threshold, cut magnitude, or the focus-block clamp.
