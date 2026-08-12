# Fused Strain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Edwards-TRIMP strain derivation with a fused number that sums baseline HR load, per-activity HR load, and logger mechanical load through one saturating curve, so `daily_logs.strain` rises on hard training days by any modality.

**Architecture:** Pure compute modules under `lib/coach/strain/` produce a day's load from three independent terms; `recomputeStrainForDay` is the single writer of `daily_logs.strain`, called from the Garmin ingest and both logger session routes. A new `garmin_activities` table stores per-activity HR streams fetched by the sidecar. Constants are fitted once against a frozen fixture of 61 labelled April–May days and never recomputed at runtime.

**Tech Stack:** Next.js 15 App Router, TypeScript strict, Supabase (Postgres + RLS), vitest (node environment), Python 3 sidecar via `python-garminconnect`.

**Spec:** [docs/superpowers/specs/2026-08-12-fused-strain-design.md](../specs/2026-08-12-fused-strain-design.md)

## Global Constraints

- Branch `feat/fused-strain` already exists and is checked out. Do not commit to `main`.
- Migration slot is **0058**. Version prefixes must be unique and uniform-width.
- Verify with `npm run typecheck` and `npx vitest run`. `npm run lint` is a no-op — do not use it.
- vitest is **node-environment** and scans `lib/**/__tests__/**/*.test.ts` only. All logic goes in `lib/`, never in `.tsx`.
- Path alias `@/*` → repo root. Use it instead of relative climbs.
- User-visible numbers use `fmtNum()` from `lib/ui/score.ts`. This plan produces no user-visible numbers directly.
- Never call `new Date().toISOString().slice(0, 10)` or `d.getHours()`. Day attribution uses `profiles.timezone` via `getUserTimezone(userId)` and helpers from `lib/time.ts`.
- Scripts run as: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/<name>.mjs`
- Sidecar stays derivation-free: it fetches and POSTs raw data, the app computes.
- `activityTrainingLoad` / `aerobicTrainingEffect` / `anaerobicTrainingEffect` are stored as metadata and **never used as model inputs**.

### Deviation from the spec, approved at plan time

The spec says `banisterTrimp` is "reused unchanged; only the caller changes." That is not achievable for the baseline term: excluding an activity window from a 2-minute sample stream leaves a 50-minute gap, and `banisterTrimp`'s existing `g > 0 && g < 60` guard would score that gap as 50 minutes at the pre-activity heart rate. Task 3 therefore adds `banisterOverIntervals` in the strain module, which reduces to the same arithmetic as `banisterTrimp` when no windows are excluded. `banisterTrimp` in `derive-strain.ts` stays untouched and continues to feed the `garmin_daily.trimp_banister` shadow column.

---

## File Structure

**Created:**

| path | responsibility |
|---|---|
| `supabase/migrations/0058_fused_strain.sql` | `garmin_activities` table, `daily_logs.hr_sample_density` |
| `lib/coach/strain/types.ts` | shared input/output shapes |
| `lib/coach/strain/constants.ts` | frozen fit constants + device→HR-source map |
| `lib/coach/strain/trimp.ts` | `banisterOverIntervals` — the one TRIMP walk |
| `lib/coach/strain/activity-load.ts` | one activity's HR stream → TRIMP |
| `lib/coach/strain/baseline-load.ts` | all-day HR minus activity windows → TRIMP |
| `lib/coach/strain/mechanical-load.ts` | logger working sets → tonnage-equivalent |
| `lib/coach/strain/match-sessions.ts` | activity↔workout matching + cross-device dedup |
| `lib/coach/strain/compose.ts` | sum → log map → clamp |
| `lib/coach/strain/index.ts` | barrel |
| `lib/coach/strain/recompute.ts` | `recomputeStrainForDay` — single writer |
| `lib/coach/strain/__tests__/*.test.ts` | unit tests per module |
| `scripts/backfill-garmin-activities.mjs` | fetch + store historical activities |
| `scripts/freeze-strain-calibration.mjs` | write the labelled fixture |
| `scripts/fit-strain-constants.mjs` | refit under the three-term form |
| `scripts/backfill-fused-strain.mjs` | recompute `daily_logs.strain` |
| `scripts/audit-strain-calibration.mjs` | fixture replay, RMSE gate |
| `scripts/audit-strain-recompute.mjs` | stored vs fresh recompute |
| `scripts/fixtures/strain-calibration-2026.json` | 61 labelled days |

**Modified:**

| path | change |
|---|---|
| `lib/data/types.ts` | `GarminActivityRow`, `hr_sample_density` on `DailyLog` |
| `sidecar/garmin/collector.py` | activity pass |
| `app/api/ingest/garmin/route.ts` | `activities` schema, upsert, recompute call |
| `app/api/logger/session/route.ts` | non-fatal recompute hook |
| `app/api/logger/session/[workout_id]/route.ts` | non-fatal recompute hook |
| `CLAUDE.md` | migration 0058 entry, strain ownership |

---

## Task 1: Migration 0058 and row types

**Files:**
- Create: `supabase/migrations/0058_fused_strain.sql`
- Modify: `lib/data/types.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: table `public.garmin_activities`; column `public.daily_logs.hr_sample_density`; TS types `GarminActivityRow`, and `hr_sample_density: number | null` on `DailyLog`.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0058_fused_strain.sql`:

```sql
-- 0058_fused_strain.sql
--
-- Per-activity heart-rate records, and the sampling-density marker that makes
-- a sensor change visible instead of silent.
--
-- Why a new table rather than endurance_activities: that table is Strava-owned
-- with hrTSS semantics and feeds daily_logs.endurance_*. Folding Garmin rows in
-- would double-count every ride present in both services and change what the
-- endurance pillar reads.
--
-- hr_samples holds the raw [[epoch_ms, bpm]] stream. Storing it is deliberate:
-- recalibrating the strain model later must not require re-fetching years of
-- history through an unofficial API.

create table if not exists public.garmin_activities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  external_id text not null,
  local_date date not null,
  activity_type text,
  started_at timestamptz not null,
  duration_s int not null,
  avg_hr numeric,
  max_hr numeric,
  device_id text,
  hr_source text not null default 'unknown'
    check (hr_source in ('wrist', 'arm', 'chest', 'unknown')),
  hr_sample_count int not null default 0,
  hr_median_gap_s numeric,
  zone_seconds jsonb,
  garmin_load numeric,
  aerobic_te numeric,
  anaerobic_te numeric,
  body_battery_diff numeric,
  trimp numeric,
  hr_samples jsonb,
  superseded_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, external_id)
);

create index if not exists garmin_activities_user_date_idx
  on public.garmin_activities (user_id, local_date);

comment on column public.garmin_activities.superseded_by is
  'external_id of the activity that won cross-device dedup. Non-null rows are excluded from strain computation but retained for audit.';
comment on column public.garmin_activities.garmin_load is
  'Garmin activityTrainingLoad. Metadata only — never a strain model input; it fit WHOOP labels worse than our own TRIMP.';

alter table public.garmin_activities enable row level security;

create policy "garmin_activities self select" on public.garmin_activities
  for select using (auth.uid() = user_id);
create policy "garmin_activities self insert" on public.garmin_activities
  for insert with check (auth.uid() = user_id);
create policy "garmin_activities self update" on public.garmin_activities
  for update using (auth.uid() = user_id);
create policy "garmin_activities self delete" on public.garmin_activities
  for delete using (auth.uid() = user_id);

-- Median gap between all-day HR samples, in seconds. Records what the ingest
-- actually received so a device swap shows up as an annotation rather than a
-- phantom fitness change.
alter table public.daily_logs add column if not exists hr_sample_density numeric;

comment on column public.daily_logs.hr_sample_density is
  'Median gap between all-day HR samples in seconds (120 for the Fenix wellness stream). NULL when no HR arrived that day.';
```

- [ ] **Step 2: Apply the migration**

Run: `supabase db push`
Expected: `0058_fused_strain.sql` applies with no error. If the CLI reports drift, stop and report — do not hand-edit remote state.

- [ ] **Step 3: Add the row types**

In `lib/data/types.ts`, add `hr_sample_density: number | null;` to the `DailyLog` type, and add:

```ts
/** One Garmin-recorded activity. Mirrors public.garmin_activities.
 *  `hr_samples` is the raw [[epoch_ms, bpm]] stream; `trimp` is the derived
 *  Banister value. `garmin_load` / `aerobic_te` / `anaerobic_te` are metadata
 *  only and are never model inputs. */
export type GarminActivityRow = {
  id: string;
  user_id: string;
  external_id: string;
  local_date: string;
  activity_type: string | null;
  started_at: string;
  duration_s: number;
  avg_hr: number | null;
  max_hr: number | null;
  device_id: string | null;
  hr_source: "wrist" | "arm" | "chest" | "unknown";
  hr_sample_count: number;
  hr_median_gap_s: number | null;
  zone_seconds: Record<string, number> | null;
  garmin_load: number | null;
  aerobic_te: number | null;
  anaerobic_te: number | null;
  body_battery_diff: number | null;
  trimp: number | null;
  hr_samples: Array<[number, number]> | null;
  superseded_by: string | null;
  created_at: string;
  updated_at: string;
};
```

- [ ] **Step 4: Verify types compile**

Run: `npm run typecheck`
Expected: exit 0. If `DailyLog` is constructed literally anywhere without the new field, TypeScript will point at it — add `hr_sample_density: null` at those sites.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0058_fused_strain.sql lib/data/types.ts
git commit -m "feat(strain): add garmin_activities table and hr_sample_density"
```

---

## Task 2: Constants and the composing curve

**Files:**
- Create: `lib/coach/strain/types.ts`, `lib/coach/strain/constants.ts`, `lib/coach/strain/compose.ts`
- Test: `lib/coach/strain/__tests__/compose.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `STRAIN_CALIBRATION: {A, k, w, mechanicalNorm}`, `DEVICE_HR_SOURCE: Record<string, HrSource>`, `MAX_INTERVAL_MIN`, `type HrSample = { ts: number; bpm: number }`, `type HrSource`, `type DayLoad = { baseline: number; activity: number; mechanical: number }`, `composeStrain(load: DayLoad): number`.

- [ ] **Step 1: Write the failing test**

Create `lib/coach/strain/__tests__/compose.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { composeStrain } from "@/lib/coach/strain/compose";
import { STRAIN_CALIBRATION } from "@/lib/coach/strain/constants";

describe("composeStrain", () => {
  it("returns 0 for a day with no load at all", () => {
    expect(composeStrain({ baseline: 0, activity: 0, mechanical: 0 })).toBe(0);
  });

  it("is monotonic in every term", () => {
    const base = { baseline: 10, activity: 10, mechanical: 1000 };
    expect(composeStrain({ ...base, baseline: 20 })).toBeGreaterThan(composeStrain(base));
    expect(composeStrain({ ...base, activity: 20 })).toBeGreaterThan(composeStrain(base));
    expect(composeStrain({ ...base, mechanical: 2000 })).toBeGreaterThan(composeStrain(base));
  });

  it("clamps at 21 for absurd load", () => {
    expect(composeStrain({ baseline: 0, activity: 1e9, mechanical: 0 })).toBe(21);
  });

  it("weights mechanical load by w — 126 kg of tonnage ≈ 1 TRIMP", () => {
    const viaCardio = composeStrain({ baseline: 0, activity: 10, mechanical: 0 });
    const viaTonnage = composeStrain({ baseline: 0, activity: 0, mechanical: 10 / STRAIN_CALIBRATION.w });
    expect(viaTonnage).toBeCloseTo(viaCardio, 6);
  });

  it("applies the curve as A·ln(1+k·load)", () => {
    const { A, k, w } = STRAIN_CALIBRATION;
    const load = 12 + 60 + w * 8000;
    expect(composeStrain({ baseline: 12, activity: 60, mechanical: 8000 })).toBeCloseTo(
      A * Math.log(1 + k * load),
      9,
    );
  });

  it("never returns a negative number for negative-ish input", () => {
    expect(composeStrain({ baseline: -5, activity: 0, mechanical: 0 })).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/coach/strain/__tests__/compose.test.ts`
Expected: FAIL — cannot resolve `@/lib/coach/strain/compose`.

- [ ] **Step 3: Write types, constants and compose**

Create `lib/coach/strain/types.ts`:

```ts
/** One heart-rate reading. ts is epoch milliseconds. */
export type HrSample = { ts: number; bpm: number };

/** Where an activity's heart rate was measured. Resolved from a hand-maintained
 *  device map, never inferred from the HR signal itself. */
export type HrSource = "wrist" | "arm" | "chest" | "unknown";

/** A half-open wall-clock window [startMs, endMs). */
export type TimeWindow = { startMs: number; endMs: number };

/** The three load terms for one day, before the curve. `mechanical` is in
 *  tonnage-equivalent kilograms; the other two are TRIMP units. */
export type DayLoad = {
  baseline: number;
  activity: number;
  mechanical: number;
};
```

Create `lib/coach/strain/constants.ts`:

```ts
import type { HrSource } from "./types";

/** Fitted strain constants.
 *
 *  PROVISIONAL — fitted 2026-08-12 under a TWO-term form in which baseline was a
 *  fixed +3.5 strain constant rather than a load term:
 *
 *    strain = 3.5 + 4.5·ln(1 + 0.0706·(activity_trimp + 0.00795·mechanical))
 *
 *  RMSE 1.56 over 61 labelled April–May 2026 days. Superseded by
 *  scripts/fit-strain-constants.mjs once scripts/fixtures/strain-calibration-2026.json
 *  carries baseline HR for the calibration window (see the plan's Task 13).
 *
 *  `w` converts tonnage-equivalent kilograms into TRIMP units: 1 TRIMP ≈ 126 kg.
 *  `mechanicalNorm` rescales the muscle/intensity/RIR-weighted sum back onto the
 *  raw-tonnage scale the fit was performed on. 1 until the refit computes it. */
export const STRAIN_CALIBRATION = {
  A: 4.5,
  k: 0.0706,
  w: 0.00795,
  mechanicalNorm: 1,
} as const;

/** Longest interval a single pair of HR samples may contribute, in minutes.
 *  Guards against off-wrist gaps being scored at the last-seen heart rate. */
export const MAX_INTERVAL_MIN = 10;

/** Hand-maintained device → sensor map. Garmin does not report sensor type on
 *  the activity record, so this is edited when hardware changes rather than
 *  inferred from HR characteristics — an inferred value would be a guess
 *  presented as a measurement.
 *
 *  3491966227 — Fenix 8. Currently wrist optical; becomes 'chest' when the
 *  HRM strap is paired for cardio. A CIRQA arm band gets its own entry ('arm')
 *  when its deviceId is first seen in ingest. */
export const DEVICE_HR_SOURCE: Record<string, HrSource> = {
  "3491966227": "wrist",
};

/** Preference order for cross-device dedup: a better sensor wins. */
export const HR_SOURCE_RANK: Record<HrSource, number> = {
  chest: 0,
  arm: 1,
  wrist: 2,
  unknown: 3,
};
```

Create `lib/coach/strain/compose.ts`:

```ts
import { STRAIN_CALIBRATION } from "./constants";
import type { DayLoad } from "./types";

/** Sum the three load terms and map them onto the 0–21 scale.
 *
 *  One saturating curve over the summed load — not three curves summed — so
 *  that a day built from many small contributions and a day built from one
 *  large one score alike. */
export function composeStrain(load: DayLoad): number {
  const { A, k, w } = STRAIN_CALIBRATION;
  const total =
    Math.max(0, load.baseline) +
    Math.max(0, load.activity) +
    w * Math.max(0, load.mechanical);
  if (total <= 0) return 0;
  return Math.min(21, A * Math.log(1 + k * total));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/coach/strain/__tests__/compose.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/coach/strain/types.ts lib/coach/strain/constants.ts lib/coach/strain/compose.ts lib/coach/strain/__tests__/compose.test.ts
git commit -m "feat(strain): compose curve and provisional calibration constants"
```

---

## Task 3: The TRIMP walk

**Files:**
- Create: `lib/coach/strain/trimp.ts`
- Test: `lib/coach/strain/__tests__/trimp.test.ts`

**Interfaces:**
- Consumes: `HrSample`, `TimeWindow`, `MAX_INTERVAL_MIN` from Task 2.
- Produces: `banisterOverIntervals(samples: HrSample[], hrRest: number, hrMax: number, skipWindows?: TimeWindow[]): number` and `medianGapSeconds(samples: HrSample[]): number | null`.

- [ ] **Step 1: Write the failing test**

Create `lib/coach/strain/__tests__/trimp.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { banisterOverIntervals, medianGapSeconds } from "@/lib/coach/strain/trimp";
import type { HrSample } from "@/lib/coach/strain/types";

/** n samples at `bpm`, spaced `gapS` seconds apart, starting at t0. */
function stream(n: number, bpm: number, gapS: number, t0 = 0): HrSample[] {
  return Array.from({ length: n }, (_, i) => ({ ts: t0 + i * gapS * 1000, bpm }));
}

describe("banisterOverIntervals", () => {
  it("returns 0 for fewer than two samples", () => {
    expect(banisterOverIntervals([], 50, 183)).toBe(0);
    expect(banisterOverIntervals([{ ts: 0, bpm: 150 }], 50, 183)).toBe(0);
  });

  it("returns 0 when the reserve is degenerate", () => {
    expect(banisterOverIntervals(stream(10, 150, 60), 183, 183)).toBe(0);
  });

  it("scores a resting stream at zero — HRr clamps at 0", () => {
    expect(banisterOverIntervals(stream(31, 45, 120), 50, 183)).toBe(0);
  });

  it("matches the Banister formula on a single interval", () => {
    const hrr = (150 - 50) / (183 - 50);
    const expected = 2 * hrr * (0.64 * Math.exp(1.92 * hrr));
    const samples: HrSample[] = [
      { ts: 0, bpm: 150 },
      { ts: 120_000, bpm: 150 },
    ];
    expect(banisterOverIntervals(samples, 50, 183)).toBeCloseTo(expected, 9);
  });

  it("clamps a long off-wrist gap to MAX_INTERVAL_MIN", () => {
    const short: HrSample[] = [
      { ts: 0, bpm: 150 },
      { ts: 10 * 60_000, bpm: 150 },
    ];
    const long: HrSample[] = [
      { ts: 0, bpm: 150 },
      { ts: 6 * 60 * 60_000, bpm: 150 },
    ];
    expect(banisterOverIntervals(long, 50, 183)).toBeCloseTo(
      banisterOverIntervals(short, 50, 183),
      9,
    );
  });

  it("uses the leading sample's HR for each interval", () => {
    const rising: HrSample[] = [
      { ts: 0, bpm: 100 },
      { ts: 60_000, bpm: 180 },
    ];
    const hrr = (100 - 50) / (183 - 50);
    expect(banisterOverIntervals(rising, 50, 183)).toBeCloseTo(
      1 * hrr * (0.64 * Math.exp(1.92 * hrr)),
      9,
    );
  });

  it("skips intervals inside an excluded window entirely", () => {
    // 60 samples 1 min apart, all at 150. Exclude minutes 20-40.
    const s = stream(61, 150, 60);
    const all = banisterOverIntervals(s, 50, 183);
    const excluded = banisterOverIntervals(s, 50, 183, [
      { startMs: 20 * 60_000, endMs: 40 * 60_000 },
    ]);
    expect(excluded).toBeLessThan(all);
    expect(excluded).toBeCloseTo(all * (40 / 60), 6);
  });

  it("does NOT credit the excluded span as one long interval", () => {
    // The bug this function exists to prevent: filtering samples first would
    // leave a 20-minute gap scored at the pre-window heart rate.
    const s = stream(61, 150, 60);
    const excluded = banisterOverIntervals(s, 50, 183, [
      { startMs: 20 * 60_000, endMs: 40 * 60_000 },
    ]);
    const naive = banisterOverIntervals(
      s.filter((x) => x.ts < 20 * 60_000 || x.ts >= 40 * 60_000),
      50,
      183,
    );
    expect(excluded).toBeLessThan(naive);
  });

  it("reduces to a plain walk when no windows are given", () => {
    const s = stream(20, 140, 120);
    expect(banisterOverIntervals(s, 50, 183, [])).toBeCloseTo(
      banisterOverIntervals(s, 50, 183),
      9,
    );
  });
});

describe("medianGapSeconds", () => {
  it("returns null for fewer than two samples", () => {
    expect(medianGapSeconds([])).toBeNull();
    expect(medianGapSeconds([{ ts: 0, bpm: 60 }])).toBeNull();
  });

  it("reports 120 for the Fenix all-day wellness stream", () => {
    expect(medianGapSeconds(stream(720, 65, 120))).toBe(120);
  });

  it("reports 1 for a 1-second activity stream", () => {
    expect(medianGapSeconds(stream(600, 130, 1))).toBe(1);
  });

  it("is unmoved by a single huge outlier gap", () => {
    const s = [...stream(50, 65, 120), { ts: 50 * 120_000 + 8 * 3600_000, bpm: 65 }];
    expect(medianGapSeconds(s)).toBe(120);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/coach/strain/__tests__/trimp.test.ts`
Expected: FAIL — cannot resolve `@/lib/coach/strain/trimp`.

- [ ] **Step 3: Write the implementation**

Create `lib/coach/strain/trimp.ts`:

```ts
import { MAX_INTERVAL_MIN } from "./constants";
import type { HrSample, TimeWindow } from "./types";

/** Banister TRIMP (men's coefficients) walked over consecutive sample pairs.
 *
 *  Σ minutes × HRr × 0.64·e^(1.92·HRr),  HRr = (bpm − hrRest)/(hrMax − hrRest)
 *
 *  Two behaviours the plain `banisterTrimp` in lib/coach/garmin/derive-strain.ts
 *  cannot provide, and the reason this function exists:
 *
 *  1. `skipWindows` drops an interval whose span overlaps an excluded window
 *     rather than filtering the samples. Filtering would leave one long gap
 *     that scores the whole excluded span at the pre-window heart rate — a
 *     50-minute session credited at desk-work HR on top of its own activity
 *     stream, which is exactly the double-count this guards.
 *  2. Long intervals are CLAMPED to MAX_INTERVAL_MIN rather than replaced with
 *     a median. An off-wrist gap is unknown time, not typical time.
 *
 *  With no windows and no long gaps it is arithmetically identical to
 *  `banisterTrimp`. Samples must be sorted by `ts`. */
export function banisterOverIntervals(
  samples: HrSample[],
  hrRest: number,
  hrMax: number,
  skipWindows: TimeWindow[] = [],
): number {
  if (samples.length < 2) return 0;
  const reserve = hrMax - hrRest;
  if (reserve <= 0) return 0;

  let trimp = 0;
  for (let i = 0; i < samples.length - 1; i++) {
    const startMs = samples[i].ts;
    const endMs = samples[i + 1].ts;
    if (endMs <= startMs) continue;
    if (skipWindows.some((wnd) => startMs < wnd.endMs && endMs > wnd.startMs)) continue;

    const minutes = Math.min((endMs - startMs) / 60_000, MAX_INTERVAL_MIN);
    let hrr = (samples[i].bpm - hrRest) / reserve;
    if (hrr < 0) hrr = 0;
    if (hrr > 1) hrr = 1;
    trimp += minutes * hrr * (0.64 * Math.exp(1.92 * hrr));
  }
  return trimp;
}

/** Median gap between consecutive samples, in seconds. Null for a stream too
 *  short to have one. Reported to daily_logs.hr_sample_density so a device swap
 *  is recorded rather than inferred. Median, not mean, so overnight charging
 *  gaps do not move it. */
export function medianGapSeconds(samples: HrSample[]): number | null {
  if (samples.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const g = (samples[i].ts - samples[i - 1].ts) / 1000;
    if (g > 0) gaps.push(g);
  }
  if (gaps.length === 0) return null;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/coach/strain/__tests__/trimp.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/coach/strain/trimp.ts lib/coach/strain/__tests__/trimp.test.ts
git commit -m "feat(strain): window-aware Banister TRIMP walk"
```

---

## Task 4: Activity load

**Files:**
- Create: `lib/coach/strain/activity-load.ts`
- Test: `lib/coach/strain/__tests__/activity-load.test.ts`

**Interfaces:**
- Consumes: `banisterOverIntervals`, `medianGapSeconds` (Task 3); `HrSample`, `TimeWindow`, `HrSource` (Task 2); `DEVICE_HR_SOURCE` (Task 2).
- Produces:
  - `type ActivityInput = { external_id: string; started_at: string; duration_s: number; device_id: string | null; hr_samples: Array<[number, number]> | null; activity_type: string | null }`
  - `activityWindow(a: ActivityInput): TimeWindow`
  - `activityTrimp(a: ActivityInput, hrRest: number, hrMax: number): number`
  - `resolveHrSource(deviceId: string | null): HrSource`
  - `toHrSamples(raw: Array<[number, number]> | null): HrSample[]`

- [ ] **Step 1: Write the failing test**

Create `lib/coach/strain/__tests__/activity-load.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  activityWindow,
  activityTrimp,
  resolveHrSource,
  toHrSamples,
  type ActivityInput,
} from "@/lib/coach/strain/activity-load";
import { banisterOverIntervals } from "@/lib/coach/strain/trimp";

const T0 = Date.parse("2026-08-11T08:52:48.000Z");

function mkActivity(over: Partial<ActivityInput> = {}): ActivityInput {
  return {
    external_id: "23933506849",
    started_at: new Date(T0).toISOString(),
    duration_s: 3016,
    device_id: "3491966227",
    activity_type: "strength_training",
    hr_samples: Array.from({ length: 3017 }, (_, i) => [T0 + i * 1000, 98] as [number, number]),
    ...over,
  };
}

describe("activityWindow", () => {
  it("spans started_at through started_at + duration", () => {
    const w = activityWindow(mkActivity());
    expect(w.startMs).toBe(T0);
    expect(w.endMs).toBe(T0 + 3016 * 1000);
  });

  it("never produces an inverted window for a zero-duration record", () => {
    const w = activityWindow(mkActivity({ duration_s: 0 }));
    expect(w.endMs).toBeGreaterThanOrEqual(w.startMs);
  });
});

describe("activityTrimp", () => {
  it("returns 0 when the activity carries no HR stream", () => {
    expect(activityTrimp(mkActivity({ hr_samples: null }), 50, 183)).toBe(0);
    expect(activityTrimp(mkActivity({ hr_samples: [] }), 50, 183)).toBe(0);
  });

  it("equals a direct Banister walk over its samples", () => {
    const a = mkActivity();
    expect(activityTrimp(a, 50, 183)).toBeCloseTo(
      banisterOverIntervals(toHrSamples(a.hr_samples), 50, 183),
      9,
    );
  });

  it("scores a hard session above an easy one of equal length", () => {
    const easy = mkActivity({
      hr_samples: Array.from({ length: 1801 }, (_, i) => [T0 + i * 1000, 95] as [number, number]),
    });
    const hard = mkActivity({
      hr_samples: Array.from({ length: 1801 }, (_, i) => [T0 + i * 1000, 150] as [number, number]),
    });
    expect(activityTrimp(hard, 50, 183)).toBeGreaterThan(activityTrimp(easy, 50, 183));
  });

  it("captures a spike that 2-minute sampling would alias away", () => {
    // 30 min: 150 bpm for 40 s of every 3 min, 75 bpm otherwise — a lifting set
    // pattern. Sampled at 1 s it registers; sampled every 2 min it may not.
    const dense: Array<[number, number]> = [];
    for (let s = 0; s <= 1800; s++) {
      const phase = s % 180;
      dense.push([T0 + s * 1000, phase < 40 ? 150 : 75]);
    }
    const sparse = dense.filter((_, i) => i % 120 === 60); // samples land in the rest phase
    const denseTrimp = activityTrimp(mkActivity({ hr_samples: dense }), 50, 183);
    const sparseTrimp = activityTrimp(mkActivity({ hr_samples: sparse }), 50, 183);
    expect(denseTrimp).toBeGreaterThan(sparseTrimp);
  });
});

describe("resolveHrSource", () => {
  it("maps a known device", () => {
    expect(resolveHrSource("3491966227")).toBe("wrist");
  });

  it("returns unknown for an unmapped or absent device", () => {
    expect(resolveHrSource("999999")).toBe("unknown");
    expect(resolveHrSource(null)).toBe("unknown");
  });
});

describe("toHrSamples", () => {
  it("returns an empty array for null", () => {
    expect(toHrSamples(null)).toEqual([]);
  });

  it("drops pairs with a null or non-finite bpm", () => {
    const raw = [
      [1000, 60],
      [2000, null],
      [3000, 70],
    ] as unknown as Array<[number, number]>;
    expect(toHrSamples(raw)).toEqual([
      { ts: 1000, bpm: 60 },
      { ts: 3000, bpm: 70 },
    ]);
  });

  it("sorts by timestamp", () => {
    const raw: Array<[number, number]> = [
      [3000, 70],
      [1000, 60],
    ];
    expect(toHrSamples(raw).map((s) => s.ts)).toEqual([1000, 3000]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/coach/strain/__tests__/activity-load.test.ts`
Expected: FAIL — cannot resolve `@/lib/coach/strain/activity-load`.

- [ ] **Step 3: Write the implementation**

Create `lib/coach/strain/activity-load.ts`:

```ts
import { DEVICE_HR_SOURCE } from "./constants";
import { banisterOverIntervals } from "./trimp";
import type { HrSample, HrSource, TimeWindow } from "./types";

/** The subset of a garmin_activities row the load math needs. */
export type ActivityInput = {
  external_id: string;
  started_at: string;
  duration_s: number;
  device_id: string | null;
  hr_samples: Array<[number, number]> | null;
  activity_type: string | null;
};

/** Raw [[ts, bpm]] pairs → sorted, validated samples. Garmin emits nulls for
 *  off-wrist moments inside an activity; they are dropped rather than
 *  interpolated, and the resulting gap is handled by the interval clamp. */
export function toHrSamples(raw: Array<[number, number]> | null): HrSample[] {
  if (!raw) return [];
  const out: HrSample[] = [];
  for (const pair of raw) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const [ts, bpm] = pair;
    if (!Number.isFinite(ts) || !Number.isFinite(bpm)) continue;
    out.push({ ts, bpm });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

/** The wall-clock span this activity occupied. Used both to score it and to
 *  cut it out of the baseline term. */
export function activityWindow(a: ActivityInput): TimeWindow {
  const startMs = Date.parse(a.started_at);
  return { startMs, endMs: startMs + Math.max(0, a.duration_s) * 1000 };
}

/** Banister TRIMP over the activity's own HR stream, at whatever density the
 *  device recorded. Zero when no stream arrived — the baseline term still
 *  covers the span in that case, because match-sessions only excludes windows
 *  for activities that are actually being scored here. */
export function activityTrimp(a: ActivityInput, hrRest: number, hrMax: number): number {
  return banisterOverIntervals(toHrSamples(a.hr_samples), hrRest, hrMax);
}

/** Sensor behind an activity's HR, from the hand-maintained device map.
 *  Unknown devices resolve to 'unknown' and rank last in dedup — never guessed
 *  from the signal. */
export function resolveHrSource(deviceId: string | null): HrSource {
  if (!deviceId) return "unknown";
  return DEVICE_HR_SOURCE[deviceId] ?? "unknown";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/coach/strain/__tests__/activity-load.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/coach/strain/activity-load.ts lib/coach/strain/__tests__/activity-load.test.ts
git commit -m "feat(strain): per-activity TRIMP and HR source resolution"
```

---

## Task 5: Baseline load

**Files:**
- Create: `lib/coach/strain/baseline-load.ts`
- Test: `lib/coach/strain/__tests__/baseline-load.test.ts`

**Interfaces:**
- Consumes: `banisterOverIntervals` (Task 3), `activityWindow` (Task 4), `HrSample`, `TimeWindow` (Task 2).
- Produces: `baselineTrimp(allDay: HrSample[], excluded: TimeWindow[], hrRest: number, hrMax: number): number`.

- [ ] **Step 1: Write the failing test**

Create `lib/coach/strain/__tests__/baseline-load.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { baselineTrimp } from "@/lib/coach/strain/baseline-load";
import type { HrSample } from "@/lib/coach/strain/types";

/** A day of 2-minute samples at `bpm`, starting at midnight epoch 0. */
function allDay(bpm: number, n = 720): HrSample[] {
  return Array.from({ length: n }, (_, i) => ({ ts: i * 120_000, bpm }));
}

describe("baselineTrimp", () => {
  it("is 0 for an empty stream", () => {
    expect(baselineTrimp([], [], 50, 183)).toBe(0);
  });

  it("scores an ordinary living day above zero — the Edwards floor is gone", () => {
    // 65 bpm sits under 50% of HRmax 183 (91.5) and scored exactly 0 under
    // Edwards. This is the regression that motivated the whole change.
    expect(baselineTrimp(allDay(65), [], 50, 183)).toBeGreaterThan(0);
  });

  it("scores a busier day above a quieter one", () => {
    expect(baselineTrimp(allDay(80), [], 50, 183)).toBeGreaterThan(
      baselineTrimp(allDay(60), [], 50, 183),
    );
  });

  it("excludes an activity window from the total", () => {
    const full = baselineTrimp(allDay(80), [], 50, 183);
    const cut = baselineTrimp(
      allDay(80),
      [{ startMs: 0, endMs: 60 * 60_000 }],
      50,
      183,
    );
    expect(cut).toBeLessThan(full);
  });

  it("does not credit the excluded span at the ambient heart rate", () => {
    // A 60-minute exclusion on a flat 80 bpm day should remove ~60 minutes of
    // load, not zero and not more.
    const perMinute = baselineTrimp(allDay(80), [], 50, 183) / (719 * 2);
    const cut = baselineTrimp(
      allDay(80),
      [{ startMs: 0, endMs: 60 * 60_000 }],
      50,
      183,
    );
    const full = baselineTrimp(allDay(80), [], 50, 183);
    expect(full - cut).toBeCloseTo(perMinute * 60, 1);
  });

  it("handles several disjoint exclusion windows", () => {
    const cut = baselineTrimp(
      allDay(80),
      [
        { startMs: 0, endMs: 30 * 60_000 },
        { startMs: 600 * 60_000, endMs: 660 * 60_000 },
      ],
      50,
      183,
    );
    expect(cut).toBeGreaterThan(0);
    expect(cut).toBeLessThan(baselineTrimp(allDay(80), [], 50, 183));
  });

  it("returns 0 when every interval is excluded", () => {
    expect(
      baselineTrimp(allDay(80), [{ startMs: -1, endMs: 720 * 120_000 + 1 }], 50, 183),
    ).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/coach/strain/__tests__/baseline-load.test.ts`
Expected: FAIL — cannot resolve `@/lib/coach/strain/baseline-load`.

- [ ] **Step 3: Write the implementation**

Create `lib/coach/strain/baseline-load.ts`:

```ts
import { banisterOverIntervals } from "./trimp";
import type { HrSample, TimeWindow } from "./types";

/** Load from ordinary living: the all-day HR stream with every scored
 *  activity's window cut out.
 *
 *  The exclusion is what makes the three terms additive without double-counting
 *  — the all-day stream and an activity stream cover the same wall-clock during
 *  a session, and summing both unmodified would count that hour twice.
 *
 *  Windows are only passed here for activities whose own HR is being scored in
 *  the activity term. An activity that arrived without a stream is deliberately
 *  left in the baseline, where its coarse 2-minute samples are better than
 *  nothing. */
export function baselineTrimp(
  allDay: HrSample[],
  excluded: TimeWindow[],
  hrRest: number,
  hrMax: number,
): number {
  return banisterOverIntervals(allDay, hrRest, hrMax, excluded);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/coach/strain/__tests__/baseline-load.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/coach/strain/baseline-load.ts lib/coach/strain/__tests__/baseline-load.test.ts
git commit -m "feat(strain): baseline load with activity windows excluded"
```

---

## Task 6: Mechanical load

**Files:**
- Create: `lib/coach/strain/mechanical-load.ts`
- Test: `lib/coach/strain/__tests__/mechanical-load.test.ts`

**Interfaces:**
- Consumes: `STRAIN_CALIBRATION.mechanicalNorm` (Task 2); `getExerciseMuscles` from `@/lib/coach/exercise-muscles`.
- Produces:
  - `type MechanicalSet = { kg: number | null; reps: number | null; warmup: boolean; rir: number | null }`
  - `type MechanicalExercise = { name: string; sets: MechanicalSet[]; e1rm: number | null }`
  - `rawTonnage(exercises: MechanicalExercise[]): number`
  - `muscleFactor(name: string): number`
  - `intensityFactor(kg: number, e1rm: number | null): number`
  - `rirFactor(rir: number | null, rirTarget: number | null): number`
  - `mechanicalLoad(exercises: MechanicalExercise[], rirTarget: number | null): number`

- [ ] **Step 1: Write the failing test**

Create `lib/coach/strain/__tests__/mechanical-load.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  rawTonnage,
  muscleFactor,
  intensityFactor,
  rirFactor,
  mechanicalLoad,
  type MechanicalExercise,
} from "@/lib/coach/strain/mechanical-load";

function ex(
  name: string,
  sets: Array<{ kg: number; reps: number; warmup?: boolean; rir?: number | null }>,
  e1rm: number | null = null,
): MechanicalExercise {
  return {
    name,
    e1rm,
    sets: sets.map((s) => ({
      kg: s.kg,
      reps: s.reps,
      warmup: s.warmup ?? false,
      rir: s.rir ?? null,
    })),
  };
}

describe("rawTonnage", () => {
  it("sums kg × reps over working sets", () => {
    expect(rawTonnage([ex("Squat (Barbell)", [{ kg: 100, reps: 5 }, { kg: 100, reps: 5 }])])).toBe(1000);
  });

  it("excludes warmup sets — the fit was performed on working sets only", () => {
    expect(
      rawTonnage([ex("Squat (Barbell)", [{ kg: 60, reps: 5, warmup: true }, { kg: 100, reps: 5 }])]),
    ).toBe(500);
  });

  it("treats null kg or reps as zero rather than throwing", () => {
    const e: MechanicalExercise = {
      name: "Plank",
      e1rm: null,
      sets: [{ kg: null, reps: null, warmup: false, rir: null }],
    };
    expect(rawTonnage([e])).toBe(0);
  });

  it("is 0 for no exercises", () => {
    expect(rawTonnage([])).toBe(0);
  });
});

describe("muscleFactor", () => {
  it("weights a large-muscle compound above a small-muscle isolation", () => {
    expect(muscleFactor("Deadlift (Barbell)")).toBeGreaterThan(muscleFactor("Bicep Curl (Dumbbell)"));
  });

  it("returns a neutral 1 for an unmapped exercise name", () => {
    expect(muscleFactor("Completely Invented Movement 9000")).toBe(1);
  });

  it("stays inside ±15% so it redistributes rather than rescales", () => {
    for (const n of ["Deadlift (Barbell)", "Bicep Curl (Dumbbell)", "Unknown Thing"]) {
      expect(muscleFactor(n)).toBeGreaterThanOrEqual(0.85);
      expect(muscleFactor(n)).toBeLessThanOrEqual(1.15);
    }
  });
});

describe("intensityFactor", () => {
  it("is neutral when no e1RM history exists", () => {
    expect(intensityFactor(100, null)).toBe(1);
    expect(intensityFactor(100, 0)).toBe(1);
  });

  it("rewards load near the athlete's ceiling", () => {
    expect(intensityFactor(180, 200)).toBeGreaterThan(intensityFactor(80, 200));
  });

  it("floors at 0.85 for light work and caps at 1.15 at the ceiling", () => {
    expect(intensityFactor(20, 200)).toBeCloseTo(0.85, 9);
    expect(intensityFactor(200, 200)).toBeCloseTo(1.15, 9);
  });

  it("is monotonic across the ramp", () => {
    const ratios = [0.5, 0.6, 0.7, 0.8, 0.9];
    const values = ratios.map((r) => intensityFactor(r * 200, 200));
    for (let i = 1; i < values.length; i++) expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]);
  });
});

describe("rirFactor", () => {
  it("is exactly neutral at the block's target — a typical session is unchanged", () => {
    expect(rirFactor(2, 2)).toBe(1);
  });

  it("is neutral when RIR or the target is missing", () => {
    // Pre-migration-0045 sessions carry no RIR. They must score identically to
    // the calibration set, which had none either.
    expect(rirFactor(null, 2)).toBe(1);
    expect(rirFactor(2, null)).toBe(1);
  });

  it("rewards taking a set closer to failure than prescribed", () => {
    expect(rirFactor(0, 2)).toBeGreaterThan(1);
  });

  it("discounts a sandbagged set", () => {
    expect(rirFactor(4, 2)).toBeLessThan(1);
  });

  it("stays inside ±15% — the bound that keeps it uncalibrated-but-safe", () => {
    for (const rir of [0, 1, 2, 3, 4, 8, 10]) {
      expect(rirFactor(rir, 2)).toBeGreaterThanOrEqual(0.85);
      expect(rirFactor(rir, 2)).toBeLessThanOrEqual(1.15);
    }
  });
});

describe("mechanicalLoad", () => {
  it("is 0 for no exercises", () => {
    expect(mechanicalLoad([], 2)).toBe(0);
  });

  it("stays within ±15% of raw tonnage for any single session", () => {
    const session = [
      ex("Deadlift (Barbell)", [{ kg: 140, reps: 5 }, { kg: 140, reps: 5 }], 180),
      ex("Bicep Curl (Dumbbell)", [{ kg: 16, reps: 12 }], 24),
    ];
    const raw = rawTonnage(session);
    const load = mechanicalLoad(session, 2);
    expect(load).toBeGreaterThan(raw * 0.85);
    expect(load).toBeLessThan(raw * 1.15);
  });

  it("ranks a heavy compound session above a light isolation session of equal tonnage", () => {
    const heavy = [ex("Deadlift (Barbell)", [{ kg: 180, reps: 5 }], 200)];
    const light = [ex("Bicep Curl (Dumbbell)", [{ kg: 15, reps: 60 }], 30)];
    expect(rawTonnage(heavy)).toBe(rawTonnage(light));
    expect(mechanicalLoad(heavy, 2)).toBeGreaterThan(mechanicalLoad(light, 2));
  });

  it("ignores warmups", () => {
    const withWarmup = [
      ex("Squat (Barbell)", [{ kg: 60, reps: 5, warmup: true }, { kg: 120, reps: 5 }], 150),
    ];
    const without = [ex("Squat (Barbell)", [{ kg: 120, reps: 5 }], 150)];
    expect(mechanicalLoad(withWarmup, 2)).toBeCloseTo(mechanicalLoad(without, 2), 9);
  });

  it("reduces to raw tonnage when nothing is known — unmapped, no e1RM, no RIR", () => {
    const blind = [ex("Completely Invented Movement 9000", [{ kg: 50, reps: 10 }], null)];
    expect(mechanicalLoad(blind, null)).toBeCloseTo(rawTonnage(blind), 9);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/coach/strain/__tests__/mechanical-load.test.ts`
Expected: FAIL — cannot resolve `@/lib/coach/strain/mechanical-load`.

- [ ] **Step 3: Write the implementation**

Create `lib/coach/strain/mechanical-load.ts`:

```ts
import { getExerciseMuscles, MUSCLE_ID } from "@/lib/coach/exercise-muscles";
import { STRAIN_CALIBRATION } from "./constants";

/** One logged set, reduced to what the mechanical term reads. */
export type MechanicalSet = {
  kg: number | null;
  reps: number | null;
  warmup: boolean;
  rir: number | null;
};

/** One logged exercise plus the athlete's current e1RM for it, when known. */
export type MechanicalExercise = {
  name: string;
  sets: MechanicalSet[];
  e1rm: number | null;
};

/** Muscles whose involvement makes a set systemically expensive. Mirrors the
 *  large/small split used for rest prescription in lib/coach/session-structure. */
const LARGE_MUSCLE_IDS: ReadonlySet<number> = new Set([
  MUSCLE_ID.Chest,
  MUSCLE_ID.Lats,
  MUSCLE_ID.Quads,
  MUSCLE_ID.Hams,
  MUSCLE_ID.Glutes,
  MUSCLE_ID.Traps,
]);

/** All three factors live inside this band. They exist to REDISTRIBUTE load
 *  between exercises and sets, not to rescale the day — the fitted `w` was
 *  derived from raw tonnage, so a factor that moved the aggregate would
 *  silently invalidate it. */
const FACTOR_MIN = 0.85;
const FACTOR_MAX = 1.15;

const clampFactor = (v: number) => Math.min(FACTOR_MAX, Math.max(FACTOR_MIN, v));

/** Σ kg × reps over non-warmup sets. This is the quantity the calibration fit
 *  was performed on and the scale everything below preserves. */
export function rawTonnage(exercises: MechanicalExercise[]): number {
  let total = 0;
  for (const e of exercises) {
    for (const s of e.sets) {
      if (s.warmup) continue;
      total += (s.kg ?? 0) * (s.reps ?? 0);
    }
  }
  return total;
}

/** A deadlift set costs more than a curl set of identical tonnage. Unmapped
 *  names resolve to neutral rather than to either extreme. */
export function muscleFactor(name: string): number {
  const mapping = getExerciseMuscles(name);
  if (!mapping) return 1;
  return mapping.primary.some((id) => LARGE_MUSCLE_IDS.has(id)) ? FACTOR_MAX : FACTOR_MIN;
}

/** Load as a fraction of the exercise's current e1RM, ramped across 50–90%.
 *  Neutral when no e1RM history exists — most accessories, and every exercise
 *  on an athlete's first session. */
export function intensityFactor(kg: number, e1rm: number | null): number {
  if (!e1rm || e1rm <= 0) return 1;
  const ratio = kg / e1rm;
  const ramp = (ratio - 0.5) / 0.4; // 0 at 50%, 1 at 90%
  return clampFactor(FACTOR_MIN + (FACTOR_MAX - FACTOR_MIN) * Math.min(1, Math.max(0, ramp)));
}

/** Proximity to failure relative to what the block prescribed.
 *
 *  Bounded and centred rather than fitted, deliberately: per-set RIR arrived in
 *  migration 0045 (July 2026) and the April–May calibration sessions carry none,
 *  so there is no labelled data to fit a coefficient against. A session at
 *  target scores exactly as it would have without RIR, which is what keeps the
 *  calibration honest. */
export function rirFactor(rir: number | null, rirTarget: number | null): number {
  if (rir === null || rirTarget === null) return 1;
  return clampFactor(1 + ((FACTOR_MAX - 1) * (rirTarget - rir)) / 2);
}

/** Tonnage-equivalent kilograms for a session: raw tonnage redistributed by
 *  muscle mass, relative intensity and proximity to failure, then rescaled by
 *  the frozen `mechanicalNorm` so the aggregate lands back on the raw-tonnage
 *  scale the model was fitted against. */
export function mechanicalLoad(
  exercises: MechanicalExercise[],
  rirTarget: number | null,
): number {
  let total = 0;
  for (const e of exercises) {
    const mFactor = muscleFactor(e.name);
    for (const s of e.sets) {
      if (s.warmup) continue;
      const tonnage = (s.kg ?? 0) * (s.reps ?? 0);
      if (tonnage === 0) continue;
      total +=
        tonnage * mFactor * intensityFactor(s.kg ?? 0, e.e1rm) * rirFactor(s.rir, rirTarget);
    }
  }
  return total * STRAIN_CALIBRATION.mechanicalNorm;
}
```

- [ ] **Step 4: Confirm `MUSCLE_ID` is exported**

Run: `grep -n "export const MUSCLE_ID" lib/coach/exercise-muscles.ts`
Expected: a match. If `MUSCLE_ID` is not exported, add `export` to its declaration in that file and include it in the Step 6 commit.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run lib/coach/strain/__tests__/mechanical-load.test.ts`
Expected: PASS, 19 tests.

- [ ] **Step 6: Commit**

```bash
git add lib/coach/strain/mechanical-load.ts lib/coach/strain/__tests__/mechanical-load.test.ts lib/coach/exercise-muscles.ts
git commit -m "feat(strain): scale-preserving mechanical load from logger sets"
```

---

## Task 7: Activity matching and cross-device dedup

**Files:**
- Create: `lib/coach/strain/match-sessions.ts`
- Test: `lib/coach/strain/__tests__/match-sessions.test.ts`

**Interfaces:**
- Consumes: `ActivityInput`, `activityWindow`, `resolveHrSource` (Task 4); `HR_SOURCE_RANK` (Task 2).
- Produces:
  - `MATCH_TOLERANCE_MS` (30 min)
  - `type WorkoutWindow = { workout_id: string; startMs: number; endMs: number }`
  - `dedupeActivities(activities: ActivityInput[]): { kept: ActivityInput[]; superseded: Array<{ external_id: string; superseded_by: string }> }`
  - `matchActivityToWorkout(activity: ActivityInput, workouts: WorkoutWindow[]): string | null`

- [ ] **Step 1: Write the failing test**

Create `lib/coach/strain/__tests__/match-sessions.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  dedupeActivities,
  matchActivityToWorkout,
  MATCH_TOLERANCE_MS,
  type WorkoutWindow,
} from "@/lib/coach/strain/match-sessions";
import type { ActivityInput } from "@/lib/coach/strain/activity-load";

const T0 = Date.parse("2026-08-11T09:00:00.000Z");

function mkActivity(over: Partial<ActivityInput> = {}): ActivityInput {
  return {
    external_id: "a1",
    started_at: new Date(T0).toISOString(),
    duration_s: 3000,
    device_id: "3491966227",
    activity_type: "strength_training",
    hr_samples: [
      [T0, 100],
      [T0 + 1000, 100],
    ],
    ...over,
  };
}

function mkWorkout(over: Partial<WorkoutWindow> = {}): WorkoutWindow {
  return { workout_id: "w1", startMs: T0, endMs: T0 + 3000 * 1000, ...over };
}

describe("matchActivityToWorkout", () => {
  it("matches when windows overlap and starts are close", () => {
    expect(matchActivityToWorkout(mkActivity(), [mkWorkout()])).toBe("w1");
  });

  it("absorbs the few-minute gap between starting the watch and the logger", () => {
    const w = mkWorkout({ startMs: T0 + 4 * 60_000 });
    expect(matchActivityToWorkout(mkActivity(), [w])).toBe("w1");
  });

  it("still matches when the athlete stops the activity late", () => {
    const a = mkActivity({ duration_s: 4500 });
    expect(matchActivityToWorkout(a, [mkWorkout()])).toBe("w1");
  });

  it("does not match a workout whose start is beyond the tolerance", () => {
    const w = mkWorkout({
      startMs: T0 + MATCH_TOLERANCE_MS + 60_000,
      endMs: T0 + MATCH_TOLERANCE_MS + 3000_000,
    });
    expect(matchActivityToWorkout(mkActivity(), [w])).toBeNull();
  });

  it("does not match when windows do not overlap at all", () => {
    const w = mkWorkout({ startMs: T0 - 3000 * 1000 - 1, endMs: T0 - 1 });
    expect(matchActivityToWorkout(mkActivity(), [w])).toBeNull();
  });

  it("returns null when there are no workouts", () => {
    expect(matchActivityToWorkout(mkActivity(), [])).toBeNull();
  });

  it("picks the nearest workout when two are candidates", () => {
    const near = mkWorkout({ workout_id: "near", startMs: T0 + 60_000 });
    const far = mkWorkout({ workout_id: "far", startMs: T0 + 20 * 60_000 });
    expect(matchActivityToWorkout(mkActivity(), [far, near])).toBe("near");
  });
});

describe("dedupeActivities", () => {
  it("keeps a single activity untouched", () => {
    const { kept, superseded } = dedupeActivities([mkActivity()]);
    expect(kept).toHaveLength(1);
    expect(superseded).toHaveLength(0);
  });

  it("keeps both when windows do not overlap", () => {
    const later = mkActivity({
      external_id: "a2",
      started_at: new Date(T0 + 6 * 3600_000).toISOString(),
    });
    expect(dedupeActivities([mkActivity(), later]).kept).toHaveLength(2);
  });

  it("keeps both when the same device recorded two overlapping records", () => {
    // Same device cannot double-record a session; overlapping same-device rows
    // are two genuine activities (e.g. a paused-and-resumed record).
    const b = mkActivity({ external_id: "a2", started_at: new Date(T0 + 60_000).toISOString() });
    expect(dedupeActivities([mkActivity(), b]).kept).toHaveLength(2);
  });

  it("collapses overlapping records from different devices", () => {
    const band = mkActivity({ external_id: "a2", device_id: "cirqa-1" });
    const { kept, superseded } = dedupeActivities([mkActivity(), band]);
    expect(kept).toHaveLength(1);
    expect(superseded).toHaveLength(1);
  });

  it("prefers the better sensor when devices disagree", () => {
    // Unmapped 'cirqa-1' resolves to unknown, which ranks below the mapped
    // wrist device — so the mapped one survives.
    const band = mkActivity({ external_id: "a2", device_id: "cirqa-1" });
    const { kept, superseded } = dedupeActivities([band, mkActivity()]);
    expect(kept[0].external_id).toBe("a1");
    expect(superseded[0]).toEqual({ external_id: "a2", superseded_by: "a1" });
  });

  it("breaks a sensor tie on sample density", () => {
    const sparse = mkActivity({
      external_id: "sparse",
      device_id: "dev-x",
      hr_samples: [[T0, 100]],
    });
    const dense = mkActivity({
      external_id: "dense",
      device_id: "dev-y",
      hr_samples: Array.from({ length: 500 }, (_, i) => [T0 + i * 1000, 100] as [number, number]),
    });
    expect(dedupeActivities([sparse, dense]).kept[0].external_id).toBe("dense");
  });

  it("is deterministic regardless of input order", () => {
    const band = mkActivity({ external_id: "a2", device_id: "cirqa-1" });
    const forward = dedupeActivities([mkActivity(), band]).kept[0].external_id;
    const reverse = dedupeActivities([band, mkActivity()]).kept[0].external_id;
    expect(forward).toBe(reverse);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/coach/strain/__tests__/match-sessions.test.ts`
Expected: FAIL — cannot resolve `@/lib/coach/strain/match-sessions`.

- [ ] **Step 3: Write the implementation**

Create `lib/coach/strain/match-sessions.ts`:

```ts
import { HR_SOURCE_RANK } from "./constants";
import { activityWindow, resolveHrSource, toHrSamples, type ActivityInput } from "./activity-load";

/** How far apart an activity's start and a logged workout's start may be and
 *  still describe the same session.
 *
 *  The athlete starts the watch activity by hand, then opens the logger — or
 *  the reverse — so the two timestamps differ by seconds to minutes. Matching
 *  on equality would fail every single day; 30 minutes absorbs the ordering gap
 *  and a late stop in the locker room without reaching a different session. */
export const MATCH_TOLERANCE_MS = 30 * 60_000;

/** A logged workout's wall-clock span. */
export type WorkoutWindow = {
  workout_id: string;
  startMs: number;
  endMs: number;
};

/** The workout this activity records, or null if it stands alone.
 *
 *  Requires BOTH an interval overlap and starts within tolerance. Overlap alone
 *  would let a long all-day auto-detected record swallow an unrelated session;
 *  start proximity alone would match a session that merely began near a
 *  different one. */
export function matchActivityToWorkout(
  activity: ActivityInput,
  workouts: WorkoutWindow[],
): string | null {
  const win = activityWindow(activity);
  let best: { id: string; delta: number } | null = null;
  for (const w of workouts) {
    const overlaps = win.startMs < w.endMs && win.endMs > w.startMs;
    if (!overlaps) continue;
    const delta = Math.abs(w.startMs - win.startMs);
    if (delta > MATCH_TOLERANCE_MS) continue;
    if (!best || delta < best.delta) best = { id: w.workout_id, delta };
  }
  return best?.id ?? null;
}

/** Rank an activity as a recording of its session: better sensor first, then
 *  denser stream, then external_id for a stable tie-break. Lower wins. */
function quality(a: ActivityInput): [number, number, string] {
  return [HR_SOURCE_RANK[resolveHrSource(a.device_id)], -toHrSamples(a.hr_samples).length, a.external_id];
}

function betterThan(a: ActivityInput, b: ActivityInput): boolean {
  const [qa, da, ia] = quality(a);
  const [qb, db, ib] = quality(b);
  if (qa !== qb) return qa < qb;
  if (da !== db) return da < db;
  return ia < ib;
}

/** Collapse the same session recorded by two devices.
 *
 *  A 24/7 band will record rides alongside the watch, producing two rows for
 *  one session with different external_ids — a unique key on
 *  (user_id, external_id) cannot express that, so the rule is window-based.
 *
 *  Overlapping records from the SAME device are left alone: one device cannot
 *  double-record a session, so those are two genuine activities. */
export function dedupeActivities(activities: ActivityInput[]): {
  kept: ActivityInput[];
  superseded: Array<{ external_id: string; superseded_by: string }>;
} {
  const kept: ActivityInput[] = [];
  const superseded: Array<{ external_id: string; superseded_by: string }> = [];

  // Stable order so the result never depends on how the ingest happened to
  // batch its rows.
  const ordered = [...activities].sort((a, b) => a.external_id.localeCompare(b.external_id));

  for (const candidate of ordered) {
    const cw = activityWindow(candidate);
    const rivalIndex = kept.findIndex((k) => {
      if (k.device_id === candidate.device_id) return false;
      const kw = activityWindow(k);
      return cw.startMs < kw.endMs && cw.endMs > kw.startMs;
    });

    if (rivalIndex === -1) {
      kept.push(candidate);
      continue;
    }

    const rival = kept[rivalIndex];
    if (betterThan(candidate, rival)) {
      kept[rivalIndex] = candidate;
      superseded.push({ external_id: rival.external_id, superseded_by: candidate.external_id });
    } else {
      superseded.push({ external_id: candidate.external_id, superseded_by: rival.external_id });
    }
  }

  return { kept, superseded };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/coach/strain/__tests__/match-sessions.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/coach/strain/match-sessions.ts lib/coach/strain/__tests__/match-sessions.test.ts
git commit -m "feat(strain): activity-to-workout matching and cross-device dedup"
```

---

## Task 8: Day assembly

**Files:**
- Create: `lib/coach/strain/assemble.ts`, `lib/coach/strain/index.ts`
- Test: `lib/coach/strain/__tests__/assemble.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–7.
- Produces:
  - `type AssembleInput = { allDaySamples: HrSample[]; activities: ActivityInput[]; workouts: Array<{ workout_id: string; startMs: number; endMs: number; exercises: MechanicalExercise[] }>; hrRest: number; hrMax: number; rirTarget: number | null }`
  - `type AssembleResult = { load: DayLoad; strain: number; keptActivityIds: string[]; superseded: Array<{ external_id: string; superseded_by: string }> }`
  - `assembleDay(input: AssembleInput): AssembleResult`

- [ ] **Step 1: Write the failing test**

Create `lib/coach/strain/__tests__/assemble.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { assembleDay, type AssembleInput } from "@/lib/coach/strain/assemble";
import type { HrSample } from "@/lib/coach/strain/types";

const DAY0 = Date.parse("2026-08-11T00:00:00.000Z");
const SESSION_START = DAY0 + 9 * 3600_000;
const SESSION_S = 3000;

function allDay(bpm = 65): HrSample[] {
  return Array.from({ length: 720 }, (_, i) => ({ ts: DAY0 + i * 120_000, bpm }));
}

function mkInput(over: Partial<AssembleInput> = {}): AssembleInput {
  return {
    allDaySamples: allDay(),
    activities: [],
    workouts: [],
    hrRest: 55,
    hrMax: 183,
    rirTarget: 2,
    ...over,
  };
}

const SESSION_ACTIVITY = {
  external_id: "act-1",
  started_at: new Date(SESSION_START).toISOString(),
  duration_s: SESSION_S,
  device_id: "3491966227",
  activity_type: "strength_training",
  hr_samples: Array.from(
    { length: SESSION_S + 1 },
    (_, i) => [SESSION_START + i * 1000, 120] as [number, number],
  ),
};

const SESSION_WORKOUT = {
  workout_id: "w-1",
  startMs: SESSION_START + 120_000,
  endMs: SESSION_START + SESSION_S * 1000,
  exercises: [
    {
      name: "Deadlift (Barbell)",
      e1rm: 180,
      sets: [
        { kg: 140, reps: 5, warmup: false, rir: 2 },
        { kg: 140, reps: 5, warmup: false, rir: 2 },
      ],
    },
  ],
};

describe("assembleDay", () => {
  it("scores a bare living day above zero", () => {
    const r = assembleDay(mkInput());
    expect(r.load.baseline).toBeGreaterThan(0);
    expect(r.strain).toBeGreaterThan(0);
  });

  it("returns zero strain for a day with no data at all", () => {
    const r = assembleDay(mkInput({ allDaySamples: [] }));
    expect(r.strain).toBe(0);
  });

  it("adds mechanical load for a logged session", () => {
    const withLift = assembleDay(mkInput({ workouts: [SESSION_WORKOUT] }));
    const without = assembleDay(mkInput());
    expect(withLift.load.mechanical).toBeGreaterThan(0);
    expect(withLift.strain).toBeGreaterThan(without.strain);
  });

  it("excludes a matched activity's window from the baseline term", () => {
    const withActivity = assembleDay(
      mkInput({ activities: [SESSION_ACTIVITY], workouts: [SESSION_WORKOUT] }),
    );
    const bare = assembleDay(mkInput());
    expect(withActivity.load.baseline).toBeLessThan(bare.load.baseline);
    expect(withActivity.load.activity).toBeGreaterThan(0);
  });

  it("does not double-count the session hour", () => {
    // The activity's own span must be removed from baseline, so baseline plus
    // activity is strictly less than naively summing both over the same hour.
    const r = assembleDay(mkInput({ activities: [SESSION_ACTIVITY] }));
    const bare = assembleDay(mkInput());
    const naive = bare.load.baseline + r.load.activity;
    expect(r.load.baseline + r.load.activity).toBeLessThan(naive);
  });

  it("keeps an unmatched activity in the cardio term", () => {
    const r = assembleDay(mkInput({ activities: [SESSION_ACTIVITY] }));
    expect(r.load.activity).toBeGreaterThan(0);
    expect(r.keptActivityIds).toEqual(["act-1"]);
  });

  it("scores a logged session with no activity record — the fallback path", () => {
    const r = assembleDay(mkInput({ workouts: [SESSION_WORKOUT] }));
    expect(r.load.activity).toBe(0);
    expect(r.load.mechanical).toBeGreaterThan(0);
    expect(r.strain).toBeGreaterThan(assembleDay(mkInput()).strain);
  });

  it("leaves an activity with no HR stream inside the baseline", () => {
    // Nothing to score in the activity term, so its window must NOT be cut out
    // of baseline — that would delete the hour from the day entirely.
    const noHr = { ...SESSION_ACTIVITY, hr_samples: null };
    const r = assembleDay(mkInput({ activities: [noHr] }));
    const bare = assembleDay(mkInput());
    expect(r.load.activity).toBe(0);
    expect(r.load.baseline).toBeCloseTo(bare.load.baseline, 9);
  });

  it("reports superseded activities from cross-device dedup", () => {
    const band = { ...SESSION_ACTIVITY, external_id: "act-2", device_id: "cirqa-1" };
    const r = assembleDay(mkInput({ activities: [SESSION_ACTIVITY, band] }));
    expect(r.keptActivityIds).toHaveLength(1);
    expect(r.superseded).toHaveLength(1);
  });

  it("ranks a heavy lifting day above a quiet day, which is the whole point", () => {
    const quiet = assembleDay(mkInput());
    const heavy = assembleDay(
      mkInput({ activities: [SESSION_ACTIVITY], workouts: [SESSION_WORKOUT] }),
    );
    expect(heavy.strain).toBeGreaterThan(quiet.strain + 3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/coach/strain/__tests__/assemble.test.ts`
Expected: FAIL — cannot resolve `@/lib/coach/strain/assemble`.

- [ ] **Step 3: Write the implementation**

Create `lib/coach/strain/assemble.ts`:

```ts
import { activityTrimp, activityWindow, toHrSamples, type ActivityInput } from "./activity-load";
import { baselineTrimp } from "./baseline-load";
import { composeStrain } from "./compose";
import { dedupeActivities, matchActivityToWorkout, type WorkoutWindow } from "./match-sessions";
import { mechanicalLoad, type MechanicalExercise } from "./mechanical-load";
import type { DayLoad, HrSample, TimeWindow } from "./types";

export type AssembleWorkout = WorkoutWindow & { exercises: MechanicalExercise[] };

export type AssembleInput = {
  allDaySamples: HrSample[];
  activities: ActivityInput[];
  workouts: AssembleWorkout[];
  hrRest: number;
  hrMax: number;
  rirTarget: number | null;
};

export type AssembleResult = {
  load: DayLoad;
  strain: number;
  keptActivityIds: string[];
  superseded: Array<{ external_id: string; superseded_by: string }>;
};

/** Build one day's three load terms and the resulting strain.
 *
 *  Pure — every input is passed in, so the whole model is testable without a
 *  database and the recompute writer stays a thin shell around it.
 *
 *  The matching result is deliberately NOT used to gate the activity term: a
 *  matched activity and an unmatched one are both real cardio. Matching exists
 *  so the mechanical term knows which workouts were already covered by an
 *  activity record, and so an unlogged activity still contributes. */
export function assembleDay(input: AssembleInput): AssembleResult {
  const { kept, superseded } = dedupeActivities(input.activities);

  // Only activities whose HR is actually being scored may have their window
  // removed from the baseline. Cutting a window we cannot score would delete
  // that hour from the day entirely.
  const excluded: TimeWindow[] = [];
  let activity = 0;
  for (const a of kept) {
    if (toHrSamples(a.hr_samples).length < 2) continue;
    activity += activityTrimp(a, input.hrRest, input.hrMax);
    excluded.push(activityWindow(a));
  }

  const baseline = baselineTrimp(input.allDaySamples, excluded, input.hrRest, input.hrMax);

  let mechanical = 0;
  for (const w of input.workouts) {
    mechanical += mechanicalLoad(w.exercises, input.rirTarget);
  }

  // Computed for its side value to future readers: which workouts a device
  // actually witnessed. Not used to scale anything today.
  for (const a of kept) matchActivityToWorkout(a, input.workouts);

  const load: DayLoad = { baseline, activity, mechanical };
  return {
    load,
    strain: composeStrain(load),
    keptActivityIds: kept.map((a) => a.external_id),
    superseded,
  };
}
```

Create `lib/coach/strain/index.ts`:

```ts
export { assembleDay } from "./assemble";
export type { AssembleInput, AssembleResult, AssembleWorkout } from "./assemble";
export { composeStrain } from "./compose";
export { STRAIN_CALIBRATION, DEVICE_HR_SOURCE, HR_SOURCE_RANK, MAX_INTERVAL_MIN } from "./constants";
export { activityTrimp, activityWindow, resolveHrSource, toHrSamples } from "./activity-load";
export type { ActivityInput } from "./activity-load";
export { baselineTrimp } from "./baseline-load";
export { mechanicalLoad, rawTonnage } from "./mechanical-load";
export type { MechanicalExercise, MechanicalSet } from "./mechanical-load";
export { dedupeActivities, matchActivityToWorkout, MATCH_TOLERANCE_MS } from "./match-sessions";
export type { WorkoutWindow } from "./match-sessions";
export { banisterOverIntervals, medianGapSeconds } from "./trimp";
export type { DayLoad, HrSample, HrSource, TimeWindow } from "./types";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/coach/strain/__tests__/assemble.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Run the whole strain suite and typecheck**

Run: `npx vitest run lib/coach/strain && npm run typecheck`
Expected: all strain tests PASS, typecheck exit 0.

- [ ] **Step 6: Commit**

```bash
git add lib/coach/strain/assemble.ts lib/coach/strain/index.ts lib/coach/strain/__tests__/assemble.test.ts
git commit -m "feat(strain): day assembly joining baseline, activity and mechanical load"
```

---

## Task 9: The recompute writer

**Files:**
- Create: `lib/coach/strain/recompute.ts`

**Interfaces:**
- Consumes: `assembleDay` (Task 8); `getUserTimezone` from `@/lib/time/get-user-tz`; `localDayRangeUtc` from `@/lib/time`; `brzycki` from `@/lib/coach/e1rm`.
- Produces: `recomputeStrainForDay(args: { supabase: SupabaseClient; userId: string; dateIso: string }): Promise<{ strain: number | null; skipped?: string }>`

- [ ] **Step 1: Write the implementation**

Create `lib/coach/strain/recompute.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { localDayRangeUtc } from "@/lib/time";
import { getUserTimezone } from "@/lib/time/get-user-tz";
import { brzycki } from "@/lib/coach/e1rm";
import { assembleDay, type AssembleWorkout } from "./assemble";
import { medianGapSeconds, toHrSamples } from "./index";
import type { ActivityInput } from "./activity-load";
import type { HrSample } from "./types";
import type { MechanicalExercise } from "./mechanical-load";

const DEFAULT_HR_MAX = 190;
const DEFAULT_HR_REST = 50;

/** Recompute and store one day's strain. The SINGLE writer of
 *  daily_logs.strain — the Garmin ingest and both logger session routes all
 *  funnel here, so there is one place where the number is decided.
 *
 *  Returns the stored value, or `{ strain: null, skipped }` when the day has no
 *  usable input. A day with no HR and no workout is left ALONE rather than
 *  written as 0: absence of data is not absence of strain, and overwriting a
 *  historical value with 0 would be a silent data loss. */
export async function recomputeStrainForDay(args: {
  supabase: SupabaseClient;
  userId: string;
  dateIso: string;
}): Promise<{ strain: number | null; skipped?: string }> {
  const { supabase, userId, dateIso } = args;
  const tz = await getUserTimezone(userId);
  const { startUtc } = localDayRangeUtc(dateIso, tz);

  const [{ data: profile }, { data: dayLog }, { data: activityRows }, { data: workoutRows }] =
    await Promise.all([
      supabase.from("profiles").select("age").eq("user_id", userId).maybeSingle(),
      supabase
        .from("daily_logs")
        .select("resting_hr")
        .eq("user_id", userId)
        .eq("date", dateIso)
        .maybeSingle(),
      supabase
        .from("garmin_activities")
        .select(
          "external_id, started_at, duration_s, device_id, activity_type, hr_samples, superseded_by",
        )
        .eq("user_id", userId)
        .eq("local_date", dateIso),
      supabase
        .from("workouts")
        .select(
          "id, started_at, date, duration_min, exercises(name, exercise_sets(kg, reps, warmup, rir, started_at, work_seconds))",
        )
        .eq("user_id", userId)
        .eq("date", dateIso),
    ]);

  const hrMax = profile?.age ? Math.round(208 - 0.7 * profile.age) : DEFAULT_HR_MAX;
  const hrRest = dayLog?.resting_hr ?? DEFAULT_HR_REST;

  // All-day stream lives on garmin_daily.raw.hr_samples, written by the ingest.
  const { data: garminDay } = await supabase
    .from("garmin_daily")
    .select("raw")
    .eq("user_id", userId)
    .eq("date", dateIso)
    .maybeSingle();
  const rawAllDay = (garminDay?.raw?.hr_samples ?? null) as Array<[number, number]> | null;
  const allDaySamples: HrSample[] = toHrSamples(rawAllDay);

  const activities: ActivityInput[] = (activityRows ?? [])
    .filter((r) => !r.superseded_by)
    .map((r) => ({
      external_id: r.external_id,
      started_at: r.started_at,
      duration_s: r.duration_s,
      device_id: r.device_id,
      activity_type: r.activity_type,
      hr_samples: r.hr_samples,
    }));

  const workouts: AssembleWorkout[] = (workoutRows ?? []).map((w) => {
    const exercises: MechanicalExercise[] = (w.exercises ?? []).map((e: {
      name: string;
      exercise_sets: Array<{
        kg: number | null;
        reps: number | null;
        warmup: boolean;
        rir: number | null;
      }>;
    }) => ({
      name: e.name,
      sets: (e.exercise_sets ?? []).map((s) => ({
        kg: s.kg,
        reps: s.reps,
        warmup: s.warmup,
        rir: s.rir,
      })),
      // Best e1RM WITHIN the session: the alternative is a history query per
      // exercise per day, which would make a backfill over 500 days quadratic.
      // Intensity is a redistribution factor, so a same-session reference is
      // sufficient and keeps recompute a bounded number of queries.
      e1rm: bestSessionE1rm(e.exercise_sets ?? []),
    }));
    const startMs = w.started_at ? Date.parse(w.started_at) : startUtc.getTime();
    const endMs = startMs + (w.duration_min ?? 60) * 60_000;
    return { workout_id: w.id, startMs, endMs, exercises };
  });

  if (allDaySamples.length === 0 && activities.length === 0 && workouts.length === 0) {
    return { strain: null, skipped: "no_input" };
  }

  const { data: week } = await supabase
    .from("training_weeks")
    .select("rir_target")
    .eq("user_id", userId)
    .lte("week_start", dateIso)
    .order("week_start", { ascending: false })
    .limit(1)
    .maybeSingle();

  const result = assembleDay({
    allDaySamples,
    activities,
    workouts,
    hrRest,
    hrMax,
    rirTarget: week?.rir_target ?? null,
  });

  const { error } = await supabase.from("daily_logs").upsert(
    {
      user_id: userId,
      date: dateIso,
      strain: result.strain,
      hr_sample_density: medianGapSeconds(allDaySamples),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,date" },
  );
  if (error) throw error;

  if (result.superseded.length > 0) {
    await Promise.all(
      result.superseded.map((s) =>
        supabase
          .from("garmin_activities")
          .update({ superseded_by: s.superseded_by })
          .eq("user_id", userId)
          .eq("external_id", s.external_id),
      ),
    );
  }

  return { strain: result.strain };
}

/** Highest Brzycki e1RM among a session's own non-warmup 1–12 rep sets. Null
 *  when nothing qualifies, which makes intensityFactor neutral. */
function bestSessionE1rm(
  sets: Array<{ kg: number | null; reps: number | null; warmup: boolean }>,
): number | null {
  let best: number | null = null;
  for (const s of sets) {
    if (s.warmup || !s.kg || !s.reps) continue;
    if (s.reps < 1 || s.reps > 12) continue;
    const v = brzycki(s.kg, s.reps);
    if (v !== null && (best === null || v > best)) best = v;
  }
  return best;
}
```

- [ ] **Step 2: Confirm the helper signatures match**

Run: `grep -n "export function brzycki" lib/coach/e1rm.ts && grep -n "export function localDayRangeUtc" -A 8 lib/time.ts`
Expected: both found. Adjust the `brzycki` call and the `localDayRangeUtc` destructuring to the real signatures if they differ from `brzycki(kg, reps): number | null` and a `{ startUtc }` field. `startUtc` is used only as the fallback start for a workout with no `started_at`; if the helper returns ISO strings rather than Dates, replace `startUtc.getTime()` with `Date.parse(startUtc)`. Fix the import and the two call sites, do not change the helpers themselves.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add lib/coach/strain/recompute.ts
git commit -m "feat(strain): recomputeStrainForDay as the single writer"
```

---

## Task 10: Sidecar activity pass

**Files:**
- Modify: `sidecar/garmin/collector.py`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: each day payload gains `activities: [{external_id, activity_type, started_at, duration_s, avg_hr, max_hr, device_id, garmin_load, aerobic_te, anaerobic_te, body_battery_diff, zone_seconds, hr_samples}]`.

- [ ] **Step 1: Add the collector function**

In `sidecar/garmin/collector.py`, add above `collect_day`:

```python
def collect_activities(g: Garmin, d: str) -> list:
    """Activities for one day, each with its native-resolution HR stream.

    The all-day wellness stream is 2-minute-sampled and aliases lifting away
    entirely — a 45-minute session yields ~22 samples and HR falls between
    sets. The activity file carries the real thing (1,000-2,500 points), which
    is where every training peak lives. No derivation here; the app computes
    TRIMP.
    """
    out = []
    try:
        acts = g.get_activities_by_date(d, d)
    except Exception as e:  # noqa: BLE001 — unofficial API, best-effort
        print(f"  warn: get_activities_by_date failed for {d}: {e}", file=sys.stderr)
        return out

    for a in acts or []:
        aid = a.get("activityId")
        if aid is None:
            continue
        rec = {
            "external_id": str(aid),
            "activity_type": (a.get("activityType") or {}).get("typeKey"),
            "started_at": a.get("startTimeGMT"),
            "duration_s": int(a.get("duration") or 0),
            "avg_hr": a.get("averageHR"),
            "max_hr": a.get("maxHR"),
            "device_id": str(a["deviceId"]) if a.get("deviceId") is not None else None,
            "garmin_load": a.get("activityTrainingLoad"),
            "aerobic_te": a.get("aerobicTrainingEffect"),
            "anaerobic_te": a.get("anaerobicTrainingEffect"),
            "body_battery_diff": a.get("differenceBodyBattery"),
            "zone_seconds": {
                str(i): a.get(f"hrTimeInZone_{i}") for i in range(1, 6)
                if a.get(f"hrTimeInZone_{i}") is not None
            },
            "hr_samples": [],
        }
        try:
            det = g.get_activity_details(aid, maxchart=4000, maxpoly=0)
            descs = {x["key"]: x["metricsIndex"] for x in (det.get("metricDescriptors") or [])}
            hi, ti = descs.get("directHeartRate"), descs.get("directTimestamp")
            if hi is not None and ti is not None:
                pts = []
                for m in det.get("activityDetailMetrics") or []:
                    v = m.get("metrics") or []
                    if len(v) > max(hi, ti) and v[hi] is not None and v[ti] is not None:
                        pts.append([int(v[ti]), int(v[hi])])
                rec["hr_samples"] = pts
        except Exception as e:  # noqa: BLE001
            print(f"  warn: activity detail {aid} failed: {e}", file=sys.stderr)
        out.append(rec)
    return out
```

- [ ] **Step 2: Call it from `collect_day`**

At the end of `collect_day`, immediately before `return day`, add:

```python
    day["activities"] = collect_activities(g, d)
```

- [ ] **Step 3: Keep activities out of the overnight-only payload**

`OVERNIGHT_KEYS` already whitelists, so `overnight_only` drops `activities` for today automatically — today's activities are incomplete until the watch syncs. Verify:

Run: `cd sidecar/garmin && grep -n "OVERNIGHT_KEYS" -A 6 collector.py`
Expected: `activities` is absent from the set. No change needed; confirm and move on.

- [ ] **Step 4: Dry-run the collector against one day**

Run:
```bash
cd sidecar/garmin && set -a && source .env && set +a && BACKFILL_DAYS=1 ./.venv/bin/python -c "
import collector, os, json
g = collector.login()
d = collector.date.today().isoformat()
acts = collector.collect_activities(g, (collector.date.today() - collector.timedelta(days=2)).isoformat())
print(json.dumps([{k: (len(v) if k == 'hr_samples' else v) for k, v in a.items()} for a in acts], indent=1, default=str))
"
```
Expected: zero or more activity records printed, each with an integer `hr_samples` count in the hundreds-to-thousands when the day had an activity. If zero activities, try a day you know you trained.

- [ ] **Step 5: Commit**

```bash
git add sidecar/garmin/collector.py
git commit -m "feat(strain): sidecar fetches per-activity HR streams"
```

---

## Task 11: Ingest route wiring

**Files:**
- Modify: `app/api/ingest/garmin/route.ts`

**Interfaces:**
- Consumes: `recomputeStrainForDay` (Task 9), `resolveHrSource`, `medianGapSeconds`, `toHrSamples`, `banisterOverIntervals` (Tasks 3–4).
- Produces: `garmin_activities` rows written per ingest; `daily_logs.strain` written via the recompute.

- [ ] **Step 1: Extend the Zod schema**

In `app/api/ingest/garmin/route.ts`, add to `daySchema` after the `hr_samples` field:

```ts
  activities: z
    .array(
      z.object({
        external_id: z.string(),
        activity_type: z.string().nullish(),
        started_at: z.string(),
        duration_s: z.number(),
        avg_hr: z.number().nullish(),
        max_hr: z.number().nullish(),
        device_id: z.string().nullish(),
        garmin_load: z.number().nullish(),
        aerobic_te: z.number().nullish(),
        anaerobic_te: z.number().nullish(),
        body_battery_diff: z.number().nullish(),
        zone_seconds: z.record(z.string(), z.number()).nullish(),
        hr_samples: z.array(z.tuple([z.number(), z.number()])).nullish(),
      }),
    )
    .nullish(),
```

- [ ] **Step 2: Upsert activity rows**

Add these imports at the top of the route:

```ts
import { recomputeStrainForDay } from "@/lib/coach/strain/recompute";
import { resolveHrSource, toHrSamples } from "@/lib/coach/strain/activity-load";
import { banisterOverIntervals, medianGapSeconds } from "@/lib/coach/strain/trimp";
```

Inside the `for (const d of parsed.days)` loop, after `dailyRows.push(...)`, add:

```ts
    for (const a of d.activities ?? []) {
      const samples = toHrSamples(a.hr_samples ?? null);
      activityRows.push({
        user_id: userId,
        external_id: a.external_id,
        local_date: d.date,
        activity_type: a.activity_type ?? null,
        started_at: a.started_at,
        duration_s: Math.round(a.duration_s),
        avg_hr: a.avg_hr ?? null,
        max_hr: a.max_hr ?? null,
        device_id: a.device_id ?? null,
        hr_source: resolveHrSource(a.device_id ?? null),
        hr_sample_count: samples.length,
        hr_median_gap_s: medianGapSeconds(samples),
        zone_seconds: a.zone_seconds ?? null,
        garmin_load: a.garmin_load ?? null,
        aerobic_te: a.aerobic_te ?? null,
        anaerobic_te: a.anaerobic_te ?? null,
        body_battery_diff: a.body_battery_diff ?? null,
        // Derived here so the row is self-describing in the DB; the composer
        // recomputes from hr_samples rather than trusting this column.
        trimp: banisterOverIntervals(samples, d.resting_hr ?? 50, hrMax),
        hr_samples: a.hr_samples ?? null,
        updated_at: now,
      });
    }
```

Declare `const activityRows: Record<string, unknown>[] = [];` next to `const dailyRows`.

- [ ] **Step 3: Write the rows and recompute**

After the existing `daily_logs` upsert block and before the final `NextResponse.json`, add:

```ts
  if (activityRows.length > 0) {
    const { error } = await sr
      .from("garmin_activities")
      .upsert(activityRows, { onConflict: "user_id,external_id" });
    if (error) {
      console.error("[ingest/garmin] garmin_activities upsert failed:", error.message);
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
  }

  // Fused strain, recomputed per ingested day. Non-fatal: the ingest's own
  // writes have already succeeded, and the nightly run plus any workout commit
  // will retry. Failing the ingest here would lose raw data to a derived value.
  for (const d of parsed.days) {
    try {
      await recomputeStrainForDay({ supabase: sr, userId, dateIso: d.date });
    } catch (err) {
      console.error("[ingest/garmin] recomputeStrainForDay failed for", d.date, err);
    }
  }
```

- [ ] **Step 4: Stop Edwards from writing strain**

In the same loop, replace:

```ts
    const strain = edw !== null ? trimpToStrain(edw) : null;
```

with:

```ts
    // Strain is no longer derived here — recomputeStrainForDay owns the column
    // and fuses cardio with the logger's mechanical load. edw/ban stay to feed
    // the garmin_daily shadow columns for parallel comparison.
    const strain = null;
```

Both `mapToDailyLogs` and `mapMovementEnergy` skip a null strain, so the movement/energy write no longer touches the column.

- [ ] **Step 5: Typecheck and verify null-strain handling**

Run: `npm run typecheck && grep -n "if (strain !== null" lib/coach/garmin/map-metrics.ts`
Expected: typecheck exit 0, and `mapToDailyLogs` guards on non-null strain. `mapMovementEnergy` always emits `strain: strain` — change that line to omit the key when null:

```ts
  const row: MovementEnergyRow = {
    date: input.date,
    steps: intOrNull(input.steps),
    distance_km: numOrNull(input.distance_km),
    calories: intOrNull(input.calories),
    active_calories: intOrNull(input.active_calories),
    strain,
  };
  // A null strain here means "not derived in this path" — recomputeStrainForDay
  // owns the column. Writing null would clobber a good value with nothing.
  if (strain === null) delete (row as Partial<MovementEnergyRow>).strain;
  return row;
```

Update `MovementEnergyRow`'s `strain` to `strain?: number | null` and re-run typecheck.

- [ ] **Step 6: Commit**

```bash
git add app/api/ingest/garmin/route.ts lib/coach/garmin/map-metrics.ts
git commit -m "feat(strain): ingest stores activities and delegates strain to recompute"
```

---

## Task 12: Logger route hooks

**Files:**
- Modify: `app/api/logger/session/route.ts`, `app/api/logger/session/[workout_id]/route.ts`

**Interfaces:**
- Consumes: `recomputeStrainForDay` (Task 9).
- Produces: strain moves the moment a session is committed or deleted.

- [ ] **Step 1: Hook the commit route**

In `app/api/logger/session/route.ts`, add the import:

```ts
import { recomputeStrainForDay } from "@/lib/coach/strain/recompute";
```

After the `repatchRemainingWeek` try/catch block, add:

```ts
    // Fused strain: the mechanical term means today's number moves as soon as
    // the session lands, instead of waiting for tomorrow's collector run.
    // Non-fatal, matching every other post-commit hook on this route — a
    // derived value must never fail a session the athlete already performed.
    try {
      await recomputeStrainForDay({
        supabase,
        userId: payload.user_id,
        dateIso: payload.date,
      });
    } catch (err) {
      console.error("[logger/session] recomputeStrainForDay failed:", err);
    }
```

- [ ] **Step 2: Hook the delete route**

In `app/api/logger/session/[workout_id]/route.ts`, add the same import and, after the repatch step, add:

```ts
  // Unwind the mechanical term too. Non-fatal and self-healing: the next
  // ingest or commit recomputes the same day.
  try {
    await recomputeStrainForDay({ supabase, userId, dateIso: workoutDate });
  } catch (err) {
    console.error("[logger/session/delete] recomputeStrainForDay failed:", err);
  }
```

Read the file first to bind `userId` and `workoutDate` to the names already in scope there — do not introduce new queries to obtain them.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 4: Exercise it locally**

Run: `npm run dev`, open `/strength`, start and commit a short session (two exercises, one set each with a load), then query:

```bash
node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local -e "
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { data } = await sb.from('daily_logs').select('date, strain, hr_sample_density').order('date', { ascending: false }).limit(3);
console.log(data);
"
```
Expected: today's row carries a non-null `strain` greater than it was before the commit.

- [ ] **Step 5: Commit**

```bash
git add app/api/logger/session/route.ts "app/api/logger/session/[workout_id]/route.ts"
git commit -m "feat(strain): recompute on session commit and delete"
```

---

## Task 13: Backfill garmin_activities

**Files:**
- Create: `scripts/backfill-garmin-activities.mjs`

**Interfaces:**
- Consumes: the sidecar's Garmin session (run from `sidecar/garmin`), `resolveHrSource`/`medianGapSeconds`/`banisterOverIntervals`.
- Produces: populated `garmin_activities` from the all-day-HR floor forward.

- [ ] **Step 1: Find the all-day HR floor**

Run:
```bash
cd sidecar/garmin && set -a && source .env && set +a && ./.venv/bin/python -c "
from garminconnect import Garmin
import os
g = Garmin(os.environ['GARMIN_EMAIL'], os.environ['GARMIN_PASSWORD']); g.login(os.path.expanduser('~/.garminconnect'))
for d in ['2026-03-01','2026-03-15','2026-04-01','2026-04-08','2026-04-15']:
    hr = g.get_heart_rates(d) or {}
    print(d, len(hr.get('heartRateValues') or []))
"
```
Expected: a printed boundary. Record the earliest date with a non-zero count — it is the backfill floor. Known: `2026-04-15` → 717, `2026-03-01` → 0.

- [ ] **Step 2: Write the export script**

Create `sidecar/garmin/backfill_activities.py`:

```python
#!/usr/bin/env python3
"""One-shot: dump every activity in a date range to JSON for the app to ingest.

Read-only against Garmin. Writes DUMP_PATH; scripts/backfill-garmin-activities.mjs
loads it and upserts. Kept separate from collector.py so the daily path stays
small and this can be re-run without touching the LaunchAgent.
"""
import json
import os
import sys

from garminconnect import Garmin

import collector

g = collector.login()
start, end = os.environ["RANGE_START"], os.environ["RANGE_END"]

acts = g.get_activities_by_date(start, end)
print(f"{len(acts)} activities {start} → {end}", file=sys.stderr)

out = []
for a in acts:
    day = (a.get("startTimeLocal") or "")[:10]
    recs = collector.collect_activities(g, day)
    for r in recs:
        if not any(x["external_id"] == r["external_id"] for x in out):
            r["local_date"] = day
            out.append(r)
    print(f"  {day}: {len(recs)}", file=sys.stderr)

json.dump(out, open(os.environ["DUMP_PATH"], "w"))
print(f"wrote {len(out)} activities to {os.environ['DUMP_PATH']}", file=sys.stderr)
```

- [ ] **Step 3: Write the upsert script**

Create `scripts/backfill-garmin-activities.mjs`:

```js
// scripts/backfill-garmin-activities.mjs
//
// Loads the JSON produced by sidecar/garmin/backfill_activities.py and upserts
// garmin_activities. Idempotent on (user_id, external_id). Read-only against
// Garmin; the only writes are to this one table.
//
//   AUDIT_USER_ID=<uuid> DUMP_PATH=/tmp/acts.json \
//   node --import ./scripts/alias-loader.mjs --experimental-strip-types \
//        --env-file=.env.local scripts/backfill-garmin-activities.mjs --yes

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { resolveHrSource, toHrSamples } from "@/lib/coach/strain/activity-load";
import { banisterOverIntervals, medianGapSeconds } from "@/lib/coach/strain/trimp";

const userId = process.env.AUDIT_USER_ID;
if (!userId) throw new Error("AUDIT_USER_ID is required");
const dump = JSON.parse(readFileSync(process.env.DUMP_PATH, "utf8"));

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const { data: profile } = await sb.from("profiles").select("age").eq("user_id", userId).maybeSingle();
const hrMax = profile?.age ? Math.round(208 - 0.7 * profile.age) : 190;

const { data: logs } = await sb
  .from("daily_logs")
  .select("date, resting_hr")
  .eq("user_id", userId);
const rhrBy = new Map((logs ?? []).map((r) => [r.date, r.resting_hr ?? 50]));

const rows = dump.map((a) => {
  const samples = toHrSamples(a.hr_samples ?? null);
  return {
    user_id: userId,
    external_id: a.external_id,
    local_date: a.local_date,
    activity_type: a.activity_type ?? null,
    started_at: a.started_at,
    duration_s: Math.round(a.duration_s ?? 0),
    avg_hr: a.avg_hr ?? null,
    max_hr: a.max_hr ?? null,
    device_id: a.device_id ?? null,
    hr_source: resolveHrSource(a.device_id ?? null),
    hr_sample_count: samples.length,
    hr_median_gap_s: medianGapSeconds(samples),
    zone_seconds: a.zone_seconds ?? null,
    garmin_load: a.garmin_load ?? null,
    aerobic_te: a.aerobic_te ?? null,
    anaerobic_te: a.anaerobic_te ?? null,
    body_battery_diff: a.body_battery_diff ?? null,
    trimp: banisterOverIntervals(samples, rhrBy.get(a.local_date) ?? 50, hrMax),
    hr_samples: a.hr_samples ?? null,
    updated_at: new Date().toISOString(),
  };
});

console.log(`${rows.length} activities to upsert`);
const byMonth = {};
for (const r of rows) byMonth[r.local_date.slice(0, 7)] = (byMonth[r.local_date.slice(0, 7)] ?? 0) + 1;
console.table(byMonth);

if (!process.argv.includes("--yes")) {
  console.log("dry run — pass --yes to write");
  process.exit(0);
}

for (let i = 0; i < rows.length; i += 25) {
  const chunk = rows.slice(i, i + 25);
  const { error } = await sb.from("garmin_activities").upsert(chunk, { onConflict: "user_id,external_id" });
  if (error) throw error;
  console.log(`upserted ${i + chunk.length}/${rows.length}`);
}
console.log("done");
```

- [ ] **Step 4: Run the export**

Run:
```bash
cd sidecar/garmin && set -a && source .env && set +a && \
RANGE_START=<floor-from-step-1> RANGE_END=$(date +%F) DUMP_PATH=/tmp/garmin-acts.json \
./.venv/bin/python backfill_activities.py
```
Expected: a per-day activity count on stderr and a written JSON file. This makes many API calls — expect several minutes.

- [ ] **Step 5: Dry-run then apply the upsert**

Run:
```bash
AUDIT_USER_ID=94fee5c6-7d9a-4b05-be3a-8407505b5429 DUMP_PATH=/tmp/garmin-acts.json \
node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local \
  scripts/backfill-garmin-activities.mjs
```
Expected: a per-month table and "dry run". Inspect the counts against the months you trained, then re-run with `--yes`.

- [ ] **Step 6: Commit**

```bash
git add scripts/backfill-garmin-activities.mjs sidecar/garmin/backfill_activities.py
git commit -m "feat(strain): backfill garmin_activities from Garmin history"
```

---

## Task 14: Freeze the calibration fixture

**HARD GATE. This task must complete before Task 16 writes a single `daily_logs.strain` value.** April–May rows still carry WHOOP's strength-adjusted numbers, and they are the only labelled data that exists. Overwriting them without freezing first destroys the ruler permanently.

**Files:**
- Create: `scripts/freeze-strain-calibration.mjs`, `scripts/fixtures/strain-calibration-2026.json`

**Interfaces:**
- Consumes: `garmin_activities` (Task 13), `workouts`, `daily_logs`, `garmin_daily`.
- Produces: `scripts/fixtures/strain-calibration-2026.json` — an array of `{ date, whoop_strain, all_day_samples, activities, exercises, resting_hr }`.

- [ ] **Step 1: Write the freeze script**

Create `scripts/freeze-strain-calibration.mjs`:

```js
// scripts/freeze-strain-calibration.mjs
//
// Writes the labelled calibration set to scripts/fixtures/strain-calibration-2026.json.
//
// April-May 2026 daily_logs.strain rows still carry WHOOP's own
// strength-adjusted values — the ONLY labelled data that will ever exist for
// this athlete, since WHOOP is disconnected. June was already overwritten by
// the Garmin cutover. Freezing them into the repo is what makes it safe to
// recompute the column.
//
//   AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs \
//     --experimental-strip-types --env-file=.env.local scripts/freeze-strain-calibration.mjs

import { writeFileSync, mkdirSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const FROM = "2026-04-01";
const TO = "2026-05-31";
const OUT = "scripts/fixtures/strain-calibration-2026.json";

const userId = process.env.AUDIT_USER_ID;
if (!userId) throw new Error("AUDIT_USER_ID is required");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const { data: logs, error: e1 } = await sb
  .from("daily_logs")
  .select("date, strain, resting_hr")
  .eq("user_id", userId)
  .gte("date", FROM)
  .lte("date", TO)
  .not("strain", "is", null)
  .order("date");
if (e1) throw e1;

const { data: acts, error: e2 } = await sb
  .from("garmin_activities")
  .select("external_id, local_date, started_at, duration_s, device_id, activity_type, hr_samples")
  .eq("user_id", userId)
  .gte("local_date", FROM)
  .lte("local_date", TO);
if (e2) throw e2;

const { data: gd, error: e3 } = await sb
  .from("garmin_daily")
  .select("date, raw")
  .eq("user_id", userId)
  .gte("date", FROM)
  .lte("date", TO);
if (e3) throw e3;

const { data: workouts, error: e4 } = await sb
  .from("workouts")
  .select("date, exercises(name, exercise_sets(kg, reps, warmup, rir))")
  .eq("user_id", userId)
  .gte("date", FROM)
  .lte("date", TO);
if (e4) throw e4;

const actsBy = new Map();
for (const a of acts ?? []) {
  if (!actsBy.has(a.local_date)) actsBy.set(a.local_date, []);
  actsBy.get(a.local_date).push(a);
}
const allDayBy = new Map((gd ?? []).map((r) => [r.date, r.raw?.hr_samples ?? null]));

// One workout per date: the richest, matching how the exploratory fit chose.
const woBy = new Map();
for (const w of workouts ?? []) {
  const sets = (w.exercises ?? []).reduce((n, e) => n + (e.exercise_sets ?? []).length, 0);
  const prev = woBy.get(w.date);
  if (!prev || sets > prev.sets) woBy.set(w.date, { sets, exercises: w.exercises ?? [] });
}

const fixture = (logs ?? []).map((l) => ({
  date: l.date,
  whoop_strain: l.strain,
  resting_hr: l.resting_hr ?? 50,
  all_day_samples: allDayBy.get(l.date) ?? null,
  activities: (actsBy.get(l.date) ?? []).map((a) => ({
    external_id: a.external_id,
    started_at: a.started_at,
    duration_s: a.duration_s,
    device_id: a.device_id,
    activity_type: a.activity_type,
    hr_samples: a.hr_samples,
  })),
  exercises: (woBy.get(l.date)?.exercises ?? []).map((e) => ({
    name: e.name,
    sets: (e.exercise_sets ?? []).map((s) => ({
      kg: s.kg,
      reps: s.reps,
      warmup: s.warmup,
      rir: s.rir,
    })),
  })),
}));

mkdirSync("scripts/fixtures", { recursive: true });
writeFileSync(OUT, JSON.stringify(fixture));

const withActivity = fixture.filter((f) => f.activities.length > 0).length;
const withTonnage = fixture.filter((f) => f.exercises.length > 0).length;
const withAllDay = fixture.filter((f) => (f.all_day_samples ?? []).length > 0).length;
console.log(`wrote ${fixture.length} labelled days → ${OUT}`);
console.log(`  with activity: ${withActivity}`);
console.log(`  with tonnage:  ${withTonnage}`);
console.log(`  with all-day HR: ${withAllDay}`);
if (fixture.length < 55) throw new Error(`expected ~61 labelled days, got ${fixture.length} — investigate before proceeding`);
```

- [ ] **Step 2: Run it**

Run:
```bash
AUDIT_USER_ID=94fee5c6-7d9a-4b05-be3a-8407505b5429 \
node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local \
  scripts/freeze-strain-calibration.mjs
```
Expected: `wrote 61 labelled days`, with activity 29, with tonnage 25.

**If `with all-day HR` is 0**, `garmin_daily` has no rows before June. Backfill it first: extend `sidecar/garmin/backfill_activities.py` with a `g.get_heart_rates(day)` pass writing `garmin_daily.raw.hr_samples` for the range, run it, then re-run this freeze. The refit in Task 15 needs the baseline term and cannot proceed without it.

- [ ] **Step 3: Commit the fixture**

```bash
git add scripts/freeze-strain-calibration.mjs scripts/fixtures/strain-calibration-2026.json
git commit -m "feat(strain): freeze the April-May labelled calibration set

WHOOP is disconnected and June was overwritten by the Garmin cutover, so
these 61 rows are the only labelled data that will ever exist. Frozen into
the repo before anything recomputes the column."
```

---

## Task 15: Refit the constants

**Files:**
- Create: `scripts/fit-strain-constants.mjs`
- Modify: `lib/coach/strain/constants.ts`

**Interfaces:**
- Consumes: the fixture (Task 14), `assembleDay` (Task 8).
- Produces: final `STRAIN_CALIBRATION` values under the three-term form.

- [ ] **Step 1: Write the fit script**

Create `scripts/fit-strain-constants.mjs`:

```js
// scripts/fit-strain-constants.mjs
//
// Grid-search A, k, w and mechanicalNorm against the frozen fixture, under the
// THREE-term form (baseline inside the load, not a constant). Prints the best
// fit and a per-day table; writing constants.ts is a manual step so the numbers
// are reviewed before they are frozen.
//
//   node --import ./scripts/alias-loader.mjs --experimental-strip-types \
//        --env-file=.env.local scripts/fit-strain-constants.mjs

import { readFileSync } from "node:fs";
import { banisterOverIntervals } from "@/lib/coach/strain/trimp";
import { toHrSamples, activityWindow } from "@/lib/coach/strain/activity-load";
import { dedupeActivities } from "@/lib/coach/strain/match-sessions";
import { rawTonnage, muscleFactor, intensityFactor, rirFactor } from "@/lib/coach/strain/mechanical-load";

const fixture = JSON.parse(readFileSync("scripts/fixtures/strain-calibration-2026.json", "utf8"));
const HR_MAX = 183;

/** Per-day terms, computed once. mechanicalNorm is applied later so the search
 *  does not have to recompute the weighted sum for every candidate. */
const rows = fixture.map((f) => {
  const { kept } = dedupeActivities(f.activities);
  const excluded = [];
  let activity = 0;
  for (const a of kept) {
    const s = toHrSamples(a.hr_samples);
    if (s.length < 2) continue;
    activity += banisterOverIntervals(s, f.resting_hr, HR_MAX);
    excluded.push(activityWindow(a));
  }
  const baseline = banisterOverIntervals(
    toHrSamples(f.all_day_samples),
    f.resting_hr,
    HR_MAX,
    excluded,
  );
  const exercises = f.exercises.map((e) => ({ ...e, e1rm: bestE1rm(e.sets) }));
  let weighted = 0;
  for (const e of exercises) {
    const mf = muscleFactor(e.name);
    for (const s of e.sets) {
      if (s.warmup) continue;
      const t = (s.kg ?? 0) * (s.reps ?? 0);
      if (!t) continue;
      weighted += t * mf * intensityFactor(s.kg ?? 0, e.e1rm) * rirFactor(s.rir, null);
    }
  }
  return { date: f.date, whoop: f.whoop_strain, baseline, activity, raw: rawTonnage(exercises), weighted };
});

function bestE1rm(sets) {
  let best = null;
  for (const s of sets) {
    if (s.warmup || !s.kg || !s.reps || s.reps < 1 || s.reps > 12) continue;
    const v = s.kg / (1.0278 - 0.0278 * s.reps);
    if (best === null || v > best) best = v;
  }
  return best;
}

// mechanicalNorm restores the raw-tonnage scale the model is fitted against.
const rawSum = rows.reduce((s, r) => s + r.raw, 0);
const weightedSum = rows.reduce((s, r) => s + r.weighted, 0);
const mechanicalNorm = weightedSum > 0 ? rawSum / weightedSum : 1;
console.log(`mechanicalNorm = ${mechanicalNorm.toFixed(6)} (raw ${Math.round(rawSum)} / weighted ${Math.round(weightedSum)})`);

const lin = (a, b, n) => Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));
const geo = (a, b, n) => Array.from({ length: n }, (_, i) => a * (b / a) ** (i / (n - 1)));

let best = null;
for (const A of lin(1, 14, 53))
  for (const k of geo(0.001, 0.5, 40))
    for (const w of geo(0.0005, 0.05, 40)) {
      let se = 0;
      for (const r of rows) {
        const load = r.baseline + r.activity + w * r.weighted * mechanicalNorm;
        const pred = Math.min(21, A * Math.log(1 + k * load));
        se += (pred - r.whoop) ** 2;
      }
      const rmse = Math.sqrt(se / rows.length);
      if (!best || rmse < best.rmse) best = { A: +A.toFixed(3), k: +k.toFixed(5), w: +w.toFixed(6), rmse: +rmse.toFixed(3) };
    }

console.log("\nbest three-term fit:", best, `mechanicalNorm: ${mechanicalNorm.toFixed(6)}`);
console.log("\ndate       whoop  pred   baseline activity  tonnage");
for (const r of rows) {
  const load = r.baseline + r.activity + best.w * r.weighted * mechanicalNorm;
  const pred = Math.min(21, best.A * Math.log(1 + best.k * load));
  console.log(
    r.date,
    String(r.whoop.toFixed(2)).padStart(6),
    String(pred.toFixed(2)).padStart(6),
    String(r.baseline.toFixed(1)).padStart(8),
    String(r.activity.toFixed(1)).padStart(8),
    String(Math.round(r.raw)).padStart(8),
  );
}
```

- [ ] **Step 2: Run the fit**

Run:
```bash
node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local \
  scripts/fit-strain-constants.mjs
```
Expected: an RMSE at or below 1.56 (the two-term baseline), and rest days no longer all predicting an identical value.

**If RMSE exceeds 1.8**, stop and report before editing constants — the audit gate in Task 17 asserts ≤ 1.8, and shipping constants that fail their own gate is worse than shipping the provisional ones.

- [ ] **Step 3: Freeze the fitted values**

Edit `lib/coach/strain/constants.ts`, replacing the `STRAIN_CALIBRATION` block with the printed values and this provenance comment:

```ts
/** Fitted strain constants.
 *
 *  Fitted <YYYY-MM-DD> by scripts/fit-strain-constants.mjs against
 *  scripts/fixtures/strain-calibration-2026.json — 61 labelled April–May 2026
 *  days carrying WHOOP's own strength-adjusted values, the only labelled data
 *  that will ever exist for this athlete. RMSE <value>.
 *
 *  Three-term form: strain = min(21, A·ln(1 + k·(baseline + activity + w·mechanical))).
 *
 *  `w` converts tonnage-equivalent kilograms into TRIMP units.
 *  `mechanicalNorm` rescales the muscle/intensity/RIR-weighted sum back onto
 *  the raw-tonnage scale the fit was performed on, so those factors
 *  redistribute load between exercises without moving the aggregate.
 *
 *  Do not hand-tune. scripts/audit-strain-calibration.mjs asserts these
 *  reproduce the fixture within RMSE 1.8 and will fail if they drift. */
export const STRAIN_CALIBRATION = {
  A: <fitted>,
  k: <fitted>,
  w: <fitted>,
  mechanicalNorm: <fitted>,
} as const;
```

- [ ] **Step 4: Re-run the unit suite**

Run: `npx vitest run lib/coach/strain && npm run typecheck`
Expected: PASS. The compose tests read `STRAIN_CALIBRATION` rather than hardcoding, so they survive the change. If `mechanical-load.test.ts`'s "within ±15% of raw tonnage" assertion now fails, the new `mechanicalNorm` has moved the aggregate — widen that assertion to `±15% × mechanicalNorm` and note why in the test.

- [ ] **Step 5: Commit**

```bash
git add scripts/fit-strain-constants.mjs lib/coach/strain/constants.ts lib/coach/strain/__tests__/mechanical-load.test.ts
git commit -m "feat(strain): refit constants under the three-term form"
```

---

## Task 16: Recompute the strain history

**Files:**
- Create: `scripts/backfill-fused-strain.mjs`

**Interfaces:**
- Consumes: `recomputeStrainForDay` (Task 9), final constants (Task 15).
- Produces: `daily_logs.strain` recomputed from the all-day-HR floor forward.

- [ ] **Step 1: Confirm the gate passed**

Run: `git log --oneline --all | grep -c "freeze the April-May labelled calibration set"`
Expected: `1`. If `0`, stop — Task 14 has not landed and this task would destroy the calibration set.

- [ ] **Step 2: Write the backfill script**

Create `scripts/backfill-fused-strain.mjs`:

```js
// scripts/backfill-fused-strain.mjs
//
// Recompute daily_logs.strain across the range where all-day HR exists, so the
// whole series uses one formula. Prints a before/after diff and requires --yes.
//
// Jan-Mar 2026 is deliberately NOT touched: no Garmin all-day HR exists for it,
// so those rows stay WHOOP-legacy and the boundary is a known discontinuity.
//
//   AUDIT_USER_ID=<uuid> RANGE_START=2026-04-01 \
//   node --import ./scripts/alias-loader.mjs --experimental-strip-types \
//        --env-file=.env.local scripts/backfill-fused-strain.mjs --yes

import { createClient } from "@supabase/supabase-js";
import { recomputeStrainForDay } from "@/lib/coach/strain/recompute";

const userId = process.env.AUDIT_USER_ID;
if (!userId) throw new Error("AUDIT_USER_ID is required");
const start = process.env.RANGE_START;
if (!start) throw new Error("RANGE_START is required (the all-day-HR floor)");

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const { data: before, error } = await sb
  .from("daily_logs")
  .select("date, strain")
  .eq("user_id", userId)
  .gte("date", start)
  .order("date");
if (error) throw error;

console.log(`${before.length} days from ${start}`);
if (!process.argv.includes("--yes")) {
  console.log("dry run — pass --yes to write. Recomputing first 10 for preview:");
  for (const row of before.slice(0, 10)) {
    console.log(`  ${row.date}  stored=${row.strain?.toFixed(2) ?? "-"}`);
  }
  process.exit(0);
}

let changed = 0;
let skipped = 0;
for (const row of before) {
  const res = await recomputeStrainForDay({ supabase: sb, userId, dateIso: row.date });
  if (res.strain === null) {
    skipped++;
    continue;
  }
  const delta = res.strain - (row.strain ?? 0);
  if (Math.abs(delta) > 0.005) changed++;
  console.log(
    `${row.date}  ${String((row.strain ?? 0).toFixed(2)).padStart(6)} → ${String(res.strain.toFixed(2)).padStart(6)}  ${delta >= 0 ? "+" : ""}${delta.toFixed(2)}`,
  );
}
console.log(`\n${changed} changed, ${skipped} skipped (no input), ${before.length} total`);
```

- [ ] **Step 3: Dry-run**

Run:
```bash
AUDIT_USER_ID=94fee5c6-7d9a-4b05-be3a-8407505b5429 RANGE_START=<floor> \
node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local \
  scripts/backfill-fused-strain.mjs
```
Expected: the day count and a 10-row preview.

- [ ] **Step 4: Apply, and sanity-check the result**

Run the same command with `--yes`, then:

```bash
node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local -e "
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { data } = await sb.from('daily_logs').select('date, strain').eq('user_id', '94fee5c6-7d9a-4b05-be3a-8407505b5429').gte('date','2026-06-01').not('strain','is',null).order('date');
const v = data.map(r => r.strain).sort((a,b)=>a-b);
const q = p => v[Math.floor(p*(v.length-1))];
console.log('n', v.length, 'p10', q(.1).toFixed(2), 'p50', q(.5).toFixed(2), 'p90', q(.9).toFixed(2), 'max', v[v.length-1].toFixed(2));
console.log('zero days:', v.filter(x => x < 0.5).length);
"
```
Expected: p90 materially above the pre-change 11.03, and near-zero days largely gone. Specifically check 2026-08-10 (19,913 kg) is no longer ~5.

- [ ] **Step 5: Commit**

```bash
git add scripts/backfill-fused-strain.mjs
git commit -m "feat(strain): recompute strain history under the fused model"
```

---

## Task 17: Audit scripts

**Files:**
- Create: `scripts/audit-strain-calibration.mjs`, `scripts/audit-strain-recompute.mjs`

**Interfaces:**
- Consumes: the fixture (Task 14), `assembleDay` (Task 8), `recomputeStrainForDay` (Task 9), `createAuditReporter` from `./audit-utils.mjs`.
- Produces: two runnable regression gates.

- [ ] **Step 1: Write the calibration audit**

Create `scripts/audit-strain-calibration.mjs`:

```js
// scripts/audit-strain-calibration.mjs
//
// Replays the frozen calibration fixture through the live composer and asserts
// the model still reproduces WHOOP's labelled days. THE regression gate for the
// strain model: touching constants.ts, compose.ts, or the mechanical weighting
// without re-running the fit will fail here.
//
// No DB access — fixture only.
//
//   node --import ./scripts/alias-loader.mjs --experimental-strip-types \
//        --env-file=.env.local scripts/audit-strain-calibration.mjs

import { readFileSync } from "node:fs";
import { assembleDay } from "@/lib/coach/strain";
import { rawTonnage, mechanicalLoad } from "@/lib/coach/strain/mechanical-load";
import { createAuditReporter } from "./audit-utils.mjs";

const { assert, summary } = createAuditReporter();
const fixture = JSON.parse(readFileSync("scripts/fixtures/strain-calibration-2026.json", "utf8"));
const HR_MAX = 183;
const RMSE_CEILING = 1.8;

assert("fixture has the full labelled set", fixture.length >= 55);

function bestE1rm(sets) {
  let best = null;
  for (const s of sets) {
    if (s.warmup || !s.kg || !s.reps || s.reps < 1 || s.reps > 12) continue;
    const v = s.kg / (1.0278 - 0.0278 * s.reps);
    if (best === null || v > best) best = v;
  }
  return best;
}

let se = 0;
let worst = { date: null, err: 0 };
const predictions = [];
for (const f of fixture) {
  const exercises = f.exercises.map((e) => ({ ...e, e1rm: bestE1rm(e.sets) }));
  const startMs = Date.parse(`${f.date}T00:00:00Z`);
  const r = assembleDay({
    allDaySamples: (f.all_day_samples ?? []).map(([ts, bpm]) => ({ ts, bpm })),
    activities: f.activities,
    workouts: exercises.length ? [{ workout_id: f.date, startMs, endMs: startMs + 86_400_000, exercises }] : [],
    hrRest: f.resting_hr,
    hrMax: HR_MAX,
    rirTarget: null,
  });
  const err = r.strain - f.whoop_strain;
  se += err ** 2;
  if (Math.abs(err) > Math.abs(worst.err)) worst = { date: f.date, err };
  predictions.push({ date: f.date, whoop: f.whoop_strain, pred: r.strain, load: r.load });
}
const rmse = Math.sqrt(se / fixture.length);

console.log(`RMSE ${rmse.toFixed(3)} over ${fixture.length} labelled days`);
console.log(`worst residual: ${worst.date} ${worst.err > 0 ? "+" : ""}${worst.err.toFixed(2)}`);
assert(`RMSE ${rmse.toFixed(3)} within ceiling ${RMSE_CEILING}`, rmse <= RMSE_CEILING);

// Scale preservation: the mechanical refinements must redistribute, not rescale.
let rawSum = 0;
let loadSum = 0;
for (const f of fixture) {
  const exercises = f.exercises.map((e) => ({ ...e, e1rm: bestE1rm(e.sets) }));
  rawSum += rawTonnage(exercises);
  loadSum += mechanicalLoad(exercises, null);
}
const ratio = rawSum > 0 ? loadSum / rawSum : 1;
console.log(`mechanical scale ratio: ${ratio.toFixed(4)}`);
assert("mechanical weighting preserves the aggregate tonnage scale", Math.abs(ratio - 1) < 0.02);

// The two regressions that motivated the work.
const heavy = predictions.filter((p) => p.load.mechanical > 14_000);
assert("heavy sessions score above 13", heavy.length > 0 && heavy.every((p) => p.pred > 13));
const rest = predictions.filter((p) => p.load.mechanical === 0 && p.load.activity === 0);
assert("living days score above zero", rest.length > 0 && rest.every((p) => p.pred > 0));

summary();
```

- [ ] **Step 2: Run it**

Run:
```bash
node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local \
  scripts/audit-strain-calibration.mjs
```
Expected: all assertions pass, RMSE ≤ 1.8.

- [ ] **Step 3: Write the recompute audit**

Create `scripts/audit-strain-recompute.mjs`:

```js
// scripts/audit-strain-recompute.mjs
//
// Verifies stored daily_logs.strain equals a fresh recompute for the last 30
// days. Catches ingest drift, a missed recompute trigger, and any second writer
// reappearing on the column.
//
//   AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs \
//     --experimental-strip-types --env-file=.env.local scripts/audit-strain-recompute.mjs

import { createClient } from "@supabase/supabase-js";
import { recomputeStrainForDay } from "@/lib/coach/strain/recompute";
import { createAuditReporter } from "./audit-utils.mjs";

const { assert, summary } = createAuditReporter();
const userId = process.env.AUDIT_USER_ID;
if (!userId) throw new Error("AUDIT_USER_ID is required");

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
const { data: rows, error } = await sb
  .from("daily_logs")
  .select("date, strain")
  .eq("user_id", userId)
  .gte("date", since)
  .order("date");
if (error) throw error;

let mismatches = 0;
for (const row of rows) {
  const fresh = await recomputeStrainForDay({ supabase: sb, userId, dateIso: row.date });
  if (fresh.strain === null) continue;
  const drift = Math.abs(fresh.strain - (row.strain ?? 0));
  if (drift > 0.01) {
    mismatches++;
    console.log(`  ${row.date}: stored ${row.strain?.toFixed(2)} vs fresh ${fresh.strain.toFixed(2)}`);
  }
}
assert(`stored strain matches recompute for all ${rows.length} recent days`, mismatches === 0);

const nulls = rows.filter((r) => r.strain === null).length;
console.log(`${nulls}/${rows.length} days have no strain (no HR and no workout)`);

summary();
```

- [ ] **Step 4: Run it**

Run:
```bash
AUDIT_USER_ID=94fee5c6-7d9a-4b05-be3a-8407505b5429 \
node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local \
  scripts/audit-strain-recompute.mjs
```
Expected: zero mismatches. Note this audit is itself a writer — it recomputes into the same rows, so a mismatch is reported once and self-heals.

- [ ] **Step 5: Commit**

```bash
git add scripts/audit-strain-calibration.mjs scripts/audit-strain-recompute.mjs
git commit -m "feat(strain): calibration and recompute audit gates"
```

---

## Task 18: Documentation

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add the migration entry**

In the "Database migrations" list, after entry 50 (`0057_superset_group.sql`), add:

```markdown
51. [supabase/migrations/0058_fused_strain.sql](supabase/migrations/0058_fused_strain.sql) — adds `garmin_activities` (per-activity row with the raw `hr_samples` stream, derived `trimp`, `hr_source`, and `superseded_by` for cross-device dedup) and `daily_logs.hr_sample_density`. Backs the fused strain model: `daily_logs.strain` is no longer Edwards TRIMP over the 2-minute all-day stream but `min(21, A·ln(1 + k·(baseline + activity + w·mechanical)))`, calibrated against 61 labelled April–May 2026 days frozen at [scripts/fixtures/strain-calibration-2026.json](scripts/fixtures/strain-calibration-2026.json).
```

Update the "Next free slot" line at the end of that section from **0058** to **0059**.

- [ ] **Step 2: Update the data-source ownership section**

In the **Garmin** bullet under "Data sources & precedence", replace the sentence describing strain derivation with:

```markdown
Strain is NO LONGER derived in this route. `recomputeStrainForDay` ([lib/coach/strain/recompute.ts](lib/coach/strain/recompute.ts)) is the single writer of `daily_logs.strain` and fuses three terms — baseline TRIMP from the all-day stream with activity windows excluded, activity TRIMP from each `garmin_activities` HR stream at native density, and mechanical load from the logger's non-warmup sets — through one saturating curve. Called from the Garmin ingest, `POST /api/logger/session` and `DELETE /api/logger/session/[workout_id]`, all non-fatally. `garmin_daily.trimp_edwards` / `trimp_banister` remain as shadow columns. Constants are frozen in [lib/coach/strain/constants.ts](lib/coach/strain/constants.ts) and must not be hand-tuned — `scripts/audit-strain-calibration.mjs` asserts they reproduce the frozen fixture within RMSE 1.8. Activity↔workout matching is tolerant (interval overlap AND starts within 30 min) because the watch activity and the logger session are started separately. Cross-device dedup is window-based, not ID-based, since a 24/7 band records the same session under a different `external_id`. Spec: [docs/superpowers/specs/2026-08-12-fused-strain-design.md](docs/superpowers/specs/2026-08-12-fused-strain-design.md).
```

- [ ] **Step 3: Add the audit scripts to the Scripts section**

```markdown
- [scripts/audit-strain-calibration.mjs](scripts/audit-strain-calibration.mjs) — replays the frozen 61-day labelled fixture through the live composer and asserts RMSE ≤ 1.8 plus mechanical scale preservation. No DB access. The regression gate for the strain model. Run via: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-strain-calibration.mjs`.
- [scripts/audit-strain-recompute.mjs](scripts/audit-strain-recompute.mjs) — verifies stored `daily_logs.strain` equals a fresh recompute for the last 30 days. Set `AUDIT_USER_ID`.
```

- [ ] **Step 4: Full verification**

Run: `npm run typecheck && npx vitest run && node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-strain-calibration.mjs`
Expected: typecheck exit 0, all vitest suites pass, all audit assertions pass.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(strain): record the fused strain model and its audit gates"
```

---

## Deferred, deliberately

Recorded so a later reader knows these were decisions, not oversights:

- **Jan–Mar 2026 strain stays WHOOP-legacy.** No Garmin all-day HR exists for that range, so it cannot be recomputed. The boundary is a known discontinuity in the series.
- **HRmax stays the Tanaka estimate.** Observed max across the window is 182 against an estimate of 183, so refining it from observed peaks buys nothing today.
- **No UI work.** `daily_logs.strain` is replaced in place and every existing consumer inherits the new number. `deriveReadiness` does not read strain, so readiness is untouched.
- **`training_readiness` on a device split** — if the Fenix is worn only for cardio and CIRQA does not report Training Readiness, `daily_logs.recovery` goes null on strength days. Separate work; flagged in the spec's open risks.
- **CIRQA sampling density is unverified** until the hardware exists. `hr_sample_density` makes any degradation visible rather than silent.
