# Debrief Block Truth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the post-workout debrief agree with the prescription engine on block length, week number, phase and RIR target; stop it emitting phantom prescriptions from warmup rows; and stop it recommending volume the engine deliberately withheld.

**Architecture:** `blockProgress.ts` stops being a second hardcoded source of truth — its block-calendar fields are extracted into a pure `deriveBlockCalendar` that reuses the engine's own `currentBlockWeek` / `totalBlockWeeks` and reads `training_weeks.rir_target` with the same `?? 2` fallback `prescribeWeek` uses. The debrief then merges same-name exercise rows, reads `training_weeks.volume_signals`, and splits mid-week repatch notes out of the muted advisory list.

**Tech Stack:** TypeScript (strict), Next.js 15 App Router, Supabase, vitest (node env), Anthropic SDK.

## Global Constraints

- Path alias `@/*` → repo root. Use it; never relative climbs.
- Verification is `npm run typecheck` + `npx vitest run`. `npm run lint` is a no-op (unconfigured `next lint` that hangs) — do not run it.
- Unit tests live under `lib/**/__tests__/**/*.test.ts` — that glob is the only thing vitest scans. Tests elsewhere silently do not run.
- `WorkoutDebriefPayload` gains only **optional** fields. Stored debrief rows predate them, so every reader uses `?? []`. `chat_messages.ui` is jsonb — **no migration**.
- Do NOT change: `prescribeWeek`, the volume rules, migration 0054, or `compose-prescription.ts`'s `lift.tag === "PR"` proxy (a known open follow-up from PR #160).
- Do NOT reinstate a periodised RIR ladder in any form. `training_weeks.rir_target ?? 2` is the single source.
- Historical debriefs are NOT rewritten. Only newly generated ones are correct.
- Spec: [docs/superpowers/specs/2026-08-03-debrief-block-truth-design.md](../specs/2026-08-03-debrief-block-truth-design.md)

---

### Task 1: `deriveBlockCalendar` — one source of truth for block week, length, phase and RIR

Fixes the two worst defects: the debrief judged the athlete against RIR 1 (hardcoded ladder) when the engine prescribed 2, and reported "week 4 of 5" for an 8-week block.

**Files:**
- Modify: `lib/coach/prescription/block-phase-rule.ts` (export two private helpers)
- Modify: `lib/query/fetchers/blockProgress.ts`
- Test: `lib/query/fetchers/__tests__/blockProgress.test.ts`

**Interfaces:**
- Consumes: `evaluateBlockPhase` (already exported), plus `currentBlockWeek` / `totalBlockWeeks` which this task exports.
- Produces:
  - `export function currentBlockWeek(block: TrainingBlock, todayIso: string): number`
  - `export function totalBlockWeeks(block: TrainingBlock): number`
  - `export type BlockCalendar = { current_week: number; total_weeks: number; research_phase: "accumulate" | "deload"; rir_target: number }`
  - `export function deriveBlockCalendar(block: TrainingBlock, weekRirTarget: number | null, todayIso: string): BlockCalendar`
  - `BlockProgressPayload.total_weeks` widens from the literal `5` to `number`.

- [ ] **Step 1: Write the failing test**

Create `lib/query/fetchers/__tests__/blockProgress.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { deriveBlockCalendar } from "@/lib/query/fetchers/blockProgress";
import type { TrainingBlock } from "@/lib/data/types";

/** The athlete's real block: 2026-07-13 → 2026-09-06 is 8 weeks. */
function block(overrides: Partial<TrainingBlock> = {}): TrainingBlock {
  return {
    id: "b1",
    user_id: "u1",
    status: "active",
    start_date: "2026-07-13",
    end_date: "2026-09-06",
    goal_text: "",
    primary_lift: "squat",
    target_metric: "e1rm",
    target_value: 112,
    target_unit: "kg",
    diet_goal: null,
    created_at: "",
    completed_at: null,
    updated_at: "",
    target_hit_at_week: null,
    endurance_focus: null,
    session_structure_overrides: null,
    ...overrides,
  } as TrainingBlock;
}

describe("deriveBlockCalendar — block length", () => {
  it("derives total_weeks from the block dates, not a hardcoded 5", () => {
    expect(deriveBlockCalendar(block(), null, "2026-08-03").total_weeks).toBe(8);
  });

  it("does not clamp current_week to 5", () => {
    // 2026-08-24 is week 7 of a block starting 2026-07-13.
    expect(deriveBlockCalendar(block(), null, "2026-08-24").current_week).toBe(7);
  });

  it("reports week 1 on the block start date", () => {
    expect(deriveBlockCalendar(block(), null, "2026-07-13").current_week).toBe(1);
  });

  it("reports week 4 for the session that exposed the bug", () => {
    expect(deriveBlockCalendar(block(), null, "2026-08-03").current_week).toBe(4);
  });
});

describe("deriveBlockCalendar — phase", () => {
  it("is accumulate before the final week", () => {
    expect(deriveBlockCalendar(block(), null, "2026-08-03").research_phase).toBe("accumulate");
  });

  it("is deload on the final week", () => {
    // Week 8 of an 8-week block.
    expect(deriveBlockCalendar(block(), null, "2026-08-31").research_phase).toBe("deload");
  });

  it("stays accumulate when the target was already hit (consolidation)", () => {
    const b = block({ target_hit_at_week: 2 });
    expect(deriveBlockCalendar(b, null, "2026-08-03").research_phase).toBe("accumulate");
  });
});

describe("deriveBlockCalendar — RIR target", () => {
  it("falls back to 2 when the week row has no rir_target (matches prescribeWeek)", () => {
    expect(deriveBlockCalendar(block(), null, "2026-08-03").rir_target).toBe(2);
  });

  it("uses the week row's rir_target when set", () => {
    expect(deriveBlockCalendar(block(), 3, "2026-08-03").rir_target).toBe(3);
  });

  it("does not vary RIR by week number", () => {
    const w1 = deriveBlockCalendar(block(), null, "2026-07-13").rir_target;
    const w4 = deriveBlockCalendar(block(), null, "2026-08-03").rir_target;
    expect(w1).toBe(w4);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/query/fetchers/__tests__/blockProgress.test.ts`
Expected: FAIL — `deriveBlockCalendar` is not exported from `@/lib/query/fetchers/blockProgress`.

- [ ] **Step 3: Export the engine's block-calendar helpers**

In `lib/coach/prescription/block-phase-rule.ts`, add the `export` keyword to the two helpers at the bottom of the file (do not change their bodies):

```ts
export function currentBlockWeek(block: TrainingBlock, todayIso: string): number {
```

```ts
export function totalBlockWeeks(block: TrainingBlock): number {
```

A second copy of this arithmetic is exactly how the divergence being fixed here started — import, never duplicate.

- [ ] **Step 4: Add `deriveBlockCalendar` and delete the hardcoded tables**

In `lib/query/fetchers/blockProgress.ts`:

1. Delete `const RIR_BY_WEEK` and `const PHASE_BY_WEEK` entirely.
2. Change the payload field `total_weeks: 5;` to `total_weeks: number;`.
3. Add the imports:

```ts
import {
  evaluateBlockPhase,
  currentBlockWeek,
  totalBlockWeeks,
} from "@/lib/coach/prescription/block-phase-rule";
import { mondayOfIso } from "@/lib/time/dates";
```

4. Add the pure function (place it above `computeBlockProgress`):

```ts
export type BlockCalendar = {
  current_week: number;
  total_weeks: number;
  research_phase: "accumulate" | "deload";
  rir_target: number;
};

/** Block week / length / phase / RIR, derived from the block's own dates and
 *  the committed week row. Pure — every field here was previously invented by
 *  a hardcoded 5-week table that had silently diverged from the prescription
 *  engine (see docs/superpowers/specs/2026-08-03-debrief-block-truth-design.md).
 *
 *  `weekRirTarget` is training_weeks.rir_target for the current week, or null
 *  when unset / no row. The `?? 2` fallback is the SAME expression prescribeWeek
 *  uses (`week.rir_target ?? 2`) — that is what keeps the debrief and the engine
 *  from disagreeing again.
 *
 *  evaluateBlockPhase's off-pace branch needs realized-load inputs the caller
 *  does not have; passing null is correct because the only discriminator this
 *  function needs (deload_week) is decided by `week >= totalBlockWeeks` before
 *  those inputs are read. consolidation and pre_target both mean "accumulate"
 *  for the two-value research_phase. */
export function deriveBlockCalendar(
  block: TrainingBlock,
  weekRirTarget: number | null,
  todayIso: string,
): BlockCalendar {
  const phase = evaluateBlockPhase({
    block,
    currentWorkingKg: null,
    recentProgressionRatePerWeek: null,
    todayIso,
  });
  return {
    current_week: currentBlockWeek(block, todayIso),
    total_weeks: totalBlockWeeks(block),
    research_phase: phase === "deload_week" ? "deload" : "accumulate",
    rir_target: weekRirTarget ?? 2,
  };
}
```

5. In `computeBlockProgress`, replace the hardcoded derivation block:

```ts
  const start = new Date(block.start_date + "T00:00:00Z");
  const todayD = new Date(today + "T00:00:00Z");
  const weeksElapsed = Math.floor((todayD.getTime() - start.getTime()) / (7 * 86_400_000));
  const currentWeek = Math.min(5, Math.max(1, weeksElapsed + 1));
  const rirTarget = RIR_BY_WEEK[currentWeek];
  const phase = PHASE_BY_WEEK[currentWeek];
```

with:

```ts
  const start = new Date(block.start_date + "T00:00:00Z");
  const todayD = new Date(today + "T00:00:00Z");

  // Current week's committed rir_target — the engine's source of truth.
  const { data: weekRow } = await supabase
    .from("training_weeks")
    .select("rir_target")
    .eq("user_id", userId)
    .eq("week_start", mondayOfIso(today))
    .maybeSingle();

  const calendar = deriveBlockCalendar(block, weekRow?.rir_target ?? null, today);
  const currentWeek = calendar.current_week;
  const rirTarget = calendar.rir_target;
  const phase = calendar.research_phase;
```

6. In the returned object, replace the literal `total_weeks: 5` with `total_weeks: calendar.total_weeks`. Keep `research_phase: phase` and `rir_target: rirTarget` wired as they already are.

Note `start` and `todayD` are still used further down for the `startMinus28` / `todayMinus28` windows — keep both declarations.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run lib/query/fetchers/__tests__/blockProgress.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 6: Typecheck and full unit suite**

Run: `npm run typecheck && npx vitest run`
Expected: no type errors — in particular `components/strength/StrengthCoachClient.tsx` must still compile with `total_weeks: number` (it only displays the value). All tests pass.

- [ ] **Step 7: Verify against live data**

Write `scripts/_tmp-calendar.mjs`, run it, then delete it:

```js
import { createClient } from "@supabase/supabase-js";
import { computeBlockProgress } from "@/lib/query/fetchers/blockProgress";
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const p = await computeBlockProgress(s, "94fee5c6-7d9a-4b05-be3a-8407505b5429", "Asia/Dubai");
console.log(JSON.stringify({
  current_week: p.current_week, total_weeks: p.total_weeks,
  research_phase: p.research_phase, rir_target: p.rir_target,
}, null, 2));
```

Run: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/_tmp-calendar.mjs`
Expected: `total_weeks: 8` (was 5), `rir_target: 2` (was 1), `research_phase: "accumulate"`.
Then: `rm -f scripts/_tmp-calendar.mjs`

- [ ] **Step 8: Commit**

```bash
git add lib/coach/prescription/block-phase-rule.ts lib/query/fetchers/blockProgress.ts lib/query/fetchers/__tests__/blockProgress.test.ts
git commit -m "fix(coach): derive block week, length, phase and RIR from the engine

blockProgress.ts asserted total_weeks: 5 as a literal type, clamped
current_week to 5, and derived RIR from a hardcoded 4/3/2/1 ladder. The
active block is 8 weeks, so the debrief reported 'week 4 of 5' and judged
the athlete against RIR 1 while the engine prescribed 2 — telling him he
under-performed when he had complied.

All four fields now come from the block's own dates and the committed week
row, via a pure deriveBlockCalendar. Also fixes the /strength Block card,
which shares this fetcher."
```

---

### Task 2: Merge same-name exercise rows in the debrief

Warmup ramps are stored as separate `exercises` rows sharing the working entry's name, so each became its own "lift" and produced a `Hold 0 kg` prescription line.

**Files:**
- Modify: `lib/coach/session-debrief/index.ts`
- Test: `lib/coach/session-debrief/__tests__/merge-exercise-rows.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `export function mergeExerciseRows<T extends { warmup: boolean }>(rows: Array<{ name: string; sets: T[] }>): Array<{ name: string; sets: T[] }>` — exported from `lib/coach/session-debrief/index.ts` for testing.

- [ ] **Step 1: Write the failing test**

Create `lib/coach/session-debrief/__tests__/merge-exercise-rows.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mergeExerciseRows } from "@/lib/coach/session-debrief/index";

type S = { warmup: boolean; kg: number };
const w = (kg: number): S => ({ warmup: true, kg });
const x = (kg: number): S => ({ warmup: false, kg });

describe("mergeExerciseRows", () => {
  it("collapses warmup-split rows into one entry with only the working sets counted", () => {
    const out = mergeExerciseRows([
      { name: "Squat (Barbell)", sets: [w(47.5)] },
      { name: "Squat (Barbell)", sets: [w(62.5)] },
      { name: "Squat (Barbell)", sets: [x(80), x(80), x(80)] },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("Squat (Barbell)");
    expect(out[0].sets.filter((s) => !s.warmup)).toHaveLength(3);
  });

  it("drops an exercise that logged only warmup sets", () => {
    const out = mergeExerciseRows([
      { name: "Mobility Drill", sets: [w(0), w(0)] },
      { name: "Squat (Barbell)", sets: [x(80)] },
    ]);
    expect(out.map((e) => e.name)).toEqual(["Squat (Barbell)"]);
  });

  it("does not merge distinct exercises", () => {
    const out = mergeExerciseRows([
      { name: "Squat (Barbell)", sets: [x(80)] },
      { name: "Leg Press Single Leg", sets: [x(140)] },
    ]);
    expect(out).toHaveLength(2);
  });

  it("matches names case- and whitespace-insensitively but keeps the first spelling", () => {
    const out = mergeExerciseRows([
      { name: "Squat (Barbell)", sets: [x(80)] },
      { name: "  squat (barbell) ", sets: [x(80)] },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("Squat (Barbell)");
    expect(out[0].sets).toHaveLength(2);
  });

  it("preserves first-appearance order", () => {
    const out = mergeExerciseRows([
      { name: "B", sets: [x(1)] },
      { name: "A", sets: [x(1)] },
      { name: "B", sets: [x(1)] },
    ]);
    expect(out.map((e) => e.name)).toEqual(["B", "A"]);
  });

  it("returns an empty array for no rows", () => {
    expect(mergeExerciseRows([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/coach/session-debrief/__tests__/merge-exercise-rows.test.ts`
Expected: FAIL — `mergeExerciseRows` is not exported.

- [ ] **Step 3: Implement and wire the merge**

In `lib/coach/session-debrief/index.ts`, add the exported helper near the top-level function declarations:

```ts
/** Collapse exercise ROWS into one entry per exercise. Warmup ramp entries are
 *  stored as separate `exercises` rows sharing the working entry's name (see
 *  augmentFirstLoadedCompoundWithWarmups), so a per-row mapping produced
 *  duplicate lifts and — for warmup-only rows, where topSet() is null —
 *  phantom "Hold 0 kg" prescriptions. Entries with no working set are dropped
 *  entirely: they are not a lift the athlete performed. */
export function mergeExerciseRows<T extends { warmup: boolean }>(
  rows: Array<{ name: string; sets: T[] }>,
): Array<{ name: string; sets: T[] }> {
  const byKey = new Map<string, { name: string; sets: T[] }>();
  for (const row of rows) {
    const key = row.name.trim().toLowerCase();
    const existing = byKey.get(key);
    if (existing) existing.sets.push(...row.sets);
    else byKey.set(key, { name: row.name, sets: [...row.sets] });
  }
  return [...byKey.values()].filter((e) => e.sets.some((s) => !s.warmup));
}
```

Then wrap the existing `todayExercises` construction:

```ts
  const todayExercises: Array<{ name: string; sets: SetRow[] }> = mergeExerciseRows(
    exs.map((e) => ({
      name: e.name as string,
      sets: ((allSets ?? []) as Array<{ exercise_id: string } & SetRow>)
        .filter((s) => s.exercise_id === e.id)
        .map((s) => ({
          kg: s.kg,
          reps: s.reps,
          duration_seconds: s.duration_seconds,
          warmup: s.warmup,
          failure: s.failure,
          rir: s.rir,
        })),
    })),
  );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/coach/session-debrief/__tests__/merge-exercise-rows.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck and full unit suite**

Run: `npm run typecheck && npx vitest run`
Expected: no type errors; all tests pass. `totalWorking` (the working-set count just below the construction) is unchanged in value — merging does not change how many non-warmup sets exist.

- [ ] **Step 6: Commit**

```bash
git add lib/coach/session-debrief/index.ts lib/coach/session-debrief/__tests__/merge-exercise-rows.test.ts
git commit -m "fix(debrief): merge same-name exercise rows

Warmup ramp entries are separate exercises rows sharing the working
entry's name, so the debrief built one lift per ROW: three Squat entries,
two of them warmup-only. topSet() returns null for those, which flowed
through to 'Squat (Barbell) -> 0kg - Hold 0 kg' twice in the prescription.
Same class of bug as the discovery dedup fixed in PR #159."
```

---

### Task 3: Debrief reads `volume_signals`

The narrative recommended *"Add sets on the curl and calf raise to at least clear MEV"* while the engine had deliberately withheld exactly those set bumps and recorded why.

**Files:**
- Modify: `lib/data/types.ts` (`WorkoutDebriefPayload.prescription`)
- Modify: `lib/coach/session-debrief/compose-prescription.ts`
- Modify: `lib/coach/session-debrief/index.ts`
- Test: `scripts/audit-prescription-rules.mjs`

**Interfaces:**
- Consumes: `VolumeFrequencySignal` from `@/lib/data/types` (migration 0054, shipped in PR #159).
- Produces: `WorkoutDebriefPayload.prescription.volume_signals?: Array<{ muscle: string; weekly_sets: number; mev: number; weekly_exposures: number }>`; `composePrescription` accepts a new `volumeSignals` input field.

- [ ] **Step 1: Add the payload field**

In `lib/data/types.ts`, extend `WorkoutDebriefPayload.prescription`:

```ts
  prescription: {
    next_session_date: string | null;
    weight_changes: Array<{ exercise: string; new_kg: number; rationale: string }>;
    notes: string[];
    /** Muscles whose set bump the engine WITHHELD for non-adherence
     *  (migration 0054). The remedy for these is a second weekly exposure,
     *  never more sets. Optional: absent on debriefs generated before
     *  2026-08-03 — every reader must use `?? []`. */
    volume_signals?: Array<{
      muscle: string;
      weekly_sets: number;
      mev: number;
      weekly_exposures: number;
    }>;
  };
```

- [ ] **Step 2: Write the failing audit assertions**

Append to `scripts/audit-prescription-rules.mjs`, before its final `summary(...)` call:

```js
import { composePrescription } from "@/lib/coach/session-debrief/compose-prescription";

console.log("\n## session-debrief — volume signal coherence\n");
{
  const volume = [
    { muscle: "Calves", sets_today: 3, sets_this_week: 4.5, band: { mev: 8, mav_low: 12, mav_high: 16, mrv: 20 }, status: "below_mev" },
    { muscle: "Hams",   sets_today: 3, sets_this_week: 4.5, band: { mev: 6, mav_low: 10, mav_high: 16, mrv: 20 }, status: "below_mev" },
  ];
  const baseInput = { sessionType: "Legs", lifts: [], volume, todayExercises: [], block: null, todayIso: "2026-08-03" };

  const withSignal = composePrescription({
    ...baseInput,
    volumeSignals: [{ muscle: "Calves", weekly_sets: 3.9, mev: 8, weekly_exposures: 1 }],
  });
  const signalNote = withSignal.notes.join(" ");
  assert("signalled muscle gets the frequency framing", /Calves.*second exposure/i.test(signalNote));
  assert("signalled muscle never gets an add-sets recommendation", !/add .*set/i.test(signalNote));
  assert("signal is carried on the payload for the narrator", withSignal.volume_signals?.length === 1);

  const withoutSignal = composePrescription({ ...baseInput, volumeSignals: [] });
  assert(
    "unsignalled below-MEV muscles keep the adherence note",
    withoutSignal.notes.some((n) => n.includes("check session adherence")),
  );
}
```

- [ ] **Step 3: Run the audit to verify it fails**

Run: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs`
Expected: FAIL — `composePrescription` does not accept `volumeSignals`, and the frequency note does not exist.

- [ ] **Step 4: Implement the note rewrite**

In `lib/coach/session-debrief/compose-prescription.ts`:

1. Extend the input type:

```ts
type ComposePrescriptionInput = {
  sessionType: string;
  lifts: WorkoutDebriefPayload["lifts"];
  volume: WorkoutDebriefPayload["volume"];
  todayExercises: Array<{ name: string }>;
  block: TrainingBlock | null;
  todayIso: string;
  /** From training_weeks.volume_signals — muscles whose set bump the engine
   *  withheld because prior bumps were not performed. Defaults to none. */
  volumeSignals?: Array<{ muscle: string; weekly_sets: number; mev: number; weekly_exposures: number }>;
};
```

2. Destructure it: `const { sessionType, lifts, volume, volumeSignals = [] } = input;`

3. Replace the `below_mev` note block:

```ts
  if (low.length >= 2) {
    notes.push(`Volume is light on ${low.map((v) => v.muscle).join(", ")} this week — check session adherence.`);
  }
```

with:

```ts
  // A muscle carrying a withheld-bump signal must NOT be told to add sets —
  // that lever was already prescribed and not performed (migration 0054).
  // The remedy is another weekly exposure.
  const signalByMuscle = new Map(volumeSignals.map((s) => [s.muscle, s]));
  for (const v of low) {
    const sig = signalByMuscle.get(v.muscle);
    if (!sig) continue;
    notes.push(
      `${v.muscle} below MEV at ${sig.weekly_exposures} session${sig.weekly_exposures === 1 ? "" : "s"}/week — a second exposure is the fix, not more sets.`,
    );
  }
  const unsignalled = low.filter((v) => !signalByMuscle.has(v.muscle));
  if (unsignalled.length >= 2) {
    notes.push(`Volume is light on ${unsignalled.map((v) => v.muscle).join(", ")} this week — check session adherence.`);
  }
```

4. Add the field to the returned object:

```ts
  return {
    next_session_date: null, // populated by orchestrator from training_weeks
    weight_changes,
    notes,
    volume_signals: volumeSignals,
  };
```

- [ ] **Step 5: Load the signals in the orchestrator**

In `lib/coach/session-debrief/index.ts`, add the import:

```ts
import { mondayOfIso } from "@/lib/time/dates";
import type { VolumeFrequencySignal } from "@/lib/data/types";
```

Before the `composePrescription({ ... })` call, load the current week's signals:

```ts
  // Withheld-bump signals for the workout's week (migration 0054). Graceful:
  // any failure or a pre-0054 row yields [] and the notes behave as before.
  const { data: signalRow } = await supabase
    .from("training_weeks")
    .select("volume_signals")
    .eq("user_id", userId)
    .eq("week_start", mondayOfIso(workout.date as string))
    .maybeSingle();
  const volumeSignals = ((signalRow?.volume_signals ?? []) as VolumeFrequencySignal[]).map((s) => ({
    muscle: s.muscle as string,
    weekly_sets: s.weekly_sets,
    mev: s.mev,
    weekly_exposures: s.weekly_exposures,
  }));
```

Then pass `volumeSignals` into the `composePrescription({ ... })` call.

- [ ] **Step 6: Run the audit to verify it passes**

Run: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs`
Expected: `0 failed`.

- [ ] **Step 7: Typecheck and full unit suite**

Run: `npm run typecheck && npx vitest run`
Expected: no type errors; all tests pass.

- [ ] **Step 8: Commit**

```bash
git add lib/data/types.ts lib/coach/session-debrief/compose-prescription.ts lib/coach/session-debrief/index.ts scripts/audit-prescription-rules.mjs
git commit -m "fix(debrief): stop recommending volume the engine withheld

The debrief told the athlete to add calf and curl sets while the engine
had deliberately withheld exactly those bumps (migration 0054) and
recorded that the remedy is a second weekly exposure. The debrief now
reads training_weeks.volume_signals and emits the frequency framing for
signalled muscles."
```

---

### Task 4: Split mid-week plan changes out of the muted notes

A 17% cut on a main lift (`Plan updated for Tuesday: Overhead Press 30 → 25 kg`) rendered as grey text beneath an adherence nag.

**Files:**
- Modify: `lib/data/types.ts` (`WorkoutDebriefPayload.prescription`)
- Modify: `lib/coach/session-debrief/index.ts`
- Modify: `lib/coach/session-debrief/payload.ts`
- Modify: `components/coach/SessionDebriefView.tsx`
- Test: `scripts/audit-prescription-rules.mjs`

**Interfaces:**
- Consumes: `prescription.notes` and `prescription.volume_signals` from Task 3.
- Produces: `WorkoutDebriefPayload.prescription.plan_changes?: string[]`.

- [ ] **Step 1: Add the payload field**

In `lib/data/types.ts`, add to `WorkoutDebriefPayload.prescription` (alongside `volume_signals` from Task 3):

```ts
    /** Mid-week repatch entries ("Plan updated for <weekday>: …"), split out
     *  of `notes` so the UI can surface a real load change above advisory
     *  text. Optional: absent on debriefs generated before 2026-08-03 —
     *  every reader must use `?? []`. */
    plan_changes?: string[];
```

- [ ] **Step 2: Write the failing audit assertion**

Append to the `## session-debrief — volume signal coherence` block added in Task 3, inside the same `{ ... }` scope:

```js
  const routed = composePrescription({ ...baseInput, volumeSignals: [] });
  routed.plan_changes = routed.plan_changes ?? [];
  assert("composePrescription initialises plan_changes", Array.isArray(routed.plan_changes));
```

And add a separate block for the routing itself:

```js
console.log("\n## session-debrief — plan_changes routing\n");
{
  const notes = ["Volume is light on Hams, Calves this week — check session adherence."];
  const repatch = ["Plan updated for Tuesday: Overhead Press (Barbell) 30 → 25 kg"];
  // Mirrors the orchestrator's routing in session-debrief/index.ts.
  const planChanges = repatch.filter((n) => n.startsWith("Plan updated for "));
  const advisory = [...notes, ...repatch].filter((n) => !n.startsWith("Plan updated for "));
  assert("repatch note routes to plan_changes", planChanges.length === 1);
  assert("advisory notes exclude repatch entries", advisory.every((n) => !n.startsWith("Plan updated for ")));
  assert("advisory notes keep the volume note", advisory.length === 1);
}
```

- [ ] **Step 3: Run the audit to verify it fails**

Run: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs`
Expected: FAIL on `composePrescription initialises plan_changes` (the field does not exist yet on the returned object).

- [ ] **Step 4: Route repatch notes to `plan_changes`**

In `lib/coach/session-debrief/compose-prescription.ts`, add `plan_changes: []` to the returned object so the field always exists:

```ts
  return {
    next_session_date: null, // populated by orchestrator from training_weeks
    weight_changes,
    notes,
    volume_signals: volumeSignals,
    plan_changes: [],
  };
```

In `lib/coach/session-debrief/index.ts`, replace:

```ts
  if (repatchNotes.length > 0) prescription.notes.push(...repatchNotes);
```

with:

```ts
  // Mid-week repatch entries are a real load change, not advisory text —
  // they get their own field so the UI can surface them above the notes.
  if (repatchNotes.length > 0) {
    prescription.plan_changes = [
      ...(prescription.plan_changes ?? []),
      ...repatchNotes.filter((n) => n.startsWith("Plan updated for ")),
    ];
    prescription.notes.push(...repatchNotes.filter((n) => !n.startsWith("Plan updated for ")));
  }
```

- [ ] **Step 5: Point the TL;DR at the new field**

In `lib/coach/session-debrief/payload.ts`, replace:

```ts
  const repatched = p.prescription.notes.filter((n) => n.startsWith("Plan updated for "));
```

with:

```ts
  // Reads plan_changes since 2026-08-03; falls back to scanning notes so
  // debriefs stored before the split still render their ↻ line.
  const repatched = (p.prescription.plan_changes ?? []).length > 0
    ? (p.prescription.plan_changes ?? [])
    : p.prescription.notes.filter((n) => n.startsWith("Plan updated for "));
```

- [ ] **Step 6: Render plan changes prominently**

In `components/coach/SessionDebriefView.tsx`, inside the Prescription `<section>`, insert this block immediately after the `<h2>` and before the empty-state paragraph:

```tsx
        {(payload.prescription.plan_changes ?? []).length > 0 && (
          <ul
            style={{
              paddingLeft: 18,
              margin: "0 0 8px 0",
              fontSize: 13,
              fontWeight: 600,
              color: COLOR.textStrong,
              lineHeight: 1.5,
            }}
          >
            {(payload.prescription.plan_changes ?? []).map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        )}
```

Update the empty-state condition on the next line so a debrief carrying only plan changes does not claim "No changes":

```tsx
        {payload.prescription.weight_changes.length === 0 &&
          payload.prescription.notes.length === 0 &&
          (payload.prescription.plan_changes ?? []).length === 0 && (
          <p style={{ fontSize: 13, color: COLOR.textMuted }}>No changes — repeat the session as written.</p>
        )}
```

- [ ] **Step 7: Run the audit and full verification**

Run: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs && npm run typecheck && npx vitest run`
Expected: audit `0 failed`, no type errors, all tests pass.

- [ ] **Step 8: Commit**

```bash
git add lib/data/types.ts lib/coach/session-debrief/compose-prescription.ts lib/coach/session-debrief/index.ts lib/coach/session-debrief/payload.ts components/coach/SessionDebriefView.tsx scripts/audit-prescription-rules.mjs
git commit -m "feat(debrief): surface mid-week plan changes above advisory notes

A 17% cut on a main lift rendered as muted grey text below a 'check
session adherence' nag, because repatch notes shared one notes[] with
volume advice. Split into prescription.plan_changes with its own emphasised
block; the TL;DR falls back to scanning notes for pre-split debriefs."
```

---

### Task 5: Narrative guardrails and end-to-end confirmation

**Files:**
- Modify: `lib/coach/session-debrief/narrative-prompt.ts`

**Interfaces:**
- Consumes: `block.rir_target` / `block.total_weeks` (Task 1), `prescription.volume_signals` (Task 3), `prescription.plan_changes` (Task 4).
- Produces: no new interfaces.

- [ ] **Step 1: Add the three guardrails**

In `lib/coach/session-debrief/narrative-prompt.ts`, insert this section immediately after the `Framework grounding — non-negotiable:` block's bullet list (before the `Block focus` section):

```
Effort, block calendar, and volume — non-negotiable:

- The prescribed RIR for this session is block.rir_target in the payload. NEVER infer an RIR target from the week number or from a periodisation ladder. If the athlete's logged RIR met or exceeded block.rir_target, he COMPLIED — do not describe that as backing off, under-effort, or holding back, and do not tell him there is "no excuse" for it. A held-back rep against a met target is the plan working.
- Block length and position come ONLY from block.week_num and block.total_weeks. Never state a different total, and never compute "weeks remaining" from anything else. If either field is null, omit block framing entirely rather than guessing.
- For any muscle listed in prescription.volume_signals, the engine has ALREADY prescribed extra sets and the athlete did not perform them. NEVER recommend adding sets for those muscles. The prescribed remedy is a second weekly exposure — say that instead.
- When prescription.plan_changes is non-empty, mention those changes explicitly. They are real load changes already written to the plan, not suggestions.
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors (prompt is a template string).

- [ ] **Step 3: Regenerate the debrief and confirm every defect is gone**

Find the most recent workout and regenerate its debrief payload without writing it, then inspect. Write `scripts/_tmp-debrief.mjs`, run it, then delete it:

`generateWorkoutDebrief` is **read-only** (it performs no insert/update/upsert — the calling
route persists the result), so running it here does not create a duplicate debrief card. It
does make one Anthropic call for `narrative_md`, which is intended: the narrative is what
carried the original defects.

Its return is the discriminated union
`{ ok: true; payload: WorkoutDebriefPayload } | { ok: false; skipped: "no_working_sets" | "no_exercises" }`.

```js
import { createClient } from "@supabase/supabase-js";
import { generateWorkoutDebrief } from "@/lib/coach/session-debrief/index";
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const u = "94fee5c6-7d9a-4b05-be3a-8407505b5429";
const { data: w } = await s.from("workouts").select("id,date,type").eq("user_id", u).order("date", { ascending: false }).limit(1).single();
console.log("workout:", w.date, w.type);

const res = await generateWorkoutDebrief({ supabase: s, userId: u, workoutId: w.id });
if (!res.ok) { console.error("skipped:", res.skipped); process.exit(1); }
const pay = res.payload;

console.log("block:", JSON.stringify(pay.block));
console.log("weight_changes:");
for (const c of pay.prescription.weight_changes) console.log(`  ${c.exercise} -> ${c.new_kg}kg`);
console.log("plan_changes:", JSON.stringify(pay.prescription.plan_changes ?? []));
console.log("notes:", JSON.stringify(pay.prescription.notes));
console.log("volume_signals:", JSON.stringify(pay.prescription.volume_signals ?? []));
console.log("\n--- narrative ---\n" + pay.narrative_md);
```

Run: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/_tmp-debrief.mjs`

Expected, all five:
1. `block.total_weeks === 8` and `block.rir_target === 2`
2. Exactly **one** `Squat (Barbell)` entry in `weight_changes`, and **no** entry with `new_kg === 0`
3. `plan_changes` contains the `Plan updated for …` entry, and `notes` does not
4. Any below-MEV muscle with a signal produces the "second exposure" note, not "check session adherence"
5. The printed narrative does **not** claim a 1-RIR target, does **not** say "week 4 of 5" or
   "one week left", and does **not** recommend adding calf or curl sets

If any of the five fails, stop and investigate — do not proceed.

Then: `rm -f scripts/_tmp-debrief.mjs`

- [ ] **Step 4: Full verification**

Run: `npm run typecheck && npx vitest run && node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs && node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-workout-debrief.mjs`

Expected: no type errors, all vitest tests pass, `audit-prescription-rules` reports `0 failed`, and `audit-workout-debrief` reports no new failures versus its state at the start of this branch. If `audit-workout-debrief` requires `AUDIT_USER_ID`, set `AUDIT_USER_ID=94fee5c6-7d9a-4b05-be3a-8407505b5429`.

- [ ] **Step 5: Check the second consumer**

`blockProgress.ts` also feeds the `/strength` Block card via `useBlockProgress`. Start the dev server (`npm run dev`), open `/strength`, and confirm the block card shows **week 4 of 8** (not 4 of 5) and does not display a stale RIR. This is a visual check — the fetcher change is shared, so the debrief is not the only surface affected.

- [ ] **Step 6: Commit**

```bash
git add lib/coach/session-debrief/narrative-prompt.ts
git commit -m "feat(debrief): narrative guardrails for RIR, block calendar, volume

Three non-negotiable rules: the RIR target is block.rir_target and a
logged RIR meeting it is compliance (never 'backing off'); block length
comes only from block.week_num/total_weeks; and muscles in
prescription.volume_signals never get an add-sets recommendation."
```

---

## Self-Review

**Spec coverage:**
- A — `deriveBlockCalendar`, exported engine helpers, deleted ladders, widened `total_weeks` → Task 1
- B — merge same-name exercise rows → Task 2
- C — `volume_signals` in the debrief + note rewrite → Task 3
- D — `plan_changes` split + UI + TL;DR fallback → Task 4
- E — three narrative guardrails → Task 5
- Back-compat (optional fields, `?? []` readers, no migration) → Tasks 3, 4 field definitions and the TL;DR fallback in Task 4 Step 5
- Testing: `deriveBlockCalendar` suite → Task 1; merge suite → Task 2; audit assertions → Tasks 3, 4; regression fixture → Task 5 Step 3; verification gate → Task 5 Step 4
- Risks: `/strength` second consumer → Task 5 Step 5; RIR-2-everywhere is asserted in Task 1's test; historical debriefs untouched (no rewrite step anywhere, by design)

**Type consistency:** `deriveBlockCalendar` / `BlockCalendar` / `currentBlockWeek` / `totalBlockWeeks` / `mergeExerciseRows` / `volume_signals` / `plan_changes` are named identically across Tasks 1–5. `volume_signals` uses the same four-field shape in the payload type (Task 3 Step 1), the composer input (Task 3 Step 4), and the orchestrator mapping (Task 3 Step 5).

**Out of scope, deliberately:** reinstating an RIR ladder; `compose-prescription.ts`'s `lift.tag === "PR"` proxy; rewriting stored debriefs; the three pre-existing off-grid machine weights.
