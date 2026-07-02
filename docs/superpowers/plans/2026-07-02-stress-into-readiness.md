# Stress into the Readiness Composite — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Garmin all-day Stress as a modest, independent term in `deriveReadiness`, yesterday-sourced, excluded from the red-recovery floor.

**Architecture:** One new term in the single readiness source (`lib/ui/score.ts`), fed from yesterday's `stress_avg` at both existing blend sites (dashboard ring + morning brief), plus a display segment in the qualitative impact breakdown.

**Tech Stack:** TypeScript (strict), Next.js 15, existing `scoreFromAnchors` weighted-mean composite.

## Global Constraints

- `deriveReadiness` ([lib/ui/score.ts](../../../lib/ui/score.ts)) is the ONE readiness computation; the dashboard ring and morning brief both call it. Do not fork it.
- Stress is added via the plain `add()` path, **NOT** `addRecovery()` — it must NOT enter `recoverySubScore` and therefore must NOT be able to trigger the red-recovery floor. The floor stays HRV/sleep/RHR only.
- Exact values (verbatim): `const W_STRESS = 0.75;` and `const A_STRESS: Anchors = [[20, 95], [35, 78], [50, 55], [65, 32], [80, 12]];`.
- Stress is yesterday-sourced (an all-day metric, absent from the overnight today-pass). At each blend site, add an EXPLICIT `stress_avg: <yesterday>?.stress_avg ?? null` override (the `...today` spread otherwise wins with today's null).
- Absent `stress_avg` must renormalize out — identical score to pre-change. Do not change `MIN_WEIGHT_FOR_SCORE`.
- No test suite in this repo. Verify with `npm run typecheck` + `npm run build` + `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-readiness-score.mjs`.
- User-visible numbers use `fmtNum()`.
- Commit after each task. Branch `feat/stress-into-readiness` (created; spec committed).

---

## Task 1: Stress term in `deriveReadiness` + audit fixtures

**Files:**
- Modify: [lib/ui/score.ts](../../../lib/ui/score.ts)
- Modify: [scripts/audit-readiness-score.mjs](../../../scripts/audit-readiness-score.mjs)

**Interfaces:**
- Produces: `deriveReadiness` honors `log.stress_avg` (0–100, lower=calmer). `ReadinessInputs.log` Pick gains `"stress_avg"`. Task 2 feeds this field.

- [ ] **Step 1: Add the anchor set**

In `lib/ui/score.ts`, after the `A_CALORIES_DELTA` anchor (line ~51), add:
```ts
// Stress is descending-by-score: calm (low) rewards, high stress penalizes.
// Aligned to Garmin's bands (≤25 rest, 26–50 low, 51–75 medium, 76–100 high).
const A_STRESS: Anchors = [[20, 95], [35, 78], [50, 55], [65, 32], [80, 12]];
```

- [ ] **Step 2: Add the weight**

After `const W_STEPS = 0.25;` (line ~64), add:
```ts
const W_STRESS = 0.75; // ~5% of the composite; recovery stays dominant (~61%)
```

- [ ] **Step 3: Add `stress_avg` to the input type**

In the `ReadinessInputs.log` `Pick<DailyLog, …>` union (starts line ~68), add `| "stress_avg"` alongside the other columns (e.g. after `"steps"`).

- [ ] **Step 4: Add the term to the composite body**

In `deriveReadiness`, inside the `if (log) { … }` block, after the steps line (`if (log.steps != null) add(scoreFromAnchors(log.steps, A_STEPS), W_STEPS);`), add:
```ts
    if (log.stress_avg != null) add(scoreFromAnchors(log.stress_avg, A_STRESS), W_STRESS);
```
Use `add` (NOT `addRecovery`) — stress must not enter `recoverySubScore`.

- [ ] **Step 5: Add audit fixtures**

In `scripts/audit-readiness-score.mjs`, follow the file's existing assertion pattern to add cases proving:
1. **calm stress lifts:** a day with `stress_avg: 25` scores HIGHER than the identical day with `stress_avg` omitted/null.
2. **high stress drags:** the same day with `stress_avg: 75` scores LOWER than the stress-absent baseline.
3. **absent renormalizes:** `stress_avg: null` yields the SAME score as pre-change (identical to omitting the field).
4. **floor untouched:** a red-recovery day (recoverySubScore <25 → band "low") stays band "low" even with `stress_avg: 20` (calm); and `recoverySubScore` is byte-identical with vs. without `stress_avg` set (stress never enters the recovery sub-score).

Reuse the existing baseline log fixture the file already defines; only vary `stress_avg`.

- [ ] **Step 6: Verify**

Run:
```bash
npm run typecheck
node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-readiness-score.mjs
```
Expected: typecheck clean; audit prints all-pass including the 4 new stress assertions and the pre-existing 22.

- [ ] **Step 7: Commit**

```bash
git add lib/ui/score.ts scripts/audit-readiness-score.mjs
git commit -m "feat(readiness): add Stress as a modest composite term (not in red floor)"
```

---

## Task 2: Feed yesterday's `stress_avg` at both blend sites

**Files:**
- Modify: [lib/morning/brief/assembler.ts](../../../lib/morning/brief/assembler.ts) (`readinessLog`, ~line 203)
- Modify: [components/dashboard/TodayClient.tsx](../../../components/dashboard/TodayClient.tsx) (`scoreLog` + `fellBackToPrior`, ~line 102)

**Interfaces:**
- Consumes: `deriveReadiness`'s `log.stress_avg` support from Task 1.

- [ ] **Step 1: Brief blend — `readinessLog`**

In `readinessLog` ([assembler.ts:207-213](../../../lib/morning/brief/assembler.ts)), add `stress_avg` to the yesterday-sourced overrides:
```ts
  return {
    ...t,
    steps: y?.steps ?? null,
    calories_eaten: y?.calories_eaten ?? null,
    protein_g: y?.protein_g ?? null,
    carbs_g: y?.carbs_g ?? null,
    stress_avg: y?.stress_avg ?? null,
  };
```

- [ ] **Step 2: Ring blend — `scoreLog`**

In `TodayClient.tsx` `scoreLog` (the `selectedLog ? { …spread + prevLog overrides } : null` at ~line 102), add:
```ts
        stress_avg: prevLog?.stress_avg ?? null,
```
alongside the existing `steps/strain/calories_eaten/protein_g/carbs_g` overrides.

- [ ] **Step 3: Ring — mark stress as yesterday-sourced for the impact chip**

In the `fellBackToPrior` block just below (`if (prevLog) { … }`, ~line 114), add:
```ts
    if (prevLog.stress_avg != null) fellBackToPrior.add("stress");
```
(This makes the impact chip read "yest. —" once Task 3 adds the `stress` segment. Harmless if Task 3 is skipped — the set entry is just unused.)

- [ ] **Step 4: Verify**

Run:
```bash
npm run typecheck && npm run build
```
Expected: clean. Manual (optional): on `/` the ring reflects a stress change on yesterday's row; the score shifts modestly.

- [ ] **Step 5: Commit**

```bash
git add lib/morning/brief/assembler.ts components/dashboard/TodayClient.tsx
git commit -m "feat(readiness): feed yesterday's stress_avg into ring + brief blends"
```

---

## Task 3: Stress segment in the impact breakdown (visibility)

**Files:**
- Modify: [lib/coach/impact.ts](../../../lib/coach/impact.ts)

**Interfaces:**
- Consumes: nothing from prior tasks (impact.ts is a standalone qualitative classifier — it does not need to sum to the score). Independent of Tasks 1–2's correctness.

- [ ] **Step 1: Add `"stress"` to the `ImpactKey` union + label + colors**

In `impact.ts`: add `| "stress"` to `ImpactKey`; add `stress: "Stress"` to `LABELS`; add `stress: "#30d158"` (calm-positive uses the recovery-green family) to `COLOR_POSITIVE`.

- [ ] **Step 2: Add `classifyStress`**

Following the existing `classifyHRV`/`classifyRHR` pattern (neutralSegment for null; sign + magnitude + reason otherwise), add:
```ts
function classifyStress(v: number | null): ImpactSegment {
  if (v === null) return neutralSegment("stress", "no data");
  if (v <= 33) {
    return { key: "stress", label: LABELS.stress, sign: "positive",
      magnitude: clamp((33 - v) / 33, 0.3, 1), color: COLOR_POSITIVE.stress,
      value: v, reason: "calm yesterday" };
  }
  if (v > 60) {
    return { key: "stress", label: LABELS.stress, sign: "negative",
      magnitude: clamp((v - 60) / 40, 0.3, 1), color: COLOR_NEGATIVE,
      value: v, reason: "elevated yesterday" };
  }
  return { key: "stress", label: LABELS.stress, sign: "neutral",
    magnitude: 0, color: COLOR_NEUTRAL, value: v, reason: "moderate" };
}
```

- [ ] **Step 3: Wire it into `computeImpact`**

In the `computeImpact` function, where the other segments are assembled into the `segments` array, add `classifyStress(log.stress_avg ?? null)` in the same manner as the existing metric segments (e.g. after the strain/steps segment). Match whatever push/array-literal style the function already uses; keep the `positiveCount`/`negativeCount`/`net` accounting consistent (it should already derive from the assembled segments — if it iterates the array, no extra work; if it hand-counts, include the new segment).

- [ ] **Step 4: Verify**

Run:
```bash
npm run typecheck && npm run build
```
Expected: clean. The impact breakdown now carries a Stress segment (positive when calm, negative when elevated), labeled "yest. —" via Task 2's `fellBackToPrior`.

- [ ] **Step 5: Commit**

```bash
git add lib/coach/impact.ts
git commit -m "feat(readiness): surface Stress in the impact breakdown"
```

---

## Self-Review notes

- **Spec coverage:** term+anchors+weight+floor-exclusion (Task 1), yesterday-sourcing at both blends (Task 2), impact visibility (Task 3), audit fixtures (Task 1 Step 5). All spec sections mapped.
- **Type consistency:** `W_STRESS`/`A_STRESS` used only in `score.ts`; `stress_avg` is an existing `DailyLog` column (Garmin cutover) so no type additions beyond the `ReadinessInputs.log` Pick. `"stress"` `ImpactKey` consistent across union/LABELS/COLOR_POSITIVE/classifyStress/computeImpact.
- **Floor safety:** the single most important invariant — stress via `add()` not `addRecovery()` — is asserted directly in Task 1 fixture #4.
