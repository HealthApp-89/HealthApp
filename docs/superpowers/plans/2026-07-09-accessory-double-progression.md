# Accessory Double Progression Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accessories progress via stateless double progression (reps climb a loadability-derived range at fixed load; topping out cleanly earns one grid step and a reps reset), with a corrected deload (accessories hold load, halve sets).

**Architecture:** One new pure rule module (`double-progression-rule.ts`) replaces `prescribeSecondaryAutoregulated` in the orchestrator's accessory branch only; volume-balance keeps owning accessory sets except on deload week, where the rule's half-sets output is final. Everything derives from the existing 28-day `WorkoutSetSample` history (which carries per-set `rir`); no schema, no stored state, no UI changes.

**Tech Stack:** Next.js 15, TypeScript strict, fixture-based audit scripts (`scripts/audit-prescription-rules.mjs` — currently 155 assertions).

**Spec:** [docs/superpowers/specs/2026-07-09-accessory-double-progression-design.md](../specs/2026-07-09-accessory-double-progression-design.md)

## Global Constraints

- Secondaries (non-focus big-four) and the primary lift: behavior byte-identical — only the accessory branch changes.
- All loads on the equipment grid via `roundToStep(kg, step)`; descent floor `max(step, …)`; step-up never exceeds the focus clamp ceiling (park at `top` reps instead).
- `rir == null` history degrades to reps-only criteria (same convention as `lastWeekClean`).
- Deload week: accessories HOLD load, sets = `max(1, ceil((baseEx.sets ?? 3) / 2))`, volume-balance skipped. Primary/secondaries unchanged (0.80×, halved floor 2).
- Rep-range widths: `{ fine: 2, moderate: 3, coarse: 4 }`; unmapped exercises default `moderate`.
- Range bottom anchors to the STATIC `SESSION_PLANS` baseReps when the exercise exists there; otherwise `baseEx.baseReps ?? 8`.
- All 155 pre-existing audit assertions stay green.
- Audit command: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs`
- Branch: `feat/accessory-double-progression` (exists; commits auto-push — never commit on main).
- Commits end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: The rule module (pure) + fixtures

**Files:**
- Create: `lib/coach/prescription/double-progression-rule.ts`
- Test: `scripts/audit-prescription-rules.mjs` (append fixtures)

**Interfaces:**
- Consumes: `roundToStep` from `@/lib/coach/prescription/calibrate-target`; `PlannedExercise` from `@/lib/coach/sessionPlans`; `BlockPhase`, `WorkoutSetSample` from `@/lib/coach/prescription/types`.
- Produces (Task 2 imports these):
  - `type Loadability = "fine" | "moderate" | "coarse"`
  - `const REP_RANGE_WIDTH: Record<Loadability, number>`
  - `prescribeAccessoryDoubleProgression(input: DoubleProgressionInput): PlannedExercise` where `DoubleProgressionInput = { baseExercise: PlannedExercise; currentWorkingKg: number; recentSets: WorkoutSetSample[]; rirTarget: number; blockPhase: BlockPhase; loadability: Loadability; focusClampCeilingKg: number | null; bottomReps: number }`

- [ ] **Step 1: Write the failing fixtures**

Append to `scripts/audit-prescription-rules.mjs` before the final `summary()` call (new import: `import { prescribeAccessoryDoubleProgression, REP_RANGE_WIDTH } from "@/lib/coach/prescription/double-progression-rule";`):

```js
console.log("\n## double-progression-rule.ts — accessory double progression\n");

{
  // Lateral Raise (DB, coarse): step 2, bottom 10, width 4 → range 10..14.
  const ex = { name: "Lateral Raise (Dumbbell)", baseReps: 10, sets: 3, rir: 2, increment: { step: 2 } };
  const S = (kg, reps, rir, date, extra = {}) => ({
    exercise_name: "Lateral Raise (Dumbbell)", exercise_key: null,
    kg, reps, warmup: false, failure: false, rir, performed_on: date, ...extra,
  });
  const input = (over = {}) => ({
    baseExercise: ex, currentWorkingKg: 12, recentSets: [], rirTarget: 2,
    blockPhase: "pre_target", loadability: "coarse", focusClampCeilingKg: null,
    bottomReps: 10, ...over,
  });

  assert("width table", REP_RANGE_WIDTH.fine === 2 && REP_RANGE_WIDTH.moderate === 3 && REP_RANGE_WIDTH.coarse === 4);

  // 1) STEP UP: two sets at L, both clean at top (14 reps, rir ≥ 2) → 14 kg, reps reset to 10.
  const up = prescribeAccessoryDoubleProgression(input({
    recentSets: [S(12, 14, 2, "2026-07-07"), S(12, 14, 3, "2026-07-07")],
  }));
  assert("step up: load +step on grid", up.baseKg === 14);
  assert("step up: reps reset to bottom", up.baseReps === 10);

  // 2) Clamp parks at top instead of exceeding ceiling.
  const parked = prescribeAccessoryDoubleProgression(input({
    recentSets: [S(12, 14, 2, "2026-07-07"), S(12, 14, 2, "2026-07-07")],
    focusClampCeilingKg: 12,
  }));
  assert("clamp: load parked at L", parked.baseKg === 12);
  assert("clamp: reps parked at top", parked.baseReps === 14);

  // 3) Single set at L is NOT enough for a step up → rep-up path instead.
  const single = prescribeAccessoryDoubleProgression(input({
    recentSets: [S(12, 14, 2, "2026-07-07")],
  }));
  assert("single set: no load jump", single.baseKg === 12);
  assert("single set: rep-up capped at top", single.baseReps === 14);

  // 4) REP UP: top set clean at 11 reps → prescribe 12.
  const repUp = prescribeAccessoryDoubleProgression(input({
    recentSets: [S(12, 11, 2, "2026-07-07"), S(12, 10, 1, "2026-07-07")],
  }));
  assert("rep up: load held", repUp.baseKg === 12);
  assert("rep up: reps +1 from achieved top set", repUp.baseReps === 12);

  // 5) Null RIR history → reps-only criterion still progresses.
  const legacy = prescribeAccessoryDoubleProgression(input({
    recentSets: [S(12, 11, null, "2026-07-07")],
  }));
  assert("null rir: rep up works", legacy.baseReps === 12 && legacy.baseKg === 12);

  // 6) Grinding below prescribed RIR is dirty: reps hit but rir 0 < 2 → not a rep-up.
  const grind = prescribeAccessoryDoubleProgression(input({
    recentSets: [S(12, 11, 0, "2026-07-07")],
  }));
  assert("grind: no rep up (hold)", grind.baseKg === 12 && grind.baseReps === 11);

  // 7) STEP DOWN: two consecutive sessions dirty at bottom (reps < 10) → 10 kg, reps 10.
  const down = prescribeAccessoryDoubleProgression(input({
    recentSets: [S(12, 8, 0, "2026-07-07"), S(12, 9, 1, "2026-06-30")],
  }));
  assert("step down: load -step", down.baseKg === 10);
  assert("step down: reps at bottom", down.baseReps === 10);

  // 8) ONE dirty session → hold (reps clamped into range).
  const hold = prescribeAccessoryDoubleProgression(input({
    recentSets: [S(12, 8, 0, "2026-07-07"), S(12, 12, 2, "2026-06-30")],
  }));
  assert("one dirty session: load held", hold.baseKg === 12);
  assert("one dirty session: reps clamped to bottom", hold.baseReps === 10);

  // 9) Descent floor: L = one step → never below step.
  const floor = prescribeAccessoryDoubleProgression(input({
    currentWorkingKg: 2,
    recentSets: [S(2, 8, 0, "2026-07-07"), S(2, 8, 0, "2026-06-30")],
  }));
  assert("descent floor: never below one step", floor.baseKg === 2);

  // 10) No history → hold at bottom.
  const fresh = prescribeAccessoryDoubleProgression(input({}));
  assert("no history: L + bottom", fresh.baseKg === 12 && fresh.baseReps === 10);

  // 11) DELOAD: load held, sets halved (3 → 2), volume-balance is skipped by the caller.
  const deload = prescribeAccessoryDoubleProgression(input({ blockPhase: "deload_week" }));
  assert("deload: load HELD", deload.baseKg === 12);
  assert("deload: sets halved", deload.sets === 2);
  assert("deload: reps at bottom", deload.baseReps === 10);

  // 12) CONSOLIDATION: all-top-clean does NOT step load; parks via rep-up at top.
  const consol = prescribeAccessoryDoubleProgression(input({
    blockPhase: "consolidation",
    recentSets: [S(12, 14, 2, "2026-07-07"), S(12, 14, 2, "2026-07-07")],
  }));
  assert("consolidation: load frozen", consol.baseKg === 12);
  assert("consolidation: reps park at top", consol.baseReps === 14);

  // 13) OFF_PACE: hold both even on a clean session.
  const off = prescribeAccessoryDoubleProgression(input({
    blockPhase: "off_pace",
    recentSets: [S(12, 11, 2, "2026-07-07")],
  }));
  assert("off_pace: load held", off.baseKg === 12);
  assert("off_pace: reps held (clamped achieved)", off.baseReps === 11);

  // 14) Warmup rows ignored in rung derivation.
  const warm = prescribeAccessoryDoubleProgression(input({
    recentSets: [S(6, 20, 4, "2026-07-07", { warmup: true }), S(12, 11, 2, "2026-07-07")],
  }));
  assert("warmups ignored", warm.baseReps === 12 && warm.baseKg === 12);
}
```

- [ ] **Step 2: Run to verify failure**

Run: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `lib/coach/prescription/double-progression-rule.ts`:

```ts
// lib/coach/prescription/double-progression-rule.ts
//
// Double progression for ACCESSORY lifts: reps climb a loadability-derived
// range at fixed load; when every working set tops the range cleanly, load
// takes one equipment-grid step and reps reset to the range bottom. Stateless
// — the rung is re-derived every run from the 28-day set history (per-set RIR
// aware; null RIR degrades to reps-only, matching lastWeekClean's convention).
//
// Owns LOAD + REPS for accessories. Sets stay volume-balance-owned, EXCEPT
// deload_week where this rule's output is final: load HELD (isolation work
// carries little systemic fatigue and percentage cuts on small dumbbells
// round to meaningless loads; on a cut, retention wants intensity kept),
// sets halved. Primary/secondary deload rules are untouched.
//
// Spec: docs/superpowers/specs/2026-07-09-accessory-double-progression-design.md

import type { PlannedExercise } from "@/lib/coach/sessionPlans";
import type { BlockPhase, WorkoutSetSample } from "@/lib/coach/prescription/types";
import { roundToStep } from "@/lib/coach/prescription/calibrate-target";

export type Loadability = "fine" | "moderate" | "coarse";

/** Rep-range width above the bottom anchor. Coarser load jumps (DB pairs)
 *  need more rep-room to absorb one step. */
export const REP_RANGE_WIDTH: Record<Loadability, number> = {
  fine: 2,
  moderate: 3,
  coarse: 4,
};

export type DoubleProgressionInput = {
  baseExercise: PlannedExercise;
  /** maintenanceLoadFor(...) ?? baseKg ?? 0 — the current working load L. */
  currentWorkingKg: number;
  recentSets: WorkoutSetSample[];
  rirTarget: number;
  blockPhase: BlockPhase;
  loadability: Loadability;
  /** roundToStep(maintenance × 0.92) during a focus block, else null. */
  focusClampCeilingKg: number | null;
  /** Stable range anchor: static SESSION_PLANS baseReps when available. */
  bottomReps: number;
};

type SessionSets = { date: string; sets: WorkoutSetSample[] };

/** Non-warmup samples for the exercise, grouped per session date, newest first. */
function sessionsFor(recentSets: WorkoutSetSample[], name: string): SessionSets[] {
  const needle = name.trim().toLowerCase();
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
 *  was recorded — met the prescribed RIR. Null RIR degrades to reps-only. */
function isClean(s: WorkoutSetSample, repsThreshold: number, prescribedRir: number): boolean {
  if (s.failure) return false;
  if (s.reps < repsThreshold) return false;
  if (s.rir != null && s.rir < prescribedRir) return false;
  return true;
}

function topSet(sets: WorkoutSetSample[]): WorkoutSetSample {
  return [...sets].sort((a, b) => b.kg - a.kg || b.reps - a.reps)[0];
}

export function prescribeAccessoryDoubleProgression(
  input: DoubleProgressionInput,
): PlannedExercise {
  const { baseExercise: ex, currentWorkingKg: L, blockPhase } = input;
  const step = ex.increment?.step ?? 2.5;
  const bottom = input.bottomReps;
  const top = bottom + REP_RANGE_WIDTH[input.loadability];
  const prescribedRir = ex.rir ?? input.rirTarget;

  // Deload: hold load, halve sets. Caller skips volume-balance this week so
  // "deload = volume −50%" finally holds for accessories too.
  if (blockPhase === "deload_week") {
    return {
      ...ex,
      baseKg: L,
      baseReps: bottom,
      sets: Math.max(1, Math.ceil((ex.sets ?? 3) / 2)),
    };
  }

  const sessions = sessionsFor(input.recentSets, ex.name);
  const last = sessions[0] ?? null;
  if (!last) return { ...ex, baseKg: L, baseReps: bottom };

  const lastTop = topSet(last.sets);
  const loadFrozen = blockPhase === "consolidation" || blockPhase === "off_pace";

  // 1) Step up: ≥2 working sets at kg ≥ L, ALL clean at the range top.
  const setsAtL = last.sets.filter((s) => s.kg >= L);
  const allTopClean =
    setsAtL.length >= 2 && setsAtL.every((s) => isClean(s, top, prescribedRir));
  if (allTopClean && !loadFrozen) {
    const nextKg = roundToStep(L + step, step);
    if (input.focusClampCeilingKg != null && nextKg > input.focusClampCeilingKg) {
      // Park at the clamp: hold load, prescribe the range top.
      return { ...ex, baseKg: L, baseReps: top };
    }
    return { ...ex, baseKg: nextKg, baseReps: bottom };
  }

  // 2) Rep up (also how consolidation parks at the top): top set clean at the
  //    range bottom → +1 rep, capped at top. off_pace never progresses.
  if (blockPhase !== "off_pace" && isClean(lastTop, bottom, prescribedRir)) {
    return { ...ex, baseKg: L, baseReps: Math.min(top, lastTop.reps + 1) };
  }

  // 3) Step down: the last TWO sessions' top sets both dirty at the bottom —
  //    grid-native descent (never below one step); the climb restarts.
  const prev = sessions[1] ?? null;
  const prevDirty = prev != null && !isClean(topSet(prev.sets), bottom, prescribedRir);
  if (!loadFrozen && !isClean(lastTop, bottom, prescribedRir) && prevDirty) {
    return { ...ex, baseKg: Math.max(step, roundToStep(L - step, step)), baseReps: bottom };
  }

  // 4) Hold: one dirty session (or frozen load) — reps clamped into range.
  return { ...ex, baseKg: L, baseReps: Math.max(bottom, Math.min(top, lastTop.reps)) };
}
```

- [ ] **Step 4: Run fixtures to verify pass**

Run: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs`
Expected: PASS — 178 total (155 + 23).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add lib/coach/prescription/double-progression-rule.ts scripts/audit-prescription-rules.mjs
git commit -m "feat(engine): double-progression rule for accessories (pure)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Orchestrator integration

**Files:**
- Modify: `lib/coach/prescription/prescribe-week.ts` (accessory branch, ~lines 299-331, plus imports)

**Interfaces:**
- Consumes: `prescribeAccessoryDoubleProgression`, `Loadability` (Task 1); `resolveExercise` from `@/lib/coach/exercise-library` (returns `LibraryExercise | null` with a `loadability` field); `roundToStep` from `@/lib/coach/prescription/calibrate-target` (add the import if prescribe-week.ts doesn't already have it); existing `maintenanceLoadFor`, `SESSION_PLANS`, `FOCUS_BLOCK_CLAMP`, `classifyVolumeBandForMuscle`, `prescribeAccessoryFromVolumeBand`.
- Produces: behavior change only — accessory branch output. Primary/secondary branches untouched.

- [ ] **Step 1: Replace the accessory branch**

In `prescribeWeek`'s exercise loop, the current `} else { … }` accessory branch (the one calling `prescribeSecondaryAutoregulated` with `consecutiveRirMisses: 0` and then `prescribeAccessoryFromVolumeBand`) becomes:

```ts
      } else {
        // Accessory — double progression owns LOAD + REPS (rep range derived
        // from library loadability; rung re-derived from 28d history), while
        // volume-balance owns SETS — except deload_week, where the rule's
        // hold-load/half-sets output is final (see double-progression-rule.ts).
        const accessoryWorkingKg =
          maintenanceLoadFor(baseEx.name, rirTarget, recentSets, todayIso) ??
          baseEx.baseKg ?? 0;
        const lib = resolveExercise(baseEx.name);
        const staticEx = (SESSION_PLANS[sessionType] ?? []).find(
          (e) => !e.warmup && e.name === baseEx.name,
        );
        const step = baseEx.increment?.step ?? 2.5;
        const focusClampCeilingKg = isFocusBlock
          ? roundToStep(accessoryWorkingKg * FOCUS_BLOCK_CLAMP, step)
          : null;
        const dp = prescribeAccessoryDoubleProgression({
          baseExercise: baseEx,
          currentWorkingKg: accessoryWorkingKg,
          recentSets,
          rirTarget,
          blockPhase,
          loadability: lib?.loadability ?? "moderate",
          focusClampCeilingKg,
          bottomReps: staticEx?.baseReps ?? baseEx.baseReps ?? 8,
        });
        if (blockPhase === "deload_week") {
          exercises.push(dp);
        } else {
          const band: VolumeBandPosition = classifyVolumeBandForMuscle(baseEx, volumeContext);
          exercises.push(
            prescribeAccessoryFromVolumeBand({
              baseExercise: dp,
              currentSets: baseEx.sets ?? 3,
              bandPosition: band,
            }),
          );
        }
      }
```

Add imports at the top: `import { prescribeAccessoryDoubleProgression } from "@/lib/coach/prescription/double-progression-rule";`, `import { resolveExercise } from "@/lib/coach/exercise-library";`, and `roundToStep` from `@/lib/coach/prescription/calibrate-target` if not already imported. `prescribeSecondaryAutoregulated` stays imported (secondaries still use it).

- [ ] **Step 2: Verify the full audit + typecheck + vitest**

Run: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs && npm run typecheck && npx vitest run`
Expected: 178 passed (integration changes no pure-function fixtures), typecheck clean, vitest 460.

- [ ] **Step 3: Commit**

```bash
git add lib/coach/prescription/prescribe-week.ts
git commit -m "feat(engine): accessory branch uses double progression; deload holds load, halves sets

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Prose + housekeeping + full verification

**Files:**
- Modify: `lib/coach/prescription/maintenance-baseline.ts:1-24` (stale comments)
- Modify: `lib/coach/system-prompts.ts` (CARTER_BASE double-progression sentence, ~line 112)

**Interfaces:** none — prose only.

- [ ] **Step 1: Correct the stale maintenance-baseline comments**

The file header (lines ~5-7) claims "RPE/RIR signals are NOT tracked in this codebase's schema (exercise_sets has no rpe/rir columns)" and the JSDoc (lines ~22-24) repeats it. Both are stale — migration 0045 added `exercise_sets.rir` and `fetchRecentSets` selects it. Replace the header sentence with:

```
// without grinding to failure or treating it as warmup. Per-set RIR exists in
// the schema (migration 0045) and is consumed by the clean/dirty predicates in
// prescribe-week.ts and double-progression-rule.ts; this baseline deliberately
// stays reps+flags-only — it estimates working CAPACITY, not effort quality.
```

And the JSDoc paragraph (starting "The rirTarget parameter is accepted…") with:

```
 *  The rirTarget parameter is accepted for API symmetry with other rule
 *  modules but is not used in the filter — the baseline estimates working
 *  capacity from completed sets; effort-quality gating (per-set RIR) lives
 *  in the progression rules that consume this value. */
```

- [ ] **Step 2: Update CARTER_BASE's double-progression sentence**

In `lib/coach/system-prompts.ts` (~line 112), the sentence `If +4 kg total feels excessive for an isolation lift, prescribe rep progression (double progression) instead of a smaller kg jump.` becomes:

```
The engine implements double progression for accessories automatically — reps climb a range derived from the exercise's loadability (fine +2 / moderate +3 / coarse +4 over the base reps); topping the range cleanly earns one grid step and a reps reset. Narrate the rung from \`<this_weeks_prescription>\` (e.g. "you owned 14s at 12 kg — the engine steps you to 14 kg DBs and resets to 10s"); never author your own jump or rep target.
```

- [ ] **Step 3: Full verification suite**

```bash
npm run typecheck
npx vitest run
node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs
node scripts/audit-timezone-usage.mjs
npm run build
```

Expected: all PASS (audit 178). Then the live e2e (read-only): `AUDIT_USER_ID=94fee5c6-7d9a-4b05-be3a-8407505b5429 node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-sunday-prescription-e2e.mjs` — its on-grid assertions must stay green against the new accessory outputs (this checks stored rows, so it validates the pre-change week; the real gate is the fixture suite + build).

- [ ] **Step 4: Commit**

```bash
git add lib/coach/prescription/maintenance-baseline.ts lib/coach/system-prompts.ts
git commit -m "docs(engine): correct stale RIR comments; teach Carter engine-owned double progression

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
