# Garmin movement/energy cluster partial cutover — design

**Date:** 2026-07-01
**Status:** Approved, pre-implementation
**Related:** [2026-07-01-garmin-fenix-ingest-design.md](2026-07-01-garmin-fenix-ingest-design.md) (Phase 1 ingest, shipped 2026-07-01)

## Goal

Move **steps, strain, distance, calories, and active calories** from WHOOP/empty to
the Garmin Fenix 8 (+ HRM chest strap) *now*, ahead of the full recovery/HRV/sleep
cutover. Rationale: with the chest strap, Garmin's HR-derived daily strain is more
trustworthy than WHOOP's wrist optical, and `daily_logs.steps` is currently empty
(no source flowing), so Garmin filling it is pure gain.

This is a **partial cutover**: Garmin takes the movement/energy cluster; WHOOP keeps
recovery/HRV/sleep until the later full cutover (still gated by `metrics_source='garmin'`).

## Current state (verified 2026-07-01)

- `daily_logs.steps` — NULL for all recent days (Apple Health ingest not flowing).
- `daily_logs.strain` — WHOOP-owned, written twice daily by `/api/whoop/sync` via
  `buildWhoopDayRows` ([lib/whoop-day-rows.ts](../../../lib/whoop-day-rows.ts)).
- `garmin_daily` — 30 days backfilled (June 1–30) with real data incl. `strain`,
  `trimp_edwards`, `trimp_banister`.
- Garmin strain calibration is still the **un-tuned default** (`A:4.2, k:0.05` in
  [lib/coach/garmin/derive-strain.ts](../../../lib/coach/garmin/derive-strain.ts)),
  so it diverges from WHOOP day-to-day (e.g. 06-29: WHOOP 5.4 vs Garmin 8.0).
- Garmin ingest route ([app/api/ingest/garmin/route.ts](../../../app/api/ingest/garmin/route.ts))
  writes `daily_logs` all-or-nothing, gated on `garminOwnsDaily = metrics_source==='garmin'`.

## Design

### Ownership model (Approach A: code-defined column ownership)

Source-of-truth stays enforced in code, not DB (per CLAUDE.md). No schema change.

- Define a constant movement/energy cluster: `steps, strain, distance_km, calories,
  active_calories`.
- The Garmin ingest route writes these columns to `daily_logs` on **every** ingest,
  independent of `metrics_source`.
- The recovery/HRV/sleep cluster (`hrv, resting_hr, recovery, sleep_*, spo2,
  skin_temp_c, respiratory_rate`) remains written **only** when
  `metrics_source==='garmin'` — the unchanged future full-cutover path.
- `buildWhoopDayRows` stops emitting `strain`. WHOOP keeps owning
  `hrv, resting_hr, recovery, sleep_*, spo2, skin_temp_c, respiratory_rate`. This is the
  single change that stops WHOOP's twice-daily sync from overwriting Garmin's strain.

Column co-ownership on one `(user_id, date)` row is safe: Supabase/PostgREST upsert on
conflict updates only the columns present in each source's payload, preserving the
others. WHOOP already omits `steps`, so it never clobbered it; dropping `strain` from
its payload makes strain Garmin's.

**`source` tag:** the partial movement/energy write does NOT set `daily_logs.source`
(omits it, preserving whatever is there — normally WHOOP's tag). The row is genuinely
co-owned and `source` is informational only. `source='garmin'` is set only on the full
recovery/sleep write (`metrics_source='garmin'`).

### Route restructure

Split the current single gated `mapToDailyLogs` write into two column groups:

1. **Always:** movement/energy columns (with calibrated `strain`).
2. **When `garminOwnsDaily`:** recovery/HRV/sleep columns + `source:'garmin'`.

Both target the same row; emit a single merged upsert per day so there's one write.
`garmin_daily` shadow write is unchanged (always full).

### Strain calibration

Reuse the existing fit in
[scripts/audit-garmin-vs-whoop.mjs](../../../scripts/audit-garmin-vs-whoop.mjs): it
grid-searches `A,k` for `strain = min(21, A·ln(1 + k·TRIMP_edwards))` minimizing squared
error vs WHOOP strain over overlapping days, and prints the best fit + RMSE. Paste the
result into `DEFAULT_STRAIN_CALIBRATION`.

**Ordering is load-bearing:** run the fit BEFORE the backfill. The fit reads WHOOP
strain from `daily_logs`; once the backfill overwrites those rows with Garmin strain,
the calibration target is gone.

### Backfill

After the code deploys, run the collector once with `BACKFILL_DAYS=30`. The route now
owns the movement/energy columns, so that single run writes calibrated strain + steps +
distance + calories into `daily_logs` for all 30 days — overwriting WHOOP strain for
that window only; older history stays WHOOP.

### Behavioral change (accepted)

The collector fetches complete days only (`range(1, n+1)` — yesterday and back, never
today). Going forward, **today's strain populates the next 9:30 run** rather than
accruing live intra-day the way WHOOP did. Readiness math is unaffected — it reads
*yesterday's* strain, which will be present (see memory
`feedback_readiness_uses_yesterday`). Only visible effect: the current day's strain
shows blank until the next morning. Accepted trade for accuracy. (Rejected alternative:
also fetch today for a live-but-partial value that firms up overnight — added complexity
for little gain at this stage.)

## Sequence

1. Fit calibration via `audit-garmin-vs-whoop.mjs` (reads WHOOP strain) → paste
   constants into `DEFAULT_STRAIN_CALIBRATION`.
2. Restructure the ingest route for partial (movement/energy) column ownership.
3. Drop `strain` from `buildWhoopDayRows`.
4. `npm run typecheck`; commit; merge to `main`; Vercel deploy.
5. Backfill run: `BACKFILL_DAYS=30` collector run.
6. Verify.

## Verification

- `daily_logs` last 30 days: Garmin `steps`/`strain`/`distance_km`/`calories`/
  `active_calories` populated; `strain` continuous with pre-window WHOOP values (no step
  change at the boundary); `recovery`/`hrv`/`sleep_*` still WHOOP values.
- Re-run `audit-garmin-vs-whoop.mjs` → post-calibration RMSE materially lower than the
  default-calibration RMSE.
- Confirm a subsequent WHOOP sync does NOT null or change `daily_logs.strain`/`steps`
  (WHOOP payload no longer includes strain; never included steps).
- `npm run typecheck` clean.

## Out of scope

- Full recovery/HRV/sleep cutover (remains gated by `metrics_source='garmin'`; flip
  later after continued parallel-run comparison).
- Banister-vs-Edwards TRIMP swap (Edwards stays the strain source).
- Apple Health steps ingest (leave dormant; Garmin owns steps now).
- Live intra-day strain (today-fetch) — deferred.
