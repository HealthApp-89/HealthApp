# Block close-early + target calibration validator — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `close_block_early` HMAC chat tool + a trend-derived target calibration validator on `propose_block`, then run the one-shot operational sequence for the current deadlift block.

**Architecture:** New pure helper (`lib/coach/prescription/calibrate-target.ts`) computes per-lift trend slope from realized workout data, falls back to a coefficient table, and returns sanity bounds. `executeProposeBlock` consumes the helper to reject obviously-miscalibrated targets unless the athlete supplies an explicit override reason. A new HMAC-gated chat-tool pair (`propose_close_block` / `commit_close_block`) wraps `generateBlockOutcome` + the `training_blocks.status` update so future blocks can be closed before `end_date` without SQL.

**Tech Stack:** TypeScript strict, Next.js 15 App Router, Supabase service-role client, Anthropic SDK tool surface, existing HMAC approval-token primitive (`lib/coach/approval-token.ts`). No new tables, no migration, no env vars.

**Source spec:** [docs/superpowers/specs/2026-05-31-block-close-and-target-calibration-design.md](../specs/2026-05-31-block-close-and-target-calibration-design.md)

---

## File map

**New files:**
- `lib/coach/prescription/calibrate-target.ts` — pure helpers (OLS, coefficient table, sanity bounds) + Supabase-driven orchestrator

**Modified files:**
- `lib/coach/tools.ts` — new tool schemas (`PROPOSE_CLOSE_BLOCK_TOOL`, `COMMIT_CLOSE_BLOCK_TOOL`), new executors (`executeProposeCloseBlock`, `executeCommitCloseBlock`), extend `PROPOSE_BLOCK_TOOL` schema with `override_reason`, extend `executeProposeBlock` with calibration validation, register tools in `PETER_TOOLS`
- `lib/coach/chat-stream.ts` — import + dispatch the two new executors, add to `PERSIST_RESULT_TOOLS`, add explicit allows in `modeAllowsTool`
- `lib/coach/system-prompts.ts` — add close-block narration paragraph to `PETER_BASE`
- `lib/coach/planning-prompts.ts` — extend `fetchSetupBlockContext` to inject `NEXT_BLOCK_TARGET_RECOMMENDATION`, extend `SETUP_BLOCK_PROMPT` beat-2 narration guidance
- `scripts/audit-prescription-rules.mjs` — assertions for the pure helpers in calibrate-target
- `CLAUDE.md` — architecture note under the "Weekly planning v1" bullet

---

## Task 1: Pure helpers in calibrate-target.ts (OLS + coefficient table + sanity bounds)

**Files:**
- Create: `lib/coach/prescription/calibrate-target.ts`
- Test: `scripts/audit-prescription-rules.mjs` (assertions appended later in Task 2)

- [ ] **Step 1: Write the pure module — coefficient table + OLS + bounds**

Create `lib/coach/prescription/calibrate-target.ts`:

```ts
// lib/coach/prescription/calibrate-target.ts
//
// Trend-derived block-target recommendation + sanity bounds.
//
// Two phases:
//   1. Pure helpers (this file's exports) — coefficient lookup, OLS slope,
//      grid rounding, sanity-bounds computation. No I/O.
//   2. Supabase-driven orchestrator computeTargetRecommendation() that pulls
//      90d of realized working sets and feeds the pure helpers.
//
// Used by executeProposeBlock to reject obviously-miscalibrated targets and
// by fetchSetupBlockContext to surface the recommendation to Carter's prompt.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { PrimaryLift } from "@/lib/data/types";
import { bestComparisonValue } from "@/lib/coach/e1rm";
import { PRIMARY_LIFT_NAME_PATTERNS } from "@/lib/coach/prescription/current-comparison-value";

export type AthletePhase = "bulk" | "maintenance" | "cut";

/** Realistic e1RM kg/wk gain on a FOCUS lift for an intermediate male
 *  athlete. Numbers triangulated from Wendler 5/3/1 cycle deltas
 *  (5 lb upper / 10 lb lower per 3-week cycle), Helms 3DMJ intermediate
 *  cut protocols, and Stronger-by-Science training-progression reviews.
 *  Conservative — these target "realistic if execution is clean", not
 *  best-case. Revisit if/when literature updates. */
export const COEFFICIENT_TABLE: Record<PrimaryLift, Record<AthletePhase, number>> = {
  deadlift: { bulk: 2.5, maintenance: 1.5, cut: 1.5 },
  squat:    { bulk: 2.0, maintenance: 1.25, cut: 1.25 },
  bench:    { bulk: 1.0, maintenance: 0.75, cut: 0.75 },
  ohp:      { bulk: 0.75, maintenance: 0.4, cut: 0.4 },
};

/** All four primary lifts are barbell-loaded in the current exercise library,
 *  so the grid step is uniform 2.5 kg. Hard-coded rather than fetched per-lift
 *  to keep this module pure + cheap. */
const GRID_STEP_KG = 2.5;

/** Round DOWN to the nearest grid step. Used so recommended/sanity targets
 *  never propose a load that isn't on the equipment grid. */
export function gridRoundDown(kg: number): number {
  return Math.floor(kg / GRID_STEP_KG) * GRID_STEP_KG;
}

/** Round UP to nearest grid step. Used for the lower sanity bound so the
 *  rejection window can never wrap a valid grid value the athlete might enter. */
export function gridRoundUp(kg: number): number {
  return Math.ceil(kg / GRID_STEP_KG) * GRID_STEP_KG;
}

/** OLS slope of (weekIndex, e1rm) across the supplied per-week max samples.
 *  Returns null when fewer than 3 weeks of data — the slope is statistically
 *  meaningless below that. weekIndices must be 0-indexed and monotonically
 *  increasing; the caller decides whether to fill gaps. */
export function computeOlsSlope(
  samples: ReadonlyArray<{ weekIndex: number; e1rm: number }>,
): number | null {
  if (samples.length < 3) return null;
  const n = samples.length;
  const sumX = samples.reduce((a, s) => a + s.weekIndex, 0);
  const sumY = samples.reduce((a, s) => a + s.e1rm, 0);
  const sumXY = samples.reduce((a, s) => a + s.weekIndex * s.e1rm, 0);
  const sumXX = samples.reduce((a, s) => a + s.weekIndex * s.weekIndex, 0);
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return null;
  return (n * sumXY - sumX * sumY) / denom;
}

/** Compute the sanity-bounds window for a proposed target, given the
 *  athlete's current e1RM and the lift's phase coefficient. The lower bound
 *  rejects "too easy" (target hit by week 1); the upper bound rejects
 *  "demoralizing/unrealistic" at 1.5× the realistic 4-week gain. */
export function computeSanityBounds(opts: {
  currentE1rm: number;
  coefficient: number;
}): [number, number] {
  const lower = gridRoundUp(opts.currentE1rm + 1);
  const upper = gridRoundDown(opts.currentE1rm + opts.coefficient * 4 * 1.5);
  return [lower, upper];
}

/** Coefficient lookup with safe fallback. NULL phase defaults to 'cut' to
 *  match the default the rest of the prescription pipeline assumes when
 *  plan_payload isn't available. */
export function coefficientFor(lift: PrimaryLift, phase: AthletePhase = "cut"): number {
  return COEFFICIENT_TABLE[lift][phase];
}

// ── Supabase-driven orchestrator (Task 2) ────────────────────────────────
// computeTargetRecommendation() is implemented in Task 2.
```

- [ ] **Step 2: Run typecheck to confirm the module compiles**

Run: `cd "/Users/abdelouahedelbied/Health app" && npm run typecheck 2>&1 | tail -5`
Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
git add lib/coach/prescription/calibrate-target.ts
git commit -m "$(cat <<'EOF'
feat(prescription): pure helpers for target calibration (OLS, bounds, coefficients)

Adds lib/coach/prescription/calibrate-target.ts with:
- COEFFICIENT_TABLE: per-lift × phase kg/wk e1RM gain (Wendler / Helms / SBS)
- computeOlsSlope: linear regression on per-week max e1RM samples
- gridRoundDown / gridRoundUp: 2.5 kg barbell grid alignment
- computeSanityBounds: [current+1, current+coef×4×1.5] window
- coefficientFor: safe lookup with cut as default

Pure functions only; Supabase-driven orchestrator lands next task.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Supabase-driven orchestrator + audit assertions

**Files:**
- Modify: `lib/coach/prescription/calibrate-target.ts` (append orchestrator)
- Modify: `scripts/audit-prescription-rules.mjs` (append assertions)

- [ ] **Step 1: Add the orchestrator to calibrate-target.ts**

Append to `lib/coach/prescription/calibrate-target.ts`:

```ts
export type TargetRecommendation = {
  /** Athlete's current best e1RM for the lift across the 90-day window.
   *  Null when no logged data exists (bootstrap path for first-ever block). */
  current_e1rm: number | null;
  /** OLS slope of per-week max e1RM, kg/wk. Null when <3 weeks of data
   *  OR when slope is non-positive (declining lift — fall through to math). */
  slope_kg_per_wk: number | null;
  /** current + slope × 4, grid-rounded. Null when slope is null. */
  trend_target: number | null;
  /** current + coefficient × 4, grid-rounded. Null when current is null. */
  math_target: number | null;
  /** Which source produced `recommended_target`. 'neither' = no data, no
   *  recommendation; validator falls through and accepts any input. */
  used: "trend" | "math" | "neither";
  recommended_target: number | null;
  /** [min, max] inclusive bounds for the validator. Null when current is null. */
  sanity_bounds: [number, number] | null;
};

export async function computeTargetRecommendation(opts: {
  supabase: SupabaseClient;
  userId: string;
  lift: PrimaryLift;
  todayIso: string;
  phase?: AthletePhase;
}): Promise<TargetRecommendation> {
  const { supabase, userId, lift, todayIso, phase = "cut" } = opts;

  const cutoff = subtractDaysIso(todayIso, 90);
  const namePatterns = PRIMARY_LIFT_NAME_PATTERNS[lift] ?? [];
  if (namePatterns.length === 0) {
    return emptyRecommendation();
  }

  const { data, error } = await supabase
    .from("workouts")
    .select("date, exercises(name, exercise_sets(kg, reps, warmup))")
    .eq("user_id", userId)
    .gte("date", cutoff)
    .order("date", { ascending: true });
  if (error || !data) return emptyRecommendation();

  type RawSet = { kg: number | null; reps: number | null; warmup: boolean | null };
  type RawEx = { name: string; exercise_sets: RawSet[] | null };
  type RawW = { date: string; exercises: RawEx[] | null };
  const rows = data as unknown as RawW[];

  const namesLower = new Set(namePatterns.map((n) => n.toLowerCase()));

  // Per-week max e1RM samples. Week index is days-since-cutoff / 7, floored.
  const cutoffMs = new Date(cutoff + "T00:00:00Z").getTime();
  const weekMax = new Map<number, number>();
  let allTimeMax: number | null = null;

  for (const w of rows) {
    for (const ex of w.exercises ?? []) {
      if (!namesLower.has(ex.name.toLowerCase())) continue;
      for (const s of ex.exercise_sets ?? []) {
        const e1rm = bestComparisonValue(
          [{ kg: s.kg, reps: s.reps, warmup: s.warmup }],
          "e1rm",
        );
        if (e1rm == null) continue;
        if (allTimeMax == null || e1rm > allTimeMax) allTimeMax = e1rm;
        const dayMs = new Date(w.date + "T00:00:00Z").getTime();
        const weekIdx = Math.floor((dayMs - cutoffMs) / (7 * 24 * 60 * 60 * 1000));
        weekMax.set(weekIdx, Math.max(weekMax.get(weekIdx) ?? 0, e1rm));
      }
    }
  }

  if (allTimeMax == null) return emptyRecommendation();
  const current = allTimeMax;

  // OLS slope across per-week samples
  const samples = Array.from(weekMax.entries())
    .map(([weekIndex, e1rm]) => ({ weekIndex, e1rm }))
    .sort((a, b) => a.weekIndex - b.weekIndex);
  const rawSlope = computeOlsSlope(samples);

  // Negative or zero slope on a focus lift is suspect (declining recently —
  // could be a deload week or just a bad session sequence). Fall through to
  // math so the recommendation isn't "target = current".
  const slope = rawSlope != null && rawSlope > 0 ? rawSlope : null;

  const coef = coefficientFor(lift, phase);
  const trendTarget = slope != null ? gridRoundDown(current + slope * 4) : null;
  const mathTarget = gridRoundDown(current + coef * 4);

  let recommended: number | null;
  let used: TargetRecommendation["used"];
  if (trendTarget != null) {
    recommended = trendTarget;
    used = "trend";
  } else {
    recommended = mathTarget;
    used = "math";
  }

  return {
    current_e1rm: current,
    slope_kg_per_wk: rawSlope, // expose the raw slope (even when non-positive) for narration
    trend_target: trendTarget,
    math_target: mathTarget,
    used,
    recommended_target: recommended,
    sanity_bounds: computeSanityBounds({ currentE1rm: current, coefficient: coef }),
  };
}

function emptyRecommendation(): TargetRecommendation {
  return {
    current_e1rm: null,
    slope_kg_per_wk: null,
    trend_target: null,
    math_target: null,
    used: "neither",
    recommended_target: null,
    sanity_bounds: null,
  };
}

function subtractDaysIso(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
```

- [ ] **Step 2: Append audit assertions for the pure helpers**

Add this section to `scripts/audit-prescription-rules.mjs` immediately before the existing final line `console.log(`\n${pass} passed, ${fail} failed.`);`:

```js
console.log("\n## calibrate-target.ts (pure helpers)\n");
{
  const {
    coefficientFor,
    computeOlsSlope,
    computeSanityBounds,
    gridRoundDown,
    gridRoundUp,
    COEFFICIENT_TABLE,
  } = await import("@/lib/coach/prescription/calibrate-target");

  // coefficient table
  assert("coefficient deadlift cut = 1.5", coefficientFor("deadlift", "cut") === 1.5);
  assert("coefficient bench cut = 0.75", coefficientFor("bench", "cut") === 0.75);
  assert("coefficient ohp cut = 0.4", coefficientFor("ohp", "cut") === 0.4);
  assert("coefficient default phase = cut", coefficientFor("squat") === coefficientFor("squat", "cut"));
  assert("coefficient table covers all 4 lifts", Object.keys(COEFFICIENT_TABLE).sort().join(",") === "bench,deadlift,ohp,squat");

  // grid rounding
  assert("gridRoundDown 81.7 = 80", gridRoundDown(81.7) === 80);
  assert("gridRoundDown 82.5 = 82.5", gridRoundDown(82.5) === 82.5);
  assert("gridRoundUp 81.7 = 82.5", gridRoundUp(81.7) === 82.5);
  assert("gridRoundUp 82.5 = 82.5", gridRoundUp(82.5) === 82.5);

  // OLS slope
  assert("OLS null on <3 samples", computeOlsSlope([{ weekIndex: 0, e1rm: 80 }, { weekIndex: 1, e1rm: 81 }]) === null);
  const slope1 = computeOlsSlope([
    { weekIndex: 0, e1rm: 80 },
    { weekIndex: 1, e1rm: 81 },
    { weekIndex: 2, e1rm: 82 },
  ]);
  assert("OLS slope of perfectly-linear +1/wk = 1.0", Math.abs(slope1 - 1.0) < 1e-9, `got ${slope1}`);
  const slope2 = computeOlsSlope([
    { weekIndex: 0, e1rm: 80 },
    { weekIndex: 1, e1rm: 80 },
    { weekIndex: 2, e1rm: 80 },
  ]);
  assert("OLS slope of flat samples = 0", slope2 === 0);
  const slope3 = computeOlsSlope([
    { weekIndex: 0, e1rm: 85 },
    { weekIndex: 1, e1rm: 84 },
    { weekIndex: 2, e1rm: 83 },
  ]);
  assert("OLS slope of declining samples = -1.0", Math.abs(slope3 + 1.0) < 1e-9, `got ${slope3}`);
  // OLS handles gaps (week 0, 2, 5) — uses x-values as supplied
  const slope4 = computeOlsSlope([
    { weekIndex: 0, e1rm: 80 },
    { weekIndex: 2, e1rm: 82 },
    { weekIndex: 5, e1rm: 85 },
  ]);
  assert("OLS slope on sparse weeks ≈ 1.0", Math.abs(slope4 - 1.0) < 0.001, `got ${slope4}`);

  // sanity bounds
  // current = 80.7, coef = 0.75 (bench cut)
  //   lower = ceil(81.7 / 2.5) × 2.5 = 82.5
  //   upper = floor(80.7 + 0.75 × 4 × 1.5 / 2.5) × 2.5 = floor((80.7 + 4.5) / 2.5) × 2.5 = floor(85.2/2.5)×2.5 = 85
  const bounds1 = computeSanityBounds({ currentE1rm: 80.7, coefficient: 0.75 });
  assert("bounds for bench cut current=80.7 are [82.5, 85]",
    bounds1[0] === 82.5 && bounds1[1] === 85,
    `got [${bounds1[0]}, ${bounds1[1]}]`);
  // current = 117.9 (your post-stamp deadlift e1RM), coef = 1.5 (deadlift cut)
  //   lower = ceil(118.9 / 2.5) × 2.5 = 120
  //   upper = floor((117.9 + 9) / 2.5) × 2.5 = floor(126.9/2.5)×2.5 = 125
  const bounds2 = computeSanityBounds({ currentE1rm: 117.9, coefficient: 1.5 });
  assert("bounds for deadlift cut current=117.9 are [120, 125]",
    bounds2[0] === 120 && bounds2[1] === 125,
    `got [${bounds2[0]}, ${bounds2[1]}]`);
}
```

- [ ] **Step 3: Run the audit to verify all assertions pass**

Run: `cd "/Users/abdelouahedelbied/Health app" && node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs 2>&1 | tail -25`
Expected: `XX passed, 0 failed.` (count rises to ~83 from 67)

- [ ] **Step 4: Run typecheck**

Run: `cd "/Users/abdelouahedelbied/Health app" && npm run typecheck 2>&1 | tail -5`
Expected: zero errors.

- [ ] **Step 5: Commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
git add lib/coach/prescription/calibrate-target.ts scripts/audit-prescription-rules.mjs
git commit -m "$(cat <<'EOF'
feat(prescription): computeTargetRecommendation orchestrator + audit assertions

Adds the Supabase-driven orchestrator that pulls 90d of realized working
sets for a primary lift, computes per-week max e1RM via Brzycki, fits an
OLS slope, and returns:
  - current_e1rm (max across the window)
  - slope_kg_per_wk (raw OLS, null when <3 weeks)
  - trend_target (current + slope×4, grid-rounded down) when slope > 0
  - math_target (current + coefficient×4, grid-rounded down)
  - recommended_target + 'used' discriminator
  - sanity_bounds [current+1 round-up, current+coef×4×1.5 round-down]

Negative/zero slope falls through to math (declining lift is suspect on a
focus block). Empty workout data returns all-nulls — validator falls back
to bootstrap path (accept whatever target is supplied).

16 audit assertions cover the pure helpers; orchestrator gets manual smoke
in Task 3 via executeProposeBlock integration.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Extend executeProposeBlock with calibration validator

**Files:**
- Modify: `lib/coach/tools.ts` — `PROPOSE_BLOCK_TOOL` schema (add `override_reason`), `executeProposeBlock` body (validate target against bounds, attach `recommendation` to preview)

- [ ] **Step 1: Add override_reason to PROPOSE_BLOCK_TOOL schema**

In `lib/coach/tools.ts`, find `export const PROPOSE_BLOCK_TOOL` (around line 1540-1580). Replace the `properties` block to include `override_reason`:

```ts
export const PROPOSE_BLOCK_TOOL = {
  name: "propose_block",
  description:
    "Propose a new 5-week training block. Does NOT write. Returns preview + approval_token. The server validates the target_value against trend-derived sanity bounds (computed from the athlete's last 90d of realized working sets for the primary lift). If the proposed target is outside [current+1, current+coefficient×4×1.5], the call fails with target_out_of_bounds — retry with an explicit override_reason if the athlete consciously wants to go outside that window.",
  input_schema: {
    type: "object" as const,
    required: ["goal_text", "start_date", "end_date"],
    properties: {
      goal_text:    { type: "string", minLength: 4, maxLength: 200 },
      primary_lift: { type: "string", enum: ["squat", "bench", "deadlift", "ohp"] },
      target_metric:{ type: "string", enum: ["e1rm", "working_weight"] },
      target_value: { type: "number", minimum: 1, maximum: 500 },
      target_unit:  { type: "string", maxLength: 16 },
      start_date:   { type: "string", format: "date", description: "Must be a Monday." },
      end_date:     { type: "string", format: "date", description: "Must equal start_date + 34 days." },
      override_reason: {
        type: "string",
        minLength: 4,
        maxLength: 200,
        description: "Required ONLY when target_value falls outside the trend-derived sanity bounds. Explain why you want to go above/below the realistic 4-week range — e.g. 'returning from injury, conservative target' or 'priming meet attempt, intentionally aggressive'.",
      },
    },
  },
};
```

- [ ] **Step 2: Extend ProposeBlockInput type**

In `lib/coach/tools.ts`, find `type ProposeBlockInput = {...}` (currently around line 1700-1710). Add `override_reason?: string`:

```ts
type ProposeBlockInput = {
  goal_text: string;
  primary_lift?: PrimaryLift;
  target_metric?: "e1rm" | "working_weight";
  target_value?: number;
  target_unit?: string;
  start_date: string;
  end_date: string;
  override_reason?: string;
};
```

- [ ] **Step 3: Import computeTargetRecommendation**

In `lib/coach/tools.ts`, find the existing import block for `lib/coach/prescription/` modules (currently lines 38-41). Add the calibrate-target import:

```ts
import { validateWeekPrescription } from "@/lib/coach/prescription/validate-week";
import { maintenanceLoadFor } from "@/lib/coach/prescription/maintenance-baseline";
import { prescribeWeek } from "@/lib/coach/prescription/prescribe-week";
import { upsertWeekPrescription } from "@/lib/coach/prescription/upsert-week-prescription";
import { computeTargetRecommendation, type TargetRecommendation } from "@/lib/coach/prescription/calibrate-target";
import type { WorkoutSetSample } from "@/lib/coach/prescription/types";
```

- [ ] **Step 4: Extend executeProposeBlock with the validator**

In `lib/coach/tools.ts`, find `executeProposeBlock` (around line 1730). After the existing field validation block ends with `if (hasMetric !== hasValue) { return { ok: false, error: ... } }` and BEFORE `const payload = i as unknown as ProposeBlockInput;`, insert the calibration block:

```ts
  // ── Target calibration: trend-derived sanity check ──────────────────────
  // Compute the trend-derived recommendation (helper returns all-nulls when
  // the lift has no logged history — bootstrap path for first-ever block).
  // Only enforces bounds when (a) target_value is set AND (b) recommendation
  // returned non-null sanity_bounds (i.e., there's enough data to anchor).
  let recommendation: TargetRecommendation | null = null;
  if (i.primary_lift != null && i.target_value != null) {
    try {
      recommendation = await computeTargetRecommendation({
        supabase: opts.supabase,
        userId: opts.userId,
        lift: i.primary_lift as PrimaryLift,
        todayIso: todayInUserTz(),
      });
    } catch (e) {
      // Don't block block creation on a transient data-fetch failure.
      console.warn("[propose_block] computeTargetRecommendation failed", e);
      recommendation = null;
    }
  }

  if (recommendation?.sanity_bounds != null && i.target_value != null) {
    const [lo, hi] = recommendation.sanity_bounds;
    const tv = i.target_value as number;
    const outOfBounds = tv < lo || tv > hi;
    const overrideReason = typeof i.override_reason === "string" && i.override_reason.length >= 4 ? i.override_reason : null;
    if (outOfBounds && overrideReason == null) {
      const direction = tv < lo ? "too low" : "too high";
      const hint = tv < lo
        ? `Target ${tv} kg would be hit too quickly given current ${recommendation.current_e1rm} e1RM. Sanity floor for this lift is ${lo} kg.`
        : `Target ${tv} kg exceeds realistic 4-week progression. Sanity ceiling for this lift is ${hi} kg (current ${recommendation.current_e1rm} e1RM + 1.5× the trend-realistic 4-week gain).`;
      return {
        ok: false,
        error: {
          error: `Proposed target ${tv} kg is ${direction} for a 5-week ${i.primary_lift} block. ${hint} Recommended target: ${recommendation.recommended_target} kg (${recommendation.used}-based). To proceed with ${tv} kg anyway, retry propose_block with an explicit override_reason explaining why.`,
          code: "target_out_of_bounds",
          hint,
        },
        meta: { ms: Date.now() - t0, range_days: 0 },
      };
    }
    if (outOfBounds && overrideReason != null) {
      console.info("[propose_block] target_out_of_bounds_override", {
        userId: opts.userId,
        lift: i.primary_lift,
        proposed: tv,
        bounds: [lo, hi],
        reason: overrideReason,
      });
    }
  }
```

- [ ] **Step 5: Attach recommendation to the preview return**

In the same `executeProposeBlock` function, replace the final return statement:

```ts
  const payload = i as unknown as ProposeBlockInput;
  const token = signApprovalToken({ userId: opts.userId, action: "block", payload });
  return {
    ok: true,
    data: { preview: payload, approval_token: token, recommendation },
    meta: { ms: Date.now() - t0, result_rows: 1, range_days: 35, truncated: false },
  };
}
```

Note the addition of `recommendation` to the `data` object. The return type signature also needs updating — find the function signature and update it:

```ts
export async function executeProposeBlock(opts: {
  supabase: SupabaseClient;
  userId: string;
  input: unknown;
}): Promise<ToolResult<{ preview: ProposeBlockInput; approval_token: string; recommendation: TargetRecommendation | null }>> {
```

- [ ] **Step 6: Run typecheck**

Run: `cd "/Users/abdelouahedelbied/Health app" && npm run typecheck 2>&1 | tail -10`
Expected: zero errors.

- [ ] **Step 7: Commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
git add lib/coach/tools.ts
git commit -m "$(cat <<'EOF'
feat(prescription): propose_block sanity-checks target against trend bounds

executeProposeBlock now calls computeTargetRecommendation before signing.
When the proposed target_value falls outside [current+1, current+coef×4×1.5]
the call fails with target_out_of_bounds, surfacing the recommendation +
sanity ceiling/floor in the error message. Athletes can override consciously
by including override_reason on the retry.

Schema adds override_reason field; preview return now carries the full
recommendation payload so Carter can narrate it back to the athlete on the
proposal chip.

Bootstrap-safe: first-ever block (no logged history) gets all-nulls back
from the recommender → validator passes through.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: propose_close_block tool + executor

**Files:**
- Modify: `lib/coach/tools.ts` (add `PROPOSE_CLOSE_BLOCK_TOOL`, `executeProposeCloseBlock`)

- [ ] **Step 1: Add the schema near the existing PROPOSE_BLOCK_TOOL**

In `lib/coach/tools.ts`, immediately after `export const COMMIT_BLOCK_TOOL = {...}` (around line 1595), add:

```ts
export const PROPOSE_CLOSE_BLOCK_TOOL = {
  name: "propose_close_block",
  description:
    "Preview closing the athlete's active block before its end_date. Returns the would-be block_outcomes payload + approval_token. Use ONLY when the athlete asks to close early (target hit early, target unreachable, schedule change, injury). The standard end-of-block flow runs via block-outcomes/sweep at end_date automatically and does NOT need this tool.",
  input_schema: {
    type: "object" as const,
    required: ["reason"],
    properties: {
      reason: {
        type: "string",
        minLength: 4,
        maxLength: 200,
        description: "Why are we closing early? Athlete-quoted preferred — e.g. 'target hit week 3, recalibrating', 'shoulder pain forcing rotation', 'travel disrupting schedule'.",
      },
    },
  },
};

export const COMMIT_CLOSE_BLOCK_TOOL = {
  name: "commit_close_block",
  description:
    "Commit a previously proposed early block close. Requires approval_token from propose_close_block. Updates training_blocks.status='completed' and writes the block_outcomes row.",
  input_schema: {
    type: "object" as const,
    required: ["approval_token"],
    properties: {
      approval_token: { type: "string", minLength: 60 },
    },
  },
};
```

- [ ] **Step 2: Add the executor type + propose executor**

In `lib/coach/tools.ts`, find the existing import for `generateBlockOutcome` — if not present, add it near the other block-outcomes imports (currently the only outcomes import is via downstream files). Search for `generateBlockOutcome` first:

Run: `grep -n "generateBlockOutcome\|block-outcomes" "/Users/abdelouahedelbied/Health app/lib/coach/tools.ts" | head -5`

If absent, add this import near the other top-of-file imports:

```ts
import { generateBlockOutcome } from "@/lib/coach/block-outcomes";
```

Then add the executor type and propose executor just BEFORE the existing `executeCommitBlock` (around line 1770):

```ts
type ProposeCloseBlockInput = {
  blockId: string;
  reason: string;
};

// ── propose_close_block executor ──────────────────────────────────────────

export async function executeProposeCloseBlock(opts: {
  supabase: SupabaseClient;
  userId: string;
  input: unknown;
}): Promise<ToolResult<{ preview: { blockId: string; primary_lift: PrimaryLift | null; target_value: number | null; reason: string; would_be_outcome: unknown }; approval_token: string }>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;

  if (typeof i.reason !== "string" || i.reason.length < 4 || i.reason.length > 200) {
    return { ok: false, error: { error: "reason required (4-200 chars)" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }

  // Find active block.
  const { data: blocks } = await opts.supabase
    .from("training_blocks")
    .select("id, primary_lift, target_value, target_metric, target_unit, start_date, end_date, target_hit_at_week, status")
    .eq("user_id", opts.userId)
    .eq("status", "active")
    .limit(1);
  const block = blocks?.[0];
  if (!block) {
    return {
      ok: false,
      error: {
        error: "You're not in an active block; nothing to close. Use propose_block / commit_block to start a new one.",
        code: "no_active_block",
      },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }

  // Generate the prospective outcome (preview only — no write).
  let prospectiveOutcome: unknown;
  try {
    const { payload } = await generateBlockOutcome({
      supabase: opts.supabase,
      userId: opts.userId,
      blockId: block.id as string,
    });
    prospectiveOutcome = payload;
  } catch (e) {
    return {
      ok: false,
      error: {
        error: `Couldn't compute the block outcome (no qualifying workouts in the block window?). ${String(e)}`,
        code: "outcome_generate_failed",
      },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }

  const closePayload: ProposeCloseBlockInput = {
    blockId: block.id as string,
    reason: i.reason as string,
  };
  const token = signApprovalToken({
    userId: opts.userId,
    action: "close_block",
    payload: closePayload,
  });

  return {
    ok: true,
    data: {
      preview: {
        blockId: block.id as string,
        primary_lift: (block.primary_lift as PrimaryLift | null) ?? null,
        target_value: (block.target_value as number | null) ?? null,
        reason: i.reason as string,
        would_be_outcome: prospectiveOutcome,
      },
      approval_token: token,
    },
    meta: { ms: Date.now() - t0, result_rows: 1, range_days: 35, truncated: false },
  };
}
```

- [ ] **Step 3: Run typecheck**

Run: `cd "/Users/abdelouahedelbied/Health app" && npm run typecheck 2>&1 | tail -5`
Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
git add lib/coach/tools.ts
git commit -m "$(cat <<'EOF'
feat(coach): propose_close_block HMAC tool schema + executor

Adds the propose-side of the close-block-early flow. Lives next to
propose_block / commit_block (Peter's block-level write surface).

Executor:
- Finds the user's active block; rejects with no_active_block when absent
- Runs generateBlockOutcome to produce a preview payload (no write yet)
- Signs HMAC token with action 'close_block' carrying { blockId, reason }
- Returns preview { blockId, primary_lift, target_value, reason,
  would_be_outcome } + approval_token

Commit-side + chat-stream wiring land in subsequent tasks.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: commit_close_block executor

**Files:**
- Modify: `lib/coach/tools.ts` (add `executeCommitCloseBlock`)

- [ ] **Step 1: Add the commit executor below propose_close_block executor**

In `lib/coach/tools.ts`, immediately after the `executeProposeCloseBlock` function added in Task 4, add:

```ts
// ── commit_close_block executor ───────────────────────────────────────────

export async function executeCommitCloseBlock(opts: {
  supabase: SupabaseClient;
  userId: string;
  input: unknown;
}): Promise<ToolResult<{ block_id: string; status: "completed"; outcome_id: string }>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;
  const token = i.approval_token;
  if (typeof token !== "string") {
    return { ok: false, error: { error: "approval_token required" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }

  let envelope;
  try {
    envelope = verifyApprovalToken({ token, userId: opts.userId, action: "close_block" });
  } catch (e) {
    if (e instanceof ApprovalTokenError) {
      return { ok: false, error: { error: approvalTokenUserMessage(e.code), code: e.code }, meta: { ms: Date.now() - t0, range_days: 0 } };
    }
    return { ok: false, error: { error: (e as Error).message, code: "verify_failed" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  if (!envelope.payload || typeof envelope.payload !== "object") {
    return { ok: false, error: { error: "That approval is missing the close-block details. Please re-propose.", code: "missing_payload" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  const p = envelope.payload as ProposeCloseBlockInput;

  // Re-verify the block is still active + owned by this user.
  const { data: blockRow } = await opts.supabase
    .from("training_blocks")
    .select("id, status")
    .eq("id", p.blockId)
    .eq("user_id", opts.userId)
    .maybeSingle();
  if (!blockRow) {
    return { ok: false, error: { error: "Block not found.", code: "no_active_block" }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  if (blockRow.status !== "active") {
    return {
      ok: false,
      error: { error: `Block is already ${blockRow.status}. Nothing to close.`, code: "already_closed" },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }

  // Re-run outcome generation against fresh data (athlete may have logged a
  // workout between propose and commit; we write what's current, not what's
  // in the token).
  let outcomePayload;
  try {
    const result = await generateBlockOutcome({
      supabase: opts.supabase,
      userId: opts.userId,
      blockId: p.blockId,
    });
    outcomePayload = result.payload;
  } catch (e) {
    return {
      ok: false,
      error: {
        error: `Couldn't compute the block outcome at commit time. ${String(e)}`,
        code: "outcome_generate_failed",
      },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }

  // Upsert the block_outcomes row. UNIQUE constraint is on (block_id);
  // ON CONFLICT updates the payload but preserves athlete_acknowledged_at
  // (which the next commit_block will stamp when the next block starts).
  const { data: outcomeRow, error: outcomeErr } = await opts.supabase
    .from("block_outcomes")
    .upsert(
      {
        ...outcomePayload,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "block_id", ignoreDuplicates: false },
    )
    .select("id")
    .single();
  if (outcomeErr || !outcomeRow) {
    return {
      ok: false,
      error: { error: `block_outcomes upsert failed: ${outcomeErr?.message ?? "unknown"}`, code: "outcome_upsert_failed" },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }

  // Flip the block to completed. Idempotent — the WHERE status='active' guard
  // makes re-runs no-op even if a concurrent close just landed.
  const { error: updateErr } = await opts.supabase
    .from("training_blocks")
    .update({
      status: "completed",
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", p.blockId)
    .eq("user_id", opts.userId)
    .eq("status", "active");
  if (updateErr) {
    return {
      ok: false,
      error: { error: `training_blocks update failed: ${updateErr.message}`, code: "block_update_failed" },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }

  return {
    ok: true,
    data: { block_id: p.blockId, status: "completed", outcome_id: outcomeRow.id as string },
    meta: { ms: Date.now() - t0, result_rows: 1, range_days: 35, truncated: false },
  };
}
```

- [ ] **Step 2: Run typecheck**

Run: `cd "/Users/abdelouahedelbied/Health app" && npm run typecheck 2>&1 | tail -5`
Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
git add lib/coach/tools.ts
git commit -m "$(cat <<'EOF'
feat(coach): commit_close_block executor with idempotent upsert

Commit-side of the close-block-early flow. Order:
  1. Verify HMAC token (action='close_block')
  2. Re-check block is still active + owned by user (defense vs stale token)
  3. Re-run generateBlockOutcome against current data (athlete may have
     logged a workout between propose and commit)
  4. UPSERT block_outcomes with ON CONFLICT(block_id) preserving
     athlete_acknowledged_at
  5. UPDATE training_blocks.status='completed' (WHERE status='active'
     guards against concurrent closes — no-op on second run)

Returns { block_id, status: 'completed', outcome_id } so the chat UI can
render a confirmation chip.

Chat-stream dispatcher + tool registration land next task.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Wire close-block tools into chat-stream + PETER_TOOLS

**Files:**
- Modify: `lib/coach/chat-stream.ts` (import executors, add dispatcher cases, extend `PERSIST_RESULT_TOOLS`, extend `modeAllowsTool`)
- Modify: `lib/coach/tools.ts` (add tools to `PETER_TOOLS` array)

- [ ] **Step 1: Import the new executors in chat-stream.ts**

In `lib/coach/chat-stream.ts`, find the import block from `@/lib/coach/tools` (currently lines 27-85). Add `executeProposeCloseBlock` and `executeCommitCloseBlock` to the import list (alphabetical order suggested):

```ts
import {
  executeQueryDailyLogs,
  executeQueryWorkouts,
  ...
  executeComputeAdherence,
  executeGetWeekPrescription,
  executeProposeBlock,
  executeCommitBlock,
  executeProposeCloseBlock,
  executeCommitCloseBlock,
  executeProposeWeekPlan,
  ...
} from "@/lib/coach/tools";
```

- [ ] **Step 2: Add dispatcher cases**

In `lib/coach/chat-stream.ts`, find the existing `} else if (block.name === "commit_block") {...}` case (around line 616-621). Insert new cases immediately after:

```ts
        } else if (block.name === "commit_block") {
          result = await executeCommitBlock({
            supabase: opts.sr,
            userId: opts.userId,
            input: block.input,
          });
        } else if (block.name === "propose_close_block") {
          result = await executeProposeCloseBlock({
            supabase: opts.sr,
            userId: opts.userId,
            input: block.input,
          });
        } else if (block.name === "commit_close_block") {
          result = await executeCommitCloseBlock({
            supabase: opts.sr,
            userId: opts.userId,
            input: block.input,
          });
        } else if (block.name === "propose_week_plan") {
```

- [ ] **Step 3: Add to PERSIST_RESULT_TOOLS**

In `lib/coach/chat-stream.ts`, find the `PERSIST_RESULT_TOOLS` Set (around lines 92-122). Add the two new tools alongside the existing block tools:

```ts
const PERSIST_RESULT_TOOLS = new Set([
  "propose_block",
  "commit_block",
  "propose_close_block",
  "commit_close_block",
  "propose_week_plan",
  "commit_week_plan",
  ...
]);
```

- [ ] **Step 4: Add explicit allows in modeAllowsTool for default mode**

In `lib/coach/chat-stream.ts`, find the `modeAllowsTool` function (around line 314). In the `default mode` section (after the existing explicit allows like `if (name === "propose_nutrition_targets") return true;`), insert:

```ts
    // default mode
    ...
    if (name === "propose_nutrition_targets") return true;
    if (name === "commit_nutrition_targets") return true;
    if (name === "propose_meal_log") return true;
    if (name === "commit_meal_log") return true;
    if (name === "propose_meal_suggestions") return true;
    if (name === "propose_session_today") return true;
    if (name === "commit_session_today") return true;
    if (name === "apply_rotation_override") return true;
    // Close-block tool pair: athlete legitimately initiates from default
    // chat when target is hit early / injury / schedule change. Without
    // these explicit allows the prefix guards below strip them and Peter
    // narrates a fake close in prose with no DB write.
    if (name === "propose_close_block") return true;
    if (name === "commit_close_block") return true;
    if (name === "propose_endurance_week") return true;
    ...
```

(The `plan_week` and `setup_block` modes already allow `propose_*`/`commit_*` via the broad filter, so no edits there.)

- [ ] **Step 5: Add tools to PETER_TOOLS array**

In `lib/coach/tools.ts`, find `export const PETER_TOOLS: readonly ToolSchema[] = [...]` (around line 5300). Insert the new tools immediately after `COMMIT_BLOCK_TOOL`:

```ts
export const PETER_TOOLS: readonly ToolSchema[] = [
  DAILY_LOGS_TOOL,
  WORKOUTS_TOOL,
  FOOD_LOG_TOOL,
  QUERY_EXERCISE_LIBRARY_TOOL,
  GET_SUBSTITUTES_TOOL,
  TRAINING_PLAN_TOOL,
  AUTOREGULATION_TOOL,
  ADHERENCE_TOOL,
  GET_WEEK_PRESCRIPTION_TOOL,
  PROPOSE_BLOCK_TOOL,
  COMMIT_BLOCK_TOOL,
  PROPOSE_CLOSE_BLOCK_TOOL,
  COMMIT_CLOSE_BLOCK_TOOL,
  PROPOSE_WEEK_PLAN_TOOL,
  COMMIT_WEEK_PLAN_TOOL,
  ...
];
```

Do NOT add to CARTER_TOOLS, NORA_TOOLS, or REMI_TOOLS — block-level decisions are Peter's lane only.

- [ ] **Step 6: Run typecheck**

Run: `cd "/Users/abdelouahedelbied/Health app" && npm run typecheck 2>&1 | tail -5`
Expected: zero errors.

- [ ] **Step 7: Commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
git add lib/coach/chat-stream.ts lib/coach/tools.ts
git commit -m "$(cat <<'EOF'
feat(coach): wire close-block tools into Peter's chat surface

- Register PROPOSE_CLOSE_BLOCK_TOOL + COMMIT_CLOSE_BLOCK_TOOL in PETER_TOOLS
  (block-level decisions stay in Peter's lane; not added to Carter/Nora/Remi)
- Add dispatcher cases in chat-stream for the two new executors
- Add both to PERSIST_RESULT_TOOLS so the close-confirmation chip survives
  chat history reload (per 2026-05-21 Nora re-save loop precedent)
- Add explicit default-mode allows in modeAllowsTool — without these the
  prefix guards strip the tools and Peter narrates a fake close

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: PETER_BASE prompt — close-block narration paragraph

**Files:**
- Modify: `lib/coach/system-prompts.ts` (append to PETER_BASE)

- [ ] **Step 1: Add the close-block paragraph to PETER_BASE**

In `lib/coach/system-prompts.ts`, find `export const PETER_BASE = \`...\`;` (starts around line 20). The PETER_BASE template literal ends around line 45. Insert a new paragraph before the closing backtick, after the existing "For block-level decisions..." paragraph:

Find this section:
```
For block-level decisions (progressing to next mesocycle, deload timing, goal shifts), you own them. Call propose_block / commit_block when proposing block-level changes.
```

Replace it with:
```
For block-level decisions (progressing to next mesocycle, deload timing, goal shifts), you own them. Call propose_block / commit_block when proposing block-level changes.

When the athlete asks to close a block early — they hit the target early, the target is unreachable, they're injured, or schedule forces a rotation — call propose_close_block({ reason }). Do NOT prompt them to wait until end_date. The chip surfaces the would-be outcome (block_phase_at_end, rotation recommendation, recommended next target). After they tap Approve and you call commit_close_block, follow up with setup_block mode (or surface the option) to plan the next block.

If propose_block returns target_out_of_bounds, the athlete's target is outside the trend-derived sanity window. The error message names the sanity floor/ceiling and the recommended target. Narrate the math back to the athlete — cite their current e1RM, the observed weekly slope (or coefficient fallback), and the realistic 4-week gain — and ASK why they want to go outside the window before retrying with override_reason. Do NOT silently capitulate to "I want to push harder" without concrete justification. Past miscalibrations (the 2026-05-11 deadlift block hit its 115 e1RM target in week 3 of 5 because the target was set without anchoring to current e1RM) are exactly what the sanity validator exists to prevent.
```

- [ ] **Step 2: Run typecheck**

Run: `cd "/Users/abdelouahedelbied/Health app" && npm run typecheck 2>&1 | tail -5`
Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
git add lib/coach/system-prompts.ts
git commit -m "$(cat <<'EOF'
feat(coach): PETER_BASE — close-block narration + calibration discipline

Two new paragraphs in Peter's prompt:

1. Close-block flow: instructs Peter to call propose_close_block on
   target-hit-early / injury / schedule-change requests rather than
   waiting until end_date. Surfaces the chip → commit_close_block →
   setup_block follow-through.

2. Target_out_of_bounds handling: when propose_block rejects an
   out-of-bounds target, Peter must narrate the math (current e1RM,
   observed slope, realistic 4-week gain) and ask the athlete WHY they
   want to override. Cites the 2026-05-11 deadlift block miscalibration
   as the exemplar of what the validator exists to prevent.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: setup_block context + prompt narration

**Files:**
- Modify: `lib/coach/planning-prompts.ts` (extend `fetchSetupBlockContext` to inject `NEXT_BLOCK_TARGET_RECOMMENDATION`; extend `SETUP_BLOCK_PROMPT` beat-2 with the narration paragraph)

- [ ] **Step 1: Import computeTargetRecommendation in planning-prompts.ts**

In `lib/coach/planning-prompts.ts`, find the existing imports (lines 1-20). Add:

```ts
import { computeTargetRecommendation } from "@/lib/coach/prescription/calibrate-target";
import type { PrimaryLift } from "@/lib/data/types";
```

(Skip the `PrimaryLift` import if it's already imported — check first with `grep -n "PrimaryLift" lib/coach/planning-prompts.ts`. If absent or only-as-string-literal, add it.)

- [ ] **Step 2: Extend fetchSetupBlockContext to inject NEXT_BLOCK_TARGET_RECOMMENDATION**

In `lib/coach/planning-prompts.ts`, find `async function fetchSetupBlockContext(...)` (around line 460). The current implementation reads the most recent unacknowledged `block_outcomes` row and returns a string. Extend it to also compute the trend recommendation for the recommended_next_focus lift:

Replace the existing function body:

```ts
async function fetchSetupBlockContext(
  supabase: SupabaseClient,
  userId: string,
): Promise<string | null> {
  const { data: outcomes } = await supabase
    .from("block_outcomes")
    .select("primary_lift, block_phase_at_end, target_value_kg, end_working_kg, recommended_next_focus, recommended_target_value_kg, lessons, training_blocks!inner(end_date)")
    .eq("user_id", userId)
    .is("athlete_acknowledged_at", null)
    .order("created_at", { ascending: false })
    .limit(1);
  const row = outcomes?.[0];
  if (!row) return null;
  const tb = (row as unknown as { training_blocks: { end_date: string } | null }).training_blocks;
  const calibrationNote = (row.lessons as { calibration_note?: string } | null)?.calibration_note ?? "";

  // Also compute trend-derived recommendation for the recommended_next_focus
  // lift, so Carter narrates a number anchored in the athlete's actual
  // realized data (not just the rotation-based recalibrate-target.ts output).
  let recommendationLines: string[] = [];
  if (row.recommended_next_focus) {
    try {
      const todayIso = todayInUserTz();
      const rec = await computeTargetRecommendation({
        supabase,
        userId,
        lift: row.recommended_next_focus as PrimaryLift,
        todayIso,
      });
      recommendationLines = [
        "",
        "NEXT_BLOCK_TARGET_RECOMMENDATION:",
        `  lift: ${row.recommended_next_focus}`,
        `  current_e1rm: ${rec.current_e1rm ?? "n/a (no logged data)"}`,
        `  observed_slope_kg_per_wk: ${rec.slope_kg_per_wk == null ? "n/a (<3 weeks data)" : rec.slope_kg_per_wk.toFixed(2)}`,
        `  trend_target: ${rec.trend_target ?? "n/a"}`,
        `  math_target: ${rec.math_target ?? "n/a"}`,
        `  used: ${rec.used}`,
        `  recommended_target: ${rec.recommended_target ?? "n/a"}`,
        `  sanity_bounds: ${rec.sanity_bounds == null ? "n/a" : `[${rec.sanity_bounds[0]}, ${rec.sanity_bounds[1]}]`}`,
      ];
    } catch {
      // Don't block setup_block context on a transient compute failure.
      recommendationLines = ["", "NEXT_BLOCK_TARGET_RECOMMENDATION: (compute failed; use rotation-based recommended_target_value_kg above)"];
    }
  }

  return [
    "BLOCK_OUTCOME_CONTEXT:",
    `  primary_lift: ${row.primary_lift}`,
    `  block_phase_at_end: ${row.block_phase_at_end}`,
    `  target_value_kg: ${row.target_value_kg}`,
    `  end_working_kg: ${row.end_working_kg}`,
    `  end_date: ${tb?.end_date ?? "n/a"}`,
    `  recommended_next_focus: ${row.recommended_next_focus}`,
    `  recommended_target_value_kg: ${row.recommended_target_value_kg}`,
    `  calibration_note: ${calibrationNote}`,
    ...recommendationLines,
  ].join("\n");
}
```

- [ ] **Step 3: Extend SETUP_BLOCK_PROMPT beat 2 with the calibration narration paragraph**

In `lib/coach/planning-prompts.ts`, find `const SETUP_BLOCK_PROMPT = \`...\`;` (starts around line 103). Find beat 2 (`ELICIT`). After the existing "If NO BLOCK_OUTCOME_CONTEXT block is present..." paragraph, BEFORE the section ends with `### Beat 3`-equivalent or `3. **PROPOSE**`, insert a new paragraph:

Locate this part of the prompt template:
```
   If NO BLOCK_OUTCOME_CONTEXT block is present (first-ever block, OR most recent outcome already acknowledged), fall back to today's behavior: ask the user for their lift focus + target directly. Single primary lift only (squat / bench / deadlift / ohp). Target metric is e1RM or working_weight in kg. Also ask for free-form goal_text (1-2 sentences) for any nuance the structure can't capture.

3. **PROPOSE** the block.
```

Replace with:
```
   If NO BLOCK_OUTCOME_CONTEXT block is present (first-ever block, OR most recent outcome already acknowledged), fall back to today's behavior: ask the user for their lift focus + target directly. Single primary lift only (squat / bench / deadlift / ohp). Target metric is e1RM or working_weight in kg. Also ask for free-form goal_text (1-2 sentences) for any nuance the structure can't capture.

   **Target calibration narration (REQUIRED when NEXT_BLOCK_TARGET_RECOMMENDATION is present in your context):** Cite the recommendation by name, the athlete's current e1RM, AND the math that produced it. E.g.: *"Your decline bench is at 80.7 e1RM; trend over 6 weeks is +1.45 kg/wk. Recommended target for a 4-week-progression focus block is 86 kg e1RM. That hits around week 4 if execution is clean — sanity floor is 82.5, ceiling is 85.5."* Always recommend a number INSIDE the sanity_bounds window. If the athlete proposes a target outside the bounds, propose_block will return target_out_of_bounds — at that point ask why they want to override, take their stated reason, and pass it as override_reason on the retry. Do NOT silently capitulate to "I want to push harder" without a concrete justification (returning from layoff, meet attempt, specific peaking timeline, etc.). The validator exists to prevent the 2026-05-11 miscalibration class (target hit by week 3 of 5).

3. **PROPOSE** the block.
```

- [ ] **Step 4: Run typecheck**

Run: `cd "/Users/abdelouahedelbied/Health app" && npm run typecheck 2>&1 | tail -5`
Expected: zero errors.

- [ ] **Step 5: Commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
git add lib/coach/planning-prompts.ts
git commit -m "$(cat <<'EOF'
feat(coach): setup_block surfaces trend-derived target recommendation

fetchSetupBlockContext now computes computeTargetRecommendation for the
recommended_next_focus lift and emits a NEXT_BLOCK_TARGET_RECOMMENDATION
block alongside BLOCK_OUTCOME_CONTEXT. Carter (during setup_block mode)
sees current e1RM, observed slope, trend/math targets, and sanity bounds
inline in his prompt.

SETUP_BLOCK_PROMPT beat 2 adds a REQUIRED narration paragraph that
instructs Carter to cite the recommendation explicitly, recommend inside
the sanity_bounds window, and handle target_out_of_bounds rejections by
asking for an override_reason rather than silently capitulating.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: CLAUDE.md architecture note

**Files:**
- Modify: `CLAUDE.md` (add bullet under "Weekly planning v1" section)

- [ ] **Step 1: Find the "Deterministic prescription pipeline" bullet**

In `CLAUDE.md`, search for `- **Deterministic prescription pipeline**` (this is the bullet added in commit `0533eb6`). Add a new sibling bullet immediately after it:

```
- **Block close-early + target calibration validator** (this arc, 2026-05-31): `propose_close_block` / `commit_close_block` HMAC chat-tool pair in [lib/coach/tools.ts](lib/coach/tools.ts) closes an active `training_blocks` row before `end_date` and writes its `block_outcomes` row in one operation — no SQL required. Peter-owned (block-level lane); registered in `PETER_TOOLS` only. The token's action is `"close_block"`. Idempotent: UPSERT on `block_outcomes(block_id)`, conditional UPDATE on `training_blocks WHERE status='active'`. `executeProposeBlock` now calls [computeTargetRecommendation](lib/coach/prescription/calibrate-target.ts) before signing — pulls 90d of realized non-warmup working sets, computes OLS slope on per-week max Brzycki e1RM, returns trend_target (`current + slope×4`) when slope > 0, otherwise math_target via the per-lift × phase COEFFICIENT_TABLE (deadlift 1.5 / squat 1.25 / bench 0.75 / ohp 0.4 kg/wk under cut). Sanity bounds `[current+1, current+coef×4×1.5]` reject obviously-miscalibrated targets unless `propose_block` is retried with an explicit `override_reason`. `fetchSetupBlockContext` in [lib/coach/planning-prompts.ts](lib/coach/planning-prompts.ts) injects `NEXT_BLOCK_TARGET_RECOMMENDATION` so Carter in `setup_block` mode narrates the recommendation back to the athlete (current e1RM, observed slope, trend/math targets, sanity bounds). PETER_BASE teaches the close-block flow + the out-of-bounds narration discipline. Audit assertions in [scripts/audit-prescription-rules.mjs](scripts/audit-prescription-rules.mjs) cover the pure helpers (OLS, grid rounding, sanity bounds). Spec: [docs/superpowers/specs/2026-05-31-block-close-and-target-calibration-design.md](docs/superpowers/specs/2026-05-31-block-close-and-target-calibration-design.md).
```

- [ ] **Step 2: Commit**

```bash
cd "/Users/abdelouahedelbied/Health app"
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
docs(claude-md): close-block flow + target calibration validator

Architecture note under "Weekly planning v1" documenting the new
propose_close_block / commit_close_block HMAC tool pair and the
trend-derived sanity-bounds validator inside executeProposeBlock.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Final typecheck + audit + push

**Files:** none (deployment task)

- [ ] **Step 1: Final typecheck**

Run: `cd "/Users/abdelouahedelbied/Health app" && npm run typecheck 2>&1 | tail -10`
Expected: zero errors.

- [ ] **Step 2: Final audit run**

Run: `cd "/Users/abdelouahedelbied/Health app" && node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs 2>&1 | tail -10`
Expected: `83 passed, 0 failed.` (67 baseline + 16 new from calibrate-target).

- [ ] **Step 3: Verify all commits are on main and ahead of origin**

Run: `cd "/Users/abdelouahedelbied/Health app" && git log origin/main..HEAD --oneline`
Expected: 9 commits (Tasks 1-9), each with the `Co-Authored-By: Claude Opus 4.7` trailer.

- [ ] **Step 4: Push to main (Vercel auto-deploys)**

Run: `cd "/Users/abdelouahedelbied/Health app" && git push origin main 2>&1 | tail -5`
Expected: successful push, `<old_sha>..<new_sha>  main -> main`.

- [ ] **Step 5: Verify push landed**

Run: `cd "/Users/abdelouahedelbied/Health app" && git fetch origin && git log origin/main --oneline -10`
Expected: most recent 9 commits visible on `origin/main`.

---

## Task 11: One-shot operational sequence (after deploy lands)

**Files:** none — runs via chat against the deployed app

**Wait for Vercel deploy to complete** (typically 1-2 minutes after the push in Task 10). Once the dashboard URL serves the new build, the chat tools are available.

- [ ] **Step 1: In Peter chat, close the current deadlift block**

Open the chat surface. Pick Peter as the speaker. Send:

```
Close the deadlift block — we hit 115 e1RM in week 3, the block was calibrated too low, and we want to recalibrate with bench next.
```

Expected sequence:
1. Peter calls `propose_close_block({ reason: "..." })`
2. A confirmation chip appears showing the would-be outcome (`block_phase_at_end='hit_early'`, recommended next focus = bench, etc.)
3. Tap **Approve** on the chip → Peter calls `commit_close_block(token)`
4. Peter confirms: "Block closed. Outcome row written. Want to plan the next block?"

- [ ] **Step 2: Verify the DB state**

Run:
```bash
cd "/Users/abdelouahedelbied/Health app" && node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local -e "
const {createClient} = await import('@supabase/supabase-js');
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const {data: blocks} = await sb.from('training_blocks').select('id, status, completed_at, primary_lift, target_hit_at_week').eq('user_id', '94fee5c6-7d9a-4b05-be3a-8407505b5429').order('created_at', {ascending: false}).limit(2);
console.log('blocks:', JSON.stringify(blocks, null, 2));
const {data: outcomes} = await sb.from('block_outcomes').select('id, primary_lift, block_phase_at_end, recommended_next_focus, recommended_target_value_kg, athlete_acknowledged_at').eq('user_id', '94fee5c6-7d9a-4b05-be3a-8407505b5429').order('created_at', {ascending: false}).limit(1);
console.log('outcome:', JSON.stringify(outcomes, null, 2));
"
```

Expected: deadlift block shows `status: 'completed'`, `completed_at: <today>`. block_outcomes row exists with `primary_lift: 'deadlift'`, `block_phase_at_end: 'hit_early'`, `recommended_next_focus: 'bench'`, `athlete_acknowledged_at: null` (will be stamped when next block is committed).

- [ ] **Step 3: Start the bench block via setup_block mode**

In chat, switch to setup_block mode (URL `?mode=setup_block` or via the block-setup CTA on /coach). Send:

```
Plan the next block — bench focus, 4-week progression then deload, start Mon Jun 8, target 85 kg e1RM.
```

Expected sequence:
1. Carter reads `BLOCK_OUTCOME_CONTEXT` + `NEXT_BLOCK_TARGET_RECOMMENDATION` from his prompt context
2. Carter narrates the recommendation explicitly ("current decline bench e1RM 80.7, observed slope +1.45 kg/wk, trend target 86 kg e1RM, recommended 85 within sanity bounds [82.5, 85]")
3. Carter calls `propose_block({ primary_lift: 'bench', target_metric: 'e1rm', target_value: 85, target_unit: 'kg', start_date: '2026-06-08', end_date: '2026-07-12', goal_text: '...' })`
4. Validator passes (85 ∈ [82.5, 85])
5. Approval chip appears → tap Approve → `commit_block` writes the new active block + stamps `athlete_acknowledged_at` on the deadlift outcome row.

- [ ] **Step 4: Verify the new block + acknowledged outcome**

Run the same DB inspection from Step 2. Expected: a new `training_blocks` row with `status: 'active'`, `primary_lift: 'bench'`, `target_metric: 'e1rm'`, `target_value: 85`, `start_date: '2026-06-08'`, `end_date: '2026-07-12'`. The deadlift outcome row now has `athlete_acknowledged_at: <timestamp>`.

- [ ] **Step 5: Optional — trigger first prescription generation immediately**

The Sunday cron (`/api/coach/sunday-prescriptions/sync`) at 03:30 UTC will populate the bench block's first week prescription. To avoid waiting, ask Peter or Carter:

```
Show me next week's bench session prescription.
```

Carter will call `get_week_prescription({ week: 'next', persist: true })` which runs `prescribeWeek` against the new active block and writes the `session_prescriptions` row for Mon Jun 8.

- [ ] **Step 6: Confirm to user**

Surface the new state in chat:
- deadlift block: closed (block_phase_at_end='hit_early')
- bench block: active, target 85 kg e1RM, runs Jun 8 → Jul 12
- this week (Jun 1-7): bridge deload, no formal prescription, self-directed light maintenance
- Sunday Jun 7 evening: bench week-1 prescription auto-generates (or already done in Step 5)

---

## Self-review (run before handoff)

**Spec coverage:**
- B1 close_block_early tool → Tasks 4, 5, 6 (schema, executors, wiring)
- B2 calibrate-target helper → Tasks 1, 2 (pure helpers + orchestrator + audit)
- B3 executeProposeBlock validator → Task 3
- B4 setup_block context + prompt → Task 8
- PETER_BASE close-block narration → Task 7
- CLAUDE.md note → Task 9
- Audit assertions → Task 2 (16 new assertions)
- One-shot operational sequence → Task 11
- ✓ All spec components mapped to tasks.

**Placeholder scan:** No TBD/TODO/incomplete sections. All code blocks complete. All commit messages contain the Co-Authored-By trailer.

**Type consistency:** `TargetRecommendation` defined in Task 1 used in Task 3 (`executeProposeBlock` import + return type). `ProposeCloseBlockInput` defined in Task 4 used in Task 5 (`executeCommitCloseBlock` envelope cast). `PRIMARY_LIFT_NAME_PATTERNS` re-used from `current-comparison-value.ts` (already shipped). Field names consistent: `current_e1rm`, `slope_kg_per_wk`, `trend_target`, `math_target`, `used`, `recommended_target`, `sanity_bounds`, `override_reason`, `block_id`, `outcome_id`.
