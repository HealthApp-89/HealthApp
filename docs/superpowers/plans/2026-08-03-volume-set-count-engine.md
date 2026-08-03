# Volume Set-Count Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the open feedback loop in the accessory set-count rule so the engine prescribes volume the athlete actually performs, stops adding sets to muscles trained past failure, and converts a repeatedly-ignored bump into a frequency recommendation.

**Architecture:** Three changes to `lib/coach/prescription/`. (1) `discoverEffectiveExercises` derives `sets` from realized workout data instead of copying the static library value. (2) A new order-independent `recentEffortQuality` helper gates the `below_mev`/`at_mev` `+1` bump when a muscle is being trained past failure. (3) A new `setAdherenceFor` helper detects bumps that were prescribed but not performed; after two ignored exposures the engine holds sets and emits a `VolumeFrequencySignal` persisted to a new `training_weeks.volume_signals` column and surfaced in Carter's prompt.

**Tech Stack:** TypeScript (strict), Next.js 15 App Router, Supabase (Postgres + RLS), vitest (node env), Anthropic SDK.

## Global Constraints

- Path alias `@/*` → repo root. Use it; never relative climbs.
- Verification is `npm run typecheck` + `npx vitest run`. `npm run lint` is a no-op (unconfigured `next lint` that hangs) — do not run it.
- Unit tests live under `lib/**/__tests__/**/*.test.ts` — that glob is the only thing vitest scans. Tests placed anywhere else will silently not run.
- Migration slot **0054** is the next free one. Version prefixes must be unique AND uniform-width (4 digits).
- DB is snake_case; row shapes are mirrored in [lib/data/types.ts](../../../lib/data/types.ts). Keep columns and TS types in sync.
- This plan touches the **accessory volume-band path only**. Do not modify primary-lift (`prescribePrimaryFromPhase`) or secondary (`prescribeSecondaryAutoregulated`) set counts.
- Do NOT change `lastWeekClean` or `consecutiveMisses`. Their first-set-of-session semantics are a known, deliberately out-of-scope finding (see spec Follow-ups). The new gates are order-independent by design.
- Spec: [docs/superpowers/specs/2026-08-03-volume-set-count-engine-design.md](../specs/2026-08-03-volume-set-count-engine-design.md)

---

### Task 1: Discovery derives realized set counts

Currently `discoverEffectiveExercises` derives `baseKg` (realized max) and `baseReps` (realized median) but copies `sets` from `SESSION_PLANS`. It also `continue`s on the second row of a repeated exercise name, discarding it — and warmup ramp entries are stored as separate rows sharing the working entry's name, so for lifts like Squat only the first (warmup) row is read.

**Files:**
- Modify: `lib/coach/prescription/recent-workouts-discovery.ts`
- Test: `lib/coach/prescription/__tests__/recent-workouts-discovery.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `discoverEffectiveExercises` returns `PlannedExercise[]` whose `sets` is `Math.round(median(perSessionWorkingSetCounts))`, falling back to the library value (or `3` for off-script exercises) when no non-warmup sets were observed.

- [ ] **Step 1: Write the failing tests**

Append to `lib/coach/prescription/__tests__/recent-workouts-discovery.test.ts`. The existing `makeWorkout` helper builds one set per exercise; these tests need control over set counts and warmup flags, so add a second local helper.

```ts
/** Builds a workout where each exercise carries an explicit list of sets. */
function makeWorkoutWithSets(
  id: string,
  date: string,
  exercises: { name: string; sets: { kg: number; reps: number; warmup?: boolean }[] }[],
) {
  return {
    id,
    type: "Legs",
    date,
    exercises: exercises.map((ex, i) => ({
      name: ex.name,
      position: i,
      exercise_sets: ex.sets.map((s, j) => ({
        kg: s.kg,
        reps: s.reps,
        warmup: s.warmup ?? false,
        set_index: j,
        duration_seconds: null,
        failure: false,
      })),
    })),
  };
}

const THREE_SETS = [
  { kg: 40, reps: 12 },
  { kg: 40, reps: 12 },
  { kg: 40, reps: 12 },
];

describe("discoverEffectiveExercises — realized set counts", () => {
  it("derives sets from the median realized working-set count, not the library default", async () => {
    // Lat Pulldown's SESSION_PLANS.Back default is 4 sets; athlete does 3.
    const workouts = ["2026-07-01", "2026-07-08", "2026-07-15", "2026-07-22"].map((d, i) =>
      ({ ...makeWorkoutWithSets(`w${i}`, d, [{ name: "Lat Pulldown (Cable)", sets: THREE_SETS }]), type: "Back" }),
    );
    const out = await discoverEffectiveExercises({
      supabase: fakeSupabase(workouts),
      userId: "u",
      sessionType: "Back",
    });
    const pulldown = out?.find((e) => e.name === "Lat Pulldown (Cable)");
    expect(pulldown?.sets).toBe(3);
  });

  it("aggregates every row sharing a name within a session (warmup-split rows)", async () => {
    // Squat is stored as three rows: two warmup ramp rows + the working row.
    // Only the 3 non-warmup sets count, and baseKg must come from them.
    const workouts = ["2026-07-01", "2026-07-08", "2026-07-15", "2026-07-22"].map((d, i) =>
      makeWorkoutWithSets(`w${i}`, d, [
        { name: "Squat (Barbell)", sets: [{ kg: 47.5, reps: 5, warmup: true }] },
        { name: "Squat (Barbell)", sets: [{ kg: 62.5, reps: 3, warmup: true }] },
        { name: "Squat (Barbell)", sets: [{ kg: 80, reps: 10 }, { kg: 80, reps: 10 }, { kg: 80, reps: 10 }] },
      ]),
    );
    const out = await discoverEffectiveExercises({
      supabase: fakeSupabase(workouts),
      userId: "u",
      sessionType: "Legs",
    });
    const squat = out?.find((e) => e.name === "Squat (Barbell)");
    expect(squat?.sets).toBe(3);
    expect(squat?.baseKg).toBe(80);
  });

  it("falls back to the library set count when only warmup sets were logged", async () => {
    const workouts = ["2026-07-01", "2026-07-08", "2026-07-15", "2026-07-22"].map((d, i) =>
      makeWorkoutWithSets(`w${i}`, d, [
        { name: "Leg Extension (Machine)", sets: [{ kg: 30, reps: 10, warmup: true }] },
      ]),
    );
    const out = await discoverEffectiveExercises({
      supabase: fakeSupabase(workouts),
      userId: "u",
      sessionType: "Legs",
    });
    const legExt = out?.find((e) => e.name === "Leg Extension (Machine)");
    // SESSION_PLANS.Legs lists Leg Extension (Machine) at 3 sets.
    expect(legExt?.sets).toBe(3);
  });

  it("uses realized counts for off-script exercises instead of the hardcoded 3", async () => {
    const fourSets = [...THREE_SETS, { kg: 40, reps: 12 }];
    const workouts = ["2026-07-01", "2026-07-08", "2026-07-15", "2026-07-22"].map((d, i) =>
      makeWorkoutWithSets(`w${i}`, d, [{ name: "Leg Press Single Leg", sets: fourSets }]),
    );
    const out = await discoverEffectiveExercises({
      supabase: fakeSupabase(workouts),
      userId: "u",
      sessionType: "Legs",
    });
    const lp = out?.find((e) => e.name === "Leg Press Single Leg");
    expect(lp?.sets).toBe(4);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/coach/prescription/__tests__/recent-workouts-discovery.test.ts`
Expected: the four new tests FAIL. The first reports `expected 4 to be 3` (library default leaking through); the warmup-split test reports `expected undefined to be 80` or a `sets` mismatch, because only the first (warmup) row is read today.

- [ ] **Step 3: Extend the presence exemplar type**

In `lib/coach/prescription/recent-workouts-discovery.ts`, change the `PresenceEntry` type inside `discoverEffectiveExercises`:

```ts
  type PresenceEntry = {
    count: number;
    exemplar: { name: string; kgs: number[]; reps: number[]; setsPerSession: number[] };
  };
```

- [ ] **Step 4: Rewrite the per-session accumulation loop**

Replace the existing `for (const w of workouts) { ... }` tally loop with:

```ts
  for (const w of workouts) {
    // Per-session working-set tally. Presence counts ONCE per session per
    // name, but sets accumulate from EVERY row bearing that name: warmup ramp
    // entries are stored as separate `exercises` rows sharing the working
    // entry's name (see augmentFirstLoadedCompoundWithWarmups), so the old
    // "skip the second row" guard discarded the working sets of any lift with
    // a warmup ramp.
    const sessionSetCounts = new Map<string, number>();
    for (const ex of w.exercises ?? []) {
      const k = ex.name.toLowerCase();
      const entry: PresenceEntry =
        presence.get(k) ?? { count: 0, exemplar: { name: ex.name, kgs: [], reps: [], setsPerSession: [] } };
      if (!sessionSetCounts.has(k)) {
        entry.count += 1;
        sessionSetCounts.set(k, 0);
      }
      for (const s of ex.exercise_sets ?? []) {
        // Exclude warmup sets so the discovered exemplar tracks working-set
        // loads and working-set COUNTS, not warmup ramping.
        if (s.warmup) continue;
        if (typeof s.kg === "number") entry.exemplar.kgs.push(s.kg);
        if (typeof s.reps === "number") entry.exemplar.reps.push(s.reps);
        sessionSetCounts.set(k, (sessionSetCounts.get(k) ?? 0) + 1);
      }
      presence.set(k, entry);
    }
    // An appearance contributing zero non-warmup sets is not evidence of
    // working volume — don't let it drag the median down.
    for (const [k, n] of sessionSetCounts) {
      if (n > 0) presence.get(k)!.exemplar.setsPerSession.push(n);
    }
  }
```

- [ ] **Step 5: Resolve `sets` from realized data in both survivor passes**

In the first pass (library exercises), change the pushed object to:

```ts
    survivors.push({
      ...libEx,
      baseKg: found.exemplar.kgs.length > 0 ? Math.max(...found.exemplar.kgs) : libEx.baseKg,
      baseReps: found.exemplar.reps.length > 0 ? Math.round(median(found.exemplar.reps)) : libEx.baseReps,
      // Realized working-set count. Median (not max) for consistency with
      // baseReps and robustness to a single outlier session.
      sets: found.exemplar.setsPerSession.length > 0
        ? Math.round(median(found.exemplar.setsPerSession))
        : (libEx.sets ?? 3),
    });
```

In the second pass (off-script exercises), change `sets: 3` to:

```ts
      sets: entry.exemplar.setsPerSession.length > 0
        ? Math.round(median(entry.exemplar.setsPerSession))
        : 3,
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run lib/coach/prescription/__tests__/recent-workouts-discovery.test.ts`
Expected: PASS, including the pre-existing ordering regression test.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add lib/coach/prescription/recent-workouts-discovery.ts lib/coach/prescription/__tests__/recent-workouts-discovery.test.ts
git commit -m "feat(prescription): derive realized set counts in discovery

Discovery derived baseKg and baseReps from realized data but copied sets
from SESSION_PLANS, so volume-balance always added +1 to a static value
regardless of what was performed. Also aggregates every row sharing an
exercise name within a session, fixing warmup-split rows being discarded."
```

---

### Task 2: `recentEffortQuality` pure module

An order-independent measure of how hard an exercise's recent sets were. Deliberately a proportion over a window: `fetchRecentSets` places no explicit order on the embedded `exercise_sets` and PostgREST returns them `set_index` ascending, so any "most recent set" logic is unreliable (spec: Ordering finding).

**Files:**
- Create: `lib/coach/prescription/effort-quality.ts`
- Test: `lib/coach/prescription/__tests__/effort-quality.test.ts`

**Interfaces:**
- Consumes: `WorkoutSetSample` from `@/lib/coach/prescription/types`.
- Produces: `recentEffortQuality(exerciseName: string, recentSets: WorkoutSetSample[], todayIso: string): EffortQuality` where `EffortQuality = { totalSets: number; hardSets: number; hardRate: number }`.

- [ ] **Step 1: Write the failing test**

Create `lib/coach/prescription/__tests__/effort-quality.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { recentEffortQuality } from "@/lib/coach/prescription/effort-quality";
import type { WorkoutSetSample } from "@/lib/coach/prescription/types";

function s(overrides: Partial<WorkoutSetSample>): WorkoutSetSample {
  return {
    exercise_name: "Lat Pulldown (Cable)",
    exercise_key: null,
    kg: 50,
    reps: 12,
    warmup: false,
    failure: false,
    performed_on: "2026-08-01",
    rir: 2,
    ...overrides,
  };
}

describe("recentEffortQuality", () => {
  it("returns a zero rate for an empty sample", () => {
    expect(recentEffortQuality("Lat Pulldown (Cable)", [], "2026-08-03")).toEqual({
      totalSets: 0,
      hardSets: 0,
      hardRate: 0,
    });
  });

  it("counts a set as hard when failure is true", () => {
    const sets = [s({}), s({}), s({ failure: true })];
    const q = recentEffortQuality("Lat Pulldown (Cable)", sets, "2026-08-03");
    expect(q).toEqual({ totalSets: 3, hardSets: 1, hardRate: 1 / 3 });
  });

  it("counts a set as hard when rir is exactly 0", () => {
    const sets = [s({}), s({ rir: 0 })];
    const q = recentEffortQuality("Lat Pulldown (Cable)", sets, "2026-08-03");
    expect(q.hardSets).toBe(1);
    expect(q.hardRate).toBe(0.5);
  });

  it("does not count a null rir as hard", () => {
    const sets = [s({ rir: null }), s({ rir: null })];
    expect(recentEffortQuality("Lat Pulldown (Cable)", sets, "2026-08-03").hardSets).toBe(0);
  });

  it("excludes warmup sets from both numerator and denominator", () => {
    const sets = [s({ warmup: true, failure: true }), s({}), s({ failure: true })];
    const q = recentEffortQuality("Lat Pulldown (Cable)", sets, "2026-08-03");
    expect(q.totalSets).toBe(2);
    expect(q.hardSets).toBe(1);
  });

  it("excludes sets outside the 28-day window", () => {
    // 2026-08-03 minus 28 days = 2026-07-06. 07-05 is out, 07-06 is in.
    const sets = [
      s({ performed_on: "2026-07-05", failure: true }),
      s({ performed_on: "2026-07-06" }),
    ];
    const q = recentEffortQuality("Lat Pulldown (Cable)", sets, "2026-08-03");
    expect(q.totalSets).toBe(1);
    expect(q.hardSets).toBe(0);
  });

  it("matches the exercise name case-insensitively and ignores other exercises", () => {
    const sets = [s({ exercise_name: "LAT PULLDOWN (CABLE)" }), s({ exercise_name: "Seated Row (Machine)", failure: true })];
    const q = recentEffortQuality("Lat Pulldown (Cable)", sets, "2026-08-03");
    expect(q.totalSets).toBe(1);
    expect(q.hardSets).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/coach/prescription/__tests__/effort-quality.test.ts`
Expected: FAIL — cannot resolve module `@/lib/coach/prescription/effort-quality`.

- [ ] **Step 3: Write the implementation**

Create `lib/coach/prescription/effort-quality.ts`:

```ts
// lib/coach/prescription/effort-quality.ts
//
// How hard were this exercise's recent working sets? Used to gate the
// volume-band set bump: MEV/MAV/MRV landmarks assume sets taken at roughly
// 0-4 RIR WITHOUT systematic failure, so "below MEV" on a muscle being
// trained past failure is a signal to fix effort, not to add a set.
//
// Deliberately ORDER-INDEPENDENT — a proportion over a window, not a walk
// from the most recent set. fetchRecentSets places no explicit order on the
// embedded exercise_sets and PostgREST returns them set_index ASCENDING, so
// "the most recent set" is not reliably addressable from that payload. See
// docs/superpowers/specs/2026-08-03-volume-set-count-engine-design.md.

import type { WorkoutSetSample } from "@/lib/coach/prescription/types";

const LOOKBACK_DAYS = 28; // matches maintenance-baseline.ts

export type EffortQuality = {
  totalSets: number;
  hardSets: number;
  /** hardSets / totalSets; 0 when no sets were observed. */
  hardRate: number;
};

/** A set is "hard" when it was taken to failure or logged at RIR 0. A null
 *  rir means "not recorded" and never counts as hard (legacy rows). */
function isHard(s: WorkoutSetSample): boolean {
  return s.failure || s.rir === 0;
}

export function recentEffortQuality(
  exerciseName: string,
  recentSets: WorkoutSetSample[],
  todayIso: string,
): EffortQuality {
  const cutoff = subtractDaysIso(todayIso, LOOKBACK_DAYS);
  const target = exerciseName.toLowerCase();
  const matching = recentSets.filter(
    (s) =>
      !s.warmup &&
      s.performed_on >= cutoff &&
      s.exercise_name.toLowerCase() === target,
  );
  const totalSets = matching.length;
  const hardSets = matching.filter(isHard).length;
  return { totalSets, hardSets, hardRate: totalSets === 0 ? 0 : hardSets / totalSets };
}

function subtractDaysIso(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/coach/prescription/__tests__/effort-quality.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/coach/prescription/effort-quality.ts lib/coach/prescription/__tests__/effort-quality.test.ts
git commit -m "feat(prescription): add order-independent recentEffortQuality helper"
```

---

### Task 3: Wire the effort gate into the volume band rule

**Files:**
- Modify: `lib/coach/prescription/volume-balance-rule.ts`
- Modify: `lib/coach/prescription/prescribe-week.ts:326-334` (the accessory branch call site)
- Test: `lib/coach/prescription/__tests__/volume-balance-rule.test.ts` (create)

**Interfaces:**
- Consumes: `recentEffortQuality` / `EffortQuality` from Task 2.
- Produces: `VolumeBalanceInput` gains optional `hardRate?: number` and `effortSampleSets?: number`. New exports `HARD_RATE_SUPPRESS_THRESHOLD`, `MIN_SETS_FOR_EFFORT_GATE`, and `isEffortSuppressed(input: VolumeBalanceInput): boolean`.

- [ ] **Step 1: Write the failing test**

Create `lib/coach/prescription/__tests__/volume-balance-rule.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  prescribeAccessoryFromVolumeBand,
  isEffortSuppressed,
  HARD_RATE_SUPPRESS_THRESHOLD,
  MIN_SETS_FOR_EFFORT_GATE,
} from "@/lib/coach/prescription/volume-balance-rule";
import type { PlannedExercise } from "@/lib/coach/sessionPlans";

const ex: PlannedExercise = { name: "Lat Pulldown (Cable)", baseKg: 50, baseReps: 12, sets: 3 };

describe("effort gate on the volume bump", () => {
  it("adds a set below MEV when effort is clean", () => {
    const out = prescribeAccessoryFromVolumeBand({
      baseExercise: ex, currentSets: 3, bandPosition: "below_mev",
      hardRate: 0, effortSampleSets: 6,
    });
    expect(out.sets).toBe(4);
  });

  it("holds below MEV when more than a third of recent sets were hard", () => {
    const out = prescribeAccessoryFromVolumeBand({
      baseExercise: ex, currentSets: 3, bandPosition: "below_mev",
      hardRate: 0.5, effortSampleSets: 6,
    });
    expect(out.sets).toBe(3);
  });

  it("still adds a set at exactly one third (one hard finishing set is acceptable)", () => {
    const out = prescribeAccessoryFromVolumeBand({
      baseExercise: ex, currentSets: 3, bandPosition: "below_mev",
      hardRate: HARD_RATE_SUPPRESS_THRESHOLD, effortSampleSets: 3,
    });
    expect(out.sets).toBe(4);
  });

  it("ignores the gate when the effort sample is too small", () => {
    const out = prescribeAccessoryFromVolumeBand({
      baseExercise: ex, currentSets: 3, bandPosition: "below_mev",
      hardRate: 1, effortSampleSets: MIN_SETS_FOR_EFFORT_GATE - 1,
    });
    expect(out.sets).toBe(4);
  });

  it("applies the gate to at_mev as well as below_mev", () => {
    const out = prescribeAccessoryFromVolumeBand({
      baseExercise: ex, currentSets: 3, bandPosition: "at_mev",
      hardRate: 0.9, effortSampleSets: 10,
    });
    expect(out.sets).toBe(3);
  });

  it("never suppresses the above_mrv set drop", () => {
    const out = prescribeAccessoryFromVolumeBand({
      baseExercise: ex, currentSets: 4, bandPosition: "above_mrv",
      hardRate: 0.9, effortSampleSets: 10,
    });
    expect(out.sets).toBe(3);
    expect(isEffortSuppressed({ baseExercise: ex, currentSets: 4, bandPosition: "above_mrv", hardRate: 0.9, effortSampleSets: 10 })).toBe(false);
  });

  it("behaves exactly as before when the effort fields are omitted", () => {
    expect(prescribeAccessoryFromVolumeBand({ baseExercise: ex, currentSets: 3, bandPosition: "below_mev" }).sets).toBe(4);
    expect(prescribeAccessoryFromVolumeBand({ baseExercise: ex, currentSets: 3, bandPosition: "in_band" }).sets).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/coach/prescription/__tests__/volume-balance-rule.test.ts`
Expected: FAIL — `isEffortSuppressed` / `HARD_RATE_SUPPRESS_THRESHOLD` are not exported.

- [ ] **Step 3: Implement the gate**

In `lib/coach/prescription/volume-balance-rule.ts`, extend the input type and add the gate. Replace the `VolumeBalanceInput` type and the `prescribeAccessoryFromVolumeBand` function with:

```ts
export type VolumeBalanceInput = {
  baseExercise: PlannedExercise;
  currentSets: number;
  bandPosition: VolumeBandPosition;
  /** Fraction of the exercise's recent working sets taken to failure or
   *  RIR 0 (see effort-quality.ts). Omitted → treated as 0 (no gate). */
  hardRate?: number;
  /** Size of the sample `hardRate` was computed from. Guards against a
   *  single logged set suppressing a bump. Omitted → treated as 0. */
  effortSampleSets?: number;
};

/** MEV/MAV/MRV landmarks assume sets at roughly 0-4 RIR without systematic
 *  failure. With 3-set exercises one hard finishing set is 1/3 and is
 *  accepted practice, so the gate fires strictly ABOVE one third — i.e.
 *  from two hard sets in three. */
export const HARD_RATE_SUPPRESS_THRESHOLD = 1 / 3;
export const MIN_SETS_FOR_EFFORT_GATE = 3;

/** True when a below-MEV/at-MEV bump should be withheld because the muscle
 *  is already being trained past failure. Never suppresses the above_mrv
 *  set DROP — shedding volume under high effort is always correct. */
export function isEffortSuppressed(input: VolumeBalanceInput): boolean {
  if (input.bandPosition !== "below_mev" && input.bandPosition !== "at_mev") return false;
  if ((input.effortSampleSets ?? 0) < MIN_SETS_FOR_EFFORT_GATE) return false;
  return (input.hardRate ?? 0) > HARD_RATE_SUPPRESS_THRESHOLD;
}

export function prescribeAccessoryFromVolumeBand(input: VolumeBalanceInput): PlannedExercise {
  const { baseExercise: ex, currentSets, bandPosition } = input;
  const suppressed = isEffortSuppressed(input);

  let nextSets = currentSets;
  switch (bandPosition) {
    case "below_mev":
      nextSets = suppressed ? currentSets : currentSets + 1;
      break;
    case "at_mev":
      nextSets = suppressed ? currentSets : currentSets + 1; // push toward MAV
      break;
    case "in_band":
      nextSets = currentSets; // hold
      break;
    case "near_mrv":
      nextSets = Math.max(1, currentSets); // hold; coach narrates "no more pushing"
      break;
    case "above_mrv":
      nextSets = Math.max(1, currentSets - 1); // drop a set
      break;
  }

  return {
    ...ex,
    sets: nextSets,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/coach/prescription/__tests__/volume-balance-rule.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Wire the gate at the prescribe-week call site**

In `lib/coach/prescription/prescribe-week.ts`, add the import near the other prescription-rule imports:

```ts
import { recentEffortQuality } from "@/lib/coach/prescription/effort-quality";
```

Then in the accessory `else` branch, replace the `prescribeAccessoryFromVolumeBand({...})` call with:

```ts
          const band: VolumeBandPosition = classifyVolumeBandForMuscle(baseEx, volumeContext);
          const effort = recentEffortQuality(baseEx.name, recentSets, todayIso);
          exercises.push(
            prescribeAccessoryFromVolumeBand({
              baseExercise: dp,
              currentSets: baseEx.sets ?? 3,
              bandPosition: band,
              hardRate: effort.hardRate,
              effortSampleSets: effort.totalSets,
            }),
          );
```

- [ ] **Step 6: Typecheck and run the full unit suite**

Run: `npm run typecheck && npx vitest run`
Expected: no type errors; all tests pass.

- [ ] **Step 7: Commit**

```bash
git add lib/coach/prescription/volume-balance-rule.ts lib/coach/prescription/prescribe-week.ts lib/coach/prescription/__tests__/volume-balance-rule.test.ts
git commit -m "feat(prescription): gate the below-MEV set bump on recent effort quality

Volume landmarks assume sets at 0-4 RIR without systematic failure. Adding
a set to a muscle already trained past failure is the wrong lever, so the
+1 is withheld when more than a third of recent working sets were taken to
failure or RIR 0."
```

---

### Task 4: `setAdherenceFor` pure module

Detects a bump that was prescribed but not performed. This is what converts the permanently-futile `+1` into a frequency signal.

**Files:**
- Create: `lib/coach/prescription/volume-adherence.ts`
- Test: `lib/coach/prescription/__tests__/volume-adherence.test.ts`

**Interfaces:**
- Consumes: `WorkoutSetSample` from `@/lib/coach/prescription/types`.
- Produces: `setAdherenceFor(exerciseName: string, priorPrescribedSets: number | null, recentSets: WorkoutSetSample[], todayIso: string): SetAdherence` where `SetAdherence = { prescribed: number | null; realizedMedian: number | null; ignoredExposures: number }`. Also exports `IGNORED_EXPOSURES_LIMIT`.

- [ ] **Step 1: Write the failing test**

Create `lib/coach/prescription/__tests__/volume-adherence.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { setAdherenceFor, IGNORED_EXPOSURES_LIMIT } from "@/lib/coach/prescription/volume-adherence";
import type { WorkoutSetSample } from "@/lib/coach/prescription/types";

/** n non-warmup sets of the named exercise on the given date. */
function session(date: string, n: number, name = "Leg Extension (Machine)"): WorkoutSetSample[] {
  return Array.from({ length: n }, () => ({
    exercise_name: name,
    exercise_key: null,
    kg: 40,
    reps: 12,
    warmup: false,
    failure: false,
    performed_on: date,
    rir: 2,
  }));
}

describe("setAdherenceFor", () => {
  it("reports zero ignored exposures when nothing was prescribed", () => {
    const out = setAdherenceFor("Leg Extension (Machine)", null, session("2026-08-01", 3), "2026-08-03");
    expect(out.ignoredExposures).toBe(0);
    expect(out.prescribed).toBeNull();
  });

  it("counts consecutive sessions that fell short of the prescription", () => {
    const sets = [...session("2026-08-01", 3), ...session("2026-07-25", 3), ...session("2026-07-18", 3)];
    const out = setAdherenceFor("Leg Extension (Machine)", 4, sets, "2026-08-03");
    expect(out.ignoredExposures).toBe(3);
    expect(out.realizedMedian).toBe(3);
  });

  it("stops counting at the first session that met the prescription", () => {
    // Newest-first: 3 (short), 4 (met) → stops at 1.
    const sets = [...session("2026-08-01", 3), ...session("2026-07-25", 4), ...session("2026-07-18", 3)];
    const out = setAdherenceFor("Leg Extension (Machine)", 4, sets, "2026-08-03");
    expect(out.ignoredExposures).toBe(1);
  });

  it("returns zero ignored exposures when the prescription is being met", () => {
    const sets = [...session("2026-08-01", 4), ...session("2026-07-25", 4)];
    const out = setAdherenceFor("Leg Extension (Machine)", 4, sets, "2026-08-03");
    expect(out.ignoredExposures).toBe(0);
    expect(out.realizedMedian).toBe(4);
  });

  it("returns nulls and zero when the exercise has no recent sets", () => {
    const out = setAdherenceFor("Leg Extension (Machine)", 4, [], "2026-08-03");
    expect(out.realizedMedian).toBeNull();
    expect(out.ignoredExposures).toBe(0);
  });

  it("excludes warmup sets and other exercises from the per-session count", () => {
    const sets = [
      ...session("2026-08-01", 3),
      { ...session("2026-08-01", 1)[0], warmup: true },
      ...session("2026-08-01", 2, "Seated Row (Machine)"),
    ];
    const out = setAdherenceFor("Leg Extension (Machine)", 4, sets, "2026-08-03");
    expect(out.realizedMedian).toBe(3);
    expect(out.ignoredExposures).toBe(1);
  });

  it("excludes sessions outside the 28-day window", () => {
    const sets = [...session("2026-07-05", 3)];
    const out = setAdherenceFor("Leg Extension (Machine)", 4, sets, "2026-08-03");
    expect(out.ignoredExposures).toBe(0);
    expect(out.realizedMedian).toBeNull();
  });

  it("exposes the limit the engine gates on", () => {
    expect(IGNORED_EXPOSURES_LIMIT).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/coach/prescription/__tests__/volume-adherence.test.ts`
Expected: FAIL — cannot resolve module `@/lib/coach/prescription/volume-adherence`.

- [ ] **Step 3: Write the implementation**

Create `lib/coach/prescription/volume-adherence.ts`:

```ts
// lib/coach/prescription/volume-adherence.ts
//
// Was the prescribed set count actually performed? The volume-band rule adds
// +1 set to a below-MEV muscle, but the rolling volume it measures is built
// from REALIZED sets — so a bump that is never performed leaves the muscle
// below MEV forever and the bump repeats indefinitely. This module detects
// that state so the engine can stop re-issuing a futile bump and surface the
// real (frequency) recommendation instead.

import type { WorkoutSetSample } from "@/lib/coach/prescription/types";

const LOOKBACK_DAYS = 28; // matches maintenance-baseline.ts and effort-quality.ts

/** Consecutive short exposures after which the engine stops bumping sets and
 *  emits a VolumeFrequencySignal instead. */
export const IGNORED_EXPOSURES_LIMIT = 2;

export type SetAdherence = {
  /** What last week's stored prescription asked for; null when unknown. */
  prescribed: number | null;
  /** Median realized non-warmup set count per session; null when no data. */
  realizedMedian: number | null;
  /** Consecutive recent sessions (newest first) whose realized set count fell
   *  short of `prescribed`. 0 when `prescribed` is null. */
  ignoredExposures: number;
};

export function setAdherenceFor(
  exerciseName: string,
  priorPrescribedSets: number | null,
  recentSets: WorkoutSetSample[],
  todayIso: string,
): SetAdherence {
  const cutoff = subtractDaysIso(todayIso, LOOKBACK_DAYS);
  const target = exerciseName.toLowerCase();

  // Group realized non-warmup sets into per-session counts. Grouping by date
  // (not array order) keeps this independent of PostgREST's embed ordering.
  const perSession = new Map<string, number>();
  for (const s of recentSets) {
    if (s.warmup) continue;
    if (s.performed_on < cutoff) continue;
    if (s.exercise_name.toLowerCase() !== target) continue;
    perSession.set(s.performed_on, (perSession.get(s.performed_on) ?? 0) + 1);
  }

  if (perSession.size === 0) {
    return { prescribed: priorPrescribedSets, realizedMedian: null, ignoredExposures: 0 };
  }

  const dates = [...perSession.keys()].sort((a, b) => b.localeCompare(a)); // newest first
  const counts = dates.map((d) => perSession.get(d)!);
  const realizedMedian = Math.round(median(counts));

  let ignoredExposures = 0;
  if (priorPrescribedSets != null) {
    for (const c of counts) {
      if (c >= priorPrescribedSets) break;
      ignoredExposures++;
    }
  }

  return { prescribed: priorPrescribedSets, realizedMedian, ignoredExposures };
}

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[m - 1] + sorted[m]) / 2 : sorted[m];
}

function subtractDaysIso(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/coach/prescription/__tests__/volume-adherence.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/coach/prescription/volume-adherence.ts lib/coach/prescription/__tests__/volume-adherence.test.ts
git commit -m "feat(prescription): add setAdherenceFor to detect ignored set bumps"
```

---

### Task 5: Migration 0054 + `volume_signals` types

**Files:**
- Create: `supabase/migrations/0054_volume_signals.sql`
- Modify: `lib/data/types.ts`

**Interfaces:**
- Consumes: `TargetedMuscleGroup` (already exported from `lib/data/types.ts`).
- Produces: `VolumeFrequencySignal` type; `TrainingWeek.volume_signals: VolumeFrequencySignal[] | null`.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0054_volume_signals.sql`:

```sql
-- 0054_volume_signals.sql
--
-- Frequency signals emitted by the prescription engine when a below-MEV set
-- bump was SUPPRESSED because prior bumps were prescribed but not performed.
-- The engine stops re-issuing a futile +1 and records why, so Carter can
-- recommend the real fix (another weekly exposure) instead of more sets.
--
-- Nullable: null on pre-0054 rows and on any week with no suppression.

alter table public.training_weeks
  add column if not exists volume_signals jsonb;

comment on column public.training_weeks.volume_signals is
  'VolumeFrequencySignal[] — per-muscle records of a below-MEV set bump withheld because prior bumps were not performed. Null when no suppression occurred. Read by the Carter prompt block (lib/coach/carter-context/volume-signals.ts).';
```

- [ ] **Step 2: Apply the migration**

Run: `supabase db push`
Expected: `0054_volume_signals.sql` applies cleanly. (The CLI is linked and migration history was reconciled on 2026-07-09, so a plain push works.)

- [ ] **Step 3: Add the types**

In `lib/data/types.ts`, add near the other prescription-related types:

```ts
/** Emitted when the engine withholds a below-MEV set bump because prior
 *  bumps were prescribed but not performed. The real constraint in that
 *  state is training FREQUENCY, not sets per session. */
export type VolumeFrequencySignal = {
  muscle: TargetedMuscleGroup;
  /** The muscle's 8-week rolling weekly set count. */
  weekly_sets: number;
  mev: number;
  /** Distinct training days this week that hit the muscle. */
  weekly_exposures: number;
  /** Exercises whose bump was withheld. */
  suppressed_exercises: string[];
};
```

Then add the column to the `TrainingWeek` row type:

```ts
  volume_signals: VolumeFrequencySignal[] | null;
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: errors ONLY where `TrainingWeek` object literals are constructed without the new field. Add `volume_signals: null` to each such literal. The known site is the synthetic `workingRow` in `lib/coach/prescription/upsert-week-prescription.ts`; fix any others the compiler names.

- [ ] **Step 5: Re-run typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0054_volume_signals.sql lib/data/types.ts lib/coach/prescription/upsert-week-prescription.ts
git commit -m "feat(db): add training_weeks.volume_signals (migration 0054)"
```

---

### Task 6: Adherence gate + signal collection in `prescribeWeek`

**Files:**
- Modify: `lib/coach/prescription/prescribe-week.ts`
- Modify: `lib/coach/prescription/upsert-week-prescription.ts`

**Interfaces:**
- Consumes: `setAdherenceFor` / `IGNORED_EXPOSURES_LIMIT` (Task 4), `recentEffortQuality` (Task 2), `VolumeFrequencySignal` (Task 5).
- Produces: `prescribeWeek` accepts an optional `signals?: VolumeFrequencySignal[]` collector in its opts and pushes into it. Its return type stays `Promise<SessionPrescriptions>` so the other 10 call sites are untouched.

- [ ] **Step 1: Add the imports and the opts collector**

In `lib/coach/prescription/prescribe-week.ts`, add imports:

```ts
import { setAdherenceFor, IGNORED_EXPOSURES_LIMIT } from "@/lib/coach/prescription/volume-adherence";
import type { VolumeFrequencySignal } from "@/lib/data/types";
```

Extend the `prescribeWeek` opts (the return type stays `Promise<SessionPrescriptions>`):

```ts
export async function prescribeWeek(opts: {
  supabase: SupabaseClient;
  userId: string;
  block: TrainingBlock | null;
  week: TrainingWeek;
  todayIso: string;
  /** Optional collector. When supplied, the engine pushes one signal per
   *  muscle whose set bump was withheld for non-adherence. Callers that
   *  don't care omit it — an out-param keeps the return type stable for
   *  the 10 existing call sites. */
  signals?: VolumeFrequencySignal[];
}): Promise<SessionPrescriptions> {
  const { supabase, userId, block, week, todayIso, signals } = opts;
```

- [ ] **Step 2: Load the prior week's prescribed set counts**

Immediately after the existing `const volumeContext = await fetchVolumeContext(...)` line, add:

```ts
  // Prior week's prescribed set counts, keyed by lowercased exercise name —
  // the denominator for adherence. Graceful: any failure yields an empty map
  // (adherence reports 0 ignored exposures, so the gate never fires).
  const priorPrescribedSets = await fetchPriorPrescribedSets(supabase, userId, week.week_start);
```

Then add the helper next to `fetchRecentSets`:

```ts
/** Map of lowercased exercise name → prescribed set count from the most
 *  recent stored week BEFORE `weekStart`. Empty map on any failure. */
async function fetchPriorPrescribedSets(
  supabase: SupabaseClient,
  userId: string,
  weekStart: string,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    const { data } = await supabase
      .from("training_weeks")
      .select("session_prescriptions")
      .eq("user_id", userId)
      .lt("week_start", weekStart)
      .order("week_start", { ascending: false })
      .limit(1);
    const presc = (data?.[0]?.session_prescriptions ?? null) as SessionPrescriptions | null;
    if (!presc) return out;
    for (const day of Object.values(presc)) {
      for (const ex of day ?? []) {
        if (ex.warmup) continue;
        const k = ex.name.toLowerCase();
        // First non-warmup entry per name wins — matches how the manual-edit
        // layer and volume rules address an exercise.
        if (!out.has(k) && typeof ex.sets === "number") out.set(k, ex.sets);
      }
    }
  } catch {
    // Graceful: no prior data → no adherence gating.
  }
  return out;
}
```

- [ ] **Step 3: Add the suppression accumulator before the weekday loop**

Immediately before `for (const [weekdayStr, sessionType] of Object.entries(week.session_plan ?? {}))`, add:

```ts
  // Muscles whose bump was withheld for non-adherence, and the exercises it
  // was withheld on. Converted to VolumeFrequencySignals after the loop, once
  // weekly exposure counts are known.
  const suppressedByMuscle = new Map<TargetedMuscleGroup, string[]>();
```

- [ ] **Step 4: Apply the adherence gate in the accessory branch**

Replace the accessory-branch block written in Task 3 Step 5 with:

```ts
          const band: VolumeBandPosition = classifyVolumeBandForMuscle(baseEx, volumeContext);
          const effort = recentEffortQuality(baseEx.name, recentSets, todayIso);
          const adherence = setAdherenceFor(
            baseEx.name,
            priorPrescribedSets.get(baseEx.name.toLowerCase()) ?? null,
            recentSets,
            todayIso,
          );
          const wantsBump = band === "below_mev" || band === "at_mev";
          const adherenceSuppressed =
            wantsBump && adherence.ignoredExposures >= IGNORED_EXPOSURES_LIMIT;

          if (adherenceSuppressed) {
            // Hold at what the athlete actually performs and record the
            // muscle so a frequency signal is emitted instead of a bump.
            const group = inferPrimaryTargetedMuscle(baseEx);
            if (group) {
              suppressedByMuscle.set(group, [
                ...(suppressedByMuscle.get(group) ?? []),
                baseEx.name,
              ]);
            }
            exercises.push({
              ...dp,
              sets: adherence.realizedMedian ?? baseEx.sets ?? 3,
            });
          } else {
            exercises.push(
              prescribeAccessoryFromVolumeBand({
                baseExercise: dp,
                currentSets: baseEx.sets ?? 3,
                bandPosition: band,
                hardRate: effort.hardRate,
                effortSampleSets: effort.totalSets,
              }),
            );
          }
```

- [ ] **Step 5: Emit the signals after the weekday loop**

Immediately before the closing `return out;` of `prescribeWeek`, add:

```ts
  // Build one frequency signal per suppressed muscle. weekly_exposures counts
  // the distinct prescribed training days that hit the muscle — the number the
  // recommendation is actually about.
  if (signals && suppressedByMuscle.size > 0 && volumeContext) {
    for (const [group, exerciseNames] of suppressedByMuscle) {
      let exposures = 0;
      for (const dayExercises of Object.values(out)) {
        const hits = (dayExercises ?? []).some(
          (ex) => !ex.warmup && inferPrimaryTargetedMuscle(ex) === group,
        );
        if (hits) exposures++;
      }
      signals.push({
        muscle: group,
        weekly_sets: volumeContext.rolling_avg_8wk[group] ?? 0,
        mev: literatureBand(group, "intermediate").mev,
        weekly_exposures: exposures,
        suppressed_exercises: exerciseNames,
      });
    }
  }
```

- [ ] **Step 6: Persist the signals from the Sunday upsert**

In `lib/coach/prescription/upsert-week-prescription.ts`, add the import:

```ts
import type { VolumeFrequencySignal } from "@/lib/data/types";
```

Change the `prescribeWeek` call (around line 184) to collect signals:

```ts
  const volumeSignals: VolumeFrequencySignal[] = [];
  const prescription = await prescribeWeek({
    supabase,
    userId,
    block,
    week: workingRow,
    todayIso,
    signals: volumeSignals,
  });
```

Then add the column to the upsert payload alongside `session_prescriptions`:

```ts
        volume_signals: volumeSignals.length > 0 ? volumeSignals : null,
```

- [ ] **Step 7: Typecheck and run the full unit suite**

Run: `npm run typecheck && npx vitest run`
Expected: no type errors; all tests pass.

- [ ] **Step 8: Commit**

```bash
git add lib/coach/prescription/prescribe-week.ts lib/coach/prescription/upsert-week-prescription.ts
git commit -m "feat(prescription): hold ignored set bumps and emit frequency signals

A below-MEV bump that is never performed leaves the muscle below MEV
forever, so the bump repeats indefinitely. After two ignored exposures the
engine holds at the realized median and records a VolumeFrequencySignal
naming the muscle, its exposure count, and the exercises it withheld."
```

---

### Task 7: Carter prompt block

**Files:**
- Create: `lib/coach/carter-context/volume-signals.ts`
- Modify: `app/api/chat/messages/route.ts:865-882`
- Modify: `lib/coach/system-prompts.ts` (CARTER_BASE)

**Interfaces:**
- Consumes: `TrainingWeek.volume_signals` (Task 5).
- Produces: `buildVolumeSignalsBlock(args: { supabase: SupabaseClient; userId: string }): Promise<string | null>`.

- [ ] **Step 1: Write the block builder**

Create `lib/coach/carter-context/volume-signals.ts`:

```ts
// lib/coach/carter-context/volume-signals.ts
//
// Surfaces the engine's withheld set bumps to Carter. When a muscle sits
// below MEV at one exposure per week, the fix is another exposure, not more
// sets in the one session — the engine stops bumping and says so here.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { VolumeFrequencySignal } from "@/lib/data/types";
import { getUserTimezone } from "@/lib/time/get-user-tz";
import { currentWeekMonday } from "@/lib/coach/carter-context/this-weeks-prescription";

export async function buildVolumeSignalsBlock(args: {
  supabase: SupabaseClient;
  userId: string;
}): Promise<string | null> {
  const { supabase, userId } = args;
  const tz = await getUserTimezone(userId);
  const weekStart = currentWeekMonday(new Date(), tz);

  const { data } = await supabase
    .from("training_weeks")
    .select("volume_signals")
    .eq("user_id", userId)
    .eq("week_start", weekStart)
    .maybeSingle();

  const signals = (data?.volume_signals ?? null) as VolumeFrequencySignal[] | null;
  if (!signals || signals.length === 0) return null;

  const lines = signals.map(
    (s) =>
      `- ${s.muscle}: ${fmt(s.weekly_sets)} sets/week vs MEV ${s.mev}, across ${s.weekly_exposures} ` +
      `session${s.weekly_exposures === 1 ? "" : "s"}/week. Set bump withheld on: ${s.suppressed_exercises.join(", ")}.`,
  );

  return [
    "<volume_signals>",
    "These muscles are below their minimum effective volume, but the engine has",
    "STOPPED adding sets because previously-added sets were not performed.",
    lines.join("\n"),
    "",
    "RULE: when a muscle is below MEV at one exposure per week, recommend a",
    "SECOND weekly exposure. Do NOT recommend more sets in the existing session —",
    "that is the lever that already failed. Never re-prescribe the withheld sets.",
    "</volume_signals>",
  ].join("\n");
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
```

- [ ] **Step 2: Confirm `currentWeekMonday` is exported**

Run: `grep -n "export function currentWeekMonday\|function currentWeekMonday" lib/coach/carter-context/this-weeks-prescription.ts`
Expected: the function exists. If it is NOT exported, add the `export` keyword to it in that file — do not duplicate the helper.

- [ ] **Step 3: Wire the block into Carter's context assembly**

In `app/api/chat/messages/route.ts`, add the import beside the existing one:

```ts
import { buildVolumeSignalsBlock } from "@/lib/coach/carter-context/volume-signals";
```

Extend the `Promise.all` destructure and array:

```ts
            const [exercisesBlock, frameworkBlock, prescriptionBlock, volumeSignalsBlock] = await Promise.all([
              buildThisWeeksExercisesBlock({ supabase: sr, userId: user.id }).catch((err) => {
                console.warn("[chat] buildThisWeeksExercisesBlock failed", err);
                return null;
              }),
              buildFrameworkStateBlock({ supabase: sr, userId: user.id }).catch((err) => {
                console.warn("[chat] buildFrameworkStateBlock failed", err);
                return null;
              }),
              buildThisWeeksPrescriptionBlock({ supabase: sr, userId: user.id }).catch((err) => {
                console.warn("[chat] buildThisWeeksPrescriptionBlock failed", err);
                return null;
              }),
              buildVolumeSignalsBlock({ supabase: sr, userId: user.id }).catch((err) => {
                console.warn("[chat] buildVolumeSignalsBlock failed", err);
                return null;
              }),
            ]);
```

And update the ordering comment + `parts` array so the volume signal sits after the prescription Carter must quote:

```ts
            // Ordering: framework rule first (the non-negotiable phase rule),
            // then the canonical prescription Carter must quote, then the
            // volume-frequency signals that constrain how he may change it,
            // then the exercise metadata supporting off-prescription swaps.
            const parts = [frameworkBlock, prescriptionBlock, volumeSignalsBlock, exercisesBlock].filter(
              (b): b is string => !!b,
            );
```

- [ ] **Step 4: Teach CARTER_BASE the rule**

Run: `grep -n "Session structure\|volume\|MEV" lib/coach/system-prompts.ts | head -20` to find the strength-guidance region of `CARTER_BASE`.

Add this paragraph to `CARTER_BASE`, immediately after the existing prescription-discipline guidance:

```
Volume and frequency. When a <volume_signals> block is present, those muscles are
below their minimum effective volume AND the engine has stopped adding sets because
previously-added sets were not performed. Recommend a second weekly exposure for that
muscle. Never recommend more sets inside the existing session, and never re-prescribe
the withheld sets — that lever has already been tried and ignored. If the athlete asks
why a set count dropped, explain it plainly: the engine stopped asking for sets that
were not being done.
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add lib/coach/carter-context/volume-signals.ts app/api/chat/messages/route.ts lib/coach/system-prompts.ts
git commit -m "feat(coach): surface volume frequency signals to Carter"
```

---

### Task 8: Audit assertions and end-to-end verification

**Files:**
- Modify: `scripts/audit-prescription-rules.mjs`
- Modify: `scripts/audit-sunday-prescription-e2e.mjs`

**Interfaces:**
- Consumes: every export from Tasks 2, 3, and 4.
- Produces: no new interfaces — regression coverage only.

- [ ] **Step 1: Add fixture assertions to the pure-function audit**

Append to `scripts/audit-prescription-rules.mjs`, before its final `summary(...)` call. Match the file's existing import and `assert` style:

```js
import {
  prescribeAccessoryFromVolumeBand,
  isEffortSuppressed,
  HARD_RATE_SUPPRESS_THRESHOLD,
  MIN_SETS_FOR_EFFORT_GATE,
} from "@/lib/coach/prescription/volume-balance-rule";
import { recentEffortQuality } from "@/lib/coach/prescription/effort-quality";
import { setAdherenceFor, IGNORED_EXPOSURES_LIMIT } from "@/lib/coach/prescription/volume-adherence";

console.log("\n## Effort gate\n");
{
  const ex = { name: "Lat Pulldown (Cable)", baseKg: 50, baseReps: 12, sets: 3 };
  const bump = (hardRate, effortSampleSets) =>
    prescribeAccessoryFromVolumeBand({ baseExercise: ex, currentSets: 3, bandPosition: "below_mev", hardRate, effortSampleSets }).sets;

  assert("clean effort below MEV adds a set", bump(0, 6) === 4);
  assert("two-of-three hard sets withholds the bump", bump(2 / 3, 6) === 3);
  assert("exactly one third still bumps", bump(HARD_RATE_SUPPRESS_THRESHOLD, 3) === 4);
  assert("sample below the floor ignores the gate", bump(1, MIN_SETS_FOR_EFFORT_GATE - 1) === 4);
  assert(
    "above_mrv drop is never suppressed",
    isEffortSuppressed({ baseExercise: ex, currentSets: 4, bandPosition: "above_mrv", hardRate: 1, effortSampleSets: 9 }) === false,
  );

  const s = (o) => ({ exercise_name: "Lat Pulldown (Cable)", exercise_key: null, kg: 50, reps: 12, warmup: false, failure: false, performed_on: "2026-08-01", rir: 2, ...o });
  const q = recentEffortQuality("Lat Pulldown (Cable)", [s({}), s({}), s({ failure: true })], "2026-08-03");
  assert("hardRate counts failure sets", Math.abs(q.hardRate - 1 / 3) < 1e-9);
  assert("rir 0 counts as hard", recentEffortQuality("Lat Pulldown (Cable)", [s({ rir: 0 })], "2026-08-03").hardSets === 1);
  assert("null rir is not hard", recentEffortQuality("Lat Pulldown (Cable)", [s({ rir: null })], "2026-08-03").hardSets === 0);
}

console.log("\n## Adherence gate\n");
{
  const session = (date, n) =>
    Array.from({ length: n }, () => ({ exercise_name: "Leg Extension (Machine)", exercise_key: null, kg: 40, reps: 12, warmup: false, failure: false, performed_on: date, rir: 2 }));

  const short2 = setAdherenceFor("Leg Extension (Machine)", 4, [...session("2026-08-01", 3), ...session("2026-07-25", 3)], "2026-08-03");
  assert("two short exposures reach the limit", short2.ignoredExposures >= IGNORED_EXPOSURES_LIMIT);
  assert("realized median reflects what was performed", short2.realizedMedian === 3);

  const met = setAdherenceFor("Leg Extension (Machine)", 4, [...session("2026-08-01", 3), ...session("2026-07-25", 4)], "2026-08-03");
  assert("a met exposure stops the count", met.ignoredExposures === 1);

  const none = setAdherenceFor("Leg Extension (Machine)", null, session("2026-08-01", 3), "2026-08-03");
  assert("null prescription yields zero ignored exposures", none.ignoredExposures === 0);
}
```

- [ ] **Step 2: Run the pure-function audit**

Run: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs`
Expected: all assertions pass, `0 failed`, exit code 0.

- [ ] **Step 3: Add the e2e ceiling assertion**

Append to `scripts/audit-sunday-prescription-e2e.mjs`, before its final summary. This is the regression gate for the whole plan — no prescribed accessory may exceed what the athlete performs by more than one set:

```js
console.log("\n## Prescribed vs realized set ceiling\n");
{
  const { data: tw } = await supabase
    .from("training_weeks")
    .select("week_start, session_prescriptions, volume_signals")
    .eq("user_id", userId)
    .order("week_start", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: workouts } = await supabase
    .from("workouts")
    .select("date, exercises(name, exercise_sets(warmup))")
    .eq("user_id", userId)
    .gte("date", subtractDaysIso(new Date().toISOString().slice(0, 10), 28));

  // Median realized non-warmup sets per session, per exercise name.
  const perExercise = new Map();
  for (const w of workouts ?? []) {
    const counts = new Map();
    for (const ex of w.exercises ?? []) {
      const n = (ex.exercise_sets ?? []).filter((s) => !s.warmup).length;
      if (n > 0) counts.set(ex.name.toLowerCase(), (counts.get(ex.name.toLowerCase()) ?? 0) + n);
    }
    for (const [k, n] of counts) {
      if (!perExercise.has(k)) perExercise.set(k, []);
      perExercise.get(k).push(n);
    }
  }

  let violations = 0;
  for (const day of Object.values(tw?.session_prescriptions ?? {})) {
    for (const ex of day ?? []) {
      if (ex.warmup) continue;
      const realized = perExercise.get(ex.name.toLowerCase());
      if (!realized || realized.length === 0) continue;
      const sorted = [...realized].sort((a, b) => a - b);
      const med = sorted[Math.floor(sorted.length / 2)];
      if ((ex.sets ?? 0) > med + 1) {
        violations++;
        console.error(`    ${ex.name}: prescribed ${ex.sets}, realized median ${med}`);
      }
    }
  }
  assert("no accessory prescribed more than realized median + 1", violations === 0);
  assert("volume_signals column is readable", tw !== null);
}
```

If `subtractDaysIso` is not already defined in that script, add it:

```js
function subtractDaysIso(iso, days) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
```

- [ ] **Step 4: Run the e2e audit**

Run: `AUDIT_USER_ID=94fee5c6-7d9a-4b05-be3a-8407505b5429 node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-sunday-prescription-e2e.mjs`
Expected: all assertions pass. Note this reads the CURRENT stored week, which was written by the old engine — a violation here before regenerating is expected and is fixed by Step 5.

- [ ] **Step 5: Regenerate the current week through the new engine and re-verify**

Regenerate this week's prescription so the stored row reflects the new rules, then re-run the e2e audit:

```bash
node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/regen-after-block-focus-fix.mjs
AUDIT_USER_ID=94fee5c6-7d9a-4b05-be3a-8407505b5429 node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-sunday-prescription-e2e.mjs
```

Expected: the ceiling assertion passes. Read `scripts/regen-after-block-focus-fix.mjs` first and confirm it targets the intended week; if it does not, regenerate via `upsertWeekPrescription` for the current `week_start` instead.

**Important:** the athlete has a `manual_session_edits` entry on this week's Monday (a re-entry week: Squat 80×7×3, accessories trimmed to 3 sets). That layer merges ABOVE `session_prescriptions` and must survive regeneration. Verify it is still present afterwards:

```bash
node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local -e "
const { createClient } = await import('@supabase/supabase-js');
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { data } = await s.from('training_weeks').select('manual_session_edits').eq('user_id','94fee5c6-7d9a-4b05-be3a-8407505b5429').eq('week_start','2026-08-03').single();
console.log(JSON.stringify(data.manual_session_edits));
"
```

Expected: the `Monday` edits object is intact.

- [ ] **Step 6: Full verification**

Run: `npm run typecheck && npx vitest run && node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs`
Expected: no type errors, all vitest tests pass, audit reports `0 failed`.

- [ ] **Step 7: Commit**

```bash
git add scripts/audit-prescription-rules.mjs scripts/audit-sunday-prescription-e2e.mjs
git commit -m "test(prescription): audit coverage for effort and adherence gates"
```

---

## Self-Review

**Spec coverage:**
- Change 1 (discovery realized set counts, incl. warmup-split row fix) → Task 1
- Change 2 (`recentEffortQuality` + gate) → Tasks 2, 3
- Change 3 (`setAdherenceFor`, gate, `VolumeFrequencySignal`, migration 0054, Carter block) → Tasks 4, 5, 6, 7
- Testing section (unit tests, fixture audit, e2e ceiling, verification gate) → Tasks 1–4 unit steps, Task 8
- Phasing: Tasks 1–3 are Phase 1 (no migration, independently shippable); Tasks 4–8 are Phase 2
- Risks: Change 1's `baseKg`/`baseReps` movement is covered by Task 8's e2e ceiling; `Math.round` median behaviour is documented in Task 1 Step 5

**Out of scope, deliberately:** re-pointing `lastWeekClean`/`consecutiveMisses`, adding `.order("set_index")` to `fetchRecentSets`, tier-aware volume bands. All recorded under spec Follow-ups.
