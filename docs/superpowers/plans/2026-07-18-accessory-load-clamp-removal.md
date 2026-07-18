# Accessory Load-Clamp Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let accessory double progression complete its load step during focus blocks by removing the redundant 92% ceiling, so a perpetual-block athlete's accessories stop freezing.

**Architecture:** Delete the `focusClampCeilingKg` check from the double-progression step-up branch and remove its computation/plumbing in `prescribe-week.ts`. The existing block-phase gates (`consolidation`/`off_pace` `loadFrozen`, `deload_week` hold) already freeze accessory load when the focus lift needs recovery — so only `pre_target` weeks change behavior.

**Tech Stack:** TypeScript (strict), Next.js repo; pure-function rule modules under `lib/coach/prescription/`; fixture-based audit harness in `scripts/audit-prescription-rules.mjs` (Node, no DB).

## Global Constraints

- Engine stays stateless — every prescription re-derived from history each run; Carter never authors numbers.
- All loads land on the equipment grid via `nextUpKg` / `roundToStep`.
- `rir == null` history degrades to reps-only criteria (legacy imports).
- Primary + secondary rules stay byte-identical; volume-balance untouched. `FOCUS_BLOCK_CLAMP` constant stays (secondary path still uses it).
- Verify changes with `npm run typecheck` + `npx vitest run`; there is no working linter.
- Spec: [docs/superpowers/specs/2026-07-18-accessory-load-clamp-removal-design.md](../specs/2026-07-18-accessory-load-clamp-removal-design.md)

---

### Task 1: Remove the accessory load clamp

**Files:**
- Modify: `lib/coach/prescription/double-progression-rule.ts` (type `DoubleProgressionInput` ~L54-66; step-up branch ~L198-209)
- Modify: `lib/coach/prescription/prescribe-week.ts` (accessory branch ~L308-328)
- Test: `scripts/audit-prescription-rules.mjs` (DP section ~L920-941)

**Interfaces:**
- Consumes: `nextUpKg(L, increment)` (unchanged, same file), `prescribeAccessoryDoubleProgression(input)` (same file).
- Produces: `DoubleProgressionInput` **without** the `focusClampCeilingKg` field. Any caller passing it must be updated in this same task (only caller: `prescribe-week.ts`).

- [ ] **Step 1: Flip the audit test to expect an unclamped step-up**

In `scripts/audit-prescription-rules.mjs`, replace the "Clamp parks at top" block (currently ~L935-941):

```js
  // 2) Clamp parks at top instead of exceeding ceiling.
  const parked = prescribeAccessoryDoubleProgression(input({
    recentSets: [S(12, 14, 2, "2026-07-07"), S(12, 14, 2, "2026-07-07")],
    focusClampCeilingKg: 12,
  }));
  assert("clamp: load parked at L", parked.baseKg === 12);
  assert("clamp: reps parked at top", parked.baseReps === 14);
```

with (no clamp — the same clean-at-top history now steps up regardless of focus block):

```js
  // 2) No clamp: clean-at-top during a focus block steps load up (double
  //    progression completes; fatigue protection lives in the phase gates).
  const focusStepUp = prescribeAccessoryDoubleProgression(input({
    recentSets: [S(12, 14, 2, "2026-07-07"), S(12, 14, 2, "2026-07-07")],
  }));
  assert("focus block step up: load +step on grid", focusStepUp.baseKg === 14);
  assert("focus block step up: reps reset to bottom", focusStepUp.baseReps === 10);
```

Also remove the now-invalid `focusClampCeilingKg: null` key from the `input()` helper default (~L922) so the fixture matches the new type:

```js
  const input = (over = {}) => ({
    baseExercise: ex, currentWorkingKg: 12, recentSets: [], rirTarget: 2,
    blockPhase: "pre_target", loadability: "coarse",
    bottomReps: 10, ...over,
  });
```

- [ ] **Step 2: Run the audit to verify it fails**

Run: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs`
Expected: FAIL on `focus block step up: load +step on grid` — the clamp still forces `baseKg === 12` (parked), so the assert for `14` fails.

- [ ] **Step 3: Remove the clamp branch from the rule**

In `lib/coach/prescription/double-progression-rule.ts`, the step-up branch (~L202-209):

```ts
  if (allTopClean && !loadFrozen) {
    const nextKg = nextUpKg(effL, ex.increment);
    if (input.focusClampCeilingKg != null && nextKg > input.focusClampCeilingKg) {
      // Park at the clamp: hold load, prescribe the range top.
      return { ...ex, baseKg: effL, baseReps: top };
    }
    return { ...ex, baseKg: nextKg, baseReps: bottom };
  }
```

becomes:

```ts
  if (allTopClean && !loadFrozen) {
    return { ...ex, baseKg: nextUpKg(effL, ex.increment), baseReps: bottom };
  }
```

- [ ] **Step 4: Remove the field from `DoubleProgressionInput`**

Same file, ~L62-63 — delete these two lines:

```ts
  /** roundToStep(maintenance × 0.92) during a focus block, else null. */
  focusClampCeilingKg: number | null;
```

- [ ] **Step 5: Update the module header comment**

Same file, the header block (~L32-36) documents accessory ownership. Update the sentence describing the focus-block clamp so it no longer claims a ceiling. Change the "Owns LOAD + REPS for accessories" paragraph to note the phase gates are the only focus-block protection. Replace:

```ts
// Owns LOAD + REPS for accessories. Sets stay volume-balance-owned, EXCEPT
// deload_week where this rule's output is final: load HELD (isolation work
```

with:

```ts
// Owns LOAD + REPS for accessories. During a focus block, load progression is
// gated ONLY by block phase (consolidation/off_pace freeze load; deload holds)
// — no separate below-baseline ceiling; pre_target lets the ladder step. Sets
// stay volume-balance-owned, EXCEPT deload_week where this rule's output is
// final: load HELD (isolation work
```

- [ ] **Step 6: Remove the ceiling computation in `prescribe-week.ts`**

In `lib/coach/prescription/prescribe-week.ts`, the accessory branch (~L311-328). Remove the `step` local and the `focusClampCeilingKg` computation, and drop the argument. Current:

```ts
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
```

becomes:

```ts
        const lib = resolveExercise(baseEx.name);
        const staticEx = (SESSION_PLANS[sessionType] ?? []).find(
          (e) => !e.warmup && e.name === baseEx.name,
        );
        const dp = prescribeAccessoryDoubleProgression({
          baseExercise: baseEx,
          currentWorkingKg: accessoryWorkingKg,
          recentSets,
          rirTarget,
          blockPhase,
          loadability: lib?.loadability ?? "moderate",
          bottomReps: staticEx?.baseReps ?? baseEx.baseReps ?? 8,
        });
```

Note: `FOCUS_BLOCK_CLAMP` (L47) and `roundToStep` stay imported — both still used by the secondary path (`focusBlockClampMultiplier`, ~L296) and elsewhere. Do not remove them. After editing, confirm `roundToStep` still has at least one use in this file (secondary/primary branches); if `tsc` reports it unused, that means another edit was too aggressive — revert to the block above.

- [ ] **Step 7: Run the audit to verify it passes**

Run: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs`
Expected: PASS — all assertions green, including the new `focus block step up: load +step on grid` / `reps reset to bottom`, and the untouched consolidation/off_pace/deload/step-down assertions.

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck`
Expected: PASS, no errors. (Confirms the `DoubleProgressionInput` field removal has no other TS consumer and no unused-local error from the removed `step`.)

- [ ] **Step 9: Unit tests + build**

Run: `npx vitest run`
Expected: PASS.

Run: `npm run build`
Expected: build succeeds (guards against a React/prod-only regression per repo convention).

- [ ] **Step 10: Commit**

```bash
git add lib/coach/prescription/double-progression-rule.ts lib/coach/prescription/prescribe-week.ts scripts/audit-prescription-rules.mjs
git commit -m "feat(prescription): remove redundant accessory load clamp in focus blocks

The 92% ceiling sat below current working weight, so accessory step-ups
always parked while a block was active — permanent freeze for a perpetual-
block rotation. Phase gates (consolidation/off_pace/deload) already protect
the focus lift; the clamp was redundant. pre_target now lets the double-
progression ladder step load. Secondary clamp untouched.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Live end-to-end audit against real data

**Files:**
- Run-only: `scripts/audit-sunday-prescription-e2e.mjs` (no edits)

**Interfaces:**
- Consumes: the committed rule change from Task 1.
- Produces: confirmation that real prescriptions stay on-grid with the new accessory outputs.

- [ ] **Step 1: Run the E2E audit**

Run: `AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-sunday-prescription-e2e.mjs`

(Use the athlete's user id. If the id isn't known in-session, ask the user for it before running.)

Expected: PASS — specifically the "on-grid weights" assertions stay green; no pattern-conflict or `target_hit_at_week` regressions. Any accessory that previously parked and is now eligible should show an on-grid stepped load, not an off-grid value.

- [ ] **Step 2: Record the result**

If PASS: note it in the PR description. No code change.
If FAIL on an off-grid accessory load: stop — that indicates `nextUpKg` produced an off-grid value for some exercise's `increment`; capture the exercise name + load and treat as a bug in the increment config, not a reason to restore the clamp.

---

## Self-Review

**1. Spec coverage:**
- Change 1 (remove ceiling check in step-up branch) → Task 1 Steps 3-5. ✓
- Change 2 (stop computing/passing ceiling in prescribe-week) → Task 1 Step 6. ✓
- `FOCUS_BLOCK_CLAMP` constant retained for secondaries → Task 1 Step 6 note. ✓
- Out-of-scope secondaries untouched → no task modifies the secondary branch. ✓
- Testing: audit assertion swap → Steps 1-2, 7; typecheck/vitest/build → Steps 8-9; live E2E → Task 2. ✓
- Behavior table (only pre_target changes) → encoded by leaving `loadFrozen`/`deload_week`/`off_pace` branches untouched. ✓
- Operational watch (focus-lift e1RM trend) → no code; belongs in PR description, noted in Task 2 Step 2. ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows exact before/after. `<uuid>` in Task 2 is a genuine runtime input with an explicit fallback instruction. ✓

**3. Type consistency:** `focusClampCeilingKg` removed from the type (Step 4) and its only TS caller (Step 6) in the same task/commit, so the build never sees a mismatch. `prescribeAccessoryDoubleProgression` and `nextUpKg` names match the source. ✓
