# Remi Recovery Intelligence — UI + Compute Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Trends pill on `/health` with 17 recovery-analytics cards across HRV/RHR, sleep, strain×recovery, body signals, subjective signals, and mobility.

**Architecture:** A new compute module `lib/coach/recovery-intelligence/` ships 5 pure composers (daily, weekly, sleep architecture, sleep consistency, subjective — the latter folds in mobility-done as a derived flag) feeding a typed `RecoveryIntelligencePayload` via a single orchestrator. A new fetcher (server + browser variants) and TanStack Query hook serve it through the project's existing SSR-hydrate pattern. `/health` gains a new `Trends` sub-pill between `Coach` and `Log`; section components consume the payload. One small migration (`0031_sleep_start_end.sql`) adds WHOOP sleep onset/offset columns so the bedtime-drift card and trigger have backing data.

**Tech Stack:** Next.js 15 (App Router), Supabase (Postgres + RLS), TypeScript strict, TanStack Query, Recharts. Project has no test suite — verification is `npm run typecheck` + manual exercise on dev server + the audit script in Task 20.

**Spec:** [docs/superpowers/specs/2026-05-24-remi-recovery-intelligence-design.md](../specs/2026-05-24-remi-recovery-intelligence-design.md)

**Visual fidelity reference (mockup):** `.superpowers/brainstorm/43273-1779599842/content/trends-pill-overview.html` (open at the start; gives the exact target look for all 17 cards).

---

## File Structure

**New files:**
```
supabase/migrations/0031_sleep_start_end.sql

lib/coach/recovery-intelligence/
  ├── types.ts                       # RecoveryIntelligencePayload + sub-types
  ├── thresholds.ts                  # All shared numbers (also used by Plan 2)
  ├── compose-daily.ts               # 28d daily series of all recovery columns
  ├── compose-weekly.ts              # 12w weekly aggregates + recovery-tier counts
  ├── compose-sleep-architecture.ts  # 14d deep/REM/light breakdown
  ├── compose-sleep-consistency.ts   # 28d bedtime/wake + 14d bedtime SD
  ├── compose-subjective.ts          # 28d checkins + per-day mobility-done flag (from workouts)
  └── index.ts                       # generateRecoveryIntelligence orchestrator + derived stats

lib/query/fetchers/recoveryIntelligence.ts
lib/query/hooks/useRecoveryIntelligence.ts

components/health/HealthTrendsClient.tsx
components/health/trends/
  ├── HrvAutonomicSection.tsx        # A1 A2 A3
  ├── SleepSection.tsx               # A4 A5 A6 A7
  ├── StrainRecoverySection.tsx      # A8 A9 A10 A11
  ├── BodySignalsSection.tsx         # A12 A13
  ├── SubjectiveSection.tsx          # A14 A15 A16
  └── MobilityCard.tsx               # A17

scripts/audit-recovery-intelligence.mjs
```

**Modified files:**
```
lib/whoop.ts                         # buildWhoopDayRows writes sleep_start_at, sleep_end_at
lib/data/types.ts                    # DailyLog gains sleep_start_at, sleep_end_at
lib/query/keys.ts                    # add recoveryIntelligence key
app/health/page.tsx                  # SUB_TABS gains trends, prefetch trends payload, render HealthTrendsClient
```

---

## Task 1: Migration 0031 + WHOOP sync extension + backfill

**Files:**
- Create: `supabase/migrations/0031_sleep_start_end.sql`
- Modify: `lib/whoop.ts` (find `buildWhoopDayRows`, extend the row shape)
- Modify: `lib/data/types.ts` (extend `DailyLog` type)

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/0031_sleep_start_end.sql
--
-- WHOOP sleep API already returns onset/offset times per sleep record
-- (lib/whoop.ts WhoopSleep.start / .end). Surfacing them on daily_logs
-- so the bedtime-drift trigger and consistency card have backing data.
-- Both columns are nullable: existing rows stay null until backfill runs.

alter table daily_logs
  add column if not exists sleep_start_at timestamptz,
  add column if not exists sleep_end_at   timestamptz;

comment on column daily_logs.sleep_start_at is 'WHOOP-sourced sleep onset timestamp (UTC). Populated by buildWhoopDayRows.';
comment on column daily_logs.sleep_end_at   is 'WHOOP-sourced sleep offset timestamp (UTC). Populated by buildWhoopDayRows.';
```

- [ ] **Step 2: Apply the migration**

Run:
```bash
supabase db push
```
Expected: "Applied migration 0031_sleep_start_end.sql". If it errors with "already applied" run `supabase migration repair --status applied 0031` first.

- [ ] **Step 3: Extend `DailyLog` type**

In `lib/data/types.ts`, find the `DailyLog` type (it's the row shape mirroring `daily_logs`). Add the two columns near the other sleep_* fields:

```ts
  sleep_start_at: string | null;
  sleep_end_at:   string | null;
```

- [ ] **Step 4: Extend `buildWhoopDayRows` in `lib/whoop.ts` to write the columns**

Find the function (search for `buildWhoopDayRows`). It maps WHOOP API records to `daily_logs` row shapes. Locate the line that handles the sleep block (it sets `sleep_hours`, `deep_sleep_hours`, etc.). Add:

```ts
sleep_start_at: sleep?.start ?? null,
sleep_end_at:   sleep?.end   ?? null,
```

where `sleep` is the `WhoopSleep` record already in scope.

- [ ] **Step 5: Typecheck**

Run:
```bash
npm run typecheck
```
Expected: no errors.

- [ ] **Step 6: Backfill historical rows**

```bash
node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/rekey-whoop.mts --since 2024-01-01 --yes
```
Expected: a date-level diff, then "Done" — populates `sleep_start_at` / `sleep_end_at` on every existing row that has WHOOP sleep data.

- [ ] **Step 7: Spot-check**

```bash
node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local -e "
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
const s = createSupabaseServiceRoleClient();
const { data } = await s.from('daily_logs').select('date,sleep_start_at,sleep_end_at').not('sleep_start_at', 'is', null).order('date', { ascending: false }).limit(5);
console.log(data);
"
```
Expected: 5 rows with non-null timestamps in `2026-05-*`. If empty, re-run Step 6.

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations/0031_sleep_start_end.sql lib/whoop.ts lib/data/types.ts
git commit -m "feat(remi): add sleep onset/offset columns for bedtime drift"
```

---

## Task 2: Thresholds module (shared between cards + Plan 2 triggers)

**Files:**
- Create: `lib/coach/recovery-intelligence/thresholds.ts`

- [ ] **Step 1: Write the file**

```ts
// lib/coach/recovery-intelligence/thresholds.ts
//
// Constants shared between the Trends pill cards (UI reference bands +
// inline interpretation) AND the Plan 2 proactive triggers. One module so
// "what the card visualizes" and "what the trigger fires on" never drift.

/** HRV — % off personal 30d baseline. */
export const HRV_NOISE_PCT             = -0.03;  // ±3% day-to-day = noise
export const HRV_SIGNAL_PCT            = -0.05;  // ≥5% sustained 3+ days = signal
export const HRV_CHRONIC_PCT           = -0.07;  // ≥7% sustained 5+ days = action
export const HRV_CHRONIC_MIN_DAYS      = 5;
export const HRV_CHRONIC_OF_LAST_DAYS  = 7;

/** RHR — bpm off personal 30d baseline. */
export const RHR_ELEVATED_BPM          = 5;      // +5 bpm sustained = illness/overreach
export const RHR_ELEVATED_MIN_DAYS     = 5;
export const RHR_ELEVATED_OF_LAST_DAYS = 7;

/** Sleep — debt vs 8h target, score thresholds. */
export const SLEEP_TARGET_HOURS        = 8;
export const SLEEP_DEBT_HOURS          = 5;      // 7d debt threshold
export const SLEEP_DEBT_WINDOW_DAYS    = 7;
export const SLEEP_TARGET_BAND         = [7, 9] as const;
export const SLEEP_SCORE_MEANINGFUL    = 70;
export const SLEEP_SCORE_ACTION        = 60;

/** Sleep architecture — deep sleep deficit. */
export const DEEP_SLEEP_DEFICIT_HOURS    = 1.0;
export const DEEP_SLEEP_DEFICIT_PCT      = 0.12;
export const DEEP_SLEEP_WINDOW_DAYS      = 14;

/** Bedtime consistency. */
export const BEDTIME_DRIFT_SD_MINUTES   = 75;
export const BEDTIME_WINDOW_DAYS        = 14;

/** Recovery distribution + streaks. */
export const RECOVERY_LOW_TIER          = 34;
export const RECOVERY_HIGH_TIER         = 67;
export const LOW_RECOVERY_STREAK_DAYS   = 4;

/** Strain × recovery balance — overreach setup. */
export const STRAIN_HIGH_AVG_7D         = 14;
export const RECOVERY_LOW_AVG_7D        = 40;

/** Skin temp — deviation from personal 28d baseline (°C). */
export const SKIN_TEMP_DELTA_C          = 0.4;
export const SKIN_TEMP_SUSTAINED_DAYS   = 3;
export const SKIN_TEMP_BASELINE_DAYS    = 28;

/** Respiratory rate — deviation from personal 28d baseline (bpm). */
export const RR_DELTA_BPM               = 1;
export const RR_SUSTAINED_DAYS          = 3;
export const RR_BASELINE_DAYS           = 28;

/** Subjective signals. */
export const RECURRING_SORENESS_OCCURRENCES = 5;
export const RECURRING_SORENESS_WINDOW_DAYS = 14;
export const SICKNESS_LINGERING_DAYS    = 4;
export const HEAVY_FATIGUE_DAYS         = 3;
export const HEAVY_FATIGUE_WINDOW_DAYS  = 7;

/** Post-strain undersleep coupling. */
export const POST_STRAIN_THRESHOLD      = 15;    // strain ≥15 = "high"
export const POST_STRAIN_SLEEP_FLOOR_H  = 7;     // next-day sleep <7h
export const POST_STRAIN_OCCURRENCES    = 2;     // 2+ times in 14d
export const POST_STRAIN_WINDOW_DAYS    = 14;
```

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck && \
git add lib/coach/recovery-intelligence/thresholds.ts && \
git commit -m "feat(remi): recovery-intelligence shared thresholds"
```

---

## Task 3: Type definitions (`RecoveryIntelligencePayload`)

**Files:**
- Create: `lib/coach/recovery-intelligence/types.ts`

- [ ] **Step 1: Write the file**

```ts
// lib/coach/recovery-intelligence/types.ts
//
// Typed payload feeding both the Trends pill cards and (later) the
// Plan 2 proactive checks. Adding a field here must update both
// the composer that fills it and any check that reads it.

export type RecoveryDailyPoint = {
  date: string;                   // YYYY-MM-DD
  hrv: number | null;
  resting_hr: number | null;
  recovery: number | null;
  sleep_hours: number | null;
  sleep_score: number | null;
  deep_sleep_hours: number | null;
  rem_sleep_hours: number | null;
  strain: number | null;
  spo2: number | null;
  skin_temp_c: number | null;
  respiratory_rate: number | null;
  sleep_start_at: string | null;  // ISO from migration 0031
  sleep_end_at:   string | null;
};

export type WeeklyAggregate = {
  week_start: string;             // YYYY-MM-DD (Monday)
  hrv_avg:        number | null;
  rhr_avg:        number | null;
  recovery_avg:   number | null;
  strain_avg:     number | null;
  sleep_hours_avg:number | null;
  sleep_score_avg:number | null;
  recovery_low_days:  number;     // count of <34 in week
  recovery_ok_days:   number;     // 34–66
  recovery_high_days: number;     // ≥67
};

export type SleepArchitecturePoint = {
  date: string;
  deep_hours:  number | null;
  rem_hours:   number | null;
  light_hours: number | null;     // derived = total − deep − REM, clamped ≥0
  total_hours: number | null;
};

export type BedtimePoint = {
  date: string;
  bedtime_minutes_after_18: number | null;   // 18:00 = 0 → 06:00 next day = 720
  wake_minutes_after_18:    number | null;
};

export type SorenessSeverity = 'mild' | 'sharp' | null;

export type SubjectivePoint = {
  date: string;
  fatigue: 'none' | 'some' | 'heavy' | null;
  sick: boolean;
  sickness_notes: string | null;
  soreness_areas: string[];        // 0 or more of chest|back|legs|shoulders|arms|core
  soreness_severity: SorenessSeverity;
  mobility_done: boolean;          // derived from `workouts` rows
};

export type RecoveryIntelligencePayload = {
  schema_version: 1;
  window_days_daily: 28;
  window_weeks_long: 12;
  daily: RecoveryDailyPoint[];                  // last 28d, oldest first
  weekly: WeeklyAggregate[];                    // last 12w
  sleep_architecture: SleepArchitecturePoint[]; // last 14d
  bedtime: BedtimePoint[];                      // last 28d
  subjective: SubjectivePoint[];                // last 28d
  baselines: {
    hrv_mean: number | null;
    hrv_sd: number | null;
    resting_hr_mean: number | null;
    skin_temp_baseline_c: number | null;        // computed personal 28d
    respiratory_rate_baseline_bpm: number | null; // computed personal 28d
  };
  derived: {
    hrv_avg_7d: number | null;
    hrv_vs_baseline_pct_7d: number | null;
    rhr_avg_7d: number | null;
    rhr_vs_baseline_bpm_7d: number | null;
    sleep_debt_7d_hours: number | null;
    bedtime_mean_minutes: number | null;
    bedtime_sd_minutes: number | null;
    mobility_current_streak_days: number;
    mobility_completion_pct_28d: number;
    recovery_avg_7d: number | null;
    strain_avg_7d: number | null;
  };
};
```

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck && \
git add lib/coach/recovery-intelligence/types.ts && \
git commit -m "feat(remi): RecoveryIntelligencePayload types"
```

---

## Task 4: Composer — daily 28d series

**Files:**
- Create: `lib/coach/recovery-intelligence/compose-daily.ts`

- [ ] **Step 1: Write the composer**

```ts
// lib/coach/recovery-intelligence/compose-daily.ts
//
// Pure-ish: takes a Supabase client + userId + today, returns the 28d
// daily series in chronological order (oldest first). Missing-row dates
// are returned as fully-null points so charts can keep a continuous x-axis.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { RecoveryDailyPoint } from "./types";

const DAILY_WINDOW_DAYS = 28;

const SELECT_COLS =
  "date,hrv,resting_hr,recovery,sleep_hours,sleep_score,deep_sleep_hours,rem_sleep_hours,strain,spo2,skin_temp_c,respiratory_rate,sleep_start_at,sleep_end_at";

export async function composeDaily(args: {
  supabase: SupabaseClient;
  userId: string;
  today: string;     // YYYY-MM-DD in user TZ
}): Promise<RecoveryDailyPoint[]> {
  const { supabase, userId, today } = args;

  // Compute window bounds inclusive of `today` going back 27 days = 28 total.
  const end = new Date(`${today}T00:00:00Z`);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (DAILY_WINDOW_DAYS - 1));
  const startIso = start.toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from("daily_logs")
    .select(SELECT_COLS)
    .eq("user_id", userId)
    .gte("date", startIso)
    .lte("date", today)
    .order("date", { ascending: true });

  if (error) throw error;

  const byDate = new Map<string, RecoveryDailyPoint>();
  for (const row of (data ?? []) as RecoveryDailyPoint[]) {
    byDate.set(row.date, row);
  }

  // Densify: emit one row per date in the window, filling gaps with nulls.
  const out: RecoveryDailyPoint[] = [];
  for (let i = 0; i < DAILY_WINDOW_DAYS; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    const iso = d.toISOString().slice(0, 10);
    out.push(
      byDate.get(iso) ?? {
        date: iso,
        hrv: null, resting_hr: null, recovery: null,
        sleep_hours: null, sleep_score: null,
        deep_sleep_hours: null, rem_sleep_hours: null,
        strain: null, spo2: null, skin_temp_c: null,
        respiratory_rate: null,
        sleep_start_at: null, sleep_end_at: null,
      },
    );
  }
  return out;
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck && \
git add lib/coach/recovery-intelligence/compose-daily.ts && \
git commit -m "feat(remi): compose-daily — 28d densified series"
```

---

## Task 5: Composer — weekly 12w aggregates

**Files:**
- Create: `lib/coach/recovery-intelligence/compose-weekly.ts`

- [ ] **Step 1: Write the composer**

```ts
// lib/coach/recovery-intelligence/compose-weekly.ts
//
// Returns 12 weekly buckets (Mon→Sun) covering today + the 11 prior weeks.
// Aggregates: avg of HRV/RHR/recovery/strain/sleep_h/sleep_score, plus
// recovery-tier counts (low/ok/high) for the stacked-bar viz (A8).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { WeeklyAggregate } from "./types";
import { RECOVERY_LOW_TIER, RECOVERY_HIGH_TIER } from "./thresholds";

const WEEKLY_WINDOW_WEEKS = 12;
const SELECT_COLS = "date,hrv,resting_hr,recovery,strain,sleep_hours,sleep_score";

function mondayOf(d: Date): Date {
  // JS: 0=Sun, 1=Mon, …, 6=Sat. Snap back to Monday.
  const day = d.getUTCDay();
  const diff = (day + 6) % 7; // Sun→6, Mon→0, Tue→1, …
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() - diff);
  out.setUTCHours(0, 0, 0, 0);
  return out;
}

function avg(xs: Array<number | null>): number | null {
  const v = xs.filter((x): x is number => x != null);
  if (v.length === 0) return null;
  return v.reduce((a, b) => a + b, 0) / v.length;
}

export async function composeWeekly(args: {
  supabase: SupabaseClient;
  userId: string;
  today: string;
}): Promise<WeeklyAggregate[]> {
  const { supabase, userId, today } = args;

  const todayD = new Date(`${today}T00:00:00Z`);
  const thisWeekStart = mondayOf(todayD);
  const oldestWeekStart = new Date(thisWeekStart);
  oldestWeekStart.setUTCDate(oldestWeekStart.getUTCDate() - 7 * (WEEKLY_WINDOW_WEEKS - 1));
  const startIso = oldestWeekStart.toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from("daily_logs")
    .select(SELECT_COLS)
    .eq("user_id", userId)
    .gte("date", startIso)
    .lte("date", today)
    .order("date", { ascending: true });

  if (error) throw error;

  const byWeek = new Map<string, typeof data>();
  for (const row of data ?? []) {
    const wkStart = mondayOf(new Date(`${row.date}T00:00:00Z`)).toISOString().slice(0, 10);
    if (!byWeek.has(wkStart)) byWeek.set(wkStart, []);
    byWeek.get(wkStart)!.push(row);
  }

  const out: WeeklyAggregate[] = [];
  for (let i = 0; i < WEEKLY_WINDOW_WEEKS; i++) {
    const wkStart = new Date(oldestWeekStart);
    wkStart.setUTCDate(wkStart.getUTCDate() + 7 * i);
    const iso = wkStart.toISOString().slice(0, 10);
    const rows = byWeek.get(iso) ?? [];
    out.push({
      week_start: iso,
      hrv_avg:         avg(rows.map((r) => r.hrv)),
      rhr_avg:         avg(rows.map((r) => r.resting_hr)),
      recovery_avg:    avg(rows.map((r) => r.recovery)),
      strain_avg:      avg(rows.map((r) => r.strain)),
      sleep_hours_avg: avg(rows.map((r) => r.sleep_hours)),
      sleep_score_avg: avg(rows.map((r) => r.sleep_score)),
      recovery_low_days:  rows.filter((r) => r.recovery != null && r.recovery <  RECOVERY_LOW_TIER ).length,
      recovery_ok_days:   rows.filter((r) => r.recovery != null && r.recovery >= RECOVERY_LOW_TIER && r.recovery < RECOVERY_HIGH_TIER).length,
      recovery_high_days: rows.filter((r) => r.recovery != null && r.recovery >= RECOVERY_HIGH_TIER).length,
    });
  }
  return out;
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck && \
git add lib/coach/recovery-intelligence/compose-weekly.ts && \
git commit -m "feat(remi): compose-weekly — 12w aggregates + tier counts"
```

---

## Task 6: Composer — sleep architecture (14d)

**Files:**
- Create: `lib/coach/recovery-intelligence/compose-sleep-architecture.ts`

- [ ] **Step 1: Write the composer**

```ts
// lib/coach/recovery-intelligence/compose-sleep-architecture.ts
//
// 14 daily points (oldest first) with deep / REM / light breakdown.
// "light" is derived: max(0, total_sleep − deep − REM). Total < deep+REM
// (rare WHOOP artifact) clamps to 0 to keep the stacked-bar viz coherent.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { SleepArchitecturePoint } from "./types";

const WINDOW_DAYS = 14;
const SELECT_COLS = "date,sleep_hours,deep_sleep_hours,rem_sleep_hours";

export async function composeSleepArchitecture(args: {
  supabase: SupabaseClient;
  userId: string;
  today: string;
}): Promise<SleepArchitecturePoint[]> {
  const { supabase, userId, today } = args;

  const end = new Date(`${today}T00:00:00Z`);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (WINDOW_DAYS - 1));
  const startIso = start.toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from("daily_logs")
    .select(SELECT_COLS)
    .eq("user_id", userId)
    .gte("date", startIso)
    .lte("date", today)
    .order("date", { ascending: true });

  if (error) throw error;

  type Row = { date: string; sleep_hours: number | null; deep_sleep_hours: number | null; rem_sleep_hours: number | null };
  const byDate = new Map<string, Row>();
  for (const r of (data ?? []) as Row[]) byDate.set(r.date, r);

  const out: SleepArchitecturePoint[] = [];
  for (let i = 0; i < WINDOW_DAYS; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    const iso = d.toISOString().slice(0, 10);
    const row = byDate.get(iso);
    const total = row?.sleep_hours ?? null;
    const deep  = row?.deep_sleep_hours ?? null;
    const rem   = row?.rem_sleep_hours ?? null;
    const light =
      total != null && deep != null && rem != null
        ? Math.max(0, total - deep - rem)
        : null;
    out.push({ date: iso, deep_hours: deep, rem_hours: rem, light_hours: light, total_hours: total });
  }
  return out;
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck && \
git add lib/coach/recovery-intelligence/compose-sleep-architecture.ts && \
git commit -m "feat(remi): compose-sleep-architecture — 14d deep/REM/light"
```

---

## Task 7: Composer — sleep consistency (bedtime/wake)

**Files:**
- Create: `lib/coach/recovery-intelligence/compose-sleep-consistency.ts`

- [ ] **Step 1: Write the composer**

```ts
// lib/coach/recovery-intelligence/compose-sleep-consistency.ts
//
// 28 daily bedtime + wake points expressed as "minutes after 18:00 local",
// so a bedtime of 23:30 → 330, 01:00 → 420, 02:30 → 510. Wakes around 07:00
// → 780. Anchoring at 18:00 keeps athletes who go to bed before midnight
// and after midnight on a continuous y-axis (no wrap).
//
// Also computes the bedtime SD over the last 14 days for the
// bedtime-drift trigger and the card subtitle.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { BedtimePoint } from "./types";
import { BEDTIME_WINDOW_DAYS } from "./thresholds";

const WINDOW_DAYS = 28;
const SELECT_COLS = "date,sleep_start_at,sleep_end_at";

function minutesAfter18(iso: string | null): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  // Local TZ: Supabase returns timestamptz; toLocale parses into runtime TZ.
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  const minutes = local.getUTCHours() * 60 + local.getUTCMinutes();
  // Anchor 18:00 = 0. Wraps from previous day handled below.
  let m = minutes - 18 * 60;
  if (m < 0) m += 24 * 60; // 06:00 → 720 (= morning of "today")
  return m;
}

export type SleepConsistencyOut = {
  series: BedtimePoint[];
  bedtime_mean_minutes: number | null;
  bedtime_sd_minutes: number | null;
};

export async function composeSleepConsistency(args: {
  supabase: SupabaseClient;
  userId: string;
  today: string;
}): Promise<SleepConsistencyOut> {
  const { supabase, userId, today } = args;

  const end = new Date(`${today}T00:00:00Z`);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (WINDOW_DAYS - 1));
  const startIso = start.toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from("daily_logs")
    .select(SELECT_COLS)
    .eq("user_id", userId)
    .gte("date", startIso)
    .lte("date", today)
    .order("date", { ascending: true });

  if (error) throw error;

  type Row = { date: string; sleep_start_at: string | null; sleep_end_at: string | null };
  const byDate = new Map<string, Row>();
  for (const r of (data ?? []) as Row[]) byDate.set(r.date, r);

  const series: BedtimePoint[] = [];
  for (let i = 0; i < WINDOW_DAYS; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    const iso = d.toISOString().slice(0, 10);
    const row = byDate.get(iso);
    series.push({
      date: iso,
      bedtime_minutes_after_18: minutesAfter18(row?.sleep_start_at ?? null),
      wake_minutes_after_18:    minutesAfter18(row?.sleep_end_at   ?? null),
    });
  }

  // Last 14d bedtime stats.
  const last14 = series.slice(-BEDTIME_WINDOW_DAYS)
    .map((p) => p.bedtime_minutes_after_18)
    .filter((m): m is number => m != null);

  let mean: number | null = null;
  let sd: number | null = null;
  if (last14.length >= 5) {
    mean = last14.reduce((a, b) => a + b, 0) / last14.length;
    const variance = last14.reduce((acc, x) => acc + (x - mean!) ** 2, 0) / last14.length;
    sd = Math.sqrt(variance);
  }
  return { series, bedtime_mean_minutes: mean, bedtime_sd_minutes: sd };
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck && \
git add lib/coach/recovery-intelligence/compose-sleep-consistency.ts && \
git commit -m "feat(remi): compose-sleep-consistency — bedtime SD over 14d"
```

---

## Task 8: Composer — subjective signals (from checkins)

**Files:**
- Create: `lib/coach/recovery-intelligence/compose-subjective.ts`

- [ ] **Step 1: Write the composer**

```ts
// lib/coach/recovery-intelligence/compose-subjective.ts
//
// 28d series of morning-intake feel data + a derived mobility_done flag
// computed by checking whether `workouts` has a 'Mobility'-type row sourced
// from chat (external_id starts 'chat-mobility-') for that date.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { SubjectivePoint, SorenessSeverity } from "./types";

const WINDOW_DAYS = 28;

export async function composeSubjective(args: {
  supabase: SupabaseClient;
  userId: string;
  today: string;
}): Promise<SubjectivePoint[]> {
  const { supabase, userId, today } = args;

  const end = new Date(`${today}T00:00:00Z`);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (WINDOW_DAYS - 1));
  const startIso = start.toISOString().slice(0, 10);

  // checkins is keyed on date too.
  const checkinsP = supabase
    .from("checkins")
    .select("date,fatigue,sick,sickness_notes,soreness_areas,soreness_severity")
    .eq("user_id", userId)
    .gte("date", startIso)
    .lte("date", today);

  // Mobility presence: 'Mobility' type, chat source. external_id pattern
  // 'chat-mobility-YYYY-MM-DD' is the durable signal (see lib/coach/tools.ts:executeMarkMobilityDone).
  const mobilityP = supabase
    .from("workouts")
    .select("date")
    .eq("user_id", userId)
    .eq("type", "Mobility")
    .like("external_id", "chat-mobility-%")
    .gte("date", startIso)
    .lte("date", today);

  const [checkins, mobility] = await Promise.all([checkinsP, mobilityP]);
  if (checkins.error) throw checkins.error;
  if (mobility.error) throw mobility.error;

  type CheckinRow = { date: string; fatigue: 'none' | 'some' | 'heavy' | null; sick: boolean | null; sickness_notes: string | null; soreness_areas: string[] | null; soreness_severity: SorenessSeverity };
  const byDate = new Map<string, CheckinRow>();
  for (const r of (checkins.data ?? []) as CheckinRow[]) byDate.set(r.date, r);

  const mobilitySet = new Set<string>((mobility.data ?? []).map((r) => r.date));

  const out: SubjectivePoint[] = [];
  for (let i = 0; i < WINDOW_DAYS; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    const iso = d.toISOString().slice(0, 10);
    const c = byDate.get(iso);
    out.push({
      date: iso,
      fatigue: c?.fatigue ?? null,
      sick: !!c?.sick,
      sickness_notes: c?.sickness_notes ?? null,
      soreness_areas: c?.soreness_areas ?? [],
      soreness_severity: c?.soreness_severity ?? null,
      mobility_done: mobilitySet.has(iso),
    });
  }
  return out;
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck && \
git add lib/coach/recovery-intelligence/compose-subjective.ts && \
git commit -m "feat(remi): compose-subjective — checkins + mobility flag"
```

---

## Task 9: Orchestrator + derived stats

**Files:**
- Create: `lib/coach/recovery-intelligence/index.ts`

- [ ] **Step 1: Write the orchestrator**

```ts
// lib/coach/recovery-intelligence/index.ts
//
// Single entry point: composes all sub-payloads in parallel, computes
// derived/rolling stats, and returns the typed RecoveryIntelligencePayload.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { RecoveryIntelligencePayload, RecoveryDailyPoint, SubjectivePoint } from "./types";
import { composeDaily } from "./compose-daily";
import { composeWeekly } from "./compose-weekly";
import { composeSleepArchitecture } from "./compose-sleep-architecture";
import { composeSleepConsistency } from "./compose-sleep-consistency";
import { composeSubjective } from "./compose-subjective";
import { SLEEP_TARGET_HOURS, SLEEP_DEBT_WINDOW_DAYS } from "./thresholds";

function avg(xs: Array<number | null | undefined>): number | null {
  const v = xs.filter((x): x is number => x != null);
  if (v.length === 0) return null;
  return v.reduce((a, b) => a + b, 0) / v.length;
}

function mobilityStreak(subjective: SubjectivePoint[]): number {
  let streak = 0;
  for (let i = subjective.length - 1; i >= 0; i--) {
    if (subjective[i].mobility_done) streak++;
    else break;
  }
  return streak;
}

function lastN<T>(arr: T[], n: number): T[] {
  return arr.slice(-n);
}

export async function generateRecoveryIntelligence(args: {
  supabase: SupabaseClient;
  userId: string;
  today: string;
}): Promise<RecoveryIntelligencePayload> {
  const { supabase, userId, today } = args;

  const [daily, weekly, arch, cons, subjective, profileRes] = await Promise.all([
    composeDaily({ supabase, userId, today }),
    composeWeekly({ supabase, userId, today }),
    composeSleepArchitecture({ supabase, userId, today }),
    composeSleepConsistency({ supabase, userId, today }),
    composeSubjective({ supabase, userId, today }),
    supabase.from("profiles").select("whoop_baselines").eq("user_id", userId).maybeSingle(),
  ]);

  type Baselines = { hrv_mean?: number; hrv_sd?: number; resting_hr_mean?: number };
  const b = (profileRes.data?.whoop_baselines as Baselines | null) ?? {};
  const hrv_mean = b.hrv_mean ?? null;
  const hrv_sd = b.hrv_sd ?? null;
  const rhr_mean = b.resting_hr_mean ?? null;

  // Personal 28d baselines for skin temp + respiratory rate.
  const skin_temp_baseline_c =
    avg(daily.map((d) => d.skin_temp_c));
  const respiratory_rate_baseline_bpm =
    avg(daily.map((d) => d.respiratory_rate));

  // Derived rolling stats.
  const last7 = lastN(daily, 7);
  const hrv_avg_7d = avg(last7.map((d) => d.hrv));
  const rhr_avg_7d = avg(last7.map((d) => d.resting_hr));
  const recovery_avg_7d = avg(last7.map((d) => d.recovery));
  const strain_avg_7d = avg(last7.map((d) => d.strain));

  const sleep_debt_7d_hours =
    lastN(daily, SLEEP_DEBT_WINDOW_DAYS).reduce<number | null>((acc, d) => {
      if (d.sleep_hours == null) return acc;
      const debt = Math.max(0, SLEEP_TARGET_HOURS - d.sleep_hours);
      return (acc ?? 0) + debt;
    }, null);

  const mobility_28d_done = subjective.filter((s) => s.mobility_done).length;

  return {
    schema_version: 1,
    window_days_daily: 28,
    window_weeks_long: 12,
    daily,
    weekly,
    sleep_architecture: arch,
    bedtime: cons.series,
    subjective,
    baselines: {
      hrv_mean,
      hrv_sd,
      resting_hr_mean: rhr_mean,
      skin_temp_baseline_c,
      respiratory_rate_baseline_bpm,
    },
    derived: {
      hrv_avg_7d,
      hrv_vs_baseline_pct_7d: hrv_avg_7d != null && hrv_mean != null && hrv_mean > 0
        ? (hrv_avg_7d - hrv_mean) / hrv_mean
        : null,
      rhr_avg_7d,
      rhr_vs_baseline_bpm_7d: rhr_avg_7d != null && rhr_mean != null
        ? rhr_avg_7d - rhr_mean
        : null,
      sleep_debt_7d_hours,
      bedtime_mean_minutes: cons.bedtime_mean_minutes,
      bedtime_sd_minutes: cons.bedtime_sd_minutes,
      mobility_current_streak_days: mobilityStreak(subjective),
      mobility_completion_pct_28d: mobility_28d_done / 28,
      recovery_avg_7d,
      strain_avg_7d,
    },
  };
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck && \
git add lib/coach/recovery-intelligence/index.ts && \
git commit -m "feat(remi): orchestrator + derived rolling stats"
```

---

## Task 10: Fetcher + hook + query key

**Files:**
- Create: `lib/query/fetchers/recoveryIntelligence.ts`
- Create: `lib/query/hooks/useRecoveryIntelligence.ts`
- Modify: `lib/query/keys.ts`

- [ ] **Step 1: Write the fetcher (server variant only — browser throws)**

This mirrors `lib/query/fetchers/coachTrends.ts`, which is SSR-hydrate only because the composer must read from `profiles` and other tables that get RLS-blocked or are bigger than a single client should pull. Browser hook reads from cache.

```ts
// lib/query/fetchers/recoveryIntelligence.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  generateRecoveryIntelligence,
} from "@/lib/coach/recovery-intelligence";
import type { RecoveryIntelligencePayload } from "@/lib/coach/recovery-intelligence/types";

export async function fetchRecoveryIntelligenceServer(
  supabase: SupabaseClient,
  userId: string,
  today: string,
): Promise<RecoveryIntelligencePayload> {
  return generateRecoveryIntelligence({ supabase, userId, today });
}

export async function fetchRecoveryIntelligenceBrowser(): Promise<RecoveryIntelligencePayload> {
  throw new Error(
    "recoveryIntelligence browser fetcher: not implemented — use SSR hydrate only.",
  );
}
```

- [ ] **Step 2: Extend `lib/query/keys.ts`**

Find the `coachTrends` block and add a sibling:

```ts
  recoveryIntelligence: {
    all: (userId: string) => ["recoveryIntelligence", userId] as const,
    one: (userId: string) => ["recoveryIntelligence", userId, "current"] as const,
  },
```

- [ ] **Step 3: Write the hook**

```ts
// lib/query/hooks/useRecoveryIntelligence.ts
"use client";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchRecoveryIntelligenceBrowser } from "@/lib/query/fetchers/recoveryIntelligence";

export function useRecoveryIntelligence(userId: string) {
  return useQuery({
    queryKey: queryKeys.recoveryIntelligence.one(userId),
    queryFn: fetchRecoveryIntelligenceBrowser,
    enabled: !!userId,
  });
}
```

- [ ] **Step 4: Typecheck + commit**

```bash
npm run typecheck && \
git add lib/query/fetchers/recoveryIntelligence.ts lib/query/hooks/useRecoveryIntelligence.ts lib/query/keys.ts && \
git commit -m "feat(remi): recoveryIntelligence fetcher + hook + query key"
```

---

## Task 11: Wire `/health` page — add Trends sub-pill + prefetch

**Files:**
- Modify: `app/health/page.tsx`

- [ ] **Step 1: Extend `SUB_TABS`**

In `app/health/page.tsx`, replace the existing `SUB_TABS` array with:

```ts
const SUB_TABS = [
  { key: "coach",  label: "Coach"  },
  { key: "trends", label: "Trends" },
  { key: "log",    label: "Log"    },
];
```

- [ ] **Step 2: Normalize the `tab` param**

Find the line `const tab = tabParam === "log" ? "log" : "coach";` and replace with:

```ts
const tab =
  tabParam === "log"    ? "log"    :
  tabParam === "trends" ? "trends" : "coach";
```

- [ ] **Step 3: Prefetch the trends payload + use service role**

`/health` currently uses the cookie-bound `createSupabaseServerClient`. The recovery-intelligence orchestrator reads from `profiles` (for `whoop_baselines`) and `workouts` (for mobility), both RLS-safe for the user's own rows, so the cookie client works fine — no service role needed.

In the `Promise.all([...])` block, add another `prefetchQuery` call:

```ts
queryClient.prefetchQuery({
  queryKey: queryKeys.recoveryIntelligence.one(user.id),
  queryFn: () =>
    fetchRecoveryIntelligenceServer(supabase, user.id, today),
}),
```

Add the import at the top:

```ts
import { fetchRecoveryIntelligenceServer } from "@/lib/query/fetchers/recoveryIntelligence";
```

- [ ] **Step 4: Render `HealthTrendsClient` when `tab === "trends"`**

Replace the existing ternary at the bottom with a 3-way branch:

```tsx
{tab === "coach"  && <HealthCoachClient userId={user.id} hrvBaseline={hrvBaseline} />}
{tab === "trends" && <HealthTrendsClient userId={user.id} />}
{tab === "log"    && <HealthLogClient userId={user.id} initialDate={dateParam} />}
```

Add the import:
```ts
import { HealthTrendsClient } from "@/components/health/HealthTrendsClient";
```

- [ ] **Step 5: Typecheck + manual smoke**

```bash
npm run typecheck
```

Then start dev:
```bash
npm run dev
```

Navigate to `http://localhost:3000/health?tab=trends`. Expected: page renders with the new pill highlighted but no card content yet — `HealthTrendsClient` doesn't exist. **Don't commit yet** — the page is broken until Task 12.

- [ ] **Step 6: Stop dev server**

`Ctrl+C` the dev process.

---

## Task 12: `HealthTrendsClient` shell + section wiring

**Files:**
- Create: `components/health/HealthTrendsClient.tsx`

- [ ] **Step 1: Write the shell**

```tsx
// components/health/HealthTrendsClient.tsx
"use client";
import { useRecoveryIntelligence } from "@/lib/query/hooks/useRecoveryIntelligence";
import { useMarkThreadSeen } from "@/lib/chat/use-mark-thread-seen";
import { HrvAutonomicSection } from "@/components/health/trends/HrvAutonomicSection";
import { SleepSection } from "@/components/health/trends/SleepSection";
import { StrainRecoverySection } from "@/components/health/trends/StrainRecoverySection";
import { BodySignalsSection } from "@/components/health/trends/BodySignalsSection";
import { SubjectiveSection } from "@/components/health/trends/SubjectiveSection";
import { MobilityCard } from "@/components/health/trends/MobilityCard";
import { COLOR } from "@/lib/ui/theme";

type Props = { userId: string };

export function HealthTrendsClient({ userId }: Props) {
  useMarkThreadSeen("remi");
  const { data, isLoading, isError, error } = useRecoveryIntelligence(userId);

  if (isLoading || !data) {
    return (
      <div style={{ padding: 24, color: COLOR.textMid, fontSize: 13 }}>
        Loading recovery trends…
      </div>
    );
  }
  if (isError) {
    return (
      <div style={{ padding: 24, color: COLOR.danger, fontSize: 13 }}>
        Couldn’t load recovery trends: {(error as Error).message}
      </div>
    );
  }

  return (
    <div style={{ paddingBottom: 100 }}>
      <HrvAutonomicSection payload={data} />
      <SleepSection         payload={data} />
      <StrainRecoverySection payload={data} />
      <BodySignalsSection   payload={data} />
      <SubjectiveSection    payload={data} />
      <MobilityCard         payload={data} />
    </div>
  );
}
```

- [ ] **Step 2: Typecheck (compiles will fail until the section files exist — keep going)**

The next 6 tasks create the section components. After Task 18 the typecheck will be green.

- [ ] **Step 3: Don't commit yet — wait until all sections exist (Task 18).**

---

## Task 13: HrvAutonomicSection (A1 A2 A3)

**Files:**
- Create: `components/health/trends/HrvAutonomicSection.tsx`

**Visual fidelity reference:** `.superpowers/brainstorm/43273-1779599842/content/trends-pill-overview.html` — Cluster 1 section. Port the SVG shapes directly. Color tokens:
- baseline reference: `COLOR.accent` (purple, 50% opacity)
- primary line: `COLOR.info` (cyan) — but `COLOR` may not have `info`; use `"#7dd3fc"` literal if needed and add a comment for the engineer to migrate if a token gets added later
- alert line: `COLOR.danger`
- bars in 12w view: `COLOR.info`, switch to `COLOR.warning` for trending-down recent weeks (last 3 if `hrv_avg` of that week is below `baseline * 0.97`)

- [ ] **Step 1: Write the section**

```tsx
// components/health/trends/HrvAutonomicSection.tsx
"use client";
import type { RecoveryIntelligencePayload } from "@/lib/coach/recovery-intelligence/types";
import { COLOR } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";

type Props = { payload: RecoveryIntelligencePayload };

export function HrvAutonomicSection({ payload }: Props) {
  const { daily, weekly, baselines, derived } = payload;

  return (
    <section style={{ padding: 16 }}>
      <h3 style={sectionTitle}>HRV &amp; autonomic state</h3>

      {/* A1: HRV vs baseline · 28d daily */}
      <HrvVsBaselineCard
        daily={daily.map((d) => ({ date: d.date, hrv: d.hrv }))}
        baseline={baselines.hrv_mean}
        hrvSd={baselines.hrv_sd}
        avg7d={derived.hrv_avg_7d}
        vsBaselinePct={derived.hrv_vs_baseline_pct_7d}
      />

      {/* A2: RHR vs baseline · 28d daily */}
      <RhrVsBaselineCard
        daily={daily.map((d) => ({ date: d.date, rhr: d.resting_hr }))}
        baseline={baselines.resting_hr_mean}
        avg7d={derived.rhr_avg_7d}
        deltaBpm={derived.rhr_vs_baseline_bpm_7d}
      />

      {/* A3: HRV weekly avg · 12w */}
      <HrvWeeklyCard weekly={weekly} baseline={baselines.hrv_mean} />
    </section>
  );
}

const sectionTitle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: 0.6,
  color: COLOR.textMuted,
  margin: "0 0 10px 0",
};

// — Card implementations: each renders the equivalent SVG from the mockup. —

function HrvVsBaselineCard({
  daily, baseline, hrvSd, avg7d, vsBaselinePct,
}: {
  daily: Array<{ date: string; hrv: number | null }>;
  baseline: number | null;
  hrvSd: number | null;
  avg7d: number | null;
  vsBaselinePct: number | null;
}) {
  // Trend-line polyline. Map y so baseline is centered, ±SD is a band.
  // Use a simple linear scale: take min/max from daily HRV with a 10% pad.
  const hrvs = daily.map((d) => d.hrv).filter((h): h is number => h != null);
  const yMin = (Math.min(...hrvs, baseline ?? 0)) * 0.9;
  const yMax = (Math.max(...hrvs, baseline ?? 0)) * 1.1;
  const yScale = (v: number) => 80 - ((v - yMin) / (yMax - yMin)) * 80;

  const points = daily
    .map((d, i) => (d.hrv == null ? null : `${(i / (daily.length - 1)) * 360},${yScale(d.hrv)}`))
    .filter(Boolean)
    .join(" ");

  const pctRounded = vsBaselinePct == null ? null : Math.round(vsBaselinePct * 100);
  const valueClass: "good" | "warn" | "bad" =
    pctRounded == null ? "warn" : pctRounded < -7 ? "bad" : pctRounded < -3 ? "warn" : "good";

  return (
    <Card>
      <CardHeader
        title="HRV vs baseline · 28d"
        sub={baseline != null && avg7d != null
          ? `7d avg: ${fmtNum(avg7d)} ms · baseline: ${fmtNum(baseline)} ms`
          : "Insufficient data"}
        value={pctRounded != null ? `${pctRounded > 0 ? "+" : ""}${pctRounded}%` : "—"}
        tone={valueClass}
      />
      <svg viewBox="0 0 360 80" preserveAspectRatio="none" style={{ width: "100%" }}>
        {baseline != null && hrvSd != null && (
          <rect
            x="0" y={yScale(baseline + hrvSd)} width="360"
            height={yScale(baseline - hrvSd) - yScale(baseline + hrvSd)}
            fill={COLOR.accent} fillOpacity={0.08}
          />
        )}
        {baseline != null && (
          <line x1="0" y1={yScale(baseline)} x2="360" y2={yScale(baseline)}
            stroke={COLOR.accent} strokeWidth={1} strokeDasharray="3,3" opacity={0.5} />
        )}
        <polyline points={points} fill="none" stroke="#7dd3fc" strokeWidth={1.5} />
      </svg>
      <Legend items={[
        { color: "#7dd3fc", label: "HRV daily" },
        { color: COLOR.accent, label: "baseline ±1 SD" },
      ]} />
    </Card>
  );
}

function RhrVsBaselineCard({
  daily, baseline, avg7d, deltaBpm,
}: {
  daily: Array<{ date: string; rhr: number | null }>;
  baseline: number | null;
  avg7d: number | null;
  deltaBpm: number | null;
}) {
  const vals = daily.map((d) => d.rhr).filter((v): v is number => v != null);
  const yMin = Math.min(...vals, baseline ?? 0) - 3;
  const yMax = Math.max(...vals, baseline ?? 0) + 3;
  const yScale = (v: number) => 80 - ((v - yMin) / (yMax - yMin)) * 80;

  const points = daily
    .map((d, i) => (d.rhr == null ? null : `${(i / (daily.length - 1)) * 360},${yScale(d.rhr)}`))
    .filter(Boolean)
    .join(" ");

  const tone: "good" | "warn" | "bad" =
    deltaBpm == null ? "warn" : deltaBpm >= 5 ? "bad" : deltaBpm >= 3 ? "warn" : "good";

  return (
    <Card>
      <CardHeader
        title="RHR vs baseline · 28d"
        sub={baseline != null && avg7d != null
          ? `7d avg: ${fmtNum(avg7d)} bpm · baseline: ${fmtNum(baseline)} bpm`
          : "Insufficient data"}
        value={deltaBpm != null ? `${deltaBpm > 0 ? "+" : ""}${fmtNum(deltaBpm)} bpm` : "—"}
        tone={tone}
      />
      <svg viewBox="0 0 360 80" preserveAspectRatio="none" style={{ width: "100%" }}>
        {baseline != null && (
          <>
            <line x1="0" y1={yScale(baseline)}     x2="360" y2={yScale(baseline)}
              stroke={COLOR.accent} strokeWidth={1} strokeDasharray="3,3" opacity={0.5} />
            <line x1="0" y1={yScale(baseline + 5)} x2="360" y2={yScale(baseline + 5)}
              stroke={COLOR.danger} strokeWidth={1} strokeDasharray="2,4" opacity={0.4} />
          </>
        )}
        <polyline points={points} fill="none" stroke="#7dd3fc" strokeWidth={1.5} />
      </svg>
      <Legend items={[
        { color: COLOR.accent, label: "baseline" },
        { color: COLOR.danger, label: "+5 bpm alert" },
      ]} />
    </Card>
  );
}

function HrvWeeklyCard({
  weekly, baseline,
}: {
  weekly: RecoveryIntelligencePayload["weekly"];
  baseline: number | null;
}) {
  const vals = weekly.map((w) => w.hrv_avg).filter((v): v is number => v != null);
  if (vals.length === 0) {
    return (
      <Card>
        <CardHeader title="HRV weekly avg · 12w" sub="Insufficient data" value="—" tone="warn" />
      </Card>
    );
  }
  const yMax = Math.max(...vals, baseline ?? 0) * 1.1;
  const barH = (v: number | null) => (v == null ? 0 : (v / yMax) * 70);

  const recentTrendingDown =
    baseline != null
      ? weekly.slice(-3).every((w) => w.hrv_avg != null && w.hrv_avg < baseline * 0.97)
      : false;

  return (
    <Card>
      <CardHeader
        title="HRV weekly avg · 12w"
        sub={recentTrendingDown ? "Trending down 3 weeks" : ""}
        value={vals[vals.length - 1] != null ? `${fmtNum(vals[vals.length - 1])}` : "—"}
        tone={recentTrendingDown ? "warn" : "good"}
      />
      <svg viewBox="0 0 360 80" preserveAspectRatio="none" style={{ width: "100%" }}>
        {baseline != null && (
          <line x1="0" y1={80 - (baseline / yMax) * 70} x2="360" y2={80 - (baseline / yMax) * 70}
            stroke={COLOR.accent} strokeDasharray="3,3" opacity={0.5} />
        )}
        {weekly.map((w, i) => {
          const h = barH(w.hrv_avg);
          const x = 4 + i * 30;
          const isRecent = i >= weekly.length - 3 && recentTrendingDown;
          return (
            <rect key={w.week_start}
              x={x} y={80 - h} width={22} height={h}
              fill={isRecent ? COLOR.warning : "#7dd3fc"} />
          );
        })}
      </svg>
    </Card>
  );
}

// ── Shared card primitives (used by every section) ──────────────────────────

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      background: COLOR.surface,
      border: `1px solid ${COLOR.divider}`,
      borderRadius: 12, padding: 14, marginBottom: 10,
    }}>{children}</div>
  );
}

function CardHeader({
  title, sub, value, tone,
}: { title: string; sub?: string; value?: string; tone?: "good" | "warn" | "bad" }) {
  const toneColor = tone === "good" ? COLOR.success : tone === "bad" ? COLOR.danger : COLOR.warning;
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: COLOR.text }}>{title}</div>
        {sub && <div style={{ fontSize: 11, color: COLOR.textMuted }}>{sub}</div>}
      </div>
      {value && (
        <div style={{ fontSize: 18, fontWeight: 700, color: toneColor }}>{value}</div>
      )}
    </div>
  );
}

function Legend({ items }: { items: Array<{ color: string; label: string }> }) {
  return (
    <div style={{ display: "flex", gap: 12, fontSize: 10, color: COLOR.textMuted, marginTop: 6, flexWrap: "wrap" }}>
      {items.map((it) => (
        <span key={it.label}>
          <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: it.color, verticalAlign: "middle", marginRight: 4 }} />
          {it.label}
        </span>
      ))}
    </div>
  );
}
```

**Note:** the `Card`, `CardHeader`, `Legend` helpers live in this file but are imported by every other section file via re-export. Add the re-export at the bottom:

```ts
export { Card, CardHeader, Legend };
```

- [ ] **Step 2: Typecheck (still failing — keep going)**

---

## Task 14: SleepSection (A4 A5 A6 A7)

**Files:**
- Create: `components/health/trends/SleepSection.tsx`

**Visual reference:** Cluster 2 of the mockup file.

- [ ] **Step 1: Write the section**

```tsx
// components/health/trends/SleepSection.tsx
"use client";
import type { RecoveryIntelligencePayload } from "@/lib/coach/recovery-intelligence/types";
import { Card, CardHeader, Legend } from "@/components/health/trends/HrvAutonomicSection";
import { COLOR } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";
import {
  SLEEP_TARGET_BAND, SLEEP_SCORE_MEANINGFUL, SLEEP_SCORE_ACTION, BEDTIME_DRIFT_SD_MINUTES,
} from "@/lib/coach/recovery-intelligence/thresholds";

type Props = { payload: RecoveryIntelligencePayload };

export function SleepSection({ payload }: Props) {
  const { daily, sleep_architecture, bedtime, derived } = payload;

  // 7d rolling sleep_hours average for A4 line overlay.
  const rolling7 = daily.map((d, i, arr) => {
    const slice = arr.slice(Math.max(0, i - 6), i + 1).map((x) => x.sleep_hours).filter((v): v is number => v != null);
    if (slice.length === 0) return null;
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  });

  return (
    <section style={{ padding: 16, paddingTop: 0 }}>
      <h3 style={sectionTitle}>Sleep architecture &amp; consistency</h3>

      {/* A4: Sleep hours bars + 7d rolling avg */}
      <SleepHoursCard
        daily={daily.map((d) => ({ date: d.date, hours: d.sleep_hours }))}
        rolling={rolling7}
        avg7d={
          rolling7[rolling7.length - 1]
        }
      />

      {/* A5: Sleep score vs hours */}
      <ScoreVsHoursCard
        daily={daily.map((d) => ({ date: d.date, score: d.sleep_score, hours: d.sleep_hours }))}
      />

      {/* A6: Sleep architecture mix */}
      <ArchitectureCard arch={sleep_architecture} />

      {/* A7: Bedtime/wake consistency */}
      <BedtimeCard
        bedtime={bedtime}
        meanMinutes={derived.bedtime_mean_minutes}
        sdMinutes={derived.bedtime_sd_minutes}
      />
    </section>
  );
}

const sectionTitle: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, textTransform: "uppercase",
  letterSpacing: 0.6, color: COLOR.textMuted, margin: "0 0 10px 0",
};

function SleepHoursCard({
  daily, rolling, avg7d,
}: {
  daily: Array<{ date: string; hours: number | null }>;
  rolling: Array<number | null>;
  avg7d: number | null;
}) {
  const [lo, hi] = SLEEP_TARGET_BAND;
  const yMax = 10;
  const yScale = (v: number) => 80 - (v / yMax) * 80;
  const tone: "good" | "warn" | "bad" =
    avg7d == null ? "warn" : avg7d >= lo ? "good" : avg7d >= 6 ? "warn" : "bad";

  return (
    <Card>
      <CardHeader title="Sleep hours · 28d"
        sub={`7d avg: ${avg7d != null ? `${fmtNum(avg7d)}h` : "—"} · target ${lo}–${hi}h`}
        value={avg7d != null ? `${fmtNum(avg7d)}h` : "—"} tone={tone} />
      <svg viewBox="0 0 360 80" preserveAspectRatio="none" style={{ width: "100%" }}>
        {/* target band */}
        <rect x="0" y={yScale(hi)} width="360" height={yScale(lo) - yScale(hi)}
          fill={COLOR.success} fillOpacity={0.08} />
        {/* bars */}
        {daily.map((d, i) => {
          if (d.hours == null) return null;
          const x = 2 + i * (360 - 4) / daily.length;
          const w = (360 - 4) / daily.length - 2;
          const h = (d.hours / yMax) * 80;
          const color = d.hours >= lo ? "#7dd3fc" : d.hours >= 6 ? COLOR.warning : COLOR.danger;
          return <rect key={i} x={x} y={80 - h} width={w} height={h} fill={color} />;
        })}
        {/* 7d rolling line */}
        <polyline
          points={rolling
            .map((v, i) => (v == null ? null : `${(i / (rolling.length - 1)) * 360},${yScale(v)}`))
            .filter(Boolean)
            .join(" ")}
          fill="none" stroke={COLOR.accent} strokeWidth={1.5}
        />
      </svg>
      <Legend items={[
        { color: "#7dd3fc", label: "nightly" },
        { color: COLOR.accent, label: "7d rolling" },
        { color: COLOR.success, label: "target band" },
      ]} />
    </Card>
  );
}

function ScoreVsHoursCard({
  daily,
}: { daily: Array<{ date: string; score: number | null; hours: number | null }> }) {
  const yScoreMax = 100;
  const yHoursMax = 10;
  const yS = (v: number) => 80 - (v / yScoreMax) * 80;
  const yH = (v: number) => 80 - (v / yHoursMax) * 80;
  const lastScore = daily[daily.length - 1]?.score ?? null;
  const lastHours = daily[daily.length - 1]?.hours ?? null;
  return (
    <Card>
      <CardHeader title="Sleep score vs hours · 28d"
        sub={`Score ${lastScore != null ? Math.round(lastScore) : "—"} · hours ${lastHours != null ? fmtNum(lastHours) : "—"}`} />
      <svg viewBox="0 0 360 80" preserveAspectRatio="none" style={{ width: "100%" }}>
        <line x1="0" y1={yS(SLEEP_SCORE_MEANINGFUL)} x2="360" y2={yS(SLEEP_SCORE_MEANINGFUL)}
          stroke={COLOR.warning} strokeWidth={0.5} strokeDasharray="2,3" opacity={0.4} />
        <polyline
          points={daily.map((d, i) => (d.score == null ? null : `${(i / (daily.length - 1)) * 360},${yS(d.score)}`)).filter(Boolean).join(" ")}
          fill="none" stroke={COLOR.warning} strokeWidth={1.5} />
        <polyline
          points={daily.map((d, i) => (d.hours == null ? null : `${(i / (daily.length - 1)) * 360},${yH(d.hours)}`)).filter(Boolean).join(" ")}
          fill="none" stroke="#7dd3fc" strokeWidth={1.5} />
      </svg>
      <Legend items={[
        { color: COLOR.warning, label: "score" },
        { color: "#7dd3fc", label: "hours" },
      ]} />
    </Card>
  );
}

function ArchitectureCard({ arch }: { arch: RecoveryIntelligencePayload["sleep_architecture"] }) {
  const yMax = Math.max(...arch.map((a) => a.total_hours ?? 0), 1);
  const yScale = (v: number) => (v / yMax) * 80;
  return (
    <Card>
      <CardHeader title="Sleep architecture mix · 14d"
        sub={archSummary(arch)} />
      <svg viewBox="0 0 360 80" preserveAspectRatio="none" style={{ width: "100%" }}>
        {arch.map((a, i) => {
          const x = 2 + i * (360 - 4) / arch.length;
          const w = (360 - 4) / arch.length - 2;
          const deep = a.deep_hours ?? 0;
          const rem  = a.rem_hours ?? 0;
          const light = a.light_hours ?? 0;
          const yDeep  = 80 - yScale(deep);
          const yRem   = yDeep - yScale(rem);
          const yLight = yRem  - yScale(light);
          return (
            <g key={i}>
              <rect x={x} y={yDeep}  width={w} height={yScale(deep)}  fill={COLOR.accent} />
              <rect x={x} y={yRem}   width={w} height={yScale(rem)}   fill="#7dd3fc" />
              <rect x={x} y={yLight} width={w} height={yScale(light)} fill="#374151" />
            </g>
          );
        })}
      </svg>
      <Legend items={[
        { color: COLOR.accent, label: "deep" },
        { color: "#7dd3fc", label: "REM" },
        { color: "#374151", label: "light" },
      ]} />
    </Card>
  );
}

function archSummary(arch: RecoveryIntelligencePayload["sleep_architecture"]): string {
  const totalDeep = arch.reduce((a, b) => a + (b.deep_hours ?? 0), 0);
  const totalRem  = arch.reduce((a, b) => a + (b.rem_hours ?? 0), 0);
  const totalSum  = arch.reduce((a, b) => a + (b.total_hours ?? 0), 0);
  if (totalSum === 0) return "Insufficient data";
  const dP = Math.round((totalDeep / totalSum) * 100);
  const rP = Math.round((totalRem  / totalSum) * 100);
  const lP = 100 - dP - rP;
  return `Deep ${dP}% · REM ${rP}% · Light ${lP}%`;
}

function BedtimeCard({
  bedtime, meanMinutes, sdMinutes,
}: {
  bedtime: RecoveryIntelligencePayload["bedtime"];
  meanMinutes: number | null;
  sdMinutes: number | null;
}) {
  // y-axis: 0 = 18:00, 720 = 06:00, 1080 = 12:00 next day. Use 18:00–10:00 range = 0–960.
  const yMax = 960;
  const yScale = (m: number) => (m / yMax) * 110;
  const isDrifting = sdMinutes != null && sdMinutes >= BEDTIME_DRIFT_SD_MINUTES;
  return (
    <Card>
      <CardHeader title="Bedtime / wake consistency · 28d"
        sub={`Bedtime SD: ${sdMinutes != null ? Math.round(sdMinutes) : "—"} min · wake variability is tighter`}
        value={isDrifting ? "drift" : "ok"} tone={isDrifting ? "warn" : "good"} />
      <svg viewBox="0 0 360 110" preserveAspectRatio="none" style={{ width: "100%" }}>
        {meanMinutes != null && (
          <line x1="0" y1={yScale(meanMinutes)} x2="360" y2={yScale(meanMinutes)}
            stroke={COLOR.accent} strokeDasharray="2,3" opacity={0.3} />
        )}
        {bedtime.map((p, i) => {
          const x = (i / (bedtime.length - 1)) * 360;
          return (
            <g key={p.date}>
              {p.bedtime_minutes_after_18 != null && (
                <circle cx={x} cy={yScale(p.bedtime_minutes_after_18)} r={2.5} fill="#7dd3fc" />
              )}
              {p.wake_minutes_after_18 != null && (
                <circle cx={x} cy={yScale(p.wake_minutes_after_18)} r={2.5} fill={COLOR.accent} />
              )}
            </g>
          );
        })}
      </svg>
      <Legend items={[
        { color: "#7dd3fc", label: "bedtime" },
        { color: COLOR.accent, label: "wake" },
      ]} />
    </Card>
  );
}
```

- [ ] **Step 2: Typecheck (still failing — keep going)**

---

## Task 15: StrainRecoverySection (A8 A9 A10 A11)

**Files:**
- Create: `components/health/trends/StrainRecoverySection.tsx`

**Visual reference:** Cluster 3 of the mockup file.

- [ ] **Step 1: Write the section**

```tsx
// components/health/trends/StrainRecoverySection.tsx
"use client";
import type { RecoveryIntelligencePayload } from "@/lib/coach/recovery-intelligence/types";
import { Card, CardHeader, Legend } from "@/components/health/trends/HrvAutonomicSection";
import { COLOR } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";
import {
  STRAIN_HIGH_AVG_7D, RECOVERY_LOW_AVG_7D,
} from "@/lib/coach/recovery-intelligence/thresholds";

type Props = { payload: RecoveryIntelligencePayload };

export function StrainRecoverySection({ payload }: Props) {
  const { daily, weekly, derived } = payload;

  // Reduce weekly array to last 4 weeks for A8.
  const last4Weeks = weekly.slice(-4);

  return (
    <section style={{ padding: 16, paddingTop: 0 }}>
      <h3 style={sectionTitle}>Strain × Recovery balance</h3>

      {/* A8 */}
      <RecoveryDistributionCard weeks={last4Weeks} />

      {/* A9 */}
      <StrainRecoveryCard daily={daily} derived={derived} />

      {/* A10: day-of-week strain bars (12w) */}
      <DayOfWeekStrainCard daily={daily} weekly={weekly} />

      {/* A11: scatter strain[t-1] vs recovery[t] */}
      <PostStrainScatterCard daily={daily} />
    </section>
  );
}

const sectionTitle: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, textTransform: "uppercase",
  letterSpacing: 0.6, color: COLOR.textMuted, margin: "0 0 10px 0",
};

function RecoveryDistributionCard({
  weeks,
}: { weeks: RecoveryIntelligencePayload["weekly"] }) {
  const totals = weeks.reduce(
    (acc, w) => ({
      low:  acc.low  + w.recovery_low_days,
      ok:   acc.ok   + w.recovery_ok_days,
      high: acc.high + w.recovery_high_days,
    }),
    { low: 0, ok: 0, high: 0 },
  );
  const total = totals.low + totals.ok + totals.high;
  const greenPct = total === 0 ? 0 : Math.round((totals.high / total) * 100);
  const tone: "good" | "warn" | "bad" =
    greenPct >= 50 ? "good" : greenPct >= 25 ? "warn" : "bad";

  return (
    <Card>
      <CardHeader title="Recovery distribution · 28d"
        sub={`${totals.low} red · ${totals.ok} yellow · ${totals.high} green`}
        value={`${greenPct}%`} tone={tone} />
      <svg viewBox="0 0 360 80" preserveAspectRatio="none" style={{ width: "100%" }}>
        {weeks.map((w, i) => {
          const x = 20 + i * 80;
          const tot = w.recovery_low_days + w.recovery_ok_days + w.recovery_high_days;
          if (tot === 0) return null;
          const hHigh = (w.recovery_high_days / tot) * 80;
          const hOk   = (w.recovery_ok_days   / tot) * 80;
          const hLow  = (w.recovery_low_days  / tot) * 80;
          return (
            <g key={w.week_start}>
              <rect x={x} y={0}              width={60} height={hHigh} fill={COLOR.success} />
              <rect x={x} y={hHigh}          width={60} height={hOk}   fill={COLOR.warning} />
              <rect x={x} y={hHigh + hOk}    width={60} height={hLow}  fill={COLOR.danger} />
            </g>
          );
        })}
      </svg>
      <Legend items={[
        { color: COLOR.success, label: "high (≥67)" },
        { color: COLOR.warning, label: "ok (34–66)" },
        { color: COLOR.danger, label: "low (<34)" },
      ]} />
    </Card>
  );
}

function StrainRecoveryCard({
  daily, derived,
}: {
  daily: RecoveryIntelligencePayload["daily"];
  derived: RecoveryIntelligencePayload["derived"];
}) {
  const overreach =
    derived.strain_avg_7d != null && derived.recovery_avg_7d != null &&
    derived.strain_avg_7d >= STRAIN_HIGH_AVG_7D && derived.recovery_avg_7d < RECOVERY_LOW_AVG_7D;
  const yScaleStrain = (v: number) => 80 - (v / 21) * 80;
  const yScaleRecov  = (v: number) => 80 - (v / 100) * 80;
  return (
    <Card>
      <CardHeader title="Strain × Recovery · 28d"
        sub={`7d strain ${derived.strain_avg_7d != null ? fmtNum(derived.strain_avg_7d) : "—"} · recovery ${derived.recovery_avg_7d != null ? `${Math.round(derived.recovery_avg_7d)}%` : "—"}`}
        value={overreach ? "⚠ overreach risk" : "balanced"} tone={overreach ? "bad" : "good"} />
      <svg viewBox="0 0 360 80" preserveAspectRatio="none" style={{ width: "100%" }}>
        {overreach && <rect x="240" y="0" width="120" height="80" fill={COLOR.danger} fillOpacity={0.06} />}
        <polyline
          points={daily.map((d, i) => (d.strain == null ? null : `${(i / (daily.length - 1)) * 360},${yScaleStrain(d.strain)}`)).filter(Boolean).join(" ")}
          fill="none" stroke={COLOR.warning} strokeWidth={1.5} />
        <polyline
          points={daily.map((d, i) => (d.recovery == null ? null : `${(i / (daily.length - 1)) * 360},${yScaleRecov(d.recovery)}`)).filter(Boolean).join(" ")}
          fill="none" stroke={COLOR.success} strokeWidth={1.5} />
      </svg>
      <Legend items={[
        { color: COLOR.warning, label: "strain" },
        { color: COLOR.success, label: "recovery" },
        { color: COLOR.danger, label: "overreach band" },
      ]} />
    </Card>
  );
}

function DayOfWeekStrainCard({
  daily, weekly,
}: {
  daily: RecoveryIntelligencePayload["daily"];
  weekly: RecoveryIntelligencePayload["weekly"];
}) {
  // We only have 28d in `daily`; for 12w day-of-week we need the broader query.
  // For v1, derive from `daily` (last 28 days, ~4 weeks). Real 12w would require
  // adding a 12w daily series to the payload — deferred per spec scope (v2).
  const buckets = [0,0,0,0,0,0,0].map(() => ({ sum: 0, n: 0 }));
  for (const d of daily) {
    if (d.strain == null) continue;
    const dow = (new Date(`${d.date}T00:00:00Z`).getUTCDay() + 6) % 7; // Mon=0
    buckets[dow].sum += d.strain;
    buckets[dow].n   += 1;
  }
  const avgs = buckets.map((b) => (b.n === 0 ? 0 : b.sum / b.n));
  const yMax = Math.max(...avgs, 1);
  const labels = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
  const top2 = [...avgs.map((v, i) => ({ v, i }))].sort((a, b) => b.v - a.v).slice(0, 2).map((x) => labels[x.i]);
  return (
    <Card>
      <CardHeader title="Day-of-week strain · 4w avg"
        sub={top2.length ? `${top2.join(" & ")} are your heavy days` : "Insufficient data"} />
      <svg viewBox="0 0 360 80" preserveAspectRatio="none" style={{ width: "100%" }}>
        {avgs.map((v, i) => {
          const x = 10 + i * 50;
          const h = (v / yMax) * 70;
          const color = v >= 15 ? COLOR.danger : v >= 10 ? COLOR.warning : COLOR.textMid;
          return (
            <g key={i}>
              <rect x={x} y={80 - h} width={40} height={h} fill={color} />
              <text x={x + 20} y={78} fontSize={9} fill={COLOR.textMuted} textAnchor="middle">{labels[i]}</text>
            </g>
          );
        })}
      </svg>
    </Card>
  );
}

function PostStrainScatterCard({
  daily,
}: { daily: RecoveryIntelligencePayload["daily"] }) {
  // Pairs: (yesterday_strain, today_recovery).
  const pairs: Array<{ x: number; y: number }> = [];
  for (let i = 1; i < daily.length; i++) {
    const xs = daily[i - 1].strain;
    const ys = daily[i].recovery;
    if (xs != null && ys != null) pairs.push({ x: xs, y: ys });
  }

  // OLS for trend line.
  let slope = 0, intercept = 0;
  if (pairs.length >= 3) {
    const n = pairs.length;
    const xMean = pairs.reduce((a, p) => a + p.x, 0) / n;
    const yMean = pairs.reduce((a, p) => a + p.y, 0) / n;
    const num = pairs.reduce((a, p) => a + (p.x - xMean) * (p.y - yMean), 0);
    const den = pairs.reduce((a, p) => a + (p.x - xMean) ** 2, 0);
    slope = den === 0 ? 0 : num / den;
    intercept = yMean - slope * xMean;
  }

  const xScale = (x: number) => 30 + (x / 21) * 320;
  const yScale = (y: number) => 92 - (y / 100) * 80;

  return (
    <Card>
      <CardHeader title="Strain → next-day recovery · 28d"
        sub={pairs.length >= 3 ? `${fmtNum(slope)} pts recovery per +1 strain` : "Need more data"} />
      <svg viewBox="0 0 360 110" preserveAspectRatio="none" style={{ width: "100%" }}>
        <text x="2" y="14" fontSize={9} fill={COLOR.textMuted}>recov %</text>
        <text x="320" y="105" fontSize={9} fill={COLOR.textMuted}>strain</text>
        {pairs.length >= 3 && (
          <line x1={xScale(0)} y1={yScale(intercept)} x2={xScale(21)} y2={yScale(slope * 21 + intercept)}
            stroke={COLOR.accent} strokeWidth={1} strokeDasharray="3,3" opacity={0.6} />
        )}
        {pairs.map((p, i) => (
          <circle key={i} cx={xScale(p.x)} cy={yScale(p.y)} r={3} fill="#7dd3fc" />
        ))}
      </svg>
    </Card>
  );
}
```

- [ ] **Step 2: Typecheck (still failing — keep going)**

---

## Task 16: BodySignalsSection (A12 A13)

**Files:**
- Create: `components/health/trends/BodySignalsSection.tsx`

**Visual reference:** Cluster 4 of the mockup file.

- [ ] **Step 1: Write the section**

```tsx
// components/health/trends/BodySignalsSection.tsx
"use client";
import type { RecoveryIntelligencePayload } from "@/lib/coach/recovery-intelligence/types";
import { Card, CardHeader, Legend } from "@/components/health/trends/HrvAutonomicSection";
import { COLOR } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";
import { SKIN_TEMP_DELTA_C, RR_DELTA_BPM } from "@/lib/coach/recovery-intelligence/thresholds";

type Props = { payload: RecoveryIntelligencePayload };

export function BodySignalsSection({ payload }: Props) {
  const { daily, baselines } = payload;
  return (
    <section style={{ padding: 16, paddingTop: 0 }}>
      <h3 style={sectionTitle}>Body signals · early warning</h3>
      <SkinTempCard daily={daily} baseline={baselines.skin_temp_baseline_c} />
      <RespRateCard daily={daily} baseline={baselines.respiratory_rate_baseline_bpm} />
    </section>
  );
}

const sectionTitle: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, textTransform: "uppercase",
  letterSpacing: 0.6, color: COLOR.textMuted, margin: "0 0 10px 0",
};

function SkinTempCard({
  daily, baseline,
}: { daily: RecoveryIntelligencePayload["daily"]; baseline: number | null }) {
  const lastDelta = (() => {
    if (baseline == null) return null;
    const recent3 = daily.slice(-3).map((d) => d.skin_temp_c).filter((v): v is number => v != null);
    if (recent3.length === 0) return null;
    return recent3.reduce((a, b) => a + b, 0) / recent3.length - baseline;
  })();
  const tone: "good" | "warn" | "bad" =
    lastDelta == null ? "warn" : lastDelta >= SKIN_TEMP_DELTA_C ? "bad" : lastDelta >= 0.3 ? "warn" : "good";

  const yScale = (v: number) => 40 - ((v - (baseline ?? v)) / 1.5) * 40;
  return (
    <Card>
      <CardHeader title="Skin temp deviation · 28d"
        sub={lastDelta != null && lastDelta >= SKIN_TEMP_DELTA_C ? `Last 3 days +${fmtNum(lastDelta)}°C · pre-symptomatic?` : "Within personal band"}
        value={lastDelta != null ? `${lastDelta > 0 ? "+" : ""}${fmtNum(lastDelta)}°C` : "—"} tone={tone} />
      <svg viewBox="0 0 360 80" preserveAspectRatio="none" style={{ width: "100%" }}>
        {baseline != null && (
          <>
            <rect x="0" y={yScale(baseline + 0.3)} width="360" height={yScale(baseline - 0.3) - yScale(baseline + 0.3)}
              fill={COLOR.accent} fillOpacity={0.1} />
            <line x1="0" y1={yScale(baseline)} x2="360" y2={yScale(baseline)}
              stroke={COLOR.accent} strokeDasharray="3,3" opacity={0.5} />
            <line x1="0" y1={yScale(baseline + SKIN_TEMP_DELTA_C)} x2="360" y2={yScale(baseline + SKIN_TEMP_DELTA_C)}
              stroke={COLOR.danger} strokeDasharray="2,4" opacity={0.4} />
          </>
        )}
        <polyline
          points={daily.map((d, i) => (d.skin_temp_c == null ? null : `${(i / (daily.length - 1)) * 360},${yScale(d.skin_temp_c)}`)).filter(Boolean).join(" ")}
          fill="none" stroke="#7dd3fc" strokeWidth={1.5} />
      </svg>
    </Card>
  );
}

function RespRateCard({
  daily, baseline,
}: { daily: RecoveryIntelligencePayload["daily"]; baseline: number | null }) {
  const last7 = daily.slice(-7).map((d) => d.respiratory_rate).filter((v): v is number => v != null);
  const avg7 = last7.length === 0 ? null : last7.reduce((a, b) => a + b, 0) / last7.length;
  const delta = avg7 != null && baseline != null ? avg7 - baseline : null;
  const tone: "good" | "warn" | "bad" =
    delta == null ? "warn" : delta >= RR_DELTA_BPM ? "warn" : "good";
  const yScale = (v: number) => 40 - ((v - (baseline ?? v)) / 3) * 30;
  return (
    <Card>
      <CardHeader title="Respiratory rate · 28d"
        sub={`7d avg: ${avg7 != null ? fmtNum(avg7) : "—"} bpm · baseline: ${baseline != null ? fmtNum(baseline) : "—"}`}
        value={delta != null ? `${delta > 0 ? "+" : ""}${fmtNum(delta)}` : "—"} tone={tone} />
      <svg viewBox="0 0 360 70" preserveAspectRatio="none" style={{ width: "100%" }}>
        {baseline != null && (
          <>
            <line x1="0" y1={yScale(baseline)} x2="360" y2={yScale(baseline)}
              stroke={COLOR.accent} strokeDasharray="3,3" opacity={0.5} />
            <line x1="0" y1={yScale(baseline + RR_DELTA_BPM)} x2="360" y2={yScale(baseline + RR_DELTA_BPM)}
              stroke={COLOR.warning} strokeDasharray="2,4" opacity={0.4} />
          </>
        )}
        <polyline
          points={daily.map((d, i) => (d.respiratory_rate == null ? null : `${(i / (daily.length - 1)) * 360},${yScale(d.respiratory_rate)}`)).filter(Boolean).join(" ")}
          fill="none" stroke="#7dd3fc" strokeWidth={1.5} />
      </svg>
    </Card>
  );
}
```

- [ ] **Step 2: Typecheck (still failing — keep going)**

---

## Task 17: SubjectiveSection (A14 A15 A16)

**Files:**
- Create: `components/health/trends/SubjectiveSection.tsx`

**Visual reference:** Cluster 5 of the mockup file.

- [ ] **Step 1: Write the section**

```tsx
// components/health/trends/SubjectiveSection.tsx
"use client";
import type { RecoveryIntelligencePayload, SubjectivePoint } from "@/lib/coach/recovery-intelligence/types";
import { Card, CardHeader, Legend } from "@/components/health/trends/HrvAutonomicSection";
import { COLOR } from "@/lib/ui/theme";
import { RECURRING_SORENESS_OCCURRENCES, RECURRING_SORENESS_WINDOW_DAYS } from "@/lib/coach/recovery-intelligence/thresholds";

const AREAS = ["chest", "back", "legs", "shoulders", "arms", "core"] as const;

type Props = { payload: RecoveryIntelligencePayload };

export function SubjectiveSection({ payload }: Props) {
  const { subjective, daily } = payload;
  return (
    <section style={{ padding: 16, paddingTop: 0 }}>
      <h3 style={sectionTitle}>Subjective signals · from checkins</h3>
      <SorenessHeatmapCard subjective={subjective} />
      <FatigueTimelineCard subjective={subjective} />
      <SubjVsObjCard daily={daily} subjective={subjective} />
    </section>
  );
}

const sectionTitle: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, textTransform: "uppercase",
  letterSpacing: 0.6, color: COLOR.textMuted, margin: "0 0 10px 0",
};

function SorenessHeatmapCard({ subjective }: { subjective: SubjectivePoint[] }) {
  // Recurring detection over last 14d for the subtitle.
  const last14 = subjective.slice(-RECURRING_SORENESS_WINDOW_DAYS);
  const counts: Record<string, number> = {};
  for (const p of last14) for (const a of p.soreness_areas) counts[a] = (counts[a] ?? 0) + 1;
  const recurring = Object.entries(counts)
    .filter(([, c]) => c >= RECURRING_SORENESS_OCCURRENCES)
    .map(([a, c]) => `${a} (${c})`);

  return (
    <Card>
      <CardHeader title="Soreness heat-map · 28d"
        sub={recurring.length ? `Recurring: ${recurring.join(", ")} of last ${RECURRING_SORENESS_WINDOW_DAYS} days` : "No recurring areas"} />
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        {AREAS.map((area) => (
          <div key={area} style={{ display: "flex", gap: 2, alignItems: "center" }}>
            <div style={{ fontSize: 10, color: COLOR.textMid, width: 60, flexShrink: 0 }}>{area}</div>
            {subjective.map((p) => {
              const has = p.soreness_areas.includes(area);
              const bg = !has ? "#1a1a1a"
                : p.soreness_severity === "sharp" ? "rgba(248,113,113,0.7)"
                : "rgba(250,204,21,0.45)";
              return <div key={p.date} style={{ flex: 1, height: 14, borderRadius: 2, background: bg }} />;
            })}
          </div>
        ))}
      </div>
      <Legend items={[
        { color: "rgba(250,204,21,0.45)", label: "mild" },
        { color: "rgba(248,113,113,0.7)", label: "sharp" },
      ]} />
    </Card>
  );
}

function FatigueTimelineCard({ subjective }: { subjective: SubjectivePoint[] }) {
  const heavyCount = subjective.slice(-7).filter((s) => s.fatigue === "heavy").length;
  const sickStreak = (() => {
    let s = 0;
    for (let i = subjective.length - 1; i >= 0; i--) {
      if (subjective[i].sick) s++; else break;
    }
    return s;
  })();

  return (
    <Card>
      <CardHeader title="Fatigue × sickness · 28d"
        sub={`${heavyCount} heavy in 7d${sickStreak > 0 ? ` · current sick streak ${sickStreak}d` : ""}`} />
      <div style={{ display: "flex", gap: 2 }}>
        {subjective.map((p) => {
          const bg =
            p.fatigue === "heavy" ? "#7f1d1d" :
            p.fatigue === "some"  ? "#422006" :
            "#1f2937";
          return (
            <div key={p.date} style={{ flex: 1, height: 22, borderRadius: 2, background: bg, position: "relative" }}>
              {p.sick && (
                <div style={{ position: "absolute", bottom: -3, left: "50%", transform: "translateX(-50%)",
                  width: 6, height: 6, background: COLOR.danger, borderRadius: "50%" }} />
              )}
            </div>
          );
        })}
      </div>
      <Legend items={[
        { color: "#1f2937", label: "none" },
        { color: "#422006", label: "some" },
        { color: "#7f1d1d", label: "heavy" },
        { color: COLOR.danger, label: "sick" },
      ]} />
    </Card>
  );
}

function SubjVsObjCard({
  daily, subjective,
}: { daily: RecoveryIntelligencePayload["daily"]; subjective: SubjectivePoint[] }) {
  // Both arrays are 28d, same dates.
  const yHrv = (v: number, min: number, max: number) => 80 - ((v - min) / (max - min)) * 80;
  const hrvs = daily.map((d) => d.hrv).filter((v): v is number => v != null);
  if (hrvs.length === 0) {
    return <Card><CardHeader title="Subjective vs objective · 28d" sub="Insufficient data" /></Card>;
  }
  const min = Math.min(...hrvs) * 0.95;
  const max = Math.max(...hrvs) * 1.05;
  return (
    <Card>
      <CardHeader title="Subjective vs objective · 28d"
        sub="HRV trend overlaid with reported fatigue tier" />
      <svg viewBox="0 0 360 80" preserveAspectRatio="none" style={{ width: "100%" }}>
        <polyline
          points={daily.map((d, i) => (d.hrv == null ? null : `${(i / (daily.length - 1)) * 360},${yHrv(d.hrv, min, max)}`)).filter(Boolean).join(" ")}
          fill="none" stroke="#7dd3fc" strokeWidth={1.5} />
        {subjective.map((s, i) => {
          if (s.fatigue == null) return null;
          const r = s.fatigue === "heavy" ? 5 : s.fatigue === "some" ? 3 : 2;
          return <circle key={s.date} cx={(i / (subjective.length - 1)) * 360} cy={72} r={r} fill={COLOR.danger} />;
        })}
      </svg>
      <Legend items={[
        { color: "#7dd3fc", label: "HRV" },
        { color: COLOR.danger, label: "fatigue (size = tier)" },
      ]} />
    </Card>
  );
}
```

- [ ] **Step 2: Typecheck (still failing — keep going)**

---

## Task 18: MobilityCard (A17)

**Files:**
- Create: `components/health/trends/MobilityCard.tsx`

**Visual reference:** Cluster 6 of the mockup file.

- [ ] **Step 1: Write the card**

```tsx
// components/health/trends/MobilityCard.tsx
"use client";
import type { RecoveryIntelligencePayload } from "@/lib/coach/recovery-intelligence/types";
import { Card, CardHeader } from "@/components/health/trends/HrvAutonomicSection";
import { COLOR } from "@/lib/ui/theme";

type Props = { payload: RecoveryIntelligencePayload };

export function MobilityCard({ payload }: Props) {
  const { subjective, derived } = payload;
  // Group 28 days into 4 rows of 7 (Mon→Sun), oldest first.
  // Use the actual weekday of each date.
  const grid: Array<Array<{ date: string; done: boolean } | null>> = [[], [], [], []];
  // Find the Monday on or before subjective[0].date so the grid starts on Mon.
  const first = new Date(`${subjective[0].date}T00:00:00Z`);
  const firstDow = (first.getUTCDay() + 6) % 7; // Mon=0
  // Pad with nulls to start of week.
  for (let i = 0; i < firstDow; i++) grid[0].push(null);
  let row = 0;
  for (const p of subjective) {
    grid[row].push({ date: p.date, done: p.mobility_done });
    if (grid[row].length === 7) { row++; if (row >= 4) break; }
  }
  while (grid[3].length < 7) grid[3].push(null);

  return (
    <section style={{ padding: 16, paddingTop: 0 }}>
      <h3 style={sectionTitle}>Mobility · adherence</h3>
      <Card>
        <CardHeader title="Mobility completion · 28d"
          sub={`Current streak: ${derived.mobility_current_streak_days} days · ${subjective.filter((s) => s.mobility_done).length}/28 done`}
          value={`${Math.round(derived.mobility_completion_pct_28d * 100)}%`} tone="good" />
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          {grid.map((rowCells, ri) => (
            <div key={ri} style={{ display: "flex", gap: 2, alignItems: "center" }}>
              <div style={{ fontSize: 10, color: COLOR.textMid, width: 60, flexShrink: 0 }}>W{ri + 1}</div>
              {rowCells.map((c, i) => (
                <div key={i} style={{
                  flex: 1, height: 14, borderRadius: 2,
                  background: c?.done ? "rgba(74,222,128,0.65)" : "#1a1a1a",
                }} />
              ))}
            </div>
          ))}
          <div style={{ display: "flex", gap: 2, marginLeft: 60 }}>
            {["M","T","W","T","F","S","S"].map((d, i) => (
              <div key={i} style={{ flex: 1, textAlign: "center", fontSize: 9, color: COLOR.textMuted }}>{d}</div>
            ))}
          </div>
        </div>
      </Card>
    </section>
  );
}

const sectionTitle: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, textTransform: "uppercase",
  letterSpacing: 0.6, color: COLOR.textMuted, margin: "0 0 10px 0",
};
```

- [ ] **Step 2: Typecheck (should now be GREEN)**

```bash
npm run typecheck
```
Expected: no errors.

- [ ] **Step 3: Manual smoke on dev**

```bash
npm run dev
```

Navigate to `http://localhost:3000/health?tab=trends`. Expected: all 17 cards render. Click between Coach / Trends / Log pills — state survives.

If a section renders empty: open the browser devtools network tab and check the `useRecoveryIntelligence` query's data. If `daily` is empty for the dev user, you need to seed via existing WHOOP sync; check whether the user has rows in `daily_logs` for the last 28d.

- [ ] **Step 4: Commit the whole Trends pill UI**

```bash
git add app/health/page.tsx components/health/HealthTrendsClient.tsx components/health/trends/
git commit -m "feat(remi): /health Trends pill — 17 recovery cards + 6 sections"
```

---

## Task 19: Backstop — empty-state handling spot-check

The composers already densify and return nulls for missing data. The card components render "—" or "Insufficient data" subtitles when their derived value is null. Spot-check this works.

- [ ] **Step 1: Run dev, navigate to `/health?tab=trends`**

- [ ] **Step 2: For a user with no `checkins` data, verify**:
  - Soreness heat-map renders the labels but all cells are dim (no shaded squares).
  - Fatigue × sickness shows all "none" (gray) cells.
  - Subjective vs objective shows the HRV line but no fatigue dots.

- [ ] **Step 3: For a user with no `sleep_start_at` (migration applied but not yet backfilled OR new WHOOP user)**:
  - Bedtime/wake card shows "Bedtime SD: — min" and no dots.

If anything crashes instead of degrading gracefully, fix the offending card (most likely a `null` slipping past a filter). Re-typecheck, re-test.

- [ ] **Step 4: If fixes needed, commit**

```bash
git add components/health/trends/
git commit -m "fix(remi): graceful empty states in trends cards"
```

If nothing needed fixing, skip this commit.

---

## Task 20: Audit script

**Files:**
- Create: `scripts/audit-recovery-intelligence.mjs`

- [ ] **Step 1: Write the script**

```js
// scripts/audit-recovery-intelligence.mjs
//
// Verifies the RecoveryIntelligencePayload composer outputs against raw
// queries on daily_logs / checkins / workouts for the target user.
//
// Usage:
//   AUDIT_USER_ID=<uuid> node \
//     --import ./scripts/alias-loader.mjs \
//     --experimental-strip-types \
//     --env-file=.env.local \
//     scripts/audit-recovery-intelligence.mjs

import { createClient } from "@supabase/supabase-js";
import { generateRecoveryIntelligence } from "@/lib/coach/recovery-intelligence";

const userId = process.env.AUDIT_USER_ID;
if (!userId) {
  console.error("AUDIT_USER_ID env var required");
  process.exit(1);
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const today = new Date().toISOString().slice(0, 10);
console.log(`audit-recovery-intelligence · user ${userId} · today ${today}`);

const payload = await generateRecoveryIntelligence({ supabase, userId, today });

console.log("\n── shape ──");
console.log(`  daily: ${payload.daily.length} (expected 28)`);
console.log(`  weekly: ${payload.weekly.length} (expected 12)`);
console.log(`  sleep_architecture: ${payload.sleep_architecture.length} (expected 14)`);
console.log(`  bedtime: ${payload.bedtime.length} (expected 28)`);
console.log(`  subjective: ${payload.subjective.length} (expected 28)`);

console.log("\n── baselines ──");
console.log(`  hrv_mean: ${payload.baselines.hrv_mean}`);
console.log(`  hrv_sd: ${payload.baselines.hrv_sd}`);
console.log(`  resting_hr_mean: ${payload.baselines.resting_hr_mean}`);
console.log(`  skin_temp_baseline_c: ${payload.baselines.skin_temp_baseline_c}`);
console.log(`  respiratory_rate_baseline_bpm: ${payload.baselines.respiratory_rate_baseline_bpm}`);

console.log("\n── derived ──");
console.log(JSON.stringify(payload.derived, null, 2));

// Spot-check: composer daily 7d hrv avg == raw query 7d hrv avg.
const last7Iso = payload.daily.slice(-7).map((d) => d.date);
const { data: raw } = await supabase
  .from("daily_logs")
  .select("hrv")
  .eq("user_id", userId)
  .in("date", last7Iso);
const rawAvg = (() => {
  const v = (raw ?? []).map((r) => r.hrv).filter((x) => x != null);
  if (v.length === 0) return null;
  return v.reduce((a, b) => a + b, 0) / v.length;
})();
console.log("\n── crosscheck: hrv_avg_7d ──");
console.log(`  composer: ${payload.derived.hrv_avg_7d}`);
console.log(`  raw     : ${rawAvg}`);
const ok = (payload.derived.hrv_avg_7d == null && rawAvg == null) ||
  (payload.derived.hrv_avg_7d != null && rawAvg != null && Math.abs(payload.derived.hrv_avg_7d - rawAvg) < 0.01);
console.log(`  match: ${ok ? "✓" : "✗"}`);
process.exit(ok ? 0 : 1);
```

- [ ] **Step 2: Run it**

```bash
AUDIT_USER_ID=<your-dev-uuid> node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-recovery-intelligence.mjs
```
Expected: prints the shape + baselines + derived, ends with `match: ✓`.

- [ ] **Step 3: Document the script in CLAUDE.md** (next to the existing audit-* scripts)

Find the `## Scripts` section and add:

```md
- [scripts/audit-recovery-intelligence.mjs](scripts/audit-recovery-intelligence.mjs) — verifies the `RecoveryIntelligencePayload` composer outputs match raw queries for the target user. Set `AUDIT_USER_ID`. Run via: `AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-recovery-intelligence.mjs`.
```

- [ ] **Step 4: Commit**

```bash
git add scripts/audit-recovery-intelligence.mjs CLAUDE.md
git commit -m "feat(remi): audit-recovery-intelligence script + docs"
```

---

## Plan 1 complete

`/health?tab=trends` ships with 17 cards. Migration 0031 is live, WHOOP sync populates the new columns, composers feed a typed payload, sections render. Audit script verifies composer correctness.

**Next:** Plan 2 (`docs/superpowers/plans/2026-05-24-remi-recovery-intelligence-triggers-prompt.md`) adds the 13 proactive triggers + the `REMI_BASE` prompt expansion. Plan 2 reuses `RecoveryIntelligencePayload` from Plan 1.
