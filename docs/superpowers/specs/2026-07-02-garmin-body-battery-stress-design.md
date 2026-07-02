# Garmin Body Battery + Stress metrics — design

**Date:** 2026-07-02
**Status:** Approved, pre-implementation
**Related:** [2026-07-01-garmin-movement-cluster-cutover-design.md](2026-07-01-garmin-movement-cluster-cutover-design.md) (established the single-owner Garmin → daily_logs pipeline this reuses), [2026-07-01-garmin-fenix-ingest-design.md](2026-07-01-garmin-fenix-ingest-design.md)

## Goal

Surface two Garmin-native daily metrics the Fenix 8 already measures 24/7 but the app
doesn't use yet: **Body Battery** (0–100 continuous energy) and **Stress** (0–100 all-day
HRV-based stress). Both are reliably populated (verified 2026-07-02); they add a recovery/
autoregulation signal WHOOP never provided. Surface them in the coach, on the dashboard, and
in trends.

**Explicitly deferred:** VO2max (null — needs GPS cardio the athlete isn't doing yet) and
Garmin training load (a 28-day aerobic/anaerobic balance that overlaps the endurance pillar's
own CTL/ATL/TSB). Revisit both when the triathlon ramp generates the underlying data.

## Feasibility (verified 2026-07-02)

- Body Battery: `garmin_daily.body_battery_low/peak` already populated by the collector.
- Stress: `get_stats` returns `averageStressLevel` (e.g. 24), `maxStressLevel` (98), and
  `stressQualifier` (`CALM`/`BALANCED`/`STRESSFUL`) — all present across sampled days.

## Approach

These are Garmin-only, single-owner metrics with no WHOOP counterpart, so they reuse the
movement/energy cluster pattern exactly: collector → `garmin_daily` → written to `daily_logs`
on **every** ingest (independent of `profiles.metrics_source`, no `source` tag so co-owned
WHOOP rows keep theirs) → app reads `daily_logs` → coach reads the snapshot prefix. No new
machinery.

## Data model

Migration `0047_garmin_wellness_metrics.sql` (Dashboard-apply per the 0026-dup CLI snag — see
`reference_supabase_migration_history_lag`; then `supabase migration repair --status applied 0047`):

- `garmin_daily`: add `stress_avg int`, `stress_max int`, `stress_qualifier text`
  (`body_battery_low/peak` already exist).
- `daily_logs`: add `body_battery_low int`, `body_battery_peak int`, `stress_avg int`,
  `stress_max int`, `stress_qualifier text`.

All nullable (`null` = no Garmin data that day). Mirror the new fields in
[lib/data/types.ts](../../../lib/data/types.ts) (`DailyLog`) and the `garmin_daily` row type.

## Collector

[sidecar/garmin/collector.py](../../../sidecar/garmin/collector.py) — Body Battery already
collected. Add stress from `get_stats`: `stress_avg = averageStressLevel`,
`stress_max = maxStressLevel`, `stress_qualifier = stressQualifier` (each guarded, `None` when
absent — consistent with the existing safe-getter style).

## Ingest route + mapper

[app/api/ingest/garmin/route.ts](../../../app/api/ingest/garmin/route.ts) +
[lib/coach/garmin/map-metrics.ts](../../../lib/coach/garmin/map-metrics.ts):
- Extend the daySchema (Zod) with the five fields.
- Add a sibling pure mapper `mapGarminWellness(input)` in map-metrics.ts returning the five
  wellness columns (`body_battery_low/peak`, `stress_avg/max/qualifier`) with the same
  always-present-null, no-`source` contract as `mapMovementEnergy` (leave `mapMovementEnergy`
  unchanged). The route spreads BOTH mappers into each always-written `daily_logs` row.
  `garmin_daily` shadow write gains the three stress fields.
- Fixture assertions added to [scripts/audit-garmin-strain.mjs](../../../scripts/audit-garmin-strain.mjs)
  covering the new mapper columns (always-present, null-when-absent, no `source`).

## UI

- **Query layer:** add the five columns to `COLS` (dashboard) and `TREND_COLS` (trends) in
  [lib/query/fetchers/dailyLogs.ts](../../../lib/query/fetchers/dailyLogs.ts). No new hooks —
  existing `useDailyLogs` consumers get the fields.
- **Dashboard** ([app/page.tsx](../../../app/page.tsx)): a Body Battery tile (peak→low for the
  day) and a Stress tile (avg number + colored `stress_qualifier` badge), using the existing
  `MetricCard` pattern. Guard for `null` (renders "—" when a day has no Garmin data).
- **Trends** ([app/trends/page.tsx](../../../app/trends/page.tsx)): Body Battery and Stress
  added as selectable metrics using the existing chart component.

## Coach integration

[lib/coach/snapshot.ts](../../../lib/coach/snapshot.ts): add a compact `BODY_BATTERY_STRESS`
block to the snapshot prefix (today's Body Battery peak/low + stress avg/qualifier). Light
prompt guidance in REMI_BASE (recovery: sustained high stress /
low Body Battery is an autoregulation flag alongside HRV/RHR) and PETER_BASE (synthesis).
No new coach tools — read-only context only.

## Backfill + verification

- Re-run the collector 30 days (`BACKFILL_DAYS=30`) to populate stress history into both
  tables (Body Battery already present).
- Verify: `daily_logs` shows all five columns for recent days; a WHOOP sync leaves them
  untouched (single-owner, WHOOP never writes them); dashboard tiles + trends charts render
  (including the `null` day case); coach snapshot includes the block; `npm run typecheck` clean;
  `scripts/audit-garmin-strain.mjs` passes.

## Out of scope

- VO2max, Garmin training load (deferred to endurance ramp).
- Stress duration breakdown (rest/low/medium/high) and the intraday Body Battery curve — store
  daily summaries only (avg/max/qualifier, low/peak).
- Any change to `metrics_source` semantics or the recovery/HRV/sleep cutover.
