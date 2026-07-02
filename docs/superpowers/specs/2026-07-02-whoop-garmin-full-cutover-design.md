# WHOOP → Garmin Full Cutover — Design

**Date:** 2026-07-02
**Status:** Approved (design) — pending spec review
**Branch (suggested):** `feat/whoop-garmin-full-cutover`
**Supersedes the parallel-run era of:** [2026-07-01 movement-cluster cutover](2026-07-01-garmin-movement-cluster-cutover-design.md), [2026-07-02 Body Battery + Stress](2026-07-02-garmin-body-battery-stress-design.md)

## Goal

Retire WHOOP as a data source. Make the Garmin Fenix 8 (+ HRM strap) the **sole owner of the recovery/HRV/sleep cluster** — it already owns movement/strain + Body Battery/Stress. Complete a *clean* transition before the WHOOP subscription lapses (~**2026-07-29**, non-renewing): Garmin-only baselines from day one, no silently-frozen metrics, no dead WHOOP UI, and the morning brief unaffected.

## Context — what is already built (no work needed)

The parallel-run arc left the cutover mostly wired behind the `profiles.metrics_source` (`'whoop' | 'garmin'`) knob:

- **The flip itself:** [app/api/ingest/garmin/route.ts](../../../app/api/ingest/garmin/route.ts) calls the full `mapToDailyLogs` (writes `hrv`, `resting_hr`, `recovery`, `sleep_*`, `respiratory_rate`, `spo2`, `strain`, `source:'garmin'`) the instant `metrics_source==='garmin'`; otherwise it writes only the movement/energy + wellness clusters.
- **The collector** ([sidecar/garmin/collector.py](../../../sidecar/garmin/collector.py)) already fetches HRV, RHR, sleep (hours/deep/REM/score), respiratory rate, `training_readiness`, Body Battery, Stress, steps/distance/calories, and all-day HR samples.
- **WHOOP stand-down:** [app/api/whoop/sync/route.ts](../../../app/api/whoop/sync/route.ts) already checks `metrics_source` and skips the `daily_logs` write (`skipped_write: "metrics_source_garmin"`) — no clobber.
- **Baselines read from `daily_logs`**, not the WHOOP API ([lib/whoop/baselines.ts](../../../lib/whoop/baselines.ts) `computeWhoopBaselines`), so the rolling-baseline math works on Garmin data once Garmin writes those columns.
- **`mapToDailyLogs`** ([lib/coach/garmin/map-metrics.ts](../../../lib/coach/garmin/map-metrics.ts)) already maps `training_readiness → recovery` and `spo2 → spo2`; skin temp is intentionally unmapped (Garmin reports *variation*, not absolute °C).

So flipping is one `UPDATE`. The work is everything that makes the flip *clean*.

## Locked decisions

1. **Backfill + overwrite** ~35 days of Garmin recovery into `daily_logs` so baselines are Garmin-only from day one. **Archive the overwritten WHOOP rows to JSON first** — nothing silently destroyed.
2. **Map Training Readiness → recovery** (already wired) **and recalibrate the red-recovery floor** thresholds in `deriveReadiness` against Garmin's TR distribution.
3. **Add SpO2** (Garmin pulse ox) to the collector; **retire absolute `skin_temp_c`** (defer Garmin skin-temp-*variation* as a future signal).
4. **Morning readiness stays previous-day based** — day D's brief computes from day D-1's complete Garmin row, which the collector's normal trailing fetch already writes. **No today-pass, no collector freshness change.** Operational dependency (accepted): the watch synced and the collector ran before check-in; otherwise the brief uses the latest available row and refreshes when the 09:30 Dubai run lands.

## Non-goals (out of scope)

- Renaming the `profiles.whoop_baselines` jsonb column (many readers; keep the name, update docs only — YAGNI).
- Garmin skin-temp-variation as a new column/chart (deferred).
- VO2max / Garmin training-load ingestion (deferred to the endurance ramp, unchanged).
- Any change to Withings / food / endurance / Strava ownership.
- Keeping WHOOP capture flowing to a shadow table for continued A/B during the overlap — the 30-day comparison already green-lit HRV (r=0.93) / RHR (r=0.80); overlap validation is subjective ("does the Garmin-driven ring feel right?") + baseline stabilization, neither of which needs live WHOOP.

## Ownership after cutover

`daily_logs` columns, post-flip:

| Column | Owner after cutover | Notes |
|---|---|---|
| `hrv`, `resting_hr`, `recovery`, `sleep_hours`, `sleep_score`, `deep_sleep_hours`, `rem_sleep_hours`, `sleep_start_at`, `sleep_end_at`, `respiratory_rate` | **Garmin** | `recovery` = Garmin Training Readiness (0–100). |
| `spo2` | **Garmin** | New pulse-ox fetch (this arc). |
| `skin_temp_c` | **retired** | No writer; column + all consumers removed. |
| `steps`, `strain`, `distance_km`, `calories`, `active_calories` | Garmin | Already cut over. |
| `body_battery_low/peak`, `stress_avg/max/qualifier` | Garmin | Already cut over. |
| body composition, `exercise_min`, nutrition, endurance | unchanged | Withings / food / Strava. |

## Work breakdown

### A. Collector — add SpO2, no freshness change
- Fetch pulse-ox: `g.get_spo2_data(d)` → emit `spo2` (e.g. `averageSpo2`; guard Garmin `-1`/`None` sentinels like the stress fields already do).
- **No today-pass.** Trailing complete-days fetch is unchanged.
- Skin temp: leave unfetched (retired).

### B. Route / mapper — confirm only
- `spo2` already mapped in `mapToDailyLogs`; the daySchema already accepts `spo2`. No route change beyond confirming SpO2 flows through when `garminOwnsDaily`.
- Skin temp stays unmapped.

### C. Archive + backfill (the sequence that must be ordered)
Ordering matters — the route only writes the full recovery cluster when `metrics_source==='garmin'`, so the flip precedes the backfill:
1. **Archive:** `scripts/archive-whoop-daily.mts` — dump current `daily_logs` recovery columns (`hrv, resting_hr, recovery, sleep_*, respiratory_rate, spo2, skin_temp_c`) for the last ~35 days to a timestamped JSON under `docs/superpowers/` or a scratch path. Read-only.
2. **Flip:** set `profiles.metrics_source = 'garmin'`.
3. **Backfill:** run the collector with `BACKFILL_DAYS=35` → the route (now in `garminOwnsDaily` mode) writes the full Garmin recovery cluster over those 35 days.
4. **Recompute baselines** (see E) — now Garmin-only.

### D. Red-recovery floor recalibration
- `deriveReadiness` ([lib/ui/score.ts](../../../lib/ui/score.ts)) has a hard floor tuned to WHOOP Recovery%: recovery sub-score `<25 → band low`, `<40 → cap moderate`. Garmin Training Readiness has a different distribution.
- Extract the two thresholds to named constants. Ship **Garmin-appropriate initial values** derived from the `garmin_daily` shadow + backfilled TR distribution.
- `scripts/calibrate-recovery-floor.mjs` — read the TR distribution, print recommended thresholds (e.g. percentile-anchored to match WHOOP's floor hit-rate), so the values can be re-tuned during the overlap. Read-only.
- Update `audit-readiness-score` fixtures if the constants change asserted outputs.

### E. Baseline cron — iterate Garmin users, not `whoop_tokens`
- [app/api/whoop/baselines/sync/route.ts](../../../app/api/whoop/baselines/sync/route.ts) iterates `whoop_tokens`. After the token row lapses this silently stops recomputing.
- Change the cron's user set to `profiles` where `metrics_source = 'garmin'` (single-user app: effectively "the athlete").
- Keep the `rolling_30d` jsonb key and `computeWhoopBaselines` as-is (already `daily_logs`-sourced). Update the file header comment to say "recovery baselines (Garmin-sourced post-cutover)".

### F. Morning intake / recommendation — "awaiting Garmin" notice + recheck
The athlete may check in before the 09:30 Dubai collector run, so we keep an
"data not synced yet" affordance (like the old WHOOP one) but repoint it at
Garmin. There is **no on-demand Garmin sync from the phone** (the Mac collector
is the only path), so the button is **informational + a client-side recheck**,
not a server sync call.

- [app/api/chat/morning/intake/route.ts](../../../app/api/chat/morning/intake/route.ts) currently emits `{ label: "Sync WHOOP now", action: "whoop_sync" }` when `log.recovery == null`. **Replace** with a Garmin-worded notice: copy along the lines of "Garmin hasn't synced today's data yet — sync your watch in Garmin Connect and run the collector, then Recheck." Chips: `{ label: "Recheck", action: "recheck_garmin" }` and the existing `{ label: "Skip — feel-only plan", action: "skip_whoop" }` (rename the action key away from `whoop`).
- The **`recheck_garmin`** action re-queries `daily_logs` for the previous-day recovery row (client re-hits the gate) — no server sync is triggered. If recovery is now present (athlete ran the collector), the flow proceeds to assemble the brief; if still absent, the same notice re-shows.
- [app/api/chat/morning/recommendation/route.ts](../../../app/api/chat/morning/recommendation/route.ts) gates with `awaiting_whoop` when recovery is null. Rework so it reads the **previous-day** recovery row and returns an `awaiting_garmin`-style state (renamed off `whoop`) that the notice above renders; "Skip" still always bypasses to the feel-only path (never a permanent hard-block).

### G. Retire skin temp (all consumers)
- Remove `SkinTempCard` from [components/health/trends/BodySignalsSection.tsx](../../../components/health/trends/BodySignalsSection.tsx).
- Remove `skin_temp_baseline_c` computation from [lib/coach/recovery-intelligence/index.ts](../../../lib/coach/recovery-intelligence/index.ts) and the field from its types/payload.
- Remove `skin_temp_c` from `compose-daily.ts` `SELECT_COLS` + densify fallback + `RecoveryDailyPoint`.
- Remove / disable the `check-skin-temp` proactive trigger ([lib/coach/proactive/check-skin-temp.ts](../../../lib/coach/proactive/check-skin-temp.ts)) and its registration.
- Drop `skin_temp_c` from the snapshot select/template ([lib/coach/snapshot.ts](../../../lib/coach/snapshot.ts)) and any fetcher `COLS` that carry it.

### H. Coach prompts + snapshot copy
- REMI_BASE: drop `skin_temp_c` from the readable-column list; keep `spo2` (now Garmin). PETER_BASE / CARTER_BASE: relabel "WHOOP baselines" → "recovery baselines".
- `SharedLayersCard` copy on [app/profile/coach-prompts/page.tsx](../../../app/profile/coach-prompts/page.tsx): "WHOOP baselines" → "recovery baselines".

### I. UI — ConnectionsPanel
- [components/profile/ConnectionsPanel.tsx](../../../components/profile/ConnectionsPanel.tsx): remove the WHOOP connect / Sync / Backfill CTAs. Since the cutover is permanent, drop the WHOOP card (or render a passive "retired" note). Ensure the Garmin ingest status is the visible connection.

### J. Crons — vercel.json
- Remove the two `/api/whoop/sync` entries (05:00 + 10:00 UTC).
- Keep `/api/whoop/baselines/sync` (now Garmin-driven, per E). Optionally rename the route path in a later cleanup — not required.
- Leave `/api/whoop/backfill` route in place (manual, harmless) but it is not cron'd.

### K. The flip + recompute
- Executed as part of step C (flip → backfill → recompute). Confirm `owns_daily: true` in the ingest response and that `daily_logs` rows carry `source:'garmin'` for the backfilled window.

## Validation

- `npm run typecheck` + `npm run build` clean.
- Audit scripts: `audit-readiness-score`, `audit-rolling-baselines` (Garmin-sourced), plus a dashboard + Health→Trends eyeball (tiles + WellnessSection render; no skin-temp card; SpO2 populates).
- Confirm the morning brief reads yesterday's Garmin recovery row and renders a band. Confirm the early-check-in path: when the previous-day row is missing, the "Garmin hasn't synced yet" notice shows; running the collector then tapping **Recheck** pulls the row in and proceeds; **Skip** always bypasses to feel-only.
- Daily eyeball through late July: the Garmin-driven ring "feels right" vs how the athlete actually feels; recalibrate the floor constants (D) if the band mislabels.
- **2026-07-29 WHOOP expiry is then a non-event** — nothing reads WHOOP live.

## Rollback / point of no return

- **Before the backfill overwrites `daily_logs`:** flipping `metrics_source` back to `'whoop'` fully restores WHOOP ownership (WHOOP still syncing until 07-29).
- **After the backfill:** WHOOP's daily values in the 35-day window live only in the archive JSON (C.1); rollback would restore ownership but not those exact overwritten rows without a re-import from the archive.
- **After 2026-07-29:** no rollback — WHOOP produces no data. Accepted.

## Testing approach

No automated test harness in this repo (per CLAUDE.md). Verification = `typecheck` + `build` + the audit scripts above + manual page exercise. New pure helpers (SpO2 sentinel guard, floor-threshold calibration) get fixture assertions in the relevant existing audit script where one exists.
