# Accessory Double Progression — Design

**Date:** 2026-07-09
**Status:** Approved (deload prescription amended per athlete review: accessories hold load, halve sets)
**Arc:** Structural gaps, sub-project 1 (accessory progression)

## Problem

Accessories (everything that isn't a big-four lift) have no workable progression path in the deterministic engine:

- Load progression is binary — `prescribeSecondaryAutoregulated` gives +1 equipment step on a clean top set, else hold ([lib/coach/prescription/autoregulation-rule.ts:41-56](../../../lib/coach/prescription/autoregulation-rule.ts)). For isolation work the step is proportionally huge (lateral raise at 12 kg DBs: +2 kg/DB = +17%), so the clean check rarely passes and the load freezes indefinitely.
- Reps are a pass-through scalar — autoregulation returns `baseReps` untouched; no structure anywhere carries a rep range. The only "double progression" in the codebase is prose in CARTER_BASE ([system-prompts.ts:112](../../../lib/coach/system-prompts.ts)) and a glossary card.
- The miss-descent path is dead for accessories — the orchestrator hard-codes `consecutiveRirMisses: 0` ([prescribe-week.ts:313](../../../lib/coach/prescription/prescribe-week.ts)), so the −10% branch never fires.
- **Discovered bug:** during `deload_week`, accessory sets are NOT halved. Autoregulation's deload `setsOverride` is clobbered because `prescribeAccessoryFromVolumeBand` is called with the library baseline (`currentSets: baseEx.sets ?? 3`, [prescribe-week.ts:322-330](../../../lib/coach/prescription/prescribe-week.ts)) — volume-balance owns accessory sets even in deload, violating the documented "Week 5: volume −50%".

## Goals

- Accessories progress via classic double progression: reps climb within a range at fixed load; when the range tops out cleanly, load takes one grid step and reps reset.
- All state derived from existing 28-day workout history (`fetchRecentSets`, which now carries per-set `rir`) — no schema change, no stored progression state, no UI change (every surface renders a scalar rep target; the weekly number simply starts moving).
- Grid-native descent replaces the dead −10% path.
- Deload week becomes true for the whole session — with the load/sets levers split correctly per exercise class (see §Deload).

## Non-goals

- Secondaries (non-focus big-four lifts) keep `prescribeSecondaryAutoregulated` unchanged — barbell steps are proportionally small; the maintenance-clamp design is deliberate.
- No curated per-exercise rep ranges (the library's existing `loadability` field encodes the need — see §Range width).
- No changes to volume-balance band logic outside the deload skip.
- No changes to the primary-lift block-phase rules.

## Design

### 1. New rule module: `lib/coach/prescription/double-progression-rule.ts`

Pure function, replacing `prescribeSecondaryAutoregulated` in the orchestrator's **accessory branch only**:

```
prescribeAccessoryDoubleProgression(opts: {
  baseExercise: PlannedExercise;      // name, baseReps, sets, rir?, increment?
  currentWorkingKg: number;           // maintenanceLoadFor(...) ?? baseKg ?? 0
  recentSets: WorkoutSetSample[];     // 28d window, has rir
  rirTarget: number;                  // week default (ex.rir ?? rirTarget = prescribed RIR)
  blockPhase: BlockPhase;
  loadability: "fine" | "moderate" | "coarse";  // resolved from the exercise library; default "moderate" when unmapped
  focusClampCeilingKg: number | null; // roundToStep(maintenance × 0.92) in focus blocks, else null
}): PlannedExercise
```

The `consecutiveRirMisses: 0` hack disappears with the autoreg call.

### 2. Rep range (derived, not stored)

- `bottom`: when the exercise exists in `SESSION_PLANS[sessionType]`, use the STATIC plan's `baseReps` (stable anchor — discovery's median drifts upward as achieved reps climb, which would inflate the whole range); otherwise `baseExercise.baseReps ?? 8`.
- `top = bottom + WIDTH[loadability]` where `WIDTH = { fine: 2, moderate: 3, coarse: 4 }` — coarser load jumps need more rep-room to absorb a step. `loadability` already exists on all 62 library entries; unmapped exercises default `moderate`.

### 3. The ladder (evaluated per exercise from `recentSets`)

Let `L = currentWorkingKg`, `lastSession` = most recent date with non-warmup sets for this exercise, `prescribedRir = ex.rir ?? rirTarget`. A set is *clean* iff `!failure && reps ≥ threshold && (rir == null || rir ≥ prescribedRir)` — same null-RIR fallback convention as `lastWeekClean`.

1. **Step up:** last session has ≥2 non-warmup sets at `kg ≥ L`, and EVERY such set is clean at `threshold = top` → `nextKg = roundToStep(L + step)`, `nextReps = bottom`.
   - Focus-clamp interaction: if `nextKg > focusClampCeilingKg`, hold `L` and prescribe `top` reps (progression parks at the ceiling instead of exceeding the clamp).
2. **Rep up:** else if the top set of `lastSession` is clean at `threshold = bottom` (i.e. `!failure`, `reps ≥ bottom`, RIR criterion met) → `nextKg = L`, `nextReps = min(top, topSetReps + 1)`. Anchored to ACHIEVED reps, not a remembered prescription — the engine is stateless, so the rung is always re-derived from what was actually lifted.
3. **Step down:** else if the top sets of the last TWO distinct sessions both failed `threshold = bottom` (dirty at even the range floor) → `nextKg = max(step, roundToStep(L − step))`, `nextReps = bottom`. Grid-native descent; the climb restarts, so no step-up/step-down oscillation.
4. **Hold:** else (exactly one dirty session so far, or no history) → `nextKg = L`, `nextReps = clamp(bottom, top, topSetReps)` when a last session exists, else `bottom`.

Sets remain volume-balance-owned (unchanged call order: double-progression output feeds `prescribeAccessoryFromVolumeBand`), except during deload.

### 4. Phase gates (mirror the primary's discipline)

- `pre_target` → full ladder.
- `consolidation` → load frozen at `L`; rep-up path still allowed (mirrors "hold load, progress reps").
- `off_pace` → hold both.
- `deload_week` → see below; ladder not applied.

### 5. Deload — corrected prescription (amended after athlete review)

Deloads dissipate *systemic* fatigue, which lives in the heavy compounds; isolation work generates little of it, and on a GLP-1 cut the athlete's dominant risk is muscle loss, which wants intensity retained. Percentage cuts on small dumbbells also round to meaningless loads (0.8 × 12 kg → 10 kg). Therefore:

| Class | Load | Sets |
|---|---|---|
| Primary + secondaries | 0.80× (unchanged, existing rules) | halved, floor 2 (unchanged) |
| **Accessories** | **HELD at working weight** (change: today they get 0.80×) | **halved: `max(1, ceil(baseSets / 2))`** (bug fix: today they keep full volume-balanced sets) |

Implementation: in `deload_week` the accessory branch bypasses both the ladder and `prescribeAccessoryFromVolumeBand`; the rule returns `{ ...ex, baseKg: L, baseReps: bottom, sets: max(1, ceil((baseEx.sets ?? 3) / 2)) }`.

### 6. Orchestrator integration ([prescribe-week.ts](../../../lib/coach/prescription/prescribe-week.ts) accessory branch, ~lines 299-331)

- Resolve `loadability` via the exercise library (`resolveExercise`/library lookup by name; default `moderate`).
- Call the new rule instead of `prescribeSecondaryAutoregulated`; keep `maintenanceLoadFor(...) ?? baseEx.baseKg ?? 0` as `currentWorkingKg`; compute `focusClampCeilingKg` exactly as the clamp does today (`roundToStep(accessoryWorkingKg × FOCUS_BLOCK_CLAMP, step)` when `isFocusBlock`).
- `deload_week` → skip volume-balance for accessories (rule output is final).

### 7. Prose + housekeeping

- CARTER_BASE's double-progression sentence updated: the engine now implements it for accessories; Carter narrates the rung ("you topped the range at 12 reps clean — engine steps you to 14 kg DBs and resets to 10s"), never authors it.
- [maintenance-baseline.ts](../../../lib/coach/prescription/maintenance-baseline.ts) header comment corrected (it still claims `exercise_sets` has no RIR column; migration 0045 added it).

### 8. Testing

Fixtures in [scripts/audit-prescription-rules.mjs](../../../scripts/audit-prescription-rules.mjs) (house style, no DB): each ladder rung (step-up on all-sets-clean-at-top, rep-up on clean top set, step-down after two dirty-at-bottom sessions, hold), width per loadability + unmapped default, null-RIR fallback paths, focus-clamp parking at ceiling, phase gates (consolidation rep-up-only, off_pace hold, deload accessory hold-load/half-sets), grid rounding incl. `pairedDb` steps and machine micro-pins, descent floor (never below one step). Plus `typecheck`, `vitest`, `build`, and a live `audit-sunday-prescription-e2e.mjs` pass — note its "on-grid weights" assertions must stay green with the new outputs.

## Invariants preserved

- Engine remains stateless (weekly recompute from history); Carter never authors numbers.
- Primary/secondary rules byte-identical; volume-balance untouched outside the deload skip.
- All loads on the equipment grid (`roundToStep`, per-DB vs total semantics unchanged).
- `rir == null` history degrades to reps-only criteria (legacy imports, skipped entries).
