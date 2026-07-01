# Garmin Fenix 8 Ingest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ingest Garmin Fenix 8 health data into the app as a drop-in replacement for WHOOP's recovery/strain source, proved out by a month-long parallel run.

**Architecture:** A thin Python `python-garminconnect` sidecar pulls raw daily metrics and POSTs them to a new `/api/ingest/garmin` route. The route stores raw data in a `garmin_daily` shadow table, derives a WHOOP-parity 0–21 strain (TRIMP → log map) and maps Training Readiness → recovery, then writes `daily_logs` only when `profiles.metrics_source = 'garmin'` (the cutover knob). All derivation lives in TypeScript; the sidecar stays dumb.

**Tech Stack:** Next.js 15 App Router, Supabase (Postgres + RLS), TypeScript (strict), Zod, Python 3 + `python-garminconnect`, Node fixture-audit scripts run via `alias-loader.mjs`.

## Global Constraints

- Path alias `@/*` → repo root. Use it, not relative climbs.
- Number display: max 2 decimals, trailing zeros trimmed — but this plan produces backend/data code; `fmtNum()` applies only if you touch UI (you don't here).
- `daily_logs.calories`, `daily_logs.active_calories`, `daily_logs.steps`, `daily_logs.calories_eaten` are **INTEGER** columns — `Math.round()` before upsert.
- No new "today"/date code may call `new Date().toISOString().slice(0,10)` in app code paths gated by the timezone audit; the ingest route keys by the `date` string the sidecar sends (already local-day-attributed), so it is exempt, but do not compute "today" inside the route.
- There is **no TS test framework**; pure-function verification is done with fixture **audit scripts** in the style of `scripts/audit-prescription-rules.mjs`, run via `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/<name>.mjs`. "Write the failing test" means "add the assertion to the audit script."
- Migration number is **0046** (`0045_per_set_rir.sql` already exists). Apply it via the **Supabase Dashboard SQL editor** by pasting the file contents — NOT `supabase db push`, which is blocked by a pre-existing duplicate `0026` prefix in the migration history (same path every recent arc took). **Applying the migration is a controller/user step, never a subagent action.** Implementers write the `.sql` file and stop there.
- Verify TypeScript with `npm run typecheck` (strict, `tsc --noEmit`). There is no working linter.

---

### Task 1: Migration + type plumbing

**Files:**
- Create: `supabase/migrations/0046_garmin_ingest.sql`
- Modify: `lib/data/types.ts` (add `metrics_source` to `Profile`; add `GarminDailyRow`)
- Modify: `lib/ingest/auth.ts:22-25` (widen `resolveIngestToken` source union)

**Interfaces:**
- Produces: `garmin_daily` table; `profiles.metrics_source text NOT NULL DEFAULT 'whoop'`; TS types `Profile.metrics_source: 'whoop' | 'garmin'` and `GarminDailyRow`; `resolveIngestToken(raw, source)` accepts `"garmin"`.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0046_garmin_ingest.sql`:

```sql
-- 0046_garmin_ingest.sql
-- Garmin Fenix 8 ingest: shadow/audit table + cutover knob.

-- Single source-of-truth knob for who owns the recovery/strain cluster on
-- daily_logs. WHOOP and Garmin are mutually exclusive owners.
alter table profiles
  add column if not exists metrics_source text not null default 'whoop'
    check (metrics_source in ('whoop', 'garmin'));

-- Raw + derived per-day Garmin data. Always written by the ingest route (audit
-- trail + Phase-1 shadow store); daily_logs is written separately, gated by
-- profiles.metrics_source.
create table if not exists garmin_daily (
  user_id uuid not null references auth.users (id) on delete cascade,
  date date not null,
  -- raw vitals
  hrv numeric,
  resting_hr numeric,
  training_readiness numeric,      -- 0-100, maps to daily_logs.recovery
  body_battery_low numeric,
  body_battery_peak numeric,
  sleep_hours numeric,
  sleep_score numeric,
  deep_sleep_hours numeric,
  rem_sleep_hours numeric,
  sleep_start_at timestamptz,
  sleep_end_at timestamptz,
  respiratory_rate numeric,
  steps integer,
  distance_km numeric,
  calories integer,
  active_calories integer,
  spo2 numeric,                    -- stored, flagged unreliable, not trusted
  skin_temp_variation numeric,
  acute_load numeric,
  chronic_load numeric,
  vo2max numeric,
  -- derived
  strain numeric,                  -- 0-21, WHOOP-parity, from TRIMP
  trimp_edwards numeric,
  trimp_banister numeric,
  raw jsonb,                       -- full sidecar payload for the day
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, date)
);

alter table garmin_daily enable row level security;

create policy "garmin_daily self select" on garmin_daily
  for select using (auth.uid() = user_id);
create policy "garmin_daily self modify" on garmin_daily
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
```

- [ ] **Step 2: Apply the migration (CONTROLLER/USER STEP — not the implementer)**

Do NOT run `supabase db push` (blocked by the duplicate `0026` prefix). The implementer writes the `.sql` file and stops. The controller (or user) applies it by pasting the file contents into the **Supabase Dashboard → SQL Editor** and running it.
Expected after apply: `garmin_daily` table exists and `profiles.metrics_source` column exists (default `'whoop'`). Live-DB verification steps in later tasks (Task 4 smoke, Task 7 audit) depend on this apply having happened.

- [ ] **Step 3: Widen the ingest-token source union**

In `lib/ingest/auth.ts`, change the `resolveIngestToken` signature (lines 22-25):

```typescript
export async function resolveIngestToken(
  rawToken: string,
  source: "apple_health" | "strong" | "yazio" | "garmin",
): Promise<string | null> {
```

- [ ] **Step 4: Add TS types**

In `lib/data/types.ts`, add to the `Profile` type (after `timezone: string;`):

```typescript
  /** Which integration owns the recovery/strain cluster on daily_logs.
   *  'whoop' (default) or 'garmin'. The single cutover knob: the WHOOP sync
   *  cron and the Garmin ingest route each write daily_logs only when this
   *  matches their source. Migration 0046. */
  metrics_source: "whoop" | "garmin";
```

Then add a new exported type (near the other row types):

```typescript
/** Raw + derived per-day Garmin data (migration 0046). Shadow/audit store;
 *  daily_logs is written separately, gated by profiles.metrics_source. */
export type GarminDailyRow = {
  user_id: string;
  date: string; // YYYY-MM-DD (local day, attributed by the sidecar)
  hrv: number | null;
  resting_hr: number | null;
  training_readiness: number | null;
  body_battery_low: number | null;
  body_battery_peak: number | null;
  sleep_hours: number | null;
  sleep_score: number | null;
  deep_sleep_hours: number | null;
  rem_sleep_hours: number | null;
  sleep_start_at: string | null;
  sleep_end_at: string | null;
  respiratory_rate: number | null;
  steps: number | null;
  distance_km: number | null;
  calories: number | null;
  active_calories: number | null;
  spo2: number | null;
  skin_temp_variation: number | null;
  acute_load: number | null;
  chronic_load: number | null;
  vo2max: number | null;
  strain: number | null;
  trimp_edwards: number | null;
  trimp_banister: number | null;
  raw: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};
```

- [ ] **Step 5: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS (no errors). The widened union and new types compile.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0046_garmin_ingest.sql lib/data/types.ts lib/ingest/auth.ts
git commit -m "feat(garmin): migration + type plumbing for Garmin ingest"
```

---

### Task 2: Strain derivation module

**Files:**
- Create: `lib/coach/garmin/derive-strain.ts`
- Create: `scripts/audit-garmin-strain.mjs`

**Interfaces:**
- Produces:
  - `hrZone(bpm: number, hrMax: number): 0 | 1 | 2 | 3 | 4 | 5`
  - `edwardsTrimp(samples: HrSample[], hrMax: number): number`
  - `banisterTrimp(samples: HrSample[], hrRest: number, hrMax: number): number`
  - `trimpToStrain(trimp: number, cal?: StrainCalibration): number`
  - `type HrSample = { ts: number; bpm: number }` (ts = epoch ms)
  - `type StrainCalibration = { A: number; k: number }`
  - `DEFAULT_STRAIN_CALIBRATION: StrainCalibration`

- [ ] **Step 1: Write the failing audit assertions**

Create `scripts/audit-garmin-strain.mjs`:

```javascript
// Fixture-based audit for lib/coach/garmin/derive-strain.ts. No DB access.
// Run: node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-garmin-strain.mjs
import {
  hrZone,
  edwardsTrimp,
  banisterTrimp,
  trimpToStrain,
  DEFAULT_STRAIN_CALIBRATION,
} from "@/lib/coach/garmin/derive-strain.ts";

let passed = 0;
let failed = 0;
function assert(name, cond) {
  if (cond) { passed++; }
  else { failed++; console.error("FAIL:", name); }
}
function approx(a, b, eps = 1e-6) { return Math.abs(a - b) <= eps; }

// hrZone: half-open bands on %HRmax. hrMax=200 → Z1 100-119, Z2 120-139,
// Z3 140-159, Z4 160-179, Z5 180+. Below 100 (50%) = zone 0.
assert("zone below Z1", hrZone(90, 200) === 0);
assert("zone Z1 lower edge", hrZone(100, 200) === 1);
assert("zone Z2", hrZone(130, 200) === 2);
assert("zone Z3", hrZone(150, 200) === 3);
assert("zone Z4", hrZone(170, 200) === 4);
assert("zone Z5 lower edge", hrZone(180, 200) === 5);
assert("zone Z5 above max", hrZone(210, 200) === 5);

// Edwards TRIMP: each sample = 2 min (inferred from 2-min spacing) × zone weight.
// Three samples 2 min apart, all in Z3 (weight 3) → 3 samples, but the last
// sample has no following delta so it uses the median spacing (2 min).
const z3samples = [
  { ts: 0, bpm: 150 },
  { ts: 120_000, bpm: 150 },
  { ts: 240_000, bpm: 150 },
];
// 3 samples × 2 min × weight 3 = 18
assert("edwards all-Z3", approx(edwardsTrimp(z3samples, 200), 18));

// Zone-0 samples contribute nothing.
const restSamples = [
  { ts: 0, bpm: 60 },
  { ts: 120_000, bpm: 60 },
];
assert("edwards rest = 0", approx(edwardsTrimp(restSamples, 200), 0));

// Banister (men's): per sample duration(min) × HRr × 0.64·e^(1.92·HRr),
// HRr=(bpm-rest)/(max-rest). One 2-min sample at bpm=150, rest=50, max=200:
// HRr=0.6667; y=0.64·e^(1.28)=0.64·3.5966=2.3018; TRIMP=2·0.6667·2.3018=3.069
assert(
  "banister single sample",
  approx(banisterTrimp([{ ts: 0, bpm: 150 }, { ts: 120_000, bpm: 150 }], 50, 200), 2 * (100 / 150) * (0.64 * Math.exp(1.92 * (100 / 150))), 1e-3),
);

// trimpToStrain: saturating log, bounded at 21, monotonic, 0→0.
assert("strain at 0 trimp", approx(trimpToStrain(0), 0));
assert("strain bounded at 21", trimpToStrain(1e9) <= 21);
assert("strain monotonic", trimpToStrain(50) < trimpToStrain(150));
assert(
  "strain uses default cal",
  approx(trimpToStrain(100), Math.min(21, DEFAULT_STRAIN_CALIBRATION.A * Math.log(1 + DEFAULT_STRAIN_CALIBRATION.k * 100))),
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 1 : 0); // exit 1 while unimplemented (see Step 2)
```

Note the deliberately inverted exit code in Step 1 so Step 2 "fails" cleanly; you will flip it in Step 4.

- [ ] **Step 2: Run the audit to verify it fails**

Run: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-garmin-strain.mjs`
Expected: FAIL — module not found (`Cannot find module '@/lib/coach/garmin/derive-strain.ts'`).

- [ ] **Step 3: Write the implementation**

Create `lib/coach/garmin/derive-strain.ts`:

```typescript
// Derive a WHOOP-parity 0-21 daily strain from a Garmin all-day HR stream.
// Two TRIMP methods (Edwards, Banister-men) → saturating log map. Pure; no DB.
// Spec: docs/superpowers/specs/2026-07-01-garmin-fenix-ingest-design.md §5

export type HrSample = { ts: number; bpm: number }; // ts = epoch ms
export type StrainCalibration = { A: number; k: number };

/** Initial calibration; refined against WHOOP during the parallel month.
 *  Chosen so a ~all-out day (TRIMP ≈ 300) lands near 20 and an easy day
 *  (TRIMP ≈ 30) lands ~7. Update after the audit fit (Task 7). */
export const DEFAULT_STRAIN_CALIBRATION: StrainCalibration = { A: 4.2, k: 0.05 };

/** Half-open zone bands on %HRmax: Z1 50-59, Z2 60-69, Z3 70-79, Z4 80-89,
 *  Z5 90+. Below 50% → 0 (no strain contribution). */
export function hrZone(bpm: number, hrMax: number): 0 | 1 | 2 | 3 | 4 | 5 {
  const pct = (bpm / hrMax) * 100;
  if (pct < 50) return 0;
  if (pct < 60) return 1;
  if (pct < 70) return 2;
  if (pct < 80) return 3;
  if (pct < 90) return 4;
  return 5;
}

/** Median gap between consecutive samples, in minutes. Fallback 2 min for a
 *  single sample (Garmin all-day HR is 2-min-sampled). Used to give each
 *  sample a duration weight. */
function sampleMinutes(samples: HrSample[]): number {
  if (samples.length < 2) return 2;
  const gaps: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const g = (samples[i].ts - samples[i - 1].ts) / 60_000;
    if (g > 0 && g < 60) gaps.push(g); // ignore gaps/outliers (device off-wrist)
  }
  if (gaps.length === 0) return 2;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

/** Edwards TRIMP: Σ (minutes-per-sample × zone weight 1..5). Needs only hrMax. */
export function edwardsTrimp(samples: HrSample[], hrMax: number): number {
  const mins = sampleMinutes(samples);
  let trimp = 0;
  for (const s of samples) {
    trimp += mins * hrZone(s.bpm, hrMax);
  }
  return trimp;
}

/** Banister TRIMP (men's coefficients): Σ duration(min) × HRr × 0.64·e^(1.92·HRr),
 *  HRr = (bpm - hrRest) / (hrMax - hrRest), clamped to [0, 1]. */
export function banisterTrimp(
  samples: HrSample[],
  hrRest: number,
  hrMax: number,
): number {
  const mins = sampleMinutes(samples);
  const reserve = hrMax - hrRest;
  if (reserve <= 0) return 0;
  let trimp = 0;
  for (const s of samples) {
    let hrr = (s.bpm - hrRest) / reserve;
    if (hrr < 0) hrr = 0;
    if (hrr > 1) hrr = 1;
    trimp += mins * hrr * (0.64 * Math.exp(1.92 * hrr));
  }
  return trimp;
}

/** Map a raw TRIMP to a bounded 0-21 strain via a saturating log transform. */
export function trimpToStrain(
  trimp: number,
  cal: StrainCalibration = DEFAULT_STRAIN_CALIBRATION,
): number {
  if (trimp <= 0) return 0;
  return Math.min(21, cal.A * Math.log(1 + cal.k * trimp));
}
```

- [ ] **Step 4: Flip the audit exit code and run to verify it passes**

In `scripts/audit-garmin-strain.mjs`, change the last line to:

```javascript
process.exit(failed === 0 ? 0 : 1);
```

Run: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-garmin-strain.mjs`
Expected: `13 passed, 0 failed`, exit 0.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`
Expected: PASS

```bash
git add lib/coach/garmin/derive-strain.ts scripts/audit-garmin-strain.mjs
git commit -m "feat(garmin): TRIMP-based 0-21 strain derivation + audit"
```

---

### Task 3: Raw-Garmin → daily_logs mapper

**Files:**
- Create: `lib/coach/garmin/map-metrics.ts`
- Modify: `scripts/audit-garmin-strain.mjs` (append mapper assertions — reuses the same audit runner)

**Interfaces:**
- Consumes: `GarminDailyRow` (Task 1).
- Produces:
  - `type GarminDayInput` (the validated sidecar per-day shape — see Step 3)
  - `mapToDailyLogs(input: GarminDayInput, strain: number | null): Partial<DailyLog> & { user_id: string; date: string; source: "garmin" }`

- [ ] **Step 1: Append failing assertions to the audit script**

Add to `scripts/audit-garmin-strain.mjs` (before the `console.log` summary), and add the import at the top:

```javascript
import { mapToDailyLogs } from "@/lib/coach/garmin/map-metrics.ts";

const mapped = mapToDailyLogs(
  {
    date: "2026-07-01",
    hrv: 68,
    resting_hr: 52,
    training_readiness: 74,
    sleep_hours: 7.4,
    sleep_score: 81,
    steps: 8421.6,        // sidecar may send float; column is int
    distance_km: 6.2,
    calories: 2480.9,
    active_calories: 612.4,
    respiratory_rate: 14.2,
  },
  12.5,
);
assert("map recovery = readiness", mapped.recovery === 74);
assert("map strain passthrough", mapped.strain === 12.5);
assert("map steps rounded int", mapped.steps === 8422);
assert("map calories rounded int", mapped.calories === 2481);
assert("map active_calories rounded int", mapped.active_calories === 612);
assert("map source tag", mapped.source === "garmin");
assert("map keeps user/date keys", mapped.date === "2026-07-01");
// Absent fields must not appear as null keys that would clobber other sources.
assert("map omits absent spo2", !("spo2" in mapped));
```

- [ ] **Step 2: Run to verify new assertions fail**

Run: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-garmin-strain.mjs`
Expected: FAIL — `Cannot find module '@/lib/coach/garmin/map-metrics.ts'`.

- [ ] **Step 3: Write the implementation**

Create `lib/coach/garmin/map-metrics.ts`:

```typescript
// Pure mapper: validated Garmin per-day input → daily_logs partial row.
// Training Readiness → recovery; strain is passed in (derived in Task 2).
// Only present fields are emitted, so a missing metric never clobbers another
// source's column. Int columns are rounded. Spec §4.

import type { DailyLog } from "@/lib/data/types";

/** The per-day shape the ingest route forwards after Zod validation. All
 *  metric fields optional; absence means "Garmin had no value that day". */
export type GarminDayInput = {
  date: string;
  hrv?: number;
  resting_hr?: number;
  training_readiness?: number;
  sleep_hours?: number;
  sleep_score?: number;
  deep_sleep_hours?: number;
  rem_sleep_hours?: number;
  sleep_start_at?: string;
  sleep_end_at?: string;
  respiratory_rate?: number;
  steps?: number;
  distance_km?: number;
  calories?: number;
  active_calories?: number;
  spo2?: number;
  skin_temp_variation?: number;
};

type MappedRow = Partial<DailyLog> & {
  user_id: string;
  date: string;
  source: "garmin";
};

const INT_FIELDS = new Set(["steps", "calories", "active_calories"]);

export function mapToDailyLogs(
  input: GarminDayInput,
  strain: number | null,
): Omit<MappedRow, "user_id"> {
  // user_id is attached by the route; keep this mapper pure over the payload.
  const row: Record<string, unknown> = {
    date: input.date,
    source: "garmin",
  };

  // Direct raw → column mappings. Skin temp is intentionally NOT mapped
  // (Garmin reports variation, not absolute °C — spec open question, left null).
  const direct: Array<[keyof GarminDayInput, keyof DailyLog]> = [
    ["hrv", "hrv"],
    ["resting_hr", "resting_hr"],
    ["training_readiness", "recovery"],
    ["sleep_hours", "sleep_hours"],
    ["sleep_score", "sleep_score"],
    ["deep_sleep_hours", "deep_sleep_hours"],
    ["rem_sleep_hours", "rem_sleep_hours"],
    ["sleep_start_at", "sleep_start_at"],
    ["sleep_end_at", "sleep_end_at"],
    ["respiratory_rate", "respiratory_rate"],
    ["steps", "steps"],
    ["distance_km", "distance_km"],
    ["calories", "calories"],
    ["active_calories", "active_calories"],
    ["spo2", "spo2"],
  ];

  for (const [src, col] of direct) {
    const v = input[src];
    if (v === undefined || v === null) continue;
    row[col] = INT_FIELDS.has(col as string) && typeof v === "number"
      ? Math.round(v)
      : v;
  }

  if (strain !== null && strain !== undefined) row.strain = strain;

  return row as Omit<MappedRow, "user_id">;
}
```

- [ ] **Step 4: Run the audit to verify it passes**

Run: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-garmin-strain.mjs`
Expected: `21 passed, 0 failed`, exit 0.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`
Expected: PASS

```bash
git add lib/coach/garmin/map-metrics.ts scripts/audit-garmin-strain.mjs
git commit -m "feat(garmin): raw-metric → daily_logs mapper + audit"
```

---

### Task 4: `/api/ingest/garmin` route

**Files:**
- Create: `app/api/ingest/garmin/route.ts`
- Create: `scratchpad sample payload` (local only, not committed)

**Interfaces:**
- Consumes: `resolveIngestToken(raw, "garmin")` (Task 1), `deriveStrain` helpers (Task 2), `mapToDailyLogs` + `GarminDayInput` (Task 3), `garmin_daily` + `profiles.metrics_source` (Task 1).
- Produces: `POST /api/ingest/garmin` accepting `{ days: GarminDayInput[] & { hr_samples?: [number, number][] } }`.

- [ ] **Step 1: Write the route**

Create `app/api/ingest/garmin/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { extractBearer, resolveIngestToken } from "@/lib/ingest/auth";
import {
  edwardsTrimp,
  banisterTrimp,
  trimpToStrain,
  type HrSample,
} from "@/lib/coach/garmin/derive-strain";
import { mapToDailyLogs, type GarminDayInput } from "@/lib/coach/garmin/map-metrics";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Age-based HRmax fallback when profile.age is present (Tanaka: 208 - 0.7*age).
// Refined by observed peaks would be better; v1 uses the estimate.
const DEFAULT_HR_MAX = 190;

const daySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  hrv: z.number().nullish(),
  resting_hr: z.number().nullish(),
  training_readiness: z.number().nullish(),
  body_battery_low: z.number().nullish(),
  body_battery_peak: z.number().nullish(),
  sleep_hours: z.number().nullish(),
  sleep_score: z.number().nullish(),
  deep_sleep_hours: z.number().nullish(),
  rem_sleep_hours: z.number().nullish(),
  sleep_start_at: z.string().nullish(),
  sleep_end_at: z.string().nullish(),
  respiratory_rate: z.number().nullish(),
  steps: z.number().nullish(),
  distance_km: z.number().nullish(),
  calories: z.number().nullish(),
  active_calories: z.number().nullish(),
  spo2: z.number().nullish(),
  skin_temp_variation: z.number().nullish(),
  acute_load: z.number().nullish(),
  chronic_load: z.number().nullish(),
  vo2max: z.number().nullish(),
  // [epoch_ms, bpm] pairs, 2-min-sampled all-day HR (TRIMP input).
  hr_samples: z.array(z.tuple([z.number(), z.number()])).nullish(),
});

const bodySchema = z.object({ days: z.array(daySchema).max(31) });

export async function POST(request: Request) {
  const raw = extractBearer(request);
  if (!raw) return NextResponse.json({ ok: false, reason: "missing_token" }, { status: 401 });

  const userId = await resolveIngestToken(raw, "garmin");
  if (!userId) return NextResponse.json({ ok: false, reason: "invalid_token" }, { status: 401 });

  let parsed;
  try {
    parsed = bodySchema.parse(await request.json());
  } catch (e) {
    return NextResponse.json({ ok: false, error: "invalid_payload", detail: String(e) }, { status: 400 });
  }

  const sr = createSupabaseServiceRoleClient();

  // Cutover knob: does Garmin own daily_logs yet?
  const { data: profile } = await sr
    .from("profiles")
    .select("metrics_source, age")
    .eq("user_id", userId)
    .maybeSingle();
  const garminOwnsDaily = profile?.metrics_source === "garmin";
  const hrMax = profile?.age ? Math.round(208 - 0.7 * profile.age) : DEFAULT_HR_MAX;

  const garminRows: Record<string, unknown>[] = [];
  const dailyRows: Record<string, unknown>[] = [];
  const now = new Date().toISOString();

  for (const d of parsed.days) {
    const samples: HrSample[] = (d.hr_samples ?? []).map(([ts, bpm]) => ({ ts, bpm }));
    const hrRest = d.resting_hr ?? 50;
    const edw = samples.length ? edwardsTrimp(samples, hrMax) : null;
    const ban = samples.length ? banisterTrimp(samples, hrRest, hrMax) : null;
    // Edwards is the default strain source; swap to Banister after the
    // parallel-month calibration if it tracks WHOOP better (spec §5).
    const strain = edw !== null ? trimpToStrain(edw) : null;

    garminRows.push({
      user_id: userId,
      date: d.date,
      hrv: d.hrv ?? null,
      resting_hr: d.resting_hr ?? null,
      training_readiness: d.training_readiness ?? null,
      body_battery_low: d.body_battery_low ?? null,
      body_battery_peak: d.body_battery_peak ?? null,
      sleep_hours: d.sleep_hours ?? null,
      sleep_score: d.sleep_score ?? null,
      deep_sleep_hours: d.deep_sleep_hours ?? null,
      rem_sleep_hours: d.rem_sleep_hours ?? null,
      sleep_start_at: d.sleep_start_at ?? null,
      sleep_end_at: d.sleep_end_at ?? null,
      respiratory_rate: d.respiratory_rate ?? null,
      steps: d.steps != null ? Math.round(d.steps) : null,
      distance_km: d.distance_km ?? null,
      calories: d.calories != null ? Math.round(d.calories) : null,
      active_calories: d.active_calories != null ? Math.round(d.active_calories) : null,
      spo2: d.spo2 ?? null,
      skin_temp_variation: d.skin_temp_variation ?? null,
      acute_load: d.acute_load ?? null,
      chronic_load: d.chronic_load ?? null,
      vo2max: d.vo2max ?? null,
      strain,
      trimp_edwards: edw,
      trimp_banister: ban,
      raw: d,
      updated_at: now,
    });

    if (garminOwnsDaily) {
      // Strip hr_samples before mapping (not a daily_logs field).
      const { hr_samples: _omit, ...dayInput } = d;
      dailyRows.push({ ...mapToDailyLogs(dayInput as GarminDayInput, strain), user_id: userId, updated_at: now });
    }
  }

  if (garminRows.length > 0) {
    const { error } = await sr.from("garmin_daily").upsert(garminRows, { onConflict: "user_id,date" });
    if (error) {
      console.error("[ingest/garmin] garmin_daily upsert failed:", error.message);
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
  }

  let daysUpserted = 0;
  if (dailyRows.length > 0) {
    const { error } = await sr.from("daily_logs").upsert(dailyRows, { onConflict: "user_id,date" });
    if (error) {
      console.error("[ingest/garmin] daily_logs upsert failed:", error.message);
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
    daysUpserted = dailyRows.length;
    revalidatePath("/");
    revalidatePath("/coach");
  }

  return NextResponse.json({
    ok: true,
    source: "garmin",
    garmin_daily_upserted: garminRows.length,
    daily_logs_upserted: daysUpserted,
    owns_daily: garminOwnsDaily,
  });
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS. (If `profile.age` typing complains, confirm `Profile.age` exists in `lib/data/types.ts` — it does.)

- [ ] **Step 3: Smoke-test locally against the dev server**

Mint a token: start `npm run dev`, sign in, then in the browser console on the app run
`await fetch('/api/ingest/token', {method:'POST'}).then(r=>r.json())` and copy the `token`.

Write `/private/tmp/claude-501/-Users-abdelouahedelbied-Health-app/1368b36b-3fbe-4e4f-8a2c-6bbc09666c11/scratchpad/garmin-sample.json`:

```json
{ "days": [ { "date": "2026-07-01", "hrv": 68, "resting_hr": 52, "training_readiness": 74, "sleep_hours": 7.4, "sleep_score": 81, "steps": 8421, "hr_samples": [[0,150],[120000,150],[240000,150]] } ] }
```

Run (substitute the token):
```bash
curl -s -X POST http://localhost:3000/api/ingest/garmin \
  -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" \
  --data @"/private/tmp/claude-501/-Users-abdelouahedelbied-Health-app/1368b36b-3fbe-4e4f-8a2c-6bbc09666c11/scratchpad/garmin-sample.json"
```
Expected: `{"ok":true,"source":"garmin","garmin_daily_upserted":1,"daily_logs_upserted":0,"owns_daily":false}` — `daily_logs_upserted:0` confirms the parallel-phase guard (metrics_source still 'whoop'). Verify a `garmin_daily` row exists for the date via Supabase.

- [ ] **Step 4: Commit**

```bash
git add app/api/ingest/garmin/route.ts
git commit -m "feat(garmin): /api/ingest/garmin route with strain derivation + cutover guard"
```

---

### Task 5: Guard the WHOOP sync on `metrics_source`

**Files:**
- Modify: `app/api/whoop/sync/route.ts:66-75`

**Interfaces:**
- Consumes: `profiles.metrics_source` (Task 1).

- [ ] **Step 1: Add the guard before the daily_logs upsert**

In `app/api/whoop/sync/route.ts`, inside `syncForUser`, replace the block that currently reads (lines ~66-75):

```typescript
  const { rows, skipped } = buildWhoopDayRows(userId, recovery.records, cycles.records, sleep.records);

  if (rows.length === 0) return { ok: true, ...counts, skipped };

  const supabase = createSupabaseServiceRoleClient();
  const { error } = await supabase
    .from("daily_logs")
    .upsert(rows, { onConflict: "user_id,date" });
  if (error) throw error;
  counts.upserted = rows.length;
```

with:

```typescript
  const { rows, skipped } = buildWhoopDayRows(userId, recovery.records, cycles.records, sleep.records);

  if (rows.length === 0) return { ok: true, ...counts, skipped };

  const supabase = createSupabaseServiceRoleClient();

  // Cutover knob: once the athlete flips profiles.metrics_source to 'garmin',
  // WHOOP stops owning daily_logs. We still fetched WHOOP above (harmless), but
  // do not write the recovery/strain cluster — Garmin owns it now.
  const { data: profile } = await supabase
    .from("profiles")
    .select("metrics_source")
    .eq("user_id", userId)
    .maybeSingle();
  if (profile?.metrics_source === "garmin") {
    return { ok: true, ...counts, skipped, skipped_write: "metrics_source_garmin" };
  }

  const { error } = await supabase
    .from("daily_logs")
    .upsert(rows, { onConflict: "user_id,date" });
  if (error) throw error;
  counts.upserted = rows.length;
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add app/api/whoop/sync/route.ts
git commit -m "feat(garmin): gate WHOOP daily_logs write on metrics_source"
```

---

### Task 6: Python collector sidecar

**Files:**
- Create: `sidecar/garmin/collector.py`
- Create: `sidecar/garmin/requirements.txt`
- Create: `sidecar/garmin/README.md`
- Create: `sidecar/garmin/.env.example`

**Interfaces:**
- Consumes: `POST /api/ingest/garmin` (Task 4).
- Produces: a runnable daily collector.

- [ ] **Step 1: Write requirements + env example**

Create `sidecar/garmin/requirements.txt`:

```
garminconnect>=0.3.6
requests>=2.31
```

Create `sidecar/garmin/.env.example`:

```
GARMIN_EMAIL=you@example.com
GARMIN_PASSWORD=your-password
INGEST_URL=https://health-app-delta-ruby.vercel.app/api/ingest/garmin
INGEST_TOKEN=ah_xxxxxxxx
# Days back to fetch each run (yesterday + catch-up). Default 4.
BACKFILL_DAYS=4
```

- [ ] **Step 2: Write the collector**

Create `sidecar/garmin/collector.py`:

```python
#!/usr/bin/env python3
"""Garmin Fenix 8 → Apex Health OS collector (the "pump").

Pulls raw daily metrics via python-garminconnect and POSTs them to the app's
/api/ingest/garmin route. No derivation here — all strain/recovery logic lives
in the TypeScript app. Run once daily via cron.
"""
import os
import sys
import json
from datetime import date, timedelta

import requests
from garminconnect import Garmin
from garminconnect import GarminConnectAuthenticationError

TOKENSTORE = os.path.expanduser("~/.garminconnect")


def login() -> Garmin:
    """Log in, reusing the persisted token; fall back to full login + MFA."""
    email = os.environ["GARMIN_EMAIL"]
    password = os.environ["GARMIN_PASSWORD"]
    try:
        g = Garmin()
        g.login(TOKENSTORE)  # reuse saved tokens
        return g
    except (FileNotFoundError, GarminConnectAuthenticationError, Exception):
        # First run or expired token: full login. prompt_mfa is called if 2FA
        # is enabled — you type the 6-digit code once; the token is then saved.
        g = Garmin(email, password, prompt_mfa=lambda: input("Garmin MFA code: "))
        g.login()
        g.garth.dump(TOKENSTORE)
        return g


def collect_day(g: Garmin, d: str) -> dict:
    """Assemble one day's raw payload. Each getter is wrapped so a single
    missing metric never aborts the day."""
    def safe(fn, *a):
        try:
            return fn(*a)
        except Exception as e:  # noqa: BLE001 — unofficial API, best-effort
            print(f"  warn: {fn.__name__} failed for {d}: {e}", file=sys.stderr)
            return None

    day = {"date": d}

    hrv = safe(g.get_hrv_data, d)
    if hrv and hrv.get("hrvSummary"):
        day["hrv"] = hrv["hrvSummary"].get("lastNightAvg")

    rhr = safe(g.get_rhr_day, d)
    if rhr and rhr.get("allMetrics"):
        # shape: allMetrics.metricsMap.WELLNESS_RESTING_HEART_RATE[0].value
        try:
            m = rhr["allMetrics"]["metricsMap"]["WELLNESS_RESTING_HEART_RATE"]
            day["resting_hr"] = m[0]["value"]
        except (KeyError, IndexError, TypeError):
            pass

    tr = safe(g.get_training_readiness, d)
    if isinstance(tr, list) and tr:
        day["training_readiness"] = tr[0].get("score")
    elif isinstance(tr, dict):
        day["training_readiness"] = tr.get("score")

    bb = safe(g.get_body_battery, d, d)
    if isinstance(bb, list) and bb:
        vals = [x for x in (bb[0].get("bodyBatteryValuesArray") or []) if len(x) > 1]
        if vals:
            levels = [v[1] for v in vals]
            day["body_battery_low"] = min(levels)
            day["body_battery_peak"] = max(levels)

    sleep = safe(g.get_sleep_data, d)
    if sleep and sleep.get("dailySleepDTO"):
        dto = sleep["dailySleepDTO"]
        secs = dto.get("sleepTimeSeconds")
        if secs:
            day["sleep_hours"] = round(secs / 3600, 2)
        if dto.get("deepSleepSeconds") is not None:
            day["deep_sleep_hours"] = round(dto["deepSleepSeconds"] / 3600, 2)
        if dto.get("remSleepSeconds") is not None:
            day["rem_sleep_hours"] = round(dto["remSleepSeconds"] / 3600, 2)
        if dto.get("sleepScores", {}).get("overall", {}).get("value") is not None:
            day["sleep_score"] = dto["sleepScores"]["overall"]["value"]

    stats = safe(g.get_stats, d)
    if stats:
        if stats.get("totalSteps") is not None:
            day["steps"] = stats["totalSteps"]
        if stats.get("totalDistanceMeters") is not None:
            day["distance_km"] = round(stats["totalDistanceMeters"] / 1000, 2)
        if stats.get("totalKilocalories") is not None:
            day["calories"] = stats["totalKilocalories"]
        if stats.get("activeKilocalories") is not None:
            day["active_calories"] = stats["activeKilocalories"]
        if stats.get("avgWakingRespirationValue") is not None:
            day["respiratory_rate"] = stats["avgWakingRespirationValue"]

    ts = safe(g.get_training_status, d)
    if isinstance(ts, dict):
        # acute/chronic load live under mostRecentTrainingLoadBalance; shape
        # varies by firmware — best-effort extraction.
        try:
            bal = ts.get("mostRecentTrainingLoadBalance", {})
            metrics = list(bal.get("metricsTrainingLoadBalanceDTOMap", {}).values())
            if metrics:
                day["acute_load"] = metrics[0].get("acwrPercent")
        except (KeyError, IndexError, TypeError):
            pass

    hr = safe(g.get_heart_rates, d)
    if hr and hr.get("heartRateValues"):
        # [[ts_ms, bpm], ...]; drop nulls (off-wrist)
        day["hr_samples"] = [[t, b] for t, b in hr["heartRateValues"] if b is not None]

    return day


def main() -> int:
    n = int(os.environ.get("BACKFILL_DAYS", "4"))
    g = login()
    days = []
    for i in range(1, n + 1):
        d = (date.today() - timedelta(days=i)).isoformat()
        print(f"collecting {d} ...")
        days.append(collect_day(g, d))

    resp = requests.post(
        os.environ["INGEST_URL"],
        headers={"Authorization": f"Bearer {os.environ['INGEST_TOKEN']}"},
        json={"days": days},
        timeout=30,
    )
    print(f"ingest → {resp.status_code}: {resp.text}")
    return 0 if resp.ok else 1


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 3: Write the README**

Create `sidecar/garmin/README.md`:

```markdown
# Garmin collector sidecar

Pulls Fenix 8 daily metrics via the unofficial `python-garminconnect` and POSTs
them to `/api/ingest/garmin`. All derivation happens app-side; this is a dumb pump.

## Setup
1. `python3 -m venv .venv && source .venv/bin/activate`
2. `pip install -r requirements.txt`
3. `cp .env.example .env` and fill in Garmin creds + the ingest token
   (mint it on the app: Profile → rotate ingest token).
4. First run does an interactive login: `set -a; source .env; set +a; python collector.py`
   — if 2FA is on you'll be asked for a 6-digit code once. The token is saved to
   `~/.garminconnect` and reused after that.

## Daily schedule (Mac/Linux cron, 08:30 local)
```
30 8 * * * cd /path/to/sidecar/garmin && set -a && source .env && set +a && ./.venv/bin/python collector.py >> ~/garmin-collector.log 2>&1
```

## Notes
- Unofficial API: expect occasional breakage. Fix with `pip install -U garminconnect`.
- During the parallel month, `daily_logs_upserted` will be 0 (WHOOP still owns
  daily_logs); the route stores everything in `garmin_daily` for comparison.
```

- [ ] **Step 4: First-run verification against real Garmin**

Run:
```bash
cd sidecar/garmin && python3 -m venv .venv && source .venv/bin/activate && \
pip install -r requirements.txt && cp .env.example .env
# edit .env with real creds + token, then:
set -a; source .env; set +a; python collector.py
```
Expected: prints "collecting <date> ..." lines, then `ingest → 200: {"ok":true,...,"garmin_daily_upserted":4,...}`. If prompted for an MFA code, that answers the open 2FA question (enter it once). Confirm `garmin_daily` rows appear in Supabase.

- [ ] **Step 5: Commit**

```bash
git add sidecar/garmin/
git commit -m "feat(garmin): python collector sidecar"
```

---

### Task 7: Garmin-vs-WHOOP audit + strain calibration

**Files:**
- Create: `scripts/audit-garmin-vs-whoop.mjs`

**Interfaces:**
- Consumes: `garmin_daily` + `daily_logs` (populated by Tasks 4 & 6 running in parallel).

- [ ] **Step 1: Write the audit script**

Create `scripts/audit-garmin-vs-whoop.mjs`:

```javascript
// Phase-1 parallel-run audit: day-by-day Garmin vs WHOOP comparison + a strain
// calibration fit (A, k for trimpToStrain so Garmin strain tracks WHOOP's).
// Set AUDIT_USER_ID. Read-only.
// Run: AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-garmin-vs-whoop.mjs
import { createClient } from "@supabase/supabase-js";

const userId = process.env.AUDIT_USER_ID;
if (!userId) { console.error("Set AUDIT_USER_ID"); process.exit(1); }

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const { data: gRows } = await sb
  .from("garmin_daily")
  .select("date, hrv, resting_hr, training_readiness, sleep_hours, strain, trimp_edwards, trimp_banister")
  .eq("user_id", userId)
  .order("date");

const { data: wRows } = await sb
  .from("daily_logs")
  .select("date, hrv, resting_hr, recovery, sleep_hours, strain")
  .eq("user_id", userId);

const wByDate = new Map((wRows ?? []).map((r) => [r.date, r]));

console.log("date        | HRV g/w     | RHR g/w   | rec g/w   | strain g/w  | edwTRIMP");
const pairs = []; // {whoopStrain, edwTrimp} for calibration
for (const g of gRows ?? []) {
  const w = wByDate.get(g.date);
  if (!w) continue;
  const f = (x) => (x == null ? "—" : (Math.round(x * 10) / 10).toString());
  console.log(
    `${g.date} | ${f(g.hrv)}/${f(w.hrv)}  | ${f(g.resting_hr)}/${f(w.resting_hr)} | ` +
    `${f(g.training_readiness)}/${f(w.recovery)} | ${f(g.strain)}/${f(w.strain)} | ${f(g.trimp_edwards)}`,
  );
  if (w.strain != null && g.trimp_edwards != null && g.trimp_edwards > 0) {
    pairs.push({ y: w.strain, trimp: g.trimp_edwards });
  }
}

// Calibrate A,k for strain = A·ln(1 + k·TRIMP) by a small grid search
// minimizing squared error vs WHOOP strain. Prints the best fit to paste into
// DEFAULT_STRAIN_CALIBRATION.
if (pairs.length >= 5) {
  let best = { A: 4.2, k: 0.05, err: Infinity };
  for (let A = 2; A <= 8; A += 0.2) {
    for (let k = 0.01; k <= 0.2; k += 0.005) {
      let err = 0;
      for (const p of pairs) {
        const pred = Math.min(21, A * Math.log(1 + k * p.trimp));
        err += (pred - p.y) ** 2;
      }
      if (err < best.err) best = { A: Math.round(A * 100) / 100, k: Math.round(k * 1000) / 1000, err };
    }
  }
  console.log(`\nStrain calibration best fit over ${pairs.length} days: A=${best.A}, k=${best.k} (RMSE ${Math.sqrt(best.err / pairs.length).toFixed(2)})`);
  console.log("→ paste into DEFAULT_STRAIN_CALIBRATION in lib/coach/garmin/derive-strain.ts");
} else {
  console.log(`\nNeed ≥5 overlapping days with WHOOP strain to calibrate (have ${pairs.length}).`);
}
```

- [ ] **Step 2: Run it**

Run: `AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-garmin-vs-whoop.mjs`
Expected: a per-day comparison table. Early in the parallel run it prints "Need ≥5 overlapping days"; after ~a week it prints a best-fit `A`/`k`.

- [ ] **Step 3: Commit**

```bash
git add scripts/audit-garmin-vs-whoop.mjs
git commit -m "feat(garmin): parallel-run audit + strain calibration fit"
```

---

## Cutover (manual, after ~2 weeks of clean parallel data — not a code task)

1. Update `DEFAULT_STRAIN_CALIBRATION` in `lib/coach/garmin/derive-strain.ts` with the audit's best-fit `A`/`k`; commit.
2. Flip the knob: `update profiles set metrics_source = 'garmin' where user_id = '<uuid>';`
3. Confirm the next Garmin ingest returns `daily_logs_upserted > 0` and `owns_daily: true`, and that the dashboard/brief read Garmin data.
4. Let the WHOOP subscription lapse. The WHOOP cron self-guards (Task 5) — no need to disable it.

## Self-Review

- **Spec coverage:** §3.1 sidecar → Task 6. §3.2 route + modules → Tasks 2,3,4. §4 mapping → Task 3. §5 strain → Task 2. §6 rollout/cutover knob → Tasks 1,4,5 + Cutover section. §7 data model → Task 1. §9 audits → Tasks 2,7. Baselines (§6) need no task (read daily_logs already). ✎ All covered.
- **Placeholder scan:** no TBD/TODO; every code step shows full code. ✎ Clean.
- **Type consistency:** `HrSample`, `GarminDayInput`, `mapToDailyLogs`, `trimpToStrain`, `edwardsTrimp`, `banisterTrimp`, `metrics_source`, `garmin_daily` used identically across Tasks 1–7. ✎ Consistent.
