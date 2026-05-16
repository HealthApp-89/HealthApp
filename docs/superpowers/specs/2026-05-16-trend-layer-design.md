# Trend Layer — Design

**Date:** 2026-05-16
**Status:** Approved (awaiting implementation plan)
**Owner:** single-user app, Abdelouahed
**Relation to other work:** Sub-project #5 of the "coach-as-real-coach" arc. Builds on Sub-project #1 (Weekly Review Document), Sub-project #2 (Daily Coach Loop), and Sub-project #3 (Coach Tab UX shell + tool discovery — all shipped 2026-05-15 → 2026-05-16). One sub-project remains in the arc — Proactive reach-out (#4) — explicitly next.

## Problem

The weekly review document's §4 Trend Signals (Sub-project #1) is a 2×2 grid of one-line summaries: loss rate, strength slope, /LBM slope, plateau flags. It's useful as a glance — but it's a dead-end. The user can see "+1.8%/wk strength slope" or "Bench plateaued 2wk" but can't drill in to ask *which lifts*, *how flat*, *what's the loss rate doing this week vs four weeks ago*. The Slice 6 banner from Sub-project #1 surfaces "Review ready" mid-week but the underlying analytics are signal-level only.

A real coach reviewing an athlete's trajectory does five concrete things:

1. **Reads per-lift strength curves** — e1RM week-over-week with explicit slope, separating the four big lifts (Squat / Deadlift / Bench / OHP) and noting which are climbing, which are flat, and how long.
2. **Tracks the body-comp trajectory** — weight loss rate against a target band (-0.7 to -0.2 kg/wk), with LBM and body-fat-% direction so the cut isn't sacrificing muscle.
3. **Sees nutrition adherence** — what fraction of days hit the kcal target, what fraction hit the protein floor, where the deficit drifts.
4. **Watches recovery** — sleep hours + efficiency averaged, HRV vs the user's 30-day baseline, RHR drift.
5. **Names the relationships** — "When you eat below 2200 kcal, you lose 0.6 kg/wk. Above 2400, you gain back. When weekly working sets exceed your MAV+2, HRV drops 8% the next week." Cross-metric correlations rendered as plain-language insights, not raw scatter plots.

The existing `/trends` page covers (1) and (2) at the raw-metric level (period pills, single-metric drilldown) but doesn't compute slopes, doesn't separate per-lift, doesn't band the loss rate, doesn't compute adherence percentages, and doesn't surface cross-metric relationships. It's a data-exploration tool, not a coaching-analysis surface.

This spec covers the Trend Layer: a new `/coach/trends` page distinct from `/trends`, organized into five sections (Strength / Body / Nutrition / Recovery / Cross), backed by a new `lib/coach/trends/` compute module that deepens the weekly review's §4 outputs and renders opinionated analytics. Cross-metric correlations are computed deterministically (linear regression, R²) and rendered as English insight cards with an "open chart" reveal. No new tables, no migration, no Anthropic calls — the compute is pure derivation from existing data.

## Goals

1. **Five coaching-analysis sections at `/coach/trends`.** Strength (per-lift 4w/12w slopes + plateau spans) / Body (weight rate + LBM + body fat) / Nutrition (adherence percentages + deficit magnitude) / Recovery (sleep + HRV + RHR) / Cross (insight cards for nutrition × weight and volume × recovery). Single-page sectioned navigation (mirrors `CoachNav`'s pill pattern).
2. **4-week AND 12-week windows.** Per-card toggle, defaults to 4w (catches recent shifts), 12w available for trend stability checks. Two windows reflect "what's changing now" vs "what's the underlying trajectory."
3. **Deepen the weekly review's §4.** `WeeklyReviewPayload.trends` gains optional fields for per-lift slope arrays + plateau spans + cross-metric correlation summaries. §4 renderer adds per-cell drillthrough links to `/coach/trends`. Backward-compatible — additive only.
4. **Cross-metric insights as prose, charts as drilldown.** Each correlation card opens with one English sentence ("When kcal averages <2200, you lose 0.6 kg/wk. Each +200 kcal correlates with +0.2 kg/wk."). Tap to reveal the underlying scatter. The "what to do" is in the prose; the chart is for the curious user.
5. **Drilldown via inline expand, not new routes.** Tap any metric card → in-place expand within its section, showing full sparkline + per-week table. No `/coach/trends/[metric]` sub-routes; the page is one URL.
6. **Reuse, don't reinvent.** Read from `daily_logs` (weight, body comp, sleep, kcal, protein, HRV, RHR), `workouts → exercises → exercise_sets` (per-lift e1RM), `training_blocks` (on-pace context), `weekly_reviews` (week-over-week reference), `body_measurements` (circumference trends if measured). No new tables.
7. **Zero AI in the compute layer.** Cross-metric insight sentences are deterministic templates filled from regression coefficients. The weekly review's narrative AI consumes these as inputs but generates no new prose in this sub-project.
8. **Hook into Sub-project #3's surfaces.** Tools tab REFERENCE section gets a "View trends" row; sub-project #2's morning brief gets no changes (intentional — brief is daily, trends are weekly+).

## Non-Goals

- **Cross-block historical comparison.** Comparing Block 2 vs Block 3 trends is out of scope. Trend windows are 4w / 12w from "now" only.
- **Power-user features.** No data export. No custom dashboards. No SQL-style query tools.
- **Editable time windows beyond 4w / 12w.** No 6w / 8w / N-week / arbitrary range. The two presets are deliberate.
- **Mobile-specific gestures.** No pinch-to-zoom, no swipe-to-navigate-sections. Tap-only.
- **New raw-metric drilldowns.** The existing `/trends/[metric]` pages stay as-is. `/coach/trends` is for opinionated coaching signals, not raw data exploration.
- **AI-generated insight prose.** Cross-metric insight sentences come from a deterministic template that fills regression coefficients into English. No Anthropic call in this sub-project.
- **Chart libraries / dependencies.** Custom SVG sparklines + line charts. No `recharts`, no `d3`, no new npm dependency.
- **Trend-based push notifications.** Sub-project #4 territory; #5 only computes the signals.
- **Sub-project #4's notification triggers consuming these signals.** That's #4's spec; this one stops at exposing the signals in the payload.

## Phasing relation

| Sub-project | What it does | Status |
|---|---|---|
| Sub-project #1 — Weekly Review Document | §4 trend signals as 2×2 grid summary | ✅ Shipped |
| Sub-project #2 — Daily Coach Loop | References sub-project #1's prescription; no direct trend layer dependency | ✅ Shipped |
| Sub-project #3 — Coach Tab UX shell + tool discovery | Tools tab → REFERENCE row will gain "View trends" | ✅ Shipped |
| **#5 Trend Layer (this spec)** | `/coach/trends` page + deepened §4 + cross-metric correlations | 📝 Designing |
| Sub-project #4 — Proactive reach-out | Push notifications triggered by trends (plateau detected, off-pace, deficit drift). Consumes #5's signals. | ⏸ Next after #5 |

The arc's compute deepens here. Sub-project #1's `compose-trends.ts` produces signal-level outputs (single numbers per metric); this sub-project adds rolling per-lift arrays + plateau spans + correlation regression coefficients. Sub-project #4 then layers notifications on top of those signals.

## Architecture overview

```
                       ┌────────────────────────────────┐
                       │   lib/coach/trends/  (new)     │
                       │                                │
                       │   index.ts (orchestrator)      │
                       │   compose-strength.ts          │
                       │   compose-body.ts              │
                       │   compose-nutrition.ts         │
                       │   compose-recovery.ts          │
                       │   compose-cross.ts             │
                       │   linear-regression.ts (util)  │
                       └──────┬──────────────────┬──────┘
                              │                  │
              ┌───────────────┘                  └─────────────────┐
              ▼                                                    ▼
   ┌──────────────────────────────┐               ┌─────────────────────────────┐
   │  /coach/trends page (PR 3)   │               │ Weekly review §4 retrofit   │
   │  (new route)                 │               │ (PR 2)                       │
   │                              │               │                              │
   │  CoachTrendsView container   │               │ WeeklyReviewPayload.trends   │
   │  TrendsHeader (hero)         │               │   gains optional fields:     │
   │  StrengthSection             │               │   - per_lift_slope[]         │
   │  BodySection                 │               │   - plateau_spans[]          │
   │  NutritionSection            │               │   - cross_insights[]         │
   │  RecoverySection             │               │ §4 renderer adds drillthrough│
   │  CrossSection                │               │   links to /coach/trends     │
   │  Sparkline (SVG, custom)     │               │ AI narrative prompt          │
   │  ExpandedChart (drilldown)   │               │   references new fields when │
   │                              │               │   present (no shape change)  │
   │  Query: useCoachTrends hook  │               │                              │
   │  Fetcher: server + browser   │               │                              │
   └──────────────────────────────┘               └─────────────────────────────┘
              │                                                    │
              └────────────────────┬───────────────────────────────┘
                                   ▼
                       ┌────────────────────────────────┐
                       │  Sub-project #3 retrofit (PR 4)│
                       │                                │
                       │  Tools tab REFERENCE row:      │
                       │    "View trends" → /coach/trends│
                       │  Optional /coach banner when   │
                       │    plateau or off-pace fires   │
                       │  CLAUDE.md update              │
                       └────────────────────────────────┘
```

**Four PRs:**

- **PR 1 — `lib/coach/trends/` compute module.** Six new files (orchestrator + 5 composers + regression util). Pure functions, no I/O beyond injected supabase service-role client. Audit script exercising each composer against the dev fixture.
- **PR 2 — Weekly review §4 retrofit.** Extend `WeeklyReviewPayload.trends` types with three optional arrays. Update `WeeklyReviewTrends.tsx` to render per-cell drillthrough links. Update `narrative-prompt.ts` system prompt to reference the new fields when populated.
- **PR 3 — `/coach/trends` page UI.** New route + page component + section components + sparkline + drilldown + query infrastructure. SSR-hydrate via TanStack Query (per CLAUDE.md client-cache rules).
- **PR 4 — Integration polish.** Tools tab REFERENCE row; optional `/coach` banner when off-pace; CLAUDE.md update; final manual verification.

## Data model

**No new tables. No migration.** New TypeScript types in `lib/data/types.ts`:

```ts
// ── Trend layer (lib/coach/trends/) ─────────────────────────────────────────

export type TrendWindow = "4w" | "12w";

export type PerLiftSlope = {
  lift: string;                           // "Squat (Barbell)" — matches BIG_FOUR
  e1rm_kg_now: number | null;
  slope_pct_per_wk_4w: number | null;     // e.g. +0.018 = +1.8%/wk
  slope_pct_per_wk_12w: number | null;
  r_squared_4w: number | null;            // confidence in the slope
  r_squared_12w: number | null;
  plateau_active: boolean;
  plateau_weeks_flat: number;             // 0 when not plateaued
};

export type StrengthTrend = {
  schema_version: 1;
  per_lift: PerLiftSlope[];               // big-four only
  block_phase_now: WeeklyPhase | null;    // from active block
  on_pace: boolean | null;
};

export type BodyTrend = {
  schema_version: 1;
  weight: {
    now_kg: number | null;
    rate_kg_per_wk_4w: number | null;
    rate_kg_per_wk_12w: number | null;
    target_band: { lower: number; upper: number };   // [-0.7, -0.2] default
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
    days_hit_4w: number;                 // within ±5% of target
    days_total_4w: number;
    pct_4w: number | null;
    pct_12w: number | null;
    avg_4w: number | null;
    avg_12w: number | null;
  };
  deficit_kcal: {
    avg_4w: number | null;               // negative = deficit
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
    vs_baseline_pct_4w: number | null;   // -8% means averaging 8% below baseline
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
  slope: number;                         // change per unit
  intercept: number;
  r_squared: number;                     // strength of relationship
  n_points: number;                      // weekly data points
  insight_md: string;                    // deterministic English sentence
  /** Optional drill-data for the scatter render. */
  points: Array<{ x: number; y: number; week_start: string }>;
};

export type CoachTrendsPayload = {
  schema_version: 1;
  generated_at: string;
  strength: StrengthTrend;
  body: BodyTrend;
  nutrition: NutritionAdherenceTrend;
  recovery: RecoveryTrend;
  cross_insights: CrossInsight[];        // 2 entries: nutrition_x_weight, volume_x_recovery
  /** Headline insight surfaced in the page header. Auto-picked from plateau/off-pace signals. */
  headline: {
    severity: "info" | "warn" | "ok";
    title: string;
    body_md: string;
  };
};
```

## Compose layer detail (PR 1)

Six files under `lib/coach/trends/`:

| File | Purpose | Inputs | Output |
|---|---|---|---|
| `linear-regression.ts` | Pure util: OLS regression on `{x, y}[]` arrays. Returns `{ slope, intercept, r_squared, n }`. | data points | regression result |
| `compose-strength.ts` | Per-lift e1RM weekly peaks → 4w and 12w slopes via OLS. Plateau detection (3+ weeks within 1.5% of each other, matching Sub-project #1's threshold). | supabase, userId, today | StrengthTrend |
| `compose-body.ts` | Weight / LBM / body-fat-% slopes from daily_logs. Loss rate band check. | supabase, userId, today | BodyTrend |
| `compose-nutrition.ts` | Per-day target hit/miss aggregation. Reads `daily_logs.protein_g` + `daily_logs.calories_eaten` against `plan_payload.nutrition` or `intake_payload.nutrition` targets. | supabase, userId, today | NutritionAdherenceTrend |
| `compose-recovery.ts` | Sleep / HRV / RHR rolling averages. HRV baseline from existing `whoop_baselines` table. | supabase, userId, today | RecoveryTrend |
| `compose-cross.ts` | Two correlation passes. Weekly aggregation (kcal avg ↔ weight delta; weekly working sets ↔ next-week HRV avg). Calls `linear-regression`. Renders English insight via deterministic template. | supabase, userId, today, dependent trends | CrossInsight[] |
| `index.ts` | Orchestrator. Parallel-fetch supabase reads, sequential compose, assemble `CoachTrendsPayload`. Pick `headline` from severity priority (plateau > off-pace > info). | supabase, userId, today | CoachTrendsPayload |

**`linear-regression.ts` — pure util:**

```ts
export function linearRegression(points: Array<{ x: number; y: number }>): {
  slope: number; intercept: number; r_squared: number; n: number;
} | null {
  const n = points.length;
  if (n < 2) return null;
  // OLS: slope = cov(x,y) / var(x); intercept = mean(y) - slope * mean(x)
  const meanX = points.reduce((s, p) => s + p.x, 0) / n;
  const meanY = points.reduce((s, p) => s + p.y, 0) / n;
  let num = 0, denX = 0, denY = 0;
  for (const p of points) {
    num += (p.x - meanX) * (p.y - meanY);
    denX += (p.x - meanX) ** 2;
    denY += (p.y - meanY) ** 2;
  }
  if (denX === 0) return null;
  const slope = num / denX;
  const intercept = meanY - slope * meanX;
  const r_squared = denY === 0 ? 1 : (num ** 2) / (denX * denY);
  return { slope, intercept, r_squared, n };
}
```

**`compose-cross.ts` insight templates:**

Two correlation pairs, both deterministic prose generators:

```ts
function nutritionXWeightInsight(reg: RegressionResult, window: TrendWindow): string {
  if (reg.r_squared < 0.2) {
    return `Nutrition and weight show no clear relationship in the last ${window === "4w" ? "4 weeks" : "12 weeks"} (R² ${reg.r_squared.toFixed(2)}). Weekly variance dominates the signal — likely fluid + glycogen rather than fat.`;
  }
  const kcalSensitivity = Math.round(200 * reg.slope * 10) / 10;   // kg/wk per +200 kcal/wk avg
  const direction = reg.slope > 0 ? "gain" : "lose";
  return `When kcal averages ${reg.slope > 0 ? "higher" : "lower"}, you ${direction} weight. Each +200 kcal/day correlates with ${kcalSensitivity >= 0 ? "+" : ""}${kcalSensitivity} kg/wk over the last ${window === "4w" ? "4 weeks" : "12 weeks"} (R² ${reg.r_squared.toFixed(2)}).`;
}

function volumeXRecoveryInsight(reg: RegressionResult, window: TrendWindow): string {
  if (reg.r_squared < 0.2) {
    return `Weekly working-set volume isn't strongly correlated with recovery in the last ${window === "4w" ? "4 weeks" : "12 weeks"} (R² ${reg.r_squared.toFixed(2)}). HRV / sleep are likely driven by non-training factors.`;
  }
  const setsSensitivity = Math.round(reg.slope * 10) / 10;
  return `Higher weekly volume tracks with ${reg.slope < 0 ? "lower" : "higher"} next-week HRV. Each +10 working sets correlates with ${setsSensitivity >= 0 ? "+" : ""}${Math.round(10 * reg.slope * 10) / 10} HRV points over the last ${window === "4w" ? "4 weeks" : "12 weeks"} (R² ${reg.r_squared.toFixed(2)}).`;
}
```

R² thresholds: < 0.2 → "no clear relationship" prose. The template is intentionally conservative — better to say "weak signal" than overclaim a spurious correlation.

## UI structure detail (PR 3)

**Route:** `app/coach/trends/page.tsx` — server component, SSR-hydrate, redirects to login when unauthed. Prefetches via `fetchCoachTrendsServer`. Mirrors the weekly-review page pattern from Sub-project #1.

**Components in `components/coach/trends/`:**

| Component | Responsibility |
|---|---|
| `CoachTrendsView.tsx` | Client container. Renders header + active section. Section state in URL: `?section=strength` (default), `recent`-style. Activates SectionPills + corresponding section component. |
| `TrendsHeader.tsx` | Hero callout — block + phase + headline insight. Pulls `payload.headline`. |
| `SectionPills.tsx` | Strength / Body / Nutrition / Recovery / Cross pill row. Mirrors `CoachNav` style. |
| `StrengthSection.tsx` | Renders one card per big-four lift + plateau callout cards. Per-card 4w/12w toggle. Tap-to-expand. |
| `BodySection.tsx` | Weight card with band-shading + LBM card + body-fat card. |
| `NutritionSection.tsx` | Adherence-percent cards (protein, kcal) + deficit magnitude card. |
| `RecoverySection.tsx` | Sleep card + HRV card + RHR card. |
| `CrossSection.tsx` | Two insight cards (nutrition × weight, volume × recovery). Each opens a `ScatterChart` on tap. |
| `Sparkline.tsx` | Custom SVG sparkline — accepts `{ points, width, height, stroke }`. |
| `LineChart.tsx` | Custom SVG line chart with axes + grid. Used in `ExpandedChart`. |
| `ScatterChart.tsx` | Custom SVG scatter — used by `CrossSection`. |
| `ExpandedChart.tsx` | Drill-down: full LineChart + per-week table. Inline expand within the card. |
| `WindowToggle.tsx` | 4w / 12w pill toggle. Local state per card. |
| `ChangeBadge.tsx` | Color-coded delta pill ("+1.8%/wk" green, "0%/wk plateau" amber). |

**Query infrastructure:** mirrors Sub-project #1's weekly-review pattern.

| File | Purpose |
|---|---|
| `lib/query/fetchers/coachTrends.ts` | `fetchCoachTrendsServer` + `fetchCoachTrendsBrowser` (parallel server-side trends compute, returns full payload). |
| `lib/query/hooks/useCoachTrends.ts` | `useCoachTrends(userId)` — TanStack Query hook. |
| `lib/query/keys.ts` | Add `coachTrends.all(userId)` query key. |

## Weekly review §4 retrofit (PR 2)

**Type extension** in `lib/data/types.ts`:

```ts
// Existing trends type from Sub-project #1:
export type WeeklyReviewTrendSignals = {
  // ... existing fields ...
  /** New from sub-project #5. Per-lift e1RM slopes computed via OLS. */
  per_lift_slope?: PerLiftSlope[];
  /** New from sub-project #5. Plateau spans per lift. */
  plateau_spans?: Array<{ lift: string; weeks_flat: number; magnitude_pct: number }>;
  /** New from sub-project #5. Cross-metric insight summaries. */
  cross_insights?: CrossInsight[];
};
```

All three new fields are optional → existing weekly_reviews rows continue to typecheck and render. The renderer (`WeeklyReviewTrends.tsx`) adds:

- Per-cell drillthrough — tap "Plateaus: Bench (2wk) ⚠" → navigate to `/coach/trends?section=strength` with the bench card auto-expanded.
- New "See full trends →" link in the bottom-right of the §4 card.

**`compose-trends.ts` retrofit:** sub-project #1's existing composer calls into the new `lib/coach/trends/` modules to populate the additional fields. Old fields stay computed in-place; new fields are added.

**Narrative prompt update** in `lib/coach/weekly-review/narrative-prompt.ts`: append two lines to the system prompt explaining that `payload.trends.per_lift_slope` and `payload.trends.cross_insights` may be present, and the narrator should reference specific slopes by lift name when discussing periodization decisions.

## Cross-metric correlation methodology

Two relationship pairs, both computed on weekly aggregates over the 4w and 12w windows.

**Pair 1 — Nutrition × Weight:**
- **X:** weekly average daily kcal (sum of 7 daily values / 7).
- **Y:** weight delta in kg (weight on day 7 minus weight on day 1 of the same week).
- **N:** 4 weekly points for the 4w window, 12 for 12w.
- **OLS slope unit:** kg/wk per kcal/day. Reported scaled to "per +200 kcal/day" for readability.

**Pair 2 — Volume × Recovery:**
- **X:** weekly working-set count across all logged sessions (warmups excluded).
- **Y:** average HRV across the *following week* (lag-1 to account for delayed recovery cost).
- **N:** 4 weekly points for 4w, 12 for 12w.
- **OLS slope unit:** HRV ms per working set. Reported scaled to "per +10 sets" for readability.

**R² interpretation:**
- R² ≥ 0.6 → "strong relationship" — show the slope confidently.
- 0.3 ≤ R² < 0.6 → "moderate relationship" — show the slope with hedging language.
- R² < 0.3 → "weak relationship" — explicitly say "no clear relationship" in the insight prose.

**Sample size constraint:** N ≥ 4 for the 4w window, N ≥ 8 for the 12w window. Below either threshold, render the card as "Not enough data yet (need {n_needed} weeks)."

## Edge cases

- **First week of usage / new block** — `compose-strength.ts` needs at least 3 weekly e1RM points to compute a slope. When unavailable, slope fields return null; UI shows "Building trend — N more weeks of data needed."
- **No active training block** — `StrengthTrend.block_phase_now` and `on_pace` return null. Strength section still renders per-lift slopes from logged workouts.
- **Empty `body_measurements`** — circumference trends omitted. Body section still works with `daily_logs` weight/LBM/body-fat.
- **Sparse daily_logs** — slope computation skips null days. Below N=4 for 4w, the metric shows "Not enough data."
- **HRV missing for a week** — that week's point is skipped in the volume × recovery regression. R² may drop below threshold; the insight pivots to "no clear relationship" wording.
- **Plateau detection collides with deload week** — Sub-project #1's deload weeks naturally show flat e1RM (intentional). The plateau detector skips deload-phase weeks via the `training_blocks.research_phase` lookup; deload-induced flatness doesn't fire a plateau callout.
- **`r_squared` computation when all y values equal** — denominator denY = 0; return r_squared = 1 (perfectly fits a flat line). The slope is then 0, and the insight template reads "no movement in this metric."
- **Weight loss target band** — defaults to `[-0.7, -0.2]` kg/wk (Helms range). Plan stage: read user's preferred band from `intake_payload` if present; otherwise use default.
- **Cross-metric insight when slope is near zero** — the template's `kcalSensitivity` computation returns ~0; insight prose handles this gracefully ("Each +200 kcal/day correlates with +0.0 kg/wk — your weight isn't sensitive to kcal in this window").
- **User opens `/coach/trends` mid-week with no committed weekly review** — page still renders. The compute module reads daily_logs/workouts directly; weekly_reviews is only used for week-over-week e1RM tracking (optional, falls back to raw exercise_sets aggregation).
- **`?section` URL parameter with unknown value** — defaults to `strength`.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Linear regression on sparse / noisy data produces spurious slopes | R² thresholds gate the insight prose. Below 0.3 we explicitly say "weak signal." Below the N threshold we say "not enough data." |
| 4w slope is hypersensitive to one outlier week (e.g. a missed week) | Use weekly aggregates rather than raw daily points for slope computation. Missed weeks drop a point but don't pull the slope. |
| Plateau detection misfires during deload weeks | Skip deload-phase weeks via `training_blocks.research_phase` filter (per spec compose-strength logic). |
| Cross-metric correlation is fundamentally spurious for a single user | R² is the honest measure; the insight prose hedges below 0.6 and explicitly disclaims below 0.3. User sees the math, can decide. |
| `/coach/trends` page payload is large (full 12w of points × 6 metrics) | Acceptable for a single user with at most ~84 daily points per metric. The full payload is well under 100KB. No pagination needed. |
| Adding §4 retrofit fields breaks existing weekly_reviews rows | All new fields are optional. Existing rows without the new fields render correctly; the §4 component handles `undefined` gracefully. Backward-compatible. |
| Sparkline custom-render misses an edge case (e.g. all-null series) | Component renders an explicit "no data" placeholder when points array is empty or fewer than N=2. Verified at implementation. |
| URL state `?section=strength` conflicts with existing `/coach?view=...` pattern | Different routes; `/coach/trends` has its own URL space. No conflict. |
| User confusion between `/trends` (raw) and `/coach/trends` (analysis) | Tools tab's "View trends" row label explicitly says "coaching trends" or similar. The two routes serve different audiences; cross-link from `/trends` to `/coach/trends` (and vice versa) in PR 4 polish if it helps. |
| Cross-metric insight prose template produces awkward sentences for edge values | Templates handle zero-slope and weak-R² cases explicitly. Plan stage iterates against real fixture data before shipping. |
| Sub-project #1's `compose-trends.ts` becomes redundant with `lib/coach/trends/compose-strength.ts` | Sub-project #1's composer becomes a thin wrapper that imports + delegates to the new module for the new fields, keeping its existing 2×2 outputs in place. |

## Verification

- **Typecheck:** `npm run typecheck` clean after each PR.
- **Audit script** in PR 1: `scripts/audit-coach-trends.mjs` — run against the dev fixture (sub-project #1 state). Inspects each composer's output for sanity: per-lift slopes in expected ranges, no nulls where data exists, R² values between 0 and 1.
- **Manual exercise** in PR 3: visit `/coach/trends` on dev. Cycle through all five sections. Tap a strength card; verify expand inline. Toggle 4w/12w; verify slope changes. Tap a cross-metric insight; verify scatter renders. Resize browser to mobile; verify section pills wrap.
- **§4 retrofit verification** in PR 2: open an existing committed weekly review at `/coach/weeks/[week_start]`. §4 should still render (backward-compat). After regenerating the review, §4 cells should be tappable and link to `/coach/trends` sections.
- **Number formatting:** all numeric displays go through `fmtNum` per CLAUDE.md.
- **Disabled-state audit:** force the dev fixture to a state with no logged workouts in the last 4 weeks; verify the Strength section shows "Not enough data" rather than crashing or showing zero.

## Open questions deferred to plan stage

1. **Weight loss target band source.** Defaults to [-0.7, -0.2] kg/wk. Plan stage: check whether `intake_payload.weight.target_loss_rate` exists; if so, prefer the user's value. If not, hardcode the default.
2. **Headline insight auto-picker priority.** Currently spec'd as plateau > off-pace > info. Plan stage: confirm the ordering and the exact thresholds (e.g. "off-pace" needs a numeric definition — block goal vs current trajectory).
3. **Per-card 4w/12w toggle persistence.** Local state per card (resets on page reload) vs URL query param (persists). Lean local-state for simplicity unless deep-linking to a specific window matters.
4. **`/trends` cross-link** (raw → coaching). Should `/trends` get a header link to `/coach/trends`? Lean yes if it doesn't crowd the existing header.
5. **`ExpandedChart` per-week table column set.** Plan stage decides which columns make sense per metric (e.g. weight: week_start / weight / delta / target; strength: week_start / top set / e1RM / slope-vs-prior).
6. **Cross-metric prose template edge cases.** Spec has templates for strong/moderate/weak R² + zero-slope. Plan stage iterates against real fixture data and adds wording fixes if the prose reads stilted.
