# Health Tab — Body Composition + Monthly Measurements

**Status**: design approved 2026-05-10, awaiting implementation plan.
**Branch (proposed)**: `feat/health-tab`.

## Problem

Withings sync already writes seven body-composition columns to `daily_logs`
(`weight_kg`, `body_fat_pct`, `fat_mass_kg`, `fat_free_mass_kg`,
`muscle_mass_kg`, `bone_mass_kg`, `hydration_kg`). Five of them surface as
charts on `/trends`. None of them have a focused home — they share a tab with
strain, recovery, sleep, nutrition, and steps.

Body circumferences (neck, arms, chest, three waist heights, hips, thighs,
calves, plus thigh minimums) are not tracked anywhere. They produce a stronger
physiological progress signal than weight alone, especially during
recomposition where weight stays flat. Capture cadence is monthly via a 3D
body-scanner app that emits a 14-row report; the user transcribes the numbers
and (option B) attaches the report screenshot.

## Goal

A new `/health` tab that:

1. Surfaces the latest Withings body composition with deltas vs 30 days ago.
2. Captures monthly circumference measurements (14 fields + optional photo +
   notes), one row per `(user_id, measured_on)`.
3. Shows trends over 12 months for both daily-cadence body comp and
   monthly-cadence circumferences.
4. Computes derived ratios on read (waist–hip, waist–chest, arm/thigh
   symmetry).

Mirrors the structure of `/strength` (server prefetch → hydrated client →
sub-nav pill).

## Non-goals (v1)

- OCR auto-extraction of the scanner screenshot. Deferred to
  `feat/health-ocr`. Field names match the scanner's report so the future
  pre-fill is mechanical.
- Coach context for circumferences. Coach prompts continue to read body comp
  from `daily_logs` only.
- Push reminders or cron-driven cadence prompts. Reminder surface is
  render-time only.
- Orphan-photo garbage collection. Acceptable leak in v1; deferred to
  `feat/health-storage-gc`.
- CSV / bulk historical import. Manual entry only.
- Surfacing circumferences on `/trends`. They live inside `/health → Trend`.

## Architecture

### Data model

New table `body_measurements` (separate from `daily_logs` because cadence
is monthly, the data source is the user not Withings, and the row owns a
photo).

```sql
create table public.body_measurements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  measured_on date not null,

  neck_cm                 numeric(5,1),
  left_upper_arm_cm       numeric(5,1),
  right_upper_arm_cm      numeric(5,1),
  chest_cm                numeric(5,1),
  high_waist_cm           numeric(5,1),
  mid_waist_cm            numeric(5,1),
  low_waist_cm            numeric(5,1),
  hips_cm                 numeric(5,1),
  left_thigh_cm           numeric(5,1),
  left_thigh_min_cm       numeric(5,1),
  right_thigh_cm          numeric(5,1),
  right_thigh_min_cm      numeric(5,1),
  left_calf_cm            numeric(5,1),
  right_calf_cm           numeric(5,1),

  photo_path  text,
  notes       text,
  created_at  timestamptz not null default now(),

  unique (user_id, measured_on)
);

create index body_measurements_user_date_idx
  on public.body_measurements (user_id, measured_on desc);

alter table public.body_measurements enable row level security;

create policy "own_measurements_select" on public.body_measurements
  for select using (auth.uid() = user_id);
create policy "own_measurements_modify" on public.body_measurements
  for all   using (auth.uid() = user_id) with check (auth.uid() = user_id);
```

All circumference fields are nullable so a partial measurement saves cleanly.
The `(user_id, measured_on)` unique constraint makes the save endpoint an
idempotent upsert — re-saving the same date overwrites.

### Storage

New private bucket `health-photos`. Path layout:
`${user_id}/measurements/${measured_on}/${uuid}.${ext}`.

Storage RLS policies (added inside the same migration, after the table) match
the `chat-images` pattern — owner-only by path prefix:

```sql
create policy "own_health_photos_select" on storage.objects
  for select using (
    bucket_id = 'health-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
create policy "own_health_photos_insert" on storage.objects
  for insert with check (
    bucket_id = 'health-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
create policy "own_health_photos_delete" on storage.objects
  for delete using (
    bucket_id = 'health-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
```

**Order is mandatory**: the `health-photos` bucket must be created in the
Supabase dashboard *before* `supabase db push` applies migration `0009`.
The storage-policy `create policy` statements reference `bucket_id =
'health-photos'` and Supabase's storage RLS layer requires the bucket row
to exist (mirrors the `chat-images` setup step in CLAUDE.md). The migration
header comment will state this prerequisite explicitly so future operators
don't trip on it.

### Query infrastructure

Mirrors the canonical `dailyLogs` pattern verbatim
(`lib/query/fetchers/dailyLogs.ts`):

- `lib/query/fetchers/bodyMeasurements.ts` — server + browser variants of
  `fetchBodyMeasurements(client, userId)`. Returns up to the most recent 60
  rows, ordered `measured_on desc`. Both throw on Supabase error.
- `lib/query/hooks/useBodyMeasurements.ts` — single hook
  `useBodyMeasurements(userId)`. The page derives `latest = data?.[0]`
  inline; no separate `useLatest…` hook (would create a redundant cache
  entry and a second invalidation on every save).
- `lib/query/keys.ts` adds:
  ```ts
  bodyMeasurements: {
    all: (uid: string) => ['bodyMeasurements', uid, 'all'] as const,
  }
  ```
- `lib/data/types.ts` adds `BodyMeasurement` matching the row shape.

### Mutation routes

All writes stay on server route handlers per the client-cache rule in
CLAUDE.md.

- **`POST /api/health/measurements/photo`** — multipart upload. Server
  authenticates via cookie client, then writes to `health-photos` via the
  service-role client (storage RLS still enforced through the path-prefix
  policy). Returns `{ path, signed_url }`. Content-type whitelist:
  `image/png`, `image/jpeg`, `image/heic`, `image/webp`. Max 10 MB.
- **`POST /api/health/measurements`** — JSON body
  `{ measured_on, ...14 fields, photo_path?, notes? }`. Upserts on
  `(user_id, measured_on)`. Returns the saved row. Calls
  `revalidatePath('/health')`.
- **`DELETE /api/health/measurements/[id]`** — hard-deletes the row, then
  deletes the photo blob from storage if `photo_path` is non-null. Returns
  `{ ok: true }`.

After any mutation the client invalidates
`queryKeys.bodyMeasurements.all(userId)`.

The photo endpoint is intentionally split from the measurement save so the
upload runs in parallel with the user's typing and a failed save doesn't
discard an already-uploaded photo.

### Derived metrics

New pure-functions module `lib/health/measurements.ts`:

```ts
export function whr(m: BodyMeasurement): number | null
  // mid_waist_cm / hips_cm
export function waistChest(m: BodyMeasurement): number | null
  // mid_waist_cm / chest_cm
export function armAvg(m: BodyMeasurement): number | null
  // (left_upper_arm_cm + right_upper_arm_cm) / 2
export function thighAvg(m: BodyMeasurement): number | null
  // (left_thigh_cm + right_thigh_cm) / 2
export function calfAvg(m: BodyMeasurement): number | null
  // (left_calf_cm + right_calf_cm) / 2
export function symmetryPct(l: number | null, r: number | null): number | null
  // |L-R| / ((L+R)/2) * 100
export function delta(
  curr: BodyMeasurement,
  prev: BodyMeasurement | null,
): Record<keyof BodyMeasurement, { abs: number; pct: number } | null>
```

Any function whose inputs include a `null` returns `null`. UI renders `—`
rather than synthetic zeros. No DB columns or materialized views — computed
on read. Same approach as `lib/coach/progress-metrics.ts`.

All number rendering goes through `fmtNum()` from `lib/ui/score.ts` per
CLAUDE.md.

## UI

### Page wiring

- **`app/health/page.tsx`** (Server Component) — gates auth, mints
  `makeServerQueryClient()`, prefetches:
  - `queryKeys.bodyMeasurements.all(user.id)` via
    `fetchBodyMeasurementsServer`.
  - `queryKeys.healthTrend.range(user.id, ymFrom, today)` via
    `fetchHealthTrendServer` (12-month window over a body-comp-specific
    column projection: `weight_kg, body_fat_pct, fat_mass_kg,
    fat_free_mass_kg, muscle_mass_kg`). A new fetcher pair, sibling to
    `fetchDailyLogsTrendServer`, because that one's projection is narrower
    (HRV/RHR/sleep/strain/weight/BF) for the `/trends` payload budget and
    widening it would inflate every `/trends` page load. Today view derives
    both the latest body-comp values and the 30-day-prior baseline from
    this same dataset.

  Wraps `<HealthClient>` in `<HydrationBoundary>`.
- **`components/health/HealthClient.tsx`** — reads via `useBodyMeasurements`
  and `useHealthTrend`. Owns the view-mode state
  (`'today' | 'trend' | 'log'`) and the form-modal open/close state.
- **`components/health/HealthNav.tsx`** — pill toggle, copies `StrengthNav`
  pattern with three views.

### View 1 — Today (default)

Two stacked cards:

1. **Body composition card** (Withings, daily). For each metric (weight,
   BF%, fat mass, lean mass, muscle mass): "current" is the most recent
   non-null reading for that field within the prefetched 12-month window,
   "baseline" is the most recent non-null reading whose `date` falls inside
   `[today − 35d, today − 25d]` (a ±5-day window around the 30-day mark to
   tolerate sync gaps). If no baseline reading exists in that window, Δ
   renders as `—`. Color: green when moving toward the configured target
   direction (e.g., lower BF% good, higher muscle mass good), red when
   away. Direction map lives alongside the card component.

2. **Latest measurement card** (monthly). Renders all 14 circumferences in
   three groups: **Upper** (neck, L/R upper arm, chest), **Core** (high/mid/
   low waist, hips), **Lower** (L/R thigh, L/R thigh-min, L/R calf). Layout
   matches the scanner screenshot: `Item | Present | Last | Net` columns. Δ
   computed via `delta(latest, prev)` where `prev` is `data?.[1]`.

   Below the table, a derived-metrics row: WHR, W:C, arm symmetry %, thigh
   symmetry %.

   Photo thumbnail bottom-right when `photo_path` is set; tap → fullscreen
   viewer using a fresh signed URL.

   Soft banner above the card if
   `differenceInDays(today, latest.measured_on) > 30`:
   *"Last measured X days ago — log new"* with inline CTA.

   Empty state (no measurements yet): single full-width CTA *"Log your first
   measurement"*.

Persistent button: **Log new measurement** → opens form modal.

### View 2 — Trend

1. **Body comp lines** — line charts for weight, BF%, lean mass, muscle mass
   over the last 12 months. Reuses the existing `<MetricCard>` from
   `/trends` and its range pills (3M / 6M / YTD / 1Y / All). No new chart
   primitives.

2. **Circumference sparklines** — six small cards, each `name + current
   value + Δ vs window start + 12-month sparkline`:
   - Mid waist • Hips • WHR (derived)
   - Chest • Avg upper arm • Avg thigh

   Same range pills as the body-comp section. Configured in a new
   `lib/charts/circumferenceChartConfig.ts` defining the sparkline field
   list.

The other 8 raw circumferences (neck, individual L/R arm, high/low waist,
individual L/R thigh, L/R thigh-min, L/R calf) are exposed on demand by
making each row in the latest-measurement table tappable — expands an inline
12-month sparkline for that single field. Avoids a 14-card chart wall.

### View 3 — Log

Reverse-chrono list of all past measurements. Row layout:
`measured_on | mid_waist | weight (joined from daily_logs by date) | hips |
WHR`.

Tap a row → expands inline showing all 14 fields + photo + notes, with
**Edit** and **Delete** affordances. Edit reopens the form modal preloaded.

### Form modal

Triggered by "Log new measurement" CTA on Today, or Edit affordance on a Log
row.

- Date picker, default today. For new entries with all 14 fields blank;
  for edit, fields preload that row's values.
- Photo upload area (optional). Tap → file picker. On select: client POSTs
  to `/api/health/measurements/photo` immediately. Thumbnail + ✕ on success.
  Upload runs in parallel with the user typing the rest of the form.
- 14 numeric fields grouped Upper / Core / Lower (same grouping as Today
  view). Inline numeric keypad. Soft validation: any value outside
  `0 < x ≤ 300` renders the field with a red border and a small *"Unusual
  value"* hint underneath, but Save remains enabled — out-of-range readings
  are saved as-is. Hard validation (rejected by API): `< 0` or
  non-numeric.
- Optional notes textarea.
- **Save** disabled until at least one circumference field has a value.
- Save → `POST /api/health/measurements` with `null` for empty fields. On
  success: invalidate, close modal, scroll to new entry, brief toast
  *"Saved"*. On error: banner inside modal, form state preserved.
- When *creating new* and a row already exists for the chosen date, show a
  confirm dialog before overwrite. When *editing*, suppressed.

### Dashboard tile (`/`)

New `<BodyTile>` mirroring how the strength entry point reaches `/strength`
from the home page. Shows:

- Latest weight + Δ vs 30d (Withings, always fresh).
- Latest mid-waist + Δ vs prior measurement, or *"Log first measurement"* if
  none.
- Small `30d+` chip when overdue.
- Tap → `/health`.

Plus a small *"→ Body"* link inside the body-comp section of `/trends` for
users coming from the trends path.

Bottom nav stays at four visible items (Today / Trends / [FAB] / Coach /
Profile). Health is reached the same way Strength is.

## Build sequence

1. Migration `0009_body_measurements.sql` (table + index + RLS + storage
   policies) and manual `health-photos` bucket creation.
2. Types + query infra (`BodyMeasurement` in `lib/data/types.ts`, fetcher
   pair, hook, query key).
3. API routes — photo upload, measurement upsert, measurement delete.
4. Pure derived-metrics module `lib/health/measurements.ts`.
5. Form modal component.
6. `/health` page + `<HealthClient>` + `<HealthNav>` + Today / Trend / Log
   views.
7. `<BodyTile>` on `/` and the `/trends → /health` link.
8. CLAUDE.md update — new migration step, new owner-of-circumferences entry
   in the data-sources section.

Each step is independently typecheckable. Order matters: types before
fetchers before hooks before UI.

## Risks and mitigations

- **Schema drift between scanner labels and our column names.** Mitigated by
  naming columns to match the scanner's label set verbatim
  (`left_thigh_min_cm`, `high_waist_cm`, etc.). If the scanner changes
  vendors later, we add a label-mapping table — out of scope here.
- **Stale signed URLs in the photo viewer.** Each open of the viewer mints a
  fresh URL via the photo endpoint or a dedicated GET; URLs are not stored
  in the cached row.
- **Orphan storage objects.** Acceptable for v1 (single user, low volume).
  Tracked as `feat/health-storage-gc`.
- **30-day reminder fires on render only.** If the user never opens
  `/health`, no nudge happens. Acceptable; this is a personal app, not
  retention-driven.

## Follow-on PRs

1. **`feat/health-ocr`** — Anthropic vision call on photo upload returns the
   14 numbers; modal pre-fills.
2. **`feat/health-coach-context`** — feed latest measurement + WHR / symmetry
   into coach prompts.
3. **`feat/health-storage-gc`** — nightly cron deletes orphan photos.
4. **`feat/health-csv-import`** — backfill historical measurements from CSV.
