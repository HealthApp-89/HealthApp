# Logger Supersets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the workout logger record a superset — one START, two exercises, one STOP, rest only at the end — starting with the three pairs in the Friday Arms session.

**Architecture:** A superset is plan metadata (`PlannedExercise.superset`), and a group is the maximal contiguous run of exercises sharing a tag. The existing set/rest state machine generalises from one active set to a list of active sets (a *round*); it is not duplicated. The pairing persists to `exercises.superset_group` so downstream readers can tell a grouped exercise's timing apart from a solo one's.

**Tech Stack:** Next.js 15 App Router, TypeScript (strict), Supabase/Postgres, vitest (node environment, `lib/**/__tests__/**/*.test.ts` only), Tailwind v4.

**Spec:** [docs/superpowers/specs/2026-08-11-logger-supersets-design.md](../specs/2026-08-11-logger-supersets-design.md)

## Global Constraints

- Branch: `feat/logger-supersets` (already created; the spec commit is on it).
- Verification per task: `npm run typecheck` and `npx vitest run` must both pass before committing. `npm run lint` is a no-op in this repo — do not use it.
- Components cannot be unit-tested here (vitest is node-environment and only scans `lib/**/__tests__/`). All new logic that can be pure MUST live under `lib/` and be tested there. `npm run build` is the guard for React hook-order failures.
- No `Date.now()` inside a `setState` updater — hoist the clock read into the handler (React may invoke updaters twice). Same rule for `new Date()`.
- Pure modules take `now` as a parameter; tests use a fixed epoch constant, never the real clock.
- User-visible numbers go through `fmtNum()` from `lib/ui/score.ts`.
- Next free migration slot is **0057**. Version prefixes must be unique and uniform-width.
- Do not introduce a second copy of an engine rule. Where two surfaces need the same number, they call the same function.

---

## File Structure

**Created:**
- `lib/logger/superset-groups.ts` — grouping and next-round resolution. Pure.
- `lib/logger/__tests__/superset-groups.test.ts`
- `lib/coach/prescription/__tests__/warmup-superset.test.ts`
- `supabase/migrations/0057_superset_group.sql`

**Modified:**
- `lib/coach/sessionPlans.ts` — `PlannedExercise.superset`, Arms tags.
- `lib/coach/prescription/prescribe-week.ts` — warmup entries strip the tag; export the warmup helper for testing.
- `lib/logger/set-timer.ts` — round timing math; `TimerState` generalised to lists.
- `lib/logger/draft-ops.ts` — commit one/all pending entries; `firstPendingSet` skip becomes a list.
- `lib/logger/types.ts` — `CommitSessionPayload.exercises[].superset_group`.
- `components/logger/LoggerSheet.tsx` — round wiring, group rendering, ungroup.
- `components/logger/ExerciseCard.tsx` — reads list-shaped timer state; Ungroup menu item.
- `lib/data/fetch-workout-for-edit.ts` — select and type the new column.
- `lib/logger/hydrate-from-workout.ts` — restore the tag onto `prescribed.superset`.
- `lib/coach/live-session/rule-rest-discipline.ts` — silent for grouped exercises.
- `lib/data/types.ts` + `lib/morning/brief/assembler.ts` + `components/morning/BriefSessionList.tsx` + `components/strength/TodayPlanCard.tsx` — the `SS` chip.
- `CLAUDE.md` — logger section.

**Existing tests updated:** `lib/logger/__tests__/set-timer.test.ts`, `lib/logger/__tests__/draft-ops.test.ts`, `lib/logger/__tests__/hydrate-from-workout.test.ts`.

---

### Task 1: Superset tag on the plan

**Files:**
- Modify: `lib/coach/sessionPlans.ts:9-41` (type), `lib/coach/sessionPlans.ts:79-90` (Arms)
- Modify: `lib/coach/prescription/prescribe-week.ts:509-552`
- Test: `lib/coach/prescription/__tests__/warmup-superset.test.ts`

**Interfaces:**
- Produces: `PlannedExercise.superset?: string`; `export function augmentFirstLoadedCompoundWithWarmups(exercises: PlannedExercise[]): PlannedExercise[]`

- [ ] **Step 1: Add the field to `PlannedExercise`**

In `lib/coach/sessionPlans.ts`, inside the `PlannedExercise` type (after `duration_seconds`):

```ts
  /** Superset tag. ADJACENT exercises sharing a tag are performed back-to-back
   *  as one round, with rest only after the last member — see
   *  lib/logger/superset-groups.ts, which defines a group as the maximal
   *  contiguous run of equal tags. Absent = performed alone.
   *
   *  Contiguity is the whole rule: a reorder that separates two members
   *  dissolves the group, and removing a member leaves the survivor solo, so
   *  there is no invalid state to validate against. */
  superset?: string;
```

- [ ] **Step 2: Tag the three Arms pairs**

In `SESSION_PLANS.Arms`, add `superset` to the first six entries only. The list is already in pairing order — do not reorder anything:

```ts
  Arms: [
    { name: "Arnold Press (Dumbbell)", baseKg: 24, baseReps: 15, sets: 3, key: "arnold_press", increment: { step: 4 }, superset: "A" },
    { name: "Bicep Curl (Dumbbell)", baseKg: 20, baseReps: 15, sets: 3, key: "bicep_curl", increment: { step: 4 }, superset: "A" },
    { name: "Front Raise (Dumbbell)", baseKg: 16, baseReps: 15, sets: 3, key: "front_raise", increment: { step: 4 }, superset: "B" },
    { name: "Hammer Curl (Dumbbell)", baseKg: 20, baseReps: 15, sets: 3, key: "hammer_curl", increment: { step: 4 }, superset: "B" },
    { name: "Lateral Raise (Dumbbell)", baseKg: 12, baseReps: 15, sets: 3, key: "lateral_raise", increment: { step: 4 }, superset: "C" },
    { name: "Triceps Pushdown (Cable - Straight Bar)", baseKg: 22.5, baseReps: 12, sets: 3, key: "triceps_pushdown", increment: { step: 2.5 }, superset: "C" },
```

Leave `Cable External Rotation`, `Cable Internal Rotation`, `Rear Delt Fly` and `Reverse Crunch` untagged.

- [ ] **Step 3: Write the failing test for the warmup trap**

Create `lib/coach/prescription/__tests__/warmup-superset.test.ts`:

```ts
// The two ramped warmup entries are built by spreading the working compound,
// so without an explicit strip they inherit its superset tag and the logger
// pulls the warmups into the pair. The athlete ramps the press alone.

import { describe, it, expect } from "vitest";
import { augmentFirstLoadedCompoundWithWarmups } from "@/lib/coach/prescription/prescribe-week";
import type { PlannedExercise } from "@/lib/coach/sessionPlans";

const ARMS: PlannedExercise[] = [
  { name: "Arnold Press (Dumbbell)", baseKg: 24, baseReps: 15, sets: 3, increment: { step: 4 }, superset: "A" },
  { name: "Bicep Curl (Dumbbell)", baseKg: 20, baseReps: 15, sets: 3, increment: { step: 4 }, superset: "A" },
];

describe("augmentFirstLoadedCompoundWithWarmups", () => {
  it("inserts two warmup entries before the first loaded compound", () => {
    const out = augmentFirstLoadedCompoundWithWarmups(ARMS);
    expect(out).toHaveLength(4);
    expect(out[0].warmup).toBe(true);
    expect(out[1].warmup).toBe(true);
    expect(out[2].name).toBe("Arnold Press (Dumbbell)");
  });

  it("strips the superset tag from the warmup entries", () => {
    const out = augmentFirstLoadedCompoundWithWarmups(ARMS);
    expect(out[0].superset).toBeUndefined();
    expect(out[1].superset).toBeUndefined();
  });

  it("leaves the working entries' tags intact", () => {
    const out = augmentFirstLoadedCompoundWithWarmups(ARMS);
    expect(out[2].superset).toBe("A");
    expect(out[3].superset).toBe("A");
  });
});
```

- [ ] **Step 4: Run it and watch it fail**

Run: `npx vitest run lib/coach/prescription/__tests__/warmup-superset.test.ts`
Expected: FAIL — `augmentFirstLoadedCompoundWithWarmups` is not exported (import error), and once exported, the strip assertions fail.

If the import fails because `prescribe-week.ts` pulls a server-only module, move these three assertions into `scripts/audit-prescription-rules.mjs` instead — that script already imports this module and runs under the alias-loader — and note the move in the commit message.

- [ ] **Step 5: Export the helper and strip the tag**

In `lib/coach/prescription/prescribe-week.ts`, change the declaration to `export function augmentFirstLoadedCompoundWithWarmups(` and add to its docstring:

```
 *  The warmup entries are built by spreading the working compound, so they
 *  must drop `superset`: a warmup inheriting the tag would be pulled into the
 *  pair by the logger's contiguous-run grouping and the athlete would be told
 *  to superset his ramp-up sets.
```

Then replace the two entry constructions:

```ts
  // Drop the superset tag: warmups are performed alone, before the round.
  const { superset: _supersetDropped, ...soloCompound } = compound;

  const warmup1: PlannedExercise = {
    ...soloCompound,
    warmup: true,
    baseKg: w1Kg,
    baseReps: 5,
    sets: 1,
    note: "Warmup 1 — ramp to working set",
  };
  const warmup2: PlannedExercise = {
    ...soloCompound,
    warmup: true,
    baseKg: w2Kg,
    baseReps: 3,
    sets: 1,
    note: "Warmup 2 — ramp to working set",
  };
```

- [ ] **Step 6: Verify**

Run: `npx vitest run lib/coach/prescription/__tests__/warmup-superset.test.ts` → PASS
Run: `npm run typecheck` → clean
Run: `npx vitest run` → all pass

- [ ] **Step 7: Commit**

```bash
git add lib/coach/sessionPlans.ts lib/coach/prescription/prescribe-week.ts lib/coach/prescription/__tests__/warmup-superset.test.ts
git commit -m "feat(plan): superset tag on PlannedExercise, tag the three Arms pairs"
```

---

### Task 2: Round timing math

**Files:**
- Modify: `lib/logger/set-timer.ts` (add beside `PHONE_LAG_SECONDS` / `workSecondsFor`)
- Test: `lib/logger/__tests__/set-timer.test.ts`

**Interfaces:**
- Produces: `SUPERSET_TRANSITION_SECONDS: number`, `splitRoundWork(startAnchorMs: number, stopPressMs: number, memberCount: number): number[]`, `roundMemberStartOffsets(shares: number[]): number[]`

Additive only — nothing calls these yet, so the tree stays green.

- [ ] **Step 1: Write the failing tests**

Append to `lib/logger/__tests__/set-timer.test.ts` (and add `SUPERSET_TRANSITION_SECONDS`, `splitRoundWork`, `roundMemberStartOffsets` to the import list at the top of that file):

```ts
describe("splitRoundWork", () => {
  it("matches workSecondsFor exactly for a one-member round", () => {
    expect(splitRoundWork(T0, T0 + 38_000, 1)).toEqual([workSecondsFor(T0, T0 + 38_000)]);
  });

  it("deducts one transition allowance for a pair and splits the rest", () => {
    // 100s wall clock − 5s phone lag − 5s transition = 90s of work, 45 each.
    expect(splitRoundWork(T0, T0 + 100_000, 2)).toEqual([45, 45]);
  });

  it("gives an odd remainder to the first member so the sum stays exact", () => {
    // 101s − 5 − 5 = 91 → 46 + 45.
    const shares = splitRoundWork(T0, T0 + 101_000, 2);
    expect(shares).toEqual([46, 45]);
    expect(shares[0] + shares[1]).toBe(91);
  });

  it("deducts two transitions for a three-member round", () => {
    // 125s − 5 − 10 = 110 → 38 + 36 + 36.
    const shares = splitRoundWork(T0, T0 + 125_000, 3);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(110);
    expect(shares[0]).toBe(38);
  });

  it("floors every member at 1 second for an absurdly short round", () => {
    expect(splitRoundWork(T0, T0 + 2_000, 2)).toEqual([1, 1]);
  });
});

describe("roundMemberStartOffsets", () => {
  it("starts the first member at zero", () => {
    expect(roundMemberStartOffsets([45, 45])[0]).toBe(0);
  });

  it("offsets each later member by the earlier shares plus a transition", () => {
    expect(roundMemberStartOffsets([45, 45])).toEqual([0, 50]);
    expect(roundMemberStartOffsets([38, 36, 36])).toEqual([0, 43, 84]);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run lib/logger/__tests__/set-timer.test.ts`
Expected: FAIL — the three symbols do not exist.

- [ ] **Step 3: Implement**

In `lib/logger/set-timer.ts`, directly beneath `restSeedSeconds`:

```ts
/** Dumbbell swap, or the walk from the rack to the cable station, between two
 *  exercises of one superset. Deducted once per transition so it is not
 *  credited as time under load. */
export const SUPERSET_TRANSITION_SECONDS = 5;

/**
 * Time under load for each member of one superset round.
 *
 * A round is ONE continuous work interval covering N exercises — that
 * continuity is the point of the technique, so the athlete is not asked to tap
 * a hand-off. The per-member split is therefore an even estimate, not a
 * measurement, and the honest part is the total: the shares sum exactly to the
 * round's work time, which is what keeps the dock's WORK counter, the finish
 * summary's work:rest ratio and rest-between-rounds true.
 *
 * The odd remainder goes to the FIRST member rather than being dropped, for
 * that same reason. Each share is floored at 1 for the same reason
 * `workSecondsFor` floors — a set never records zero seconds.
 *
 * A one-member round is exactly `workSecondsFor`, so a solo exercise runs this
 * code path unchanged.
 */
export function splitRoundWork(
  startAnchorMs: number,
  stopPressMs: number,
  memberCount: number,
): number[] {
  const n = Math.max(1, memberCount);
  const raw =
    Math.floor((stopPressMs - startAnchorMs) / 1000)
    - PHONE_LAG_SECONDS
    - SUPERSET_TRANSITION_SECONDS * (n - 1);
  if (raw < n) return Array.from({ length: n }, () => 1);
  const share = Math.floor(raw / n);
  const remainder = raw - share * n;
  return Array.from({ length: n }, (_unused, i) => (i === 0 ? share + remainder : share));
}

/**
 * Seconds from the round's start to each member's start: the earlier members'
 * work plus one transition allowance apiece. LoggerSheet turns these into the
 * per-set `started_at` stamps, so `restBetweenSets` keeps measuring from a real
 * anchor rather than guessing.
 */
export function roundMemberStartOffsets(shares: number[]): number[] {
  const offsets: number[] = [];
  let acc = 0;
  for (let i = 0; i < shares.length; i++) {
    offsets.push(acc);
    acc += shares[i] + SUPERSET_TRANSITION_SECONDS;
  }
  return offsets;
}
```

- [ ] **Step 4: Verify**

Run: `npx vitest run lib/logger/__tests__/set-timer.test.ts` → PASS
Run: `npm run typecheck` → clean

- [ ] **Step 5: Commit**

```bash
git add lib/logger/set-timer.ts lib/logger/__tests__/set-timer.test.ts
git commit -m "feat(logger): round work split and member start offsets"
```

---

### Task 3: Grouping and next-round resolution

**Files:**
- Create: `lib/logger/superset-groups.ts`
- Modify: `lib/logger/draft-ops.ts:139-148` (`firstPendingSet` skip becomes a list)
- Modify: `components/logger/LoggerSheet.tsx:734` (call site)
- Test: `lib/logger/__tests__/superset-groups.test.ts`, `lib/logger/__tests__/draft-ops.test.ts`

**Interfaces:**
- Consumes: `PlannedExercise.superset` (Task 1)
- Produces: `type SupersetGroup = { tag: string | null; indices: number[] }`, `groupsOf(exercises: { prescribed: PlannedExercise }[]): SupersetGroup[]`, `groupOfIndex(exercises, index): SupersetGroup`, `nextRound(draft: LoggerDraft, skip: SetRef[]): SetRef[]`; `firstPendingSet(draft, skip: SetRef[])`

- [ ] **Step 1: Write the failing tests**

Create `lib/logger/__tests__/superset-groups.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { LoggerDraft, ExerciseSetDraft } from "@/lib/logger/types";
import type { PlannedExercise } from "@/lib/coach/sessionPlans";
import { groupsOf, groupOfIndex, nextRound } from "@/lib/logger/superset-groups";

const NOW = "2026-08-11T09:00:00.000Z";

function mkSet(over: Partial<ExerciseSetDraft> = {}): ExerciseSetDraft {
  return {
    set_index: 0, kg: 20, reps: 15, duration_seconds: null,
    warmup: false, failure: false, rir: 2, committed_at: null, ...over,
  };
}

/** `spec` is [name, superset tag or null, number of sets, number committed]. */
function mkDraft(spec: [string, string | null, number, number][]): LoggerDraft {
  return {
    user_id: "u1", session_type: "Arms", date: "2026-08-11",
    started_at: NOW, updated_at: NOW, paused_at: null, paused_ms_total: 0,
    external_id: "logger-test", resolved_plan: [], timer: null,
    exercises: spec.map(([name, tag, sets, committed], i) => {
      const prescribed: PlannedExercise = { name, sets, baseReps: 15, baseKg: 20 };
      if (tag) prescribed.superset = tag;
      return {
        name, position: i, prescribed,
        sets: Array.from({ length: sets }, (_u, j) =>
          mkSet({ set_index: j, committed_at: j < committed ? NOW : null }),
        ),
      };
    }),
  };
}

const ARMS: [string, string | null, number, number][] = [
  ["Arnold Press", "A", 3, 0],
  ["Bicep Curl", "A", 3, 0],
  ["Front Raise", "B", 3, 0],
  ["Hammer Curl", "B", 3, 0],
  ["Rear Delt Fly", null, 3, 0],
];

describe("groupsOf", () => {
  it("pairs adjacent exercises sharing a tag and leaves untagged ones solo", () => {
    expect(groupsOf(mkDraft(ARMS).exercises)).toEqual([
      { tag: "A", indices: [0, 1] },
      { tag: "B", indices: [2, 3] },
      { tag: null, indices: [4] },
    ]);
  });

  it("dissolves a pair that a reorder has separated", () => {
    const groups = groupsOf(mkDraft([
      ["Arnold Press", "A", 3, 0],
      ["Rear Delt Fly", null, 3, 0],
      ["Bicep Curl", "A", 3, 0],
    ]).exercises);
    expect(groups).toEqual([
      { tag: "A", indices: [0] },
      { tag: null, indices: [1] },
      { tag: "A", indices: [2] },
    ]);
  });

  it("groups a run of three", () => {
    const groups = groupsOf(mkDraft([
      ["A1", "A", 3, 0], ["A2", "A", 3, 0], ["A3", "A", 3, 0],
    ]).exercises);
    expect(groups).toEqual([{ tag: "A", indices: [0, 1, 2] }]);
  });

  it("returns nothing for an empty session", () => {
    expect(groupsOf([])).toEqual([]);
  });
});

describe("groupOfIndex", () => {
  it("returns the group containing the index", () => {
    const ex = mkDraft(ARMS).exercises;
    expect(groupOfIndex(ex, 1)).toEqual({ tag: "A", indices: [0, 1] });
    expect(groupOfIndex(ex, 4)).toEqual({ tag: null, indices: [4] });
  });
});

describe("nextRound", () => {
  it("returns one set per member for a fresh pair", () => {
    expect(nextRound(mkDraft(ARMS), [])).toEqual([
      { exerciseIndex: 0, setIndex: 0 },
      { exerciseIndex: 1, setIndex: 0 },
    ]);
  });

  it("advances both members once the first round is committed", () => {
    const d = mkDraft([["Arnold Press", "A", 3, 1], ["Bicep Curl", "A", 3, 1], ["Rear Delt Fly", null, 3, 0]]);
    expect(nextRound(d, [])).toEqual([
      { exerciseIndex: 0, setIndex: 1 },
      { exerciseIndex: 1, setIndex: 1 },
    ]);
  });

  it("drops a member that has no uncommitted set left", () => {
    // Arnold has 3 sets all done except the last; the curl is finished.
    const d = mkDraft([["Arnold Press", "A", 3, 2], ["Bicep Curl", "A", 2, 2]]);
    expect(nextRound(d, [])).toEqual([{ exerciseIndex: 0, setIndex: 2 }]);
  });

  it("skips refs whose entry row is still open, and moves on to the next group", () => {
    const d = mkDraft([["Arnold Press", "A", 1, 0], ["Bicep Curl", "A", 1, 0], ["Rear Delt Fly", null, 2, 0]]);
    const skip = [{ exerciseIndex: 0, setIndex: 0 }, { exerciseIndex: 1, setIndex: 0 }];
    expect(nextRound(d, skip)).toEqual([{ exerciseIndex: 2, setIndex: 0 }]);
  });

  it("returns an empty round when every set is committed", () => {
    expect(nextRound(mkDraft([["Arnold Press", "A", 2, 2], ["Bicep Curl", "A", 2, 2]]), [])).toEqual([]);
  });

  it("returns a single-set round for a solo exercise", () => {
    expect(nextRound(mkDraft([["Rear Delt Fly", null, 3, 1]]), [])).toEqual([
      { exerciseIndex: 0, setIndex: 1 },
    ]);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run lib/logger/__tests__/superset-groups.test.ts`
Expected: FAIL — module `@/lib/logger/superset-groups` does not exist.

- [ ] **Step 3: Widen `firstPendingSet`'s skip to a list**

In `lib/logger/draft-ops.ts`, replace the signature and the skip check (the docstring's existing explanation of *why* a set is skipped stays; only the arity changes):

```ts
export function firstPendingSet(draft: LoggerDraft, skip: SetRef[]): SetRef | null {
  for (let ei = 0; ei < draft.exercises.length; ei++) {
    const sets = draft.exercises[ei].sets;
    for (let si = 0; si < sets.length; si++) {
      const ref = { exerciseIndex: ei, setIndex: si };
      if (!sets[si].committed_at && !skip.some((s) => sameSet(ref, s))) return ref;
    }
  }
  return null;
}
```

Add to its docstring, above the existing `skip` paragraph:

```
 * `skip` is a LIST because a superset round opens one entry row per member,
 * so more than one set can be uncommitted-but-finished at the same moment.
```

Update the call site at `components/logger/LoggerSheet.tsx:734` to
`firstPendingSet(draft, timer.pendingEntry ? [timer.pendingEntry] : [])`, and in
`lib/logger/__tests__/draft-ops.test.ts` change every `firstPendingSet(d, null)`
to `firstPendingSet(d, [])` and every `firstPendingSet(d, ref)` to
`firstPendingSet(d, [ref])`.

- [ ] **Step 4: Implement the grouping module**

Create `lib/logger/superset-groups.ts`:

```ts
// lib/logger/superset-groups.ts
//
// Which exercises are performed back-to-back, and which sets make up the next
// round. Pure — no React, no clock, no I/O — because the logger's components
// are unreachable by this repo's vitest setup (node environment,
// `lib/**/__tests__` glob) and grouping is exactly the kind of index arithmetic
// that fails silently.
//
// A GROUP is the maximal contiguous run of exercises sharing a `superset` tag.
// Contiguity is the entire rule, and it is load-bearing: a reorder that
// separates two members dissolves the pair, removing a member leaves the
// survivor solo, and two same-tagged exercises that end up apart are simply two
// groups of one. Nothing to validate, no invalid state to represent.
//
// A ROUND is one set from each member of a group — set 1 of each, then set 2 of
// each. Rounds are DERIVED rather than stored, which is what lets an unequal
// pair (3 sets against 2) end with a solo round without a special case.

import type { LoggerDraft, ExerciseDraft } from "@/lib/logger/types";
import { firstPendingSet } from "@/lib/logger/draft-ops";
import type { SetRef } from "@/lib/logger/set-timer";

export type SupersetGroup = {
  /** The shared tag, or null for an exercise performed alone. */
  tag: string | null;
  /** Indices into `draft.exercises`, in performance order. */
  indices: number[];
};

/** Every group in the session, in order. A solo exercise is a one-member
 *  group, so callers never need to branch on "is this a superset". */
export function groupsOf(exercises: Pick<ExerciseDraft, "prescribed">[]): SupersetGroup[] {
  const groups: SupersetGroup[] = [];
  for (let i = 0; i < exercises.length; i++) {
    const tag = exercises[i].prescribed.superset ?? null;
    const prev = groups[groups.length - 1];
    if (prev && tag !== null && prev.tag === tag) {
      prev.indices.push(i);
    } else {
      groups.push({ tag, indices: [i] });
    }
  }
  return groups;
}

/** The group containing `index`. Falls back to a one-member group so callers
 *  can rely on a non-null result for any valid index. */
export function groupOfIndex(
  exercises: Pick<ExerciseDraft, "prescribed">[],
  index: number,
): SupersetGroup {
  const found = groupsOf(exercises).find((g) => g.indices.includes(index));
  return found ?? { tag: exercises[index]?.prescribed.superset ?? null, indices: [index] };
}

/**
 * The sets START should begin: the next uncommitted set, plus the matching set
 * of every other member of its group, in group order.
 *
 * A member with nothing left uncommitted is omitted rather than padded, which
 * is how a 3-set exercise paired with a 2-set one ends on a solo round. Empty
 * result means the session is fully committed and the dock disables START.
 *
 * `skip` carries the refs whose entry row is still open — those sets are
 * uncommitted but already performed, so offering to run them again would count
 * down to a set the caller is about to commit.
 */
export function nextRound(draft: LoggerDraft, skip: SetRef[]): SetRef[] {
  const lead = firstPendingSet(draft, skip);
  if (!lead) return [];
  const group = groupOfIndex(draft.exercises, lead.exerciseIndex);
  const round: SetRef[] = [];
  for (const ei of group.indices) {
    const sets = draft.exercises[ei]?.sets ?? [];
    const si = sets.findIndex(
      (s, i) => !s.committed_at && !skip.some((k) => k.exerciseIndex === ei && k.setIndex === i),
    );
    if (si >= 0) round.push({ exerciseIndex: ei, setIndex: si });
  }
  return round;
}
```

- [ ] **Step 5: Verify**

Run: `npx vitest run` → all pass (including the updated `draft-ops` tests)
Run: `npm run typecheck` → clean

- [ ] **Step 6: Commit**

```bash
git add lib/logger/superset-groups.ts lib/logger/__tests__/superset-groups.test.ts lib/logger/draft-ops.ts lib/logger/__tests__/draft-ops.test.ts components/logger/LoggerSheet.tsx
git commit -m "feat(logger): contiguous-run superset grouping and next-round resolution"
```

---

### Task 4: Generalise the timer from one set to a round

Pure refactor. Behaviour must be **identical** at the end of this task — every round has exactly one member until Task 5 wires the grouping in. Do not add superset behaviour here.

**Files:**
- Modify: `lib/logger/set-timer.ts:20-220`
- Modify: `lib/logger/draft-ops.ts:31-89`
- Modify: `components/logger/LoggerSheet.tsx` (all timer reads)
- Modify: `components/logger/ExerciseCard.tsx:141-162`
- Test: `lib/logger/__tests__/set-timer.test.ts`, `lib/logger/__tests__/draft-ops.test.ts`

**Interfaces:**
- Produces: `TimerState { phase, anchorMs, activeSets: SetRef[], restSeconds, pendingEntries: (SetRef & { workSeconds: number })[] }`; actions `{ type: "press_start"; sets: SetRef[]; nowMs }`, `{ type: "save_entry"; set: SetRef }`; `includesSet(list: SetRef[], ref: SetRef | null): boolean`; `commitPendingEntries(draft, nowIso)`; `commitPendingEntry(draft, ref, nowIso)`

- [ ] **Step 1: Restate the timer type and reducer**

In `lib/logger/set-timer.ts` replace the `TimerState` / `IDLE_TIMER` / `TimerAction` block:

```ts
export type TimerState = {
  phase: TimerPhase;
  /** Absolute epoch ms the current phase started. Null only when idle.
   *  For `rest` this is the RACK time, already back-dated by the phone lag. */
  anchorMs: number | null;
  /** The sets the phase concerns, in group order: counting down to them,
   *  under load, or being rested after. A superset round holds more than one;
   *  an ordinary exercise holds exactly one; idle holds none. One list rather
   *  than a separate superset path — a second copy of this machine is how the
   *  two would drift. */
  activeSets: SetRef[];
  /** Seeded rest length for the rest currently running (prescribed − lag). */
  restSeconds: number;
  /** Zoomed entry rows — one per member of the round just stopped, each
   *  carrying that member's share of the round's work. Deliberately NOT a
   *  phase: entry and rest are concurrent, and making entry a phase value would
   *  make them mutually exclusive — exactly the coupling this design removes. */
  pendingEntries: (SetRef & { workSeconds: number })[];
};

export const IDLE_TIMER: TimerState = {
  phase: "idle",
  anchorMs: null,
  activeSets: [],
  restSeconds: 0,
  pendingEntries: [],
};

export type TimerAction =
  | { type: "press_start"; sets: SetRef[]; nowMs: number }
  /** Countdown reached zero, or the athlete tapped to skip it. */
  | { type: "countdown_elapsed"; nowMs: number }
  | { type: "press_stop"; nowMs: number; prescribedRestSeconds: number }
  /** One member's entry row was saved. The rest stay open. */
  | { type: "save_entry"; set: SetRef }
  /** A set was uncommitted or deleted. */
  | { type: "clear_for_set"; set: SetRef }
  | { type: "reset" };

/** Membership test for a round. Null ref is never a member. */
export function includesSet(list: SetRef[], ref: SetRef | null): boolean {
  if (!ref) return false;
  return list.some((s) => sameSet(s, ref));
}
```

- [ ] **Step 2: Update the reducer cases**

```ts
    case "press_start": {
      if (state.phase === "countdown" || state.phase === "running") return state;
      if (action.sets.length === 0) return state;
      return {
        phase: "countdown",
        anchorMs: action.nowMs,
        activeSets: action.sets,
        restSeconds: 0,
        // Caller persists any open entries BEFORE dispatching — see the
        // auto-save in LoggerSheet's handleTimerStart.
        pendingEntries: [],
      };
    }

    case "countdown_elapsed": {
      if (state.phase !== "countdown") return state;
      return { ...state, phase: "running", anchorMs: action.nowMs };
    }

    case "press_stop": {
      if (state.phase !== "running" || state.anchorMs === null || state.activeSets.length === 0) {
        return state;
      }
      const shares = splitRoundWork(state.anchorMs, action.nowMs, state.activeSets.length);
      return {
        phase: "rest",
        // Anchor at the rack, not the tap.
        anchorMs: action.nowMs - PHONE_LAG_SECONDS * 1000,
        activeSets: state.activeSets,
        restSeconds: restSeedSeconds(action.prescribedRestSeconds),
        pendingEntries: state.activeSets.map((s, i) => ({ ...s, workSeconds: shares[i] })),
      };
    }

    case "save_entry": {
      if (!state.pendingEntries.some((e) => sameSet(e, action.set))) return state;
      return {
        ...state,
        pendingEntries: state.pendingEntries.filter((e) => !sameSet(e, action.set)),
      };
    }

    case "clear_for_set": {
      // Un-committing or deleting ANY member of the round in play leaves
      // nothing coherent to stop or rest after, so the whole timer goes —
      // the same conservative rule the single-set machine applied.
      if (includesSet(state.activeSets, action.set)) return IDLE_TIMER;
      if (state.pendingEntries.some((e) => sameSet(e, action.set))) {
        return {
          ...state,
          pendingEntries: state.pendingEntries.filter((e) => !sameSet(e, action.set)),
        };
      }
      return state;
    }
```

- [ ] **Step 3: Update both remap functions**

```ts
export function remapTimerSets(
  state: TimerState,
  exerciseIndex: number,
  mapSetIndex: (oldIndex: number) => number | null,
): TimerState {
  if (state.activeSets.length === 0 && state.pendingEntries.length === 0) return state;

  const activeSets: SetRef[] = [];
  for (const ref of state.activeSets) {
    if (ref.exerciseIndex !== exerciseIndex) { activeSets.push(ref); continue; }
    const moved = mapSetIndex(ref.setIndex);
    if (moved !== null) activeSets.push({ ...ref, setIndex: moved });
  }
  // Every member of the round in play is gone: nothing left to stop or rest
  // after, so drop the timer rather than let it advance against sets that no
  // longer exist.
  if (state.activeSets.length > 0 && activeSets.length === 0) return IDLE_TIMER;

  const pendingEntries = state.pendingEntries.flatMap((e) => {
    if (e.exerciseIndex !== exerciseIndex) return [e];
    const moved = mapSetIndex(e.setIndex);
    return moved === null ? [] : [{ ...e, setIndex: moved }];
  });

  return { ...state, activeSets, pendingEntries };
}

export function remapTimerExercises(
  state: TimerState,
  mapIndex: (oldIndex: number) => number | null,
): TimerState {
  if (state.activeSets.length === 0 && state.pendingEntries.length === 0) return state;

  const activeSets: SetRef[] = [];
  for (const ref of state.activeSets) {
    const moved = mapIndex(ref.exerciseIndex);
    if (moved !== null) activeSets.push({ ...ref, exerciseIndex: moved });
  }
  if (state.activeSets.length > 0 && activeSets.length === 0) return IDLE_TIMER;

  const pendingEntries = state.pendingEntries.flatMap((e) => {
    const moved = mapIndex(e.exerciseIndex);
    return moved === null ? [] : [{ ...e, exerciseIndex: moved }];
  });

  return { ...state, activeSets, pendingEntries };
}
```

Keep both docstrings, adjusting the singular wording ("the set in play") to "any member of the round in play", and add one line to each: *a member that vanishes is dropped from the round; the timer only dies when every member is gone.*

- [ ] **Step 4: Split the entry commit in draft-ops**

In `lib/logger/draft-ops.ts`, replace `commitPendingEntry` with a shared core plus two entry points (keep the existing docstring's explanation of the time-based fallback verbatim on `commitEntries`):

```ts
/** Commit the entry row for ONE member of the open round. Called by that
 *  row's Save button; the other members' rows stay open and rest keeps
 *  running underneath. */
export function commitPendingEntry(
  draft: LoggerDraft,
  ref: SetRef,
  nowIso: string,
): LoggerDraft {
  const timer = draft.timer ?? IDLE_TIMER;
  const entry = timer.pendingEntries.find((e) => sameSet(e, ref));
  if (!entry) return draft;
  return commitEntries(draft, [entry], nowIso);
}

/** Commit EVERY open entry row. The exit paths use this — pressing START on
 *  the next round, Finish, and Pause & close — because none of them may
 *  silently drop a set the athlete has already performed. */
export function commitPendingEntries(draft: LoggerDraft, nowIso: string): LoggerDraft {
  const timer = draft.timer ?? IDLE_TIMER;
  if (timer.pendingEntries.length === 0) return draft;
  return commitEntries(draft, timer.pendingEntries, nowIso);
}

function commitEntries(
  draft: LoggerDraft,
  entries: (SetRef & { workSeconds: number })[],
  nowIso: string,
): LoggerDraft {
  let exercises = draft.exercises;
  for (const entry of entries) {
    exercises = exercises.map((ex, ei) =>
      ei !== entry.exerciseIndex ? ex : {
        ...ex,
        sets: ex.sets.map((s, si): ExerciseSetDraft => {
          if (si !== entry.setIndex || s.committed_at) return s;
          // A time-based set auto-saved by START never had its seconds field
          // blurred, so it would commit `duration_seconds: null` alongside a
          // perfectly good `work_seconds` — the plank the timer measured at 45s
          // recorded as no plank at all.
          const timeBased = ex.prescribed.duration_seconds != null;
          return {
            ...s,
            duration_seconds: timeBased && s.duration_seconds == null
              ? entry.workSeconds
              : s.duration_seconds,
            committed_at: nowIso,
          };
        }),
      },
    );
  }
  let timer = draft.timer ?? IDLE_TIMER;
  for (const entry of entries) {
    timer = timerReducer(timer, { type: "save_entry", set: entry });
  }
  return { ...draft, exercises, timer };
}
```

- [ ] **Step 5: Update the component call sites — mechanical, no behaviour change**

`components/logger/ExerciseCard.tsx`:
```ts
  const liveHere = midSet && timer.activeSets.some((s) => s.exerciseIndex === exerciseIndex);
  const pendingEntry =
    timer.pendingEntries.find((e) => e.exerciseIndex === exerciseIndex) ?? null;
```

`components/logger/LoggerSheet.tsx`:
- import `includesSet` and `commitPendingEntries` alongside the existing imports; keep `commitPendingEntry` (now two-arg).
- `handleTimerStart(set)` → `handleTimerStart(sets: SetRef[])`, with `const autoSaved = pendingEntryRefs.current;` (see below), `commitPendingEntries(prev, nowIso)` in place of the one-entry call, and `{ type: "press_start", sets, nowMs }`.
- `pendingEntryRef` (a single ref) becomes `pendingEntryRefs = useRef<SetRef[]>([])`, mirrored by the effect as
  `pendingEntryRefs.current = (draft?.timer?.pendingEntries ?? []).map((e) => ({ exerciseIndex: e.exerciseIndex, setIndex: e.setIndex }));`
- `handleEntrySave(ref)`: guard becomes `if (!pendingEntryRefs.current.some((r) => sameSet(r, ref))) return;` and the updater `commitPendingEntry(prev, ref, nowIso)`.
- `handleSetCommit`: `sameSet(cur.activeSet, {...})` → `includesSet(cur.activeSets, { exerciseIndex, setIndex })`.
- `handleCountdownElapsed`: stamp `started_at` on the FIRST member only — `const ref = next.activeSets[0];` and keep the rest of the body. (Later members are stamped at stop; Task 5 adds that.)
- `handleStop`: read `cur.activeSets[0]` for the rest lookup and keep stamping only that member's `work_seconds` from `next.pendingEntries[0].workSeconds` (Task 5 generalises the stamping loop).
- `pauseAndClose` and the Finish button: `commitPendingEntries(draft, nowIso)` / `commitPendingEntries(p, nowIso)`.
- `describeSet(draft, midSet ? timer.activeSets[0] ?? null : nextSetRef)`.
- `firstPendingSet(draft, timer.pendingEntries)`.

- [ ] **Step 6: Update the existing timer tests to the new shape**

In `lib/logger/__tests__/set-timer.test.ts`: `press_start` actions take `sets: [SET_A]`; assertions on `s.activeSet` become `s.activeSets` (`toEqual([SET_A])`); `s.pendingEntry` becomes `s.pendingEntries[0]`; `save_entry` actions carry `set: SET_A`. Add two new cases:

```ts
  it("press_start with an empty round is a no-op", () => {
    expect(timerReducer(IDLE_TIMER, { type: "press_start", sets: [], nowMs: T0 })).toBe(IDLE_TIMER);
  });

  it("save_entry for one member leaves the other member's row open", () => {
    const started = timerReducer(IDLE_TIMER, { type: "press_start", sets: [SET_A, SET_B], nowMs: T0 - 5000 });
    const running = timerReducer(started, { type: "countdown_elapsed", nowMs: T0 });
    const stopped = timerReducer(running, { type: "press_stop", nowMs: T0 + 100_000, prescribedRestSeconds: 120 });
    expect(stopped.pendingEntries).toHaveLength(2);
    const saved = timerReducer(stopped, { type: "save_entry", set: SET_A });
    expect(saved.pendingEntries).toEqual([{ ...SET_B, workSeconds: 45 }]);
    expect(saved.phase).toBe("rest");
  });
```

In `lib/logger/__tests__/draft-ops.test.ts`: `commitPendingEntry(draft, nowIso)` calls become `commitPendingEntry(draft, ref, nowIso)`; add one case asserting `commitPendingEntries` commits both members of a two-entry round and empties `pendingEntries`.

- [ ] **Step 7: Verify**

Run: `npx vitest run` → all pass
Run: `npm run typecheck` → clean
Run: `npm run build` → succeeds (guards the hook-order class of failure)

- [ ] **Step 8: Commit**

```bash
git add lib/logger components/logger
git commit -m "refactor(logger): timer state carries a round of sets, not one set"
```

---

### Task 5: Wire rounds into the logger

**Files:**
- Modify: `components/logger/LoggerSheet.tsx`
- Test: manual (component); the maths it calls is already covered by Tasks 2–3.

**Interfaces:**
- Consumes: `nextRound`, `groupOfIndex` (Task 3); `splitRoundWork`, `roundMemberStartOffsets` (Task 2); `commitPendingEntries` (Task 4)

- [ ] **Step 1: Start a whole round**

Replace the `nextSetRef` derivation and the dock's start handler:

```ts
  // What START dispatches. During `rest`, activeSets holds the sets just
  // FINISHED, so the next round always comes from the pending scan — and the
  // members whose zoom is still open are excluded, because START commits them
  // on the way.
  const nextRoundRefs = nextRound(draft, timer.pendingEntries);
```

`canStart={nextRoundRefs.length > 0}`, `onStart={() => { if (nextRoundRefs.length) handleTimerStart(nextRoundRefs); }}`.

The per-row "Start this set" button must start the whole round too, or a tap there would begin half a superset. Change `ExerciseCard`'s `onTimerStart` prop to `(set: SetRef) => void` — **unchanged signature** — and have LoggerSheet expand the ref itself:

```ts
  /** The round a set belongs to: that set plus each other group member's first
   *  uncommitted set, in group order. A row-level START must not begin half a
   *  superset, and the dock's START goes through nextRound already. */
  const roundForSet = useCallback((set: SetRef): SetRef[] => {
    const d = draftRef.current;
    if (!d) return [set];
    const group = groupOfIndex(d.exercises, set.exerciseIndex);
    if (group.indices.length === 1) return [set];
    const round: SetRef[] = [];
    for (const ei of group.indices) {
      if (ei === set.exerciseIndex) { round.push(set); continue; }
      const si = d.exercises[ei].sets.findIndex((s) => !s.committed_at);
      if (si >= 0) round.push({ exerciseIndex: ei, setIndex: si });
    }
    return round;
  }, []);

  const handleRowStart = useCallback((set: SetRef) => {
    handleTimerStart(roundForSet(set));
  }, [handleTimerStart, roundForSet]);
```

Pass `onTimerStart={props.editMode ? undefined : handleRowStart}` to `ExerciseCard`.

`draftRef` is a `useRef<LoggerDraft | null>(null)` declared beside `pendingEntryRefs` and written by the same mirroring effect (`draftRef.current = draft;`). It exists for the same reason that ref does: these callbacks use functional `setDraft` so they stay reference-stable for the memoized cards, which means they cannot close over the current draft.

- [ ] **Step 2: Stamp every member on stop**

Replace the body of `handleStop`:

```ts
  const handleStop = useCallback(() => {
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    setDraft((prev) => {
      if (!prev) return prev;
      const cur = timerOf(prev);
      if (cur.phase !== "running" || cur.activeSets.length === 0 || cur.anchorMs === null) return prev;
      const roundStartMs = cur.anchorMs;
      // Group rest, not per-exercise rest: the pair is one unit, so the longer
      // of the members' prescriptions is what the athlete owes.
      const prescribedRest = Math.max(
        ...cur.activeSets.map((r) =>
          restOverrides[r.exerciseIndex] ?? annotatedRestFor(prev, r.exerciseIndex),
        ),
      );
      const next = timerReducer(cur, { type: "press_stop", nowMs, prescribedRestSeconds: prescribedRest });
      // Read the shares OFF the new state rather than recomputing them — one
      // split, one source of truth for both the entry rows and the DB stamps.
      const shares = next.pendingEntries.map((e) => e.workSeconds);
      const offsets = roundMemberStartOffsets(shares);
      let exercises = prev.exercises;
      next.pendingEntries.forEach((entry, i) => {
        // Member 0's started_at was stamped at countdown end; later members
        // start when the earlier ones finish, plus one transition allowance.
        const startedAt = i === 0
          ? null
          : new Date(roundStartMs + offsets[i] * 1000).toISOString();
        exercises = exercises.map((ex, ei) =>
          ei !== entry.exerciseIndex ? ex : {
            ...ex,
            sets: ex.sets.map((s, si) =>
              si !== entry.setIndex ? s : {
                ...s,
                work_seconds: entry.workSeconds,
                started_at: startedAt ?? s.started_at ?? null,
              },
            ),
          },
        );
      });
      return withTimer({ ...prev, exercises }, next, nowIso);
    });
  }, [restOverrides]);
```

- [ ] **Step 3: Describe the round in the dock**

Replace `describeSet` with a round-aware version:

```ts
/** Dock captions for a round: which sets are in play and what they ask for. */
function describeRound(
  draft: LoggerDraft,
  refs: SetRef[],
): { activeLabel: string; targetLabel: string } {
  if (refs.length === 0) return { activeLabel: "All sets committed", targetLabel: "tap Finish when done" };
  if (refs.length === 1) return describeSet(draft, refs[0]);
  const group = groupOfIndex(draft.exercises, refs[0].exerciseIndex);
  const lead = draft.exercises[refs[0].exerciseIndex];
  const roundNumber = lead ? lead.sets.slice(0, refs[0].setIndex).filter((s) => !s.warmup).length + 1 : 1;
  const targets = refs.map((r) => {
    const ex = draft.exercises[r.exerciseIndex];
    const p = ex?.prescribed;
    if (!ex || !p) return "";
    const short = ex.name.split("(")[0].trim();
    return p.baseKg != null
      ? `${short} ${fmtNum(p.baseKg)}×${p.baseReps ?? "?"}`
      : `${short} ×${p.baseReps ?? "?"}`;
  });
  return {
    activeLabel: `Superset ${group.tag} · round ${roundNumber}`,
    targetLabel: targets.join(" → "),
  };
}
```

Keep `describeSet` — it is still the single-member path. Call site:
`const { activeLabel, targetLabel } = describeRound(draft, midSet ? timer.activeSets : nextRoundRefs);`

- [ ] **Step 4: Coach on the round**

`pendingCoachEval` becomes `SetRef[]`:

- `handleTimerStart` sets `setPendingCoachEval(autoSaved)` (already a list).
- `handleSetCommit` and `handleEntrySave` set `setPendingCoachEval([ref])`.
- The evaluation effect walks the list in order and shows the first line it gets:

```ts
  useEffect(() => {
    if (!pendingCoachEval || pendingCoachEval.length === 0 || !draft) return;
    // At most one line per commit, still — a round commits two sets, so the
    // first rule that fires in group order wins and the rest stay silent.
    let shown: { line: CoachLine; set: SetRef } | null = null;
    for (const ref of pendingCoachEval) {
      const line = evaluateCommittedSet(draft, ref, props.editMode ? undefined : liveContext.data);
      if (line) { shown = { line, set: ref }; break; }
    }
    setCoach(shown);
    setPendingCoachEval(null);
  }, [pendingCoachEval, draft, liveContext.data, props.editMode]);
```

- [ ] **Step 5: Verify**

Run: `npm run typecheck` → clean
Run: `npx vitest run` → all pass
Run: `npm run build` → succeeds

- [ ] **Step 6: Manual smoke on `/strength`**

Start an Arms session in the dev server (`npm run dev`). Confirm: START counts down once and the dock reads `Superset A · round 1` with both targets; STOP opens two entry rows at once; the WORK counter jumps by the whole round; rest starts once.

- [ ] **Step 7: Commit**

```bash
git add components/logger/LoggerSheet.tsx components/logger/ExerciseCard.tsx
git commit -m "feat(logger): one START/STOP drives a whole superset round"
```

---

### Task 6: Group rendering and ungroup

**Files:**
- Modify: `components/logger/LoggerSheet.tsx:1016-1043` (exercise list render)
- Modify: `components/logger/ExerciseCard.tsx:180-188` (⋯ menu)

**Interfaces:**
- Consumes: `groupsOf` (Task 3)
- Produces: `onUngroup?: (index: number) => void` on `ExerciseCard`

- [ ] **Step 1: Render groups with a rail**

Replace the `draft.exercises.map(...)` block with a group-driven render. Member cards keep their existing props and key **exactly** — the key encodes the index, and changing it would remount every card:

```tsx
        {groupsOf(draft.exercises).map((group) => {
          const cards = group.indices.map((i) => {
            const ex = draft.exercises[i];
            return (
              <ExerciseCard
                key={`${draft.started_at}-${ex.name}-${i}`}
                /* …every existing prop, unchanged, with exerciseIndex={i}… */
                onUngroup={group.tag ? handleUngroup : undefined}
              />
            );
          });
          if (!group.tag || group.indices.length < 2) return cards;
          const rounds = Math.max(...group.indices.map((i) => draft.exercises[i].sets.length));
          return (
            <div key={`ss-${group.tag}-${group.indices[0]}`} className="mb-3">
              <div className="flex items-center gap-2 mb-1.5 ml-0.5">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-purple-300 bg-purple-500/15 border border-purple-500/30 px-2 py-0.5 rounded-md">
                  Superset {group.tag}
                </span>
                <span className="text-[10px] text-zinc-500">
                  {rounds} rounds · rest after the last
                </span>
              </div>
              <div className="border-l-2 border-purple-500/40 pl-2">{cards}</div>
            </div>
          );
        })}
```

- [ ] **Step 2: Add the Ungroup menu item**

In `ExerciseCard`, add the prop `onUngroup?: (index: number) => void` (documented: *present only for a member of a real group; the sheet owns the mutation because it owns the draft*) and one item in the ⋯ menu, above Remove:

```tsx
              {onUngroup && (
                <button onClick={() => { setMenuOpen(false); onUngroup(exerciseIndex); }} className="block w-full text-left px-2 py-1.5 hover:bg-zinc-700 rounded text-zinc-200">Ungroup superset</button>
              )}
```

- [ ] **Step 3: Implement the handler**

In LoggerSheet, beside the other stable callbacks (above the `!draft` early return, per the hook-order rule):

```ts
  /** Break this exercise out of its superset for the rest of the session —
   *  the cable station is occupied, the pair is not happening tonight.
   *  Draft-local: the plan keeps its tag, and tomorrow's session is unaffected.
   *
   *  Drops the timer when the exercise is part of the live round, for the same
   *  reason handleSetCommit does: the round's membership would change under a
   *  running clock, and a STOP dispatched afterwards would split the work
   *  across a different set of members than the one that was performed. */
  const handleUngroup = useCallback((index: number) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const cur = timerOf(prev);
      const involved =
        cur.activeSets.some((s) => s.exerciseIndex === index)
        || cur.pendingEntries.some((e) => e.exerciseIndex === index);
      const exercises = prev.exercises.map((ex, i) => {
        if (i !== index) return ex;
        const { superset: _dropped, ...prescribed } = ex.prescribed;
        return { ...ex, prescribed };
      });
      // `updated_at` is left alone: the IndexedDB mirror effect stamps it, and
      // reading a clock inside a setState updater is the Rules-of-React
      // violation this file avoids everywhere else.
      return { ...prev, exercises, timer: involved ? IDLE_TIMER : prev.timer ?? null };
    });
  }, []);
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck` → clean
Run: `npm run build` → succeeds
Manual: the three Arms pairs render inside rails with `Superset A/B/C` chips; the four solo exercises render as before; Ungroup on the curl leaves two independent cards and the next START begins a one-set round.

- [ ] **Step 5: Commit**

```bash
git add components/logger/LoggerSheet.tsx components/logger/ExerciseCard.tsx
git commit -m "feat(logger): superset rail, chip, and per-session ungroup"
```

---

### Task 7: Persist the pairing

**Files:**
- Create: `supabase/migrations/0057_superset_group.sql`
- Modify: `lib/logger/types.ts:85-100` (`CommitSessionPayload`)
- Modify: `components/logger/LoggerSheet.tsx` (`commitNow` payload)
- Modify: `lib/data/fetch-workout-for-edit.ts:21-42`
- Modify: `lib/logger/hydrate-from-workout.ts:24-45`
- Test: `lib/logger/__tests__/hydrate-from-workout.test.ts`

**Interfaces:**
- Produces: `exercises.superset_group text`; `CommitSessionPayload.exercises[].superset_group: string | null`; `WorkoutForEditExercise.superset_group: string | null`

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0057_superset_group.sql`:

```sql
-- 0057_superset_group.sql
--
-- Records that an exercise was performed as part of a superset — two or more
-- exercises back-to-back with rest only after the last.
--
-- Two facts about a grouped exercise's stored numbers that no consumer can
-- reconstruct without this column:
--
--   1. work_seconds is a SPLIT, not a measurement. One START/STOP covers the
--      whole round (interrupting it would defeat the technique), so the round's
--      work time is divided evenly between its members after deducting the
--      phone lag and one 5s transition allowance per hand-off. The round total
--      is exact; the per-member share is an estimate.
--   2. rest_seconds_actual is INFLATED. It is derived from the previous set of
--      the SAME exercise, so a grouped exercise's recorded rest silently
--      contains the other member's work — it reads longer than the true rest
--      between rounds.
--
-- NULL for every exercise performed alone, every Strong CSV import, and all
-- pre-0057 rows. No backfill is possible: the grouping was never recorded.

alter table public.exercises add column if not exists superset_group text;

comment on column public.exercises.superset_group is
  'Superset tag ("A"/"B"/"C") when this exercise was performed back-to-back with its neighbours. NULL = performed alone. When set: work_seconds is an even split of the round rather than a measurement, and rest_seconds_actual includes the other members'' work. NULL for Strong imports and pre-0057 rows.';

-- Re-declare commit_logger_session to persist it. Body is identical to 0056
-- except the exercises INSERT column list and VALUES list.
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

  if auth.uid() is null or auth.uid() <> payload_user_id then
    raise exception 'commit_logger_session: auth.uid() mismatch';
  end if;

  if jsonb_array_length(payload->'exercises') > 30 then
    raise exception 'commit_logger_session: too many exercises (>30)';
  end if;

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

  delete from exercises where workout_id = new_workout_id;

  for ex in select * from jsonb_array_elements(payload->'exercises') loop
    if jsonb_array_length(ex->'sets') > 30 then
      raise exception 'commit_logger_session: too many sets for one exercise (>30)';
    end if;

    insert into exercises (workout_id, name, position, superset_group)
    values (
      new_workout_id,
      ex->>'name',
      (ex->>'position')::int,
      nullif(ex->>'superset_group', '')
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

- [ ] **Step 2: Apply it**

Run: `supabase db push`
Expected: `0057_superset_group.sql` applied. If the CLI reports drift, stop and report rather than editing history.

- [ ] **Step 3: Carry the tag on the wire**

`lib/logger/types.ts`, inside `CommitSessionPayload.exercises[]` above `sets`:

```ts
    /** Superset tag when this exercise was performed back-to-back with its
     *  neighbours; null when performed alone. See migration 0057 for what it
     *  tells a reader about work_seconds and rest_seconds_actual. */
    superset_group: string | null;
```

`components/logger/LoggerSheet.tsx`, in `commitNow`'s exercise map:

```ts
        name: ex.name,
        position: i,
        superset_group: ex.prescribed.superset ?? null,
```

- [ ] **Step 4: Read it back for edit mode**

`lib/data/fetch-workout-for-edit.ts`: add `superset_group: string | null;` to `WorkoutForEditExercise`, add `superset_group` to the `exercises(...)` selection inside `QUERY_COLS`, add it to `RawExercise`, and carry it in `shape()`:

```ts
      .map((e) => ({
        id: e.id,
        name: e.name,
        position: e.position ?? 0,
        superset_group: e.superset_group,
        sets: [...(e.exercise_sets ?? [])].sort((a, b) => a.set_index - b.set_index),
      }))
```

`lib/logger/hydrate-from-workout.ts`: after `prescribed` is resolved, restore the tag so an edited Friday keeps its pairs instead of flattening into ten exercises:

```ts
    // The saved grouping wins over whatever today's plan says: this is a
    // record of what was performed, not a fresh prescription.
    const prescribed: PlannedExercise = e.superset_group
      ? { ...base, superset: e.superset_group }
      : base;
```

(rename the existing `prescribed` const to `base`.)

- [ ] **Step 5: Test the hydration**

In `lib/logger/__tests__/hydrate-from-workout.test.ts`, add `superset_group: null` to the exercise inside `workoutFixture` (the widened type requires it), then append:

```ts
describe("hydrateWorkoutAsDraft — superset grouping", () => {
  it("restores the saved tag onto prescribed", () => {
    const w = workoutFixture();
    w.exercises[0].superset_group = "A";
    const draft = hydrateWorkoutAsDraft(w, []);
    expect(draft.exercises[0].prescribed.superset).toBe("A");
  });

  it("leaves prescribed untagged for an exercise performed alone", () => {
    const draft = hydrateWorkoutAsDraft(workoutFixture(), []);
    expect(draft.exercises[0].prescribed.superset).toBeUndefined();
  });

  it("prefers the saved tag over today's plan entry", () => {
    // The plan may have been re-paired since; this row records what happened.
    const w = workoutFixture();
    w.exercises[0].superset_group = "A";
    const draft = hydrateWorkoutAsDraft(w, [
      { name: "Decline Bench", sets: 3, baseReps: 8, superset: "C" },
    ]);
    expect(draft.exercises[0].prescribed.superset).toBe("A");
  });
});
```

- [ ] **Step 6: Verify**

Run: `npx vitest run` → all pass
Run: `npm run typecheck` → clean
Manual: log a two-round Arms superset in dev, Finish, then reopen it via the edit button — the pair still renders as a pair.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/0057_superset_group.sql lib/logger lib/data/fetch-workout-for-edit.ts components/logger/LoggerSheet.tsx
git commit -m "feat(logger): persist superset_group through commit and edit-mode hydration"
```

---

### Task 8: Rest-discipline stays quiet on grouped exercises

**Files:**
- Modify: `lib/coach/live-session/rule-rest-discipline.ts:69-80`
- Test: `lib/coach/live-session/__tests__/rule-guardrails.test.ts`

**Interfaces:**
- Consumes: `PlannedExercise.superset` (Task 1)

- [ ] **Step 1: Write the failing test**

Append to `lib/coach/live-session/__tests__/rule-guardrails.test.ts`, reusing that file's existing `mkSet` and `mkInput` builders. Add `import { ruleRestDiscipline } from "@/lib/coach/live-session/rule-rest-discipline";` at the top.

The numbers: `Squat` is tier 1 and `mkInput` prescribes 10 reps, so `restPrescription(1, 10).min` is 120s and the rule fires below 72s. Set 1 starts at 09:00:00 and runs 40s, set 2 starts at 09:01:30 — a 50s gap.

```ts
describe("ruleRestDiscipline — supersets", () => {
  const s1 = mkSet({
    set_index: 0,
    started_at: "2026-08-10T09:00:00.000Z",
    work_seconds: 40,
    committed_at: "2026-08-10T09:00:45.000Z",
  });
  const s2 = mkSet({
    set_index: 1,
    started_at: "2026-08-10T09:01:30.000Z",
    work_seconds: 38,
    committed_at: "2026-08-10T09:02:15.000Z",
  });

  it("fires on a 50s gap for a solo tier-1 lift", () => {
    const input = mkInput({ name: "Squat", sets: [s1, s2], current: s2 });
    expect(ruleRestDiscipline(input)).not.toBeNull();
  });

  it("stays silent when the same lift is performed in a superset", () => {
    const input = mkInput({ name: "Squat", sets: [s1, s2], current: s2 });
    const grouped = {
      ...input,
      exercise: {
        ...input.exercise,
        prescribed: { ...input.exercise.prescribed, superset: "A" },
      },
    };
    expect(ruleRestDiscipline(grouped)).toBeNull();
  });
});
```

`mkSet` in that file does not yet accept `started_at` / `work_seconds` in its literal — it spreads `Partial<ExerciseSetDraft>`, which already includes both, so no change is needed there.

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run lib/coach/live-session/__tests__/rule-guardrails.test.ts`
Expected: FAIL — the grouped case still returns a line.

- [ ] **Step 3: Implement**

In `ruleRestDiscipline`, immediately after the `set.warmup` guard:

```ts
  // A superset member's rest is not the quantity restPrescription describes.
  // Its gap is measured from the previous set of the SAME exercise, which in a
  // superset spans the other member's work as well — comparing that against an
  // inter-working-set prescription judges a number the athlete never chose.
  if (exercise.prescribed.superset) return null;
```

Extend the module header with one line: *Exercises performed in a superset are excluded outright — see the guard below.*

- [ ] **Step 4: Verify**

Run: `npx vitest run` → all pass
Run: `npm run typecheck` → clean

- [ ] **Step 5: Commit**

```bash
git add lib/coach/live-session/rule-rest-discipline.ts lib/coach/live-session/__tests__/rule-guardrails.test.ts
git commit -m "fix(live-session): rest discipline is not a judgement a superset can fail"
```

---

### Task 9: The `SS` chip on the brief and the strength card

**Files:**
- Modify: `lib/data/types.ts:1104-1118` (`MorningBriefExercise`)
- Modify: `lib/morning/brief/assembler.ts:611-622`
- Modify: `components/morning/BriefSessionList.tsx` (exercise name cell)
- Modify: `components/strength/TodayPlanCard.tsx:146-160`

`DailyPlan.exercises` is `PlannedExercise & {…}` built with `{ ...ex }`, so the strength card already receives `superset` — no plumbing there, only rendering.

- [ ] **Step 1: Carry the tag into the brief card shape**

`lib/data/types.ts`, in `MorningBriefExercise` after `video_url`:

```ts
  /** Superset tag carried through from the PlannedExercise. Rendered as an
   *  "SS A" chip so the session list groups visually the way the logger does. */
  superset?: string;
```

`lib/morning/brief/assembler.ts`, beside the existing optional-field copies:

```ts
      if (p.superset) result.superset = p.superset;
```

- [ ] **Step 2: Render it in the brief**

In `components/morning/BriefSessionList.tsx`, inside the exercise-name div, directly after `{e.name}`:

```tsx
                  {e.superset && (
                    <span
                      style={{
                        marginLeft: 6,
                        fontSize: 10,
                        fontWeight: 700,
                        letterSpacing: "0.06em",
                        color: COLOR.accent,
                      }}
                    >
                      SS {e.superset}
                    </span>
                  )}
```

- [ ] **Step 3: Render it on the strength card**

In `components/strength/TodayPlanCard.tsx`, in the same span as the exercise name, after the name text:

```tsx
                    {ex.superset && (
                      <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, opacity: 0.75 }}>
                        SS {ex.superset}
                      </span>
                    )}
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck` → clean
Run: `npm run build` → succeeds
Manual: `/strength` on a Friday shows `SS A` / `SS B` / `SS C` beside the six paired exercises and nothing beside the other four.

- [ ] **Step 5: Commit**

```bash
git add lib/data/types.ts lib/morning/brief/assembler.ts components/morning/BriefSessionList.tsx components/strength/TodayPlanCard.tsx
git commit -m "feat(ui): superset chip on the morning brief and strength card"
```

---

### Task 10: Re-prescribe the current week, document, verify

**Files:**
- Modify: `CLAUDE.md` (logger paragraph + migration list)

- [ ] **Step 1: Regenerate this week's prescription**

`training_weeks.session_prescriptions` sits at the top of the resolution chain and was written before the tag existed, so today's logger would still resolve untagged exercises. Trigger the Sunday prescription sync for the current week:

```bash
curl -X POST "$NEXT_PUBLIC_APP_URL/api/coach/sunday-prescriptions/sync" \
  -H "Authorization: Bearer $CRON_SECRET"
```

Then confirm the Friday entry carries the tags — open the logger on `/strength` and check the rails render. If the row is not regenerated (the endpoint targets next Monday's row), the tags appear from next week and the pairs come from `SESSION_PLANS` in the meantime; note which happened in the commit message rather than forcing a row edit.

- [ ] **Step 2: Add migration 0057 to the CLAUDE.md list**

After the 0056 entry:

```markdown
50. [supabase/migrations/0057_superset_group.sql](supabase/migrations/0057_superset_group.sql) — adds `exercises.superset_group` (nullable tag; NULL = performed alone) and re-declares `commit_logger_session` to insert it. Marks that an exercise was performed back-to-back with its neighbours, which is the only way a reader can tell that its `work_seconds` is an even split of one round rather than a measurement, and that its `rest_seconds_actual` silently contains the other member's work. No backfill — the grouping was never recorded before.
```

Update the "Next free slot" line to **0058**.

- [ ] **Step 3: Extend the logger paragraph in CLAUDE.md**

Append to the in-app workout logger bullet:

```markdown
Supersets are plan metadata: `PlannedExercise.superset` tags adjacent exercises, and a group is the maximal CONTIGUOUS run of equal tags ([lib/logger/superset-groups.ts](lib/logger/superset-groups.ts)) — so a reorder that separates two members dissolves the pair and there is no invalid state to validate. The timer carries a ROUND (`TimerState.activeSets`, `pendingEntries`) rather than a single set; one START and one STOP cover every member, `splitRoundWork` divides the interval evenly after deducting `PHONE_LAG_SECONDS` once and `SUPERSET_TRANSITION_SECONDS` per hand-off, and the shares are read off the new timer state rather than recomputed so the entry rows and the DB stamps cannot disagree. The split is deliberate: asking for a hand-off tap would buy per-set precision no consumer spends, at the cost of the continuity that is the point of a superset. The round total stays exact, so the WORK counter and work:rest ratio are unaffected. `exercises.superset_group` (migration 0057) carries the fact to the DB, `ruleRestDiscipline` goes silent for grouped exercises (their gap spans the other member's work), and the ⋯ menu's Ungroup breaks a pair for the session without touching the plan. Friday Arms ships with three pairs; warmup entries strip the tag in `augmentFirstLoadedCompoundWithWarmups` or the ramp-up sets would be pulled into the pair.
```

- [ ] **Step 4: Full verification**

Run and paste the output of each into the commit or the report — do not claim any of them passed without the output:

```bash
npm run typecheck
npx vitest run
npm run build
node scripts/audit-timezone-usage.mjs
```

- [ ] **Step 5: Commit and open the PR**

```bash
git add CLAUDE.md
git commit -m "docs: superset logging in CLAUDE.md, migration 0057"
git push -u origin feat/logger-supersets
gh pr create --title "feat(logger): supersets" --body "…"
```

---

## Verification checklist (end of arc)

- [ ] `npm run typecheck` clean
- [ ] `npx vitest run` — all suites pass, including the four new/updated logger suites
- [ ] `npm run build` succeeds
- [ ] Migration 0057 applied (`supabase db push`)
- [ ] A real Friday Arms session logged end-to-end: three rails, one START/STOP per round, two entry rows per stop, rest once per round, Finish commits, `exercises.superset_group` populated for the six paired rows and NULL for the other four
