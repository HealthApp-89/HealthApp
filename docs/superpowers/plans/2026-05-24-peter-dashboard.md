# Peter Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a head-coach synthesis layer for Peter — a 6-theme dashboard at a new top-level `/coach` route, backed by a deterministic+narrative cached payload that doubles as Peter's chat-prompt injection so the dashboard is literally what Peter reads.

**Architecture:** Six pure composers (`lib/coach/peter-dashboard/compose-*`) consume existing intelligence layers (`lib/coach/trends`, `recovery-intelligence`, `nutrition-intelligence`). An orchestrator parallel-runs them, detects pairwise cross-theme clusters, and a single Sonnet 4.6 call wraps the output in Peter's voice. Result persists to a new versioned `coach_dashboards` table. Daily cron + manual regen write rows; both UI and Peter's system-prompt assembly read the latest row. /metrics is renamed to /coach with two sub-tabs (Dashboard / Chat) since /metrics is already Peter's surface and most of its other content has been redirected away.

**Tech Stack:** Next.js 15 (App Router), Supabase + RLS, Anthropic SDK (Sonnet 4.6 for narrative), TanStack Query SSR-hydrate, Recharts, Tailwind v4.

**Spec:** [docs/superpowers/specs/2026-05-24-peter-dashboard-design.md](../specs/2026-05-24-peter-dashboard-design.md)

**Spec calibration (important):** The spec says "/health?tab=coach is Peter's chat" — that was wrong. Peter's chat actually lives at /metrics ([components/metrics/MetricsClient.tsx](../../../components/metrics/MetricsClient.tsx)). `/health?tab=coach` is Remi's chat. The plan renames `/metrics` → `/coach` (since /metrics has already been redirected away from its original purpose: `?sub=strength→/strength`, `?sub=body→/diet`, `?sub=log→/health`, `?section=nutrition→/diet`). `/health` is not touched; it keeps its three sub-tabs.

---

## File Structure

### New files

- `supabase/migrations/0034_peter_dashboard.sql` — `coach_dashboards` table + RLS
- `supabase/migrations/0035_athlete_goal_structured.sql` — structured goal columns on `athlete_profile_documents`
- `lib/coach/peter-dashboard/types.ts` — `ThemeKey`, `ThemePayload`, `ThemeCluster`, `PeterDashboardFacts`, `PeterDashboardPayload`
- `lib/coach/peter-dashboard/thresholds.ts` — all severity numeric constants
- `lib/coach/peter-dashboard/compose-recomp.ts`
- `lib/coach/peter-dashboard/compose-energy.ts`
- `lib/coach/peter-dashboard/compose-fatigue.ts`
- `lib/coach/peter-dashboard/compose-performance.ts`
- `lib/coach/peter-dashboard/compose-plan-adherence.ts`
- `lib/coach/peter-dashboard/compose-goal-distance.ts`
- `lib/coach/peter-dashboard/link-themes.ts`
- `lib/coach/peter-dashboard/narrate.ts` — Sonnet call + fabrication check + retry + fallback
- `lib/coach/peter-dashboard/narrative-prompt.ts` — system prompt for narrate
- `lib/coach/peter-dashboard/render-injection.ts` — builds "Today's read" markdown block from a payload row
- `lib/coach/peter-dashboard/index.ts` — `generatePeterDashboard()` orchestrator + `loadLatestPeterDashboard()` reader
- `lib/query/fetchers/peterDashboard.ts`
- `lib/query/hooks/usePeterDashboard.ts`
- `app/coach/page.tsx` — Server Component, SSR-hydrate, sub-tab dispatcher
- `app/coach/layout.tsx` — wraps with `SubPillNav`
- `app/api/coach/dashboard/sync/route.ts` — cron handler
- `app/api/coach/dashboard/regenerate/route.ts` — manual regen
- `components/coach/PeterDashboardClient.tsx`
- `components/coach/PeterDashboardHero.tsx`
- `components/coach/PeterDashboardGrid.tsx`
- `components/coach/PeterThemeCard.tsx`
- `components/coach/PeterDashboardRegenButton.tsx`
- `components/coach/PeterChatClient.tsx` — extracted chat-only wrapper (lifted from `MetricsClient`)
- `scripts/audit-peter-dashboard.mjs`

### Modified files

- `lib/data/types.ts` — re-export `PeterDashboardPayload`
- `lib/query/keys.ts` — add `peterDashboard.{all, latest}`
- `lib/coach/system-prompts.ts` — two PETER_BASE prose additions
- `lib/coach/planning-prompts.ts` — `buildSystemPrompt` injects `peterDashboardBlock` for Peter mode
- `lib/coach/chat-stream.ts` — new `peterDashboardBlock` option; appended after base, before peterContext
- `app/api/chat/messages/route.ts` — load + pass `peterDashboardBlock`
- `app/metrics/page.tsx` — replaced by `app/coach/page.tsx` (delete after move)
- `components/metrics/MetricsClient.tsx` — split into `PeterDashboardClient` + `PeterChatClient`, then delete file
- `components/layout/BottomNav.tsx` — change `/metrics` entry to `/coach`, relabel "Metrics" → "Coach"
- `vercel.json` — add `0 4 * * *` cron for `/api/coach/dashboard/sync`
- `CLAUDE.md` — new section under "Architecture → Coach / AI"

---

## Task 1: Migrations — `coach_dashboards` table + structured goal columns

**Files:**
- Create: `supabase/migrations/0034_peter_dashboard.sql`
- Create: `supabase/migrations/0035_athlete_goal_structured.sql`

- [ ] **Step 1: Create migration 0031**

Write to `supabase/migrations/0034_peter_dashboard.sql`:

```sql
-- 0034_peter_dashboard.sql
-- Versioned cache for Peter's head-coach dashboard payload.
-- Daily cron writes v1; manual regen bumps version. Both the /coach
-- dashboard UI and Peter's chat-prompt assembly read the latest row.

create table coach_dashboards (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users on delete cascade,
  generated_on  date not null,
  version       int  not null default 1,
  status        text not null default 'ready'
    check (status in ('ready', 'failed')),
  payload       jsonb not null,
  narrative_md  text  not null,
  generated_at  timestamptz not null default now(),
  unique (user_id, generated_on, version)
);

create index coach_dashboards_user_recent_idx
  on coach_dashboards (user_id, generated_on desc, version desc);

alter table coach_dashboards enable row level security;

-- Owner-only read; writes via service-role (cron + regenerate endpoint).
create policy coach_dashboards_select_own
  on coach_dashboards for select
  using (auth.uid() = user_id);
```

- [ ] **Step 2: Create migration 0032**

Write to `supabase/migrations/0035_athlete_goal_structured.sql`:

```sql
-- 0035_athlete_goal_structured.sql
-- Structured goal fields for the Peter Dashboard's Goal-distance theme.
-- The existing free-form goal narrative on athlete_profile_documents
-- stays as the "why" text; these columns add the "what + by when" so
-- projection math can run.
--
-- goal_metric is required when goal_kind = 'lift_e1rm' (the lift name);
-- null otherwise. Validation lives in app code, not a partial constraint
-- (Phase 1 wizard enforces it).

alter table athlete_profile_documents
  add column goal_kind        text
    check (goal_kind in ('lift_e1rm', 'bodyweight_kg', 'bodyfat_pct')),
  add column goal_metric      text,
  add column goal_target      numeric,
  add column goal_target_date date;
```

- [ ] **Step 3: Apply both migrations via Supabase CLI**

Run:
```bash
supabase db push
```

Expected: both migrations report applied. If history is out of sync, run `supabase migration repair --status applied <history>` per CLAUDE.md.

- [ ] **Step 4: Verify schema in Supabase**

Run:
```bash
psql "$(supabase status -o env | grep DB_URL | cut -d= -f2- | tr -d \")" -c "\d coach_dashboards" -c "\d athlete_profile_documents"
```

Expected: `coach_dashboards` shows 8 columns + the unique index; `athlete_profile_documents` shows the 4 new columns.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0034_peter_dashboard.sql supabase/migrations/0035_athlete_goal_structured.sql
git commit -m "feat(peter): migrations 0031+0032 — coach_dashboards + structured goal fields"
```

---

## Task 2: Types + thresholds module

**Files:**
- Create: `lib/coach/peter-dashboard/types.ts`
- Create: `lib/coach/peter-dashboard/thresholds.ts`
- Modify: `lib/data/types.ts` (append re-export)

- [ ] **Step 1: Write types module**

Write to `lib/coach/peter-dashboard/types.ts`:

```ts
// lib/coach/peter-dashboard/types.ts
//
// Type contracts for the Peter Dashboard payload chain.
// Composers produce ThemePayload; orchestrator assembles PeterDashboardFacts;
// narrative wrap produces Narrative; final stored shape is PeterDashboardPayload.

export type ThemeKey =
  | 'recomp'
  | 'energy'
  | 'fatigue'
  | 'performance'
  | 'plan_adherence'
  | 'goal_distance';

export type Severity = 'ok' | 'warn' | 'urgent';

/** Sparkline series for the expanded card state. `ref` is an optional
 *  reference value (e.g. target line, baseline) rendered as a dashed overlay. */
export type SparklineSeries = {
  label: string;
  series: Array<{ x: string; y: number; ref?: number }>;
};

export type ThemePayload = {
  key: ThemeKey;
  severity: Severity;
  /** Grid-state summary, e.g. "BF +0.4/wk, LBM flat". <= 40 chars. */
  one_line: string;
  /** Deterministic prose fallback. Used when narrative wrap fails. */
  body_md: string;
  /** Numeric/string facts the narrative wrapper may cite. Keys are
   *  composer-defined and stable across regens. */
  facts: Record<string, number | string | null>;
  /** Mini chart for expanded state; null when no chart fits the theme. */
  sparkline: SparklineSeries | null;
  /** Audit trail of which tables/columns were read. Helps the audit script
   *  catch drift if a composer accidentally re-queries something a parent
   *  composer already provided. */
  inputs_used: string[];
};

export type ThemeCluster = {
  id: string;
  themes: ThemeKey[];
  root_hypothesis: string;
};

export type PeterDashboardFacts = {
  themes: Record<ThemeKey, ThemePayload>;
  clusters: ThemeCluster[];
  block_context: {
    block_number: number | null;
    week_of_block: number | null;
    block_total_weeks: number | null;
    primary_lift: string | null;
  };
  goal_summary: {
    kind: 'lift_e1rm' | 'bodyweight_kg' | 'bodyfat_pct' | null;
    metric: string | null;
    target: number | null;
    target_date: string | null;
  };
};

/** Output shape of the single narrative call. Validated before persist. */
export type Narrative = {
  hero: {
    headline: string;
    body_md: string;
  };
  cards: Record<ThemeKey, { narrative_md: string }>;
};

/** Final persisted shape — written to coach_dashboards.payload. */
export type PeterDashboardPayload = {
  schema_version: 1;
  generated_at: string;
  facts: PeterDashboardFacts;
  narrative: Narrative | null;  // null when narrative wrap failed
  narrative_failed: boolean;
};

export const ALL_THEME_KEYS: ThemeKey[] = [
  'recomp',
  'energy',
  'fatigue',
  'performance',
  'plan_adherence',
  'goal_distance',
];

/** Drilldown route per theme. Single source of truth for the expanded
 *  card's "Open …" chip. */
export const THEME_DRILLDOWN: Record<ThemeKey, string> = {
  recomp:         '/diet?view=body',
  energy:         '/diet',
  fatigue:        '/health?tab=trends',
  performance:    '/strength',
  plan_adherence: '/coach',
  goal_distance:  '/profile',
};

export const THEME_LABEL: Record<ThemeKey, string> = {
  recomp:         'Recomp',
  energy:         'Energy',
  fatigue:        'Fatigue',
  performance:    'Performance',
  plan_adherence: 'Plan adherence',
  goal_distance:  'Goal',
};
```

- [ ] **Step 2: Write thresholds module**

Write to `lib/coach/peter-dashboard/thresholds.ts`:

```ts
// lib/coach/peter-dashboard/thresholds.ts
//
// All numeric severity constants live here. Spec section "Composers"
// is the source of truth; this file is the implementation mirror.

// Recomp
export const RECOMP_LBM_HOLD_KG_4W = -0.2;       // LBM "holding" if delta_4w_kg >= this
export const RECOMP_BF_DOWN_PTS_4W = -0.3;       // BF down ≥ this (negative) is "ok"
export const RECOMP_LIFT_HOLD_SLOPE_PCT_4W = -2.5; // top lifts holding if slope > this
export const RECOMP_LBM_LOSS_WARN_KG_4W = -0.2;
export const RECOMP_LBM_LOSS_URGENT_KG_4W = -0.5;
export const RECOMP_LIFT_DROP_URGENT_PCT_4W = -5;

// Energy
export const ENERGY_UNDER_TARGET_KCAL = 150;     // |delta| ≥ this counts as "under"
export const ENERGY_UNDER_DAYS_WARN = 7;
export const ENERGY_GLP1_DEFICIT_PCT_TDEE_URGENT = 0.25;

// Fatigue
export const FATIGUE_REMI_TRIGGER_COUNT_WARN = 1;
export const FATIGUE_REMI_TRIGGER_COUNT_URGENT = 3;
export const FATIGUE_HRV_BELOW_BASELINE_PCT_WARN = -0.05; // 7d sustained

// Performance
export const PERFORMANCE_PLATEAU_WEEKS_WARN = 3;
export const PERFORMANCE_LIFT_DROP_URGENT_PCT_4W = -5;
export const PERFORMANCE_BIGFOUR_PLATEAU_COUNT_URGENT = 2;

// Plan adherence
export const ADHERENCE_PCT_WARN = 0.70;
export const ADHERENCE_PCT_URGENT = 0.50;
export const ADHERENCE_CONSECUTIVE_WEEKS = 2;

// Goal distance
export const GOAL_PACE_RATIO_OK = 0.90;
export const GOAL_PACE_RATIO_WARN = 0.70;
export const GOAL_ETA_MISS_DAYS_URGENT = 14;

// Cluster: theme severities counted as "active" for cluster eligibility
export const CLUSTER_ACTIVE_SEVERITIES: Array<'warn' | 'urgent'> = ['warn', 'urgent'];
```

- [ ] **Step 3: Re-export from `lib/data/types.ts`**

Open `lib/data/types.ts`, append at the bottom:

```ts
// Peter Dashboard types — re-exported here so route handlers and components
// can `import type { PeterDashboardPayload } from '@/lib/data/types'`.
export type {
  ThemeKey,
  Severity,
  SparklineSeries,
  ThemePayload,
  ThemeCluster,
  PeterDashboardFacts,
  Narrative as PeterDashboardNarrative,
  PeterDashboardPayload,
} from '@/lib/coach/peter-dashboard/types';
```

- [ ] **Step 4: Typecheck**

Run:
```bash
npm run typecheck
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add lib/coach/peter-dashboard/types.ts lib/coach/peter-dashboard/thresholds.ts lib/data/types.ts
git commit -m "feat(peter): types + thresholds for peter-dashboard composers"
```

---

## Task 3: Composer — Recomp

**Files:**
- Create: `lib/coach/peter-dashboard/compose-recomp.ts`

This composer is the canonical example for the other composers. It reads only via existing `generateCoachTrends()` + a small protein-adherence aggregation; it does not re-query daily_logs directly.

- [ ] **Step 1: Write composer**

Write to `lib/coach/peter-dashboard/compose-recomp.ts`:

```ts
// lib/coach/peter-dashboard/compose-recomp.ts
//
// Recomp trajectory: are we losing fat while keeping muscle + strength?
// Reads from generateCoachTrends() (body + strength) and food_log
// aggregations. Pure: no LLM, no side effects.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ThemePayload } from './types';
import {
  RECOMP_LBM_HOLD_KG_4W,
  RECOMP_BF_DOWN_PTS_4W,
  RECOMP_LIFT_HOLD_SLOPE_PCT_4W,
  RECOMP_LBM_LOSS_URGENT_KG_4W,
  RECOMP_LIFT_DROP_URGENT_PCT_4W,
} from './thresholds';
import type { CoachTrendsPayload } from '@/lib/data/types';

export async function composeRecomp(args: {
  supabase: SupabaseClient;
  userId: string;
  today: string;
  trends: CoachTrendsPayload;
}): Promise<ThemePayload> {
  const { trends } = args;

  const lbm4w = trends.body.lbm.delta_4w_kg;
  const bf4w  = trends.body.body_fat_pct.delta_4w_pct;
  const topLiftSlopes = trends.strength.per_lift
    .slice(0, 3)
    .map((p) => p.slope_pct_per_wk_4w)
    .filter((s): s is number => s != null);

  const lbmHolding = lbm4w == null ? true : lbm4w >= RECOMP_LBM_HOLD_KG_4W;
  const bfDown     = bf4w  != null && bf4w <= RECOMP_BF_DOWN_PTS_4W;
  const liftsHolding = topLiftSlopes.every(
    (s) => s > RECOMP_LIFT_HOLD_SLOPE_PCT_4W,
  );
  const lbmCollapsing = lbm4w != null && lbm4w < RECOMP_LBM_LOSS_URGENT_KG_4W;
  const liftCollapsing = topLiftSlopes.some(
    (s) => s <= RECOMP_LIFT_DROP_URGENT_PCT_4W,
  );

  let severity: ThemePayload['severity'];
  if (lbmCollapsing && liftCollapsing) severity = 'urgent';
  else if (lbmHolding && bfDown && liftsHolding) severity = 'ok';
  else severity = 'warn';

  // Sparkline: weekly BF % over 12w from body composer's daily series.
  const sparkline = trends.body.body_fat_pct.daily_12w &&
    trends.body.body_fat_pct.daily_12w.length > 0
    ? {
        label: 'Body fat % (12w)',
        series: trends.body.body_fat_pct.daily_12w.map((d) => ({
          x: d.date,
          y: d.value,
        })),
      }
    : null;

  return {
    key: 'recomp',
    severity,
    one_line: oneLineFor({ lbm4w, bf4w }),
    body_md: bodyMdFor({ lbm4w, bf4w, severity }),
    facts: {
      lbm_delta_4w_kg: lbm4w,
      bf_pct_delta_4w_pts: bf4w,
      top_lift_slopes_pct_per_wk_4w: topLiftSlopes.join(','),
    },
    sparkline,
    inputs_used: ['coach_trends.body', 'coach_trends.strength.per_lift'],
  };
}

function oneLineFor(x: { lbm4w: number | null; bf4w: number | null }): string {
  const lbmStr = x.lbm4w == null ? 'LBM —' :
    x.lbm4w >= -0.1 ? 'LBM flat' :
    `LBM ${x.lbm4w.toFixed(1)}kg`;
  const bfStr = x.bf4w == null ? 'BF —' :
    x.bf4w >= 0 ? `BF +${x.bf4w.toFixed(1)}pts` :
    `BF ${x.bf4w.toFixed(1)}pts`;
  return `${bfStr} / 4w · ${lbmStr}`;
}

function bodyMdFor(x: {
  lbm4w: number | null;
  bf4w: number | null;
  severity: ThemePayload['severity'];
}): string {
  if (x.severity === 'ok') {
    return 'LBM holding, body fat trending down, strength preserved. Recomp working.';
  }
  if (x.severity === 'urgent') {
    return `LBM down ${x.lbm4w?.toFixed(1)} kg over 4 weeks and at least one top lift dropped >5%. Cut is too aggressive.`;
  }
  if (x.bf4w != null && x.bf4w > 0) {
    return `Body fat up ${x.bf4w.toFixed(1)} pts over 4 weeks while LBM is ${x.lbm4w == null ? 'unknown' : x.lbm4w >= -0.1 ? 'holding' : `down ${Math.abs(x.lbm4w).toFixed(1)} kg`}. Deficit drift is the likely candidate.`;
  }
  return 'Recomp showing mixed signal across LBM, body fat, and strength. Check the inputs.';
}
```

- [ ] **Step 2: Typecheck**

Run:
```bash
npm run typecheck
```

Expected: pass. `CoachTrendsPayload` already includes `.body.lbm.delta_4w_kg`, `.body.body_fat_pct.delta_4w_pct`, and per_lift slopes — verify by reading `lib/data/types.ts` if the typecheck fails.

- [ ] **Step 3: Commit**

```bash
git add lib/coach/peter-dashboard/compose-recomp.ts
git commit -m "feat(peter): compose-recomp — Body × Strength × LBM theme"
```

---

## Task 4: Composer — Energy availability

**Files:**
- Create: `lib/coach/peter-dashboard/compose-energy.ts`

- [ ] **Step 1: Write composer**

Write to `lib/coach/peter-dashboard/compose-energy.ts`:

```ts
// lib/coach/peter-dashboard/compose-energy.ts
//
// Energy availability: intake vs target, split by training-day vs rest-day,
// with GLP-1 mode awareness. Reads daily_logs aggregations + getTodayTargets
// + workouts presence-per-date for the rest/training split.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ThemePayload } from './types';
import {
  ENERGY_UNDER_TARGET_KCAL,
  ENERGY_UNDER_WINDOW_DAYS_WARN,
  ENERGY_GLP1_DEFICIT_PCT_TDEE_URGENT,
} from './thresholds';
import { getTodayTargets } from '@/lib/morning/brief/get-today-targets';

const WINDOW_DAYS = 14;

export async function composeEnergy(args: {
  supabase: SupabaseClient;
  userId: string;
  today: string;
}): Promise<ThemePayload> {
  const { supabase, userId, today } = args;
  const start = isoDaysAgo(today, WINDOW_DAYS - 1);

  // Targets — kcal target + GLP-1 mode.
  const targets = await getTodayTargets(supabase, userId, today);
  const kcalTarget = targets?.kcal ?? null;
  const isGlp1Active = targets?.glp1_mode === 'active' || targets?.glp1_mode === 'tapering';

  // 14d of daily_logs (kcal + active_calories for TDEE estimate).
  const { data: logs, error: logsErr } = await supabase
    .from('daily_logs')
    .select('date, calories_eaten, active_calories, strain')
    .eq('user_id', userId)
    .gte('date', start)
    .lte('date', today)
    .order('date', { ascending: true });
  if (logsErr) throw logsErr;

  // Workouts in window — used as the training-day vs rest-day flag.
  const { data: workouts, error: woErr } = await supabase
    .from('workouts')
    .select('date')
    .eq('user_id', userId)
    .gte('date', start)
    .lte('date', today);
  if (woErr) throw woErr;
  const trainingDates = new Set((workouts ?? []).map((w) => w.date as string));

  const rows = (logs ?? []).map((r) => ({
    date: r.date as string,
    kcal: (r.calories_eaten as number | null) ?? null,
    active: (r.active_calories as number | null) ?? null,
    trained: trainingDates.has(r.date as string),
  }));

  // Under-target day count.
  let underDays = 0;
  let totalDelta = 0;
  let deltaCount = 0;
  for (const r of rows) {
    if (r.kcal == null || kcalTarget == null) continue;
    const delta = r.kcal - kcalTarget;
    totalDelta += delta;
    deltaCount++;
    if (delta <= -ENERGY_UNDER_TARGET_KCAL) underDays++;
  }
  const avgDelta = deltaCount > 0 ? totalDelta / deltaCount : null;

  // Training vs rest day average kcal.
  const trainKcals = rows.filter((r) => r.trained && r.kcal != null).map((r) => r.kcal!);
  const restKcals  = rows.filter((r) => !r.trained && r.kcal != null).map((r) => r.kcal!);
  const trainAvg = avg(trainKcals);
  const restAvg  = avg(restKcals);

  // GLP-1 deficit alarm (rough TDEE = average daily intake - average daily delta).
  let glp1DeficitUrgent = false;
  if (isGlp1Active && avgDelta != null && kcalTarget != null) {
    const tdeeEst = kcalTarget; // target is calibrated to TDEE in GLP-1 modes
    glp1DeficitUrgent = Math.abs(avgDelta) / tdeeEst > ENERGY_GLP1_DEFICIT_PCT_TDEE_URGENT;
  }

  let severity: ThemePayload['severity'];
  if (glp1DeficitUrgent) severity = 'urgent';
  else if (underDays >= ENERGY_UNDER_WINDOW_DAYS_WARN) severity = 'warn';
  else severity = 'ok';

  return {
    key: 'energy',
    severity,
    one_line: oneLineFor({ underDays, avgDelta }),
    body_md: bodyMdFor({ underDays, avgDelta, trainAvg, restAvg, severity, isGlp1Active }),
    facts: {
      under_target_days_14d: underDays,
      avg_kcal_delta_vs_target: avgDelta == null ? null : Math.round(avgDelta),
      training_day_avg_kcal: trainAvg == null ? null : Math.round(trainAvg),
      rest_day_avg_kcal: restAvg == null ? null : Math.round(restAvg),
      kcal_target: kcalTarget,
      glp1_mode_active: isGlp1Active,
    },
    sparkline: kcalTarget == null ? null : {
      label: 'kcal vs target (14d)',
      series: rows
        .filter((r) => r.kcal != null)
        .map((r) => ({ x: r.date, y: r.kcal!, ref: kcalTarget })),
    },
    inputs_used: [
      'daily_logs.calories_eaten',
      'daily_logs.active_calories',
      'workouts.date',
      'getTodayTargets',
    ],
  };
}

function avg(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function isoDaysAgo(today: string, days: number): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function oneLineFor(x: { underDays: number; avgDelta: number | null }): string {
  if (x.avgDelta == null) return 'No intake data';
  const sign = x.avgDelta >= 0 ? '+' : '';
  return `${sign}${Math.round(x.avgDelta)} kcal × ${x.underDays}d under`;
}

function bodyMdFor(x: {
  underDays: number;
  avgDelta: number | null;
  trainAvg: number | null;
  restAvg: number | null;
  severity: ThemePayload['severity'];
  isGlp1Active: boolean;
}): string {
  if (x.severity === 'ok') return 'Intake tracking target across the window.';
  if (x.severity === 'urgent') {
    return `Under target by ${x.avgDelta != null ? Math.abs(Math.round(x.avgDelta)) : '?'} kcal/d on average with the medication active — risk of muscle and adherence loss.`;
  }
  const split = (x.trainAvg != null && x.restAvg != null)
    ? ` Training-day avg ${Math.round(x.trainAvg)} kcal vs rest-day avg ${Math.round(x.restAvg)} kcal.`
    : '';
  return `Under target ${x.underDays} of last 14 days, averaging ${x.avgDelta != null ? Math.round(x.avgDelta) : '?'} kcal/d delta.${split}`;
}
```

- [ ] **Step 2: Typecheck**

Run:
```bash
npm run typecheck
```

Expected: pass. If `getTodayTargets`'s return shape doesn't expose `glp1_mode`, open [lib/morning/brief/get-today-targets.ts](../../../lib/morning/brief/get-today-targets.ts) and confirm the field name; adjust as needed.

- [ ] **Step 3: Commit**

```bash
git add lib/coach/peter-dashboard/compose-energy.ts
git commit -m "feat(peter): compose-energy — intake vs target × training/rest split"
```

---

## Task 5: Composer — Fatigue debt

**Files:**
- Create: `lib/coach/peter-dashboard/compose-fatigue.ts`

- [ ] **Step 1: Write composer**

Write to `lib/coach/peter-dashboard/compose-fatigue.ts`:

```ts
// lib/coach/peter-dashboard/compose-fatigue.ts
//
// Fatigue debt: composite of HRV, RHR, sleep, strain, and which Remi
// proactive triggers fired in the last 14 days. Reads
// generateRecoveryIntelligence() + chat_messages for trigger lookup.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ThemePayload } from './types';
import {
  FATIGUE_REMI_TRIGGER_COUNT_WARN,
  FATIGUE_REMI_TRIGGER_COUNT_URGENT,
  FATIGUE_HRV_BELOW_BASELINE_PCT_WARN,
} from './thresholds';
import { generateRecoveryIntelligence } from '@/lib/coach/recovery-intelligence';

const DEDUP_WINDOW_DAYS = 14;

export async function composeFatigue(args: {
  supabase: SupabaseClient;
  userId: string;
  today: string;
}): Promise<ThemePayload> {
  const { supabase, userId, today } = args;

  const ri = await generateRecoveryIntelligence({ supabase, userId, today });

  // Remi triggers fired in last 14 days.
  const start = isoDaysAgo(today, DEDUP_WINDOW_DAYS - 1);
  const { data: nudges, error: nErr } = await supabase
    .from('chat_messages')
    .select('ui, created_at')
    .eq('user_id', userId)
    .eq('kind', 'proactive_nudge')
    .eq('speaker', 'remi')
    .gte('created_at', `${start}T00:00:00Z`);
  if (nErr) throw nErr;

  const triggerKeys = (nudges ?? [])
    .map((n) => {
      const ui = n.ui as { trigger_key?: string } | null;
      return ui?.trigger_key ?? null;
    })
    .filter((k): k is string => k != null);
  const uniqueTriggerCount = new Set(triggerKeys).size;

  const hrvVsBaseline7d = ri.weekly.hrv_pct_vs_baseline_7d ?? null;
  const hrvChronicSignal = hrvVsBaseline7d != null && hrvVsBaseline7d <= FATIGUE_HRV_BELOW_BASELINE_PCT_WARN;
  const hrvChronicDepression = triggerKeys.includes('hrv_chronic_depression');

  let severity: ThemePayload['severity'];
  if (uniqueTriggerCount >= FATIGUE_REMI_TRIGGER_COUNT_URGENT || hrvChronicDepression) {
    severity = 'urgent';
  } else if (uniqueTriggerCount >= FATIGUE_REMI_TRIGGER_COUNT_WARN || hrvChronicSignal) {
    severity = 'warn';
  } else {
    severity = 'ok';
  }

  // Sparkline: HRV vs personal baseline over 28d (daily series).
  const hrvSeries = (ri.daily.points ?? [])
    .slice(-28)
    .filter((p) => p.hrv != null)
    .map((p) => ({ x: p.date, y: p.hrv as number, ref: ri.hrv_baseline ?? undefined }));

  return {
    key: 'fatigue',
    severity,
    one_line: oneLineFor({ hrvVsBaseline7d, triggerCount: uniqueTriggerCount }),
    body_md: bodyMdFor({
      hrvVsBaseline7d,
      sleepAvg7d: ri.weekly.sleep_hours_avg_7d ?? null,
      triggerCount: uniqueTriggerCount,
      severity,
    }),
    facts: {
      hrv_vs_baseline_pct_7d: hrvVsBaseline7d,
      sleep_hours_avg_7d: ri.weekly.sleep_hours_avg_7d ?? null,
      remi_triggers_fired_14d: uniqueTriggerCount,
      remi_trigger_keys: triggerKeys.join(','),
    },
    sparkline: hrvSeries.length > 0
      ? { label: 'HRV vs baseline (28d)', series: hrvSeries }
      : null,
    inputs_used: [
      'recovery_intelligence.weekly',
      'recovery_intelligence.daily',
      'chat_messages.kind=proactive_nudge speaker=remi',
    ],
  };
}

function isoDaysAgo(today: string, days: number): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function oneLineFor(x: { hrvVsBaseline7d: number | null; triggerCount: number }): string {
  if (x.hrvVsBaseline7d != null) {
    const pct = (x.hrvVsBaseline7d * 100).toFixed(0);
    const arrow = x.hrvVsBaseline7d < 0 ? '' : '+';
    return `HRV ${arrow}${pct}% vs baseline · ${x.triggerCount} flags`;
  }
  return `${x.triggerCount} Remi flag${x.triggerCount === 1 ? '' : 's'} in 14d`;
}

function bodyMdFor(x: {
  hrvVsBaseline7d: number | null;
  sleepAvg7d: number | null;
  triggerCount: number;
  severity: ThemePayload['severity'];
}): string {
  if (x.severity === 'ok') return 'Recovery markers steady; no Remi flags in the last 14 days.';
  const parts: string[] = [];
  if (x.hrvVsBaseline7d != null && x.hrvVsBaseline7d <= -0.05) {
    parts.push(`HRV ${Math.abs(Math.round(x.hrvVsBaseline7d * 100))}% below baseline (7d)`);
  }
  if (x.sleepAvg7d != null && x.sleepAvg7d < 7) {
    parts.push(`sleep averaging ${x.sleepAvg7d.toFixed(1)}h`);
  }
  if (x.triggerCount > 0) {
    parts.push(`${x.triggerCount} Remi flag${x.triggerCount === 1 ? '' : 's'} in 14d`);
  }
  return parts.length > 0
    ? `${parts.join('; ')}. Recovery is the bottleneck.`
    : 'Recovery off baseline.';
}
```

- [ ] **Step 2: Typecheck**

Run:
```bash
npm run typecheck
```

Expected: pass. If `RecoveryIntelligencePayload` shape differs (field names like `hrv_pct_vs_baseline_7d` / `sleep_hours_avg_7d`), open [lib/coach/recovery-intelligence/types.ts](../../../lib/coach/recovery-intelligence/types.ts) and adjust the property accesses.

- [ ] **Step 3: Commit**

```bash
git add lib/coach/peter-dashboard/compose-fatigue.ts
git commit -m "feat(peter): compose-fatigue — HRV+sleep+strain+Remi-triggers composite"
```

---

## Task 6: Composer — Performance trajectory

**Files:**
- Create: `lib/coach/peter-dashboard/compose-performance.ts`

- [ ] **Step 1: Write composer**

Write to `lib/coach/peter-dashboard/compose-performance.ts`:

```ts
// lib/coach/peter-dashboard/compose-performance.ts
//
// Performance trajectory: per-lift e1RM slopes + active plateau spans.
// Reads from generateCoachTrends().strength (already has slopes + plateau
// flags + weeks-flat counts).

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ThemePayload } from './types';
import {
  PERFORMANCE_PLATEAU_WEEKS_WARN,
  PERFORMANCE_LIFT_DROP_URGENT_PCT_4W,
  PERFORMANCE_BIGFOUR_PLATEAU_COUNT_URGENT,
} from './thresholds';
import type { CoachTrendsPayload } from '@/lib/data/types';

const BIG_FOUR = new Set(['squat', 'deadlift', 'bench', 'ohp']);

export async function composePerformance(args: {
  supabase: SupabaseClient;
  userId: string;
  today: string;
  trends: CoachTrendsPayload;
}): Promise<ThemePayload> {
  const { trends } = args;

  const perLift = trends.strength.per_lift;
  const activePlateaus = perLift.filter((p) => p.plateau_active);
  const longestPlateau = activePlateaus.reduce<typeof perLift[0] | null>(
    (a, b) => (a == null || b.plateau_weeks_flat > a.plateau_weeks_flat ? b : a),
    null,
  );
  const bigFourPlateaued = activePlateaus.filter((p) => {
    const name = p.lift.toLowerCase().replace(/\s*\([^)]+\)/, '');
    return BIG_FOUR.has(name);
  });

  const topDropping = perLift.find(
    (p) => p.slope_pct_per_wk_4w != null &&
           p.slope_pct_per_wk_4w <= PERFORMANCE_LIFT_DROP_URGENT_PCT_4W,
  );

  let severity: ThemePayload['severity'];
  if (
    bigFourPlateaued.length >= PERFORMANCE_BIGFOUR_PLATEAU_COUNT_URGENT ||
    topDropping != null
  ) {
    severity = 'urgent';
  } else if (
    longestPlateau != null &&
    longestPlateau.plateau_weeks_flat >= PERFORMANCE_PLATEAU_WEEKS_WARN
  ) {
    severity = 'warn';
  } else {
    severity = 'ok';
  }

  // Sparkline: top-plateaued (or top-volume) lift's e1RM 12w.
  const headlineLift = longestPlateau ?? perLift[0] ?? null;
  const sparkline = headlineLift && headlineLift.weekly_e1rm_12w?.length
    ? {
        label: `${shortName(headlineLift.lift)} e1RM (12w)`,
        series: headlineLift.weekly_e1rm_12w.map((p) => ({ x: p.week_start, y: p.e1rm })),
      }
    : null;

  return {
    key: 'performance',
    severity,
    one_line: oneLineFor({ longestPlateau, totalPlateaus: activePlateaus.length }),
    body_md: bodyMdFor({ longestPlateau, bigFourPlateaued, severity }),
    facts: {
      active_plateau_count: activePlateaus.length,
      longest_plateau_weeks: longestPlateau?.plateau_weeks_flat ?? null,
      longest_plateau_lift: longestPlateau?.lift ?? null,
      bigfour_plateaued_count: bigFourPlateaued.length,
    },
    sparkline,
    inputs_used: ['coach_trends.strength.per_lift'],
  };
}

function shortName(lift: string): string {
  return lift.replace(/\s*\([^)]+\)/, '');
}

function oneLineFor(x: {
  longestPlateau: { lift: string; plateau_weeks_flat: number } | null;
  totalPlateaus: number;
}): string {
  if (x.longestPlateau == null) return 'Lifts moving';
  return `${shortName(x.longestPlateau.lift)} flat ${x.longestPlateau.plateau_weeks_flat}wk`;
}

function bodyMdFor(x: {
  longestPlateau: { lift: string; plateau_weeks_flat: number } | null;
  bigFourPlateaued: Array<{ lift: string }>;
  severity: ThemePayload['severity'];
}): string {
  if (x.severity === 'ok') return 'No active plateaus; lifts trending up.';
  if (x.bigFourPlateaued.length >= 2) {
    const names = x.bigFourPlateaued.map((p) => shortName(p.lift)).join(' and ');
    return `${names} both plateaued simultaneously. Deload candidate.`;
  }
  if (x.longestPlateau != null) {
    return `${shortName(x.longestPlateau.lift)} flat ${x.longestPlateau.plateau_weeks_flat} weeks — rep-shift or deload at the next weekly review.`;
  }
  return 'Performance flagged but no single dominant pattern.';
}
```

- [ ] **Step 2: Typecheck**

Run:
```bash
npm run typecheck
```

Expected: pass. Confirm `weekly_e1rm_12w` field exists on per_lift entries; if it's named differently in `CoachTrendsPayload`, adjust.

- [ ] **Step 3: Commit**

```bash
git add lib/coach/peter-dashboard/compose-performance.ts
git commit -m "feat(peter): compose-performance — per-lift plateau + slope theme"
```

---

## Task 7: Composer — Plan adherence

**Files:**
- Create: `lib/coach/peter-dashboard/compose-plan-adherence.ts`

- [ ] **Step 1: Write composer**

Write to `lib/coach/peter-dashboard/compose-plan-adherence.ts`:

```ts
// lib/coach/peter-dashboard/compose-plan-adherence.ts
//
// Plan adherence: sessions done vs prescribed (last 4 training_weeks),
// food log coverage (% days with committed entries), mobility marks,
// bedtime SD. All deterministic.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ThemePayload } from './types';
import {
  ADHERENCE_PCT_WARN,
  ADHERENCE_PCT_URGENT,
  ADHERENCE_CONSECUTIVE_WEEKS,
} from './thresholds';

const FOOD_WINDOW_DAYS = 14;

export async function composePlanAdherence(args: {
  supabase: SupabaseClient;
  userId: string;
  today: string;
}): Promise<ThemePayload> {
  const { supabase, userId, today } = args;

  // Last 4 training_weeks for weekly adherence %.
  const { data: weeks, error: wErr } = await supabase
    .from('training_weeks')
    .select('week_start, session_plan, original_session_plan, adherence_pct')
    .eq('user_id', userId)
    .lte('week_start', today)
    .order('week_start', { ascending: false })
    .limit(4);
  if (wErr) throw wErr;
  const weekly = (weeks ?? []).reverse().map((w) => ({
    week_start: w.week_start as string,
    adherence_pct: (w.adherence_pct as number | null) ?? null,
  }));

  // Food log coverage in last 14 days.
  const foodStart = isoDaysAgo(today, FOOD_WINDOW_DAYS - 1);
  const { data: foodDates, error: fErr } = await supabase
    .from('food_log_entries')
    .select('eaten_at')
    .eq('user_id', userId)
    .eq('status', 'committed')
    .gte('eaten_at', `${foodStart}T00:00:00Z`)
    .lte('eaten_at', `${today}T23:59:59Z`);
  if (fErr) throw fErr;
  const foodDays = new Set(
    (foodDates ?? []).map((f) => (f.eaten_at as string).slice(0, 10)),
  );
  const foodCoveragePct = foodDays.size / FOOD_WINDOW_DAYS;

  // Severity from weekly adherence trend.
  const recent2 = weekly.slice(-ADHERENCE_CONSECUTIVE_WEEKS);
  const allBelowUrgent =
    recent2.length >= ADHERENCE_CONSECUTIVE_WEEKS &&
    recent2.every((w) => w.adherence_pct != null && w.adherence_pct < ADHERENCE_PCT_URGENT);
  const allBelowWarn =
    recent2.length >= ADHERENCE_CONSECUTIVE_WEEKS &&
    recent2.every((w) => w.adherence_pct != null && w.adherence_pct < ADHERENCE_PCT_WARN);

  let severity: ThemePayload['severity'];
  if (allBelowUrgent) severity = 'urgent';
  else if (allBelowWarn) severity = 'warn';
  else severity = 'ok';

  const latestAdherence = weekly[weekly.length - 1]?.adherence_pct ?? null;

  return {
    key: 'plan_adherence',
    severity,
    one_line: oneLineFor({ latestAdherence, foodCoveragePct }),
    body_md: bodyMdFor({ weekly, foodCoveragePct, severity }),
    facts: {
      latest_week_adherence_pct: latestAdherence,
      food_log_coverage_pct_14d: round2(foodCoveragePct),
      training_weeks_considered: weekly.length,
    },
    sparkline: weekly.length >= 2
      ? {
          label: 'Weekly adherence',
          series: weekly
            .filter((w) => w.adherence_pct != null)
            .map((w) => ({ x: w.week_start, y: w.adherence_pct! })),
        }
      : null,
    inputs_used: [
      'training_weeks.adherence_pct',
      'food_log_entries (status=committed, 14d)',
    ],
  };
}

function isoDaysAgo(today: string, days: number): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function oneLineFor(x: { latestAdherence: number | null; foodCoveragePct: number }): string {
  const adh = x.latestAdherence == null ? '—' : `${Math.round(x.latestAdherence * 100)}%`;
  const food = `${Math.round(x.foodCoveragePct * 100)}% food`;
  return `${adh} sessions · ${food}`;
}

function bodyMdFor(x: {
  weekly: Array<{ adherence_pct: number | null }>;
  foodCoveragePct: number;
  severity: ThemePayload['severity'];
}): string {
  if (x.severity === 'ok') {
    return 'Sessions and food logging on track. Execution is not the issue.';
  }
  const pcts = x.weekly
    .map((w) => (w.adherence_pct == null ? '—' : `${Math.round(w.adherence_pct * 100)}%`))
    .join('/');
  return `Last weeks ${pcts} adherence. Food coverage ${Math.round(x.foodCoveragePct * 100)}% over 14d.`;
}
```

- [ ] **Step 2: Typecheck**

Run:
```bash
npm run typecheck
```

Expected: pass. `training_weeks.adherence_pct` exists per the schedule-flexibility design ([2026-05-11-schedule-flexibility-design.md](../specs/2026-05-11-schedule-flexibility-design.md)). If the column is named differently, adjust.

- [ ] **Step 3: Commit**

```bash
git add lib/coach/peter-dashboard/compose-plan-adherence.ts
git commit -m "feat(peter): compose-plan-adherence — weekly + food-coverage theme"
```

---

## Task 8: Composer — Goal distance

**Files:**
- Create: `lib/coach/peter-dashboard/compose-goal-distance.ts`

- [ ] **Step 1: Write composer**

Write to `lib/coach/peter-dashboard/compose-goal-distance.ts`:

```ts
// lib/coach/peter-dashboard/compose-goal-distance.ts
//
// Goal distance: structured goal fields × current trajectory × projected ETA.
// Degrades to "Set a structured goal" card when fields are null
// (migration 0032 just added them; backfill is user-driven).

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ThemePayload } from './types';
import {
  GOAL_PACE_RATIO_OK,
  GOAL_PACE_RATIO_WARN,
  GOAL_ETA_MISS_DAYS_URGENT,
} from './thresholds';
import type { CoachTrendsPayload } from '@/lib/data/types';

export async function composeGoalDistance(args: {
  supabase: SupabaseClient;
  userId: string;
  today: string;
  trends: CoachTrendsPayload;
}): Promise<ThemePayload> {
  const { supabase, userId, today, trends } = args;

  // Active (acknowledged) athlete profile document.
  const { data: doc, error } = await supabase
    .from('athlete_profile_documents')
    .select('goal_kind, goal_metric, goal_target, goal_target_date, acknowledged_at')
    .eq('user_id', userId)
    .not('acknowledged_at', 'is', null)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;

  if (!doc || !doc.goal_kind || doc.goal_target == null || !doc.goal_target_date) {
    return degradedCard();
  }

  const targetDate = doc.goal_target_date as string;
  const daysToTarget = daysBetween(today, targetDate);
  if (daysToTarget == null || daysToTarget <= 0) {
    return {
      key: 'goal_distance',
      severity: 'warn',
      one_line: 'Target date passed',
      body_md: 'Goal target date has passed. Refresh the goal in /profile.',
      facts: { goal_kind: doc.goal_kind, days_past_target: -(daysToTarget ?? 0) },
      sparkline: null,
      inputs_used: ['athlete_profile_documents'],
    };
  }

  // Current value + slope from coach trends, by goal_kind.
  const cur = currentAndSlope({
    kind: doc.goal_kind as 'lift_e1rm' | 'bodyweight_kg' | 'bodyfat_pct',
    metric: doc.goal_metric as string | null,
    trends,
  });

  if (cur.current == null) {
    return {
      key: 'goal_distance',
      severity: 'warn',
      one_line: 'No current reading',
      body_md: `Goal set to ${doc.goal_target} ${unitFor(doc.goal_kind as string)} by ${targetDate}, but no current reading is available to project from.`,
      facts: {
        goal_kind: doc.goal_kind,
        goal_target: doc.goal_target as number,
        days_to_target: daysToTarget,
      },
      sparkline: null,
      inputs_used: ['athlete_profile_documents', 'coach_trends'],
    };
  }

  const target = doc.goal_target as number;
  const delta = target - cur.current;
  const requiredRatePerDay = delta / daysToTarget;

  // Project ETA from current trajectory.
  const slopePerDay = cur.slope_per_day;
  const etaDays = slopePerDay !== 0 && Math.sign(slopePerDay) === Math.sign(delta)
    ? Math.abs(delta / slopePerDay)
    : Infinity;
  const etaMissDays = isFinite(etaDays) ? Math.round(etaDays - daysToTarget) : Infinity;

  // pace_ratio: current rate / required rate.
  const paceRatio = requiredRatePerDay === 0
    ? 1
    : slopePerDay / requiredRatePerDay;

  let severity: ThemePayload['severity'];
  if (paceRatio < GOAL_PACE_RATIO_WARN || etaMissDays > GOAL_ETA_MISS_DAYS_URGENT) {
    severity = 'urgent';
  } else if (paceRatio < GOAL_PACE_RATIO_OK) {
    severity = 'warn';
  } else {
    severity = 'ok';
  }

  return {
    key: 'goal_distance',
    severity,
    one_line: oneLineFor({ paceRatio, daysToTarget }),
    body_md: bodyMdFor({
      goalKind: doc.goal_kind as string,
      metric: doc.goal_metric as string | null,
      target,
      current: cur.current,
      daysToTarget,
      paceRatio,
      etaMissDays,
      severity,
    }),
    facts: {
      goal_kind: doc.goal_kind,
      goal_metric: doc.goal_metric,
      goal_target: target,
      current_value: cur.current,
      days_to_target: daysToTarget,
      pace_ratio: round2(paceRatio),
      eta_miss_days: isFinite(etaMissDays) ? etaMissDays : null,
    },
    sparkline: null,
    inputs_used: ['athlete_profile_documents', 'coach_trends'],
  };
}

function degradedCard(): ThemePayload {
  return {
    key: 'goal_distance',
    severity: 'ok',
    one_line: 'Set a structured goal',
    body_md: 'Add goal kind, target value, and target date in /profile to enable projections.',
    facts: { has_structured_goal: false },
    sparkline: null,
    inputs_used: ['athlete_profile_documents'],
  };
}

function currentAndSlope(args: {
  kind: 'lift_e1rm' | 'bodyweight_kg' | 'bodyfat_pct';
  metric: string | null;
  trends: CoachTrendsPayload;
}): { current: number | null; slope_per_day: number } {
  if (args.kind === 'bodyweight_kg') {
    const cur = args.trends.body.weight.current_kg ?? null;
    const ratePerWk = args.trends.body.weight.rate_kg_per_wk_4w ?? 0;
    return { current: cur, slope_per_day: ratePerWk / 7 };
  }
  if (args.kind === 'bodyfat_pct') {
    const cur = args.trends.body.body_fat_pct.current_pct ?? null;
    const deltaPts4w = args.trends.body.body_fat_pct.delta_4w_pct ?? 0;
    return { current: cur, slope_per_day: deltaPts4w / 28 };
  }
  // lift_e1rm
  const lift = args.trends.strength.per_lift.find(
    (p) => p.lift.toLowerCase().includes((args.metric ?? '').toLowerCase()),
  );
  if (!lift) return { current: null, slope_per_day: 0 };
  const cur = lift.latest_e1rm_kg ?? null;
  const slopePctPerWk = lift.slope_pct_per_wk_4w ?? 0;
  const slopeKgPerWk = cur != null ? (slopePctPerWk / 100) * cur : 0;
  return { current: cur, slope_per_day: slopeKgPerWk / 7 };
}

function unitFor(kind: string): string {
  if (kind === 'lift_e1rm') return 'kg';
  if (kind === 'bodyweight_kg') return 'kg';
  if (kind === 'bodyfat_pct') return '%';
  return '';
}

function daysBetween(fromIso: string, toIso: string): number | null {
  const a = new Date(`${fromIso}T00:00:00Z`).getTime();
  const b = new Date(`${toIso}T00:00:00Z`).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / (24 * 3600 * 1000));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function oneLineFor(x: { paceRatio: number; daysToTarget: number }): string {
  if (x.paceRatio >= 1) return `On pace · ${x.daysToTarget}d`;
  return `${Math.round(x.paceRatio * 100)}% pace · ${x.daysToTarget}d`;
}

function bodyMdFor(x: {
  goalKind: string;
  metric: string | null;
  target: number;
  current: number;
  daysToTarget: number;
  paceRatio: number;
  etaMissDays: number;
  severity: ThemePayload['severity'];
}): string {
  const what = x.metric ? `${x.metric}` : x.goalKind.replace(/_/g, ' ');
  if (x.severity === 'ok') {
    return `${what} on pace for ${x.target}${unitFor(x.goalKind)} by target date — current ${x.current.toFixed(1)}${unitFor(x.goalKind)}.`;
  }
  if (x.severity === 'urgent') {
    const miss = isFinite(x.etaMissDays) ? ` Current trajectory misses by ~${x.etaMissDays} days.` : '';
    return `${what} at ${Math.round(x.paceRatio * 100)}% of required pace toward ${x.target}${unitFor(x.goalKind)}.${miss}`;
  }
  return `${what} pace running slightly behind — ${Math.round(x.paceRatio * 100)}% of what's needed for ${x.target}${unitFor(x.goalKind)}.`;
}
```

- [ ] **Step 2: Typecheck**

Run:
```bash
npm run typecheck
```

Expected: pass. If `body.weight.current_kg`, `body.body_fat_pct.current_pct`, or `latest_e1rm_kg` aren't in `CoachTrendsPayload`, fall back to a Supabase read (latest `daily_logs` row).

- [ ] **Step 3: Commit**

```bash
git add lib/coach/peter-dashboard/compose-goal-distance.ts
git commit -m "feat(peter): compose-goal-distance — structured goal × pace ratio × ETA"
```

---

## Task 9: Cluster detection (`link-themes`)

**Files:**
- Create: `lib/coach/peter-dashboard/link-themes.ts`

- [ ] **Step 1: Write cluster detector**

Write to `lib/coach/peter-dashboard/link-themes.ts`:

```ts
// lib/coach/peter-dashboard/link-themes.ts
//
// Deterministic pairwise cluster rules. After composers run, this detects
// theme combinations that likely share a root cause and produces named
// clusters. The narrative wrapper uses these to write "these are the same
// problem" prose instead of treating each theme independently.

import type { ThemePayload, ThemeCluster, ThemeKey } from './types';
import { CLUSTER_ACTIVE_SEVERITIES } from './thresholds';

const ACTIVE = new Set<string>(CLUSTER_ACTIVE_SEVERITIES);

function isActive(t: ThemePayload | undefined): boolean {
  return !!t && ACTIVE.has(t.severity);
}

export function linkThemes(
  themes: Record<ThemeKey, ThemePayload>,
): ThemeCluster[] {
  const clusters: ThemeCluster[] = [];

  const energy   = themes.energy;
  const fatigue  = themes.fatigue;
  const perf     = themes.performance;
  const recomp   = themes.recomp;
  const adh      = themes.plan_adherence;
  const goal     = themes.goal_distance;

  // Rule 1: energy + fatigue + performance plateau → deficit-too-aggressive cluster.
  const perfHasPlateau =
    perf && (perf.facts['active_plateau_count'] as number | null) != null &&
    (perf.facts['active_plateau_count'] as number) > 0;
  if (isActive(energy) && isActive(fatigue) && perfHasPlateau) {
    clusters.push({
      id: 'energy-fatigue-perf',
      themes: ['energy', 'fatigue', 'performance'],
      root_hypothesis:
        'deficit too aggressive given training load — energy gap is depressing recovery and stalling lifts',
    });
  }

  // Rule 2: recomp BF drift + energy under-target → rest-day-deficit-drift cluster.
  const recompBfDrift = recomp != null &&
    (recomp.facts['bf_pct_delta_4w_pts'] as number | null) != null &&
    (recomp.facts['bf_pct_delta_4w_pts'] as number) > 0;
  const energyUnder = energy != null &&
    (energy.facts['under_target_days_14d'] as number | null) != null &&
    (energy.facts['under_target_days_14d'] as number) >= 5;
  if (recompBfDrift && energyUnder) {
    // Skip if already in Rule 1 cluster.
    const inRule1 = clusters.some(
      (c) => c.id === 'energy-fatigue-perf' && c.themes.includes('energy'),
    );
    if (!inRule1) {
      clusters.push({
        id: 'recomp-energy',
        themes: ['recomp', 'energy'],
        root_hypothesis:
          'deficit drifts on rest days — body fat creeps while training-day intake hides the gap',
      });
    }
  }

  // Rule 3: fatigue urgent + adherence warn → symptom-or-cause cluster.
  if (
    fatigue != null && fatigue.severity === 'urgent' &&
    adh != null && (adh.severity === 'warn' || adh.severity === 'urgent')
  ) {
    clusters.push({
      id: 'fatigue-adherence',
      themes: ['fatigue', 'plan_adherence'],
      root_hypothesis:
        'missing sessions when fatigue spikes — chicken-and-egg, may need a planned deload',
    });
  }

  // Rule 4: performance plateau + goal warn → off-pace-from-stall cluster.
  if (perfHasPlateau && goal != null && (goal.severity === 'warn' || goal.severity === 'urgent')) {
    clusters.push({
      id: 'performance-goal',
      themes: ['performance', 'goal_distance'],
      root_hypothesis:
        'goal pace slipping because the lifts that drive it have stalled',
    });
  }

  return clusters;
}
```

- [ ] **Step 2: Typecheck**

Run:
```bash
npm run typecheck
```

Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add lib/coach/peter-dashboard/link-themes.ts
git commit -m "feat(peter): link-themes — pairwise cluster detection"
```

---

## Task 10: Narrative wrap (single Sonnet call)

**Files:**
- Create: `lib/coach/peter-dashboard/narrative-prompt.ts`
- Create: `lib/coach/peter-dashboard/narrate.ts`

- [ ] **Step 1: Write narrative system prompt**

Write to `lib/coach/peter-dashboard/narrative-prompt.ts`:

```ts
// lib/coach/peter-dashboard/narrative-prompt.ts
//
// System prompt for the single Sonnet 4.6 call that wraps the structured
// PeterDashboardFacts in Peter's voice. Mirrors the weekly-review pattern.

import type { PeterDashboardFacts } from './types';

export const NARRATIVE_SYSTEM_PROMPT = `You are Peter, the Head Coach. The team's data has been synthesized into six cross-domain themes (Recomp / Energy / Fatigue / Performance / Plan adherence / Goal). Your job is to render this synthesis in your voice for the athlete to read on their dashboard.

Voice rules: concrete numbers always (kg, %, kcal, ms, days). Second person ("you"). No emoji. No markdown headings — that's structural. Plain coach prose.

Output strictly as JSON matching this shape — no surrounding markdown, no commentary:
{
  "hero": {
    "headline": "<= 20 words, 1 sentence — names THE most pressing theme or 'On track'",
    "body_md": "<= 60 words, 2-3 sentences — synthesis. When clusters[] is non-empty, you MUST name the cluster relationship in this body."
  },
  "cards": {
    "recomp":         { "narrative_md": "<= 50 words, 1-3 sentences" },
    "energy":         { "narrative_md": "<= 50 words" },
    "fatigue":        { "narrative_md": "<= 50 words" },
    "performance":    { "narrative_md": "<= 50 words" },
    "plan_adherence": { "narrative_md": "<= 50 words" },
    "goal_distance":  { "narrative_md": "<= 50 words" }
  }
}

Rules:
1. Every numeric token you emit must appear in the facts payload. Do not invent.
2. When a theme is in a cluster, that card's narrative MUST reference the cluster relationship (e.g. "same gap that's stalling your bench").
3. Cite the most informative fact per card. For 'ok' severity, one short sentence is enough.
4. No padding, no disclaimers, no "I'd recommend".`;

export function buildUserMessage(facts: PeterDashboardFacts): string {
  return JSON.stringify(facts);
}
```

- [ ] **Step 2: Write narrate.ts with validation + retry + fallback**

Write to `lib/coach/peter-dashboard/narrate.ts`:

```ts
// lib/coach/peter-dashboard/narrate.ts
//
// Single Sonnet 4.6 call wrapping the facts payload. Validates output shape
// + fabrication-checks every numeric token. Retries once on failure with
// the offending text quoted. Falls back to deterministic body_md when the
// retry also fails — the dashboard still renders, just clinically.

import { callClaude } from '@/lib/anthropic/client';
import { NARRATIVE_MODEL } from '@/lib/anthropic/models';
import type {
  PeterDashboardFacts,
  Narrative,
  ThemeKey,
  ThemePayload,
} from './types';
import { ALL_THEME_KEYS } from './types';
import { NARRATIVE_SYSTEM_PROMPT, buildUserMessage } from './narrative-prompt';

const MAX_TOKENS = 900;

type NarrateResult = {
  narrative: Narrative | null;
  failed: boolean;
  failure_reason?: string;
};

export async function narrate(facts: PeterDashboardFacts): Promise<NarrateResult> {
  let attempt = 0;
  let lastError: string | null = null;

  while (attempt < 2) {
    attempt++;
    const systemPrompt = attempt === 1
      ? NARRATIVE_SYSTEM_PROMPT
      : `${NARRATIVE_SYSTEM_PROMPT}\n\nPrior attempt failed validation with: ${lastError}\nRetry. Fix the offending text. Same JSON shape.`;

    let raw: string;
    try {
      raw = await callClaude(
        [{ role: 'user', content: buildUserMessage(facts) }],
        {
          model: NARRATIVE_MODEL,
          system: systemPrompt,
          maxTokens: MAX_TOKENS,
          cacheSystem: true,
        },
      );
    } catch (e) {
      lastError = `claude call threw: ${String(e)}`;
      continue;
    }

    const parsed = tryParse(raw);
    if (!parsed.ok) {
      lastError = parsed.error;
      continue;
    }

    const validation = validate(parsed.narrative, facts);
    if (!validation.ok) {
      lastError = validation.error;
      continue;
    }

    return { narrative: parsed.narrative, failed: false };
  }

  return { narrative: null, failed: true, failure_reason: lastError ?? 'unknown' };
}

function tryParse(raw: string): { ok: true; narrative: Narrative } | { ok: false; error: string } {
  // Strip ```json fences if present.
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    return { ok: false, error: `JSON parse: ${String(e)}` };
  }
  if (
    typeof parsed !== 'object' || parsed == null ||
    typeof (parsed as { hero?: unknown }).hero !== 'object' ||
    typeof (parsed as { cards?: unknown }).cards !== 'object'
  ) {
    return { ok: false, error: 'shape: missing hero or cards' };
  }
  const n = parsed as Narrative;
  for (const k of ALL_THEME_KEYS) {
    if (typeof n.cards[k]?.narrative_md !== 'string') {
      return { ok: false, error: `shape: missing cards.${k}.narrative_md` };
    }
  }
  return { ok: true, narrative: n };
}

function validate(n: Narrative, facts: PeterDashboardFacts): { ok: true } | { ok: false; error: string } {
  // Word caps.
  if (countWords(n.hero.headline) > 20) {
    return { ok: false, error: `hero.headline > 20 words: "${n.hero.headline}"` };
  }
  if (countWords(n.hero.body_md) > 60) {
    return { ok: false, error: `hero.body_md > 60 words` };
  }
  for (const k of ALL_THEME_KEYS) {
    if (countWords(n.cards[k].narrative_md) > 50) {
      return { ok: false, error: `cards.${k}.narrative_md > 50 words` };
    }
  }

  // Fabrication check: every numeric token in narrative text must exist in facts.
  const allowed = collectAllowedNumbers(facts);
  const offenders: string[] = [];
  for (const text of [n.hero.headline, n.hero.body_md, ...ALL_THEME_KEYS.map((k) => n.cards[k].narrative_md)]) {
    for (const tok of extractNumericTokens(text)) {
      if (!allowed.has(tok)) offenders.push(tok);
    }
  }
  if (offenders.length > 0) {
    return { ok: false, error: `numeric tokens not in facts: ${offenders.slice(0, 5).join(', ')}` };
  }

  // Cluster mention enforcement: when facts.clusters is non-empty, hero.body_md
  // must reference at least one cluster theme pair OR the affected cards must
  // each name the partner theme.
  if (facts.clusters.length > 0) {
    const heroText = n.hero.body_md.toLowerCase();
    const heroNamesAnyCluster = facts.clusters.some((c) =>
      c.themes.every((t) => heroText.includes(themeMention(t).toLowerCase())),
    );
    if (!heroNamesAnyCluster) {
      return { ok: false, error: 'cluster present but hero.body_md does not name the cluster relationship' };
    }
  }

  return { ok: true };
}

function themeMention(k: ThemeKey): string {
  return ({
    recomp: 'recomp',
    energy: 'energy',
    fatigue: 'fatigue',
    performance: 'performance',
    plan_adherence: 'adherence',
    goal_distance: 'goal',
  } as Record<ThemeKey, string>)[k];
}

function collectAllowedNumbers(facts: PeterDashboardFacts): Set<string> {
  const out = new Set<string>();
  const push = (v: unknown) => {
    if (typeof v === 'number') {
      // Allow the raw number and a few common renderings (with sign, rounded).
      out.add(String(v));
      out.add(String(Math.round(v)));
      out.add(String(Math.round(v * 10) / 10));
      out.add(String(Math.abs(v)));
      out.add(String(Math.abs(Math.round(v))));
      out.add(String(Math.round(Math.abs(v) * 10) / 10));
      if (Number.isInteger(v)) out.add(String(v));
      // Percentages: facts often store decimals (0.07 == 7%); allow the
      // multiplied-by-100 form too.
      out.add(String(Math.round(v * 100)));
    }
    if (typeof v === 'string') {
      // String fields may carry comma-separated numerics ("3.2,-1.1,0.4").
      for (const t of v.split(/[,\s]+/)) {
        const n = Number(t);
        if (Number.isFinite(n)) push(n);
      }
    }
  };
  for (const t of Object.values(facts.themes)) {
    for (const v of Object.values(t.facts)) push(v);
  }
  push(facts.block_context.block_number);
  push(facts.block_context.week_of_block);
  push(facts.goal_summary.target);
  // Always allow small integers and percentages for general prose.
  for (let i = 0; i <= 100; i++) out.add(String(i));
  return out;
}

function extractNumericTokens(text: string): string[] {
  return Array.from(text.matchAll(/-?\d+(?:\.\d+)?/g)).map((m) => m[0]);
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Build a deterministic fallback Narrative from theme body_md fields.
 *  Used when narrate() returns failed=true. */
export function fallbackNarrative(
  themes: Record<ThemeKey, ThemePayload>,
): Narrative {
  const urgent = ALL_THEME_KEYS
    .map((k) => themes[k])
    .filter((t) => t.severity === 'urgent');
  const warn = ALL_THEME_KEYS
    .map((k) => themes[k])
    .filter((t) => t.severity === 'warn');
  const headline = urgent.length > 0
    ? `${themeLabel(urgent[0].key)} urgent — ${urgent[0].one_line}`
    : warn.length > 0
      ? `${themeLabel(warn[0].key)} watch — ${warn[0].one_line}`
      : 'On track';
  const body_md = urgent.length > 0
    ? urgent[0].body_md
    : warn.length > 0
      ? warn[0].body_md
      : 'No urgent or watch-level themes today.';
  const cards = Object.fromEntries(
    ALL_THEME_KEYS.map((k) => [k, { narrative_md: themes[k].body_md }]),
  ) as Record<ThemeKey, { narrative_md: string }>;
  return { hero: { headline, body_md }, cards };
}

function themeLabel(k: ThemeKey): string {
  return ({
    recomp: 'Recomp',
    energy: 'Energy',
    fatigue: 'Fatigue',
    performance: 'Performance',
    plan_adherence: 'Plan adherence',
    goal_distance: 'Goal',
  } as Record<ThemeKey, string>)[k];
}
```

- [ ] **Step 3: Typecheck**

Run:
```bash
npm run typecheck
```

Expected: pass. If `callClaude`'s options shape is different, open [lib/anthropic/client.ts](../../../lib/anthropic/client.ts) and adjust the call.

- [ ] **Step 4: Commit**

```bash
git add lib/coach/peter-dashboard/narrative-prompt.ts lib/coach/peter-dashboard/narrate.ts
git commit -m "feat(peter): narrate — single Sonnet wrap + fabrication check + retry + fallback"
```

---

## Task 11: Orchestrator + injection renderer

**Files:**
- Create: `lib/coach/peter-dashboard/render-injection.ts`
- Create: `lib/coach/peter-dashboard/index.ts`

- [ ] **Step 1: Write render-injection (builds "Today's read" markdown)**

Write to `lib/coach/peter-dashboard/render-injection.ts`:

```ts
// lib/coach/peter-dashboard/render-injection.ts
//
// Renders the "Today's read" markdown block that gets injected into
// Peter's system prompt. Single source of truth so the block on the
// dashboard UI and the block in the prompt cannot diverge.

import type { PeterDashboardPayload, ThemeKey } from './types';
import { ALL_THEME_KEYS, THEME_LABEL } from './types';

export function renderInjectionBlock(
  payload: PeterDashboardPayload,
  generatedOn: string,
): string {
  const n = payload.narrative;
  if (n == null) {
    return '# Today\'s read\n\nNot generated successfully today — synthesize from the snapshot directly.';
  }

  const lines: string[] = [];
  lines.push(`# Today's read (Peter — generated ${generatedOn} 04:00 UTC)`);
  lines.push('');
  lines.push(`> ${n.hero.headline}`);
  lines.push('>');
  lines.push(`> ${n.hero.body_md}`);
  lines.push('');

  for (const k of ALL_THEME_KEYS) {
    const sev = payload.facts.themes[k].severity;
    lines.push(`## ${THEME_LABEL[k]} — ${sev}`);
    lines.push(n.cards[k].narrative_md);
    lines.push('');
  }

  if (payload.facts.clusters.length > 0) {
    lines.push('---');
    for (const c of payload.facts.clusters) {
      lines.push(
        `Cluster (same root): ${c.themes.map((t) => THEME_LABEL[t]).join(' + ')}. Root hypothesis: ${c.root_hypothesis}.`,
      );
    }
    lines.push('');
  }

  lines.push('Use these takes when answering today\'s questions. If the user asks about a theme, ground in the card\'s specifics rather than re-deriving.');

  return lines.join('\n');
}

/** Placeholder used when there's no row yet (first-run user, cron hasn't fired). */
export function noPayloadInjection(): string {
  return '# Today\'s read\n\nNot yet generated — synthesize from the snapshot directly.';
}
```

- [ ] **Step 2: Write orchestrator**

Write to `lib/coach/peter-dashboard/index.ts`:

```ts
// lib/coach/peter-dashboard/index.ts
//
// Orchestrator. Parallel-runs the 6 composers, detects clusters, runs the
// narrative wrap, returns the typed PeterDashboardPayload. Also exposes
// loadLatestPeterDashboard() for readers (chat-stream, dashboard UI).

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  PeterDashboardFacts,
  PeterDashboardPayload,
  ThemeKey,
  ThemePayload,
} from './types';
import { ALL_THEME_KEYS } from './types';
import { composeRecomp } from './compose-recomp';
import { composeEnergy } from './compose-energy';
import { composeFatigue } from './compose-fatigue';
import { composePerformance } from './compose-performance';
import { composePlanAdherence } from './compose-plan-adherence';
import { composeGoalDistance } from './compose-goal-distance';
import { linkThemes } from './link-themes';
import { narrate, fallbackNarrative } from './narrate';
import { generateCoachTrends } from '@/lib/coach/trends';

export async function generatePeterDashboard(args: {
  supabase: SupabaseClient;
  userId: string;
  today: string;
}): Promise<PeterDashboardPayload> {
  const { supabase, userId, today } = args;

  // Trends payload is the parent dependency for 3 composers.
  const trends = await generateCoachTrends({ supabase, userId, today });

  const [recomp, energy, fatigue, performance, planAdherence, goalDistance] =
    await Promise.all([
      composeRecomp({ supabase, userId, today, trends }),
      composeEnergy({ supabase, userId, today }),
      composeFatigue({ supabase, userId, today }),
      composePerformance({ supabase, userId, today, trends }),
      composePlanAdherence({ supabase, userId, today }),
      composeGoalDistance({ supabase, userId, today, trends }),
    ]);

  const themes: Record<ThemeKey, ThemePayload> = {
    recomp, energy, fatigue, performance,
    plan_adherence: planAdherence,
    goal_distance: goalDistance,
  };

  const clusters = linkThemes(themes);

  // Block + goal context for the narrative call.
  const blockContext = await fetchBlockContext(supabase, userId, today);
  const goalSummary = await fetchGoalSummary(supabase, userId);

  const facts: PeterDashboardFacts = {
    themes,
    clusters,
    block_context: blockContext,
    goal_summary: goalSummary,
  };

  const narrateResult = await narrate(facts);
  const narrative = narrateResult.failed
    ? fallbackNarrative(themes)
    : narrateResult.narrative!;

  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    facts,
    narrative: narrateResult.failed ? null : narrative,
    narrative_failed: narrateResult.failed,
  };
}

async function fetchBlockContext(
  supabase: SupabaseClient,
  userId: string,
  today: string,
): Promise<PeterDashboardFacts['block_context']> {
  const { data, error } = await supabase
    .from('training_blocks')
    .select('block_number, start_date, end_date, total_weeks, primary_lift')
    .eq('user_id', userId)
    .lte('start_date', today)
    .gte('end_date', today)
    .order('start_date', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) {
    return { block_number: null, week_of_block: null, block_total_weeks: null, primary_lift: null };
  }
  const startMs = new Date(`${data.start_date as string}T00:00:00Z`).getTime();
  const todayMs = new Date(`${today}T00:00:00Z`).getTime();
  const weekOf = Math.floor((todayMs - startMs) / (7 * 24 * 3600 * 1000)) + 1;
  return {
    block_number: (data.block_number as number | null) ?? null,
    week_of_block: weekOf,
    block_total_weeks: (data.total_weeks as number | null) ?? null,
    primary_lift: (data.primary_lift as string | null) ?? null,
  };
}

async function fetchGoalSummary(
  supabase: SupabaseClient,
  userId: string,
): Promise<PeterDashboardFacts['goal_summary']> {
  const { data, error } = await supabase
    .from('athlete_profile_documents')
    .select('goal_kind, goal_metric, goal_target, goal_target_date')
    .eq('user_id', userId)
    .not('acknowledged_at', 'is', null)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) {
    return { kind: null, metric: null, target: null, target_date: null };
  }
  return {
    kind: (data.goal_kind as PeterDashboardFacts['goal_summary']['kind']) ?? null,
    metric: (data.goal_metric as string | null) ?? null,
    target: (data.goal_target as number | null) ?? null,
    target_date: (data.goal_target_date as string | null) ?? null,
  };
}

/** Reader used by the SSR-hydrate fetcher and chat-stream injection.
 *  Returns the latest version row for the given date — null when none exists. */
export async function loadLatestPeterDashboard(
  supabase: SupabaseClient,
  userId: string,
  date: string,
): Promise<{ payload: PeterDashboardPayload; narrative_md: string; generated_on: string; version: number } | null> {
  const { data, error } = await supabase
    .from('coach_dashboards')
    .select('payload, narrative_md, generated_on, version')
    .eq('user_id', userId)
    .eq('generated_on', date)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return {
    payload: data.payload as PeterDashboardPayload,
    narrative_md: data.narrative_md as string,
    generated_on: data.generated_on as string,
    version: data.version as number,
  };
}
```

- [ ] **Step 3: Typecheck**

Run:
```bash
npm run typecheck
```

Expected: pass. If `training_blocks` columns differ, adjust the select.

- [ ] **Step 4: Commit**

```bash
git add lib/coach/peter-dashboard/index.ts lib/coach/peter-dashboard/render-injection.ts
git commit -m "feat(peter): orchestrator + reader + render-injection"
```

---

## Task 12: Cron + regenerate endpoints + vercel.json

**Files:**
- Create: `app/api/coach/dashboard/sync/route.ts`
- Create: `app/api/coach/dashboard/regenerate/route.ts`
- Modify: `vercel.json`

- [ ] **Step 1: Write sync (cron) endpoint**

Write to `app/api/coach/dashboard/sync/route.ts`:

```ts
// app/api/coach/dashboard/sync/route.ts
//
// Cron entrypoint. Daily 04:00 UTC. Idempotent on (user_id, today, version=1):
// if a v1 row exists, returns it without re-running composers.

import { NextResponse } from 'next/server';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { generatePeterDashboard } from '@/lib/coach/peter-dashboard';
import { renderInjectionBlock } from '@/lib/coach/peter-dashboard/render-injection';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: Request) {
  const auth = req.headers.get('authorization') ?? '';
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || !auth.startsWith('Bearer ') || auth.slice(7) !== cronSecret) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const sb = createSupabaseServiceRoleClient();

  const { data: profile, error: pErr } = await sb
    .from('profiles')
    .select('user_id')
    .order('created_at', { ascending: true })
    .limit(1)
    .single();
  if (pErr || !profile) {
    return NextResponse.json({ error: 'no user', detail: pErr?.message }, { status: 404 });
  }
  const userId = profile.user_id as string;

  const today = new Date().toISOString().slice(0, 10);

  // Idempotent on v1.
  const { data: existing } = await sb
    .from('coach_dashboards')
    .select('id, status, version')
    .eq('user_id', userId)
    .eq('generated_on', today)
    .eq('version', 1)
    .maybeSingle();
  if (existing) {
    return NextResponse.json({ ok: true, skipped: 'exists', existing_id: existing.id });
  }

  const t0 = Date.now();
  try {
    const payload = await generatePeterDashboard({ supabase: sb, userId, today });
    const narrative_md = renderInjectionBlock(payload, today);

    const { data: inserted, error: insErr } = await sb
      .from('coach_dashboards')
      .insert({
        user_id: userId,
        generated_on: today,
        version: 1,
        status: payload.narrative_failed ? 'failed' : 'ready',
        payload,
        narrative_md,
      })
      .select('id')
      .single();
    if (insErr) throw insErr;

    const tookMs = Date.now() - t0;
    console.info('[peter-dashboard.sync]', {
      userId,
      generated_on: today,
      version: 1,
      status: payload.narrative_failed ? 'failed' : 'ready',
      narrative_failed: payload.narrative_failed,
      took_ms: tookMs,
    });

    return NextResponse.json({ ok: true, id: inserted.id, status: payload.narrative_failed ? 'failed' : 'ready' });
  } catch (e) {
    console.error('[peter-dashboard.sync] failed', e);
    return NextResponse.json({ error: 'generation_failed', detail: String(e) }, { status: 500 });
  }
}
```

- [ ] **Step 2: Write regenerate endpoint**

Write to `app/api/coach/dashboard/regenerate/route.ts`:

```ts
// app/api/coach/dashboard/regenerate/route.ts
//
// Manual regen. Inserts a new row at (user_id, today, max(version) + 1).
// Rate-limited 6/day per user via row count.

import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { createSupabaseServerClient, createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { generatePeterDashboard } from '@/lib/coach/peter-dashboard';
import { renderInjectionBlock } from '@/lib/coach/peter-dashboard/render-injection';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const DAILY_REGEN_CAP = 6;

export async function POST() {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const sb = createSupabaseServiceRoleClient();
  const today = new Date().toISOString().slice(0, 10);

  // Rate limit: count existing rows for today.
  const { data: rows, error: countErr } = await sb
    .from('coach_dashboards')
    .select('version')
    .eq('user_id', user.id)
    .eq('generated_on', today)
    .order('version', { ascending: false });
  if (countErr) {
    return NextResponse.json({ error: 'count_failed', detail: countErr.message }, { status: 500 });
  }

  if ((rows?.length ?? 0) >= DAILY_REGEN_CAP) {
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(0, 0, 0, 0);
    return NextResponse.json(
      { error: 'rate_limited', retry_after: tomorrow.toISOString() },
      { status: 429 },
    );
  }

  const nextVersion = (rows?.[0]?.version as number | undefined ?? 0) + 1;

  try {
    const payload = await generatePeterDashboard({ supabase: sb, userId: user.id, today });
    const narrative_md = renderInjectionBlock(payload, today);

    const { data: inserted, error: insErr } = await sb
      .from('coach_dashboards')
      .insert({
        user_id: user.id,
        generated_on: today,
        version: nextVersion,
        status: payload.narrative_failed ? 'failed' : 'ready',
        payload,
        narrative_md,
      })
      .select('id, version')
      .single();
    if (insErr) throw insErr;

    revalidatePath('/coach');

    return NextResponse.json({
      ok: true,
      id: inserted.id,
      version: inserted.version,
      status: payload.narrative_failed ? 'failed' : 'ready',
    });
  } catch (e) {
    console.error('[peter-dashboard.regenerate] failed', e);
    return NextResponse.json({ error: 'generation_failed', detail: String(e) }, { status: 500 });
  }
}
```

- [ ] **Step 3: Add cron entry to vercel.json**

Open `vercel.json` and add the new cron in the `crons` array (after the weekly-review entries):

```json
    {
      "path": "/api/coach/dashboard/sync",
      "schedule": "0 4 * * *"
    },
```

- [ ] **Step 4: Typecheck**

Run:
```bash
npm run typecheck
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add app/api/coach/dashboard/sync/route.ts app/api/coach/dashboard/regenerate/route.ts vercel.json
git commit -m "feat(peter): cron + regenerate endpoints + daily 04:00 UTC schedule"
```

---

## Task 13: Query keys + fetcher + hook

**Files:**
- Modify: `lib/query/keys.ts`
- Create: `lib/query/fetchers/peterDashboard.ts`
- Create: `lib/query/hooks/usePeterDashboard.ts`

- [ ] **Step 1: Add query keys**

Open `lib/query/keys.ts` and find the block with `coachTrends` / `recoveryIntelligence`. Add a sibling entry:

```ts
  peterDashboard: {
    all: (userId: string) => ["peterDashboard", userId] as const,
    latest: (userId: string, date: string) =>
      ["peterDashboard", userId, "latest", date] as const,
  },
```

- [ ] **Step 2: Write fetcher pair**

Write to `lib/query/fetchers/peterDashboard.ts`:

```ts
// lib/query/fetchers/peterDashboard.ts
//
// Pair matches the existing recoveryIntelligence / coachTrends pattern:
// server fetcher does the real read; browser fetcher throws by design
// (SSR-hydrate only). The hook sets staleTime: Infinity so TanStack Query
// trusts the dehydrated cache and never triggers the browser fetcher.

import type { SupabaseClient } from '@supabase/supabase-js';
import { loadLatestPeterDashboard } from '@/lib/coach/peter-dashboard';
import type { PeterDashboardPayload } from '@/lib/data/types';

export type PeterDashboardRow = {
  payload: PeterDashboardPayload;
  narrative_md: string;
  generated_on: string;
  version: number;
} | null;

export async function fetchPeterDashboardServer(
  supabase: SupabaseClient,
  userId: string,
  today: string,
): Promise<PeterDashboardRow> {
  return loadLatestPeterDashboard(supabase, userId, today);
}

export async function fetchPeterDashboardBrowser(): Promise<PeterDashboardRow> {
  throw new Error(
    'peterDashboard browser fetcher: not implemented — use SSR hydrate only.',
  );
}
```

- [ ] **Step 3: Write hook**

Write to `lib/query/hooks/usePeterDashboard.ts`:

```ts
'use client';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query/keys';
import {
  fetchPeterDashboardBrowser,
  type PeterDashboardRow,
} from '@/lib/query/fetchers/peterDashboard';

export function usePeterDashboard(userId: string, today: string) {
  return useQuery<PeterDashboardRow>({
    queryKey: queryKeys.peterDashboard.latest(userId, today),
    queryFn: fetchPeterDashboardBrowser,
    enabled: !!userId && !!today,
    // SSR-hydrate-only. Browser fetcher throws by design — see useRecoveryIntelligence.
    staleTime: Infinity,
  });
}
```

- [ ] **Step 4: Typecheck**

Run:
```bash
npm run typecheck
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add lib/query/keys.ts lib/query/fetchers/peterDashboard.ts lib/query/hooks/usePeterDashboard.ts
git commit -m "feat(peter): query keys + fetcher + hook for SSR-hydrate"
```

---

## Task 14: `/coach` route + sub-tabs + chat extraction

**Files:**
- Create: `app/coach/page.tsx`
- Create: `components/coach/PeterChatClient.tsx`
- Modify: `app/metrics/page.tsx` (delete after move)
- Modify: `components/metrics/MetricsClient.tsx` (delete after move)

- [ ] **Step 1: Extract chat client**

Write to `components/coach/PeterChatClient.tsx`:

```tsx
'use client';

import ChatPanel from '@/components/chat/ChatPanel';
import { useMarkThreadSeen } from '@/lib/chat/use-mark-thread-seen';

type Props = {
  userId: string;
};

/** Peter's chat surface, lifted out of MetricsClient. Reads /coach?tab=chat;
 *  the dashboard tab uses PeterDashboardClient instead. */
export function PeterChatClient({ userId }: Props) {
  useMarkThreadSeen('peter');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 'calc(100dvh - 88px)' }}>
      <ChatPanel userId={userId} embedded={true} initialKind="coach" thread="peter" />
    </div>
  );
}
```

- [ ] **Step 2: Write `/coach` page (server component, SSR-hydrate, sub-tab dispatcher)**

Write to `app/coach/page.tsx`:

```tsx
import { redirect } from 'next/navigation';
import { HydrationBoundary, dehydrate } from '@tanstack/react-query';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { makeServerQueryClient } from '@/lib/query/queryClient';
import { queryKeys } from '@/lib/query/keys';
import { fetchPeterDashboardServer } from '@/lib/query/fetchers/peterDashboard';
import { PeterDashboardClient } from '@/components/coach/PeterDashboardClient';
import { PeterChatClient } from '@/components/coach/PeterChatClient';
import { SubPillNav } from '@/components/layout/SubPillNav';
import { todayInUserTz } from '@/lib/time';
import { COLOR } from '@/lib/ui/theme';

export const dynamic = 'force-dynamic';

const SUB_TABS = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'chat',      label: 'Chat'      },
];

type SP = {
  searchParams?: Promise<{ tab?: string; context?: string }>;
};

export default async function CoachPage({ searchParams }: SP) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const sp = (await searchParams) ?? {};
  const tab = sp.tab === 'chat' ? 'chat' : 'dashboard';
  const today = todayInUserTz();

  const queryClient = makeServerQueryClient();
  if (tab === 'dashboard') {
    await queryClient.prefetchQuery({
      queryKey: queryKeys.peterDashboard.latest(user.id, today),
      queryFn: () => fetchPeterDashboardServer(supabase, user.id, today),
    });
  }

  return (
    <div style={{ background: COLOR.bg, minHeight: '100dvh' }}>
      <SubPillNav tabs={SUB_TABS} active={tab} basePath="/coach" />
      <HydrationBoundary state={dehydrate(queryClient)}>
        {tab === 'dashboard'
          ? <PeterDashboardClient userId={user.id} today={today} />
          : <PeterChatClient userId={user.id} />
        }
      </HydrationBoundary>
    </div>
  );
}
```

- [ ] **Step 3: Verify `SubPillNav` API and `todayInUserTz` import path**

Run:
```bash
grep -n "export" /Users/abdelouahedelbied/Health\ app/components/layout/SubPillNav.tsx
```

Expected: prints the export with its props (tabs, active, basePath). Adjust prop names in the page.tsx if needed.

- [ ] **Step 4: Delete old `/metrics` page and `MetricsClient` (move complete after Task 16)**

Defer the delete until after Task 16 (nav rename) so /metrics keeps working during the transition. For now, leave them.

- [ ] **Step 5: Commit (page + chat client only; PeterDashboardClient comes in Task 15)**

```bash
git add app/coach/page.tsx components/coach/PeterChatClient.tsx
git commit -m "feat(peter): /coach route shell with dashboard/chat sub-tab dispatch"
```

---

## Task 15: Dashboard UI — Hero, Grid, ThemeCard (accordion), RegenButton

**Files:**
- Create: `components/coach/PeterDashboardClient.tsx`
- Create: `components/coach/PeterDashboardHero.tsx`
- Create: `components/coach/PeterDashboardGrid.tsx`
- Create: `components/coach/PeterThemeCard.tsx`
- Create: `components/coach/PeterDashboardRegenButton.tsx`

- [ ] **Step 1: Write client wrapper**

Write to `components/coach/PeterDashboardClient.tsx`:

```tsx
'use client';

import { usePeterDashboard } from '@/lib/query/hooks/usePeterDashboard';
import { PeterDashboardHero } from './PeterDashboardHero';
import { PeterDashboardGrid } from './PeterDashboardGrid';
import { PeterDashboardRegenButton } from './PeterDashboardRegenButton';
import { COLOR } from '@/lib/ui/theme';

type Props = { userId: string; today: string };

export function PeterDashboardClient({ userId, today }: Props) {
  const { data, isLoading, isError } = usePeterDashboard(userId, today);

  if (isLoading) {
    return <div style={{ padding: 24, color: COLOR.text.muted }}>Loading…</div>;
  }
  if (isError) {
    return <div style={{ padding: 24, color: COLOR.text.muted }}>Failed to load.</div>;
  }
  if (!data) {
    return (
      <div style={{ padding: 24, color: COLOR.text.muted }}>
        Peter hasn&apos;t generated today&apos;s read yet — running daily at 04:00 UTC.
        Use the regenerate button below to trigger one now.
        <div style={{ marginTop: 16 }}>
          <PeterDashboardRegenButton />
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: 11, color: COLOR.text.muted }}>
          Last refreshed {new Date(data.payload.generated_at).toLocaleString(undefined, { hour: '2-digit', minute: '2-digit' })}
          {data.payload.narrative_failed ? ' · narrative failed' : ''}
        </div>
        <PeterDashboardRegenButton />
      </div>
      <PeterDashboardHero
        narrative={data.payload.narrative}
        fallbackHeadline={`On track · v${data.version}`}
      />
      <PeterDashboardGrid payload={data.payload} />
    </div>
  );
}
```

- [ ] **Step 2: Write hero**

Write to `components/coach/PeterDashboardHero.tsx`:

```tsx
import type { PeterDashboardNarrative } from '@/lib/data/types';
import { COLOR, RADIUS } from '@/lib/ui/theme';

type Props = {
  narrative: PeterDashboardNarrative | null;
  fallbackHeadline: string;
};

export function PeterDashboardHero({ narrative, fallbackHeadline }: Props) {
  return (
    <div
      style={{
        background: COLOR.surface,
        border: `1px solid ${COLOR.border}`,
        borderRadius: RADIUS.md,
        padding: 16,
      }}
    >
      <div style={{ fontSize: 10, color: COLOR.text.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>
        Peter&apos;s read
      </div>
      <h2 style={{ fontSize: 16, margin: '6px 0', color: COLOR.text.primary, fontWeight: 600 }}>
        {narrative?.hero.headline ?? fallbackHeadline}
      </h2>
      {narrative?.hero.body_md && (
        <p style={{ fontSize: 13, color: COLOR.text.secondary, margin: 0, lineHeight: 1.5 }}>
          {narrative.hero.body_md}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Write grid**

Write to `components/coach/PeterDashboardGrid.tsx`:

```tsx
'use client';
import { useState } from 'react';
import type { PeterDashboardPayload, ThemeKey } from '@/lib/data/types';
import { PeterThemeCard } from './PeterThemeCard';

const ALL: ThemeKey[] = [
  'recomp', 'energy', 'fatigue',
  'performance', 'plan_adherence', 'goal_distance',
];

type Props = { payload: PeterDashboardPayload };

export function PeterDashboardGrid({ payload }: Props) {
  const [expanded, setExpanded] = useState<ThemeKey | null>(null);
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
        gap: 8,
      }}
    >
      {ALL.map((k) => {
        const isOpen = expanded === k;
        return (
          <div key={k} style={{ gridColumn: isOpen ? '1 / -1' : 'auto' }}>
            <PeterThemeCard
              theme={payload.facts.themes[k]}
              narrative={payload.narrative?.cards[k]?.narrative_md ?? null}
              expanded={isOpen}
              onToggle={() => setExpanded(isOpen ? null : k)}
            />
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Write theme card (collapsed + expanded state with sparkline + chips)**

Write to `components/coach/PeterThemeCard.tsx`:

```tsx
'use client';
import Link from 'next/link';
import { LineChart, Line, ResponsiveContainer, ReferenceLine, Tooltip } from 'recharts';
import type { ThemePayload } from '@/lib/data/types';
import { THEME_LABEL, THEME_DRILLDOWN } from '@/lib/coach/peter-dashboard/types';
import { COLOR, RADIUS } from '@/lib/ui/theme';

const SEVERITY_COLOR = {
  ok:     '#22c55e',
  warn:   '#eab308',
  urgent: '#ef4444',
};

type Props = {
  theme: ThemePayload;
  narrative: string | null;
  expanded: boolean;
  onToggle: () => void;
};

export function PeterThemeCard({ theme, narrative, expanded, onToggle }: Props) {
  return (
    <button
      type="button"
      onClick={onToggle}
      style={{
        width: '100%',
        textAlign: 'left',
        background: COLOR.surface,
        border: `1px solid ${COLOR.border}`,
        borderRadius: RADIUS.md,
        padding: expanded ? 14 : 10,
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{
            display: 'inline-block', width: 8, height: 8, borderRadius: 4,
            background: SEVERITY_COLOR[theme.severity],
          }}
        />
        <span style={{ fontSize: 12, fontWeight: 600, color: COLOR.text.primary }}>
          {THEME_LABEL[theme.key]}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 10, color: COLOR.text.muted }}>
          {expanded ? '−' : '+'}
        </span>
      </div>
      <div style={{ fontSize: 11, color: COLOR.text.muted }}>{theme.one_line}</div>

      {expanded && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 4 }}>
          <p style={{ fontSize: 13, color: COLOR.text.primary, margin: 0, lineHeight: 1.5 }}>
            {narrative ?? theme.body_md}
          </p>

          {/* Fact chips */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {Object.entries(theme.facts)
              .filter(([, v]) => v !== null && v !== '')
              .slice(0, 6)
              .map(([k, v]) => (
                <span
                  key={k}
                  style={{
                    fontSize: 10,
                    background: '#1e293b',
                    border: '1px solid #334155',
                    borderRadius: 3,
                    padding: '2px 6px',
                    color: '#cbd5e1',
                  }}
                >
                  {k.replace(/_/g, ' ')}: {String(v)}
                </span>
              ))}
          </div>

          {theme.sparkline && (
            <div style={{ height: 100 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={theme.sparkline.series} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
                  <Line type="monotone" dataKey="y" stroke="#60a5fa" dot={false} strokeWidth={2} />
                  {theme.sparkline.series[0]?.ref != null && (
                    <ReferenceLine y={theme.sparkline.series[0].ref} stroke="#64748b" strokeDasharray="3 3" />
                  )}
                  <Tooltip
                    contentStyle={{ background: '#0a0a0a', border: '1px solid #27272a', borderRadius: 4, fontSize: 11 }}
                    labelStyle={{ color: '#a1a1aa' }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Nav chips */}
          <div style={{ display: 'flex', gap: 6 }} onClick={(e) => e.stopPropagation()}>
            <Link
              href={`/coach?tab=chat&context=${theme.key}`}
              style={chipStyle}
            >
              Ask Peter →
            </Link>
            <Link href={THEME_DRILLDOWN[theme.key]} style={chipStyle}>
              Open {drilldownLabel(THEME_DRILLDOWN[theme.key])} →
            </Link>
          </div>
        </div>
      )}
    </button>
  );
}

const chipStyle: React.CSSProperties = {
  fontSize: 11,
  background: '#1e293b',
  border: '1px solid #334155',
  borderRadius: 4,
  padding: '4px 8px',
  color: '#cbd5e1',
  textDecoration: 'none',
};

function drilldownLabel(path: string): string {
  if (path.startsWith('/diet')) return 'Diet';
  if (path.startsWith('/strength')) return 'Strength';
  if (path.startsWith('/health')) return 'Health';
  if (path.startsWith('/profile')) return 'Profile';
  return 'detail';
}
```

- [ ] **Step 5: Write regenerate button**

Write to `components/coach/PeterDashboardRegenButton.tsx`:

```tsx
'use client';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query/keys';

export function PeterDashboardRegenButton() {
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const qc = useQueryClient();

  async function onClick() {
    setPending(true);
    setErr(null);
    try {
      const res = await fetch('/api/coach/dashboard/regenerate', { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        if (res.status === 429) setErr('Daily regen limit reached — try tomorrow.');
        else setErr(body?.detail ?? body?.error ?? 'Regenerate failed.');
        return;
      }
      await qc.invalidateQueries({ queryKey: ['peterDashboard'] });
    } catch (e) {
      setErr(String(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        style={{
          fontSize: 11,
          padding: '4px 10px',
          background: '#1e293b',
          border: '1px solid #334155',
          borderRadius: 4,
          color: '#cbd5e1',
          cursor: pending ? 'wait' : 'pointer',
        }}
      >
        {pending ? 'Regenerating…' : 'Regenerate'}
      </button>
      {err && <span style={{ fontSize: 10, color: '#ef4444' }}>{err}</span>}
    </div>
  );
}
```

- [ ] **Step 6: Typecheck**

Run:
```bash
npm run typecheck
```

Expected: pass. If `COLOR.text.muted`/`COLOR.surface`/`COLOR.border` names differ from your theme, adjust against [lib/ui/theme.ts](../../../lib/ui/theme.ts).

- [ ] **Step 7: Commit**

```bash
git add components/coach/PeterDashboardClient.tsx components/coach/PeterDashboardHero.tsx components/coach/PeterDashboardGrid.tsx components/coach/PeterThemeCard.tsx components/coach/PeterDashboardRegenButton.tsx
git commit -m "feat(peter): dashboard UI — hero + grid + accordion theme cards + regen"
```

---

## Task 16: Nav rename `/metrics` → `/coach` + delete old files

**Files:**
- Modify: `components/layout/BottomNav.tsx`
- Delete: `app/metrics/page.tsx`
- Delete: `components/metrics/MetricsClient.tsx`
- (Keep `app/metrics/reviews/page.tsx` and `app/metrics/weeks/[week_start]/page.tsx`) — these are deep-links that still work via their own routes.

- [ ] **Step 1: Update BottomNav**

Open `components/layout/BottomNav.tsx`, find the TABS array and change the `/metrics` entry:

```diff
-  { href: "/metrics",  label: "Metrics",  Icon: BarChart3,       match: (p) => p.startsWith("/metrics"),  thread: "peter" },
+  { href: "/coach",    label: "Coach",    Icon: BarChart3,       match: (p) => p.startsWith("/coach") || p.startsWith("/metrics"), thread: "peter" },
```

The `match` keeps `/metrics/*` sub-routes (reviews, weeks/[week_start]) highlighting the same nav tab so deep links don't appear "orphaned" in the nav.

- [ ] **Step 2: Delete `/metrics/page.tsx` and add a redirect shim**

Replace `app/metrics/page.tsx` entirely with:

```tsx
import { redirect } from 'next/navigation';

type SP = { searchParams?: Promise<{ tab?: string; sub?: string; section?: string; date?: string }> };

export default async function MetricsLegacyRedirect({ searchParams }: SP) {
  const sp = (await searchParams) ?? {};
  // Preserve any existing sub/section redirects that the old page handled.
  if (sp.sub === 'strength') redirect('/strength?tab=coach');
  if (sp.sub === 'body') redirect('/diet?tab=coach');
  if (sp.sub === 'log') {
    const dateQs = sp.date ? `&date=${encodeURIComponent(sp.date)}` : '';
    redirect(`/health?tab=log${dateQs}`);
  }
  // Bare /metrics → /coach
  redirect(`/coach${sp.tab ? `?tab=${sp.tab}` : ''}`);
}
```

- [ ] **Step 3: Delete `MetricsClient`**

Run:
```bash
rm components/metrics/MetricsClient.tsx
```

If grep shows other importers, rewrite them to use `PeterDashboardClient` or `PeterChatClient`:

```bash
grep -rn "MetricsClient" "/Users/abdelouahedelbied/Health app" --include='*.ts' --include='*.tsx' 2>/dev/null
```

Expected: no remaining importers. If any remain, fix them then re-run.

- [ ] **Step 4: Typecheck**

Run:
```bash
npm run typecheck
```

Expected: pass.

- [ ] **Step 5: Verify locally**

Run `npm run dev`. Open:
- `/coach` → renders the dashboard (or the "not yet generated" empty state — that's expected pre-cron)
- `/coach?tab=chat` → renders Peter's chat
- `/metrics` → 307 redirect to `/coach`
- BottomNav highlights "Coach" while on `/coach`, `/metrics/reviews/*`, and `/metrics/weeks/*`

- [ ] **Step 6: Commit**

```bash
git add components/layout/BottomNav.tsx app/metrics/page.tsx
git rm components/metrics/MetricsClient.tsx
git commit -m "feat(peter): rename /metrics → /coach in nav, redirect old /metrics URLs"
```

---

## Task 17: Wire "Today's read" into Peter's system prompt

**Files:**
- Modify: `lib/coach/system-prompts.ts`
- Modify: `lib/coach/chat-stream.ts`
- Modify: `lib/coach/planning-prompts.ts`
- Modify: `app/api/chat/messages/route.ts`

- [ ] **Step 1: Add PETER_BASE prose teaching Peter how to use the block**

Open `lib/coach/system-prompts.ts`. Find `PETER_BASE` and add the following lines.

After the opening paragraph (right after the first triple-newline-separated section), insert:

```
You have a "Today's read" block in your context with cross-domain synthesis already done — six themes with severity + narrative + cluster relationships. When the athlete asks a cross-domain question, ground in that block instead of re-running the synthesis. When the athlete asks about a specific theme, cite the card's facts directly.

```

At the end of the existing prompt (before the closing backticks), add a new paragraph:

```

When "Today's read" flags a cluster (multiple themes sharing a root cause), surface the cluster relationship explicitly. Don't answer about one card while ignoring the cluster — the cluster IS the head-coach insight.
```

- [ ] **Step 2: Add `peterDashboardBlock` option to `RunChatStreamOpts` + append in chat-stream**

Open `lib/coach/chat-stream.ts`. Find `RunChatStreamOpts` (around line 170). After the `peterContext?` field, add:

```ts
  /** Pre-built "Today's read" markdown from coach_dashboards.narrative_md.
   *  Appended after the base system prompt for Peter turns only. Null/undefined
   *  means no dashboard row exists yet — falls back to the snapshot context.
   *  Composes alongside peterContext (specialist activity); both blocks coexist. */
  peterDashboardBlock?: string | null;
```

Then find the prompt assembly (around line 260) and add a new conditional append BEFORE the `peterContext` append:

```ts
  let systemText = baseSystemText;
  if (opts.peterDashboardBlock && speaker === "peter") {
    systemText = `${systemText}\n\n${opts.peterDashboardBlock}`;
  }
  if (opts.peterContext) systemText = `${systemText}\n\n${opts.peterContext}`;
```

(The exact existing line `let systemText = baseSystemText;` already exists; only the new `if (opts.peterDashboardBlock...)` block is added.)

- [ ] **Step 3: Thread option through `buildSystemPrompt` — no change needed**

`buildSystemPrompt` returns a string that becomes `opts.systemPrompt`. The dashboard block lives as a separate option (`peterDashboardBlock`), not inside the system prompt string. No change to `buildSystemPrompt`.

- [ ] **Step 4: Load + pass the block in the chat route**

Open `app/api/chat/messages/route.ts`. Find where `peterContext` is built (around line 809) — it should look like:

```ts
const peterContext = speaker === "peter"
  ? await buildPeterContextBlock(sr, user.id).catch((err) => { ... })
  : null;
```

Right next to it, add the dashboard block load:

```ts
const peterDashboardBlock = speaker === "peter"
  ? await loadLatestPeterDashboard(sr, user.id, new Date().toISOString().slice(0, 10))
      .then((row) => row?.narrative_md ?? null)
      .catch((err) => {
        console.warn("[chat] loadLatestPeterDashboard failed", err);
        return null;
      })
  : null;
```

Add the import at the top of the file:

```ts
import { loadLatestPeterDashboard } from "@/lib/coach/peter-dashboard";
```

Then find the `runChatStream` call and add `peterDashboardBlock` to its options:

```ts
runChatStream({
  ...existingOpts,
  peterContext,
  peterDashboardBlock,
})
```

- [ ] **Step 5: Typecheck**

Run:
```bash
npm run typecheck
```

Expected: pass.

- [ ] **Step 6: Verify locally**

Run `npm run dev`. Open `/coach?tab=chat`, send a cross-domain test message like "how's my week going across the board?". Check the server logs for the prompt construction (you can temporarily `console.log(systemText.length)` in chat-stream to verify the new block lands).

- [ ] **Step 7: Commit**

```bash
git add lib/coach/system-prompts.ts lib/coach/chat-stream.ts app/api/chat/messages/route.ts
git commit -m "feat(peter): inject 'Today's read' dashboard block into Peter's chat prompt"
```

---

## Task 18: Audit script

**Files:**
- Create: `scripts/audit-peter-dashboard.mjs`

- [ ] **Step 1: Write audit script**

Write to `scripts/audit-peter-dashboard.mjs`:

```js
// scripts/audit-peter-dashboard.mjs
//
// Dry-run generatePeterDashboard against current data. Reports per-theme
// severity + one_line, cluster detections, and verifies every numeric
// token in narrative_md exists in payload.facts. Roundtrips the
// injection block so the operator can eyeball what Peter actually reads.
//
// Usage:
//   AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs \
//     --experimental-strip-types --env-file=.env.local \
//     scripts/audit-peter-dashboard.mjs

import { createSupabaseServiceRoleClient } from '../lib/supabase/server.ts';
import { generatePeterDashboard } from '../lib/coach/peter-dashboard/index.ts';
import { renderInjectionBlock } from '../lib/coach/peter-dashboard/render-injection.ts';

const userId = process.env.AUDIT_USER_ID;
if (!userId) {
  console.error('AUDIT_USER_ID env var required');
  process.exit(1);
}

const sb = createSupabaseServiceRoleClient();
const today = new Date().toISOString().slice(0, 10);

console.log(`auditing peter dashboard for ${userId} on ${today}\n`);

const payload = await generatePeterDashboard({ supabase: sb, userId, today });

console.log('## themes\n');
for (const [k, t] of Object.entries(payload.facts.themes)) {
  console.log(`  ${k.padEnd(16)} [${t.severity.padEnd(6)}] ${t.one_line}`);
}

console.log('\n## clusters\n');
if (payload.facts.clusters.length === 0) console.log('  (none)');
for (const c of payload.facts.clusters) {
  console.log(`  ${c.id}: ${c.themes.join(' + ')}`);
  console.log(`    root: ${c.root_hypothesis}`);
}

console.log('\n## narrative status\n');
console.log(payload.narrative_failed
  ? '  FAILED — used deterministic fallback'
  : '  ok');

console.log('\n## fabrication check\n');
const allowed = collectAllowed(payload.facts);
const offenders = [];
const texts = [];
if (payload.narrative) {
  texts.push(payload.narrative.hero.headline, payload.narrative.hero.body_md);
  for (const card of Object.values(payload.narrative.cards)) {
    texts.push(card.narrative_md);
  }
}
for (const t of texts) {
  for (const tok of t.matchAll(/-?\d+(?:\.\d+)?/g)) {
    if (!allowed.has(tok[0])) offenders.push(tok[0]);
  }
}
if (offenders.length === 0) console.log('  no fabricated numerics');
else console.log(`  OFFENDERS: ${offenders.slice(0, 10).join(', ')}`);

console.log('\n## prompt block (what Peter sees)\n');
console.log(renderInjectionBlock(payload, today));

function collectAllowed(facts) {
  const out = new Set();
  const push = (v) => {
    if (typeof v === 'number') {
      out.add(String(v));
      out.add(String(Math.round(v)));
      out.add(String(Math.round(v * 10) / 10));
      out.add(String(Math.abs(v)));
      out.add(String(Math.round(Math.abs(v))));
      out.add(String(Math.round(v * 100)));
    }
    if (typeof v === 'string') {
      for (const t of v.split(/[,\s]+/)) {
        const n = Number(t);
        if (Number.isFinite(n)) push(n);
      }
    }
  };
  for (const t of Object.values(facts.themes)) {
    for (const v of Object.values(t.facts)) push(v);
  }
  push(facts.block_context.block_number);
  push(facts.goal_summary.target);
  for (let i = 0; i <= 100; i++) out.add(String(i));
  return out;
}

process.exit(0);
```

- [ ] **Step 2: Run the audit**

Run:
```bash
AUDIT_USER_ID=$(supabase db remote-pg-exec "select user_id from profiles limit 1" 2>/dev/null | tail -2 | head -1 | tr -d ' ') \
  node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-peter-dashboard.mjs
```

(Or set `AUDIT_USER_ID` manually if you know your user id.)

Expected: themes / clusters / narrative-status / fabrication-check / prompt block all print. No "OFFENDERS" line.

If the script blows up on alias resolution, the alias-loader has a known gotcha — use the explicit relative paths in the imports (already used above).

- [ ] **Step 3: Commit**

```bash
git add scripts/audit-peter-dashboard.mjs
git commit -m "feat(peter): audit-peter-dashboard — dry-run + fabrication check + prompt roundtrip"
```

---

## Task 19: CLAUDE.md update

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add entries**

Open `CLAUDE.md`. Find the migrations list (numbered list ending around `30. [supabase/migrations/0030_food_library_dedup.sql]...`) and append:

```markdown
31. [supabase/migrations/0034_peter_dashboard.sql](supabase/migrations/0034_peter_dashboard.sql) — adds `coach_dashboards` (versioned `(user_id, generated_on, version)` cache of the head-coach synthesis payload + rendered `narrative_md`). Read by both the `/coach` dashboard UI and Peter's chat-prompt assembly (single source of truth for "what Peter sees this morning").

32. [supabase/migrations/0035_athlete_goal_structured.sql](supabase/migrations/0035_athlete_goal_structured.sql) — adds structured goal columns to `athlete_profile_documents` (`goal_kind`, `goal_metric`, `goal_target`, `goal_target_date`) for the Goal-distance theme's projection math. Existing free-form goal narrative stays as the "why" text. Backfill is user-driven via `/profile`; until populated, Goal-distance card renders a "Set a structured goal" prompt.
```

Then find the `## Architecture → Coach / AI` section and append a new bullet under it:

```markdown
- **Peter Dashboard (head-coach synthesis)** lives in [lib/coach/peter-dashboard/](lib/coach/peter-dashboard/). Six pure composers (Recomp / Energy / Fatigue / Performance / Plan adherence / Goal distance) cross-correlate over existing intelligence layers (`generateCoachTrends`, `recovery-intelligence`, `nutrition-intelligence`) rather than re-querying. An orchestrator parallel-runs them, detects pairwise cross-theme clusters via [link-themes.ts](lib/coach/peter-dashboard/link-themes.ts), and a single Sonnet 4.6 call wraps the output in Peter's voice with a fabrication check + retry + deterministic fallback. Output persists to `coach_dashboards` (migration 0031, versioned `(user_id, generated_on, version)`). Daily cron at 04:00 UTC ([/api/coach/dashboard/sync](app/api/coach/dashboard/sync/route.ts)) writes v1; manual regen at [/api/coach/dashboard/regenerate](app/api/coach/dashboard/regenerate/route.ts) bumps version (rate-limited 6/day per user). The same row feeds two consumers: the `/coach?tab=dashboard` UI ([components/coach/PeterDashboardClient.tsx](components/coach/PeterDashboardClient.tsx)) AND Peter's chat-prompt assembly ([lib/coach/peter-dashboard/render-injection.ts](lib/coach/peter-dashboard/render-injection.ts) is loaded by [app/api/chat/messages/route.ts](app/api/chat/messages/route.ts) and threaded into `runChatStream` as `peterDashboardBlock`, appended between the snapshot prefix and `peterContext`). PETER_BASE in [lib/coach/system-prompts.ts](lib/coach/system-prompts.ts) teaches Peter how to ground in the block and surface cluster relationships explicitly. `/metrics` was renamed to `/coach` (Peter already lived there; `/metrics/*` sub-routes still resolve via redirects + `BottomNav.match`). Audit: `AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-peter-dashboard.mjs`. Spec: [docs/superpowers/specs/2026-05-24-peter-dashboard-design.md](docs/superpowers/specs/2026-05-24-peter-dashboard-design.md).
```

Also append to the "Scripts" section:

```markdown
- [scripts/audit-peter-dashboard.mjs](scripts/audit-peter-dashboard.mjs) — dry-runs `generatePeterDashboard` against current data, verifies every numeric token in `narrative_md` exists in `payload.facts`, prints per-theme severity + cluster detections, and roundtrips the prompt-injection block so you can eyeball what Peter actually reads. Set `AUDIT_USER_ID`.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(peter): document peter-dashboard architecture + 0031/0032 migrations"
```

---

## Self-Review

### Spec coverage check

Walking the spec sections vs tasks:

- **Architecture (composers + orchestrator + narrative wrap + two consumers)** → Tasks 3–8 (composers), 9 (clusters), 10 (narrative), 11 (orchestrator + injection renderer), 13 (fetcher/hook). ✓
- **Schema (0031 + 0032)** → Task 1. ✓
- **Composers (recomp/energy/fatigue/performance/plan_adherence/goal_distance + linkThemes)** → Tasks 3–9. ✓
- **Narrative wrapping (Sonnet call + validation + retry + fallback)** → Task 10. ✓
- **UI surfaces (/coach + sub-tabs + hero + grid + theme cards + regen)** → Tasks 14, 15. ✓
- **Prompt integration (PETER_BASE updates + chat-stream wiring + load in route)** → Task 17. ✓
- **Cron + endpoints (sync + regenerate + vercel.json)** → Task 12. ✓
- **Audit script** → Task 18. ✓
- **Nav rearrangement + chat relocation (/metrics → /coach)** → Tasks 14 (chat extraction), 16 (nav rename + delete). ✓
- **CLAUDE.md update** → Task 19. ✓
- **Out-of-scope cuts** → Documented in spec; no tasks needed (deferrals). ✓

### Type consistency check

- `ThemePayload`, `ThemeKey`, `ThemeCluster`, `PeterDashboardFacts`, `PeterDashboardPayload`, `Narrative` defined in Task 2 and referenced consistently throughout Tasks 3-15.
- `loadLatestPeterDashboard` signature in Task 11 matches what Task 13 (fetcher) imports.
- `generatePeterDashboard` signature in Task 11 matches what Task 12 (cron + regenerate) and Task 18 (audit) call.
- `THEME_DRILLDOWN` from Task 2 used by ThemeCard (Task 15) for the nav-chip link — composers no longer carry per-theme route, removing drift risk.
- `peterDashboardBlock` field name consistent across Task 17 (chat-stream RunChatStreamOpts, route load + pass).

### Placeholder scan

No "TBD", "TODO", or vague step text. Every code step contains the actual code to write. Every command step has the exact command + expected output framing.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-24-peter-dashboard.md` (will commit next).

**Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Best for this plan because tasks 3–9 (the six composers) are similar-shape and can be reviewed quickly without polluting the main context.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
