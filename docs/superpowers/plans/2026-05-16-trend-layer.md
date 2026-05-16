# Trend Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship sub-project #5 of the coach-as-real-coach arc — a new `/coach/trends` page with 3 sections (Performance / Composition / Cross), backed by a new `lib/coach/trends/` compute module. The compute deepens the weekly review's §4 trend signals with per-lift e1RM slopes (4w + 12w via OLS), plateau spans, body-comp rates, nutrition adherence %s, recovery averages, and two cross-metric correlations rendered as plain-English insight prose.

**Architecture:** Pure derivation from existing data — no new tables, no migration, no Anthropic calls. New `lib/coach/trends/` mirrors `lib/coach/weekly-review/`'s composer pattern (pure functions, one orchestrator, audit script). UI reuses the existing `components/charts/` primitives (`LineChart`, `MetricCard`, `DetailChartCard`) — the new `components/coach/trends/` directory holds section-organizing layout components only. Four PRs stack on a single feature branch.

**Tech Stack:** Next.js 15 App Router, Supabase (read-only service-role for compute), TanStack Query (hybrid SSR-hydrate), Tailwind v4. No new dependencies.

**Spec:** [docs/superpowers/specs/2026-05-16-trend-layer-design.md](../specs/2026-05-16-trend-layer-design.md).

---

## Pre-flight

- [ ] **Pre-flight 1: Create feature branch off main**

  ```bash
  cd "/Users/abdelouahedelbied/Health app"
  git checkout main
  git pull origin main
  git checkout -b feat/coach-trends
  ```

- [ ] **Pre-flight 2: Verify clean baseline**

  ```bash
  npm run typecheck
  ```

  Expected: exits 0.

- [ ] **Pre-flight 3: Verify the dev fixture is still in place**

  Sub-project #1's fixture should be live (block at start_date=2026-05-04, weekly_review at week_start=2026-05-04). Sub-project #5's compute consumes the same `daily_logs` / `workouts` / `weekly_reviews` / `training_blocks` rows. Confirm:

  ```bash
  node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local -e "
  import { readFileSync } from 'fs';
  import { createClient } from '@supabase/supabase-js';
  const env = {};
  for (const l of readFileSync('.env.local','utf-8').split('\n')) {
    const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data: blk } = await sb.from('training_blocks').select('start_date, end_date, status').eq('status', 'active').single();
  console.log('Active block:', blk);
  const { count: w } = await sb.from('workouts').select('*', { count: 'exact', head: true });
  console.log('Workouts total:', w);
  const { count: dl } = await sb.from('daily_logs').select('*', { count: 'exact', head: true });
  console.log('daily_logs total:', dl);
  "
  ```

  Expected: active block at 2026-05-04, ≥4 workouts, ≥30 daily_logs rows. If empty, restore via `memory/project_weekly_review_dev_fixture.md`.

- [ ] **Pre-flight 4: Verify existing chart primitives we'll reuse**

  ```bash
  ls components/charts/
  grep -n "^export" components/charts/LineChart.tsx components/charts/MetricCard.tsx | head -10
  ```

  Expected: `LineChart.tsx`, `MetricCard.tsx`, `DetailChartCard.tsx` all present. PR 3 reuses these — confirm they exist before relying on them.

---

## File Structure

**New files (15):**

| Path | Purpose |
|---|---|
| `lib/coach/trends/linear-regression.ts` | Pure OLS util — `linearRegression(points)` |
| `lib/coach/trends/compose-strength.ts` | Per-lift e1RM weekly peaks → 4w/12w slopes + plateau detection |
| `lib/coach/trends/compose-body.ts` | Weight / LBM / body-fat-% slopes; target-band check |
| `lib/coach/trends/compose-nutrition.ts` | Per-day target hit/miss aggregation → adherence %s |
| `lib/coach/trends/compose-recovery.ts` | Sleep / HRV / RHR rolling averages; HRV vs baseline |
| `lib/coach/trends/compose-cross.ts` | Two correlation passes with deterministic insight prose |
| `lib/coach/trends/index.ts` | Orchestrator — parallel fetch + assemble payload |
| `scripts/audit-coach-trends.mjs` | Manual exercise script |
| `lib/query/fetchers/coachTrends.ts` | Server + browser fetcher variants |
| `lib/query/hooks/useCoachTrends.ts` | TanStack Query read hook |
| `app/coach/trends/page.tsx` | Server route — SSR-hydrate + auth gate |
| `app/coach/trends/loading.tsx` | Loading skeleton |
| `components/coach/trends/CoachTrendsView.tsx` | Page client container — section state + render |
| `components/coach/trends/TrendsHeader.tsx` | Hero callout — block + headline |
| `components/coach/trends/SectionPills.tsx` | 3-pill nav row (mirrors CoachNav style) |
| `components/coach/trends/PerformanceSection.tsx` | Strength sub-block + Recovery sub-block |
| `components/coach/trends/CompositionSection.tsx` | Body sub-block + Nutrition sub-block |
| `components/coach/trends/CrossSection.tsx` | Two cross-metric insight cards + scatter reveal |
| `components/coach/trends/SectionSubHeader.tsx` | Small label component for sub-block separation |
| `components/coach/trends/WindowToggle.tsx` | 4w / 12w pill toggle (local state) |
| `components/coach/trends/ChangeBadge.tsx` | Color-coded delta pill |
| `components/coach/trends/ScatterChart.tsx` | Custom SVG scatter — for cross-metric drilldown |

(Some of the above might be merged — section components can hold their own ChangeBadge / SectionSubHeader inline if they don't recur.)

**Modified files (6):**

| Path | Change |
|---|---|
| `lib/data/types.ts` | Add `TrendWindow`, `PerLiftSlope`, `StrengthTrend`, `BodyTrend`, `NutritionAdherenceTrend`, `RecoveryTrend`, `CrossInsight`, `CoachTrendsPayload`. Extend `WeeklyReviewTrendSignals` (or equivalent existing type) with 3 optional new fields. |
| `lib/query/keys.ts` | Add `coachTrends.all(userId)` query key namespace |
| `lib/coach/weekly-review/compose-trends.ts` | Call new `lib/coach/trends/` composers to populate the 3 new payload fields |
| `lib/coach/weekly-review/narrative-prompt.ts` | Reference new payload fields in system prompt when present |
| `components/coach/WeeklyReviewTrends.tsx` | Add per-cell drillthrough links to `/coach/trends?section=...` |
| `components/coach/ToolsView.tsx` | Add "View trends" row to REFERENCE section |

---

## Slice 1 — Compute module (`lib/coach/trends/`)

Goal: All five composers + orchestrator + regression util produce sane output against the dev fixture. Audit script runs cleanly. No UI, no consumer integration yet.

### Task 1.1: Add new types to lib/data/types.ts

**Files:**
- Modify: `lib/data/types.ts` (append after Sub-project #1's WeeklyReviewPayload section)

- [ ] **Step 1: Append the new types**

  Open `lib/data/types.ts`. Find the existing `WeeklyReviewPayload` (around the area where Sub-project #1's types live). Append AFTER that section:

  ```ts
  // ── Coach trends (lib/coach/trends/) ────────────────────────────────────────

  export type TrendWindow = "4w" | "12w";

  export type PerLiftSlope = {
    lift: string;                       // "Squat (Barbell)" — matches BIG_FOUR
    e1rm_kg_now: number | null;
    slope_pct_per_wk_4w: number | null;
    slope_pct_per_wk_12w: number | null;
    r_squared_4w: number | null;
    r_squared_12w: number | null;
    plateau_active: boolean;
    plateau_weeks_flat: number;
  };

  export type StrengthTrend = {
    schema_version: 1;
    per_lift: PerLiftSlope[];
    block_phase_now: WeeklyPhase | null;
    on_pace: boolean | null;
  };

  export type BodyTrend = {
    schema_version: 1;
    weight: {
      now_kg: number | null;
      rate_kg_per_wk_4w: number | null;
      rate_kg_per_wk_12w: number | null;
      target_band: { lower: number; upper: number };
      in_band: boolean | null;
    };
    lbm: {
      now_kg: number | null;
      delta_4w_kg: number | null;
      delta_12w_kg: number | null;
    };
    body_fat_pct: {
      now: number | null;
      delta_4w_pct: number | null;
      delta_12w_pct: number | null;
    };
  };

  export type NutritionAdherenceTrend = {
    schema_version: 1;
    protein: {
      target_g: number | null;
      days_hit_4w: number;
      days_total_4w: number;
      pct_4w: number | null;
      pct_12w: number | null;
    };
    kcal: {
      target: number | null;
      days_hit_4w: number;
      days_total_4w: number;
      pct_4w: number | null;
      pct_12w: number | null;
      avg_4w: number | null;
      avg_12w: number | null;
    };
    deficit_kcal: {
      avg_4w: number | null;
      avg_12w: number | null;
    };
  };

  export type RecoveryTrend = {
    schema_version: 1;
    sleep: {
      avg_h_4w: number | null;
      avg_h_12w: number | null;
      avg_efficiency_pct_4w: number | null;
      avg_efficiency_pct_12w: number | null;
    };
    hrv: {
      avg_4w: number | null;
      avg_12w: number | null;
      baseline_30d: number | null;
      vs_baseline_pct_4w: number | null;
    };
    rhr: {
      avg_bpm_4w: number | null;
      avg_bpm_12w: number | null;
      delta_4w_bpm: number | null;
    };
  };

  export type CrossInsight = {
    schema_version: 1;
    pair: "nutrition_x_weight" | "volume_x_recovery";
    window: TrendWindow;
    slope: number;
    intercept: number;
    r_squared: number;
    n_points: number;
    insight_md: string;
    points: Array<{ x: number; y: number; week_start: string }>;
  };

  export type CoachTrendsPayload = {
    schema_version: 1;
    generated_at: string;
    strength: StrengthTrend;
    body: BodyTrend;
    nutrition: NutritionAdherenceTrend;
    recovery: RecoveryTrend;
    cross_insights: CrossInsight[];
    headline: {
      severity: "info" | "warn" | "ok";
      title: string;
      body_md: string;
    };
  };
  ```

- [ ] **Step 2: Extend the weekly review trends type with the 3 new optional fields**

  Find the existing weekly-review trends type (likely inside `WeeklyReviewPayload` definition, the `trends` field's shape). Add three optional fields:

  ```ts
  // Inside the existing weekly-review trends shape, append (preserving existing fields):
    /** Sub-project #5: per-lift slopes via OLS. Populated when the trends
     *  compute layer has enough data; optional for back-compat. */
    per_lift_slope?: PerLiftSlope[];
    /** Sub-project #5: plateau spans per lift. */
    plateau_spans?: Array<{ lift: string; weeks_flat: number; magnitude_pct: number }>;
    /** Sub-project #5: cross-metric insight summaries. */
    cross_insights?: CrossInsight[];
  ```

  Locate the existing trends-on-weekly-review type by searching for `weight_loss_kg_per_week` or `plateau_flags` to find the right type definition. The three fields above are appended optional fields — no rename, no shape change to existing fields.

- [ ] **Step 3: Verify typecheck**

  ```bash
  npm run typecheck
  ```

  Expected: exit 0.

- [ ] **Step 4: Commit**

  ```bash
  git add lib/data/types.ts
  git commit -m "feat(types): coach trends payload types + weekly-review extensions"
  ```

### Task 1.2: linear-regression util

**Files:**
- Create: `lib/coach/trends/linear-regression.ts`

- [ ] **Step 1: Write the util**

  Create `lib/coach/trends/linear-regression.ts`:

  ```ts
  // lib/coach/trends/linear-regression.ts
  //
  // Pure OLS regression on (x, y) point arrays. Used by all five coach-trend
  // composers to derive slopes + R² values.

  export type Point = { x: number; y: number };

  export type RegressionResult = {
    slope: number;
    intercept: number;
    r_squared: number;
    n: number;
  };

  /** Fit y = slope * x + intercept via ordinary least squares.
   *  Returns null when fewer than 2 points OR all x values are identical
   *  (variance of x is zero, slope undefined). */
  export function linearRegression(points: readonly Point[]): RegressionResult | null {
    const n = points.length;
    if (n < 2) return null;

    const meanX = points.reduce((s, p) => s + p.x, 0) / n;
    const meanY = points.reduce((s, p) => s + p.y, 0) / n;

    let num = 0;
    let denX = 0;
    let denY = 0;
    for (const p of points) {
      const dx = p.x - meanX;
      const dy = p.y - meanY;
      num += dx * dy;
      denX += dx * dx;
      denY += dy * dy;
    }

    if (denX === 0) return null;

    const slope = num / denX;
    const intercept = meanY - slope * meanX;
    // r² = (cov(x,y))² / (var(x) * var(y)). When all y are equal (denY = 0),
    // the line is a perfect flat fit and r² is defined as 1.
    const r_squared = denY === 0 ? 1 : (num * num) / (denX * denY);

    return { slope, intercept, r_squared, n };
  }
  ```

- [ ] **Step 2: Verify typecheck**

  ```bash
  npm run typecheck
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add lib/coach/trends/linear-regression.ts
  git commit -m "feat(coach/trends): linearRegression OLS util"
  ```

### Task 1.3: compose-strength

**Files:**
- Create: `lib/coach/trends/compose-strength.ts`

- [ ] **Step 1: Write the composer**

  Create `lib/coach/trends/compose-strength.ts`:

  ```ts
  // lib/coach/trends/compose-strength.ts
  //
  // Per-lift e1RM trend computation. Reads the last 12 weeks of workouts,
  // computes weekly e1RM peaks per big-four lift, fits OLS slopes for 4w
  // and 12w windows, and detects plateaus (3+ consecutive weeks within
  // 1.5% of each other). Skips deload weeks when computing plateau spans
  // so an intentional light week doesn't fire a false plateau.

  import type { SupabaseClient } from "@supabase/supabase-js";
  import type { StrengthTrend, PerLiftSlope, WeeklyPhase } from "@/lib/data/types";
  import { BIG_FOUR } from "@/lib/coach/big-four";
  import { epley } from "@/lib/coach/derived";
  import { mondayOf } from "@/lib/coach/weekly-review/date-utils";
  import { linearRegression, type Point } from "./linear-regression";

  const PLATEAU_THRESHOLD_PCT = 0.015;  // 1.5% — matches sub-project #1
  const PLATEAU_MIN_WEEKS = 3;

  type WeeklySet = {
    week_start: string;
    lift: string;
    top_e1rm_kg: number;
  };

  export async function composeStrength(args: {
    supabase: SupabaseClient;
    userId: string;
    today: string;             // "YYYY-MM-DD"
  }): Promise<StrengthTrend> {
    const { supabase, userId, today } = args;

    const windowStart12w = shiftDays(today, -7 * 12);

    const { data: workouts, error: wErr } = await supabase
      .from("workouts")
      .select("date, type, exercises (name, sets:exercise_sets (kg, reps, warmup))")
      .eq("user_id", userId)
      .gte("date", windowStart12w)
      .lte("date", today);
    if (wErr) throw wErr;

    // Per-week peak e1RM per big-four lift.
    const weeklyPeaks = new Map<string, Map<string, number>>(); // lift -> (weekStart -> peakE1rm)
    for (const lift of BIG_FOUR) weeklyPeaks.set(lift, new Map());

    type Row = {
      date: string;
      exercises: Array<{
        name: string;
        sets: Array<{ kg: number | null; reps: number | null; warmup: boolean }>;
      }>;
    };

    for (const row of (workouts as Row[] | null) ?? []) {
      const wk = mondayOf(row.date);
      for (const ex of row.exercises) {
        if (!BIG_FOUR.includes(ex.name)) continue;
        let peak = 0;
        for (const s of ex.sets) {
          if (s.warmup) continue;
          const e = epley(s.kg, s.reps);
          if (e != null && e > peak) peak = e;
        }
        if (peak === 0) continue;
        const liftMap = weeklyPeaks.get(ex.name)!;
        const existing = liftMap.get(wk) ?? 0;
        if (peak > existing) liftMap.set(wk, peak);
      }
    }

    // Deload-week filter: read training_weeks.research_phase for the 12-week window.
    const { data: tws } = await supabase
      .from("training_weeks")
      .select("week_start, research_phase")
      .eq("user_id", userId)
      .gte("week_start", windowStart12w)
      .lte("week_start", today);
    const deloadWeeks = new Set<string>(
      ((tws as { week_start: string; research_phase: string | null }[] | null) ?? [])
        .filter((r) => r.research_phase === "deload")
        .map((r) => r.week_start)
    );

    // Block context (for `block_phase_now` + `on_pace`).
    const { data: block } = await supabase
      .from("training_blocks")
      .select("research_phase, start_date, end_date, status, goal_text")
      .eq("user_id", userId)
      .eq("status", "active")
      .maybeSingle();

    const perLift: PerLiftSlope[] = BIG_FOUR.map((lift) =>
      computeLiftSlope(lift, weeklyPeaks.get(lift)!, deloadWeeks, today)
    );

    return {
      schema_version: 1,
      per_lift: perLift,
      block_phase_now: block?.research_phase === "deload" ? "deload" : null,
      on_pace: null,  // headline picker computes this separately if needed
    };
  }

  function computeLiftSlope(
    lift: string,
    weeklyPeaks: Map<string, number>,
    deloadWeeks: Set<string>,
    today: string,
  ): PerLiftSlope {
    const baseMonday = mondayOf(today);

    // Sort week starts ascending.
    const sortedWeeks = [...weeklyPeaks.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]));

    if (sortedWeeks.length === 0) {
      return {
        lift,
        e1rm_kg_now: null,
        slope_pct_per_wk_4w: null,
        slope_pct_per_wk_12w: null,
        r_squared_4w: null,
        r_squared_12w: null,
        plateau_active: false,
        plateau_weeks_flat: 0,
      };
    }

    const e1rmNow = sortedWeeks[sortedWeeks.length - 1][1];

    // OLS over the last N weeks, x = week index (0 = oldest of window), y = e1rm.
    const fitWindow = (weeks: number) => {
      const recent = sortedWeeks.slice(-weeks);
      if (recent.length < 2) return null;
      const points: Point[] = recent.map(([wkStart, e1rm], idx) => ({
        x: idx,
        y: e1rm,
      }));
      const meanY = points.reduce((s, p) => s + p.y, 0) / points.length;
      if (meanY === 0) return null;
      const reg = linearRegression(points);
      if (!reg) return null;
      return {
        slope_pct_per_wk: reg.slope / meanY,
        r_squared: reg.r_squared,
      };
    };

    const fit4w = fitWindow(4);
    const fit12w = fitWindow(12);

    // Plateau detection — last 3+ non-deload weeks within 1.5% of each other.
    const nonDeload = sortedWeeks.filter(([wk]) => !deloadWeeks.has(wk));
    const tail = nonDeload.slice(-12);  // look back up to 12 weeks
    let plateauWeeks = 0;
    if (tail.length >= PLATEAU_MIN_WEEKS) {
      // Walk backward from the last week; count consecutive within-threshold weeks.
      const last = tail[tail.length - 1][1];
      for (let i = tail.length - 1; i >= 0; i--) {
        const e = tail[i][1];
        if (last > 0 && Math.abs(e - last) / last <= PLATEAU_THRESHOLD_PCT) {
          plateauWeeks++;
        } else {
          break;
        }
      }
    }

    return {
      lift,
      e1rm_kg_now: e1rmNow,
      slope_pct_per_wk_4w: fit4w?.slope_pct_per_wk ?? null,
      slope_pct_per_wk_12w: fit12w?.slope_pct_per_wk ?? null,
      r_squared_4w: fit4w?.r_squared ?? null,
      r_squared_12w: fit12w?.r_squared ?? null,
      plateau_active: plateauWeeks >= PLATEAU_MIN_WEEKS,
      plateau_weeks_flat: plateauWeeks,
    };
  }

  function shiftDays(d: string, days: number): string {
    const dt = new Date(d + "T12:00:00Z");
    dt.setUTCDate(dt.getUTCDate() + days);
    return dt.toISOString().slice(0, 10);
  }
  ```

- [ ] **Step 2: Verify typecheck**

  ```bash
  npm run typecheck
  ```

  If `epley` import surprises you (it should be at `lib/coach/derived.ts`), confirm:

  ```bash
  grep -n "export.*epley" lib/coach/derived.ts
  ```

  If the signature is `epley(kg: number, reps: number)` not `epley(kg: number | null, reps: number | null)`, add a null-guard wrapper at call site.

- [ ] **Step 3: Commit**

  ```bash
  git add lib/coach/trends/compose-strength.ts
  git commit -m "feat(coach/trends): per-lift e1RM slope + plateau detection"
  ```

### Task 1.4: compose-body

**Files:**
- Create: `lib/coach/trends/compose-body.ts`

- [ ] **Step 1: Write the composer**

  Create `lib/coach/trends/compose-body.ts`:

  ```ts
  // lib/coach/trends/compose-body.ts
  //
  // Weight / LBM / body-fat-% trends from daily_logs.

  import type { SupabaseClient } from "@supabase/supabase-js";
  import type { BodyTrend } from "@/lib/data/types";
  import { linearRegression, type Point } from "./linear-regression";

  const DEFAULT_TARGET_BAND: BodyTrend["weight"]["target_band"] = {
    lower: -0.7,
    upper: -0.2,
  };

  export async function composeBody(args: {
    supabase: SupabaseClient;
    userId: string;
    today: string;
  }): Promise<BodyTrend> {
    const { supabase, userId, today } = args;

    const windowStart12w = shiftDays(today, -7 * 12);

    const { data: logs, error } = await supabase
      .from("daily_logs")
      .select("date, weight_kg, fat_free_mass_kg, body_fat_pct")
      .eq("user_id", userId)
      .gte("date", windowStart12w)
      .lte("date", today)
      .order("date", { ascending: true });
    if (error) throw error;

    type Row = {
      date: string;
      weight_kg: number | null;
      fat_free_mass_kg: number | null;
      body_fat_pct: number | null;
    };
    const rows = (logs as Row[] | null) ?? [];

    const todayDate = new Date(today + "T12:00:00Z").getTime();
    const dayIndex = (d: string) =>
      Math.round((new Date(d + "T12:00:00Z").getTime() - todayDate) / (24 * 3600 * 1000));

    const window4wCutoff = shiftDays(today, -28);

    // Build point series per metric.
    const wPoints4w: Point[] = [];
    const wPoints12w: Point[] = [];
    for (const r of rows) {
      if (r.weight_kg == null) continue;
      const xi = dayIndex(r.date);
      const p: Point = { x: xi, y: r.weight_kg };
      wPoints12w.push(p);
      if (r.date >= window4wCutoff) wPoints4w.push(p);
    }

    const w4 = linearRegression(wPoints4w);
    const w12 = linearRegression(wPoints12w);

    // Slopes are kg/day; convert to kg/week.
    const weightRate4w = w4 ? w4.slope * 7 : null;
    const weightRate12w = w12 ? w12.slope * 7 : null;

    const inBand = weightRate4w != null
      ? weightRate4w >= DEFAULT_TARGET_BAND.lower && weightRate4w <= DEFAULT_TARGET_BAND.upper
      : null;

    // LBM + body fat — deltas over the window.
    const lbmRows = rows.filter((r) => r.fat_free_mass_kg != null);
    const lbmNow = lbmRows.length > 0 ? lbmRows[lbmRows.length - 1].fat_free_mass_kg : null;
    const lbm4wStart = lbmRows.find((r) => r.date >= window4wCutoff);
    const lbm12wStart = lbmRows[0];
    const lbmDelta4w = lbmNow != null && lbm4wStart?.fat_free_mass_kg != null
      ? lbmNow - lbm4wStart.fat_free_mass_kg
      : null;
    const lbmDelta12w = lbmNow != null && lbm12wStart?.fat_free_mass_kg != null
      ? lbmNow - lbm12wStart.fat_free_mass_kg
      : null;

    const bfRows = rows.filter((r) => r.body_fat_pct != null);
    const bfNow = bfRows.length > 0 ? bfRows[bfRows.length - 1].body_fat_pct : null;
    const bf4wStart = bfRows.find((r) => r.date >= window4wCutoff);
    const bf12wStart = bfRows[0];
    const bfDelta4w = bfNow != null && bf4wStart?.body_fat_pct != null
      ? bfNow - bf4wStart.body_fat_pct
      : null;
    const bfDelta12w = bfNow != null && bf12wStart?.body_fat_pct != null
      ? bfNow - bf12wStart.body_fat_pct
      : null;

    return {
      schema_version: 1,
      weight: {
        now_kg: rows.findLast?.((r) => r.weight_kg != null)?.weight_kg ?? rows.filter((r) => r.weight_kg != null).pop()?.weight_kg ?? null,
        rate_kg_per_wk_4w: weightRate4w,
        rate_kg_per_wk_12w: weightRate12w,
        target_band: DEFAULT_TARGET_BAND,
        in_band: inBand,
      },
      lbm: {
        now_kg: lbmNow,
        delta_4w_kg: lbmDelta4w,
        delta_12w_kg: lbmDelta12w,
      },
      body_fat_pct: {
        now: bfNow,
        delta_4w_pct: bfDelta4w,
        delta_12w_pct: bfDelta12w,
      },
    };
  }

  function shiftDays(d: string, days: number): string {
    const dt = new Date(d + "T12:00:00Z");
    dt.setUTCDate(dt.getUTCDate() + days);
    return dt.toISOString().slice(0, 10);
  }
  ```

- [ ] **Step 2: Verify typecheck**

  ```bash
  npm run typecheck
  ```

  Note: `Array.prototype.findLast` may need a node lib polyfill. If TS complains, replace with the `.filter().pop()` fallback (already in the snippet).

- [ ] **Step 3: Commit**

  ```bash
  git add lib/coach/trends/compose-body.ts
  git commit -m "feat(coach/trends): body composition rates + target band"
  ```

### Task 1.5: compose-nutrition

**Files:**
- Create: `lib/coach/trends/compose-nutrition.ts`

- [ ] **Step 1: Write the composer**

  Create `lib/coach/trends/compose-nutrition.ts`:

  ```ts
  // lib/coach/trends/compose-nutrition.ts
  //
  // Nutrition adherence + deficit magnitude trends.

  import type { SupabaseClient } from "@supabase/supabase-js";
  import type { NutritionAdherenceTrend } from "@/lib/data/types";
  import { getTodayTargets } from "@/lib/morning/brief/get-today-targets";

  const KCAL_HIT_TOLERANCE = 0.05;  // ±5% of target = "hit"

  export async function composeNutrition(args: {
    supabase: SupabaseClient;
    userId: string;
    today: string;
  }): Promise<NutritionAdherenceTrend> {
    const { supabase, userId, today } = args;

    const windowStart12w = shiftDays(today, -7 * 12);
    const window4wCutoff = shiftDays(today, -28);

    const { data: logs, error } = await supabase
      .from("daily_logs")
      .select("date, calories_eaten, protein_g")
      .eq("user_id", userId)
      .gte("date", windowStart12w)
      .lte("date", today)
      .order("date", { ascending: true });
    if (error) throw error;

    const targets = await getTodayTargets(supabase, userId);
    const proteinTarget = targets?.protein_g ?? null;
    const kcalTarget = targets?.kcal ?? null;

    type Row = { date: string; calories_eaten: number | null; protein_g: number | null };
    const rows = (logs as Row[] | null) ?? [];

    function countHits(
      rows: Row[],
      keyFn: (r: Row) => number | null,
      hit: (v: number) => boolean,
    ): { hits: number; total: number } {
      let h = 0;
      let t = 0;
      for (const r of rows) {
        const v = keyFn(r);
        if (v == null) continue;
        t++;
        if (hit(v)) h++;
      }
      return { hits: h, total: t };
    }

    const protein4w = countHits(
      rows.filter((r) => r.date >= window4wCutoff),
      (r) => r.protein_g,
      (v) => proteinTarget != null && v >= proteinTarget,
    );
    const protein12w = countHits(
      rows,
      (r) => r.protein_g,
      (v) => proteinTarget != null && v >= proteinTarget,
    );

    const kcal4w = countHits(
      rows.filter((r) => r.date >= window4wCutoff),
      (r) => r.calories_eaten,
      (v) => kcalTarget != null && Math.abs(v - kcalTarget) / kcalTarget <= KCAL_HIT_TOLERANCE,
    );
    const kcal12w = countHits(
      rows,
      (r) => r.calories_eaten,
      (v) => kcalTarget != null && Math.abs(v - kcalTarget) / kcalTarget <= KCAL_HIT_TOLERANCE,
    );

    const avg = (xs: number[]) => xs.length > 0 ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
    const kcalAvg4w = avg(
      rows.filter((r) => r.date >= window4wCutoff && r.calories_eaten != null)
        .map((r) => r.calories_eaten as number),
    );
    const kcalAvg12w = avg(
      rows.filter((r) => r.calories_eaten != null).map((r) => r.calories_eaten as number),
    );

    const deficit4w = kcalAvg4w != null && kcalTarget != null ? kcalAvg4w - kcalTarget : null;
    const deficit12w = kcalAvg12w != null && kcalTarget != null ? kcalAvg12w - kcalTarget : null;

    return {
      schema_version: 1,
      protein: {
        target_g: proteinTarget,
        days_hit_4w: protein4w.hits,
        days_total_4w: protein4w.total,
        pct_4w: protein4w.total > 0 ? protein4w.hits / protein4w.total : null,
        pct_12w: protein12w.total > 0 ? protein12w.hits / protein12w.total : null,
      },
      kcal: {
        target: kcalTarget,
        days_hit_4w: kcal4w.hits,
        days_total_4w: kcal4w.total,
        pct_4w: kcal4w.total > 0 ? kcal4w.hits / kcal4w.total : null,
        pct_12w: kcal12w.total > 0 ? kcal12w.hits / kcal12w.total : null,
        avg_4w: kcalAvg4w,
        avg_12w: kcalAvg12w,
      },
      deficit_kcal: {
        avg_4w: deficit4w,
        avg_12w: deficit12w,
      },
    };
  }

  function shiftDays(d: string, days: number): string {
    const dt = new Date(d + "T12:00:00Z");
    dt.setUTCDate(dt.getUTCDate() + days);
    return dt.toISOString().slice(0, 10);
  }
  ```

- [ ] **Step 2: Verify typecheck + commit**

  ```bash
  npm run typecheck
  git add lib/coach/trends/compose-nutrition.ts
  git commit -m "feat(coach/trends): nutrition adherence + deficit magnitude"
  ```

### Task 1.6: compose-recovery

**Files:**
- Create: `lib/coach/trends/compose-recovery.ts`

- [ ] **Step 1: Write the composer**

  Create `lib/coach/trends/compose-recovery.ts`:

  ```ts
  // lib/coach/trends/compose-recovery.ts
  //
  // Sleep / HRV / RHR rolling averages. HRV baseline from profiles.whoop_baselines.

  import type { SupabaseClient } from "@supabase/supabase-js";
  import type { RecoveryTrend } from "@/lib/data/types";

  export async function composeRecovery(args: {
    supabase: SupabaseClient;
    userId: string;
    today: string;
  }): Promise<RecoveryTrend> {
    const { supabase, userId, today } = args;
    const windowStart12w = shiftDays(today, -7 * 12);
    const window4wCutoff = shiftDays(today, -28);
    const window30dCutoff = shiftDays(today, -30);

    const { data: logs, error } = await supabase
      .from("daily_logs")
      .select("date, sleep_hours, sleep_score, hrv, resting_hr")
      .eq("user_id", userId)
      .gte("date", windowStart12w)
      .lte("date", today)
      .order("date", { ascending: true });
    if (error) throw error;

    type Row = {
      date: string;
      sleep_hours: number | null;
      sleep_score: number | null;
      hrv: number | null;
      resting_hr: number | null;
    };
    const rows = (logs as Row[] | null) ?? [];

    const { data: profile } = await supabase
      .from("profiles")
      .select("whoop_baselines")
      .eq("user_id", userId)
      .maybeSingle();
    type WB = { hrv_mean?: number | null } & Record<string, unknown>;
    const wb = (profile?.whoop_baselines as WB | null) ?? null;
    const hrvBaseline = (wb?.hrv_mean as number | undefined) ?? null;

    const avg = (xs: number[]) =>
      xs.length > 0 ? xs.reduce((s, x) => s + x, 0) / xs.length : null;

    const rows4w = rows.filter((r) => r.date >= window4wCutoff);
    const rows30d = rows.filter((r) => r.date >= window30dCutoff);

    const sleep4w = avg(rows4w.filter((r) => r.sleep_hours != null).map((r) => r.sleep_hours as number));
    const sleep12w = avg(rows.filter((r) => r.sleep_hours != null).map((r) => r.sleep_hours as number));
    const eff4w = avg(rows4w.filter((r) => r.sleep_score != null).map((r) => r.sleep_score as number));
    const eff12w = avg(rows.filter((r) => r.sleep_score != null).map((r) => r.sleep_score as number));

    const hrv4w = avg(rows4w.filter((r) => r.hrv != null).map((r) => r.hrv as number));
    const hrv12w = avg(rows.filter((r) => r.hrv != null).map((r) => r.hrv as number));

    const rhr4w = avg(rows4w.filter((r) => r.resting_hr != null).map((r) => r.resting_hr as number));
    const rhr12w = avg(rows.filter((r) => r.resting_hr != null).map((r) => r.resting_hr as number));
    const rhrPrior = avg(
      rows.filter((r) => r.date < window4wCutoff && r.resting_hr != null)
        .slice(-28)
        .map((r) => r.resting_hr as number),
    );

    return {
      schema_version: 1,
      sleep: {
        avg_h_4w: sleep4w,
        avg_h_12w: sleep12w,
        avg_efficiency_pct_4w: eff4w,
        avg_efficiency_pct_12w: eff12w,
      },
      hrv: {
        avg_4w: hrv4w,
        avg_12w: hrv12w,
        baseline_30d: hrvBaseline,
        vs_baseline_pct_4w: hrv4w != null && hrvBaseline != null && hrvBaseline > 0
          ? (hrv4w - hrvBaseline) / hrvBaseline
          : null,
      },
      rhr: {
        avg_bpm_4w: rhr4w,
        avg_bpm_12w: rhr12w,
        delta_4w_bpm: rhr4w != null && rhrPrior != null ? rhr4w - rhrPrior : null,
      },
    };
  }

  function shiftDays(d: string, days: number): string {
    const dt = new Date(d + "T12:00:00Z");
    dt.setUTCDate(dt.getUTCDate() + days);
    return dt.toISOString().slice(0, 10);
  }
  ```

  Note on `sleep_score`: per sub-project #2's discovery, `daily_logs` has `sleep_score` not `sleep_efficiency_pct`. The recovery trend uses `sleep_score` as the efficiency proxy — matches sub-project #1's pattern.

- [ ] **Step 2: Verify typecheck + commit**

  ```bash
  npm run typecheck
  git add lib/coach/trends/compose-recovery.ts
  git commit -m "feat(coach/trends): recovery averages + HRV-vs-baseline"
  ```

### Task 1.7: compose-cross

**Files:**
- Create: `lib/coach/trends/compose-cross.ts`

- [ ] **Step 1: Write the composer**

  Create `lib/coach/trends/compose-cross.ts`:

  ```ts
  // lib/coach/trends/compose-cross.ts
  //
  // Cross-metric correlations (two pairs):
  //   1. nutrition × weight: weekly avg kcal vs weekly weight delta (kg)
  //   2. volume × recovery:  weekly working sets vs next-week HRV avg (lag-1)
  //
  // Each returns 4w and 12w insight cards. R² thresholds:
  //   >= 0.6 → strong, show slope confidently
  //   >= 0.3 → moderate, hedge in prose
  //   <  0.3 → weak, say "no clear relationship"

  import type { SupabaseClient } from "@supabase/supabase-js";
  import type { CrossInsight, TrendWindow } from "@/lib/data/types";
  import { mondayOf } from "@/lib/coach/weekly-review/date-utils";
  import { linearRegression } from "./linear-regression";

  const N_MIN_4W = 4;
  const N_MIN_12W = 8;

  export async function composeCross(args: {
    supabase: SupabaseClient;
    userId: string;
    today: string;
  }): Promise<CrossInsight[]> {
    const { supabase, userId, today } = args;
    const windowStart12w = shiftDays(today, -7 * 12);

    const { data: logs } = await supabase
      .from("daily_logs")
      .select("date, weight_kg, calories_eaten, hrv")
      .eq("user_id", userId)
      .gte("date", windowStart12w)
      .lte("date", today)
      .order("date", { ascending: true });

    const { data: workouts } = await supabase
      .from("workouts")
      .select("date, exercises (sets:exercise_sets (kg, reps, warmup))")
      .eq("user_id", userId)
      .gte("date", windowStart12w)
      .lte("date", today);

    type Log = { date: string; weight_kg: number | null; calories_eaten: number | null; hrv: number | null };
    type Workout = {
      date: string;
      exercises: Array<{ sets: Array<{ kg: number | null; reps: number | null; warmup: boolean }> }>;
    };

    // Group logs by week.
    const weekly = new Map<string, {
      kcalSum: number; kcalDays: number;
      weightStart: number | null; weightEnd: number | null;
      hrvSum: number; hrvDays: number;
      setCount: number;
    }>();
    function getWeek(d: string) {
      const wk = mondayOf(d);
      let cell = weekly.get(wk);
      if (!cell) {
        cell = { kcalSum: 0, kcalDays: 0, weightStart: null, weightEnd: null, hrvSum: 0, hrvDays: 0, setCount: 0 };
        weekly.set(wk, cell);
      }
      return cell;
    }

    for (const l of (logs as Log[] | null) ?? []) {
      const cell = getWeek(l.date);
      if (l.calories_eaten != null) { cell.kcalSum += l.calories_eaten; cell.kcalDays++; }
      if (l.weight_kg != null) {
        if (cell.weightStart == null) cell.weightStart = l.weight_kg;
        cell.weightEnd = l.weight_kg;
      }
      if (l.hrv != null) { cell.hrvSum += l.hrv; cell.hrvDays++; }
    }

    for (const w of (workouts as Workout[] | null) ?? []) {
      const cell = getWeek(w.date);
      for (const ex of w.exercises) {
        for (const s of ex.sets) {
          if (!s.warmup) cell.setCount++;
        }
      }
    }

    const weeks = [...weekly.entries()].sort((a, b) => a[0].localeCompare(b[0]));

    // Build correlation point arrays.
    const nutWeight: Array<{ x: number; y: number; week_start: string }> = [];
    for (const [wk, cell] of weeks) {
      if (cell.kcalDays === 0 || cell.weightStart == null || cell.weightEnd == null) continue;
      nutWeight.push({
        x: cell.kcalSum / cell.kcalDays,                  // avg kcal/day
        y: cell.weightEnd - cell.weightStart,             // kg delta over the week
        week_start: wk,
      });
    }

    const volRec: Array<{ x: number; y: number; week_start: string }> = [];
    for (let i = 0; i < weeks.length - 1; i++) {
      const [wk, cell] = weeks[i];
      const nextCell = weeks[i + 1][1];
      if (cell.setCount === 0 || nextCell.hrvDays === 0) continue;
      volRec.push({
        x: cell.setCount,                                 // weekly working sets
        y: nextCell.hrvSum / nextCell.hrvDays,            // next week's avg HRV
        week_start: wk,
      });
    }

    const insights: CrossInsight[] = [];

    function buildPair(
      pair: CrossInsight["pair"],
      points: typeof nutWeight,
      window: TrendWindow,
    ): CrossInsight | null {
      const nMin = window === "4w" ? N_MIN_4W : N_MIN_12W;
      const slice = window === "4w" ? points.slice(-4) : points.slice(-12);
      if (slice.length < nMin) return null;

      const reg = linearRegression(slice);
      if (!reg) return null;

      const insight_md = pair === "nutrition_x_weight"
        ? nutritionXWeightInsight(reg, window)
        : volumeXRecoveryInsight(reg, window);

      return {
        schema_version: 1,
        pair,
        window,
        slope: reg.slope,
        intercept: reg.intercept,
        r_squared: reg.r_squared,
        n_points: reg.n,
        insight_md,
        points: slice,
      };
    }

    for (const window of ["4w", "12w"] as const) {
      const nw = buildPair("nutrition_x_weight", nutWeight, window);
      if (nw) insights.push(nw);
      const vr = buildPair("volume_x_recovery", volRec, window);
      if (vr) insights.push(vr);
    }

    return insights;
  }

  function nutritionXWeightInsight(
    reg: { slope: number; intercept: number; r_squared: number; n: number },
    window: TrendWindow,
  ): string {
    const wTxt = window === "4w" ? "last 4 weeks" : "last 12 weeks";
    if (reg.r_squared < 0.2) {
      return `Nutrition and weight show no clear relationship in the ${wTxt} (R² ${reg.r_squared.toFixed(2)}). Weekly variance dominates the signal — likely fluid + glycogen rather than fat.`;
    }
    // slope is kg/wk per kcal/day. Convert to per +200 kcal/day for readability.
    const per200 = Math.round(200 * reg.slope * 10) / 10;
    const direction = reg.slope > 0 ? "gain" : "lose";
    const dirAdj = reg.slope > 0 ? "higher" : "lower";
    const hedge = reg.r_squared < 0.6 ? " (moderate signal — week-to-week noise still large)" : "";
    return `When kcal averages ${dirAdj}, you ${direction} weight. Each +200 kcal/day correlates with ${per200 >= 0 ? "+" : ""}${per200} kg/wk over the ${wTxt} (R² ${reg.r_squared.toFixed(2)})${hedge}.`;
  }

  function volumeXRecoveryInsight(
    reg: { slope: number; intercept: number; r_squared: number; n: number },
    window: TrendWindow,
  ): string {
    const wTxt = window === "4w" ? "last 4 weeks" : "last 12 weeks";
    if (reg.r_squared < 0.2) {
      return `Weekly working-set volume isn't strongly correlated with recovery in the ${wTxt} (R² ${reg.r_squared.toFixed(2)}). HRV is likely driven by non-training factors.`;
    }
    const per10sets = Math.round(10 * reg.slope * 10) / 10;
    const direction = reg.slope < 0 ? "lower" : "higher";
    const hedge = reg.r_squared < 0.6 ? " (moderate signal)" : "";
    return `Higher weekly volume tracks with ${direction} next-week HRV. Each +10 working sets correlates with ${per10sets >= 0 ? "+" : ""}${per10sets} HRV points over the ${wTxt} (R² ${reg.r_squared.toFixed(2)})${hedge}.`;
  }

  function shiftDays(d: string, days: number): string {
    const dt = new Date(d + "T12:00:00Z");
    dt.setUTCDate(dt.getUTCDate() + days);
    return dt.toISOString().slice(0, 10);
  }
  ```

- [ ] **Step 2: Verify typecheck + commit**

  ```bash
  npm run typecheck
  git add lib/coach/trends/compose-cross.ts
  git commit -m "feat(coach/trends): cross-metric correlation pairs with insight prose"
  ```

### Task 1.8: Orchestrator index.ts

**Files:**
- Create: `lib/coach/trends/index.ts`

- [ ] **Step 1: Write the orchestrator**

  Create `lib/coach/trends/index.ts`:

  ```ts
  // lib/coach/trends/index.ts
  //
  // Orchestrator: parallel-fetch supabase reads via the 5 composers,
  // pick a headline insight from severity priority, return CoachTrendsPayload.

  import type { SupabaseClient } from "@supabase/supabase-js";
  import type { CoachTrendsPayload } from "@/lib/data/types";
  import { composeStrength } from "./compose-strength";
  import { composeBody } from "./compose-body";
  import { composeNutrition } from "./compose-nutrition";
  import { composeRecovery } from "./compose-recovery";
  import { composeCross } from "./compose-cross";

  export async function generateCoachTrends(args: {
    supabase: SupabaseClient;
    userId: string;
    today: string;
  }): Promise<CoachTrendsPayload> {
    const [strength, body, nutrition, recovery, cross_insights] = await Promise.all([
      composeStrength(args),
      composeBody(args),
      composeNutrition(args),
      composeRecovery(args),
      composeCross(args),
    ]);

    return {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      strength,
      body,
      nutrition,
      recovery,
      cross_insights,
      headline: pickHeadline({ strength, body, recovery }),
    };
  }

  function pickHeadline(input: {
    strength: CoachTrendsPayload["strength"];
    body: CoachTrendsPayload["body"];
    recovery: CoachTrendsPayload["recovery"];
  }): CoachTrendsPayload["headline"] {
    // Priority: plateau > off-pace (weight rate outside band) > HRV-below-baseline > ok
    const plateauedLifts = input.strength.per_lift.filter((p) => p.plateau_active);
    if (plateauedLifts.length > 0) {
      const longest = plateauedLifts.reduce((a, b) =>
        b.plateau_weeks_flat > a.plateau_weeks_flat ? b : a,
      );
      const short = longest.lift.replace(/\s*\([^)]+\)/, "");
      return {
        severity: "warn",
        title: `${short} plateau — ${longest.plateau_weeks_flat} weeks flat`,
        body_md: `e1RM has not moved on ${short} for ${longest.plateau_weeks_flat} weeks. Coach will propose a rep-shift or deload at the next weekly review.`,
      };
    }

    if (input.body.weight.in_band === false && input.body.weight.rate_kg_per_wk_4w != null) {
      const rate = input.body.weight.rate_kg_per_wk_4w;
      const aggressive = rate < input.body.weight.target_band.lower;
      return {
        severity: "warn",
        title: aggressive
          ? `Weight dropping ${rate.toFixed(1)} kg/wk — aggressive`
          : `Weight ${rate >= 0 ? "rising" : "falling slowly"} (${rate.toFixed(1)} kg/wk)`,
        body_md: aggressive
          ? "Loss rate is below the target band. Risk of LBM and strength loss — coach may hold loads at the next review."
          : "Loss rate is above the target band. If a cut is intended, deficit needs deepening; if maintenance, you're on track.",
      };
    }

    if (input.recovery.hrv.vs_baseline_pct_4w != null && input.recovery.hrv.vs_baseline_pct_4w < -0.05) {
      const pct = Math.abs(input.recovery.hrv.vs_baseline_pct_4w * 100);
      return {
        severity: "warn",
        title: `HRV ${pct.toFixed(0)}% below baseline`,
        body_md: "Average HRV over the last 4 weeks is below your 30-day baseline. Sleep, stress, or training load are candidates — check the Recovery section.",
      };
    }

    return {
      severity: "ok",
      title: "On track",
      body_md: "No plateau, weight loss in band, recovery near baseline. Stay the course.",
    };
  }
  ```

- [ ] **Step 2: Verify typecheck + commit**

  ```bash
  npm run typecheck
  git add lib/coach/trends/index.ts
  git commit -m "feat(coach/trends): orchestrator + headline insight picker"
  ```

### Task 1.9: Audit script

**Files:**
- Create: `scripts/audit-coach-trends.mjs`

- [ ] **Step 1: Write the audit script**

  Create `scripts/audit-coach-trends.mjs`:

  ```js
  #!/usr/bin/env node
  // scripts/audit-coach-trends.mjs
  //
  // Exercise the coach-trends compute against the live fixture and dump
  // the payload for manual inspection. Read-only.

  import { readFileSync } from "node:fs";
  import { resolve, dirname } from "node:path";
  import { fileURLToPath } from "node:url";
  import { createClient } from "@supabase/supabase-js";

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(__dirname, "..");
  const env = {};
  for (const line of readFileSync(resolve(repoRoot, ".env.local"), "utf-8").split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error("Missing env"); process.exit(1); }

  const sb = createClient(url, key, { auth: { persistSession: false } });
  const { data: profile } = await sb.from("profiles").select("user_id").order("created_at", { ascending: true }).limit(1).single();
  const userId = profile.user_id;
  const today = new Date().toISOString().slice(0, 10);

  // Import the orchestrator at runtime. Requires the TS module loader — wrap via dynamic import.
  const { generateCoachTrends } = await import("../lib/coach/trends/index.ts");
  const payload = await generateCoachTrends({ supabase: sb, userId, today });

  console.log("=== HEADLINE ===");
  console.log(payload.headline);
  console.log("\n=== STRENGTH per-lift ===");
  for (const p of payload.strength.per_lift) {
    const slope4 = p.slope_pct_per_wk_4w != null ? `${(p.slope_pct_per_wk_4w * 100).toFixed(1)}%/wk` : "n/a";
    const plateau = p.plateau_active ? ` PLATEAU ${p.plateau_weeks_flat}wk` : "";
    console.log(`  ${p.lift.padEnd(35)} e1RM=${p.e1rm_kg_now ?? "n/a"}  slope=${slope4}${plateau}`);
  }
  console.log("\n=== BODY ===");
  console.log(`  weight ${payload.body.weight.now_kg}kg  rate4w=${payload.body.weight.rate_kg_per_wk_4w}  inBand=${payload.body.weight.in_band}`);
  console.log(`  LBM ${payload.body.lbm.now_kg}kg  Δ4w=${payload.body.lbm.delta_4w_kg}`);
  console.log("\n=== NUTRITION ===");
  console.log(`  protein 4w hits: ${payload.nutrition.protein.days_hit_4w}/${payload.nutrition.protein.days_total_4w}  (${((payload.nutrition.protein.pct_4w ?? 0) * 100).toFixed(0)}%)`);
  console.log(`  kcal 4w hits: ${payload.nutrition.kcal.days_hit_4w}/${payload.nutrition.kcal.days_total_4w}`);
  console.log("\n=== RECOVERY ===");
  console.log(`  sleep 4w avg: ${payload.recovery.sleep.avg_h_4w}h  eff=${payload.recovery.sleep.avg_efficiency_pct_4w}`);
  console.log(`  HRV 4w avg: ${payload.recovery.hrv.avg_4w}  vs baseline: ${payload.recovery.hrv.vs_baseline_pct_4w != null ? ((payload.recovery.hrv.vs_baseline_pct_4w as number) * 100).toFixed(0) + "%" : "n/a"}`);
  console.log("\n=== CROSS INSIGHTS ===");
  for (const c of payload.cross_insights) {
    console.log(`  [${c.pair} / ${c.window}] n=${c.n_points} R²=${c.r_squared.toFixed(2)}`);
    console.log(`    ${c.insight_md}`);
  }
  ```

- [ ] **Step 2: Run the audit script**

  ```bash
  node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-coach-trends.mjs
  ```

  Expected: prints headline + per-lift slopes + body/nutrition/recovery summaries + cross insights. Some values may be `n/a` if data is sparse — verify the structure is sane, not the specific numbers.

- [ ] **Step 3: Commit**

  ```bash
  git add scripts/audit-coach-trends.mjs
  git commit -m "chore(coach/trends): audit script for compute verification"
  git push -u origin feat/coach-trends
  gh pr create --title "feat(coach): trend layer compute module (Slice 1/4)" \
    --body "Pure compute module under lib/coach/trends/. Five composers (strength/body/nutrition/recovery/cross) + linear-regression util + orchestrator + audit script. No UI, no consumer integration yet — that's Slices 2-4."
  ```

---

## Slice 2 — Weekly review §4 retrofit

Goal: `WeeklyReviewPayload.trends` populates the new per_lift_slope / plateau_spans / cross_insights fields. §4 renderer adds drillthrough links. Narrative prompt references the new fields. Backward-compatible — existing weekly_reviews rows still typecheck and render.

### Task 2.1: Wire new compute into existing weekly-review compose-trends

**Files:**
- Modify: `lib/coach/weekly-review/compose-trends.ts`

- [ ] **Step 1: Add the calls to the new composers**

  Open `lib/coach/weekly-review/compose-trends.ts`. Find the existing `composeTrends` function. Add imports at the top:

  ```ts
  import { composeStrength } from "@/lib/coach/trends/compose-strength";
  import { composeCross } from "@/lib/coach/trends/compose-cross";
  ```

  Inside `composeTrends`, after the existing computations, ADD the three new field outputs. The existing return object stays — append the new optional fields:

  ```ts
  const [strengthTrend, crossInsights] = await Promise.all([
    composeStrength({ supabase, userId, today }),
    composeCross({ supabase, userId, today }),
  ]);

  const perLiftSlope = strengthTrend.per_lift;
  const plateauSpans = strengthTrend.per_lift
    .filter((p) => p.plateau_active)
    .map((p) => ({
      lift: p.lift,
      weeks_flat: p.plateau_weeks_flat,
      magnitude_pct: 0,  // unused for now; reserved for future delta tracking
    }));

  return {
    ...existingTrends,           // whatever the existing function already returns
    per_lift_slope: perLiftSlope,
    plateau_spans: plateauSpans,
    cross_insights: crossInsights,
  };
  ```

  Adapt to the actual existing return statement — the goal is to ADD three fields to the returned object, not rewrite the function. `today` is the week-end date passed into composeTrends (likely already available; if not, derive from `weekStart + 6 days`).

- [ ] **Step 2: Verify typecheck**

  ```bash
  npm run typecheck
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add lib/coach/weekly-review/compose-trends.ts
  git commit -m "feat(weekly-review): populate sub-project-5 trend fields"
  ```

### Task 2.2: Update §4 renderer with drillthrough links

**Files:**
- Modify: `components/coach/WeeklyReviewTrends.tsx`

- [ ] **Step 1: Add per-cell drillthrough links**

  Open `components/coach/WeeklyReviewTrends.tsx`. Find the existing 2×2 grid rendering the four trend cells. Wrap each cell's link/text with a `<Link href="/coach/trends?section=...">`:

  ```tsx
  import Link from "next/link";

  // Each cell already has a value rendering. Wrap with Link:
  // Loss rate → /coach/trends?section=composition
  // Strength slope → /coach/trends?section=performance
  // /LBM slope → /coach/trends?section=composition
  // Plateau flags → /coach/trends?section=performance

  // Example for the loss rate cell:
  <Link href="/coach/trends?section=composition" style={{ textDecoration: "none", color: "inherit" }}>
    {/* existing cell content */}
  </Link>
  ```

  Adapt to the actual current JSX. The minimum change: wrap each of the 4 cells with a Next.js `<Link>` to the relevant section.

  Below the 2×2 grid, add a "See full trends →" link:

  ```tsx
  <Link
    href="/coach/trends"
    style={{
      display: "inline-block",
      marginTop: 8,
      fontSize: 11,
      color: COLOR.accent,
      textDecoration: "none",
    }}
  >
    See full trends →
  </Link>
  ```

- [ ] **Step 2: Verify typecheck + commit**

  ```bash
  npm run typecheck
  git add components/coach/WeeklyReviewTrends.tsx
  git commit -m "feat(review): §4 cell drillthrough links to /coach/trends"
  ```

### Task 2.3: Update narrative prompt to reference new fields

**Files:**
- Modify: `lib/coach/weekly-review/narrative-prompt.ts`

- [ ] **Step 1: Add a clause about the new fields**

  Open `lib/coach/weekly-review/narrative-prompt.ts`. Find the existing system prompt construction (look for the `TRENDS:` block or similar). Add a paragraph noting the new fields:

  ```ts
  // Just before the existing trend rendering, add:
  TRENDS DEEP CONTEXT (sub-project #5 — optional fields):
  - payload.trends.per_lift_slope[] may be present — each entry has a 4w slope in pct/wk and an R² confidence value.
    When referring to a specific lift's trajectory, cite its slope_pct_per_wk_4w if available.
  - payload.trends.plateau_spans[] flags lifts plateaued ≥ 3 weeks.
  - payload.trends.cross_insights[] holds short English sentences describing nutrition × weight and volume × recovery correlations.
    When the prose touches body composition or recovery, you may reference these insights verbatim or paraphrase them.
  - All three are OPTIONAL — when undefined, omit any reference to per-lift slope or correlation insights.
  ```

  Place this above the existing rules so the narrator sees it before generating prose.

- [ ] **Step 2: Verify typecheck + commit + close Slice 2**

  ```bash
  npm run typecheck
  git add lib/coach/weekly-review/narrative-prompt.ts
  git commit -m "feat(review): narrative prompt references trend deep-context fields"
  git push
  ```

---

## Slice 3 — `/coach/trends` page UI

Goal: Navigating to `/coach/trends` renders the 3-section page. Each section renders sub-blocks with cards reusing existing `MetricCard` / `LineChart` primitives. Cross section shows insight prose + scatter reveal.

### Task 3.1: Query infrastructure

**Files:**
- Create: `lib/query/fetchers/coachTrends.ts`
- Create: `lib/query/hooks/useCoachTrends.ts`
- Modify: `lib/query/keys.ts`

- [ ] **Step 1: Add query keys**

  In `lib/query/keys.ts`, add a new namespace alongside `weeklyReviews`:

  ```ts
  coachTrends: {
    all: (userId: string) => ["coachTrends", userId] as const,
    one: (userId: string) => ["coachTrends", userId, "current"] as const,
  },
  ```

- [ ] **Step 2: Write the fetcher**

  Create `lib/query/fetchers/coachTrends.ts`:

  ```ts
  import type { SupabaseClient } from "@supabase/supabase-js";
  import { createSupabaseBrowserClient } from "@/lib/supabase/client";
  import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
  import { generateCoachTrends } from "@/lib/coach/trends";
  import type { CoachTrendsPayload } from "@/lib/data/types";

  export async function fetchCoachTrendsServer(
    supabase: SupabaseClient,
    userId: string,
    today: string,
  ): Promise<CoachTrendsPayload> {
    return generateCoachTrends({ supabase, userId, today });
  }

  export async function fetchCoachTrendsBrowser(
    userId: string,
    today: string,
  ): Promise<CoachTrendsPayload> {
    // The browser client has RLS — but the trends compute reads many tables.
    // To keep RLS enforced and avoid an API endpoint, the page is server-rendered
    // and hydrated; the browser hook reads from cache only (no re-fetch).
    // If a refetch is needed at runtime, hit a thin /api/coach/trends endpoint.
    void userId; void today;
    throw new Error("coachTrends browser fetcher: not implemented — use SSR hydrate only.");
  }
  ```

  Note: the browser fetcher throws by design. The page is SSR-hydrated; the hook reads cached data, never refetches. If runtime refetch becomes needed later, add a `/api/coach/trends` route.

- [ ] **Step 3: Write the hook**

  Create `lib/query/hooks/useCoachTrends.ts`:

  ```ts
  "use client";
  import { useQuery } from "@tanstack/react-query";
  import { queryKeys } from "@/lib/query/keys";

  export function useCoachTrends(userId: string) {
    return useQuery({
      queryKey: queryKeys.coachTrends.one(userId),
      // Hydrated by SSR; the browser fetcher throws if called, which would only
      // happen if cache misses (shouldn't, since the server prefetched).
      queryFn: async () => {
        throw new Error("useCoachTrends: expected SSR-hydrated cache hit");
      },
      staleTime: 60 * 1000,    // 60s — matches the page's revalidate
    });
  }
  ```

- [ ] **Step 4: Verify typecheck + commit**

  ```bash
  npm run typecheck
  git add lib/query/keys.ts lib/query/fetchers/coachTrends.ts lib/query/hooks/useCoachTrends.ts
  git commit -m "feat(query): coachTrends fetcher + hook (SSR-hydrate-only)"
  ```

### Task 3.2: Page route + loading

**Files:**
- Create: `app/coach/trends/page.tsx`
- Create: `app/coach/trends/loading.tsx`

- [ ] **Step 1: Loading skeleton**

  Create `app/coach/trends/loading.tsx`:

  ```tsx
  export default function Loading() {
    return (
      <div style={{ padding: 16, color: "#888" }}>Computing trends…</div>
    );
  }
  ```

- [ ] **Step 2: Server page**

  Create `app/coach/trends/page.tsx`:

  ```tsx
  import { redirect } from "next/navigation";
  import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
  import { createSupabaseServerClient, createSupabaseServiceRoleClient } from "@/lib/supabase/server";
  import { makeServerQueryClient } from "@/lib/query/queryClient";
  import { queryKeys } from "@/lib/query/keys";
  import { fetchCoachTrendsServer } from "@/lib/query/fetchers/coachTrends";
  import { CoachTrendsView } from "@/components/coach/trends/CoachTrendsView";
  import { todayInUserTz } from "@/lib/time";

  export const revalidate = 60;

  export default async function CoachTrendsRoute(props: {
    searchParams: Promise<{ section?: string }>;
  }) {
    const sp = await props.searchParams;
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) redirect("/login");

    const today = todayInUserTz();

    // The trends compute reads from many tables — use service-role to avoid
    // RLS performance overhead on a multi-table aggregation.
    const serviceSupabase = createSupabaseServiceRoleClient();

    const queryClient = makeServerQueryClient();
    await queryClient.prefetchQuery({
      queryKey: queryKeys.coachTrends.one(user.id),
      queryFn: () => fetchCoachTrendsServer(serviceSupabase, user.id, today),
    });

    const initialSection: "performance" | "composition" | "cross" =
      sp.section === "composition" || sp.section === "cross" ? sp.section : "performance";

    return (
      <HydrationBoundary state={dehydrate(queryClient)}>
        <CoachTrendsView userId={user.id} initialSection={initialSection} />
      </HydrationBoundary>
    );
  }
  ```

- [ ] **Step 3: Verify typecheck + commit**

  ```bash
  npm run typecheck
  git add app/coach/trends/page.tsx app/coach/trends/loading.tsx
  git commit -m "feat(coach): /coach/trends route + SSR-hydrate"
  ```

### Task 3.3-3.9: Container + sections + supporting components

For each component below, create the file with the snippet, run typecheck, commit individually so the build stays clean per commit. Group commits make a single PR review hard later. The components are listed in dependency order — supporting first, then containers.

- [ ] **Task 3.3 — SectionPills.tsx**

  Create `components/coach/trends/SectionPills.tsx`:

  ```tsx
  "use client";

  import { COLOR } from "@/lib/ui/theme";

  export type TrendsSection = "performance" | "composition" | "cross";

  export function SectionPills({
    active,
    onChange,
  }: {
    active: TrendsSection;
    onChange: (s: TrendsSection) => void;
  }) {
    const items: { id: TrendsSection; label: string }[] = [
      { id: "performance", label: "Performance" },
      { id: "composition", label: "Composition" },
      { id: "cross", label: "Cross" },
    ];
    return (
      <div style={{ display: "flex", gap: 6, padding: "8px 12px" }}>
        {items.map((it) => (
          <button
            key={it.id}
            type="button"
            onClick={() => onChange(it.id)}
            style={{
              background: active === it.id ? COLOR.accent : COLOR.surfaceAlt,
              color: active === it.id ? "#fff" : COLOR.textStrong,
              border: "none",
              borderRadius: 9999,
              padding: "6px 12px",
              fontSize: 12,
              fontWeight: active === it.id ? 700 : 500,
              cursor: "pointer",
            }}
          >
            {it.label}
          </button>
        ))}
      </div>
    );
  }
  ```

  Verify typecheck. Commit: `feat(coach/trends): SectionPills component`.

- [ ] **Task 3.4 — WindowToggle.tsx**

  Create `components/coach/trends/WindowToggle.tsx`:

  ```tsx
  "use client";

  import { COLOR } from "@/lib/ui/theme";
  import type { TrendWindow } from "@/lib/data/types";

  export function WindowToggle({
    value,
    onChange,
  }: {
    value: TrendWindow;
    onChange: (w: TrendWindow) => void;
  }) {
    return (
      <div style={{ display: "inline-flex", gap: 2, fontSize: 10 }}>
        {(["4w", "12w"] as const).map((w) => (
          <button
            key={w}
            type="button"
            onClick={() => onChange(w)}
            style={{
              background: value === w ? COLOR.textStrong : "transparent",
              color: value === w ? COLOR.surface : COLOR.textMuted,
              border: `1px solid ${value === w ? COLOR.textStrong : COLOR.divider}`,
              borderRadius: 9999,
              padding: "2px 8px",
              fontSize: 10,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {w}
          </button>
        ))}
      </div>
    );
  }
  ```

  Verify typecheck. Commit: `feat(coach/trends): WindowToggle component`.

- [ ] **Task 3.5 — ChangeBadge.tsx**

  Create `components/coach/trends/ChangeBadge.tsx`:

  ```tsx
  "use client";

  import { COLOR } from "@/lib/ui/theme";
  import { fmtNum } from "@/lib/ui/score";

  export function ChangeBadge({
    valuePct,
    label,
  }: {
    valuePct: number | null;
    label?: string;
  }) {
    if (valuePct == null) {
      return <span style={{ fontSize: 11, color: COLOR.textFaint }}>n/a</span>;
    }
    const color = valuePct > 0.005
      ? "#16a34a"
      : valuePct < -0.005
      ? "#dc2626"
      : COLOR.textMuted;
    const sign = valuePct >= 0 ? "+" : "";
    return (
      <span style={{ fontSize: 11, color, fontWeight: 700 }}>
        {sign}{fmtNum(valuePct * 100)}%{label ? ` ${label}` : ""}
      </span>
    );
  }
  ```

  Verify typecheck. Commit: `feat(coach/trends): ChangeBadge component`.

- [ ] **Task 3.6 — SectionSubHeader.tsx**

  Create `components/coach/trends/SectionSubHeader.tsx`:

  ```tsx
  "use client";

  import { COLOR } from "@/lib/ui/theme";

  export function SectionSubHeader({ label }: { label: string }) {
    return (
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          color: COLOR.textFaint,
          letterSpacing: "0.5px",
          textTransform: "uppercase",
          marginTop: 14,
          marginBottom: 6,
          paddingLeft: 12,
        }}
      >
        {label}
      </div>
    );
  }
  ```

  Verify typecheck. Commit: `feat(coach/trends): SectionSubHeader component`.

- [ ] **Task 3.7 — ScatterChart.tsx**

  Create `components/coach/trends/ScatterChart.tsx`:

  ```tsx
  "use client";

  import type { CSSProperties } from "react";
  import { COLOR } from "@/lib/ui/theme";

  export function ScatterChart({
    points,
    slope,
    intercept,
    width = 280,
    height = 140,
    style,
  }: {
    points: Array<{ x: number; y: number }>;
    slope: number;
    intercept: number;
    width?: number;
    height?: number;
    style?: CSSProperties;
  }) {
    if (points.length < 2) return null;
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const padX = (maxX - minX) * 0.05 || 1;
    const padY = (maxY - minY) * 0.1 || 1;
    const sx = (x: number) => 20 + ((x - minX + padX) / (maxX - minX + 2 * padX)) * (width - 30);
    const sy = (y: number) => height - 20 - ((y - minY + padY) / (maxY - minY + 2 * padY)) * (height - 30);

    // Regression line endpoints.
    const xLineMin = minX - padX;
    const xLineMax = maxX + padX;
    const yAt = (x: number) => slope * x + intercept;

    return (
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={style}>
        <line x1={20} y1={height - 20} x2={width - 10} y2={height - 20} stroke={COLOR.divider} strokeWidth="1" />
        <line x1={20} y1={10} x2={20} y2={height - 20} stroke={COLOR.divider} strokeWidth="1" />
        <line
          x1={sx(xLineMin)}
          y1={sy(yAt(xLineMin))}
          x2={sx(xLineMax)}
          y2={sy(yAt(xLineMax))}
          stroke={COLOR.accent}
          strokeWidth="1.5"
          strokeDasharray="4 2"
        />
        {points.map((p, i) => (
          <circle key={i} cx={sx(p.x)} cy={sy(p.y)} r="3" fill={COLOR.textStrong} />
        ))}
      </svg>
    );
  }
  ```

  Verify typecheck. Commit: `feat(coach/trends): ScatterChart SVG primitive`.

- [ ] **Task 3.8 — TrendsHeader.tsx**

  Create `components/coach/trends/TrendsHeader.tsx`:

  ```tsx
  "use client";

  import { Card, SectionLabel } from "@/components/ui/Card";
  import { COLOR } from "@/lib/ui/theme";
  import type { CoachTrendsPayload } from "@/lib/data/types";

  export function TrendsHeader({ headline }: { headline: CoachTrendsPayload["headline"] }) {
    const accent = headline.severity === "warn" ? "#d97706" : headline.severity === "ok" ? "#16a34a" : COLOR.accent;
    return (
      <Card>
        <SectionLabel>
          <span style={{ color: accent }}>{headline.severity.toUpperCase()}</span> · HEADLINE
        </SectionLabel>
        <div style={{ fontSize: 14, fontWeight: 700, color: COLOR.textStrong, marginTop: 4 }}>
          {headline.title}
        </div>
        <p style={{ fontSize: 12, color: COLOR.textMuted, marginTop: 6, lineHeight: 1.5 }}>
          {headline.body_md}
        </p>
      </Card>
    );
  }
  ```

  Verify typecheck. Commit: `feat(coach/trends): TrendsHeader hero callout`.

- [ ] **Task 3.9 — PerformanceSection.tsx**

  Create `components/coach/trends/PerformanceSection.tsx`. This is the largest section component — renders strength sub-block (per-lift cards) + recovery sub-block:

  ```tsx
  "use client";

  import { useState } from "react";
  import { Card, SectionLabel } from "@/components/ui/Card";
  import { COLOR } from "@/lib/ui/theme";
  import { fmtNum } from "@/lib/ui/score";
  import type { CoachTrendsPayload, TrendWindow } from "@/lib/data/types";
  import { SectionSubHeader } from "./SectionSubHeader";
  import { WindowToggle } from "./WindowToggle";
  import { ChangeBadge } from "./ChangeBadge";

  function shortLift(name: string): string {
    return name.replace(/\s*\([^)]+\)/, "");
  }

  export function PerformanceSection({
    strength,
    recovery,
  }: {
    strength: CoachTrendsPayload["strength"];
    recovery: CoachTrendsPayload["recovery"];
  }) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <SectionSubHeader label="Strength" />
        {strength.per_lift.map((p) => <LiftCard key={p.lift} per={p} />)}

        <SectionSubHeader label="Recovery" />
        <Card>
          <SectionLabel>SLEEP</SectionLabel>
          <div style={{ fontSize: 14, fontWeight: 700, color: COLOR.textStrong, marginTop: 4 }}>
            {recovery.sleep.avg_h_4w != null ? `${fmtNum(recovery.sleep.avg_h_4w)}h` : "n/a"} avg · {recovery.sleep.avg_efficiency_pct_4w != null ? `${fmtNum(recovery.sleep.avg_efficiency_pct_4w)} score` : "n/a"}
          </div>
        </Card>
        <Card>
          <SectionLabel>HRV</SectionLabel>
          <div style={{ fontSize: 14, fontWeight: 700, color: COLOR.textStrong, marginTop: 4 }}>
            {recovery.hrv.avg_4w != null ? fmtNum(recovery.hrv.avg_4w) : "n/a"}
          </div>
          <div style={{ marginTop: 4 }}>
            <ChangeBadge valuePct={recovery.hrv.vs_baseline_pct_4w} label="vs baseline" />
          </div>
        </Card>
        <Card>
          <SectionLabel>RESTING HR</SectionLabel>
          <div style={{ fontSize: 14, fontWeight: 700, color: COLOR.textStrong, marginTop: 4 }}>
            {recovery.rhr.avg_bpm_4w != null ? `${fmtNum(recovery.rhr.avg_bpm_4w)} bpm` : "n/a"}
          </div>
          <div style={{ fontSize: 11, color: COLOR.textMuted, marginTop: 4 }}>
            Δ4w {recovery.rhr.delta_4w_bpm != null ? `${recovery.rhr.delta_4w_bpm > 0 ? "+" : ""}${fmtNum(recovery.rhr.delta_4w_bpm)} bpm` : "n/a"}
          </div>
        </Card>
      </div>
    );
  }

  function LiftCard({ per }: { per: CoachTrendsPayload["strength"]["per_lift"][number] }) {
    const [win, setWin] = useState<TrendWindow>("4w");
    const slope = win === "4w" ? per.slope_pct_per_wk_4w : per.slope_pct_per_wk_12w;
    return (
      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <SectionLabel>{shortLift(per.lift)}</SectionLabel>
          <WindowToggle value={win} onChange={setWin} />
        </div>
        <div style={{ fontSize: 14, fontWeight: 700, color: COLOR.textStrong, marginTop: 4 }}>
          {per.e1rm_kg_now != null ? `${fmtNum(per.e1rm_kg_now)} kg e1RM` : "n/a"}
        </div>
        <div style={{ marginTop: 6, display: "flex", gap: 8, alignItems: "center" }}>
          <ChangeBadge valuePct={slope} label={`/wk · ${win}`} />
          {per.plateau_active && (
            <span style={{ fontSize: 10, color: "#d97706", fontWeight: 700 }}>
              PLATEAU {per.plateau_weeks_flat}w
            </span>
          )}
        </div>
      </Card>
    );
  }
  ```

  Verify typecheck. Commit: `feat(coach/trends): PerformanceSection (strength + recovery)`.

- [ ] **Task 3.10 — CompositionSection.tsx**

  Create `components/coach/trends/CompositionSection.tsx`:

  ```tsx
  "use client";

  import { Card, SectionLabel } from "@/components/ui/Card";
  import { COLOR } from "@/lib/ui/theme";
  import { fmtNum } from "@/lib/ui/score";
  import type { CoachTrendsPayload } from "@/lib/data/types";
  import { SectionSubHeader } from "./SectionSubHeader";

  export function CompositionSection({
    body,
    nutrition,
  }: {
    body: CoachTrendsPayload["body"];
    nutrition: CoachTrendsPayload["nutrition"];
  }) {
    const bandText = `${body.weight.target_band.lower} to ${body.weight.target_band.upper} kg/wk`;
    const inBandColor = body.weight.in_band === true ? "#16a34a" : body.weight.in_band === false ? "#dc2626" : COLOR.textMuted;
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <SectionSubHeader label="Body composition" />
        <Card>
          <SectionLabel>WEIGHT</SectionLabel>
          <div style={{ fontSize: 14, fontWeight: 700, color: COLOR.textStrong, marginTop: 4 }}>
            {body.weight.now_kg != null ? `${fmtNum(body.weight.now_kg)} kg` : "n/a"}
          </div>
          <div style={{ fontSize: 11, color: COLOR.textMuted, marginTop: 4 }}>
            4w rate: <span style={{ color: inBandColor, fontWeight: 600 }}>
              {body.weight.rate_kg_per_wk_4w != null
                ? `${body.weight.rate_kg_per_wk_4w > 0 ? "+" : ""}${fmtNum(body.weight.rate_kg_per_wk_4w)} kg/wk`
                : "n/a"}
            </span> · target band {bandText}
          </div>
        </Card>
        <Card>
          <SectionLabel>LBM</SectionLabel>
          <div style={{ fontSize: 14, fontWeight: 700, color: COLOR.textStrong, marginTop: 4 }}>
            {body.lbm.now_kg != null ? `${fmtNum(body.lbm.now_kg)} kg` : "n/a"}
          </div>
          <div style={{ fontSize: 11, color: COLOR.textMuted, marginTop: 4 }}>
            Δ4w {body.lbm.delta_4w_kg != null ? `${body.lbm.delta_4w_kg > 0 ? "+" : ""}${fmtNum(body.lbm.delta_4w_kg)} kg` : "n/a"} ·
            Δ12w {body.lbm.delta_12w_kg != null ? `${body.lbm.delta_12w_kg > 0 ? "+" : ""}${fmtNum(body.lbm.delta_12w_kg)} kg` : "n/a"}
          </div>
        </Card>
        <Card>
          <SectionLabel>BODY FAT %</SectionLabel>
          <div style={{ fontSize: 14, fontWeight: 700, color: COLOR.textStrong, marginTop: 4 }}>
            {body.body_fat_pct.now != null ? `${fmtNum(body.body_fat_pct.now)}%` : "n/a"}
          </div>
          <div style={{ fontSize: 11, color: COLOR.textMuted, marginTop: 4 }}>
            Δ4w {body.body_fat_pct.delta_4w_pct != null ? `${body.body_fat_pct.delta_4w_pct > 0 ? "+" : ""}${fmtNum(body.body_fat_pct.delta_4w_pct)} pts` : "n/a"}
          </div>
        </Card>

        <SectionSubHeader label="Nutrition" />
        <Card>
          <SectionLabel>PROTEIN ADHERENCE</SectionLabel>
          <div style={{ fontSize: 14, fontWeight: 700, color: COLOR.textStrong, marginTop: 4 }}>
            {nutrition.protein.pct_4w != null ? `${fmtNum(nutrition.protein.pct_4w * 100)}%` : "n/a"} · 4w
          </div>
          <div style={{ fontSize: 11, color: COLOR.textMuted, marginTop: 4 }}>
            {nutrition.protein.days_hit_4w}/{nutrition.protein.days_total_4w} days hit target ({nutrition.protein.target_g ?? "n/a"}g)
          </div>
        </Card>
        <Card>
          <SectionLabel>KCAL ADHERENCE</SectionLabel>
          <div style={{ fontSize: 14, fontWeight: 700, color: COLOR.textStrong, marginTop: 4 }}>
            {nutrition.kcal.pct_4w != null ? `${fmtNum(nutrition.kcal.pct_4w * 100)}%` : "n/a"} · 4w
          </div>
          <div style={{ fontSize: 11, color: COLOR.textMuted, marginTop: 4 }}>
            {nutrition.kcal.days_hit_4w}/{nutrition.kcal.days_total_4w} days within ±5% of {nutrition.kcal.target ?? "n/a"} kcal target
          </div>
        </Card>
        <Card>
          <SectionLabel>DEFICIT MAGNITUDE</SectionLabel>
          <div style={{ fontSize: 14, fontWeight: 700, color: COLOR.textStrong, marginTop: 4 }}>
            {nutrition.deficit_kcal.avg_4w != null ? `${nutrition.deficit_kcal.avg_4w > 0 ? "+" : ""}${fmtNum(nutrition.deficit_kcal.avg_4w)} kcal/day` : "n/a"}
          </div>
          <div style={{ fontSize: 11, color: COLOR.textMuted, marginTop: 4 }}>
            4w average vs target. Negative = deficit; positive = surplus.
          </div>
        </Card>
      </div>
    );
  }
  ```

  Verify typecheck. Commit: `feat(coach/trends): CompositionSection (body + nutrition)`.

- [ ] **Task 3.11 — CrossSection.tsx**

  Create `components/coach/trends/CrossSection.tsx`:

  ```tsx
  "use client";

  import { useState } from "react";
  import { Card, SectionLabel } from "@/components/ui/Card";
  import { COLOR } from "@/lib/ui/theme";
  import type { CoachTrendsPayload, CrossInsight, TrendWindow } from "@/lib/data/types";
  import { WindowToggle } from "./WindowToggle";
  import { ScatterChart } from "./ScatterChart";

  export function CrossSection({ insights }: { insights: CoachTrendsPayload["cross_insights"] }) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <PairCard pair="nutrition_x_weight" title="Nutrition × Weight" insights={insights} />
        <PairCard pair="volume_x_recovery" title="Volume × Recovery" insights={insights} />
      </div>
    );
  }

  function PairCard({
    pair,
    title,
    insights,
  }: {
    pair: CrossInsight["pair"];
    title: string;
    insights: CrossInsight[];
  }) {
    const [win, setWin] = useState<TrendWindow>("4w");
    const [chartOpen, setChartOpen] = useState(false);
    const insight = insights.find((c) => c.pair === pair && c.window === win);

    return (
      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <SectionLabel>{title}</SectionLabel>
          <WindowToggle value={win} onChange={setWin} />
        </div>
        {insight ? (
          <>
            <p style={{ fontSize: 12, color: COLOR.textStrong, marginTop: 8, lineHeight: 1.5 }}>
              {insight.insight_md}
            </p>
            <button
              type="button"
              onClick={() => setChartOpen((v) => !v)}
              style={{
                marginTop: 8,
                background: "transparent",
                border: "none",
                color: COLOR.accent,
                fontSize: 11,
                padding: 0,
                cursor: "pointer",
              }}
            >
              {chartOpen ? "Hide chart ↑" : "Open chart →"}
            </button>
            {chartOpen && (
              <div style={{ marginTop: 8 }}>
                <ScatterChart
                  points={insight.points}
                  slope={insight.slope}
                  intercept={insight.intercept}
                />
              </div>
            )}
          </>
        ) : (
          <p style={{ fontSize: 12, color: COLOR.textMuted, marginTop: 6 }}>
            Not enough data yet for this window ({win}). Need at least {win === "4w" ? "4" : "8"} weeks of paired data.
          </p>
        )}
      </Card>
    );
  }
  ```

  Verify typecheck. Commit: `feat(coach/trends): CrossSection with insight cards + scatter reveal`.

- [ ] **Task 3.12 — CoachTrendsView container**

  Create `components/coach/trends/CoachTrendsView.tsx`:

  ```tsx
  "use client";

  import { useState } from "react";
  import { useRouter } from "next/navigation";
  import { useCoachTrends } from "@/lib/query/hooks/useCoachTrends";
  import { CHAT, COLOR } from "@/lib/ui/theme";
  import { formatHeaderDate } from "@/lib/time";
  import { SectionPills, type TrendsSection } from "./SectionPills";
  import { TrendsHeader } from "./TrendsHeader";
  import { PerformanceSection } from "./PerformanceSection";
  import { CompositionSection } from "./CompositionSection";
  import { CrossSection } from "./CrossSection";

  export function CoachTrendsView({
    userId,
    initialSection,
  }: {
    userId: string;
    initialSection: TrendsSection;
  }) {
    const router = useRouter();
    const [activeSection, setActiveSection] = useState<TrendsSection>(initialSection);
    const { data: payload } = useCoachTrends(userId);

    if (!payload) return null;

    return (
      <div
        style={{
          maxWidth: CHAT.feedMaxWidth,
          margin: "0 auto",
          minHeight: "100dvh",
          color: COLOR.textStrong,
        }}
      >
        <header style={{ padding: "12px 16px 8px" }}>
          <div style={{ fontSize: 12, color: COLOR.textMuted, fontWeight: 500 }}>
            {formatHeaderDate()}
          </div>
          <h1
            style={{
              fontSize: 22,
              fontWeight: 700,
              letterSpacing: "-0.02em",
              color: COLOR.textStrong,
              margin: "2px 0 0",
            }}
          >
            Trends
          </h1>
        </header>

        <SectionPills
          active={activeSection}
          onChange={(s) => {
            setActiveSection(s);
            const url = new URL(window.location.href);
            url.searchParams.set("section", s);
            router.replace(url.pathname + "?" + url.searchParams.toString(), { scroll: false });
          }}
        />

        <div style={{ padding: "0 12px 24px", display: "flex", flexDirection: "column", gap: 10 }}>
          <TrendsHeader headline={payload.headline} />
          {activeSection === "performance" && (
            <PerformanceSection strength={payload.strength} recovery={payload.recovery} />
          )}
          {activeSection === "composition" && (
            <CompositionSection body={payload.body} nutrition={payload.nutrition} />
          )}
          {activeSection === "cross" && <CrossSection insights={payload.cross_insights} />}
        </div>
      </div>
    );
  }
  ```

  Verify typecheck. Commit: `feat(coach/trends): CoachTrendsView container + section routing`.

### Task 3.13: Manual verification + push Slice 3

- [ ] **Step 1: Run dev server**

  ```bash
  npm run dev
  ```

- [ ] **Step 2: Visit /coach/trends**

  In browser: `http://localhost:3000/coach/trends`. Expected: header + headline callout + section pills (Performance default) + per-lift cards. Switch to Composition / Cross — section content swaps. Toggle 4w/12w on a strength card or cross card — value updates.

  Stop dev server.

- [ ] **Step 3: Push and add to PR**

  ```bash
  git push
  ```

  Slice 3 commits land on the existing branch (stacked with Slices 1+2).

---

## Slice 4 — Integration polish + close-out

Goal: Tools tab REFERENCE row links to `/coach/trends`. Optional `/coach` banner when off-pace fires. CLAUDE.md update. Final manual verification.

### Task 4.1: Add "View trends" row to Tools tab REFERENCE section

**Files:**
- Modify: `components/coach/ToolsView.tsx`

- [ ] **Step 1: Add the row**

  Open `components/coach/ToolsView.tsx`. Find the existing REFERENCE section (sub-project #3 added it with one row: "Glossary"). Add a "View trends" row above the Glossary row:

  ```tsx
  <Card>
    <SectionLabel>REFERENCE</SectionLabel>
    <ToolRow
      title="View trends"
      subtitle="Strength / Composition / Cross-metric"
      onClick={() => router.push("/coach/trends")}
    />
    <ToolRow
      title="Glossary"
      subtitle="MEV / MAV / RIR / and more"
      onClick={() => setGlossaryOpen(true)}
    />
  </Card>
  ```

- [ ] **Step 2: Verify typecheck + commit**

  ```bash
  npm run typecheck
  git add components/coach/ToolsView.tsx
  git commit -m "feat(coach): Tools tab → View trends row"
  ```

### Task 4.2: Optional /coach banner when off-pace fires

This is a nice-to-have. Defer if the implementation feels unbalanced; the headline insight on `/coach/trends` already covers the same content.

- [ ] **Decision step:** If the headline insight on `/coach/trends` feels sufficient (it auto-picks plateau / off-pace), skip this step. Otherwise:

  Create a small `TrendsAlertBanner` component that reads `useCoachTrends(userId)` and renders a card on `/coach` when `headline.severity === 'warn'`. Wire into `CoachClient.tsx` above the existing banner stack.

  **Recommended: skip this step for v1.** The `/coach/trends` page surfaces the insight; adding a banner on `/coach` risks notification fatigue.

### Task 4.3: CLAUDE.md update

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add a one-paragraph subsection**

  Open `CLAUDE.md`. Find the Coach / AI architecture section (where weekly review + daily coach loop are documented). Append a short paragraph:

  ```
  ### Trend Layer

  `/coach/trends` is the deep coaching-analysis surface — distinct from `/trends`
  (raw metric exploration). Three sections (Performance / Composition / Cross)
  rendered from a pure compute module at `lib/coach/trends/`. Five composers
  (strength / body / nutrition / recovery / cross) consume `daily_logs`,
  `workouts`, `weekly_reviews`, `training_blocks`. Cross-metric correlations
  use OLS via `linear-regression.ts`; insight prose is deterministic
  templating, no AI calls. Per-lift slope, plateau spans, and cross insights
  also feed the weekly review's §4 via optional fields on the trends payload.
  See spec at `docs/superpowers/specs/2026-05-16-trend-layer-design.md`.
  ```

- [ ] **Step 2: Commit**

  ```bash
  git add CLAUDE.md
  git commit -m "docs(claude-md): document trend layer + /coach/trends"
  ```

### Task 4.4: Final manual exercise + retitle PR

- [ ] **Step 1: Run dev server**

  ```bash
  npm run dev
  ```

- [ ] **Step 2: Full walkthrough**

  1. Visit `/coach` → tap "Tools" pill → tap "View trends" → arrives at `/coach/trends?section=performance`.
  2. Open existing weekly review at `/coach/weeks/2026-05-04` → §4 cells are tappable → each lands on `/coach/trends?section=...` with the right section preselected.
  3. On `/coach/trends`, toggle 4w/12w on a lift card → value updates.
  4. On Cross section, tap "Open chart →" → scatter renders.

  Stop dev server.

- [ ] **Step 3: Retitle PR + push**

  ```bash
  git push
  gh pr edit <PR-number> --title "feat(coach): trend layer (Slices 1-4/4)"
  ```

---

## Self-Review

After all four slices merge, run the spec self-review:

- [ ] Re-read [docs/superpowers/specs/2026-05-16-trend-layer-design.md](../specs/2026-05-16-trend-layer-design.md) — every Goal (1-8) has a corresponding task:
  - Goal 1 (three sections) → Slice 3 Tasks 3.9-3.12.
  - Goal 2 (4w + 12w windows) → Task 3.4 (WindowToggle).
  - Goal 3 (deepened §4) → Slice 2.
  - Goal 4 (cross insights as prose) → Slice 1 Task 1.7 templates + Task 3.11 rendering.
  - Goal 5 (inline expand, no new routes) → no `/coach/trends/[metric]` routes exist; Cross section uses tap-to-reveal.
  - Goal 6 (reuse not reinvent) → reuse `Card`, `SectionLabel`, existing `MetricCard` / `LineChart` from `components/charts/`.
  - Goal 7 (zero AI in compute) → all five composers are deterministic; no `callClaude` in `lib/coach/trends/`.
  - Goal 8 (Tools tab hook) → Slice 4 Task 4.1.
- [ ] Walk the full flow on real data after merge — confirm headline insight surfaces the dev fixture's actual state (likely plateau on Deadlift, low cross-metric R² from sparse data).
- [ ] Confirm no orphan files and no leftover `TODO` comments in shipped code.

When all four slices merge, sub-project #5 is done. Sub-project #4 (Proactive reach-out) is the final piece of the arc — its triggers consume `payload.headline.severity` and the per-lift plateau flags from this sub-project.
