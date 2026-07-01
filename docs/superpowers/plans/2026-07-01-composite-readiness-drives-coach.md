# Composite Readiness Drives the Coach — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one recovery-dominant composite readiness number drive the dashboard ring, the morning brief headline, the readiness band, the coach-suggestion chip, and the AI advice — so the coach acts on WHOOP HRV/RHR/sleep instead of the athlete's raw self-report.

**Architecture:** Extend the existing pure `calcReadinessScore` in `lib/ui/score.ts` into a single `deriveReadiness()` that returns `{ score, recoverySubScore, feel, band }` with re-tuned weights (Recovery ~64% / Feel ~25% / Lifestyle ~11%) and a red-recovery floor. Both the dashboard (`TodayClient.tsx`) and the brief (`assembler.ts`) call it, deleting the brief's separate feel-based `deriveReadinessBand`. No schema changes — everything is derived at read time.

**Tech Stack:** Next.js 15 (App Router), TypeScript (strict), React. No test runner is wired (`npm run test` does not exist); pure-function verification follows the repo convention of a fixture-based audit script (`scripts/audit-*.mjs`) run via the alias-loader, mirroring `scripts/audit-prescription-rules.mjs`.

## Global Constraints

- Number display: max 2 decimals, trailing zeros trimmed — always via `fmtNum()` from `lib/ui/score.ts`. Never raw `.toFixed()`.
- No new DB columns, no migration. All readiness values derived at read time.
- WHOOP's own `recovery %` field stays OUT of the composite formula (it double-counts HRV/RHR/sleep). It remains a displayed metric only.
- Weights are code constants — no per-user tuning UI.
- Verify every task with `npm run typecheck` (there is no lint). Pure-function tasks also run the audit script.
- Recovery-dominant weighting (locked): HRV 3, RHR 3, sleep score 2, deep sleep 1, morning feel 3.5, protein 0.5, calories 0.5, carbs 0.25, steps 0.25.
- Band cutoffs (locked): composite ≥ 67 → high; 45–66 → moderate; < 45 → low.
- Red-recovery floor (locked): recovery sub-score < 25 → band forced to low; < 40 → band cannot be high (capped moderate).
- Recovery-required rule (locked): if no recovery signal (HRV, RHR, or sleep score) is present, the composite is `null` and the brief shows a "pending sync" state — never a feel-only readiness number.

---

### Task 1: `deriveReadiness` core + re-tuned weights (pure)

**Files:**
- Modify: `lib/ui/score.ts` (replace weight constants ~53-55; add `deriveReadiness` + `bandFromReadiness`; make `calcReadinessScore` a thin wrapper; export `ReadinessInputs`)
- Test: `scripts/audit-readiness-score.mjs` (create)

**Interfaces:**
- Consumes: existing `scoreFromAnchors`, anchor constants (`A_HRV_RATIO`, `A_RHR`, `A_SLEEP_SCORE`, `A_DEEP_SLEEP`, `A_CHECKIN`, `A_PROTEIN_RATIO`, `A_CALORIES_DELTA`, `A_CARBS_G`, `A_STEPS`) — all unchanged.
- Produces:
  - `export type ReadinessInputs` (the existing shape, now exported).
  - `export type ReadinessResult = { score: number | null; recoverySubScore: number | null; feel: number | null; band: "low" | "moderate" | "high" }`.
  - `export function deriveReadiness(inputs: ReadinessInputs): ReadinessResult`.
  - `export function calcReadinessScore(inputs: ReadinessInputs): number | null` — now returns `deriveReadiness(inputs).score` (back-compat).

- [ ] **Step 1: Write the failing audit script**

Create `scripts/audit-readiness-score.mjs`:

```js
// scripts/audit-readiness-score.mjs
//
// Fixture-based audit for deriveReadiness (lib/ui/score.ts). No DB access.
// Run via:
//   node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-readiness-score.mjs

import { deriveReadiness, calcReadinessScore } from "@/lib/ui/score";

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const HRV_BASE = 33;

// 1. Today's real case: HRV 20.46 (62% of baseline), RHR 73, no sleep score,
//    perfect-ish feel 7. Recovery signals are red → floor forces ACTION (low).
{
  const r = deriveReadiness({
    log: { hrv: 20.46, resting_hr: 73, sleep_score: null, deep_sleep_hours: null,
           protein_g: null, calories_eaten: null, carbs_g: null, steps: null, weight_kg: 103 },
    checkin: { readiness: 7 },
    hrvBaseline: HRV_BASE, weightKg: 103, calorieTarget: 1900,
  });
  assert("today red-recovery → band low", r.band === "low", `band=${r.band}`);
  assert("today recovery sub-score < 25", r.recoverySubScore !== null && r.recoverySubScore < 25, `sub=${r.recoverySubScore}`);
  assert("today feel preserved as 7", r.feel === 7, `feel=${r.feel}`);
}

// 2. Feel cannot rescue a red body: perfect 10 feel + red recovery still low.
{
  const r = deriveReadiness({
    log: { hrv: 20, resting_hr: 74, sleep_score: null, deep_sleep_hours: null,
           protein_g: null, calories_eaten: null, carbs_g: null, steps: null, weight_kg: 103 },
    checkin: { readiness: 10 },
    hrvBaseline: HRV_BASE, weightKg: 103, calorieTarget: 1900,
  });
  assert("perfect feel + red recovery → band low", r.band === "low", `band=${r.band}`);
  assert("perfect feel + red recovery → composite < 50", r.score !== null && r.score < 50, `score=${r.score}`);
}

// 3. Lifestyle absent renormalizes over recovery+feel (score still computed).
{
  const r = deriveReadiness({
    log: { hrv: 33, resting_hr: 52, sleep_score: 75, deep_sleep_hours: 1.6,
           protein_g: null, calories_eaten: null, carbs_g: null, steps: null, weight_kg: 103 },
    checkin: { readiness: 7 },
    hrvBaseline: HRV_BASE, weightKg: 103, calorieTarget: 1900,
  });
  assert("lifestyle absent → score not null", r.score !== null, `score=${r.score}`);
  assert("good recovery + good feel → band high", r.band === "high", `band=${r.band}`);
}

// 4. Recovery required: no HRV/RHR/sleep → score null, neutral band, feel kept.
{
  const r = deriveReadiness({
    log: { hrv: null, resting_hr: null, sleep_score: null, deep_sleep_hours: null,
           protein_g: 150, calories_eaten: 1800, carbs_g: 120, steps: 6000, weight_kg: 103 },
    checkin: { readiness: 8 },
    hrvBaseline: HRV_BASE, weightKg: 103, calorieTarget: 1900,
  });
  assert("no recovery signal → score null", r.score === null, `score=${r.score}`);
  assert("no recovery signal → recoverySubScore null", r.recoverySubScore === null, `sub=${r.recoverySubScore}`);
  assert("no recovery signal → band moderate (neutral)", r.band === "moderate", `band=${r.band}`);
  assert("no recovery signal → feel still 8", r.feel === 8, `feel=${r.feel}`);
}

// 5. Moderate recovery caps a would-be-high day at moderate.
//    recovery sub in [25,40): HRV ratio ~0.75 (→25), RHR 60 (→50), sleep 60 (→50), deep 0.8 (→25)
{
  const r = deriveReadiness({
    log: { hrv: 24.75, resting_hr: 60, sleep_score: 60, deep_sleep_hours: 0.8,
           protein_g: null, calories_eaten: null, carbs_g: null, steps: null, weight_kg: 103 },
    checkin: { readiness: 10 },
    hrvBaseline: HRV_BASE, weightKg: 103, calorieTarget: 1900,
  });
  assert("recovery sub in [25,40)", r.recoverySubScore !== null && r.recoverySubScore >= 25 && r.recoverySubScore < 40, `sub=${r.recoverySubScore}`);
  assert("moderate recovery caps high → moderate", r.band !== "high", `band=${r.band}`);
}

// 6. Back-compat: calcReadinessScore returns deriveReadiness(...).score
{
  const inputs = {
    log: { hrv: 33, resting_hr: 52, sleep_score: 75, deep_sleep_hours: 1.6,
           protein_g: null, calories_eaten: null, carbs_g: null, steps: null, weight_kg: 103 },
    checkin: { readiness: 7 },
    hrvBaseline: HRV_BASE, weightKg: 103, calorieTarget: 1900,
  };
  assert("calcReadinessScore == deriveReadiness().score",
    calcReadinessScore(inputs) === deriveReadiness(inputs).score);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
```

- [ ] **Step 2: Run the audit to verify it fails**

Run: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-readiness-score.mjs`
Expected: FAIL — `deriveReadiness` is not exported yet (import error or assertion failures).

- [ ] **Step 3: Re-tune the weight constants**

In `lib/ui/score.ts`, replace the three weight constants (currently `W_STRONG = 2`, `W_SUPPORTING = 1`, `MIN_WEIGHT_FOR_SCORE = 4` at lines ~53-55) with per-signal weights:

```ts
// Recovery-dominant readiness weights (spec 2026-07-01). Recovery bucket ~64%,
// feel ~25%, lifestyle ~11% when all present. Weights re-normalize over whichever
// signals are present, so unlogged lifestyle never penalizes readiness.
const W_HRV = 3;
const W_RHR = 3;
const W_SLEEP = 2;
const W_DEEP = 1;
const W_FEEL = 3.5;
const W_PROTEIN = 0.5;
const W_CALORIES = 0.5;
const W_CARBS = 0.25;
const W_STEPS = 0.25;
const MIN_WEIGHT_FOR_SCORE = 3;
```

- [ ] **Step 4: Export `ReadinessInputs`**

In `lib/ui/score.ts`, change `type ReadinessInputs = {` (line ~57) to `export type ReadinessInputs = {`. Leave the shape unchanged.

- [ ] **Step 5: Add `deriveReadiness`, `bandFromReadiness`, and the wrapper**

Replace the entire body of `calcReadinessScore` (lines ~87-124) with the following. Keep the anchor constants and `scoreFromAnchors` above it untouched:

```ts
export type ReadinessResult = {
  /** Composite 0-100. Null when no recovery signal is present (recovery-required). */
  score: number | null;
  /** Recovery-bucket-only 0-100 (HRV, RHR, sleep score, deep sleep). Null when no
   *  recovery signal is present. Drives the red-recovery floor. */
  recoverySubScore: number | null;
  /** Raw morning self-report (1-10) passed through untouched, for display. */
  feel: number | null;
  band: "low" | "moderate" | "high";
};

/** Maps a composite score to a band, then applies the red-recovery floor:
 *  a red recovery sub-score caps the band regardless of how good the composite
 *  (or the athlete's feel) is. Feel can lower a day, never rescue a red body. */
function bandFromReadiness(score: number, recoverySubScore: number | null): "low" | "moderate" | "high" {
  let band: "low" | "moderate" | "high" = score >= 67 ? "high" : score >= 45 ? "moderate" : "low";
  if (recoverySubScore !== null) {
    if (recoverySubScore < 25) band = "low";
    else if (recoverySubScore < 40 && band === "high") band = "moderate";
  }
  return band;
}

/** Single source of truth for readiness across the dashboard ring and the morning
 *  brief. Recovery-dominant weighted mean over whichever inputs are present. */
export function deriveReadiness(inputs: ReadinessInputs): ReadinessResult {
  const { log, checkin, hrvBaseline, calorieTarget } = inputs;
  const weightKg = inputs.weightKg ?? log?.weight_kg ?? null;
  const feel = checkin?.readiness ?? null;

  let weighted = 0;
  let totalWeight = 0;
  let recWeighted = 0;
  let recWeight = 0;
  const add = (score: number, weight: number) => {
    weighted += score * weight;
    totalWeight += weight;
  };
  const addRecovery = (score: number, weight: number) => {
    add(score, weight);
    recWeighted += score * weight;
    recWeight += weight;
  };

  if (log) {
    if (log.sleep_score != null) addRecovery(scoreFromAnchors(log.sleep_score, A_SLEEP_SCORE), W_SLEEP);
    if (log.deep_sleep_hours != null) addRecovery(scoreFromAnchors(log.deep_sleep_hours, A_DEEP_SLEEP), W_DEEP);
    if (log.hrv != null && hrvBaseline > 0) {
      addRecovery(scoreFromAnchors(log.hrv / hrvBaseline, A_HRV_RATIO), W_HRV);
    }
    if (log.resting_hr != null) addRecovery(scoreFromAnchors(log.resting_hr, A_RHR), W_RHR);

    if (log.protein_g != null && weightKg != null && weightKg > 0) {
      add(scoreFromAnchors(log.protein_g / (1.6 * weightKg), A_PROTEIN_RATIO), W_PROTEIN);
    }
    if (log.calories_eaten != null && calorieTarget != null && calorieTarget > 0) {
      add(scoreFromAnchors(Math.abs(log.calories_eaten / calorieTarget - 1), A_CALORIES_DELTA), W_CALORIES);
    }
    if (log.carbs_g != null) add(scoreFromAnchors(log.carbs_g, A_CARBS_G), W_CARBS);
    if (log.steps != null) add(scoreFromAnchors(log.steps, A_STEPS), W_STEPS);
  }

  if (feel != null) add(scoreFromAnchors(feel, A_CHECKIN), W_FEEL);

  const recoverySubScore = recWeight > 0 ? Math.round(recWeighted / recWeight) : null;

  // Recovery-required: no recovery signal present → readiness is not meaningful.
  if (recWeight === 0) return { score: null, recoverySubScore: null, feel, band: "moderate" };
  if (totalWeight < MIN_WEIGHT_FOR_SCORE) return { score: null, recoverySubScore, feel, band: "moderate" };

  const score = Math.round(weighted / totalWeight);
  return { score, recoverySubScore, feel, band: bandFromReadiness(score, recoverySubScore) };
}

/** @deprecated Prefer `deriveReadiness`. Returns just the composite score. */
export function calcReadinessScore(inputs: ReadinessInputs): number | null {
  return deriveReadiness(inputs).score;
}
```

- [ ] **Step 6: Run the audit to verify it passes**

Run: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-readiness-score.mjs`
Expected: PASS — `13 passed, 0 failed` (or similar; all assertions green).

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add lib/ui/score.ts scripts/audit-readiness-score.mjs
git commit -m "feat(readiness): recovery-dominant deriveReadiness with red-recovery floor

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Dashboard ring consumes `deriveReadiness`

**Files:**
- Modify: `components/dashboard/TodayClient.tsx:122-128` (replace `calcReadinessScore` call), import line ~13.

**Interfaces:**
- Consumes: `deriveReadiness` from Task 1.
- Produces: nothing new; the ring's `score` value is now `deriveReadiness(...).score` (picks up re-tuned weights). Band is available if the ring wants it later.

- [ ] **Step 1: Swap the import**

In `components/dashboard/TodayClient.tsx` line ~13, change:

```ts
import { calcReadinessScore, fmtNum } from "@/lib/ui/score";
```
to:
```ts
import { deriveReadiness, fmtNum } from "@/lib/ui/score";
```

- [ ] **Step 2: Replace the score computation**

Replace the `const score = calcReadinessScore({ ... });` block (lines ~122-128) with:

```ts
  const readiness = deriveReadiness({
    log: scoreLog,
    checkin: checkin ?? null,
    hrvBaseline,
    weightKg: effectiveWeightKg,
    calorieTarget,
  });
  const score = readiness.score;
```

Leave the downstream `score` usage (the ring value) and the separate `computeImpact(...)` call unchanged — `computeImpact` is the directional per-metric breakdown and is intentionally out of scope for the weight retune.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Build (guards against the hooks-order prod-only crash noted in project memory)**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add components/dashboard/TodayClient.tsx
git commit -m "refactor(dashboard): ring reads deriveReadiness (new weights)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Brief readiness wiring — compute composite, delete the feel-based band

**Files:**
- Modify: `lib/data/types.ts:991-996` (`MorningBriefReadiness` — add `recovery_sub_score` + `feel`, re-comment `score`)
- Modify: `lib/morning/brief/assembler.ts` (rewrite `composeReadiness` ~193-203; delete `deriveReadinessBand` ~329-352; add lifestyle-fallback helper)
- Modify: `lib/morning/brief/assembler.ts:51-61` (`WhoopBaselineForBand` — add `hrv_6mo_avg`) and `BriefInputs` (~63-109, add `hrvBaseline: number`)
- Modify: `lib/morning/brief/data-sources.ts:175-190` (populate `hrvBaseline`)

**Interfaces:**
- Consumes: `deriveReadiness` from Task 1.
- Produces:
  - `MorningBriefReadiness = { score: number | null; recovery_sub_score: number | null; feel: number | null; hrv: number | null; recovery: number | null; band: "low" | "moderate" | "high" }` where `score` is now the composite 0-100.
  - `BriefInputs.hrvBaseline: number`.

- [ ] **Step 1: Extend the `MorningBriefReadiness` type**

In `lib/data/types.ts`, replace lines 991-996:

```ts
export type MorningBriefReadiness = {
  score: number | null;                       // composite 0-100 (deriveReadiness); null = recovery not synced
  recovery_sub_score: number | null;          // recovery-bucket-only 0-100; drives the red-recovery floor
  feel: number | null;                        // raw morning self-report 1-10 (checkins.readiness)
  hrv: number | null;                         // from daily_logs[today].hrv
  recovery: number | null;                    // 0-100 from daily_logs[today].recovery
  band: "low" | "moderate" | "high";          // composite band + red-recovery floor
};
```

- [ ] **Step 2: Add `hrv_6mo_avg` to `WhoopBaselineForBand` and `hrvBaseline` to `BriefInputs`**

In `lib/morning/brief/assembler.ts`, inside the `WhoopBaselineForBand` type (~51-61) add:

```ts
  /** 6-month HRV average — the ratio denominator for the readiness composite,
   *  matching the dashboard ring. Falls back to 33 when absent. */
  hrv_6mo_avg?: number | null;
```

Then in `BriefInputs` (~63-109), add after `whoopBaselines`:

```ts
  /** HRV ratio denominator for deriveReadiness (profiles.whoop_baselines.hrv_6mo_avg
   *  ?? 33). Kept as a plain number so the brief and dashboard compute identical
   *  HRV ratios. */
  hrvBaseline: number;
```

- [ ] **Step 3: Populate `hrvBaseline` in the data source**

In `lib/morning/brief/data-sources.ts`, the profile row is read at line ~131 (`.select("whoop_baselines")`) and spread into the return at ~187. Add a derivation just before the `return {` at line ~175:

```ts
  const wb = (profileRes.data as { whoop_baselines?: WhoopBaselineForBand } | null)?.whoop_baselines ?? null;
  const hrvBaseline = typeof wb?.hrv_6mo_avg === "number" ? wb.hrv_6mo_avg : 33;
```

Then in the returned object, change the `whoopBaselines:` line to reuse `wb` and add `hrvBaseline`:

```ts
    whoopBaselines: wb,
    hrvBaseline,
```

Note: if `fetchBriefInputs` has a second early-return/fallback `return {` (search the file for `return {` — there is one near line ~240 per the grep), add `hrvBaseline: 33` there too so every `BriefInputs` construction typechecks.

- [ ] **Step 4: Rewrite `composeReadiness` and delete `deriveReadinessBand`**

In `lib/morning/brief/assembler.ts`, replace `composeReadiness` (lines ~193-203) with:

```ts
/** Today's recovery signals + YESTERDAY's lifestyle (steps/calories/protein/carbs),
 *  mirroring the dashboard ring's scoreLog per the readiness-uses-yesterday rule. */
function readinessLog(inputs: BriefInputs): DailyLog | null {
  const t = inputs.todayLog;
  if (!t) return null;
  const y = inputs.yesterdayLog;
  return {
    ...t,
    steps: y?.steps ?? null,
    calories_eaten: y?.calories_eaten ?? null,
    protein_g: y?.protein_g ?? null,
    carbs_g: y?.carbs_g ?? null,
  };
}

function composeReadiness(inputs: BriefInputs): MorningBriefReadiness {
  const r = deriveReadiness({
    log: readinessLog(inputs),
    checkin: inputs.todayCheckin,
    hrvBaseline: inputs.hrvBaseline,
    weightKg: inputs.todayLog?.weight_kg ?? inputs.yesterdayLog?.weight_kg ?? null,
    calorieTarget: inputs.todayTargets?.kcal ?? null,
  });
  return {
    score: r.score,
    recovery_sub_score: r.recoverySubScore,
    feel: r.feel,
    hrv: inputs.todayLog?.hrv ?? null,
    recovery: inputs.todayLog?.recovery ?? null,
    band: r.band,
  };
}
```

Then delete the entire `deriveReadinessBand` function (lines ~329-352) and the now-unused `WhoopBaselineForBand`-band comment block above it if it references only that function. Add the import at the top of the file:

```ts
import { deriveReadiness } from "@/lib/ui/score";
```

Note: `todayTargets` type is `TodayTargets | null`; confirm it exposes `kcal`. If the field is named differently (e.g. `calorieTarget`), use that name — grep `type TodayTargets` in `lib/morning/brief/get-today-targets.ts`.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors. If `deriveReadinessBand` is referenced anywhere else, the error will name the site — remove those references (they should not exist; it was local to `composeReadiness`).

- [ ] **Step 6: Extend the audit script with a brief-parity assertion**

Append to `scripts/audit-readiness-score.mjs` before the final summary:

```js
// 7. Brief parity: deriveReadiness with today's recovery + yesterday's lifestyle
//    produces the same score as the dashboard would for identical inputs.
{
  const shared = {
    log: { hrv: 33, resting_hr: 52, sleep_score: 75, deep_sleep_hours: 1.6,
           protein_g: 150, calories_eaten: 1900, carbs_g: 120, steps: 6000, weight_kg: 103 },
    checkin: { readiness: 7 },
    hrvBaseline: HRV_BASE, weightKg: 103, calorieTarget: 1900,
  };
  const a = deriveReadiness(shared);
  const b = deriveReadiness({ ...shared });
  assert("deriveReadiness is deterministic across surfaces", a.score === b.score && a.band === b.band);
}
```

Run: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-readiness-score.mjs`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/data/types.ts lib/morning/brief/assembler.ts lib/morning/brief/data-sources.ts scripts/audit-readiness-score.mjs
git commit -m "feat(brief): readiness headline is the composite, delete feel-based band

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Brief card display + advice grounding

**Files:**
- Modify: `components/morning/MorningBriefCard.tsx:75-88` (pending-sync banner copy), `:294-305` (headline scale + "You felt" sub-stat)
- Modify: `lib/morning/brief/advice-prompt.ts:399-401` (readiness context line)

**Interfaces:**
- Consumes: `MorningBriefReadiness` with `score` (0-100), `recovery_sub_score`, `feel` from Task 3.
- Produces: no new interfaces.

- [ ] **Step 1: Update the pending-sync banner copy**

In `components/morning/MorningBriefCard.tsx`, the `card.whoop_missing` banner (line ~86) currently reads:

```
WHOOP didn't sync this morning — readiness is feel-only.
```
Replace with (readiness is now null, not feel-only):

```
WHOOP hasn't synced yet — readiness is pending. Tap sync to compute it.
```

- [ ] **Step 2: Headline shows the composite (0-100), drop "/10"**

In `components/morning/MorningBriefCard.tsx` (~294-305), the headline currently renders `fmtNum(card.readiness.score)` with a `/10` suffix. Change the suffix span so it reads `/100` (or nothing) and add a self-report sub-line. Replace the score block (~293-306) with:

```tsx
        {card.readiness.score !== null ? fmtNum(card.readiness.score) : "—"}
        <span
          style={{
            fontSize: 16,
            fontWeight: 600,
            letterSpacing: 0,
            marginLeft: 6,
            opacity: 0.75,
          }}
        >
          {card.readiness.score !== null ? "/100" : null}
        </span>
```

Then, immediately after the closing `</div>` of the score block, add the self-report sub-line:

```tsx
      {card.readiness.feel !== null ? (
        <div style={{ fontSize: 12, fontWeight: 600, opacity: 0.8, marginTop: 4 }}>
          You felt: {fmtNum(card.readiness.feel)}/10
        </div>
      ) : null}
```

- [ ] **Step 3: Ground the AI advice in the composite**

In `lib/morning/brief/advice-prompt.ts` (~399-401), replace the readiness context line:

```ts
  const r = card.readiness;
  lines.push(
    `- Readiness band: ${r.band} (composite ${r.score ?? "n/a"}/100, recovery sub-score ${r.recovery_sub_score ?? "n/a"}, athlete felt ${r.feel ?? "n/a"}/10, HRV ${r.hrv ?? "n/a"}, WHOOP recovery ${r.recovery ?? "n/a"})`,
  );
```

(Match the surrounding push/array style — if the code uses a `.join` array literal rather than `lines.push`, insert the same string into that array. Grep the immediate context to confirm the variable name.)

- [ ] **Step 4: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: both succeed.

- [ ] **Step 5: Commit**

```bash
git add components/morning/MorningBriefCard.tsx lib/morning/brief/advice-prompt.ts
git commit -m "feat(brief): headline shows composite/100 + 'You felt' sub-stat; advice grounds in composite

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Verification + doc note

**Files:**
- Modify: `CLAUDE.md` (readiness single-source note in the Coach/AI section)

**Interfaces:** none.

- [ ] **Step 1: Full typecheck + build + audit**

Run:
```bash
npm run typecheck
npm run build
node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-readiness-score.mjs
```
Expected: typecheck clean, build succeeds, audit all-pass.

- [ ] **Step 2: Manual smoke (local)**

Run `npm run dev`. Then:
- Open `/` — confirm the readiness ring renders a number (weights changed; value may differ from before).
- Open the morning brief (or `/coach` where the brief card renders) — confirm the headline shows the **same composite number** as the ring, with "You felt: N/10" beneath, and the band label reflects the floor (a red-recovery day shows ACTION/WATCH, not GOOD).
- Confirm the coach-suggestion chip fires the low-readiness path on a red-recovery day.

Record what you observed (numbers + band) in the task notes — do not claim success without seeing it.

- [ ] **Step 3: Add the CLAUDE.md single-source note**

In `CLAUDE.md`, in the Coach/AI bullet list, add a line near the readiness/brief entries:

```md
- **Readiness (single source)**: `deriveReadiness` in [lib/ui/score.ts](lib/ui/score.ts) is the ONE readiness computation — recovery-dominant weighted composite (HRV/RHR/sleep/deep-sleep ~64%, morning feel ~25%, nutrition/steps ~11%) with a red-recovery floor (recovery sub-score <25 → band low, <40 → cap moderate) and a recovery-required rule (no HRV/RHR/sleep → score null, brief shows "pending sync"). Both the dashboard ring ([TodayClient.tsx](components/dashboard/TodayClient.tsx)) and the morning brief ([composeReadiness](lib/morning/brief/assembler.ts)) call it; the old feel-based `deriveReadinessBand` is gone. Lifestyle signals renormalize out cleanly when unlogged. Audit: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-readiness-score.mjs`. Spec: [docs/superpowers/specs/2026-07-01-composite-readiness-drives-coach-design.md](docs/superpowers/specs/2026-07-01-composite-readiness-drives-coach-design.md).
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(coach): readiness is now a single recovery-dominant composite

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Re-tuned weights → Task 1 Step 3. ✓
- Recovery sub-score → Task 1 Step 5. ✓
- Graceful fallback / lifestyle-optional → Task 1 (renormalization) + audit case 3. ✓
- Recovery-required → Task 1 (`recWeight === 0` branch) + audit case 4; brief pending-sync banner Task 4 Step 1. ✓
- Red-recovery floor → Task 1 `bandFromReadiness` + audit cases 1, 2, 5. ✓
- Single source of truth → Task 2 (dashboard) + Task 3 (brief) call `deriveReadiness`; `deriveReadinessBand` deleted Task 3 Step 4. ✓
- AI advice grounding → Task 4 Step 3. ✓
- Display unification (composite headline + "You felt") → Task 4 Steps 1-2. ✓
- No schema change → confirmed; no migration task. ✓

**Placeholder scan:** No TBD/TODO; all code steps show full code. The two "grep to confirm the exact name" notes (TodayTargets `kcal` field, advice-prompt push style) are verification hints with concrete fallbacks, not placeholders.

**Type consistency:** `deriveReadiness → ReadinessResult { score, recoverySubScore, feel, band }` (camelCase, TS API) is mapped in `composeReadiness` to `MorningBriefReadiness { score, recovery_sub_score, feel, hrv, recovery, band }` (snake_case, persisted card shape) — the mapping is explicit in Task 3 Step 4. `calcReadinessScore` retains its `(ReadinessInputs) → number | null` signature. `BriefInputs.hrvBaseline: number` is produced in Task 3 Step 3 and consumed in Step 4. Consistent.
