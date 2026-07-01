# Garmin Fenix 8 Ingest — replacing WHOOP as the recovery/strain source

**Date:** 2026-07-01
**Status:** Design — pending review
**Author:** Abdelouahed + Claude

## 1. Motivation

The WHOOP subscription is ending (~1 month of runway). Rather than pay WHOOP's recurring
$199–239/yr forever or migrate to the Fitbit Air (whose readiness score is not exposed on
any public API), we move recovery/strain sourcing to the **Garmin Fenix 8 the athlete
already owns** — $0 marginal cost, and the richest available data set.

Garmin's **official** Connect Developer Program is business-only and effectively closed to
individuals, so the practical path is the actively-maintained unofficial library
`python-garminconnect`, which survived Garmin's March 2026 Cloudflare TLS-fingerprinting
crackdown (via `curl_cffi` browser impersonation). This is against Garmin's ToS but
low-consequence for single-user personal use.

**The two signals the athlete actually acts on — recovery and strain — are both covered:**
Garmin exposes Training Readiness (recovery analog) and Training Load (strain analog)
directly, plus all the raw HR needed to compute a WHOOP-parity 0–21 strain in-app.

**Accuracy note that de-risks the whole thing:** the Fenix 8's one real weakness is optical
wrist-HR on intervals/lifting/cold. The athlete owns a **HR chest strap** and will pair it
for lifting sessions — so the recorded activity HR (and therefore Training Load and any
derived strain) is chest-strap-accurate exactly where it matters most for a strength-focused
program.

## 2. Goals & non-goals

**Goals**
- Pull Garmin data daily into the app with no manual entry (incl. steps).
- Preserve every existing downstream consumer: readiness math, rolling baselines,
  recovery-intelligence, autoregulation, morning brief, Carter's prompts — all of which
  read `daily_logs` columns and must keep working unchanged.
- Run Garmin **in parallel with WHOOP for ~1 month** to prove reliability and sane numbers
  before cutting WHOOP.
- Derive a WHOOP-equivalent 0–21 daily strain so `daily_logs.strain` stays on the same scale
  its consumers expect.

**Non-goals (out of scope)**
- Garmin's official Health API / partner approval (closed to us).
- Real-time / intraday live streaming. Daily batch only.
- Endurance pillar overlap (Strava already owns `endurance_*`); Garmin activities are not
  re-ingested as endurance rows in this arc.
- A Node-native Garmin client (all are Cloudflare-blocked; Python sidecar is the path).
- Replicating Garmin's proprietary EPOC formula or WHOOP's exact strain constants — our
  derived strain is a per-user calibration, not a clone (fine: autoregulation only compares
  the athlete to himself over time).

## 3. Architecture — two components

The design splits deliberately into a **thin pump** and **all the smarts**, so the fragile
unofficial-API surface stays as small and dumb as possible.

### 3.1 Component A — the collector sidecar (Python, "the pump")

A small standalone Python program using `python-garminconnect`. Responsibilities, and
nothing more:

1. Authenticate to Garmin (token persisted to disk; 2FA code entered once on first login).
2. For each target date (yesterday + a short catch-up window, see §6), call the getters and
   collect **raw** values.
3. POST the raw JSON to the app's `/api/ingest/garmin` route with a per-user bearer token.
4. Exit. Scheduled once daily by cron.

The sidecar contains **no derivation logic** — it does not compute strain, map recovery, or
decide precedence. It forwards raw Garmin numbers. This keeps the ToS-risky, breakage-prone
code trivial and puts all testable logic in the TypeScript app.

**Getters used (confirmed present in `python-garminconnect`):**

| Getter | Raw payload forwarded |
|---|---|
| `get_hrv_data(d)` | overnight HRV (rMSSD, ms) + status band |
| `get_rhr_day(d)` | resting HR |
| `get_heart_rates(d)` | `heartRateValues`: 2-min-sampled `[ts_ms, bpm]` all-day array (TRIMP input) |
| `get_sleep_data(d)` | sleep duration, stages, sleep score, start/end |
| `get_daily_steps(d,d)` / `get_stats(d)` | steps, distance, calories, floors |
| `get_body_battery(d,d)` | Body Battery time series (peak/low) |
| `get_training_readiness(d)` | Training Readiness score 0–100 (recovery analog) |
| `get_training_status(d)` | Training Load: acute (7-day) / chronic, load ratio |
| `get_respiration_data(d)` | respiration rate |
| `get_max_metrics(d)` | VO2max (reference only) |

For chest-strap lifting sessions where finer resolution is wanted, `get_activities` +
`get_activity_details(id)` expose ~1 Hz workout HR; the 2-min daily stream is the default and
is sufficient for day-level strain.

**Runtime location:** the athlete's Mac for the parallel test (simplest); movable to a small
always-on box (Raspberry Pi / $5 cloud VM) for the hands-off long term. No code change to move
— it's the same script under a different cron.

### 3.2 Component B — the app-side ingest + derivation (TypeScript, "the smarts")

**New route: `POST /api/ingest/garmin`** (dedicated, mirrors the Strava ingest pattern rather
than overloading the Apple-Health webhook, because the payload is richer and carries the
intraday HR array).

- **Auth:** reuse `resolveIngestToken(raw, "garmin")` — add `"garmin"` to the accepted
  source union and mint a per-user token via the existing `/api/ingest/token` flow.
- **Validation:** Zod schema over the raw Garmin payload; malformed fields are dropped, not
  fatal (mirrors the health webhook's defensive coercion).
- **Processing pipeline per date:**
  1. Store the raw payload in a new `garmin_daily` table (always — this is the audit trail).
  2. Derive 0–21 strain from the HR stream (§5).
  3. Map Training Readiness → recovery, and the raw fields → their `daily_logs` columns (§4).
  4. Write to `daily_logs` **only when `profiles.metrics_source = 'garmin'`** (the cutover
     knob, §6). During the parallel phase this write is skipped and only `garmin_daily` is
     populated, so WHOOP stays authoritative and the app is untouched.
  5. `revalidatePath("/")` + `revalidatePath("/coach")` on a `daily_logs` write.

**New module: `lib/coach/garmin/`**
- `derive-strain.ts` — pure TRIMP → 0–21 functions (§5). Unit-audited, no DB.
- `map-metrics.ts` — pure raw-Garmin → `daily_logs`-shape mapper (§4).

## 4. Metric mapping (Garmin → `daily_logs`)

| `daily_logs` column | Garmin source | Notes |
|---|---|---|
| `hrv` | overnight rMSSD (ms) | direct |
| `resting_hr` | `restingHeartRate` | direct |
| `recovery` | **Training Readiness (0–100)** | primary recovery analog; same 0–100 scale as WHOOP recovery% |
| `strain` | **derived 0–21 from TRIMP** (§5) | keeps the column on WHOOP's scale for all consumers |
| `sleep_hours` / `sleep_score` / `deep_sleep_hours` / `rem_sleep_hours` / `sleep_start_at` / `sleep_end_at` | `get_sleep_data` | direct |
| `respiratory_rate` | `get_respiration_data` | feeds baselines |
| `steps` / `distance_km` / `calories` / `active_calories` | `get_daily_steps` / `get_stats` | **ownership moves from Apple Health to Garmin** — no more manual/Shortcut steps |
| `spo2` | Garmin Pulse Ox | **stored but flagged unreliable** (Garmin under-reads 4–6%); kept for continuity, not trusted |
| `skin_temp_c` | Garmin skin-temp *variation* | Garmin reports variation-from-baseline, not absolute °C like WHOOP — store the variation and accept the semantic shift, or leave null (open question §9) |

**Raw-only, kept in `garmin_daily` for reference (not mapped to `daily_logs`):** Body Battery,
Training Status acute/chronic load, VO2max, HRV status band.

### Precedence / ownership changes (code-enforced, per CLAUDE.md convention)
- Post-cutover, **Garmin owns**: `hrv`, `resting_hr`, `recovery`, `strain`, all `sleep_*`,
  `respiratory_rate`, `spo2`, `skin_temp_c` (formerly WHOOP), and `steps`, `distance_km`,
  `calories`, `active_calories` (formerly Apple Health).
- **WHOOP ingest is gated off** at cutover via the same `metrics_source` knob: the WHOOP
  sync cron writes `daily_logs` only when `metrics_source = 'whoop'`. (Mirror of the existing
  `disable_yazio_ingest` / `disable_strong_ingest` pattern, but a single enum instead of two
  booleans, because WHOOP and Garmin are mutually exclusive owners of the recovery cluster.)
- Withings body-comp ownership is untouched. Strava endurance ownership is untouched.

## 5. Strain derivation (`lib/coach/garmin/derive-strain.ts`)

Garmin has no bounded 0–21 strain. We synthesize one so `daily_logs.strain` stays compatible
with `readiness.ts`, `impact.ts`, and `scoreLog`.

**Inputs:** the day's `heartRateValues` (2-min `[ts, bpm]` samples), plus resting HR and max
HR (max HR from profile / age-estimate `208 − 0.7·age`, refined by observed peaks).

**Two TRIMP methods, computed over the full-day stream:**
- **Edwards TRIMP** (default baseline): `Σ (minutes in HR zone × zone weight 1–5)`, zones by
  %HRmax. Needs only max HR.
- **Banister TRIMP** (smoother, WHOOP-like exponential feel): per-interval
  `duration × HRr × 0.64·e^(1.92·HRr)` where `HRr = (HR − HRrest)/(HRmax − HRrest)`, summed.
  Men's coefficients (correct for this athlete).

**Map to 0–21:** `strain = min(21, A · ln(1 + k · TRIMP))`, a saturating log transform. `A`
and `k` are **calibrated per-user during the parallel month** by fitting against WHOOP's
strain on the same days (easy day → low single digits, all-out day → ~19–21). The calibration
constants are stored (profile jsonb or a small config) so the transform is reproducible.

The chest-strap-on-lifting rule means the HR stream feeding this is accurate on hard sessions,
so the derived strain is trustworthy on exactly the days that matter.

## 6. Rollout — two phases, de-risked by the WHOOP overlap

**Phase 1 — Parallel / shadow (the ~1 month of remaining WHOOP):**
- `profiles.metrics_source = 'whoop'` (default). WHOOP keeps writing `daily_logs`; the app is
  visually and behaviourally unchanged.
- The Garmin sidecar runs daily and populates **`garmin_daily` only**.
- An **audit script** (`scripts/audit-garmin-vs-whoop.mjs`) prints a day-by-day comparison of
  Garmin vs WHOOP for HRV, RHR, recovery/readiness, sleep, and strain — the evidence base for
  (a) trusting the numbers and (b) calibrating the strain constants `A`/`k`.

**Phase 2 — Cutover (once Garmin has run clean for ~2 weeks):**
- Flip `profiles.metrics_source = 'garmin'`.
- The Garmin route now writes `daily_logs`; the WHOOP cron no-ops (guarded on the same knob).
- Let WHOOP lapse.
- Rolling baselines need **no change** — they already read `daily_logs` columns
  (`lib/whoop/baselines.ts` `SOURCE_COLUMNS`), so they seamlessly recompute over Garmin data.
  (The historical 6-month WHOOP means stored in `whoop_baselines` remain as biographical
  context only, per existing CLAUDE.md semantics.)

**Backfill window:** each daily run fetches yesterday **plus the last 3 days** and upserts
idempotently (keyed `(user_id, date)`), so a missed run or a late Garmin sync self-heals
without a separate backfill job.

## 7. Data model changes (one migration, next available number — verify latest before applying)

- **`garmin_daily`** table: `(user_id, date)` PK, RLS self, columns for every raw metric
  forwarded by the sidecar + the derived strain + a `raw jsonb` catch-all. This is the audit
  trail and the shadow store during Phase 1.
- **`profiles.metrics_source`** text enum `('whoop' | 'garmin')` NOT NULL DEFAULT `'whoop'`.
  The single cutover knob controlling which source writes `daily_logs`.
- **`ingest_tokens`**: add `'garmin'` as a valid source (mint via existing `/api/ingest/token`).
- No change to `daily_logs` schema — Garmin reuses existing columns.

## 8. Auth, failure handling, and reliability

- **First login / 2FA:** the sidecar prompts for a one-time code if 2FA is on, then persists
  the OAuth token pair to `~/.garminconnect/` (mode 0600). Subsequent runs are silent until
  the refresh token expires (~yearly re-login).
- **Rate limits (429):** a daily single-user pull is the gentlest usage; the library adds
  randomized pre-login delays. On 429, the sidecar backs off and retries; a persistent failure
  logs loudly and exits non-zero (cron surfaces it) without corrupting `daily_logs`.
- **Library breakage:** because it's unofficial, budget for occasional multi-day outages when
  Garmin changes endpoints, resolved by `pip install -U garminconnect`. During any outage the
  app simply shows stale data for those days; nothing crashes. (Post-cutover this is the one
  real operational cost — acceptable for a personal app, and the reason we prove it for a month
  first.)
- **Confidence:** ~80–85% it runs smoothly now and stays working, with the honest expectation
  of 1–3 short maintenance hiccups per year.

## 9. Testing & verification

- `scripts/audit-garmin-vs-whoop.mjs` — Phase-1 day-by-day Garmin-vs-WHOOP comparison +
  strain-calibration fit report. Set `AUDIT_USER_ID`.
- Pure-function audit for `derive-strain.ts` (TRIMP math, zone bucketing, log map, bounds) —
  fixture-based, no DB, in the style of `scripts/audit-prescription-rules.mjs`.
- `npm run typecheck` for the route + mapper + types.
- Post-cutover: reuse the existing rolling-baselines audit to confirm baselines recompute
  cleanly over Garmin data.

## 10. Open questions (for review)

1. **Skin temp:** store Garmin's *variation* value in `skin_temp_c` (semantic shift from
   WHOOP's absolute °C) or leave it null? Leaning null — no consumer strictly needs it and the
   semantics differ.
2. **Sidecar → app transport:** confirmed as HTTPS POST to `/api/ingest/garmin`. (Alternative
   considered and rejected: sidecar writing Supabase directly via service role — worse
   separation, duplicates auth.)
3. **Where the sidecar lives long-term** — Mac for the test; decide Pi vs cloud VM at cutover.
4. **2FA status** on the Garmin account — determines whether first login needs the one-time
   code (no code impact, just the setup step).
