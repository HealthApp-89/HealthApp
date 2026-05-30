# Endurance Pillar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Phase 1 of the endurance pillar — Strava OAuth + per-activity ingest, `endurance_activities` data model, Carter's S&C mandate expansion with 7 new chat tools, snapshot prefix injection, Peter dashboard Endurance theme, `/profile` setup section, and a morning brief endurance block — sized for the user's current 1×60min Z2/wk reality with the data shape future-proofed for triathlon.

**Architecture:** New `endurance_activities` table per Strava activity, joined to `daily_logs` via day-level aggregation (`sum_endurance_for_day`). Strava OAuth + token refresh mirrors WHOOP/Withings (dedicated `strava_tokens` table, not jsonb on profiles). HR-based TSS (hrTSS) is computed at ingest from per-second HR stream + user's threshold HR. Carter owns endurance via expanded `CARTER_TOOLS` partition; `propose/commit_endurance_week` use the existing HMAC approval-token primitive with a new `"endurance_week"` action; `set_*` milestone tools (phase / discipline / threshold_hr / ftp) are direct writes mirroring GLP-1 milestone tools (no HMAC). Composer (`compose-z2-base`) is a pure function consumed by Carter's prescription tools; produces the same `EnduranceSessionPlan` shape Phase 2 composers will. UI footprint: no top-level page, just a card on the existing Peter dashboard + a morning-brief block on the prescribed day + `/profile` setup.

**Tech Stack:** Next.js 15 (App Router), Supabase Postgres + RLS, Anthropic SDK (server-side), TanStack Query (client cache), Tailwind v4. No test runner; verification via `npm run typecheck`, audit `.mjs` scripts (project convention: `node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-*.mjs`), and manual exercise in the dev server.

**Pre-work the user is handling in parallel:**
- Strava developer-app registration at https://www.strava.com/settings/api (one dev app, one prod app)
- Will supply `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`, `STRAVA_ACCESS_TOKEN`, `STRAVA_REFRESH_TOKEN` before Task 7 needs them
- Strava icons already at `public/strava-icon-60.png` + `public/strava-icon-124.png`

---

## File structure

**Created (new files):**

- `supabase/migrations/0038_endurance_pillar.sql` — schema migration
- `lib/coach/endurance/types.ts` — endurance domain types
- `lib/coach/endurance/hr-zones.ts` — zone derivation from threshold HR + zone bucketing of HR stream
- `lib/coach/endurance/tss.ts` — hrTSS computation
- `lib/coach/endurance/training-load.ts` — CTL/ATL/TSB EWMA computation (data layer only in Phase 1; not rendered)
- `lib/coach/endurance/compose-z2-base.ts` — Phase 1 prescription composer
- `lib/coach/interference/check-interference.ts` — strength↔endurance autoregulation seam
- `lib/strava/types.ts` — Strava API response types
- `lib/strava/client.ts` — fetch wrapper with auto token refresh
- `lib/strava/oauth.ts` — authorization URL + token exchange helpers
- `lib/strava/ingest.ts` — Strava activity → `endurance_activities` row + day re-aggregation
- `app/api/strava/auth/route.ts`
- `app/api/strava/callback/route.ts`
- `app/api/strava/disconnect/route.ts`
- `app/api/strava/sync/route.ts`
- `app/api/strava/backfill/route.ts`
- `app/api/strava/webhook/route.ts`
- `app/api/profile/endurance-profile/route.ts`
- `lib/coach/peter-dashboard/compose-endurance.ts`
- `lib/coach/proactive/check-endurance-volume-spike.ts`
- `components/profile/EnduranceSetupSection.tsx`
- `components/morning/EnduranceBriefBlock.tsx`
- `lib/query/fetchers/enduranceActivities.ts`
- `lib/query/hooks/useEnduranceActivities.ts`
- `scripts/strava-subscribe-webhook.mjs`
- `scripts/audit-endurance-pure.mjs` — fixture-based audit for pure compute modules
- `scripts/audit-endurance-ingest.mjs` — e2e check that `daily_logs.endurance_*` equals `sum_endurance_for_day` output

**Modified:**

- `lib/data/types.ts` — add `EnduranceActivity`, `StravaTokens` row types + extend `DailyLog` / `AthleteProfileDocument` / `TrainingWeek` / `TrainingBlock`
- `lib/coach/tools.ts` — 7 new tool schemas + executors + `CARTER_TOOLS` partition
- `lib/coach/approval-token.ts` — add `"endurance_week"` to `ApprovalAction` union
- `lib/coach/chat-stream.ts` — add propose/commit endurance tools to `PERSIST_RESULT_TOOLS` and `modeAllowsTool`
- `lib/coach/snapshot.ts` — inject `ENDURANCE_PROFILE` + `ENDURANCE_LOAD_7D` + `LAST_3_ENDURANCE_ACTIVITIES` blocks
- `lib/coach/system-prompts.ts` — update `CARTER_BASE`, `NORA_BASE`, `REMI_BASE`, `PETER_BASE`
- `lib/coach/adherence.ts` — endurance adherence pass + `endurance_status` field
- `lib/coach/peter-dashboard/index.ts` — orchestrate Endurance theme into parallel run
- `lib/coach/peter-dashboard/link-themes.ts` — pairwise rules involving Endurance
- `lib/coach/peter-dashboard/types.ts` — `EnduranceTheme` shape
- `components/coach/PeterDashboardClient.tsx` — render Endurance card
- `lib/morning/brief/index.ts` + assembler files — populate `EnduranceBlock` in `MorningBriefCard.ui`
- `app/profile/page.tsx` or existing `ProfileClient.tsx` — mount `EnduranceSetupSection`
- `lib/query/keys.ts` — `endurance.*` keys
- `app/api/coach/proactive/check/route.ts` — register `check-endurance-volume-spike`
- `vercel.json` — cron `/api/strava/sync` at 09:00 UTC
- `.env.example` — Strava env vars
- `docs/superpowers/specs/2026-05-30-endurance-pillar-design.md` — correct the `profiles.strava_tokens jsonb` reference to dedicated `strava_tokens` table

---

### Task 1: Migration 0038 + spec correction

**Files:**
- Create: `supabase/migrations/0038_endurance_pillar.sql`
- Modify: `docs/superpowers/specs/2026-05-30-endurance-pillar-design.md` (fix `profiles.strava_tokens jsonb` reference)

- [ ] **Step 1: Write the migration SQL**

```sql
-- 0038_endurance_pillar.sql — Phase 1 of endurance pillar
-- Apply via: supabase db push  (or Dashboard → SQL Editor)

-- ── Strava OAuth tokens (one row per user, mirrors whoop_tokens shape) ────────
create table if not exists public.strava_tokens (
  user_id uuid primary key references auth.users on delete cascade,
  access_token text not null,
  refresh_token text not null,
  expires_at timestamptz not null,
  scope text,
  strava_athlete_id text,
  updated_at timestamptz not null default now()
);

alter table public.strava_tokens enable row level security;
drop policy if exists "strava_tokens read self" on public.strava_tokens;
create policy "strava_tokens read self" on public.strava_tokens
  for select using (auth.uid() = user_id);
-- writes via service_role only

-- ── endurance_activities — one row per Strava activity ───────────────────────
create table if not exists public.endurance_activities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null check (source in ('strava','manual')),
  external_id text,
  sport text not null check (sport in ('cycling','running','swimming','other')),
  started_at timestamptz not null,
  local_date date not null,
  duration_s int not null,
  distance_m numeric,
  elevation_gain_m numeric,
  avg_hr int,
  max_hr int,
  hr_zone_distribution jsonb,
  avg_power_w int,
  normalized_power_w int,
  intensity_factor numeric,
  tss numeric,
  avg_pace_s_per_km int,
  avg_speed_kmh numeric,
  calories int,
  raw jsonb,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.endurance_activities enable row level security;
drop policy if exists "endurance_activities self" on public.endurance_activities;
create policy "endurance_activities self" on public.endurance_activities
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create unique index if not exists endurance_activities_external_id_uniq
  on public.endurance_activities (user_id, source, external_id)
  where external_id is not null;

create index if not exists endurance_activities_user_local_date_idx
  on public.endurance_activities (user_id, local_date desc);

-- ── daily_logs day-level endurance aggregates ────────────────────────────────
alter table public.daily_logs add column if not exists endurance_load numeric;
alter table public.daily_logs add column if not exists endurance_minutes int;
alter table public.daily_logs add column if not exists endurance_z2_minutes int;

-- ── athlete_profile_documents.endurance_profile ──────────────────────────────
alter table public.athlete_profile_documents
  add column if not exists endurance_profile jsonb;

-- ── training_weeks.endurance_session_plan ────────────────────────────────────
alter table public.training_weeks
  add column if not exists endurance_session_plan jsonb;

-- ── training_blocks.endurance_focus ──────────────────────────────────────────
alter table public.training_blocks
  add column if not exists endurance_focus jsonb;

-- ── Aggregation function used by ingest + audit script ───────────────────────
create or replace function public.sum_endurance_for_day(p_user_id uuid, p_date date)
returns table (
  tss_sum numeric,
  duration_minutes_sum int,
  z2_minutes_sum int
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select
    coalesce(sum(tss), 0)::numeric as tss_sum,
    coalesce(sum(duration_s) / 60, 0)::int as duration_minutes_sum,
    coalesce(sum( ((hr_zone_distribution->>'z2_s')::int) / 60 ), 0)::int as z2_minutes_sum
  from public.endurance_activities
  where user_id = p_user_id
    and local_date = p_date
    and deleted_at is null;
$$;
```

- [ ] **Step 2: Apply migration**

```bash
supabase db push
```

Expected: prints `Applying migration 20260530_endurance_pillar.sql...` (or similar timestamp) then `Finished supabase db push.` If linker prefers the dashboard path, paste the file into the SQL Editor and run.

- [ ] **Step 3: Verify schema with probe queries**

```bash
supabase db remote query "select column_name, data_type from information_schema.columns where table_name='endurance_activities' order by ordinal_position;"
supabase db remote query "select column_name from information_schema.columns where table_name='daily_logs' and column_name like 'endurance_%';"
supabase db remote query "select proname from pg_proc where proname='sum_endurance_for_day';"
```

Expected: first query returns 24 rows ending with `updated_at | timestamp with time zone`; second returns 3 rows (`endurance_load`, `endurance_minutes`, `endurance_z2_minutes`); third returns 1 row.

- [ ] **Step 4: Fix spec — replace `profiles.strava_tokens` reference**

The spec said tokens live on `profiles.strava_tokens jsonb`; the migration follows the established dedicated-table pattern instead. Update the spec to match.

```bash
sed -i.bak 's|stores `(access_token, refresh_token, expires_at, athlete_id)` on `profiles.strava_tokens` jsonb. Single-user app, no per-user token table needed (mirrors WHOOP storage pattern).|stores `(access_token, refresh_token, expires_at, scope, strava_athlete_id)` in a dedicated `strava_tokens` table (one row per user, primary key on `user_id`). Mirrors the existing `whoop_tokens` / `withings_tokens` shape — RLS read-self, writes via service-role only.|g' docs/superpowers/specs/2026-05-30-endurance-pillar-design.md
rm docs/superpowers/specs/2026-05-30-endurance-pillar-design.md.bak
```

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0038_endurance_pillar.sql docs/superpowers/specs/2026-05-30-endurance-pillar-design.md
git commit -m "$(cat <<'EOF'
feat(endurance): migration 0038 — strava_tokens + endurance_activities + agg fn

Adds strava_tokens (dedicated table mirroring whoop_tokens), endurance_activities
(per-Strava-activity row keyed by local_date for day attribution), daily_logs.endurance_*
aggregate columns, athlete_profile_documents.endurance_profile / training_weeks.endurance_session_plan
/ training_blocks.endurance_focus jsonb extensions, and sum_endurance_for_day SECURITY DEFINER
function used by the ingest path and audit script. Also corrects the spec's
profiles.strava_tokens reference to the dedicated table now actually shipped.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: TypeScript row + domain types

**Files:**
- Modify: `lib/data/types.ts` — add `StravaTokens`, `EnduranceActivity`, extend `DailyLog` / `AthleteProfileDocument` / `TrainingWeek` / `TrainingBlock`
- Create: `lib/coach/endurance/types.ts` — domain types used across endurance modules

- [ ] **Step 1: Read existing types to find insertion points**

```bash
grep -n "^export (type|interface) (DailyLog|AthleteProfileDocument|TrainingWeek|TrainingBlock|WhoopTokens)" lib/data/types.ts | head -20
```

Locate the relevant types; you'll extend them in-place.

- [ ] **Step 2: Append new row types in lib/data/types.ts**

After the existing `WhoopTokens` type (or near other token types), append:

```ts
export type StravaTokens = {
  user_id: string;
  access_token: string;
  refresh_token: string;
  expires_at: string;
  scope: string | null;
  strava_athlete_id: string | null;
  updated_at: string;
};

export type EnduranceActivity = {
  id: string;
  user_id: string;
  source: 'strava' | 'manual';
  external_id: string | null;
  sport: 'cycling' | 'running' | 'swimming' | 'other';
  started_at: string;
  local_date: string;
  duration_s: number;
  distance_m: number | null;
  elevation_gain_m: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  hr_zone_distribution: HrZoneDistribution | null;
  avg_power_w: number | null;
  normalized_power_w: number | null;
  intensity_factor: number | null;
  tss: number | null;
  avg_pace_s_per_km: number | null;
  avg_speed_kmh: number | null;
  calories: number | null;
  raw: unknown;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

export type HrZoneDistribution = {
  z1_s: number;
  z2_s: number;
  z3_s: number;
  z4_s: number;
  z5_s: number;
};
```

Then extend `DailyLog` (find its declaration, add fields):

```ts
  // … existing fields …
  endurance_load: number | null;
  endurance_minutes: number | null;
  endurance_z2_minutes: number | null;
```

Extend `AthleteProfileDocument`:

```ts
  // … existing fields …
  endurance_profile: EnduranceProfile | null;
```

(Where `EnduranceProfile` is imported from `lib/coach/endurance/types.ts` — see Step 3.)

Extend `TrainingWeek`:

```ts
  endurance_session_plan: EnduranceSessionPlan | null;
```

Extend `TrainingBlock`:

```ts
  endurance_focus: EnduranceFocus | null;
```

- [ ] **Step 3: Create lib/coach/endurance/types.ts**

```ts
// lib/coach/endurance/types.ts — shared types for the endurance pillar.

export type EnduranceDiscipline = 'cycling' | 'running' | 'triathlon';

export type EndurancePhase =
  | 'aerobic_base'
  | 'build'
  | 'race_prep'
  | 'taper'
  | 'off_season';

export type EnduranceSport = 'cycling' | 'running' | 'swimming' | 'other';

export type HrZoneRanges = {
  z1: [number, number];
  z2: [number, number];
  z3: [number, number];
  z4: [number, number];
  z5: [number, number];
};

export type EnduranceProfile = {
  discipline: EnduranceDiscipline;
  phase: EndurancePhase;
  threshold_hr: number | null;
  hr_max: number | null;
  hr_zones: HrZoneRanges | null;
  ftp_watts: number | null;
  threshold_pace_s_per_km: number | null;
  weekly_volume_target_hours: number;
  current_race: { date: string; distance: string } | null;
  set_at: string;
};

export type EnduranceSessionType =
  | 'rest'
  | 'z2_ride'
  | 'z2_run'
  | 'tempo'
  | 'intervals'
  | 'long'
  | 'brick';

export type EnduranceSessionEntry = {
  type: EnduranceSessionType;
  sport: EnduranceSport;
  duration_min: number;
  hr_cap?: number;
  hr_target_range?: [number, number];
  description: string;
};

// Keys are weekday numbers 0=Sun .. 6=Sat to match Date#getDay().
export type EnduranceSessionPlan = Partial<Record<0|1|2|3|4|5|6, EnduranceSessionEntry>>;

export type EnduranceFocus = {
  weekly_volume_target_hours: number;
  intensity_distribution: '100_z2' | '80_20' | 'polarized' | 'pyramidal';
  expected_adaptations: string[];
  notes?: string;
};
```

- [ ] **Step 4: Import `EnduranceProfile` / `EnduranceSessionPlan` / `EnduranceFocus` in lib/data/types.ts**

Add at the top of the file with the other imports:

```ts
import type {
  EnduranceProfile,
  EnduranceSessionPlan,
  EnduranceFocus,
} from '@/lib/coach/endurance/types';
```

- [ ] **Step 5: Verify typecheck**

```bash
npm run typecheck
```

Expected: zero errors. If any existing call site relied on `EnduranceActivity` being absent (it should be a new symbol — no conflicts), fix in place; usually clean.

- [ ] **Step 6: Commit**

```bash
git add lib/data/types.ts lib/coach/endurance/types.ts
git commit -m "$(cat <<'EOF'
feat(endurance): TypeScript row + domain types

Adds StravaTokens / EnduranceActivity / HrZoneDistribution row types and extends
DailyLog / AthleteProfileDocument / TrainingWeek / TrainingBlock for the new
jsonb extensions from migration 0038. Domain types (EnduranceProfile, phase /
discipline / sport unions, EnduranceSessionPlan keyed by weekday, EnduranceFocus)
live in lib/coach/endurance/types.ts so the coach modules can import without
crossing the data-types boundary.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: HR zones module + audit harness

**Files:**
- Create: `lib/coach/endurance/hr-zones.ts`
- Create: `scripts/audit-endurance-pure.mjs` — fixture-based assertion harness; this task seeds it with the HR-zones cases

- [ ] **Step 1: Write lib/coach/endurance/hr-zones.ts**

```ts
// lib/coach/endurance/hr-zones.ts — derive zone boundaries from threshold HR
// (Coggan model) and bucket a per-second HR stream into zone-seconds.

import type { HrZoneDistribution } from '@/lib/data/types';
import type { HrZoneRanges } from './types';

/**
 * Coggan HR zones, expressed as % of lactate-threshold HR (LTHR).
 * Boundaries are inclusive of the lower bound and exclusive of the upper.
 * Z5 is open-ended on the high side.
 */
const COGGAN_PCT_LTHR: Readonly<HrZoneRanges> = {
  z1: [0, 0.81],
  z2: [0.81, 0.89],
  z3: [0.89, 0.94],
  z4: [0.94, 1.05],
  z5: [1.05, 99],
};

/** Derive bpm zones from threshold HR. */
export function derivedHrZones(thresholdHr: number): HrZoneRanges {
  const r = (lo: number, hi: number): [number, number] => [
    Math.round(thresholdHr * lo),
    Math.round(thresholdHr * hi),
  ];
  return {
    z1: r(COGGAN_PCT_LTHR.z1[0], COGGAN_PCT_LTHR.z1[1]),
    z2: r(COGGAN_PCT_LTHR.z2[0], COGGAN_PCT_LTHR.z2[1]),
    z3: r(COGGAN_PCT_LTHR.z3[0], COGGAN_PCT_LTHR.z3[1]),
    z4: r(COGGAN_PCT_LTHR.z4[0], COGGAN_PCT_LTHR.z4[1]),
    z5: r(COGGAN_PCT_LTHR.z5[0], COGGAN_PCT_LTHR.z5[1]),
  };
}

/**
 * Bucket a per-second HR stream into per-zone second counts.
 * Boundaries: [lo, hi) — Z5 covers everything ≥ z5_lo. Samples ≤ 0 are dropped.
 *
 * @param hrStream  array of bpm samples, sampling rate assumed 1 Hz
 * @param thresholdHr  LTHR
 */
export function bucketZones(hrStream: readonly number[], thresholdHr: number): HrZoneDistribution {
  const z = derivedHrZones(thresholdHr);
  const out: HrZoneDistribution = { z1_s: 0, z2_s: 0, z3_s: 0, z4_s: 0, z5_s: 0 };
  for (const bpm of hrStream) {
    if (!Number.isFinite(bpm) || bpm <= 0) continue;
    if (bpm < z.z2[0]) out.z1_s += 1;
    else if (bpm < z.z3[0]) out.z2_s += 1;
    else if (bpm < z.z4[0]) out.z3_s += 1;
    else if (bpm < z.z5[0]) out.z4_s += 1;
    else out.z5_s += 1;
  }
  return out;
}

/** Default HR cap for Z2 work — Coggan Z2 upper boundary as bpm. */
export function defaultZ2Cap(thresholdHr: number): number {
  return derivedHrZones(thresholdHr).z2[1];
}
```

- [ ] **Step 2: Create scripts/audit-endurance-pure.mjs with HR-zones assertions**

```js
// scripts/audit-endurance-pure.mjs — fixture-based audit for pure compute modules
// Run via: node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-endurance-pure.mjs
// No DB access. Asserts behavior of hr-zones / tss / training-load / compose-z2-base / interference.

import { derivedHrZones, bucketZones, defaultZ2Cap } from '@/lib/coach/endurance/hr-zones';

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass += 1; console.log(`  ok  ${label}`); }
  else    { fail += 1; console.error(`FAIL  ${label}\n      expected ${JSON.stringify(expected)}\n      got      ${JSON.stringify(actual)}`); }
}

console.log('── hr-zones ──');
// Threshold HR 160 → Coggan boundaries
check('derivedHrZones(160).z2', derivedHrZones(160).z2, [130, 142]);
check('derivedHrZones(160).z4', derivedHrZones(160).z4, [150, 168]);
check('defaultZ2Cap(160)', defaultZ2Cap(160), 142);

// Sample HR stream: 60 samples at 135 (Z2), 60 at 100 (Z1), 60 at 155 (Z4)
const stream = [
  ...Array(60).fill(135),
  ...Array(60).fill(100),
  ...Array(60).fill(155),
];
check('bucketZones split', bucketZones(stream, 160), { z1_s: 60, z2_s: 60, z3_s: 0, z4_s: 60, z5_s: 0 });

// Edge: 0 and negative samples dropped
check('bucketZones drops invalid', bucketZones([0, -1, 130, 135], 160), { z1_s: 1, z2_s: 1, z3_s: 0, z4_s: 0, z5_s: 0 });

console.log(`\n${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
```

- [ ] **Step 3: Run audit**

```bash
node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-endurance-pure.mjs
```

Expected: `── hr-zones ──` header, all assertions `ok`, summary `5 pass, 0 fail`.

- [ ] **Step 4: Run typecheck**

```bash
npm run typecheck
```

Expected: zero errors.

- [ ] **Step 5: Commit**

```bash
git add lib/coach/endurance/hr-zones.ts scripts/audit-endurance-pure.mjs
git commit -m "$(cat <<'EOF'
feat(endurance): hr-zones module + audit harness

Coggan HR zones derived from threshold HR (single source: derivedHrZones).
bucketZones walks a per-second HR stream into per-zone seconds for ingest.
defaultZ2Cap is the canonical "Z2 upper" used by compose-z2-base and snapshot.
Seeds scripts/audit-endurance-pure.mjs as the fixture-based assertion harness
for all endurance pure-function modules — TSS, training-load, composer, and
interference will extend it.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: hrTSS module

**Files:**
- Create: `lib/coach/endurance/tss.ts`
- Modify: `scripts/audit-endurance-pure.mjs` (extend with TSS cases)

- [ ] **Step 1: Write lib/coach/endurance/tss.ts**

```ts
// lib/coach/endurance/tss.ts — HR-based TSS computation.
//
// hrTSS reference: a 1-hour effort at threshold HR = 100 TSS.
// formula: durationH * (avgHr / thresholdHr)^2 * 100
//
// Phase 2 will add powerTSS for activities with avg_power_w + ftp_watts.
// The branching wrapper (computeTssForActivity) picks the best estimate.

export function computeHrTss(durationS: number, avgHr: number, thresholdHr: number): number {
  if (durationS <= 0 || avgHr <= 0 || thresholdHr <= 0) return 0;
  const durationH = durationS / 3600;
  const intensity = avgHr / thresholdHr;
  return Math.round(durationH * intensity * intensity * 100 * 10) / 10; // 1 dp
}

/**
 * Pick the best available TSS estimate.
 *  - Power-based when avg_power_w + ftp_watts present (Phase 2)
 *  - Otherwise HR-based when avg_hr + threshold_hr present
 *  - Otherwise null (caller surfaces "calibrate threshold HR" CTA)
 */
export function computeTssForActivity(args: {
  durationS: number;
  avgHr: number | null;
  thresholdHr: number | null;
  avgPowerW?: number | null;
  ftpWatts?: number | null;
}): number | null {
  // Power path (Phase 2). Same column, different formula; included now so the
  // resolution chain is fixed and Phase 2 only fills in the power branch.
  if (args.avgPowerW && args.ftpWatts && args.avgPowerW > 0 && args.ftpWatts > 0) {
    const durationH = args.durationS / 3600;
    const intensity = args.avgPowerW / args.ftpWatts;
    return Math.round(durationH * intensity * intensity * 100 * 10) / 10;
  }
  // HR path (Phase 1)
  if (args.avgHr && args.thresholdHr && args.avgHr > 0 && args.thresholdHr > 0) {
    return computeHrTss(args.durationS, args.avgHr, args.thresholdHr);
  }
  return null;
}
```

- [ ] **Step 2: Extend scripts/audit-endurance-pure.mjs**

Append before `console.log(\`\n${pass} pass…\`);`:

```js
import { computeHrTss, computeTssForActivity } from '@/lib/coach/endurance/tss';

console.log('\n── tss ──');
// 1h @ threshold = 100
check('1h @ LTHR = 100 TSS', computeHrTss(3600, 160, 160), 100);
// 1h @ 80% = 64
check('1h @ 80% LTHR = 64 TSS', computeHrTss(3600, 128, 160), 64);
// 60min @ 132 vs LTHR 162 (user's Phase 1 numbers from snapshot example)
check('60min @ 132 vs LTHR 162', computeHrTss(3600, 132, 162), 66.4);
// 0-duration safety
check('zero duration → 0', computeHrTss(0, 130, 160), 0);

// Resolution chain — HR branch
check('chain: hr branch',
  computeTssForActivity({ durationS: 3600, avgHr: 132, thresholdHr: 162 }),
  66.4);
// Resolution chain — null when neither available
check('chain: null when uncalibrated',
  computeTssForActivity({ durationS: 3600, avgHr: null, thresholdHr: null }),
  null);
// Resolution chain — power preferred when present
check('chain: power preferred',
  computeTssForActivity({ durationS: 3600, avgHr: 132, thresholdHr: 162, avgPowerW: 200, ftpWatts: 250 }),
  64);
```

- [ ] **Step 3: Run audit + typecheck**

```bash
node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-endurance-pure.mjs
npm run typecheck
```

Expected: audit shows `── tss ──` section with 7 ok lines, total `12 pass, 0 fail`; typecheck zero errors.

- [ ] **Step 4: Commit**

```bash
git add lib/coach/endurance/tss.ts scripts/audit-endurance-pure.mjs
git commit -m "feat(endurance): hrTSS + TSS resolution chain

computeHrTss is the Phase 1 formula. computeTssForActivity is the resolution
chain that Phase 2's power branch slots into without ingest-side changes.
Returns null when neither HR nor power data are available — caller surfaces
'calibrate threshold HR' CTA on /profile.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Training-load module (CTL/ATL/TSB)

**Files:**
- Create: `lib/coach/endurance/training-load.ts`
- Modify: `scripts/audit-endurance-pure.mjs`

- [ ] **Step 1: Write lib/coach/endurance/training-load.ts**

```ts
// lib/coach/endurance/training-load.ts — exponentially-weighted training load.
//
// Phase 1 ships the math even though the chart is deferred — composers /
// dashboard rules use CTL/ATL/TSB as numeric inputs.
//
// Standard convention (TrainingPeaks / WKO):
//   CTL = 42-day exponentially-weighted average of daily TSS (fitness)
//   ATL = 7-day  exponentially-weighted average of daily TSS (fatigue)
//   TSB = CTL - ATL (form)
//
// Implemented as a straight pass over a contiguous daily TSS series
// (zero-fill missing days before calling).

const CTL_DAYS = 42;
const ATL_DAYS = 7;

function ewma(series: readonly number[], days: number): number {
  if (series.length === 0) return 0;
  const alpha = 2 / (days + 1);
  let prev = series[0];
  for (let i = 1; i < series.length; i += 1) {
    prev = alpha * series[i] + (1 - alpha) * prev;
  }
  return Math.round(prev * 10) / 10;
}

export type TrainingLoad = { ctl: number; atl: number; tsb: number };

export function computeTrainingLoad(dailyTss: readonly number[]): TrainingLoad {
  const ctl = ewma(dailyTss, CTL_DAYS);
  const atl = ewma(dailyTss, ATL_DAYS);
  return { ctl, atl, tsb: Math.round((ctl - atl) * 10) / 10 };
}

/** Convenience: ramp rate is delta CTL over the last 7 days. */
export function computeRampRate(dailyTss: readonly number[]): number {
  if (dailyTss.length < 8) return 0;
  const today = ewma(dailyTss, CTL_DAYS);
  const weekAgo = ewma(dailyTss.slice(0, -7), CTL_DAYS);
  return Math.round((today - weekAgo) * 10) / 10;
}
```

- [ ] **Step 2: Extend audit script**

```js
import { computeTrainingLoad, computeRampRate } from '@/lib/coach/endurance/training-load';

console.log('\n── training-load ──');
// Empty series → all zero
check('empty → zero', computeTrainingLoad([]), { ctl: 0, atl: 0, tsb: 0 });

// 60 days of 50 TSS/day → steady state, CTL ≈ ATL ≈ 50, TSB ≈ 0
const steady = Array(60).fill(50);
const sl = computeTrainingLoad(steady);
check('steady-state CTL near 50', Math.abs(sl.ctl - 50) < 1, true);
check('steady-state ATL near 50', Math.abs(sl.atl - 50) < 1, true);
check('steady-state TSB near 0',  Math.abs(sl.tsb) < 1, true);

// Spike: 60d at 30 then 7d at 100 — ATL > CTL, TSB negative
const spike = [...Array(60).fill(30), ...Array(7).fill(100)];
const sp = computeTrainingLoad(spike);
check('spike: atl > ctl', sp.atl > sp.ctl, true);
check('spike: tsb negative', sp.tsb < 0, true);
```

- [ ] **Step 3: Run audit + typecheck**

```bash
node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-endurance-pure.mjs
npm run typecheck
```

Expected: `── training-load ──` section with 5 ok lines; typecheck clean.

- [ ] **Step 4: Commit**

```bash
git add lib/coach/endurance/training-load.ts scripts/audit-endurance-pure.mjs
git commit -m "feat(endurance): CTL/ATL/TSB training-load math

Standard TrainingPeaks EWMA: 42d fitness, 7d fatigue, form is their delta.
Phase 1 surfaces won't render the chart yet (deferred) but composers and
dashboard rules use the numbers as inputs.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Z2 base composer + interference seam

**Files:**
- Create: `lib/coach/endurance/compose-z2-base.ts`
- Create: `lib/coach/interference/check-interference.ts`
- Modify: `scripts/audit-endurance-pure.mjs`

- [ ] **Step 1: Write lib/coach/endurance/compose-z2-base.ts**

```ts
// lib/coach/endurance/compose-z2-base.ts — Phase 1 prescription composer.
// Produces a Z2-only week from threshold HR + weekly volume target.
// Output is the same EnduranceSessionPlan shape Phase 2 composers will return.

import { defaultZ2Cap, derivedHrZones } from './hr-zones';
import type {
  EnduranceProfile,
  EnduranceSessionEntry,
  EnduranceSessionPlan,
} from './types';

export type ComposerInput = {
  profile: EnduranceProfile;
  /** Weekday number 0=Sun..6=Sat for the prescribed Z2 day. Phase 1 default: 3 (Wed). */
  preferredDay?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
};

export type ComposerResult =
  | { ok: true; plan: EnduranceSessionPlan; rationale: string }
  | { ok: false; reason: string };

/**
 * Phase 1 composer rules:
 *  - Discipline: cycling only (running/triathlon → not implemented).
 *  - Phase: aerobic_base only (other phases → not implemented).
 *  - Total prescribed minutes = weekly_volume_target_hours * 60.
 *  - Split into 60-min Z2 rides, capped at 5 rides/wk.
 *    At 1h target → 1 × 60min. At 4h → 4 × 60min. At 90min target → 1 × 90min.
 *  - HR cap = profile.threshold_hr * 0.83 (defaultZ2Cap) when threshold_hr set;
 *    otherwise plan still produced but hr_cap omitted (caller flags calibration).
 *  - Days chosen starting from preferredDay (default Wed), spread evenly across the week.
 */
export function composeZ2Base(input: ComposerInput): ComposerResult {
  const { profile, preferredDay = 3 } = input;
  if (profile.discipline !== 'cycling') {
    return { ok: false, reason: `Composer Phase 1 supports cycling only; got ${profile.discipline}` };
  }
  if (profile.phase !== 'aerobic_base') {
    return { ok: false, reason: `Composer Phase 1 supports aerobic_base only; got ${profile.phase}` };
  }
  const totalMinutes = Math.round(profile.weekly_volume_target_hours * 60);
  if (totalMinutes <= 0) {
    return { ok: false, reason: 'weekly_volume_target_hours must be > 0' };
  }

  // Decide number of sessions: prefer 60min/session, cap at 5/wk.
  const PREFERRED_SESSION_MIN = 60;
  const maxSessions = 5;
  const sessionCount = Math.min(maxSessions, Math.max(1, Math.round(totalMinutes / PREFERRED_SESSION_MIN)));
  const perSession = Math.round(totalMinutes / sessionCount);

  // Spread days starting from preferredDay, every ⌈7/n⌉ days.
  const stride = Math.max(1, Math.floor(7 / sessionCount));
  const days: (0|1|2|3|4|5|6)[] = [];
  for (let i = 0; i < sessionCount; i += 1) {
    days.push(((preferredDay + i * stride) % 7) as 0|1|2|3|4|5|6);
  }

  const hrCap = profile.threshold_hr ? defaultZ2Cap(profile.threshold_hr) : undefined;
  const z2Range = profile.threshold_hr ? derivedHrZones(profile.threshold_hr).z2 : undefined;

  const entry: EnduranceSessionEntry = {
    type: 'z2_ride',
    sport: 'cycling',
    duration_min: perSession,
    ...(hrCap !== undefined ? { hr_cap: hrCap } : {}),
    ...(z2Range !== undefined ? { hr_target_range: z2Range } : {}),
    description:
      `${perSession}min Z2 ride` +
      (z2Range ? `, HR ${z2Range[0]}-${z2Range[1]}` : ', HR uncalibrated') +
      ', fat oxidation + aerobic base.',
  };

  const plan: EnduranceSessionPlan = {};
  for (const d of days) plan[d] = entry;

  return {
    ok: true,
    plan,
    rationale:
      `${sessionCount} session${sessionCount > 1 ? 's' : ''} × ${perSession}min Z2 cycling = ${sessionCount * perSession}min/wk ` +
      `(target ${totalMinutes}min). Z2 only at this phase — fat oxidation + mitochondrial density.`,
  };
}
```

- [ ] **Step 2: Write lib/coach/interference/check-interference.ts**

```ts
// lib/coach/interference/check-interference.ts — strength↔endurance autoregulation.
// Phase 1: light rule. Returns 'none' for Z2 base at <5h/wk (always, in current phase).
// Phase 2: formal rules for build/race_prep phases.

import type { EnduranceProfile } from '@/lib/coach/endurance/types';

export type InterferenceAdjustment = {
  adjustment: 'none' | 'reduce_15pct' | 'reduce_30pct';
  rationale: string;
};

export function strengthVolumeAdjustment(
  profile: EnduranceProfile | null,
  endurance7dHours: number,
): InterferenceAdjustment {
  if (!profile) {
    return { adjustment: 'none', rationale: 'No endurance profile configured.' };
  }
  if (profile.phase === 'aerobic_base' && endurance7dHours < 5) {
    return { adjustment: 'none', rationale: 'Z2 base volume too low to cause interference.' };
  }
  if (profile.phase === 'build' && endurance7dHours > 8) {
    return { adjustment: 'reduce_15pct', rationale: 'Build-phase endurance volume causing measurable interference.' };
  }
  if (profile.phase === 'race_prep' && endurance7dHours > 10) {
    return { adjustment: 'reduce_30pct', rationale: 'Race-prep volume — strength maintenance only.' };
  }
  return { adjustment: 'none', rationale: '' };
}
```

- [ ] **Step 3: Extend audit script**

```js
import { composeZ2Base } from '@/lib/coach/endurance/compose-z2-base';
import { strengthVolumeAdjustment } from '@/lib/coach/interference/check-interference';

console.log('\n── compose-z2-base ──');
const profile1h = {
  discipline: 'cycling',
  phase: 'aerobic_base',
  threshold_hr: 162,
  hr_max: null, hr_zones: null, ftp_watts: null, threshold_pace_s_per_km: null,
  weekly_volume_target_hours: 1,
  current_race: null,
  set_at: '2026-05-30T00:00:00Z',
};
const r1 = composeZ2Base({ profile: profile1h });
check('1h target → ok',         r1.ok, true);
check('1h target → 1 session',  r1.ok && Object.keys(r1.plan).length, 1);
check('1h target → 60min',      r1.ok && r1.plan[3]?.duration_min, 60);
check('1h target → hr_cap 134', r1.ok && r1.plan[3]?.hr_cap, 134);

const profile4h = { ...profile1h, weekly_volume_target_hours: 4 };
const r4 = composeZ2Base({ profile: profile4h });
check('4h target → 4 sessions', r4.ok && Object.keys(r4.plan).length, 4);

// Discipline guard
const profileRun = { ...profile1h, discipline: 'running' };
const rr = composeZ2Base({ profile: profileRun });
check('running → not implemented', rr.ok, false);

// Phase guard
const profileBuild = { ...profile1h, phase: 'build' };
const rb = composeZ2Base({ profile: profileBuild });
check('build → not implemented', rb.ok, false);

console.log('\n── interference ──');
check('null profile → none',
  strengthVolumeAdjustment(null, 5).adjustment, 'none');
check('aerobic_base + 1h → none',
  strengthVolumeAdjustment(profile1h, 1).adjustment, 'none');
check('build + 10h → reduce_15pct',
  strengthVolumeAdjustment(profileBuild, 10).adjustment, 'reduce_15pct');
```

- [ ] **Step 4: Run audit + typecheck**

```bash
node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-endurance-pure.mjs
npm run typecheck
```

Expected: 9 new ok lines across composer + interference sections.

- [ ] **Step 5: Commit**

```bash
git add lib/coach/endurance/compose-z2-base.ts lib/coach/interference/check-interference.ts scripts/audit-endurance-pure.mjs
git commit -m "feat(endurance): compose-z2-base composer + interference seam

Composer is gated to cycling+aerobic_base in Phase 1; build/race_prep/taper
return ok:false with a reason the caller surfaces. At 1h target produces
1×60min, at 4h target 4×60min (spread Wed/Sat/Tue/Fri by default).

strengthVolumeAdjustment is the autoregulation seam — always returns 'none'
at the current 1h/wk volume but the structure is in place for Phase 2 rules.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Strava types + client (token refresh)

**Files:**
- Create: `lib/strava/types.ts`
- Create: `lib/strava/client.ts`
- Modify: `.env.example`

**Pre-req:** User must have provided `STRAVA_CLIENT_ID` + `STRAVA_CLIENT_SECRET` in `.env.local` for client-construction to succeed at runtime. The code itself doesn't need them at typecheck time.

- [ ] **Step 1: Write lib/strava/types.ts**

```ts
// lib/strava/types.ts — Strava API response shapes (subset we consume).
// Full responses preserved in endurance_activities.raw for replay.

export type StravaTokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_at: number; // unix seconds
  expires_in: number;
  token_type: 'Bearer';
  athlete?: { id: number };
};

export type StravaActivitySummary = {
  id: number;
  external_id: string | null;
  name: string;
  type: string;          // "Ride" | "Run" | "Swim" | …
  sport_type?: string;   // newer field, prefer when present
  start_date: string;        // UTC iso
  start_date_local: string;  // ISO without tz suffix — already local
  timezone: string;          // e.g. "(GMT+04:00) Asia/Dubai"
  utc_offset: number;
  elapsed_time: number;      // seconds
  moving_time: number;
  distance: number;          // meters
  total_elevation_gain: number;
  average_heartrate?: number;
  max_heartrate?: number;
  average_watts?: number;
  weighted_average_watts?: number;
  average_speed?: number;    // m/s
  calories?: number;
  device_watts?: boolean;
};

export type StravaActivityDetail = StravaActivitySummary & {
  calories: number;
  description?: string;
  // detail endpoint returns much more; we keep what we use
};

export type StravaStream = {
  type: 'heartrate' | 'time' | 'cadence' | 'watts' | 'distance';
  data: number[];
  series_type: 'time' | 'distance';
  original_size: number;
  resolution: 'low' | 'medium' | 'high';
};

export type StravaWebhookEvent = {
  aspect_type: 'create' | 'update' | 'delete';
  event_time: number;
  object_id: number;
  object_type: 'activity' | 'athlete';
  owner_id: number;
  subscription_id: number;
  updates?: Record<string, string>;
};
```

- [ ] **Step 2: Write lib/strava/client.ts**

```ts
// lib/strava/client.ts — fetch wrapper that auto-refreshes the access token.
// Mirrors the WHOOP pattern: read tokens from strava_tokens table via the
// service-role client, refresh if within 5min of expiry, persist back.

import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import type {
  StravaActivityDetail,
  StravaActivitySummary,
  StravaStream,
  StravaTokenResponse,
} from './types';

const STRAVA_BASE = 'https://www.strava.com/api/v3';
const REFRESH_BUFFER_S = 300; // refresh if expires within 5min

type Tokens = {
  user_id: string;
  access_token: string;
  refresh_token: string;
  expires_at: string; // ISO
  strava_athlete_id: string | null;
};

async function readTokens(userId: string): Promise<Tokens | null> {
  const sb = createSupabaseServiceRoleClient();
  const { data, error } = await sb
    .from('strava_tokens')
    .select('user_id, access_token, refresh_token, expires_at, strava_athlete_id')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(`readTokens: ${error.message}`);
  return data ?? null;
}

async function writeTokens(userId: string, t: StravaTokenResponse): Promise<void> {
  const sb = createSupabaseServiceRoleClient();
  const { error } = await sb.from('strava_tokens').upsert({
    user_id: userId,
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at: new Date(t.expires_at * 1000).toISOString(),
    ...(t.athlete?.id ? { strava_athlete_id: String(t.athlete.id) } : {}),
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(`writeTokens: ${error.message}`);
}

async function refreshAccessToken(refreshToken: string): Promise<StravaTokenResponse> {
  const body = new URLSearchParams({
    client_id: process.env.STRAVA_CLIENT_ID ?? '',
    client_secret: process.env.STRAVA_CLIENT_SECRET ?? '',
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  const r = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Strava token refresh failed ${r.status}: ${txt}`);
  }
  return (await r.json()) as StravaTokenResponse;
}

async function ensureFreshToken(userId: string): Promise<Tokens> {
  const t = await readTokens(userId);
  if (!t) throw new Error(`No strava_tokens row for user ${userId}; user must OAuth first.`);
  const expiresAtS = Math.floor(new Date(t.expires_at).getTime() / 1000);
  const nowS = Math.floor(Date.now() / 1000);
  if (expiresAtS - nowS > REFRESH_BUFFER_S) return t;
  const fresh = await refreshAccessToken(t.refresh_token);
  await writeTokens(userId, fresh);
  return {
    user_id: userId,
    access_token: fresh.access_token,
    refresh_token: fresh.refresh_token,
    expires_at: new Date(fresh.expires_at * 1000).toISOString(),
    strava_athlete_id: t.strava_athlete_id,
  };
}

async function call<T>(userId: string, path: string, init: RequestInit = {}): Promise<T> {
  const t = await ensureFreshToken(userId);
  const r = await fetch(`${STRAVA_BASE}${path}`, {
    ...init,
    headers: { ...init.headers, authorization: `Bearer ${t.access_token}` },
  });
  if (r.status === 401) {
    // Token died mid-flight; force refresh and retry once.
    const fresh = await refreshAccessToken(t.refresh_token);
    await writeTokens(userId, fresh);
    const r2 = await fetch(`${STRAVA_BASE}${path}`, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${fresh.access_token}` },
    });
    if (!r2.ok) throw new Error(`Strava ${path} ${r2.status}: ${await r2.text()}`);
    return (await r2.json()) as T;
  }
  if (!r.ok) throw new Error(`Strava ${path} ${r.status}: ${await r.text()}`);
  return (await r.json()) as T;
}

export async function listActivities(
  userId: string,
  opts: { after?: number; before?: number; page?: number; perPage?: number } = {},
): Promise<StravaActivitySummary[]> {
  const q = new URLSearchParams();
  if (opts.after) q.set('after', String(opts.after));
  if (opts.before) q.set('before', String(opts.before));
  q.set('page', String(opts.page ?? 1));
  q.set('per_page', String(opts.perPage ?? 30));
  return call<StravaActivitySummary[]>(userId, `/athlete/activities?${q}`);
}

export async function getActivityDetail(userId: string, id: number): Promise<StravaActivityDetail> {
  return call<StravaActivityDetail>(userId, `/activities/${id}?include_all_efforts=false`);
}

export async function getActivityStreams(
  userId: string,
  id: number,
  keys: Array<'heartrate' | 'watts' | 'time' | 'cadence' | 'distance'> = ['heartrate', 'time'],
): Promise<Record<string, StravaStream>> {
  const data = await call<StravaStream[]>(
    userId,
    `/activities/${id}/streams?keys=${keys.join(',')}&key_by_type=true`,
  );
  // When key_by_type=true Strava returns an object map, not an array, despite the docs.
  return data as unknown as Record<string, StravaStream>;
}

export async function deauthorizeUser(userId: string): Promise<void> {
  // Calls Strava's deauthorize endpoint and then nukes the local row.
  const t = await readTokens(userId);
  if (!t) return;
  await fetch('https://www.strava.com/oauth/deauthorize', {
    method: 'POST',
    headers: { authorization: `Bearer ${t.access_token}` },
  }).catch(() => {/* best-effort */});
  const sb = createSupabaseServiceRoleClient();
  await sb.from('strava_tokens').delete().eq('user_id', userId);
}
```

- [ ] **Step 3: Add Strava env vars to .env.example**

Append to `.env.example`:

```
# Strava OAuth — one app for dev (callback localhost), separate for prod
STRAVA_CLIENT_ID=
STRAVA_CLIENT_SECRET=
# Random 32-char, used by the webhook subscription handshake
STRAVA_VERIFY_TOKEN=
# Public callback URL — must match the Authorization Callback Domain in your Strava app
STRAVA_WEBHOOK_CALLBACK_URL=
```

- [ ] **Step 4: Verify typecheck**

```bash
npm run typecheck
```

Expected: zero errors.

- [ ] **Step 5: Commit**

```bash
git add lib/strava/types.ts lib/strava/client.ts .env.example
git commit -m "feat(strava): API types + client with auto token refresh

Mirrors WHOOP/Withings pattern: dedicated table read via service-role,
refresh if within 5min of expiry, write back. 401 mid-flight triggers
one forced refresh-and-retry then surfaces the error.

listActivities, getActivityDetail, getActivityStreams (key_by_type=true)
are the only surface the ingest path consumes. deauthorizeUser implements
the /disconnect path and is best-effort on the Strava-side call.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Strava OAuth routes

**Files:**
- Create: `lib/strava/oauth.ts`
- Create: `app/api/strava/auth/route.ts`
- Create: `app/api/strava/callback/route.ts`
- Create: `app/api/strava/disconnect/route.ts`

- [ ] **Step 1: Write lib/strava/oauth.ts**

```ts
// lib/strava/oauth.ts — authorization URL + token exchange.

import type { StravaTokenResponse } from './types';

const SCOPES = 'read,activity:read_all,profile:read_all';

export function buildAuthorizationUrl(state: string, redirectUri: string): string {
  const q = new URLSearchParams({
    client_id: process.env.STRAVA_CLIENT_ID ?? '',
    response_type: 'code',
    redirect_uri: redirectUri,
    approval_prompt: 'auto',
    scope: SCOPES,
    state,
  });
  return `https://www.strava.com/oauth/authorize?${q}`;
}

export async function exchangeCodeForTokens(code: string): Promise<StravaTokenResponse> {
  const body = new URLSearchParams({
    client_id: process.env.STRAVA_CLIENT_ID ?? '',
    client_secret: process.env.STRAVA_CLIENT_SECRET ?? '',
    code,
    grant_type: 'authorization_code',
  });
  const r = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`exchangeCodeForTokens failed ${r.status}: ${txt}`);
  }
  return (await r.json()) as StravaTokenResponse;
}
```

- [ ] **Step 2: Write app/api/strava/auth/route.ts**

```ts
// app/api/strava/auth/route.ts — kick off OAuth.
// Mints a CSRF state, stashes it in a cookie, redirects to Strava.

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { randomBytes } from 'node:crypto';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { buildAuthorizationUrl } from '@/lib/strava/oauth';

export async function GET() {
  const sb = await createSupabaseServerClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.redirect(new URL('/login', process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'));

  const state = randomBytes(16).toString('hex');
  const jar = await cookies();
  jar.set('strava_oauth_state', state, {
    httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: 600,
  });

  const base = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  const redirectUri = `${base}/api/strava/callback`;
  return NextResponse.redirect(buildAuthorizationUrl(state, redirectUri));
}
```

- [ ] **Step 3: Write app/api/strava/callback/route.ts**

```ts
// app/api/strava/callback/route.ts — exchange code, persist tokens, redirect to /profile.

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createSupabaseServerClient, createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { exchangeCodeForTokens } from '@/lib/strava/oauth';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');
  const base = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

  if (error) {
    return NextResponse.redirect(`${base}/profile?strava_error=${encodeURIComponent(error)}`);
  }
  if (!code || !state) {
    return NextResponse.redirect(`${base}/profile?strava_error=missing_code_or_state`);
  }

  const jar = await cookies();
  const expectedState = jar.get('strava_oauth_state')?.value;
  if (!expectedState || expectedState !== state) {
    return NextResponse.redirect(`${base}/profile?strava_error=csrf_mismatch`);
  }
  jar.delete('strava_oauth_state');

  const sb = await createSupabaseServerClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.redirect(`${base}/login`);

  let tokens;
  try {
    tokens = await exchangeCodeForTokens(code);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.redirect(`${base}/profile?strava_error=${encodeURIComponent(msg)}`);
  }

  const svc = createSupabaseServiceRoleClient();
  const { error: upErr } = await svc.from('strava_tokens').upsert({
    user_id: user.id,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: new Date(tokens.expires_at * 1000).toISOString(),
    strava_athlete_id: tokens.athlete?.id ? String(tokens.athlete.id) : null,
    updated_at: new Date().toISOString(),
  });
  if (upErr) {
    return NextResponse.redirect(`${base}/profile?strava_error=${encodeURIComponent(upErr.message)}`);
  }

  return NextResponse.redirect(`${base}/profile?strava=connected`);
}
```

- [ ] **Step 4: Write app/api/strava/disconnect/route.ts**

```ts
// app/api/strava/disconnect/route.ts — POST to revoke + delete tokens.

import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { deauthorizeUser } from '@/lib/strava/client';

export async function POST() {
  const sb = await createSupabaseServerClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  await deauthorizeUser(user.id);
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 5: Verify typecheck**

```bash
npm run typecheck
```

Expected: zero errors.

- [ ] **Step 6: Manual smoke (once user has provided STRAVA_CLIENT_ID / SECRET in .env.local)**

Start dev server: `npm run dev`. Navigate to `http://localhost:3000/api/strava/auth` while logged in. Should redirect to Strava consent screen. After approval, browser lands at `/profile?strava=connected` and `select * from strava_tokens` in Supabase Studio shows one row with the correct user_id and a future `expires_at`.

- [ ] **Step 7: Commit**

```bash
git add lib/strava/oauth.ts app/api/strava/auth/route.ts app/api/strava/callback/route.ts app/api/strava/disconnect/route.ts
git commit -m "feat(strava): OAuth auth / callback / disconnect routes

CSRF state in httpOnly cookie. Callback persists tokens via service-role
(bypasses RLS) keyed on user_id. Disconnect calls Strava's deauthorize
endpoint best-effort then deletes the row. All redirects land back on
/profile so the user sees connection status.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Strava ingest module

**Files:**
- Create: `lib/strava/ingest.ts`

- [ ] **Step 1: Write lib/strava/ingest.ts**

```ts
// lib/strava/ingest.ts — Strava activity → endurance_activities row + daily_logs re-aggregation.
//
// Flow per activity:
//  1. fetch detail (we usually already have summary from list endpoint; detail adds calories)
//  2. fetch HR stream if HR was recorded
//  3. compute hr_zone_distribution + hrTSS using user's threshold_hr
//  4. upsert endurance_activities by (user_id, source, external_id)
//  5. call sum_endurance_for_day(user_id, local_date) and upsert daily_logs

import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { getActivityDetail, getActivityStreams } from './client';
import { bucketZones } from '@/lib/coach/endurance/hr-zones';
import { computeTssForActivity } from '@/lib/coach/endurance/tss';
import type { StravaActivityDetail } from './types';
import type { EnduranceProfile } from '@/lib/coach/endurance/types';
import type { HrZoneDistribution } from '@/lib/data/types';

function mapSport(t: string): 'cycling' | 'running' | 'swimming' | 'other' {
  const v = t.toLowerCase();
  if (v.includes('ride') || v.includes('cycl') || v === 'virtualride') return 'cycling';
  if (v.includes('run')) return 'running';
  if (v.includes('swim')) return 'swimming';
  return 'other';
}

function localDateFromStrava(startLocalIso: string): string {
  // Strava's start_date_local is ISO without timezone suffix; it's already in
  // local time at the activity's start location. Slice the date portion.
  return startLocalIso.slice(0, 10);
}

async function readEnduranceProfile(userId: string): Promise<EnduranceProfile | null> {
  const sb = createSupabaseServiceRoleClient();
  const { data, error } = await sb
    .from('athlete_profile_documents')
    .select('endurance_profile')
    .eq('user_id', userId)
    .eq('status', 'acknowledged')
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`readEnduranceProfile: ${error.message}`);
  return (data?.endurance_profile as EnduranceProfile | null) ?? null;
}

export async function ingestActivity(args: {
  userId: string;
  stravaActivityId: number;
  prefetchedDetail?: StravaActivityDetail;
}): Promise<{ activityId: string; localDate: string }> {
  const { userId, stravaActivityId } = args;
  const sb = createSupabaseServiceRoleClient();

  const detail = args.prefetchedDetail ?? (await getActivityDetail(userId, stravaActivityId));
  const profile = await readEnduranceProfile(userId);
  const thresholdHr = profile?.threshold_hr ?? null;

  // HR-stream fetch only if HR was recorded; saves API calls.
  let hrZoneDist: HrZoneDistribution | null = null;
  if (detail.average_heartrate && thresholdHr) {
    try {
      const streams = await getActivityStreams(userId, stravaActivityId, ['heartrate']);
      const hr = streams.heartrate?.data ?? [];
      hrZoneDist = bucketZones(hr, thresholdHr);
    } catch {
      // stream may 404 for some activities (rare); fall through
    }
  }

  const tss = computeTssForActivity({
    durationS: detail.moving_time,
    avgHr: detail.average_heartrate ?? null,
    thresholdHr,
    avgPowerW: detail.average_watts ?? null,
    ftpWatts: profile?.ftp_watts ?? null,
  });

  const localDate = localDateFromStrava(detail.start_date_local);

  const row = {
    user_id: userId,
    source: 'strava' as const,
    external_id: String(detail.id),
    sport: mapSport(detail.sport_type ?? detail.type),
    started_at: detail.start_date,
    local_date: localDate,
    duration_s: detail.moving_time,
    distance_m: detail.distance ?? null,
    elevation_gain_m: detail.total_elevation_gain ?? null,
    avg_hr: detail.average_heartrate ? Math.round(detail.average_heartrate) : null,
    max_hr: detail.max_heartrate ? Math.round(detail.max_heartrate) : null,
    hr_zone_distribution: hrZoneDist,
    avg_power_w: detail.average_watts ? Math.round(detail.average_watts) : null,
    normalized_power_w: detail.weighted_average_watts ? Math.round(detail.weighted_average_watts) : null,
    intensity_factor: null as number | null,
    tss,
    avg_pace_s_per_km: detail.average_speed && detail.average_speed > 0
      ? Math.round(1000 / detail.average_speed)
      : null,
    avg_speed_kmh: detail.average_speed ? Math.round(detail.average_speed * 3.6 * 10) / 10 : null,
    calories: detail.calories ? Math.round(detail.calories) : null,
    raw: detail as unknown,
    deleted_at: null,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await sb
    .from('endurance_activities')
    .upsert(row, { onConflict: 'user_id,source,external_id' })
    .select('id')
    .single();
  if (error) throw new Error(`upsert endurance_activities: ${error.message}`);

  await reaggregateDay(userId, localDate);
  return { activityId: data.id, localDate };
}

export async function softDeleteActivity(args: {
  userId: string;
  stravaActivityId: number;
}): Promise<void> {
  const sb = createSupabaseServiceRoleClient();
  const { data, error } = await sb
    .from('endurance_activities')
    .update({ deleted_at: new Date().toISOString() })
    .eq('user_id', args.userId)
    .eq('source', 'strava')
    .eq('external_id', String(args.stravaActivityId))
    .select('local_date')
    .maybeSingle();
  if (error) throw new Error(`softDeleteActivity: ${error.message}`);
  if (data?.local_date) await reaggregateDay(args.userId, data.local_date);
}

export async function reaggregateDay(userId: string, localDate: string): Promise<void> {
  const sb = createSupabaseServiceRoleClient();
  const { data, error } = await sb.rpc('sum_endurance_for_day', { p_user_id: userId, p_date: localDate });
  if (error) throw new Error(`sum_endurance_for_day: ${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  const tssSum = Number(row?.tss_sum ?? 0);
  const minSum = Number(row?.duration_minutes_sum ?? 0);
  const z2Sum = Number(row?.z2_minutes_sum ?? 0);
  const { error: upErr } = await sb
    .from('daily_logs')
    .upsert(
      {
        user_id: userId,
        date: localDate,
        endurance_load: tssSum,
        endurance_minutes: minSum,
        endurance_z2_minutes: z2Sum,
      },
      { onConflict: 'user_id,date' },
    );
  if (upErr) throw new Error(`daily_logs upsert: ${upErr.message}`);
}
```

- [ ] **Step 2: Verify typecheck**

```bash
npm run typecheck
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add lib/strava/ingest.ts
git commit -m "feat(strava): activity ingest + day re-aggregation

ingestActivity is the single write path used by webhook + sync + backfill.
HR stream only fetched when both avg_heartrate and threshold_hr exist —
saves API calls. reaggregateDay calls sum_endurance_for_day RPC and upserts
daily_logs.endurance_* — same pattern as food/commit re-aggregation.
softDeleteActivity handles webhook DELETE events.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Strava sync + backfill routes

**Files:**
- Create: `app/api/strava/sync/route.ts` (CRON_SECRET-gated daily sync, last 7 days)
- Create: `app/api/strava/backfill/route.ts` (session-authed, paginated historical)

- [ ] **Step 1: Write app/api/strava/sync/route.ts**

```ts
// app/api/strava/sync/route.ts — daily catch-up for missed webhook deliveries.
// Gated by CRON_SECRET; runs at 09:00 UTC via vercel.json.

import { NextResponse } from 'next/server';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { listActivities } from '@/lib/strava/client';
import { ingestActivity } from '@/lib/strava/ingest';

export const maxDuration = 60;

export async function GET(req: Request) {
  const auth = req.headers.get('authorization');
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const sb = createSupabaseServiceRoleClient();
  const { data: tokens, error } = await sb.from('strava_tokens').select('user_id');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const sevenDaysAgo = Math.floor(Date.now() / 1000) - 7 * 24 * 3600;
  const results: Array<{ user_id: string; ingested: number; errors: number }> = [];

  for (const t of tokens ?? []) {
    let ingested = 0;
    let errors = 0;
    try {
      const acts = await listActivities(t.user_id, { after: sevenDaysAgo, perPage: 50 });
      for (const a of acts) {
        try {
          await ingestActivity({ userId: t.user_id, stravaActivityId: a.id });
          ingested += 1;
        } catch {
          errors += 1;
        }
      }
    } catch {
      errors += 1;
    }
    results.push({ user_id: t.user_id, ingested, errors });
  }

  return NextResponse.json({ ok: true, results });
}
```

- [ ] **Step 2: Write app/api/strava/backfill/route.ts**

```ts
// app/api/strava/backfill/route.ts — session-authed historical backfill.
// POST /api/strava/backfill?since=YYYY-MM-DD
// Paginated; respects Strava's 200req/15min limit by pausing between pages.

import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { listActivities } from '@/lib/strava/client';
import { ingestActivity } from '@/lib/strava/ingest';

export const maxDuration = 300;

const DEFAULT_SINCE_DAYS = 90;

function sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }

export async function POST(req: Request) {
  const sb = await createSupabaseServerClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const url = new URL(req.url);
  const since = url.searchParams.get('since');
  const sinceTs = since
    ? Math.floor(new Date(`${since}T00:00:00Z`).getTime() / 1000)
    : Math.floor(Date.now() / 1000) - DEFAULT_SINCE_DAYS * 24 * 3600;

  let page = 1;
  let totalIngested = 0;
  let totalErrors = 0;
  while (true) {
    const acts = await listActivities(user.id, { after: sinceTs, page, perPage: 30 });
    if (acts.length === 0) break;
    for (const a of acts) {
      try {
        await ingestActivity({ userId: user.id, stravaActivityId: a.id });
        totalIngested += 1;
      } catch {
        totalErrors += 1;
      }
    }
    if (acts.length < 30) break;
    page += 1;
    await sleep(500); // gentle pace
  }
  return NextResponse.json({ ok: true, ingested: totalIngested, errors: totalErrors });
}
```

- [ ] **Step 3: Verify typecheck**

```bash
npm run typecheck
```

Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add app/api/strava/sync/route.ts app/api/strava/backfill/route.ts
git commit -m "feat(strava): sync (cron) + backfill (session) routes

/api/strava/sync runs daily 09:00 UTC catching webhook misses for last 7d.
/api/strava/backfill is session-authed, defaults to last 90d, accepts
?since=YYYY-MM-DD for arbitrary windows. 500ms sleep between pages keeps
us well inside the 200req/15min Strava budget.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Strava webhook + subscribe script

**Files:**
- Create: `app/api/strava/webhook/route.ts`
- Create: `scripts/strava-subscribe-webhook.mjs`

- [ ] **Step 1: Write app/api/strava/webhook/route.ts**

```ts
// app/api/strava/webhook/route.ts
// GET = subscription validation handshake (echoes hub.challenge).
// POST = activity events (create/update/delete).
// Strava sends owner_id (athlete id); we map back to our user via strava_tokens.

import { NextResponse } from 'next/server';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { ingestActivity, softDeleteActivity } from '@/lib/strava/ingest';
import type { StravaWebhookEvent } from '@/lib/strava/types';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');
  if (mode === 'subscribe' && token === process.env.STRAVA_VERIFY_TOKEN && challenge) {
    return NextResponse.json({ 'hub.challenge': challenge });
  }
  return NextResponse.json({ error: 'bad_handshake' }, { status: 400 });
}

export async function POST(req: Request) {
  let evt: StravaWebhookEvent;
  try {
    evt = (await req.json()) as StravaWebhookEvent;
  } catch {
    return NextResponse.json({ error: 'bad_json' }, { status: 400 });
  }

  // Acknowledge immediately — Strava times out at 2s.
  // Spawn the actual work in the background.
  void handleEvent(evt).catch((e) => console.error('[strava webhook]', e));
  return NextResponse.json({ ok: true });
}

async function handleEvent(evt: StravaWebhookEvent): Promise<void> {
  if (evt.object_type !== 'activity') return;

  const sb = createSupabaseServiceRoleClient();
  const { data: tok, error } = await sb
    .from('strava_tokens')
    .select('user_id')
    .eq('strava_athlete_id', String(evt.owner_id))
    .maybeSingle();
  if (error || !tok) {
    console.warn('[strava webhook] no token for owner', evt.owner_id);
    return;
  }

  if (evt.aspect_type === 'create' || evt.aspect_type === 'update') {
    await ingestActivity({ userId: tok.user_id, stravaActivityId: evt.object_id });
  } else if (evt.aspect_type === 'delete') {
    await softDeleteActivity({ userId: tok.user_id, stravaActivityId: evt.object_id });
  }
}
```

- [ ] **Step 2: Write scripts/strava-subscribe-webhook.mjs**

```js
// scripts/strava-subscribe-webhook.mjs — one-shot webhook subscription registration.
// Run via: node --env-file=.env.local scripts/strava-subscribe-webhook.mjs [list|create|delete]
// Default action: list. Requires STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET,
// STRAVA_WEBHOOK_CALLBACK_URL, STRAVA_VERIFY_TOKEN in env.

const action = process.argv[2] ?? 'list';
const { STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, STRAVA_WEBHOOK_CALLBACK_URL, STRAVA_VERIFY_TOKEN } = process.env;

if (!STRAVA_CLIENT_ID || !STRAVA_CLIENT_SECRET) {
  console.error('STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET required');
  process.exit(1);
}

const base = 'https://www.strava.com/api/v3/push_subscriptions';
const authQuery = `client_id=${STRAVA_CLIENT_ID}&client_secret=${STRAVA_CLIENT_SECRET}`;

async function list() {
  const r = await fetch(`${base}?${authQuery}`);
  console.log(r.status, await r.text());
}

async function create() {
  if (!STRAVA_WEBHOOK_CALLBACK_URL || !STRAVA_VERIFY_TOKEN) {
    console.error('STRAVA_WEBHOOK_CALLBACK_URL and STRAVA_VERIFY_TOKEN required for create');
    process.exit(1);
  }
  const body = new URLSearchParams({
    client_id: STRAVA_CLIENT_ID,
    client_secret: STRAVA_CLIENT_SECRET,
    callback_url: STRAVA_WEBHOOK_CALLBACK_URL,
    verify_token: STRAVA_VERIFY_TOKEN,
  });
  const r = await fetch(base, { method: 'POST', body });
  console.log(r.status, await r.text());
}

async function del() {
  const id = process.argv[3];
  if (!id) { console.error('usage: delete <subscription_id>'); process.exit(1); }
  const r = await fetch(`${base}/${id}?${authQuery}`, { method: 'DELETE' });
  console.log(r.status, await r.text());
}

if (action === 'list') await list();
else if (action === 'create') await create();
else if (action === 'delete') await del();
else { console.error('actions: list | create | delete <id>'); process.exit(1); }
```

- [ ] **Step 3: Verify typecheck**

```bash
npm run typecheck
```

Expected: zero errors. (`.mjs` script is not part of TS project, only the route is checked.)

- [ ] **Step 4: Manual subscribe (after deploying to prod or running ngrok for local)**

```bash
# Confirm none exists:
node --env-file=.env.local scripts/strava-subscribe-webhook.mjs list
# Create:
node --env-file=.env.local scripts/strava-subscribe-webhook.mjs create
```

Expected: `create` returns `201` with `{ "id": <number> }`. Subscription survives token refreshes; only re-register on callback URL change.

- [ ] **Step 5: Commit**

```bash
git add app/api/strava/webhook/route.ts scripts/strava-subscribe-webhook.mjs
git commit -m "feat(strava): webhook handler + subscription script

GET handshake echoes hub.challenge when verify_token matches.
POST acks immediately (Strava's 2s timeout) and runs the ingest in the
background via void promise; create/update both call ingestActivity, delete
calls softDeleteActivity. owner_id → user_id mapping via strava_tokens.
Subscription is created once via scripts/strava-subscribe-webhook.mjs; survives
token refresh.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: Approval-token action + Carter milestone tools

**Files:**
- Modify: `lib/coach/approval-token.ts` — extend `ApprovalAction`
- Modify: `lib/coach/tools.ts` — add 4 milestone tool schemas + executors

- [ ] **Step 1: Extend ApprovalAction**

In `lib/coach/approval-token.ts` find the line:

```ts
export type ApprovalAction = "block" | "week" | "plan" | "weekly_review" | "nutrition_targets" | "session_today" | "session_template" | "meal_log";
```

Replace with:

```ts
export type ApprovalAction = "block" | "week" | "plan" | "weekly_review" | "nutrition_targets" | "session_today" | "session_template" | "meal_log" | "endurance_week";
```

- [ ] **Step 2: Add milestone tool schemas + executors in lib/coach/tools.ts**

After the existing `executeSetGlp1*` functions, add:

```ts
// ── Endurance milestone tools (direct write, no HMAC; mirror GLP-1 milestone tools) ──

export const SET_ENDURANCE_PHASE_TOOL = {
  name: 'set_endurance_phase',
  description:
    "Update the active athlete profile's endurance_profile.phase in place. Use when the athlete transitions phases (aerobic_base → build, build → race_prep, etc). Optionally update weekly_volume_target_hours in the same call. Phase 1 supports aerobic_base only; other phases will write but the composer won't produce prescriptions for them yet.",
  input_schema: {
    type: 'object' as const,
    required: ['phase'],
    properties: {
      phase: { type: 'string', enum: ['aerobic_base', 'build', 'race_prep', 'taper', 'off_season'] },
      weekly_volume_target_hours: { type: 'number', minimum: 0.5, maximum: 20 },
    },
  },
} as const;

export const SET_ENDURANCE_DISCIPLINE_TOOL = {
  name: 'set_endurance_discipline',
  description:
    "Update the active athlete profile's endurance_profile.discipline. Use when transitioning from cycling-only to triathlon (or vice versa). Phase 1 ships cycling only; setting 'triathlon' or 'running' is permitted but the composer will return ok:false until Phase 2.",
  input_schema: {
    type: 'object' as const,
    required: ['discipline'],
    properties: {
      discipline: { type: 'string', enum: ['cycling', 'running', 'triathlon'] },
    },
  },
} as const;

export const SET_THRESHOLD_HR_TOOL = {
  name: 'set_threshold_hr',
  description:
    "Set the athlete's lactate-threshold HR (LTHR, bpm). Used as the anchor for HR-based TSS computation and Z2/Z4 zone derivation. Without it, TSS for new activities is null. Calibration sources: 30-minute time trial average HR (gold standard), or recent threshold-effort average HR.",
  input_schema: {
    type: 'object' as const,
    required: ['bpm'],
    properties: { bpm: { type: 'integer', minimum: 80, maximum: 220 } },
  },
} as const;

export const SET_FTP_TOOL = {
  name: 'set_ftp',
  description:
    "Set the athlete's functional threshold power (FTP, watts) for cycling. Phase 2 use — once power data exists in endurance_activities, computeTssForActivity will prefer the power formula over HR. Setting this in Phase 1 is harmless; the column simply isn't read yet.",
  input_schema: {
    type: 'object' as const,
    required: ['watts'],
    properties: { watts: { type: 'integer', minimum: 50, maximum: 600 } },
  },
} as const;

async function patchEnduranceProfile(
  userId: string,
  patch: Partial<import('@/lib/coach/endurance/types').EnduranceProfile>,
): Promise<import('@/lib/coach/endurance/types').EnduranceProfile> {
  const sb = (await import('@/lib/supabase/server')).createSupabaseServiceRoleClient();
  const { data: row, error } = await sb
    .from('athlete_profile_documents')
    .select('id, endurance_profile')
    .eq('user_id', userId)
    .eq('status', 'acknowledged')
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`read athlete profile: ${error.message}`);
  if (!row) throw new Error('No acknowledged athlete profile; complete onboarding first.');

  const existing = (row.endurance_profile ?? {
    discipline: 'cycling',
    phase: 'aerobic_base',
    threshold_hr: null,
    hr_max: null,
    hr_zones: null,
    ftp_watts: null,
    threshold_pace_s_per_km: null,
    weekly_volume_target_hours: 1,
    current_race: null,
    set_at: new Date().toISOString(),
  }) as import('@/lib/coach/endurance/types').EnduranceProfile;

  const merged = { ...existing, ...patch, set_at: new Date().toISOString() };
  const { error: upErr } = await sb
    .from('athlete_profile_documents')
    .update({ endurance_profile: merged })
    .eq('id', row.id);
  if (upErr) throw new Error(`update athlete profile: ${upErr.message}`);
  return merged;
}

export async function executeSetEndurancePhase(opts: {
  userId: string;
  input: { phase: 'aerobic_base' | 'build' | 'race_prep' | 'taper' | 'off_season'; weekly_volume_target_hours?: number };
}) {
  const t0 = Date.now();
  const patch: Partial<import('@/lib/coach/endurance/types').EnduranceProfile> = { phase: opts.input.phase };
  if (opts.input.weekly_volume_target_hours != null) {
    patch.weekly_volume_target_hours = opts.input.weekly_volume_target_hours;
  }
  const merged = await patchEnduranceProfile(opts.userId, patch);
  return { ok: true as const, data: merged, meta: { ms: Date.now() - t0, range_days: 0 } };
}

export async function executeSetEnduranceDiscipline(opts: {
  userId: string;
  input: { discipline: 'cycling' | 'running' | 'triathlon' };
}) {
  const t0 = Date.now();
  const merged = await patchEnduranceProfile(opts.userId, { discipline: opts.input.discipline });
  return { ok: true as const, data: merged, meta: { ms: Date.now() - t0, range_days: 0 } };
}

export async function executeSetThresholdHr(opts: { userId: string; input: { bpm: number } }) {
  const t0 = Date.now();
  const merged = await patchEnduranceProfile(opts.userId, { threshold_hr: opts.input.bpm });
  return { ok: true as const, data: merged, meta: { ms: Date.now() - t0, range_days: 0 } };
}

export async function executeSetFtp(opts: { userId: string; input: { watts: number } }) {
  const t0 = Date.now();
  const merged = await patchEnduranceProfile(opts.userId, { ftp_watts: opts.input.watts });
  return { ok: true as const, data: merged, meta: { ms: Date.now() - t0, range_days: 0 } };
}
```

- [ ] **Step 3: Verify typecheck**

```bash
npm run typecheck
```

Expected: zero errors. (Wire-up into CARTER_TOOLS / dispatcher happens in Task 13.)

- [ ] **Step 4: Commit**

```bash
git add lib/coach/approval-token.ts lib/coach/tools.ts
git commit -m "feat(coach): endurance milestone tools (set_phase / discipline / threshold_hr / ftp)

Direct writes, no HMAC — mirrors set_glp1_* pattern. patchEnduranceProfile
is the shared upsert: reads latest acknowledged profile, merges patch,
writes back with refreshed set_at. Adds 'endurance_week' to ApprovalAction
union ahead of Task 13's HMAC propose/commit tools.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: Carter HMAC tools + query tool + chat wiring

**Files:**
- Modify: `lib/coach/tools.ts` — add `query_endurance_activities`, `propose_endurance_week`, `commit_endurance_week`, wire all 7 into `CARTER_TOOLS`, add dispatch cases
- Modify: `lib/coach/chat-stream.ts` — `PERSIST_RESULT_TOOLS` + `modeAllowsTool`

- [ ] **Step 1: Add query tool**

In `lib/coach/tools.ts`, after the milestone tools added in Task 12:

```ts
export const QUERY_ENDURANCE_ACTIVITIES_TOOL = {
  name: 'query_endurance_activities',
  description:
    "Read endurance_activities rows (Strava-ingested rides/runs/swims) for the athlete in a date range. Returns per-activity: started_at, sport, duration_s, distance_m, avg_hr, max_hr, tss, hr_zone_distribution. Distinct from query_daily_logs which returns day-level totals. Use for 'what did I do this week' / 'how many Z2 minutes' / 'show me my last ride' questions. 90-day range cap.",
  input_schema: {
    type: 'object' as const,
    required: ['start_date', 'end_date'],
    properties: {
      start_date: { type: 'string', description: 'YYYY-MM-DD local date (inclusive)' },
      end_date:   { type: 'string', description: 'YYYY-MM-DD local date (inclusive)' },
      sport:      { type: 'string', enum: ['cycling', 'running', 'swimming', 'other'] },
      min_duration_min: { type: 'integer', minimum: 1 },
    },
  },
} as const;

export async function executeQueryEnduranceActivities(opts: {
  userId: string;
  input: { start_date: string; end_date: string; sport?: string; min_duration_min?: number };
}) {
  const t0 = Date.now();
  const start = new Date(`${opts.input.start_date}T00:00:00Z`);
  const end = new Date(`${opts.input.end_date}T00:00:00Z`);
  const days = Math.ceil((end.getTime() - start.getTime()) / 86400000) + 1;
  if (days > 90) {
    return { ok: false as const, error: { error: 'range > 90 days' }, meta: { ms: Date.now() - t0, range_days: days } };
  }
  const sb = (await import('@/lib/supabase/server')).createSupabaseServiceRoleClient();
  let q = sb
    .from('endurance_activities')
    .select('id, started_at, local_date, sport, duration_s, distance_m, avg_hr, max_hr, tss, hr_zone_distribution, avg_speed_kmh, calories')
    .eq('user_id', opts.userId)
    .is('deleted_at', null)
    .gte('local_date', opts.input.start_date)
    .lte('local_date', opts.input.end_date)
    .order('started_at', { ascending: false })
    .limit(100);
  if (opts.input.sport) q = q.eq('sport', opts.input.sport);
  if (opts.input.min_duration_min) q = q.gte('duration_s', opts.input.min_duration_min * 60);
  const { data, error } = await q;
  if (error) return { ok: false as const, error: { error: error.message }, meta: { ms: Date.now() - t0, range_days: days } };
  return { ok: true as const, data: data ?? [], meta: { ms: Date.now() - t0, range_days: days } };
}
```

- [ ] **Step 2: Add propose/commit endurance week tools**

```ts
import { composeZ2Base } from '@/lib/coach/endurance/compose-z2-base';
import type { EnduranceSessionPlan } from '@/lib/coach/endurance/types';

export const PROPOSE_ENDURANCE_WEEK_TOOL = {
  name: 'propose_endurance_week',
  description:
    "Generate a preview of a weekly endurance prescription. Does NOT write. Returns preview + approval_token. Carter calls composeZ2Base internally (Phase 1 supports aerobic_base / cycling only). User must approve via commit_endurance_week.",
  input_schema: {
    type: 'object' as const,
    required: ['week_start'],
    properties: {
      week_start: { type: 'string', description: 'YYYY-MM-DD of the Sunday starting the prescribed week' },
      preferred_day: { type: 'integer', minimum: 0, maximum: 6, description: '0=Sun..6=Sat, day to anchor first session on; default Wed (3)' },
    },
  },
} as const;

export const COMMIT_ENDURANCE_WEEK_TOOL = {
  name: 'commit_endurance_week',
  description:
    "Commit a previously proposed endurance week. Requires approval_token from propose_endurance_week. Idempotent on (user_id, week_start) — re-committing UPDATEs training_weeks.endurance_session_plan.",
  input_schema: {
    type: 'object' as const,
    required: ['approval_token'],
    properties: { approval_token: { type: 'string', minLength: 60 } },
  },
} as const;

type ProposeEnduranceInput = { week_start: string; preferred_day?: 0|1|2|3|4|5|6 };
type EnduranceWeekPayload = { week_start: string; plan: EnduranceSessionPlan; rationale: string };

export async function executeProposeEnduranceWeek(opts: {
  userId: string;
  input: ProposeEnduranceInput;
}) {
  const t0 = Date.now();
  const sb = (await import('@/lib/supabase/server')).createSupabaseServiceRoleClient();
  const { data: profileRow, error } = await sb
    .from('athlete_profile_documents')
    .select('endurance_profile')
    .eq('user_id', opts.userId)
    .eq('status', 'acknowledged')
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !profileRow?.endurance_profile) {
    return { ok: false as const, error: { error: 'No endurance_profile — set up on /profile first.' }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  const result = composeZ2Base({ profile: profileRow.endurance_profile, preferredDay: opts.input.preferred_day });
  if (!result.ok) {
    return { ok: false as const, error: { error: result.reason }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  const payload: EnduranceWeekPayload = {
    week_start: opts.input.week_start,
    plan: result.plan,
    rationale: result.rationale,
  };
  const { signApprovalToken } = await import('@/lib/coach/approval-token');
  const token = signApprovalToken({ userId: opts.userId, action: 'endurance_week', payload });
  return {
    ok: true as const,
    data: { preview: payload, approval_token: token },
    meta: { ms: Date.now() - t0, range_days: 0 },
  };
}

export async function executeCommitEnduranceWeek(opts: {
  userId: string;
  input: { approval_token: string };
}) {
  const t0 = Date.now();
  const { verifyApprovalToken, ApprovalTokenError, approvalTokenUserMessage } = await import('@/lib/coach/approval-token');
  let env;
  try {
    env = verifyApprovalToken({ token: opts.input.approval_token, userId: opts.userId, action: 'endurance_week' });
  } catch (e) {
    if (e instanceof ApprovalTokenError) {
      return { ok: false as const, error: { error: approvalTokenUserMessage(e) }, meta: { ms: Date.now() - t0, range_days: 0 } };
    }
    throw e;
  }
  const payload = env.payload as EnduranceWeekPayload;
  const sb = (await import('@/lib/supabase/server')).createSupabaseServiceRoleClient();

  // Upsert: training_weeks may or may not have a row for this week yet.
  // Try update first, then insert if no row exists. (Cleaner than upsert which
  // would require us to know other columns.)
  const { data: existing } = await sb
    .from('training_weeks')
    .select('id')
    .eq('user_id', opts.userId)
    .eq('week_start', payload.week_start)
    .maybeSingle();
  if (existing) {
    const { error } = await sb
      .from('training_weeks')
      .update({ endurance_session_plan: payload.plan })
      .eq('id', existing.id);
    if (error) return { ok: false as const, error: { error: error.message }, meta: { ms: Date.now() - t0, range_days: 0 } };
  } else {
    const { error } = await sb
      .from('training_weeks')
      .insert({ user_id: opts.userId, week_start: payload.week_start, endurance_session_plan: payload.plan });
    if (error) return { ok: false as const, error: { error: error.message }, meta: { ms: Date.now() - t0, range_days: 0 } };
  }
  return { ok: true as const, data: { week_start: payload.week_start, plan: payload.plan }, meta: { ms: Date.now() - t0, range_days: 0 } };
}
```

- [ ] **Step 3: Wire all 7 tools into CARTER_TOOLS and the executor dispatcher**

Find `export const CARTER_TOOLS: readonly ToolSchema[] = [...]` and append the 7 new schemas:

```ts
  // … existing CARTER_TOOLS entries …
  QUERY_ENDURANCE_ACTIVITIES_TOOL,
  PROPOSE_ENDURANCE_WEEK_TOOL,
  COMMIT_ENDURANCE_WEEK_TOOL,
  SET_ENDURANCE_PHASE_TOOL,
  SET_ENDURANCE_DISCIPLINE_TOOL,
  SET_THRESHOLD_HR_TOOL,
  SET_FTP_TOOL,
```

Find the executor dispatch switch (look for `case "propose_week_plan":` etc., usually in the same file) and add:

```ts
    case 'query_endurance_activities':
      return executeQueryEnduranceActivities({ userId, input });
    case 'propose_endurance_week':
      return executeProposeEnduranceWeek({ userId, input });
    case 'commit_endurance_week':
      return executeCommitEnduranceWeek({ userId, input });
    case 'set_endurance_phase':
      return executeSetEndurancePhase({ userId, input });
    case 'set_endurance_discipline':
      return executeSetEnduranceDiscipline({ userId, input });
    case 'set_threshold_hr':
      return executeSetThresholdHr({ userId, input });
    case 'set_ftp':
      return executeSetFtp({ userId, input });
```

- [ ] **Step 4: Update lib/coach/chat-stream.ts**

In the `PERSIST_RESULT_TOOLS` Set, add:

```ts
  'propose_endurance_week',
  'commit_endurance_week',
```

In `modeAllowsTool`, locate the section that allows propose/commit-style tools in `default | plan_week | setup_block` modes (mirrors `propose_week_plan` gating) and add `propose_endurance_week` / `commit_endurance_week` / `query_endurance_activities` to the same allowlist. The `set_*` milestone tools follow the GLP-1 milestone pattern — allow in `default` + `intake` modes. Read the existing `modeAllowsTool` switch carefully and add the new tool names alongside their structural twins.

- [ ] **Step 5: Verify typecheck**

```bash
npm run typecheck
```

Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add lib/coach/tools.ts lib/coach/chat-stream.ts
git commit -m "feat(coach): query/propose/commit endurance tools + Carter wiring

query_endurance_activities (90d cap, sport filter, min duration filter).
propose_endurance_week wraps composeZ2Base and signs an HMAC approval token
under the new 'endurance_week' action. commit_endurance_week verifies the
token then upserts training_weeks.endurance_session_plan idempotent on
(user_id, week_start). All 7 endurance tools partitioned into CARTER_TOOLS
and added to the executor dispatch. PERSIST_RESULT_TOOLS includes propose/
commit so the chat UI confirmation chip survives history reload.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: Snapshot prefix injection

**Files:**
- Modify: `lib/coach/snapshot.ts` — add 3 new blocks

- [ ] **Step 1: Read existing snapshot.ts to understand the assembly pattern**

```bash
grep -n "BASELINES\|ENDURANCE\|peterDashboardBlock\|HISTORICAL\|push" lib/coach/snapshot.ts | head -30
```

Locate where existing blocks are assembled (likely a sequence of `parts.push(...)` calls).

- [ ] **Step 2: Add endurance-block computation**

Insert this helper near the top of `lib/coach/snapshot.ts` (or in the appropriate adjacent file matching project convention):

```ts
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { defaultZ2Cap } from '@/lib/coach/endurance/hr-zones';
import type { EnduranceProfile } from '@/lib/coach/endurance/types';
import type { EnduranceActivity } from '@/lib/data/types';

async function renderEnduranceBlocks(userId: string): Promise<string> {
  const sb = createSupabaseServiceRoleClient();

  // Latest acknowledged athlete profile for endurance_profile
  const { data: profileRow } = await sb
    .from('athlete_profile_documents')
    .select('endurance_profile')
    .eq('user_id', userId)
    .eq('status', 'acknowledged')
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  const profile = (profileRow?.endurance_profile as EnduranceProfile | null) ?? null;

  // Last 28 days of endurance_load + activities
  const today = new Date();
  const d28 = new Date(today.getTime() - 28 * 86400000);
  const d7 = new Date(today.getTime() - 7 * 86400000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const { data: dailyRows } = await sb
    .from('daily_logs')
    .select('date, endurance_load, endurance_minutes, endurance_z2_minutes')
    .eq('user_id', userId)
    .gte('date', fmt(d28))
    .lte('date', fmt(today))
    .order('date', { ascending: false });
  const { data: lastActs } = await sb
    .from('endurance_activities')
    .select('local_date, sport, duration_s, avg_hr, tss, hr_zone_distribution')
    .eq('user_id', userId)
    .is('deleted_at', null)
    .order('started_at', { ascending: false })
    .limit(3);

  let out = '';

  if (profile) {
    out += `ENDURANCE_PROFILE:\n`;
    out += `  Discipline: ${profile.discipline}\n`;
    out += `  Phase: ${profile.phase} (set ${profile.set_at.slice(0, 10)})\n`;
    out += `  Weekly volume target: ${profile.weekly_volume_target_hours}h\n`;
    if (profile.threshold_hr) {
      out += `  Threshold HR: ${profile.threshold_hr} bpm\n`;
      out += `  HR cap (Z2): ${defaultZ2Cap(profile.threshold_hr)} bpm\n`;
    } else {
      out += `  Threshold HR: uncalibrated (TSS computation disabled)\n`;
    }
  } else {
    out += `ENDURANCE_PROFILE: not configured (user has not completed /profile endurance setup)\n`;
  }

  const tss7 = (dailyRows ?? []).filter(r => r.date >= fmt(d7)).reduce((s, r) => s + (Number(r.endurance_load) || 0), 0);
  const min7 = (dailyRows ?? []).filter(r => r.date >= fmt(d7)).reduce((s, r) => s + (Number(r.endurance_minutes) || 0), 0);
  const z2_7 = (dailyRows ?? []).filter(r => r.date >= fmt(d7)).reduce((s, r) => s + (Number(r.endurance_z2_minutes) || 0), 0);
  const tss28 = (dailyRows ?? []).reduce((s, r) => s + (Number(r.endurance_load) || 0), 0);
  const avg7 = tss28 / 4; // 28-day mean weekly TSS
  const ratio = avg7 > 0 ? tss7 / avg7 : 0;
  out += `\nENDURANCE_LOAD_7D:\n`;
  out += `  TSS sum (7d): ${Math.round(tss7)}\n`;
  out += `  Endurance hours (7d): ${(min7 / 60).toFixed(1)}\n`;
  out += `  vs 28d rolling avg: ${ratio.toFixed(2)}× ${ratio > 1.4 ? '(spike)' : ratio < 0.6 && avg7 > 0 ? '(below)' : '(within normal)'}\n`;
  out += `  Z2 minutes (7d): ${z2_7}\n`;

  out += `\nLAST_3_ENDURANCE_ACTIVITIES:\n`;
  if (!lastActs || lastActs.length === 0) {
    out += `  (none yet)\n`;
  } else {
    for (const a of lastActs as Array<EnduranceActivity>) {
      const min = Math.round(a.duration_s / 60);
      const zd = a.hr_zone_distribution;
      const zsum = zd ? `Z2:${Math.round(zd.z2_s/60)} Z3:${Math.round(zd.z3_s/60)}` : '';
      out += `  ${a.local_date} | ${a.sport} | ${min}min | avg HR ${a.avg_hr ?? '—'} | TSS ${a.tss ?? '—'} | ${zsum}\n`;
    }
  }
  return out;
}
```

- [ ] **Step 3: Inject the rendered block into the snapshot assembly**

Find the existing block-assembly sequence in `snapshot.ts` (after `BASELINES_HISTORICAL` block, before `peterDashboardBlock`). Add:

```ts
const enduranceBlock = await renderEnduranceBlocks(userId);
// … append to the assembly the same way other blocks are appended …
parts.push(enduranceBlock); // (use the exact accumulator name from the surrounding code)
```

- [ ] **Step 4: Verify typecheck + manual smoke**

```bash
npm run typecheck
```

Then start dev server and hit the chat — verify Carter's system prompt snapshot (visible in dev logs or via a debug echo) now includes the three new blocks.

- [ ] **Step 5: Commit**

```bash
git add lib/coach/snapshot.ts
git commit -m "feat(coach): inject ENDURANCE_* blocks into snapshot prefix

Three blocks always present (no flag): ENDURANCE_PROFILE / ENDURANCE_LOAD_7D
/ LAST_3_ENDURANCE_ACTIVITIES. When endurance_profile is NULL, profile
block renders 'not configured' — coaches see it explicitly. 7d/28d ratio
includes a 'spike' marker so Peter/Carter/Remi can cite it without their
own math.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 15: Coach prompt updates (Carter / Nora / Remi / Peter)

**Files:**
- Modify: `lib/coach/system-prompts.ts` — update 4 prompts

- [ ] **Step 1: Read existing prompts to find the right insertion points**

```bash
grep -n "^export const \(CARTER_BASE\|NORA_BASE\|REMI_BASE\|PETER_BASE\)" lib/coach/system-prompts.ts
```

Note the line numbers — you'll add an "Endurance" section to each prompt.

- [ ] **Step 2: Update CARTER_BASE — S&C mandate + endurance phase awareness**

Find the existing CARTER_BASE template literal. Update the title/mandate line from "Strength Coach" to "Strength & Conditioning Coach" and append (before the closing template-literal backtick) a new section:

```
## Endurance ownership

You own endurance prescriptions in addition to strength. The athlete's current
phase + discipline + threshold HR + last 3 activities + 7d/28d TSS ratio are
in the snapshot prefix above (ENDURANCE_PROFILE, ENDURANCE_LOAD_7D,
LAST_3_ENDURANCE_ACTIVITIES blocks).

Phase-specific guidance:
- `aerobic_base` (current): Z2 only. HR cap is NON-NEGOTIABLE — do not prescribe
  intervals, threshold work, or "just push when you feel good." This phase
  exists to build fat-oxidation capacity + mitochondrial density without
  compromising recovery. At 1×60min/wk (Phase 1 sizing), the prescription is a
  single Z2 ride mid-week. If the athlete asks for "more intensity," explain
  the phase intent before agreeing.
- `build` / `race_prep` / `taper` / `off_season`: composer not implemented yet
  (Phase 2). If the athlete is in one of these phases, surface the gap and
  prescribe verbally rather than via propose_endurance_week.

Tools you have for endurance:
- `query_endurance_activities` — read recent rides/runs/swims (90d cap).
- `propose_endurance_week` → `commit_endurance_week` — HMAC-gated weekly plan.
- `set_endurance_phase` / `set_endurance_discipline` — milestone mutations.
- `set_threshold_hr` / `set_ftp` — calibration writes.

Strength↔endurance interference: at the current 1h/wk Z2 volume, interference is
negligible and strength volume runs unchanged. When you start a build phase,
you'll begin reducing strength volume per the interference rule (see
lib/coach/interference/check-interference.ts).
```

- [ ] **Step 3: Update NORA_BASE — endurance-day fueling**

Append to NORA_BASE:

```
## Endurance-day fueling

When today's snapshot shows a prescribed endurance session (look for `type:
z2_ride` etc. in TRAINING_WEEK.endurance_session_plan, when present):

- **Z2 days**: small CHO 30-60min pre (20-30g, e.g., banana or toast).
  Protein-led post (no big carb dump). Rationale: fat oxidation is the training
  intent; large pre-ride CHO blunts the adaptation.
- **All other days**: no endurance-driven fueling change. Treat as a normal
  strength/rest day.

You read `daily_logs.endurance_load` (the day's TSS sum) in your snapshot — if
it's > 60 and protein is short, surface the gap.
```

- [ ] **Step 4: Update REMI_BASE — endurance load in recovery context**

Append to REMI_BASE:

```
## Endurance load in recovery context

ENDURANCE_LOAD_7D in the snapshot prefix shows weekly TSS and the 7d/28d
ratio. Treat a ratio > 1.4 as a volume spike worth surfacing alongside HRV.
At the current 1h/wk Phase 1 volume, this trigger essentially never fires —
the data shape is in place for when triathlon ramp begins.
```

- [ ] **Step 5: Update PETER_BASE — Endurance theme awareness**

Append to PETER_BASE:

```
## Endurance theme

The peter-dashboard payload now carries an Endurance theme (in addition to
the existing six). Phase 1 is binary: 'ok' if the prescribed Z2 happened
within HR cap this week, 'attention' otherwise. Cite it the same way you
cite the other themes — with the specific fact rather than the severity word.
Cluster examples: high endurance volume + suppressed HRV → flag with Remi's
Recovery theme; missing prescribed Z2 + plateau on weight → flag with Recomp.
```

- [ ] **Step 6: Verify typecheck**

```bash
npm run typecheck
```

Expected: zero errors.

- [ ] **Step 7: Commit**

```bash
git add lib/coach/system-prompts.ts
git commit -m "feat(coach): teach all four coaches the endurance pillar

CARTER_BASE: title → Strength & Conditioning Coach, Phase 1 aerobic_base rules
(Z2 only, HR cap non-negotiable, intervals rejected) + tool inventory + Phase 2
deferral language for build/race_prep/taper. NORA_BASE: Z2-day fueling rule
(small CHO pre, protein-led post). REMI_BASE: 7d/28d ratio interpretation.
PETER_BASE: Endurance theme on dashboard with cluster examples.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 16: Adherence pass extension

**Files:**
- Modify: `lib/coach/adherence.ts` — add endurance adherence pass + `endurance_status` field

- [ ] **Step 1: Read adherence.ts to find the per-day output shape**

```bash
grep -n "status\|as_planned\|missed\|export\|function" lib/coach/adherence.ts | head -30
```

Locate the per-day output type that the existing strength adherence pass populates.

- [ ] **Step 2: Extend the per-day output type**

Add `endurance_status` field beside the existing `status` field:

```ts
export type EnduranceStatus =
  | 'as_planned'
  | 'over_intensity'
  | 'under_volume'
  | 'missed'
  | 'not_prescribed';

// In the existing per-day type, alongside `status`:
//   endurance_status?: EnduranceStatus;
```

- [ ] **Step 3: Add endurance adherence pass**

Add a helper function callable from the existing adherence orchestrator:

```ts
import type { EnduranceSessionPlan } from '@/lib/coach/endurance/types';
import type { EnduranceActivity } from '@/lib/data/types';

export function computeEnduranceStatus(args: {
  prescribed: EnduranceSessionPlan | null;
  weekday: 0|1|2|3|4|5|6;
  activitiesOnDay: ReadonlyArray<Pick<EnduranceActivity, 'duration_s' | 'avg_hr' | 'sport'>>;
  hrCap: number | null;
}): EnduranceStatus {
  const entry = prescribed_get(args.prescribed, args.weekday);
  if (!entry || entry.type === 'rest') return 'not_prescribed';

  // Match: any activity on this day with matching sport, within ±15min of prescribed duration
  const targetSeconds = entry.duration_min * 60;
  const tolerance = 15 * 60;
  const match = args.activitiesOnDay.find(
    (a) => a.sport === entry.sport && Math.abs(a.duration_s - targetSeconds) <= tolerance,
  );
  if (!match) {
    // Any activity at all on this day, even a different sport / duration?
    const anyActivity = args.activitiesOnDay.find((a) => a.duration_s >= 600);
    if (anyActivity) return 'under_volume'; // some endurance work, but not the prescribed shape
    return 'missed';
  }
  // HR cap check (only meaningful when both numbers exist)
  if (args.hrCap && match.avg_hr && match.avg_hr > args.hrCap) {
    return 'over_intensity';
  }
  return 'as_planned';
}

function prescribed_get(plan: EnduranceSessionPlan | null, weekday: 0|1|2|3|4|5|6) {
  if (!plan) return null;
  return plan[weekday] ?? null;
}
```

Then in the existing adherence orchestrator (where the strength `status` per day is built), call `computeEnduranceStatus` with the matching inputs and assign to `endurance_status` on the per-day output.

- [ ] **Step 4: Verify typecheck**

```bash
npm run typecheck
```

Expected: zero errors. (If existing adherence consumers read every field of the per-day type, none should break — `endurance_status` is added as an optional discriminator.)

- [ ] **Step 5: Commit**

```bash
git add lib/coach/adherence.ts
git commit -m "feat(coach): endurance adherence pass + endurance_status field

Per prescribed endurance day: matches activities by sport + ±15min duration
tolerance. HR-cap violation surfaces as over_intensity. Any other endurance
work surfaces as under_volume (counts as partial credit, not missed).
Output keys: as_planned | over_intensity | under_volume | missed | not_prescribed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 17: Peter dashboard Endurance theme

**Files:**
- Create: `lib/coach/peter-dashboard/compose-endurance.ts`
- Modify: `lib/coach/peter-dashboard/types.ts` — `EnduranceTheme` shape
- Modify: `lib/coach/peter-dashboard/index.ts` — orchestrator parallel run
- Modify: `lib/coach/peter-dashboard/link-themes.ts` — pairwise rules
- Modify: `components/coach/PeterDashboardClient.tsx` — render card

- [ ] **Step 1: Add EnduranceTheme to types.ts**

In `lib/coach/peter-dashboard/types.ts`, add:

```ts
export type EnduranceTheme = {
  kind: 'endurance';
  severity: 'ok' | 'attention' | 'concern';
  headline: string;
  facts: string[];                                  // 2-3 punchy facts
  deepLink: { kind: 'strava_activity'; url: string } | null;
  prescribed_this_week: boolean;
  did_it_happen: boolean;
  last_activity?: {
    local_date: string;
    duration_min: number;
    avg_hr: number | null;
    tss: number | null;
  };
};
```

Add `EnduranceTheme` to the union of theme variants used by `DashboardPayload.themes`.

- [ ] **Step 2: Write lib/coach/peter-dashboard/compose-endurance.ts**

```ts
// lib/coach/peter-dashboard/compose-endurance.ts — Phase 1 binary theme.
//
// 'ok'        : prescribed Z2 happened this week within HR cap
// 'attention' : prescribed Z2 didn't happen OR went over HR cap
// 'concern'   : reserved for Phase 2 (volume spike, etc.)

import type { EnduranceTheme } from './types';
import type { EnduranceActivity } from '@/lib/data/types';
import type { EnduranceProfile, EnduranceSessionPlan } from '@/lib/coach/endurance/types';
import { defaultZ2Cap } from '@/lib/coach/endurance/hr-zones';

export function composeEnduranceTheme(args: {
  profile: EnduranceProfile | null;
  weekPlan: EnduranceSessionPlan | null;
  weekActivities: ReadonlyArray<EnduranceActivity>;
}): EnduranceTheme {
  const { profile, weekPlan, weekActivities } = args;

  // No profile = surface as setup CTA.
  if (!profile) {
    return {
      kind: 'endurance',
      severity: 'attention',
      headline: 'Endurance setup not complete',
      facts: ['Connect Strava and set your threshold HR on /profile to enable endurance tracking.'],
      deepLink: null,
      prescribed_this_week: false,
      did_it_happen: false,
    };
  }

  const prescribed = !!weekPlan && Object.keys(weekPlan).some((d) => {
    const e = weekPlan[Number(d) as 0|1|2|3|4|5|6];
    return e && e.type !== 'rest';
  });
  const hrCap = profile.threshold_hr ? defaultZ2Cap(profile.threshold_hr) : null;

  // For Phase 1 (1 prescribed session/wk), "did_it_happen" = any matching activity exists.
  const completedActivity = weekActivities.find((a) => {
    if (a.sport !== 'cycling') return false;
    return true; // any cycling activity this week counts
  });
  const overCap = hrCap && completedActivity?.avg_hr && completedActivity.avg_hr > hrCap;
  const didIt = !!completedActivity;
  const lastAct = weekActivities[0];

  let severity: 'ok' | 'attention' = 'ok';
  let headline = 'Endurance on track';
  if (prescribed && !didIt) {
    severity = 'attention';
    headline = 'Prescribed Z2 not yet completed this week';
  } else if (overCap) {
    severity = 'attention';
    headline = `Z2 ride went over HR cap (${completedActivity!.avg_hr} vs cap ${hrCap})`;
  } else if (didIt) {
    const dur = Math.round(completedActivity!.duration_s / 60);
    headline = `Z2 ride completed: ${dur}min @ avg HR ${completedActivity!.avg_hr ?? '—'}`;
  } else if (!prescribed) {
    headline = 'No endurance prescription this week';
  }

  const facts: string[] = [];
  if (didIt && completedActivity!.tss != null) {
    facts.push(`TSS: ${completedActivity!.tss}`);
  }
  if (hrCap) facts.push(`HR cap: ${hrCap} bpm`);
  facts.push(`Phase: ${profile.phase}`);

  return {
    kind: 'endurance',
    severity,
    headline,
    facts,
    deepLink: completedActivity?.external_id
      ? { kind: 'strava_activity', url: `https://www.strava.com/activities/${completedActivity.external_id}` }
      : null,
    prescribed_this_week: prescribed,
    did_it_happen: didIt,
    last_activity: lastAct
      ? {
          local_date: lastAct.local_date,
          duration_min: Math.round(lastAct.duration_s / 60),
          avg_hr: lastAct.avg_hr,
          tss: lastAct.tss,
        }
      : undefined,
  };
}
```

- [ ] **Step 3: Wire into orchestrator**

In `lib/coach/peter-dashboard/index.ts`, find the `Promise.all([...])` that runs the existing 6 composers. Add a 7th call that fetches the inputs and calls `composeEnduranceTheme`. Insert the resulting theme into the payload `themes` array (or however the existing structure shapes it — match the existing pattern exactly).

```ts
import { composeEnduranceTheme } from './compose-endurance';

// In the orchestrator, alongside other composer calls:
async function composeEnduranceInputs(userId: string, weekStart: string) {
  const sb = createSupabaseServiceRoleClient();
  const [profileR, weekR, actsR] = await Promise.all([
    sb.from('athlete_profile_documents')
      .select('endurance_profile').eq('user_id', userId).eq('status', 'acknowledged')
      .order('version', { ascending: false }).limit(1).maybeSingle(),
    sb.from('training_weeks')
      .select('endurance_session_plan').eq('user_id', userId).eq('week_start', weekStart).maybeSingle(),
    sb.from('endurance_activities')
      .select('*').eq('user_id', userId).is('deleted_at', null)
      .gte('local_date', weekStart).order('started_at', { ascending: false }),
  ]);
  return composeEnduranceTheme({
    profile: profileR.data?.endurance_profile ?? null,
    weekPlan: weekR.data?.endurance_session_plan ?? null,
    weekActivities: actsR.data ?? [],
  });
}
```

Add the returned theme to the orchestrator's themes array. Order: after Plan adherence, before Goal distance.

- [ ] **Step 4: Update link-themes.ts pairwise rules**

```ts
// In lib/coach/peter-dashboard/link-themes.ts, add:
//
// Endurance + Recovery: high volume + low HRV → "under-recovery from cumulative aerobic load"
// Endurance + Recomp: prescribed Z2 missed + weight plateau → "missing cardio for deficit"
// Endurance + Performance: lift performance drop + high endurance week → interference cluster

// Mirror the existing link-detection pattern: walk pairs, emit ThemeLink when both conditions match.
```

Add three concrete `if (enduranceTheme.severity !== 'ok' && other.severity !== 'ok')` link rules following the existing pattern in the same file. Each link emits a short label like `"endurance↔recovery: high volume + low HRV"`.

- [ ] **Step 5: Render in PeterDashboardClient.tsx**

In `components/coach/PeterDashboardClient.tsx`, find the existing theme card rendering. Add a case for `kind: 'endurance'`. Mirror the visual treatment of other theme cards (severity chip + headline + facts list). When `deepLink` is non-null, render an external link to the Strava activity (`target="_blank" rel="noreferrer"`).

- [ ] **Step 6: Verify typecheck + manual smoke**

```bash
npm run typecheck
npm run dev
# Navigate to /coach?tab=dashboard, verify Endurance card renders.
# If profile not yet set up, card should show "Endurance setup not complete" with setup CTA.
```

- [ ] **Step 7: Commit**

```bash
git add lib/coach/peter-dashboard/compose-endurance.ts lib/coach/peter-dashboard/types.ts lib/coach/peter-dashboard/index.ts lib/coach/peter-dashboard/link-themes.ts components/coach/PeterDashboardClient.tsx
git commit -m "feat(peter-dashboard): Endurance theme

Phase 1 binary severity ('ok' / 'attention' only). Theme card on existing
Peter dashboard with last-activity summary, HR-cap fact, phase label, and
external deep-link to the Strava activity. Link-themes adds 3 pairwise
rules (endurance↔recovery, endurance↔recomp, endurance↔performance) so
Peter narrates cross-theme clusters without re-discovering them.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 18: Proactive nudge (dormant) + cron registration

**Files:**
- Create: `lib/coach/proactive/check-endurance-volume-spike.ts`
- Modify: `app/api/coach/proactive/check/route.ts` — register new check

- [ ] **Step 1: Write check-endurance-volume-spike.ts**

```ts
// lib/coach/proactive/check-endurance-volume-spike.ts
// Fires when 7d endurance load > 1.4× 28d rolling avg AND HRV is below
// rolling-30d baseline by > 0.5×SD. Dormant at Phase 1 volume (1h/wk).
//
// Returns a ProactiveCheckResult per the existing proactive pattern.

import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';

export type ProactiveCheckResult = {
  trigger_key: string;
  should_fire: boolean;
  ui?: unknown;
};

const TRIGGER_KEY = 'endurance_volume_recovery_mismatch';

export async function checkEnduranceVolumeSpike(userId: string): Promise<ProactiveCheckResult> {
  const sb = createSupabaseServiceRoleClient();

  // Read daily_logs.endurance_load for last 28 days
  const today = new Date();
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const d28 = new Date(today.getTime() - 28 * 86400000);
  const d7 = new Date(today.getTime() - 7 * 86400000);

  const { data: rows } = await sb
    .from('daily_logs')
    .select('date, endurance_load, hrv')
    .eq('user_id', userId)
    .gte('date', fmt(d28))
    .lte('date', fmt(today));
  const all = rows ?? [];
  const tss7 = all.filter((r) => r.date >= fmt(d7)).reduce((s, r) => s + (Number(r.endurance_load) || 0), 0);
  const tssAll = all.reduce((s, r) => s + (Number(r.endurance_load) || 0), 0);
  const avg7 = tssAll / 4;
  if (avg7 === 0 || tss7 / avg7 < 1.4) {
    return { trigger_key: TRIGGER_KEY, should_fire: false };
  }

  // Read whoop rolling_30d HRV baseline
  const { data: profile } = await sb.from('profiles').select('whoop_baselines').eq('user_id', userId).maybeSingle();
  const rolling = (profile?.whoop_baselines as { rolling_30d?: { hrv?: { mean: number; sd: number } } } | null)?.rolling_30d?.hrv;
  if (!rolling || rolling.sd <= 0) {
    return { trigger_key: TRIGGER_KEY, should_fire: false };
  }
  const todayRow = all.find((r) => r.date === fmt(today));
  if (!todayRow?.hrv) {
    return { trigger_key: TRIGGER_KEY, should_fire: false };
  }
  const z = (Number(todayRow.hrv) - rolling.mean) / rolling.sd;
  if (z >= -0.5) {
    return { trigger_key: TRIGGER_KEY, should_fire: false };
  }

  return {
    trigger_key: TRIGGER_KEY,
    should_fire: true,
    ui: {
      kind: 'endurance_volume_recovery_mismatch',
      tss_7d: Math.round(tss7),
      avg_7d_ratio: Math.round((tss7 / avg7) * 100) / 100,
      hrv_z: Math.round(z * 100) / 100,
      message:
        `Endurance load this week is ${Math.round((tss7 / avg7) * 100)}% of your 4-week average ` +
        `while HRV is ${Math.abs(z).toFixed(1)} SD below baseline. Consider an easy day or two.`,
    },
  };
}
```

- [ ] **Step 2: Register in app/api/coach/proactive/check/route.ts**

Find the existing trigger-evaluation loop (it walks the array of check functions). Add an import and a call:

```ts
import { checkEnduranceVolumeSpike } from '@/lib/coach/proactive/check-endurance-volume-spike';

// In the checks array (matching the existing shape):
//   { name: 'endurance_volume', run: checkEnduranceVolumeSpike },
```

Mirror the existing dedup-and-write pattern used by other checks (the 7-day `proactive_nudge_dedup` table from migration 0017).

- [ ] **Step 3: Verify typecheck**

```bash
npm run typecheck
```

Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add lib/coach/proactive/check-endurance-volume-spike.ts app/api/coach/proactive/check/route.ts
git commit -m "feat(proactive): endurance-volume-spike trigger (dormant in Phase 1)

Fires when 7d TSS > 1.4× 28d avg AND HRV z-score < -0.5 SD. At 1h/wk Phase 1
volume the ratio threshold won't trip; trigger wakes up automatically when
endurance volume scales. Dedup via existing proactive_nudge_dedup table
(7-day window).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 19: /profile endurance setup section

**Files:**
- Create: `components/profile/EnduranceSetupSection.tsx`
- Create: `app/api/profile/endurance-profile/route.ts`
- Modify: `components/profile/ProfileClient.tsx` (or `app/profile/page.tsx` — find the existing host)

- [ ] **Step 1: Write app/api/profile/endurance-profile/route.ts**

```ts
// POST /api/profile/endurance-profile — partial update of endurance_profile on the
// latest acknowledged athlete profile. Same semantics as /api/profile/nutrition-overrides:
// undefined keeps, null clears, value sets.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createSupabaseServerClient, createSupabaseServiceRoleClient } from '@/lib/supabase/server';

const PatchSchema = z.object({
  discipline: z.enum(['cycling', 'running', 'triathlon']).optional(),
  phase: z.enum(['aerobic_base', 'build', 'race_prep', 'taper', 'off_season']).optional(),
  threshold_hr: z.number().int().min(80).max(220).nullable().optional(),
  hr_max: z.number().int().min(120).max(230).nullable().optional(),
  ftp_watts: z.number().int().min(50).max(600).nullable().optional(),
  weekly_volume_target_hours: z.number().min(0.5).max(20).optional(),
}).strict();

export async function POST(req: Request) {
  const sb = await createSupabaseServerClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const json = await req.json();
  const parsed = PatchSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_body', details: parsed.error.format() }, { status: 400 });
  }

  const svc = createSupabaseServiceRoleClient();
  const { data: row, error } = await svc
    .from('athlete_profile_documents')
    .select('id, endurance_profile')
    .eq('user_id', user.id)
    .eq('status', 'acknowledged')
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!row) return NextResponse.json({ error: 'no_athlete_profile' }, { status: 400 });

  const existing = (row.endurance_profile ?? {
    discipline: 'cycling',
    phase: 'aerobic_base',
    threshold_hr: null,
    hr_max: null,
    hr_zones: null,
    ftp_watts: null,
    threshold_pace_s_per_km: null,
    weekly_volume_target_hours: 1,
    current_race: null,
    set_at: new Date().toISOString(),
  });
  const merged = { ...existing, ...parsed.data, set_at: new Date().toISOString() };

  const { error: upErr } = await svc.from('athlete_profile_documents').update({ endurance_profile: merged }).eq('id', row.id);
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });
  return NextResponse.json({ ok: true, endurance_profile: merged });
}
```

- [ ] **Step 2: Write components/profile/EnduranceSetupSection.tsx**

```tsx
'use client';

import { useState, useTransition } from 'react';
import type { EnduranceProfile } from '@/lib/coach/endurance/types';

type Props = {
  initial: EnduranceProfile | null;
  stravaConnected: boolean;
};

export function EnduranceSetupSection({ initial, stravaConnected }: Props) {
  const [thresholdHr, setThresholdHr] = useState<number | ''>(initial?.threshold_hr ?? '');
  const [volume, setVolume] = useState<number>(initial?.weekly_volume_target_hours ?? 1);
  const [pending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);

  const save = () => {
    setSaved(false);
    startTransition(async () => {
      const body: Record<string, unknown> = { weekly_volume_target_hours: volume };
      body.threshold_hr = thresholdHr === '' ? null : Number(thresholdHr);
      const r = await fetch('/api/profile/endurance-profile', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (r.ok) setSaved(true);
    });
  };

  return (
    <section className="space-y-4 rounded-lg border border-white/10 bg-white/5 p-4">
      <h2 className="text-lg font-medium">Endurance</h2>

      {/* Strava connection */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm">Strava</p>
          <p className="text-xs text-white/60">
            {stravaConnected ? 'Connected — activities sync automatically.' : 'Not connected — manual ingest only.'}
          </p>
        </div>
        {stravaConnected ? (
          <form action="/api/strava/disconnect" method="post">
            <button type="submit" className="text-xs text-red-300 underline">Disconnect</button>
          </form>
        ) : (
          <a href="/api/strava/auth" className="rounded bg-orange-500 px-3 py-1.5 text-xs font-medium text-black">Connect Strava</a>
        )}
      </div>

      {/* Threshold HR */}
      <label className="block text-sm">
        Threshold HR (LTHR, bpm)
        <input
          type="number"
          min={80}
          max={220}
          value={thresholdHr}
          onChange={(e) => setThresholdHr(e.target.value === '' ? '' : Number(e.target.value))}
          className="mt-1 block w-full rounded border border-white/15 bg-black/40 px-2 py-1"
        />
        <span className="block text-xs text-white/50">Required for TSS computation. Calibrate via 30-min time-trial avg HR.</span>
      </label>

      {/* Discipline / phase — locked in Phase 1 */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <p className="text-xs text-white/60">Discipline</p>
          <p className="text-sm">cycling <span className="text-xs text-white/40">(triathlon in Phase 2)</span></p>
        </div>
        <div>
          <p className="text-xs text-white/60">Phase</p>
          <p className="text-sm">aerobic_base <span className="text-xs text-white/40">(build/race-prep in Phase 2)</span></p>
        </div>
      </div>

      {/* Weekly volume target */}
      <label className="block text-sm">
        Weekly volume target: <span className="font-mono">{volume}h</span>
        <input
          type="range"
          min={0.5}
          max={15}
          step={0.5}
          value={volume}
          onChange={(e) => setVolume(Number(e.target.value))}
          className="mt-1 block w-full"
        />
        <span className="block text-xs text-white/50">Phase 1 default 1h (1×60min Z2/wk). Range leaves room for triathlon scale-up.</span>
      </label>

      <button
        onClick={save}
        disabled={pending}
        className="rounded bg-emerald-500 px-3 py-1.5 text-sm font-medium text-black disabled:opacity-50"
      >
        {pending ? 'Saving…' : saved ? 'Saved ✓' : 'Save'}
      </button>
    </section>
  );
}
```

- [ ] **Step 3: Mount in /profile**

Find the existing `ProfileClient.tsx` (or page). Read the existing structure to find where other sections (e.g. `NutritionTargetsSection`) are rendered. Add a server-side fetch for the latest acknowledged athlete profile's `endurance_profile` + a check whether the `strava_tokens` row exists, then pass into `<EnduranceSetupSection initial={...} stravaConnected={...} />`.

In `app/profile/page.tsx` (server), add:

```ts
const enduranceProfile = profileDoc?.endurance_profile ?? null;
const { data: stravaRow } = await sb.from('strava_tokens').select('user_id').eq('user_id', user.id).maybeSingle();
```

Pass these to the client component and render `<EnduranceSetupSection initial={enduranceProfile} stravaConnected={!!stravaRow} />`.

- [ ] **Step 4: Verify typecheck + smoke**

```bash
npm run typecheck
npm run dev
# Open /profile. New Endurance section visible. "Connect Strava" link works.
# After connection: form persists threshold_hr and weekly volume target.
```

- [ ] **Step 5: Commit**

```bash
git add components/profile/EnduranceSetupSection.tsx app/api/profile/endurance-profile/route.ts app/profile/page.tsx components/profile/ProfileClient.tsx
git commit -m "feat(profile): endurance setup section + partial-update API

Strava connect/disconnect, threshold HR input (calibration anchor for TSS),
weekly volume target slider (0.5-15h, default 1h), discipline/phase locked
to cycling/aerobic_base for Phase 1. POST /api/profile/endurance-profile
mirrors the nutrition-overrides partial-update semantics.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 20: Morning brief endurance block

**Files:**
- Create: `components/morning/EnduranceBriefBlock.tsx`
- Modify: `lib/morning/brief/index.ts` + assembler — populate `EnduranceBlock` in `MorningBriefCard.ui`
- Modify: existing morning-brief renderer to dispatch on the new block type

- [ ] **Step 1: Extend the MorningBriefCard.ui type**

Find the `MorningBriefCard` type (or `MorningBriefBlock` discriminated union). Add:

```ts
export type EnduranceBriefBlockData = {
  type: 'endurance';
  session_type: 'z2_ride' | 'z2_run' | 'tempo' | 'intervals' | 'long' | 'brick';
  sport: 'cycling' | 'running' | 'swimming';
  duration_min: number;
  hr_cap?: number;
  hr_target_range?: [number, number];
  description: string;
  intent: string;
};
```

Add it to the union.

- [ ] **Step 2: Populate in the brief assembler**

In `lib/morning/brief/index.ts` (or the assembler that builds `ui.blocks`):

```ts
import type { EnduranceSessionEntry, EnduranceSessionPlan } from '@/lib/coach/endurance/types';

// After fetching this week's training_week row:
const weekday = new Date().getDay() as 0|1|2|3|4|5|6;
const enduranceEntry: EnduranceSessionEntry | undefined =
  trainingWeek?.endurance_session_plan?.[weekday];
if (enduranceEntry && enduranceEntry.type !== 'rest') {
  briefBlocks.push({
    type: 'endurance',
    session_type: enduranceEntry.type,
    sport: enduranceEntry.sport,
    duration_min: enduranceEntry.duration_min,
    ...(enduranceEntry.hr_cap !== undefined ? { hr_cap: enduranceEntry.hr_cap } : {}),
    ...(enduranceEntry.hr_target_range !== undefined ? { hr_target_range: enduranceEntry.hr_target_range } : {}),
    description: enduranceEntry.description,
    intent: 'Fat oxidation + aerobic base',
  });
}
```

- [ ] **Step 3: Write components/morning/EnduranceBriefBlock.tsx**

```tsx
import type { EnduranceBriefBlockData } from '@/lib/morning/brief/types';

export function EnduranceBriefBlock({ data }: { data: EnduranceBriefBlockData }) {
  return (
    <div className="rounded-lg border border-pink-500/30 bg-pink-500/5 p-3">
      <div className="flex items-center gap-2">
        <span aria-hidden>❤️</span>
        <p className="text-sm font-medium">
          {data.duration_min}min {data.sport} — {data.session_type.replace('_', ' ')}
        </p>
      </div>
      <p className="mt-1 text-xs text-white/70">{data.description}</p>
      {data.hr_target_range && (
        <p className="mt-1 text-xs">
          Target HR: <span className="font-mono">{data.hr_target_range[0]}–{data.hr_target_range[1]}</span>
          {data.hr_cap ? <> (cap <span className="font-mono">{data.hr_cap}</span>)</> : null}
        </p>
      )}
      <p className="mt-1 text-xs text-white/50">{data.intent}</p>
    </div>
  );
}
```

- [ ] **Step 4: Dispatch on the new block type in the brief renderer**

Find the existing brief-block renderer (likely `components/morning/MorningBriefCard.tsx` or similar) that switches on `block.type`. Add:

```tsx
case 'endurance':
  return <EnduranceBriefBlock data={block} />;
```

Visual placement: render after the session block, before macros block.

- [ ] **Step 5: Verify typecheck + smoke**

```bash
npm run typecheck
npm run dev
# Complete morning intake on a day when an endurance session is prescribed.
# Brief renders the endurance block with HR target.
```

- [ ] **Step 6: Commit**

```bash
git add components/morning/EnduranceBriefBlock.tsx lib/morning/brief/index.ts lib/morning/brief/types.ts components/morning/MorningBriefCard.tsx
git commit -m "feat(morning): endurance brief block

Renders on prescribed Z2 days only (no block when rest or not prescribed).
HR target + cap + intent (fat oxidation + aerobic base) front-and-center.
Visual treatment: pink heart, mirrors the existing session block layout.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 21: Client cache + ingest audit + cron + final wiring

**Files:**
- Create: `lib/query/fetchers/enduranceActivities.ts`
- Create: `lib/query/hooks/useEnduranceActivities.ts`
- Modify: `lib/query/keys.ts`
- Create: `scripts/audit-endurance-ingest.mjs`
- Modify: `vercel.json` — cron registration

- [ ] **Step 1: Add query keys**

In `lib/query/keys.ts`, add:

```ts
endurance: {
  all: (userId: string) => ['endurance', userId] as const,
  activities: (userId: string, from: string, to: string) =>
    ['endurance', userId, 'activities', from, to] as const,
},
```

- [ ] **Step 2: Write the dual-variant fetcher**

```ts
// lib/query/fetchers/enduranceActivities.ts
import type { SupabaseClient } from '@supabase/supabase-js';
import type { EnduranceActivity } from '@/lib/data/types';

const SELECT = 'id, started_at, local_date, sport, duration_s, distance_m, avg_hr, max_hr, tss, hr_zone_distribution, external_id';

async function run(sb: SupabaseClient, userId: string, from: string, to: string): Promise<EnduranceActivity[]> {
  const { data, error } = await sb
    .from('endurance_activities')
    .select(SELECT)
    .eq('user_id', userId)
    .is('deleted_at', null)
    .gte('local_date', from)
    .lte('local_date', to)
    .order('started_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as EnduranceActivity[];
}

export async function fetchEnduranceActivitiesServer(userId: string, from: string, to: string) {
  const { createSupabaseServerClient } = await import('@/lib/supabase/server');
  const sb = await createSupabaseServerClient();
  return run(sb as unknown as SupabaseClient, userId, from, to);
}

export async function fetchEnduranceActivitiesBrowser(userId: string, from: string, to: string) {
  const { createSupabaseBrowserClient } = await import('@/lib/supabase/client');
  const sb = createSupabaseBrowserClient();
  return run(sb as unknown as SupabaseClient, userId, from, to);
}
```

- [ ] **Step 3: Write the hook**

```ts
// lib/query/hooks/useEnduranceActivities.ts
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query/keys';
import { fetchEnduranceActivitiesBrowser } from '@/lib/query/fetchers/enduranceActivities';

export function useEnduranceActivities(userId: string, from: string, to: string) {
  return useQuery({
    queryKey: queryKeys.endurance.activities(userId, from, to),
    queryFn: () => fetchEnduranceActivitiesBrowser(userId, from, to),
  });
}
```

- [ ] **Step 4: Write scripts/audit-endurance-ingest.mjs**

```js
// scripts/audit-endurance-ingest.mjs
// Verifies daily_logs.endurance_* equals sum_endurance_for_day output
// for every date in the last 30 days that has any endurance_activities row.
// Run via: AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-endurance-ingest.mjs

import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';

const userId = process.env.AUDIT_USER_ID;
if (!userId) { console.error('AUDIT_USER_ID required'); process.exit(1); }

const sb = createSupabaseServiceRoleClient();

const today = new Date();
const d30 = new Date(today.getTime() - 30 * 86400000);
const fmt = (d) => d.toISOString().slice(0, 10);

const { data: acts, error: aErr } = await sb
  .from('endurance_activities')
  .select('local_date')
  .eq('user_id', userId)
  .is('deleted_at', null)
  .gte('local_date', fmt(d30))
  .lte('local_date', fmt(today));
if (aErr) { console.error(aErr); process.exit(1); }

const dates = Array.from(new Set((acts ?? []).map((r) => r.local_date)));
console.log(`Checking ${dates.length} dates with activities…`);

let drift = 0;
for (const date of dates) {
  const { data: rpcRows, error: rErr } = await sb.rpc('sum_endurance_for_day', { p_user_id: userId, p_date: date });
  if (rErr) { console.error(date, rErr); drift += 1; continue; }
  const rpc = Array.isArray(rpcRows) ? rpcRows[0] : rpcRows;
  const { data: dailyRow, error: dErr } = await sb
    .from('daily_logs')
    .select('endurance_load, endurance_minutes, endurance_z2_minutes')
    .eq('user_id', userId)
    .eq('date', date)
    .maybeSingle();
  if (dErr) { console.error(date, dErr); drift += 1; continue; }

  const ok =
    Number(dailyRow?.endurance_load ?? 0) === Number(rpc?.tss_sum ?? 0) &&
    Number(dailyRow?.endurance_minutes ?? 0) === Number(rpc?.duration_minutes_sum ?? 0) &&
    Number(dailyRow?.endurance_z2_minutes ?? 0) === Number(rpc?.z2_minutes_sum ?? 0);
  if (!ok) {
    drift += 1;
    console.log(`DRIFT ${date}: daily_logs=${JSON.stringify(dailyRow)} rpc=${JSON.stringify(rpc)}`);
  }
}
console.log(`\n${dates.length - drift} aligned, ${drift} drifted.`);
if (drift > 0) process.exit(1);
```

- [ ] **Step 5: Register cron in vercel.json**

Read existing `vercel.json` to match format, then add an entry:

```json
{ "path": "/api/strava/sync", "schedule": "0 9 * * *" }
```

Alongside the existing `crons` array entries.

- [ ] **Step 6: Verify typecheck**

```bash
npm run typecheck
```

Expected: zero errors.

- [ ] **Step 7: Commit**

```bash
git add lib/query/fetchers/enduranceActivities.ts lib/query/hooks/useEnduranceActivities.ts lib/query/keys.ts scripts/audit-endurance-ingest.mjs vercel.json
git commit -m "feat(endurance): client cache + ingest audit + cron registration

Dual-variant fetcher per the SSR-hydrate convention. Audit verifies
daily_logs.endurance_* matches sum_endurance_for_day output for every
date with activity rows in the last 30d (catches webhook misses,
re-aggregation drift, stale daily_logs writes). Cron /api/strava/sync
runs daily at 09:00 UTC, after WHOOP sync.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review (post-write check, ran before publishing)

**Spec coverage check** (each spec section → task that implements it):

- Phase model + endurance_profile shape → Task 1 (migration) + Task 2 (TS types)
- Strava OAuth + token refresh → Tasks 7-8
- Strava ingest + reaggregation → Task 9
- Sync + backfill → Task 10
- Webhook + subscribe script → Task 11
- TSS computation (HR-based) → Task 4
- HR zones → Task 3
- CTL/ATL/TSB module → Task 5
- Z2 base composer → Task 6
- Interference seam → Task 6
- Carter 7 tools → Tasks 12-13
- Snapshot prefix (3 blocks) → Task 14
- Coach prompts (4 updates) → Task 15
- Adherence pass extension → Task 16
- Peter dashboard Endurance theme → Task 17
- Proactive nudge (dormant) → Task 18
- /profile setup section → Task 19
- Morning brief block → Task 20
- Client cache + audit + cron + env → Task 21

**Placeholder scan:** "TODO" / "TBD" / "fill in details" — none. Every step has concrete content. The few "find in file" steps describe a specific symbol to locate; the engineer then applies the shown code at the matched location.

**Type consistency:**
- `EnduranceSessionPlan` keys = weekday numbers 0-6 across all tasks ✓
- `EnduranceProfile` shape consistent between Task 2 type and Task 12 patchEnduranceProfile default ✓
- `ApprovalAction` `"endurance_week"` added in Task 12, consumed in Task 13 ✓
- `endurance_status` enum: `as_planned | over_intensity | under_volume | missed | not_prescribed` (Task 16) — appears in the spec verbatim ✓
- `HrZoneDistribution.z2_s` field name consistent between Task 1 SQL (`(hr_zone_distribution->>'z2_s')::int`), Task 2 types, and Task 3 `bucketZones` output ✓

**Spec deltas the plan introduces (documented for executor awareness):**
- Token storage shape: dedicated `strava_tokens` table (NOT `profiles.strava_tokens jsonb`). Task 1 step 4 fixes the spec.
- Milestone tools (`set_endurance_*` / `set_threshold_hr` / `set_ftp`) are direct writes, not HMAC-signed — matches GLP-1 pattern in the existing codebase. Spec's "Carter-only, HMAC-signed" line for these is interpreted as "Carter-only" (the HMAC clause applies only to propose/commit_endurance_week).
- `endurance_activities.local_date` added as a non-null column (not in spec table shape). This is the day-attribution key used by `sum_endurance_for_day` — without it, the SQL would have to know the user's timezone. Sourced from Strava's `start_date_local`.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-30-endurance-pillar.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Best for this plan because tasks 7-11 (Strava integration) benefit from the subagent re-reading the canonical WHOOP/Withings OAuth code per-task instead of inferring it from prior conversation.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints. Faster end-to-end but the conversation gets long.

Which approach?
