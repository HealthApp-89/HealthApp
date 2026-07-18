# Accessory load-clamp removal — let double progression complete during focus blocks

**Date:** 2026-07-18
**Status:** Design — awaiting review
**Area:** `lib/coach/prescription/` (accessory progression)

## Problem

Accessory lifts (e.g. Leg Press) can never add load while a focus block is
active. The athlete rotates 4 focus blocks non-stop, so a focus block is
*always* active (`isFocusBlock === true` every week). The net effect: each
accessory ratchets its reps to the top of its range once, then freezes — load
can't step, reps are maxed — indefinitely.

### Root cause

In [prescribe-week.ts](../../../lib/coach/prescription/prescribe-week.ts) the
accessory branch computes a ceiling and passes it to the double-progression rule:

```
focusClampCeilingKg = roundToStep(accessoryWorkingKg × 0.92, step)   // when isFocusBlock
```

`accessoryWorkingKg` is the athlete's **current** working weight
(`maintenanceLoadFor` = max kg across recent clean sets). So the ceiling always
lands ~8% **below** where the athlete already works. The step-up branch in
[double-progression-rule.ts](../../../lib/coach/prescription/double-progression-rule.ts)
proposes `nextUp = currentWorkingWeight + step` and parks if `nextUp > ceiling`.
Since `nextUp > currentWorkingWeight > 0.92 × currentWorkingWeight` is always
true, **the step-up parks 100% of the time during a focus block.** Load
progression on accessories is mathematically impossible whenever a block is
active.

The clamp assumed focus blocks alternate with non-focus stretches during which
accessories "catch up" on load. A perpetual-block rotation never provides that
gap.

### Why the clamp is redundant, not load-bearing

The double-progression rule already has block-phase gates that freeze accessory
load exactly when the focus lift needs recovery priority:

- `deload_week` ([line 162](../../../lib/coach/prescription/double-progression-rule.ts#L162)) — load held, sets halved.
- `consolidation` / `off_pace` (`loadFrozen`, [line 176](../../../lib/coach/prescription/double-progression-rule.ts#L176)) — no step-up; `off_pace` also blocks rep-up.

So the 92% ceiling does nothing new in three of the four phases. It only bites
in **`pre_target`** — the phase where the athlete is progressing well and has
the most recovery headroom, i.e. exactly when blocking an *earned* load step is
least justified.

## Research basis (safety)

The fix is to let double progression complete its load step for accessories.
Evidence this is safe and standard:

1. **Double progression run to completion is the textbook accessory model.**
   Strength-coaching consensus treats reps-then-load double progression as the
   recommended accessory progression scheme; the current engine implements only
   the reps half, which is a *partial* double progression. Completing it moves
   toward the standard.
2. **Fatigue management acts on volume, not load steps.** Accessory
   fatigue-management guidance is uniformly about controlling *set count /
   volume*. In this engine accessory **sets are owned by volume-balance**,
   independently. A load step-up holds sets and reps constant and adds one grid
   step (~2–5 kg) — negligible systemic-fatigue cost relative to adding volume.
   The clamp throttles the low-cost axis while the high-cost axis is governed
   elsewhere.
3. **The step-up trigger is already autoregulated.** A step fires only when
   ≥2 working sets are at load AND **every** working set is clean at the top of
   the rep range with RIR on target — a demonstrated-capacity, proximity-to-
   failure gate. RIR-based autoregulation matches standardized loading for
   strength in trained lifters. Removing the 92% ceiling removes an arbitrary
   cap, not the earned-it gate.

Sources reviewed during brainstorming: Plotkin et al. 2022 (load vs. rep
progression — equivalent hypertrophy); autoregulation meta-analysis
(PMC8762534); accessory-programming coaching literature (fatigue = volume).

## Design

### Change 1 — remove the ceiling check from the step-up branch

[double-progression-rule.ts](../../../lib/coach/prescription/double-progression-rule.ts),
step-up branch (~line 202):

```
// before
if (allTopClean && !loadFrozen) {
  const nextKg = nextUpKg(effL, ex.increment);
  if (input.focusClampCeilingKg != null && nextKg > input.focusClampCeilingKg) {
    return { ...ex, baseKg: effL, baseReps: top };   // park
  }
  return { ...ex, baseKg: nextKg, baseReps: bottom };
}

// after
if (allTopClean && !loadFrozen) {
  return { ...ex, baseKg: nextUpKg(effL, ex.increment), baseReps: bottom };
}
```

Remove `focusClampCeilingKg` from `DoubleProgressionInput` and delete the
now-dead parking branch. The phase gates (`loadFrozen`, `deload_week`,
`off_pace` rep-up block) are untouched and continue to protect the focus lift in
consolidation / off_pace / deload.

### Change 2 — stop computing/passing the ceiling for accessories

[prescribe-week.ts](../../../lib/coach/prescription/prescribe-week.ts), accessory
branch (~lines 315–328): delete the `focusClampCeilingKg` computation and the
argument to `prescribeAccessoryDoubleProgression`. `FOCUS_BLOCK_CLAMP` the
constant **stays** — it is still consumed by the secondary path
(`focusBlockClampMultiplier`, line 296).

### Out of scope (deliberate)

- **Secondaries** (non-focus big-four lifts) keep their `focusBlockClampMultiplier`
  clamp. Unlike accessories, each big-four lift becomes *the* focus lift 1 block
  in 4, so its load-progression phase arrives on rotation — the clamp is not
  permanent for them. No change.
- **e1RM / volume progress metrics** — unrelated; not touched.
- No new throttle, cadence limiter, or catch-up week. The existing phase gates
  make an accessory-specific cap unnecessary.

## Behavior after the change

Per phase, for an accessory that has cleaned out its rep range:

| Phase | Before | After |
|---|---|---|
| `pre_target` | park at current load, reps at top | **step load +1 grid, reps reset to bottom** |
| `consolidation` | park (via clamp) | hold load, rep-up allowed (via `loadFrozen`) — unchanged outcome |
| `off_pace` | park | hold load + reps (via gates) — unchanged |
| `deload_week` | hold load, half sets | hold load, half sets — unchanged |

Only `pre_target` changes. Example: Leg Press stuck at 140 kg × 16 (range top,
all clean) → next `pre_target` week prescribes 145 kg × 12.

## Testing

- **[scripts/audit-prescription-rules.mjs](../../../scripts/audit-prescription-rules.mjs)**:
  - Replace the "clamp: load parked at L" assertion (~lines 938–941) with:
    *pre_target + clean-at-top + (no clamp) → steps to `nextUpKg`, reps reset to bottom.*
  - Keep and verify green: consolidation rep-up-only, off_pace hold, deload
    hold-load/half-sets, step-down after two dirty-strained sessions, grid
    rounding. None of these depend on the removed ceiling.
- `npm run typecheck` — `DoubleProgressionInput` no longer has
  `focusClampCeilingKg`; confirm no other caller references it.
- `npx vitest run`.
- `npm run build`.
- Live `AUDIT_USER_ID=<uuid> … scripts/audit-sunday-prescription-e2e.mjs` — the
  "on-grid weights" assertions must stay green with the new accessory outputs.

## Operational watch (no code)

Because this is the athlete's first unfreeze of accessory load under a perpetual-
block rotation, watch the focus-lift e1RM trend for the weeks after ship. The
weekly review §4 and `audit-coach-trends` already surface per-lift e1RM slope. A
focus-lift trend dip concurrent with accessory load climbing is the signal that
accessory load competed for recovery — the throttle would then be reintroduced
(likely a green-RIR cadence gate, not the flawed below-current ceiling).

## Invariants preserved

- Engine stays stateless (weekly recompute from history); Carter never authors numbers.
- Secondary + primary rules byte-identical; volume-balance untouched.
- All loads on the equipment grid (`nextUpKg` / `roundToStep`).
- `rir == null` history still degrades to reps-only criteria.
- Phase discipline intact: consolidation / off_pace / deload still freeze accessory load.
