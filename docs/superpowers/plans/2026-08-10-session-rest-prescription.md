# Session Rest Prescription Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the session-structure rest ranges with single, honest per-tier values; add rest between exercises; give the last warm-up a real rest; and make the logger's manual rest override durable for the whole exercise.

**Architecture:** All prescription logic stays in the existing pure module `lib/coach/session-structure/`. A new `restSecondsFor(ex, tier)` returns one number instead of a `{min, max}` range, with a large-vs-small muscle split inside tier 3 driven by the existing `getExerciseMuscles` map. `annotateSession` gains a post-pass that bumps the last warm-up entry and computes a per-exercise `transition_seconds`. In the logger, the manual rest override moves out of React state and onto `ExerciseDraft`, so the existing draft-persist path carries it through resume and reorder for free.

**Tech Stack:** TypeScript (strict), Next.js 15 App Router, React 19 client components, vitest (node environment).

**Spec:** [docs/superpowers/specs/2026-08-10-session-rest-prescription-design.md](../specs/2026-08-10-session-rest-prescription-design.md)

## Global Constraints

- **Branch:** work on `docs/session-rest-prescription`, already rebased onto `main` at `da5fdd8`. Do not commit to `main`.
- **Verify with:** `npm run typecheck` + `npx vitest run`. There is no working linter (`npm run lint` is a no-op).
- **`npm run build` is required before the final commit.** Per the no-render-test-harness constraint, vitest is node-environment only and does not scan components — a React hooks-order error passes typecheck and vitest and only fails in a production build. Tasks 4 and 5 both touch hooks in `ExerciseCard`.
- **Test glob is `lib/**/__tests__/**/*.test.ts`** ([vitest.config.ts](../../../vitest.config.ts)). Tests placed anywhere else, including under `components/`, will never run.
- **Path alias `@/*` → repo root.** Use it; do not write relative climbs.
- **Number display:** any user-visible number goes through the existing formatting conventions — max 2 decimals, trailing zeros trimmed. The rest values here are whole seconds, so this only affects the `fmtRest` helper's minute conversion.
- **Naming deviation from the spec:** the spec calls the function `restPrescription(ex, tier)`. This plan names it **`restSecondsFor(ex, tier)`** instead. Two reasons: the name states that the return is a scalar count of seconds rather than a "prescription" object, and introducing it under a new name lets the old `restPrescription` survive until Task 3, so the tree compiles and all tests pass at every commit. The old name is deleted in Task 3.

## File Structure

| File | Responsibility |
|---|---|
| `lib/coach/session-structure/rules.ts` (modify) | Adds `REST_SECONDS`, `TRANSITION_BUFFER_SECONDS`, `isolationSize`, `restSecondsFor`. Deletes `restPrescription` in Task 3. |
| `lib/coach/session-structure/annotate.ts` (modify) | `rest_seconds: number`, new `transition_seconds`, and the `applyRestPasses` post-pass (last-warm-up bump + transitions). |
| `lib/coach/session-structure/__tests__/rest.test.ts` (create) | The only test coverage this module has ever had. Covers the table, the tier-3 split, the bump, and transitions. |
| `lib/ui/rest-format.ts` (create) | Single `fmtRest(seconds)` display helper, replacing two duplicate `fmtRestRange` copies. |
| `lib/logger/types.ts` (modify) | `ExerciseDraft.rest_override_seconds`. |
| `components/logger/ExerciseCard.tsx` (modify) | Reads the override from the draft; passes a live duration to `RestBar`; fires the transition bar after an exercise's last set. |
| `components/logger/RestBar.tsx` (modify) | Optional `label` prop for the `Next: {name}` transition copy. |
| `components/logger/RestTimeDialog.tsx` (modify) | Preset list re-aligned to the new table. |
| `components/morning/BriefSessionList.tsx`, `components/strength/TodayPlanCard.tsx` (modify) | Drop local `fmtRestRange`, import `fmtRest`. |
| `components/strength/SessionStructureBanner.tsx` (modify) | Strip `transition_seconds` alongside the other annotation fields. |
| `lib/coach/live-session/rule-rest-discipline.ts` (modify) | Migrate to `restSecondsFor`; thresholds rise. |
| `lib/coach/live-session/__tests__/evaluate-set.test.ts` (modify) | Stale threshold comment corrected. |

---

### Task 1: Rest table primitives

Pure functions only. Nothing consumes them yet, so the tree stays green and every existing test keeps passing.

**Files:**
- Modify: `lib/coach/session-structure/rules.ts`
- Create: `lib/coach/session-structure/__tests__/rest.test.ts`

**Interfaces:**
- Consumes: `getExerciseMuscles(name)` and `MUSCLE_ID` from `@/lib/coach/exercise-muscles`; `FatigueTier` from `./tiers`; `PlannedExercise` from `@/lib/coach/sessionPlans`.
- Produces:
  - `REST_SECONDS` — frozen record of the seven named values.
  - `TRANSITION_BUFFER_SECONDS: number` (60).
  - `isolationSize(name: string): "large" | "small"`.
  - `restSecondsFor(ex: PlannedExercise, tier: FatigueTier): number`.

- [ ] **Step 1: Write the failing test**

Create `lib/coach/session-structure/__tests__/rest.test.ts`.

Every exercise name below was verified to exist in both `FATIGUE_TIER` ([tiers.ts](../../../lib/coach/session-structure/tiers.ts)) and `EXERCISE_MUSCLES` ([exercise-muscles.ts](../../../lib/coach/exercise-muscles.ts)). Do not substitute other names without checking both maps — a name missing from `EXERCISE_MUSCLES` silently classifies as `"small"`.

```ts
import { describe, it, expect } from "vitest";
import { REST_SECONDS, TRANSITION_BUFFER_SECONDS, isolationSize, restSecondsFor } from "@/lib/coach/session-structure/rules";
import { tierOf } from "@/lib/coach/session-structure/tiers";
import type { PlannedExercise } from "@/lib/coach/sessionPlans";

// PlannedExercise requires only `name`; every other field is optional, so no
// cast is needed here.
function ex(name: string, over: Partial<PlannedExercise> = {}): PlannedExercise {
  return { name, sets: 3, reps: "8", ...over };
}

describe("isolationSize", () => {
  it("classifies a large-muscle isolation as large", () => {
    expect(isolationSize("Chest Fly")).toBe("large");
    expect(isolationSize("Leg Extension (Machine)")).toBe("large");
    expect(isolationSize("Leg Curl (Machine)")).toBe("large");
  });

  it("classifies a small-muscle isolation as small", () => {
    expect(isolationSize("Lateral Raise (Dumbbell)")).toBe("small");
    expect(isolationSize("Triceps Pushdown")).toBe("small");
    expect(isolationSize("Bicep Curl (Dumbbell)")).toBe("small");
  });

  it("resolves a mixed large+small primary set to large", () => {
    // "chin up" maps to primary [Lats, Biceps] — one large, one small.
    expect(isolationSize("Chin Up")).toBe("large");
  });

  it("falls back to small for an unmapped exercise name", () => {
    expect(isolationSize("Zercher Good Morning")).toBe("small");
  });
});

describe("restSecondsFor", () => {
  it("gives a heavy compound 4 minutes", () => {
    const e = ex("Squat (Barbell)");
    expect(tierOf(e)).toBe(1);
    expect(restSecondsFor(e, 1)).toBe(240);
  });

  it("gives a secondary compound 3 minutes", () => {
    const e = ex("Seated Cable Row");
    expect(tierOf(e)).toBe(2);
    expect(restSecondsFor(e, 2)).toBe(180);
  });

  it("gives a large-muscle isolation 2 minutes", () => {
    const e = ex("Chest Fly");
    expect(tierOf(e)).toBe(3);
    expect(restSecondsFor(e, 3)).toBe(120);
  });

  it("gives a small-muscle isolation 60 seconds", () => {
    const e = ex("Lateral Raise (Dumbbell)");
    expect(tierOf(e)).toBe(3);
    expect(restSecondsFor(e, 3)).toBe(60);
  });

  it("gives a warm-up ramp and a finisher 45 seconds", () => {
    expect(restSecondsFor(ex("Squat (Barbell)", { warmup: true }), 0)).toBe(45);
    expect(restSecondsFor(ex("Plank"), 4)).toBe(45);
  });

  it("ignores the rep target — a 5-rep and a 10-rep squat rest the same", () => {
    expect(restSecondsFor(ex("Squat (Barbell)", { reps: "5" }), 1)).toBe(
      restSecondsFor(ex("Squat (Barbell)", { reps: "10" }), 1),
    );
  });

  it("exposes the constants the annotation layer builds on", () => {
    expect(REST_SECONDS.lastWarmup).toBe(120);
    expect(TRANSITION_BUFFER_SECONDS).toBe(60);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/coach/session-structure/__tests__/rest.test.ts`
Expected: FAIL — `No "restSecondsFor" export is defined on the module`.

- [ ] **Step 3: Add the primitives to `rules.ts`**

Add the `getExerciseMuscles` / `MUSCLE_ID` import to the existing import block at the top of [rules.ts](../../../lib/coach/session-structure/rules.ts) — the file already imports `getExerciseMuscles`, so extend that line to also pull `MUSCLE_ID`:

```ts
import { getExerciseMuscles, MUSCLE_ID } from "@/lib/coach/exercise-muscles";
```

Then insert the following directly above the existing `restPrescription` function (leave `restPrescription` in place — Task 3 removes it):

```ts
/** Single-value rest prescription per bucket, in seconds.
 *
 *  Rest length matters because it protects volume-load: anything that costs
 *  reps on sets 2-4 costs the stimulus set 1 bought (Schoenfeld 2016; Grgic
 *  2017/2018 meta-analyses). These are the values the athlete is expected to
 *  actually take, not the floor of a range. */
export const REST_SECONDS = {
  warmup: 45,
  /** The ramp set immediately before the first working exercise. 45s here
   *  compromises the heaviest set of the day. */
  lastWarmup: 120,
  heavyCompound: 240,
  secondaryCompound: 180,
  isolationLarge: 120,
  isolationSmall: 60,
  finisher: 45,
} as const;

/** Added to the incoming exercise's rest to produce the between-exercise
 *  transition: station change, plate loading, set-up. */
export const TRANSITION_BUFFER_SECONDS = 60;

/** Primary muscles expensive enough that an isolation taken near failure
 *  needs compound-like recovery. */
const LARGE_MUSCLE_IDS: ReadonlySet<number> = new Set([
  MUSCLE_ID.Chest,
  MUSCLE_ID.Lats,
  MUSCLE_ID.Quads,
  MUSCLE_ID.Hams,
  MUSCLE_ID.Glutes,
  MUSCLE_ID.Traps,
]);

/** Large- vs small-muscle isolation. A leg extension to failure imposes
 *  local and systemic fatigue on a par with a light compound; a lateral
 *  raise recovers in about a minute.
 *
 *  Any large muscle in the primary set makes the exercise expensive, so
 *  mixed primaries resolve to "large". An unmapped name resolves to "small"
 *  deliberately: that yields the shortest timer, and the athlete can lengthen
 *  it from the logger's rest dialog in one tap. A wrong-but-long default
 *  costs four minutes of standing around before anyone notices. */
export function isolationSize(name: string): "large" | "small" {
  const mapping = getExerciseMuscles(name);
  if (!mapping || mapping.primary.length === 0) return "small";
  return mapping.primary.some((id) => LARGE_MUSCLE_IDS.has(id)) ? "large" : "small";
}

/** Rest in seconds for one exercise, given its fatigue tier.
 *
 *  Reps are deliberately not an input. The old range-based table branched on
 *  rep count; the values above are set by how expensive the movement is, and
 *  a 5-rep and a 10-rep squat both need a full recovery before the next set.
 *
 *  Tier 0 returns the plain warm-up value. The last-warm-up bump to
 *  REST_SECONDS.lastWarmup depends on the NEXT exercise and so belongs to
 *  annotateSession, not here — keeping this function a pure (ex, tier) lookup
 *  is what makes it directly testable. */
export function restSecondsFor(ex: PlannedExercise, tier: FatigueTier): number {
  switch (tier) {
    case 0: return REST_SECONDS.warmup;
    case 1: return REST_SECONDS.heavyCompound;
    case 2: return REST_SECONDS.secondaryCompound;
    case 3:
      return isolationSize(ex.name) === "large"
        ? REST_SECONDS.isolationLarge
        : REST_SECONDS.isolationSmall;
    case 4: return REST_SECONDS.finisher;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/coach/session-structure/__tests__/rest.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Verify nothing else broke**

Run: `npm run typecheck && npx vitest run`
Expected: typecheck clean; the full suite passes. `restPrescription` is still present and still used, so `annotate.ts` and `rule-rest-discipline.ts` are untouched.

- [ ] **Step 6: Commit**

```bash
git add lib/coach/session-structure/rules.ts lib/coach/session-structure/__tests__/rest.test.ts
git commit -m "feat(rest): single-value muscle-size-aware rest table"
```

---

### Task 2: Annotation shape — single value, last-warm-up bump, transitions

Flips the annotation to the new primitives and updates every consumer that renders it, in one commit — `AnnotatedExercise.rest_seconds` changing type breaks all of them simultaneously.

**Files:**
- Modify: `lib/coach/session-structure/annotate.ts`
- Create: `lib/ui/rest-format.ts`
- Modify: `components/morning/BriefSessionList.tsx`, `components/strength/TodayPlanCard.tsx`, `components/strength/SessionStructureBanner.tsx`, `components/logger/ExerciseCard.tsx`
- Test: `lib/coach/session-structure/__tests__/rest.test.ts` (extend)

**Interfaces:**
- Consumes: `restSecondsFor`, `REST_SECONDS`, `TRANSITION_BUFFER_SECONDS` from Task 1.
- Produces:
  - `AnnotatedExercise.rest_seconds: number` (was `{min, max}`).
  - `AnnotatedExercise.transition_seconds: number | null`.
  - `fmtRest(seconds: number): string` from `@/lib/ui/rest-format`.

- [ ] **Step 1: Write the failing test**

Append to `lib/coach/session-structure/__tests__/rest.test.ts`:

```ts
import { annotateSession } from "@/lib/coach/session-structure/annotate";

/** A realistic lifting day: two ramp warm-ups on the opening compound, then
 *  a secondary, a large isolation, a small isolation, and a core finisher. */
function liftingDay(): PlannedExercise[] {
  return [
    ex("Squat (Barbell)", { warmup: true, reps: "5" }),
    ex("Squat (Barbell)", { warmup: true, reps: "3" }),
    ex("Squat (Barbell)", { reps: "5" }),
    ex("Seated Cable Row"),
    ex("Leg Extension (Machine)"),
    ex("Lateral Raise (Dumbbell)"),
    ex("Plank"),
  ];
}

describe("annotateSession — rest", () => {
  it("prescribes one number per exercise, not a range", () => {
    const s = annotateSession(liftingDay());
    expect(typeof s.exercises[2].rest_seconds).toBe("number");
    expect(s.exercises[2].rest_seconds).toBe(240);
    expect(s.exercises[3].rest_seconds).toBe(180);
  });

  it("bumps the LAST warm-up before the first working exercise, not the first warm-up", () => {
    const s = annotateSession(liftingDay());
    expect(s.exercises[0].rest_seconds).toBe(45);
    expect(s.exercises[1].rest_seconds).toBe(120);
  });

  it("no-ops the bump on a session with no warm-ups", () => {
    const s = annotateSession([ex("Seated Cable Row"), ex("Chest Fly")]);
    expect(s.exercises.map((e) => e.rest_seconds)).toEqual([180, 120]);
  });

  it("no-ops the bump when every entry is a warm-up", () => {
    const s = annotateSession([
      ex("Squat (Barbell)", { warmup: true }),
      ex("Squat (Barbell)", { warmup: true }),
    ]);
    expect(s.exercises.map((e) => e.rest_seconds)).toEqual([45, 45]);
  });

  it("sets transition_seconds to the incoming exercise's rest plus a minute", () => {
    const s = annotateSession(liftingDay());
    expect(s.exercises[3].transition_seconds).toBe(240); // into the row: 180 + 60
    expect(s.exercises[4].transition_seconds).toBe(180); // into leg ext: 120 + 60
    expect(s.exercises[5].transition_seconds).toBe(120); // into lateral: 60 + 60
    expect(s.exercises[6].transition_seconds).toBe(105); // into plank: 45 + 60
  });

  it("leaves transition_seconds null on the first exercise and on every warm-up", () => {
    const s = annotateSession(liftingDay());
    expect(s.exercises[0].transition_seconds).toBeNull();
    expect(s.exercises[1].transition_seconds).toBeNull();
    expect(s.exercises[2].transition_seconds).toBe(300); // into the squat: 240 + 60
  });

  it("derives the transition from the prescription, not from a bumped warm-up value", () => {
    // The exercise at index 1 is bumped to 120s of REST, but it is a warm-up,
    // so it contributes no transition at all.
    const s = annotateSession(liftingDay());
    expect(s.exercises[1].rest_seconds).toBe(120);
    expect(s.exercises[1].transition_seconds).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/coach/session-structure/__tests__/rest.test.ts`
Expected: FAIL — `expected { min: 180, max: 300 } to be 240`.

- [ ] **Step 3: Rewrite the annotation in `annotate.ts`**

In [annotate.ts](../../../lib/coach/session-structure/annotate.ts):

Change the import block to pull the new names (drop `restPrescription`, keep `repsForExercise` — `annotateOne` no longer needs it for rest, but nothing else in this file uses it, so remove it from this import too):

```ts
import {
  findOrderingWarnings,
  restSecondsFor,
  rpePrescription,
  REST_SECONDS,
  TRANSITION_BUFFER_SECONDS,
  type OrderingWarning,
} from "./rules";
```

Change the two `AnnotatedExercise` fields:

```ts
export type AnnotatedExercise = PlannedExercise & {
  fatigue_tier: FatigueTier;
  /** Rest between sets of THIS exercise, in seconds. */
  rest_seconds: number;
  /** Rest to take BEFORE starting this exercise — i.e. after finishing the
   *  previous one. Null on the session's first exercise and on every warm-up
   *  entry. */
  transition_seconds: number | null;
  rpe_target: string;
  /** Optional per-exercise cue derived from related warnings (e.g.,
   *  "Pre-fatigued from Triceps Pushdown — expect ~15% strength drop"). */
  cue?: string;
};
```

In `annotateOne`, delete the `const reps = repsForExercise(ex);` line and replace the `rest_seconds` field. `transition_seconds` is set to null here and filled in by the post-pass, which is the only place that can see neighbours:

```ts
  return {
    ...ex,
    fatigue_tier: tier,
    rest_seconds: restSecondsFor(ex, tier),
    transition_seconds: null,
    rpe_target,
  };
```

Add the post-pass function directly above `annotateSession`:

```ts
/** Neighbour-dependent rest adjustments. Runs on the annotated array in
 *  session order, after annotateOne has set each exercise's own prescription.
 *
 *  Two passes, both of which need to see the exercise's neighbours and so
 *  cannot live in the pure (ex, tier) lookup:
 *
 *  1. The last warm-up before the first working exercise is bumped to
 *     REST_SECONDS.lastWarmup. It is the only thing standing between the
 *     athlete and the heaviest set of the day.
 *  2. transition_seconds — rest before starting this exercise — is the
 *     incoming exercise's own prescription plus a setup buffer. It is set by
 *     the demand of what is COMING, not the fatigue of what just finished.
 *     Null on index 0 (nothing precedes it) and on warm-ups (the ramp is the
 *     transition). */
function applyRestPasses(annotated: AnnotatedExercise[]): AnnotatedExercise[] {
  return annotated.map((ex, i) => {
    const isWarmup = ex.warmup === true;
    const next = annotated[i + 1];
    const isLastWarmup = isWarmup && next !== undefined && next.warmup !== true;

    return {
      ...ex,
      rest_seconds: isLastWarmup ? REST_SECONDS.lastWarmup : ex.rest_seconds,
      // Derived from the untouched prescription, never from a bumped value.
      transition_seconds:
        i === 0 || isWarmup ? null : ex.rest_seconds + TRANSITION_BUFFER_SECONDS,
    };
  });
}
```

In `annotateSession`, run the post-pass on both the main array and the reorder proposal. Reordering changes neighbours, so the proposal needs its own pass — otherwise a suggested order ships stale transitions. Change these two lines:

```ts
  const annotated = applyRestPasses(exercises.map(annotateOne));
```

and, inside the `if (warnings.length > 0)` block:

```ts
      suggested = applyRestPasses(proposal.map(annotateOne));
```

- [ ] **Step 4: Create the shared display helper**

Create `lib/ui/rest-format.ts`:

```ts
/** Format a rest prescription for display. Whole minutes render as minutes;
 *  anything else stays in seconds. Replaces the two duplicate fmtRestRange
 *  copies that lived in BriefSessionList and TodayPlanCard. */
export function fmtRest(seconds: number): string {
  if (seconds >= 60 && seconds % 60 === 0) {
    return `${seconds / 60} min`;
  }
  return `${seconds}s`;
}
```

- [ ] **Step 5: Update the four consumers**

In [BriefSessionList.tsx](../../../components/morning/BriefSessionList.tsx): delete the local `fmtRestRange` function (lines 16-21) and add `import { fmtRest } from "@/lib/ui/rest-format";` to the import block. Replace both call sites — `fmtRestRange(ann.rest_seconds)` becomes `fmtRest(ann.rest_seconds)` on the `aria-label` line and the rendered line.

In [TodayPlanCard.tsx](../../../components/strength/TodayPlanCard.tsx): delete the local `fmtRestRange` (lines 14-19), add the same import, and replace the single call site the same way.

In [SessionStructureBanner.tsx](../../../components/strength/SessionStructureBanner.tsx), extend `stripAnnotations` so the new field cannot leak into the persisted `exercise_overrides` payload:

```ts
function stripAnnotations(e: SessionStructure["exercises"][number]) {
  const {
    fatigue_tier: _t,
    rest_seconds: _r,
    transition_seconds: _ts,
    rpe_target: _rpe,
    cue: _c,
    ...rest
  } = e;
  return rest;
}
```

In [ExerciseCard.tsx](../../../components/logger/ExerciseCard.tsx), change the one line that reads the old shape:

```ts
  const prescribedRestMin = annotated?.rest_seconds ?? 120;
```

- [ ] **Step 6: Run tests and typecheck**

Run: `npm run typecheck && npx vitest run`
Expected: typecheck clean. All tests pass — including the existing `evaluate-set.test.ts`, which still calls the untouched `restPrescription`.

- [ ] **Step 7: Commit**

```bash
git add lib/coach/session-structure/annotate.ts lib/ui/rest-format.ts \
  components/morning/BriefSessionList.tsx components/strength/TodayPlanCard.tsx \
  components/strength/SessionStructureBanner.tsx components/logger/ExerciseCard.tsx \
  lib/coach/session-structure/__tests__/rest.test.ts
git commit -m "feat(rest): single-value annotation with transitions and warm-up bump"
```

---

### Task 3: Retire the old range API

Migrates the last consumer and deletes the dead function, so no caller can reach the old table.

**Files:**
- Modify: `lib/coach/live-session/rule-rest-discipline.ts`
- Modify: `lib/coach/live-session/__tests__/evaluate-set.test.ts`
- Modify: `lib/coach/session-structure/rules.ts`, `lib/coach/session-structure/index.ts`

**Interfaces:**
- Consumes: `restSecondsFor` from Task 1.
- Produces: nothing new. `restPrescription` ceases to exist.

**Threshold impact — read before editing the fixtures.** `ruleRestDiscipline` flags a set when the commit-to-commit delta falls below `UNDER_REST_RATIO` (0.6) × the prescription. The prescription rises, so the threshold rises with it:

| Tier | Old threshold | New threshold |
|---|---|---|
| 1 heavy compound | 108 s (0.6 × 180) | 144 s (0.6 × 240) |
| 2 secondary compound | 72 s (0.6 × 120) | 108 s (0.6 × 180) |

`UNDER_REST_RATIO` stays at 0.6 — the old thresholds were only low because the underlying values were range floors nobody honoured. Every existing fixture was checked against the new numbers and still asserts correctly: the "fires" cases use 50-55 s gaps (both still under 144 s) and the "stays silent" case uses a 210 s gap (still over 144 s). **Only the stale comment changes.** Do not retune the fixture timings.

- [ ] **Step 1: Update the stale comment in the test**

In [evaluate-set.test.ts](../../../lib/coach/live-session/__tests__/evaluate-set.test.ts), line 59 pins the old arithmetic verbatim. Replace:

```ts
    // Squat at 5 reps -> restPrescription(tier 1, 5) = { min: 180 }. 60% = 108s.
```

with:

```ts
    // Squat -> restSecondsFor(tier 1) = 240. 60% = 144s, so a 55s gap fires.
```

- [ ] **Step 2: Run the test to confirm it still passes**

Run: `npx vitest run lib/coach/live-session/__tests__/evaluate-set.test.ts`
Expected: PASS. The rule still calls `restPrescription`, so nothing has moved yet — this step only proves the fixtures are sound before the migration.

- [ ] **Step 3: Migrate the rule**

In [rule-rest-discipline.ts](../../../lib/coach/live-session/rule-rest-discipline.ts), change the import. `repsForExercise` becomes unused and must be dropped from the import — the codebase has no linter to catch a dangling import:

```ts
import { restSecondsFor } from "@/lib/coach/session-structure/rules";
```

Replace the threshold computation. Delete the `const reps = repsForExercise(exercise.prescribed);` line and compute the prescription once instead of twice:

```ts
  const prescribed = restSecondsFor(exercise.prescribed, tier);
  const threshold = prescribed * UNDER_REST_RATIO;

  const actual = restBefore(exercise, set);
  if (actual == null) return null;
  if (actual >= threshold) return null;
```

Further down, the second call site built the label from a duplicate lookup. Replace `const prescribedMin = restPrescription(tier, reps).min;` and the label expression with:

```ts
  const label = prescribed % 60 === 0
    ? `${prescribed / 60}-minute`
    : `${prescribed}s`;
```

Leave the `alreadyFlagged` block untouched — it closes over `threshold`, which is still in scope.

- [ ] **Step 4: Delete the dead function**

In [rules.ts](../../../lib/coach/session-structure/rules.ts), delete the entire `restPrescription` function together with its doc comment block. Then delete the now-unused `parseReps` helper **only if** `repsForExercise` no longer needs it — `repsForExercise` calls `parseReps`, and `repsForExercise` is still exported and used elsewhere, so **keep both**.

In [index.ts](../../../lib/coach/session-structure/index.ts), replace `restPrescription` in the re-export list with the new names:

```ts
export {
  findOrderingWarnings,
  restSecondsFor,
  isolationSize,
  rpePrescription,
  repsForExercise,
  REST_SECONDS,
  TRANSITION_BUFFER_SECONDS,
  type OrderingWarning,
} from "./rules";
```

- [ ] **Step 5: Verify no reference survives**

Run: `grep -rn "restPrescription" lib components app scripts --include="*.ts" --include="*.tsx" --include="*.mjs"`
Expected: no output.

Run: `npm run typecheck && npx vitest run`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add lib/coach/live-session/rule-rest-discipline.ts \
  lib/coach/live-session/__tests__/evaluate-set.test.ts \
  lib/coach/session-structure/rules.ts lib/coach/session-structure/index.ts
git commit -m "refactor(rest): retire the range-based restPrescription"
```

---

### Task 4: Durable exercise-scoped rest override

The override already applies to every subsequent set of its exercise — `effectiveRest` feeds every `commitSet`. This task fixes the three ways it gets lost: it is component state rather than draft data, so it dies on resume and on reorder, and the running bar reads a snapshot taken at commit time.

**Files:**
- Modify: `lib/logger/types.ts`
- Modify: `components/logger/ExerciseCard.tsx`
- Modify: `components/logger/RestTimeDialog.tsx`

**Interfaces:**
- Consumes: `AnnotatedExercise.rest_seconds` from Task 2.
- Produces: `ExerciseDraft.rest_override_seconds?: number | null`.

- [ ] **Step 1: Add the draft field**

In [types.ts](../../../lib/logger/types.ts), add to `ExerciseDraft` after `prescribed`:

```ts
  /** Athlete's manual rest override for this exercise, in seconds. Applies to
   *  every set of the exercise for the rest of the session, including a rest
   *  already counting down. Null/undefined = use the tier prescription.
   *
   *  Lives on the draft rather than in component state so it survives both a
   *  sheet close/resume (the draft is mirrored to IndexedDB) and an exercise
   *  reorder (cards are keyed by index, so they remount and lose state).
   *
   *  Draft-only: not sent to commit_logger_session and not persisted past the
   *  session. A permanent per-exercise rest default is a separate arc. */
  rest_override_seconds?: number | null;
```

- [ ] **Step 2: Read the override from the draft**

In [ExerciseCard.tsx](../../../components/logger/ExerciseCard.tsx), delete both pieces of rest state — `restOverrideSeconds` and `activeRestSeconds` — and derive the effective value from the draft instead. Replace:

```ts
  const prescribedRestMin = annotated?.rest_seconds ?? 120;
  const [restOverrideSeconds, setRestOverrideSeconds] = useState<number | null>(null);
  const effectiveRest = restOverrideSeconds ?? prescribedRestMin;
  const [activeRestStartedAt, setActiveRestStartedAt] = useState<number | null>(null);
  const [activeRestSeconds, setActiveRestSeconds] = useState<number>(effectiveRest);
```

with:

```ts
  const prescribedRest = annotated?.rest_seconds ?? 120;
  const effectiveRest = exercise.rest_override_seconds ?? prescribedRest;
  const [activeRestStartedAt, setActiveRestStartedAt] = useState<number | null>(null);
```

`useState` may now be unused in this file — check the remaining `useState` calls before removing it from the React import. Several other pieces of state (`restAfterSetIndex`, `menuOpen`, `restDialogOpen`, `unparsedBanner`, `coachLine`) remain, so the import stays.

- [ ] **Step 3: Drop the snapshot from `commitSet`**

In the same file, delete this line from `commitSet`:

```ts
    setActiveRestSeconds(effectiveRest);
```

`effectiveRest` stays in the `useCallback` dependency array — it is still read by the coaching branch below and by the draft write.

- [ ] **Step 4: Feed the bar a live duration**

Change the `RestBar` usage so the running countdown tracks the current value rather than a snapshot:

```tsx
                  <RestBar
                    duration_seconds={effectiveRest}
                    started_at={activeRestStartedAt}
                    onDone={() => { /* visual cue only — bar stays until next set commit */ }}
                    onSkip={() => { setActiveRestStartedAt(null); setRestAfterSetIndex(null); }}
                  />
```

`useRestCountdown` recomputes `remaining_seconds = duration_seconds - elapsed_seconds` on every render, so shortening rest mid-countdown collapses the bar and fires the done cue, and lengthening it extends the bar. `doneFiredRef` resets only when `started_at` changes, so lengthening rest after the cue has already fired shows a running bar again without re-firing the audio — the intended trade, since a second cue for a deliberately extended rest is noise.

- [ ] **Step 5: Write the override through to the draft**

Change the dialog's confirm handler so it mutates the draft instead of local state:

```tsx
        <RestTimeDialog
          initialSeconds={effectiveRest}
          exerciseName={exercise.name}
          onConfirm={(seconds) => {
            onExerciseChange(exerciseIndex, { ...exercise, rest_override_seconds: seconds });
            setRestDialogOpen(false);
          }}
          onCancel={() => setRestDialogOpen(false)}
        />
```

`onExerciseChange` is the existing `LoggerSheet` draft-persist path, so this alone fixes both the resume loss and the reorder loss.

- [ ] **Step 6: Re-align the dialog presets**

In [RestTimeDialog.tsx](../../../components/logger/RestTimeDialog.tsx), the preset row predates the new table — it lacks 45 s and offers 150 s, which no bucket now uses. Replace:

```ts
const PRESETS = [30, 60, 90, 120, 150, 180, 240, 300];
```

with:

```ts
// Mirrors the buckets in REST_SECONDS plus the two nearest half-steps, so
// every prescribed value is reachable in one tap.
const PRESETS = [45, 60, 90, 120, 180, 240, 300, 360];
```

- [ ] **Step 7: Typecheck, test, and build**

Run: `npm run typecheck && npx vitest run && npm run build`
Expected: all three clean. The build is not optional here — this task removed two `useState` calls, and vitest cannot catch a hooks-order error.

- [ ] **Step 8: Verify by hand in the logger**

Start a session from `/metrics?sub=strength` → "Start session" and confirm all five:

1. Set a rest override on the second exercise, commit a set — the bar uses the override.
2. Close the sheet and reopen it — the override is still there.
3. Reorder the exercises — the override is still attached to its exercise.
4. Edit rest while a bar is counting down — the bar re-scales immediately.
5. Replace the exercise — the override clears back to the prescription.

- [ ] **Step 9: Commit**

```bash
git add lib/logger/types.ts components/logger/ExerciseCard.tsx components/logger/RestTimeDialog.tsx
git commit -m "fix(logger): rest override survives resume, reorder, and a running timer"
```

---

### Task 5: Between-exercise transition rest in the logger

Surfaces `transition_seconds` where it is actionable. Logger only — the brief and the strength card keep one rest chip per exercise, because a second number per row is clutter on cards that get a five-second scan.

**Files:**
- Modify: `components/logger/RestBar.tsx`
- Modify: `components/logger/ExerciseCard.tsx`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: `AnnotatedExercise.transition_seconds` from Task 2.
- Produces: nothing downstream.

- [ ] **Step 1: Give `RestBar` an optional label**

In [RestBar.tsx](../../../components/logger/RestBar.tsx), add the prop and render it. Default behaviour is unchanged when the prop is omitted:

```tsx
type Props = {
  duration_seconds: number;
  started_at: number | null;
  /** Optional context for this rest, e.g. "Next: Seated Cable Row". Shown in
   *  place of the prescribed-duration figure when present. */
  label?: string;
  onDone: () => void;
  onSkip: () => void;
};
```

Destructure `label` alongside the others, then replace the left-hand span:

```tsx
      <span className="font-medium font-mono">{label ?? prescribedLabel}</span>
```

- [ ] **Step 2: Resolve the next exercise's transition in `ExerciseCard`**

In [ExerciseCard.tsx](../../../components/logger/ExerciseCard.tsx), the existing `annotated` memo already annotates the whole session. Add a second memo beside it that looks one exercise ahead:

```ts
  // The exercise that follows this card, if any — used to run a longer
  // transition rest after this exercise's final set. Rest before an exercise
  // is set by the demand of what is COMING, so this reads the NEXT card's
  // prescription, not this one's.
  const nextTransition = useMemo(() => {
    const list = allExercises.map((e) => e.prescribed);
    const s = annotateSession(list);
    const next = s.exercises[exerciseIndex + 1];
    return next ? { seconds: next.transition_seconds, name: next.name } : null;
  }, [allExercises, exerciseIndex]);
```

- [ ] **Step 3: Fire the transition bar after the exercise's last set**

Still in `ExerciseCard`, the rest bar currently always runs `effectiveRest`. Compute which rest applies to the set that was just committed. Add this above the `return`:

```ts
  // After the LAST set of an exercise, the relevant rest is the transition
  // into the next exercise, not another inter-set rest. A manual override
  // governs rest BETWEEN this exercise's sets and deliberately does not
  // reach the transition, which belongs to the next exercise's prescription.
  const isRestAfterFinalSet =
    restAfterSetIndex !== null && restAfterSetIndex === exercise.sets.length - 1;
  const transitionSeconds = nextTransition?.seconds ?? null;
  const useTransition = isRestAfterFinalSet && transitionSeconds !== null;
  const barSeconds = useTransition ? transitionSeconds : effectiveRest;
  const barLabel = useTransition ? `Next: ${nextTransition!.name}` : undefined;
```

Then change the `RestBar` usage from Task 4 to consume them:

```tsx
                  <RestBar
                    duration_seconds={barSeconds}
                    started_at={activeRestStartedAt}
                    label={barLabel}
                    onDone={() => { /* visual cue only — bar stays until next set commit */ }}
                    onSkip={() => { setActiveRestStartedAt(null); setRestAfterSetIndex(null); }}
                  />
```

Note the interaction with "+ Add set": adding a set after the final one makes `isRestAfterFinalSet` false on the next render, so the bar reverts to inter-set rest. That is correct — the exercise is no longer finished.

- [ ] **Step 4: Typecheck, test, and build**

Run: `npm run typecheck && npx vitest run && npm run build`
Expected: all three clean.

- [ ] **Step 5: Verify by hand**

In a live session, commit the final set of an exercise that is not the last in the plan. The bar should show `Next: <name>` and run the next exercise's transition (e.g. 300 s into a heavy compound, 120 s into a small isolation) rather than the exercise you just finished. Commit the final set of the last exercise in the session — no transition bar should appear.

- [ ] **Step 6: Document the change in `CLAUDE.md`**

In the **Session-structure coaching** bullet under Coach / AI, the description of `annotateSession` is now wrong — it says the engine annotates "rest seconds" without describing the shape, and says nothing about transitions. Replace the first sentence of that bullet:

```markdown
- **Session-structure coaching** ([lib/coach/session-structure/](lib/coach/session-structure/)) — deterministic rule engine annotating today's prescribed session with per-exercise fatigue tier (0 warmup → 4 finisher), a single rest value in seconds (240 heavy compound / 180 secondary / 120 large-muscle isolation / 60 small-muscle isolation / 45 warmup + finisher, with the last warmup before the first working exercise bumped to 120), a `transition_seconds` for the rest to take BEFORE each exercise (that exercise's own rest + 60 s setup buffer; null on the first exercise and on warmups), RPE/RIR target, and a cue when ordering rules fire.
```

Then append to the same bullet, before the spec link:

```markdown
Rest values are single numbers, not ranges — the old `{min, max}` shape was resolved to `.min` by the logger on every session, so the ceiling was never real. The tier-3 large/small split reads `getExerciseMuscles().primary` against a large-muscle set (Chest, Lats, Quads, Hams, Glutes, Traps); unmapped names resolve to small (shortest timer, one tap to lengthen). The athlete's manual override in the logger lives on `ExerciseDraft.rest_override_seconds`, applies to every set of that exercise including a rest already counting down, and dies with the draft — it is deliberately not persisted as a per-exercise default, so it cannot shadow the engine's values. Spec: [docs/superpowers/specs/2026-08-10-session-rest-prescription-design.md](docs/superpowers/specs/2026-08-10-session-rest-prescription-design.md).
```

- [ ] **Step 7: Commit**

```bash
git add components/logger/RestBar.tsx components/logger/ExerciseCard.tsx CLAUDE.md
git commit -m "feat(logger): rest between exercises sized by the incoming lift"
```

---

## Verification

Full-suite gate before opening a PR:

```bash
npm run typecheck && npx vitest run && npm run build
grep -rn "restPrescription" lib components app scripts --include="*.ts" --include="*.tsx" --include="*.mjs"
```

The grep must return nothing. The build must be run — vitest is node-environment only and does not scan components, so a hooks-order regression in `ExerciseCard` (Tasks 4 and 5 both touch its hooks) surfaces nowhere else.
