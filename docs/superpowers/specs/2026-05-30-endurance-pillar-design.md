# Endurance Pillar — Design

**Date:** 2026-05-30
**Status:** Approved (awaiting implementation plan)
**Owner:** single-user app, Abdelouahed
**Relation to other work:** First-class coached pillar parallel to strength. Touches the data model ([daily_logs](../../supabase/migrations), new `endurance_activities` table, `athlete_profile_documents` extension, `training_weeks` extension), the coach team (Carter's mandate expands; Peter's dashboard gains a theme; Nora's fueling rules become endurance-aware; Remi reads endurance load), and the UI (new `/endurance` page, `/profile` setup, morning brief block). Phase-aware design mirrors the existing GLP-1 mode discriminator pattern in [lib/coach/plan-builder/compose-nutrition.ts](../../lib/coach/plan-builder/compose-nutrition.ts) and [lib/morning/brief/get-today-targets.ts](../../lib/morning/brief/get-today-targets.ts).

## Problem

Endurance training is invisible at the activity level. Garmin → Apple Health → `daily_logs.{steps, distance_km, exercise_min, active_calories}` gives day-summed totals only, with no sport label, no HR distribution, no structured-workout context, no TSS-equivalent training-load metric. WHOOP strain is whole-day and modality-agnostic — a 90-minute Z2 ride and a heavy squat session both contribute to the same number.

Concretely, today's gaps:

1. **No per-activity record.** No way to ask "what did I do yesterday at 6pm" or "how many Z2 minutes this week."
2. **No structured prescriptions.** `training_weeks.session_plan` is lift-shaped (`SESSION_PLANS` is squat/bench/etc.). There is no parallel for "Tue: 75min Z2 ride, HR 130-145."
3. **No training-load metric.** `daily_logs.strain` (from WHOOP) and `exercise_min` (from Apple Health) are both too coarse to inform coaching decisions — they don't distinguish modality, don't capture HR distribution, don't scale with threshold HR.
4. **No coach mandate.** Carter's prompt is strength-only. Nora's fueling rules don't read endurance load. Remi's recovery layer doesn't account for cumulative aerobic volume. Peter's dashboard has six themes, none endurance.
5. **No integration substrate.** Strava is the natural per-activity source for this user (Garmin device → Garmin Connect → Strava sync already configured), but no Strava OAuth, no webhook subscription, no ingest path.

The current operating phase makes this particularly acute: the user is in a **Z2-cycling-for-fat-loss phase** through end of year, then pivoting to **full triathlon training**. The fat-loss phase wants 4-5 low-intensity rides per week with HR-capped Z2 work; the triathlon phase wants swim/bike/run, brick workouts, periodization, formal strength↔endurance interference autoregulation. A design that ships cycling-only and rewrites for triathlon is the wrong design.

## Goals

1. **Phase-aware endurance pillar** that ships for the current Z2-cycling phase and accepts triathlon expansion without schema rewrites. Discipline + phase live on `athlete_profile_documents.endurance_profile`; planner branches on phase, same in-place milestone pattern as `set_glp1_taper_started`.

2. **Strava as the per-activity ingest.** Free-account OAuth, webhook subscription, push-fetch on activity creation/update/delete. Strava is single source of truth for `endurance_activities`. Garmin Connect API and TrainingPeaks integration deferred to Phase 2.

3. **Training-load metric (TSS) at the day level on `daily_logs`** so every existing surface that reads daily metrics (readiness, dashboards, trends, weekly review, proactive nudges) can incorporate it without new query plumbing.

4. **Carter's mandate expands to Strength & Conditioning Coach** — owns both lift and endurance. New tools: `query_endurance_activities`, `propose_endurance_week`, `commit_endurance_week`, `set_endurance_phase`, `set_endurance_discipline`, `set_threshold_hr`, `set_ftp`. No fifth coach yet; reconsider when triathlon phase exposes attention-budget conflicts.

5. **Strength↔endurance interference seam.** Phase 1 ships a light rule (Z2 base + <5h/wk endurance → no strength reduction) so we have somewhere to put the logic. Phase 2 wires formal autoregulation rules into `session_prescriptions` for the triathlon phase.

6. **New `/endurance` page** with `?sub=activities|plan|trends` sub-pills, mirroring the `/metrics` sub-pill pattern. Activities timeline, this-week prescribed plan, weekly volume + CTL/ATL/TSB trends, Z2-minutes streak.

7. **Morning brief gains an endurance block** when today is endurance-prescribed (HR target, duration, intent), parallel to the existing session block.

8. **Peter dashboard gains an Endurance theme** alongside the existing six. Cross-theme detection picks up obvious clusters (e.g., high endurance volume + suppressed HRV → Remi-flagged under-recovery).

9. **Phase 1 ships the buildable scope.** Triathlon-specific bits (brick workouts, swim metrics, race-prep periodization, power-meter TSS), TrainingPeaks integration, and Garmin Connect partner integration are explicitly deferred.

## Non-goals

- **Reconciling WHOOP strain with Strava-derived TSS.** They measure different things — display both, don't subtract. Mirrors how Withings body composition and Apple Health calories already coexist without reconciliation.
- **Garmin Connect API integration in Phase 1.** Partner-gated, historically slow approval. Garmin data flows transitively via Garmin → Strava sync.
- **TrainingPeaks integration in Phase 1.** Also partner-gated. More importantly, in the Z2-cycling phase Carter writes the simple prescriptions in-app; structured intervals (which TP shines for) belong to the build/race-prep phase.
- **Power-meter-based TSS in Phase 1.** Z2 cycling for fat loss usually means no power meter. HR-based TSS (hrTSS) covers it. Power-meter swap is a same-column, different-formula change in Phase 2.
- **Swim metrics (CSS, SWOLF, pool/OWS distinction).** Triathlon phase only.
- **Splitting Carter into separate strength and endurance specialists.** Reconsider only when triathlon load makes attention-budget conflicts measurable.
- **CTL/ATL/TSB chart in Phase 1 ship.** The math is trivial (42d EWMA + 7d EWMA + difference), but for fewer than ~6 weeks of historical endurance data the chart is uninformative. Land the data model; render the chart after the data accumulates. List it under deferred until ~6 weeks of post-launch data exists.

## Phase model (the spine)

Mirroring the GLP-1 pattern, an `endurance_profile` jsonb block on `athlete_profile_documents` carries:

```ts
type EnduranceProfile = {
  discipline: 'cycling' | 'running' | 'triathlon';
  phase: 'aerobic_base' | 'build' | 'race_prep' | 'taper' | 'off_season';
  threshold_hr: number | null;          // LTHR, bpm — required for hrTSS
  hr_max: number | null;                // optional, falls back to 220-age
  hr_zones: { z1: [number, number], z2: [...], z3: [...], z4: [...], z5: [...] } | null;  // derived from threshold_hr if null
  ftp_watts: number | null;             // cycling, optional, unused in Phase 1
  threshold_pace_s_per_km: number | null; // running, optional, unused in Phase 1
  weekly_volume_target_hours: number;   // Carter-prescribed
  current_race: { date: string; distance: string } | null;
  set_at: string;                       // ISO timestamp
};
```

**Phase transition tools** (Carter-only, HMAC-signed):

- `set_endurance_phase({ phase, weekly_volume_target_hours? })` — phase mutation in place
- `set_endurance_discipline({ discipline })` — `cycling` → `triathlon` when user transitions
- `set_threshold_hr({ bpm })` — calibration write
- `set_ftp({ watts })` — Phase 2 use, ship the tool anyway

Mutations are milestones, not new acknowledged versions (Phase 1 immutability invariant applies to the rest of `athlete_profile_documents`, not these milestone fields — same carve-out as GLP-1 status mutations).

**Phase semantics** in [lib/coach/endurance/compose-z2-base.ts](../../lib/coach/endurance/) and future composers:

- **`aerobic_base` (current):** Z2 only, HR cap = `threshold_hr × 0.83`, weekly target 4-5 rides × 60-90min, intent framed as fat oxidation + mitochondrial density. No intervals.
- **`build`:** polarized 80/20 (80% Z2, 20% Z4/Z5), 2 quality sessions/wk, 1 long ride. Composer = `compose-build.ts` (deferred to Phase 2).
- **`race_prep`:** sport-specific specificity, race-pace work, brick workouts (tri only). Deferred.
- **`taper`:** volume cut 40-60%, intensity hold. Deferred.
- **`off_season`:** unstructured — Carter doesn't prescribe, just tracks volume.

Phase 1 ships **only `aerobic_base`**. Other phase composers stub to "Not implemented for current phase — extend in Phase 2."

## Integrations

### Strava (Phase 1 — primary)

OAuth 2.0 mirror of the WHOOP integration pattern at [lib/whoop.ts](../../lib/whoop.ts) and [app/api/whoop/](../../app/api/whoop/).

- **`/api/strava/auth`** — server-side redirect to Strava authorization URL. Scopes: `read,activity:read_all,profile:read_all`. Includes `state` CSRF token.
- **`/api/strava/callback`** — exchanges code for tokens, stores `(access_token, refresh_token, expires_at, athlete_id)` on `profiles.strava_tokens` jsonb. Single-user app, no per-user token table needed (mirrors WHOOP storage pattern).
- **`/api/strava/sync`** — `CRON_SECRET`-gated daily backfill (09:00 UTC, after WHOOP sync at 08:00). Fetches `athletes/{id}/activities` for last 7 days, upserts `endurance_activities`. Catches webhook misses.
- **`/api/strava/backfill?since=YYYY-MM-DD`** — session-authed historical backfill. Paginated, rate-limit-aware (200 req / 15min, 2000/day).
- **`/api/strava/webhook`** — handles push events. GET = subscription validation handshake (echoes `hub.challenge`). POST = activity events. Logic:
  - `aspect_type: 'create'` → fetch full activity, write `endurance_activities` row, recompute `daily_logs.endurance_*` for the affected date.
  - `aspect_type: 'update'` → re-fetch, upsert by `external_id`.
  - `aspect_type: 'delete'` → mark `endurance_activities.deleted_at`, recompute day.
- **`/api/strava/disconnect`** — POST that nulls `profiles.strava_tokens` and revokes subscription. Symmetric with `/api/withings/disconnect`.

**Webhook subscription** is created once via `scripts/strava-subscribe-webhook.mjs`. Stores subscription ID in a script-local artifact (single-user — no DB row needed). Subscription survives token refreshes; only needs re-registration on callback URL change.

**Token refresh** in `lib/strava/client.ts` — wrapper around the Strava REST endpoint that auto-refreshes when `expires_at < now + 5min`. Same pattern as WHOOP.

**Rate-limit budget:** 2000 req/day is far more than needed (~5-10 activities/week × ~3 calls each = trivial). Backfill of full history (~2 years) uses paginated `/athletes/activities` (page size 30 = ~3 pages/month = ~70 pages for 2 years = ~210 requests, well within the daily budget but spread across multiple runs to be polite).

### Garmin Connect (deferred to Phase 2)

Partner-gated API. Garmin data flows transitively via the user's existing Garmin → Strava sync. Phase 1 explicitly does not integrate Garmin directly. If Strava sync ever proves lossy (specific metric gaps), revisit at Phase 2 boundary.

### TrainingPeaks (deferred to Phase 2)

Also partner-gated. Carter writes prescriptions in-app for Phase 1; the Z2 cycling phase doesn't need TP's structured-workout format. TP integration becomes interesting when the build phase starts and Carter is prescribing complex intervals — at that point TP can be a structured-workout *output* destination (write Carter's prescriptions to TP's calendar, which then pushes to the Garmin device).

### Apple Health (unchanged)

Continues to feed `daily_logs.{steps, distance_km, exercise_min, active_calories}` as day-level fallback. Does not overlap with `endurance_activities` table. When `endurance_activities` rows exist for a date, `endurance_minutes` (sport-duration-summed) and `exercise_min` (Apple Health fallback) coexist — display both with source labels in `/coach/trends`.

### WHOOP (unchanged)

Continues to own recovery/strain. No attempt to split WHOOP strain across activities. `daily_logs.strain` and `daily_logs.endurance_load` are displayed side-by-side; Carter's prompt is taught the distinction.

## Data model

### New table — `endurance_activities`

```sql
create table public.endurance_activities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null check (source in ('strava','manual')),
  external_id text,                          -- Strava activity ID
  sport text not null check (sport in ('cycling','running','swimming','other')),
  started_at timestamptz not null,
  duration_s int not null,
  distance_m numeric,
  elevation_gain_m numeric,
  avg_hr int,
  max_hr int,
  hr_zone_distribution jsonb,                -- { z1_s, z2_s, z3_s, z4_s, z5_s }
  avg_power_w int,                           -- nullable, Phase 1 unused for prescription
  normalized_power_w int,
  intensity_factor numeric,                  -- IF
  tss numeric,                               -- hrTSS in Phase 1, swappable to pwrTSS in Phase 2
  avg_pace_s_per_km int,                     -- running
  avg_speed_kmh numeric,                     -- cycling
  calories int,
  raw jsonb,                                 -- full Strava response for replay
  deleted_at timestamptz,                    -- soft delete for Strava DELETE webhooks
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.endurance_activities enable row level security;
create policy "endurance_activities self" on public.endurance_activities
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Partial unique index, not a table constraint (mirrors migration 0003's pattern
-- for the same `(user_id, external_id) WHERE external_id IS NOT NULL` shape).
create unique index endurance_activities_external_id_uniq
  on public.endurance_activities (user_id, source, external_id)
  where external_id is not null;

create index endurance_activities_user_date_idx
  on public.endurance_activities (user_id, started_at desc);
```

### Extend `daily_logs`

```sql
alter table public.daily_logs add column if not exists endurance_load numeric;
alter table public.daily_logs add column if not exists endurance_minutes int;
alter table public.daily_logs add column if not exists endurance_z2_minutes int;
```

**Aggregation function** `sum_endurance_for_day(p_user_id uuid, p_date date)` — SECURITY DEFINER, `search_path = public, pg_temp`. Sums `tss`, `duration_s / 60`, and Z2 portion of `hr_zone_distribution` across `endurance_activities` rows whose `started_at::date = p_date`. Called from the webhook handler after each insert/update/delete. Mirrors `sum_food_entries` from migration 0018.

### Extend `athlete_profile_documents`

```sql
alter table public.athlete_profile_documents
  add column if not exists endurance_profile jsonb;
```

Shape documented in [Phase model](#phase-model-the-spine) section. NULL = endurance not configured (user hasn't done `/profile` endurance setup yet). When NULL, all endurance surfaces show a "Set up endurance" empty state pointing to `/profile?section=endurance`.

### Extend `training_weeks`

```sql
alter table public.training_weeks
  add column if not exists endurance_session_plan jsonb;
```

Shape parallel to `session_plan`:

```ts
type EnduranceSessionPlan = {
  [weekday: 0|1|2|3|4|5|6]: {
    type: 'rest' | 'z2_ride' | 'z2_run' | 'tempo' | 'intervals' | 'long' | 'brick';
    duration_min: number;
    hr_cap?: number;            // Z2 sessions
    hr_target_range?: [number, number];
    description: string;        // human-readable, e.g., "75min Z2 ride, HR 130-145, fat-burning focus"
    sport: 'cycling' | 'running' | 'swimming';
  };
};
```

`endurance_session_plan` is nullable; NULL means "no endurance prescribed this week" (e.g., user paused endurance, off-season, or fresh user pre-setup). Phase 1 composer writes only `z2_ride` / `rest` slots.

### Extend `training_blocks`

```sql
alter table public.training_blocks
  add column if not exists endurance_focus jsonb;
```

Block-level endurance goals:

```ts
type EnduranceFocus = {
  weekly_volume_target_hours: number;
  intensity_distribution: '100_z2' | '80_20' | 'polarized' | 'pyramidal';
  expected_adaptations: string[];   // ["mitochondrial density", "fat oxidation"]
  notes?: string;
};
```

NULL for blocks predating endurance pillar. New blocks created during/after endurance phase get this populated by Carter's block-setup flow.

### Adherence integration

[lib/coach/adherence.ts](../../lib/coach/adherence.ts) gains an endurance adherence pass: per prescribed endurance day, check whether `endurance_activities` rows for that date match the prescription type within tolerance (duration ±15min, HR cap not exceeded). Adherence prose distinguishes "prescribed Z2, actually did Z3" from "prescribed Z2, hit target" from "missed." Output shape extends the existing per-day `status` field with an `endurance_status` peer (`as_planned | over_intensity | under_volume | missed | not_prescribed`) so the weekly review's adherence section can narrate both pillars without conflating them.

## Training-load metric (TSS)

### Phase 1 — HR-based TSS (hrTSS)

Per-activity computation in [lib/coach/endurance/tss.ts](../../lib/coach/endurance/):

```ts
function computeHrTss(durationS: number, avgHr: number, thresholdHr: number): number {
  const durationH = durationS / 3600;
  const intensityRatio = avgHr / thresholdHr;
  return durationH * Math.pow(intensityRatio, 2) * 100;
}
```

Reference: a 1-hour effort at threshold HR = 100 TSS by definition. 1 hour at 80% of threshold = 64 TSS. 90min at 75% = ~84 TSS.

**Requires `endurance_profile.threshold_hr`.** If NULL, TSS is computed as NULL and surfaces show "Calibrate threshold HR to enable training-load tracking" CTA pointing to `/profile`.

### HR zones from threshold HR

Computed in [lib/coach/endurance/hr-zones.ts](../../lib/coach/endurance/) when `hr_zones` field is NULL:

| Zone | % of LTHR | Label |
|------|-----------|-------|
| Z1   | < 81%     | Recovery |
| Z2   | 82-89%    | Aerobic |
| Z3   | 90-94%    | Tempo |
| Z4   | 95-105%   | Lactate threshold |
| Z5   | > 106%    | VO2 / anaerobic |

(Coggan's HR zones, widely-used cycling standard. Running zones are slightly different but the spread is similar; Phase 1 uses one model for all sports.)

`hr_zone_distribution` is computed in the ingest function by walking the Strava HR stream (1-second samples) and bucketing each sample into a zone.

### Phase 2 — power-based TSS (pwrTSS)

Same column. When `avg_power_w` is present AND `ftp_watts` is set:

```ts
function computePwrTss(durationS: number, normalizedPowerW: number, ftpW: number): number {
  const durationH = durationS / 3600;
  const intensityFactor = normalizedPowerW / ftpW;
  return durationH * Math.pow(intensityFactor, 2) * 100;
}
```

Preference at ingest time: `pwrTSS if (avg_power_w && ftp_watts) else hrTSS if (avg_hr && threshold_hr) else NULL`. Phase 1 only ever reaches the second branch.

### CTL / ATL / TSB

Computed on-demand in [lib/coach/endurance/training-load.ts](../../lib/coach/endurance/) from `daily_logs.endurance_load` series. Not stored.

- **CTL (Chronic Training Load)** = 42-day EWMA of daily TSS — "fitness"
- **ATL (Acute Training Load)** = 7-day EWMA of daily TSS — "fatigue"
- **TSB (Training Stress Balance)** = CTL - ATL — "form"

Surfaced on `/endurance?sub=trends` once ~6 weeks of data exist. Listed in deferred for Phase 1 ship.

## Coach mandate expansion

### Carter — Strength & Conditioning Coach

Update [CARTER_BASE](../../lib/coach/system-prompts.ts) prompt:

- Title: "Strength & Conditioning Coach" (from "Strength Coach")
- Mandate: explicitly owns both lift and endurance
- New tools: see below
- Endurance-phase-aware language: prompt teaches Carter the `aerobic_base` phase's intent (fat oxidation, mitochondrial density, low interference with strength). Prompt explicitly says: "in `aerobic_base` phase, do not prescribe intervals; do not push intensity; HR cap is non-negotiable."
- Reads new snapshot fields: `endurance_profile`, `endurance_load_7d_avg`, `endurance_minutes_7d_sum`, `last_3_endurance_activities`.

**New Carter-only tools** (added to `CARTER_TOOLS` in [lib/coach/tools.ts](../../lib/coach/tools.ts)):

- `query_endurance_activities({ start_date, end_date, sport?, min_duration_min? })` — read endurance activity rows. 90-day range cap, mirrors `query_food_log`.
- `propose_endurance_week({ week_start, plan: EnduranceSessionPlan, rationale })` — HMAC-signed preview with `action="endurance_week"`. Renders as confirmation chip.
- `commit_endurance_week({ week_start, plan, approval_token })` — writes `training_weeks.endurance_session_plan` for that week. Requires existing `training_weeks` row (Carter typically calls this AFTER `commit_week` for strength, or merges into an existing row).
- `set_endurance_phase({ phase, weekly_volume_target_hours? })` — milestone mutation on `endurance_profile`.
- `set_endurance_discipline({ discipline })` — milestone mutation.
- `set_threshold_hr({ bpm })` — calibration write.
- `set_ftp({ watts })` — Phase 2 use, ship the tool.

Tool gating in [lib/coach/chat-stream.ts](../../lib/coach/chat-stream.ts) `modeAllowsTool`: endurance tools allowed in `default` / `plan_week` / `setup_block` modes. Not in `intake` or `meal_log` modes. Same gating rules as strength planning tools.

`PERSIST_RESULT_TOOLS` set in [lib/coach/chat-stream.ts](../../lib/coach/chat-stream.ts) gains `propose_endurance_week` and `commit_endurance_week` so confirmation chips render correctly on chat history reload.

### Nora — endurance-aware fueling

Update [NORA_BASE](../../lib/coach/system-prompts.ts) prompt:

- Reads new snapshot fields (`endurance_phase`, `today_endurance_session_type`, `today_endurance_duration_min`).
- New fueling rule: **Z2 cycling days require small CHO pre (20-30g, e.g., banana), protein-led post (no carb dump).** Rationale: fat oxidation is the training intent; large pre-ride CHO blunts the adaptation. Cite in coach narration when user logs an endurance day.
- Phase 2 expansion (deferred): build/race-prep phase = carb periodization, glycogen-replenishment windows, race-day fueling protocols.
- Reads `daily_logs.endurance_load` to flag under-fueling on high-TSS days.

### Remi — endurance load in recovery intelligence

Update [REMI_BASE](../../lib/coach/system-prompts.ts):

- Reads `daily_logs.endurance_load` rolling 7-day sum.
- New trigger in [lib/coach/proactive/](../../lib/coach/proactive/) — `check-endurance-volume-spike.ts`: if 7d endurance volume > 1.4× the 28d rolling average AND HRV is suppressed > 0.5×SD below rolling 30d baseline, fire a `proactive_nudge` card with `trigger_key='endurance_volume_recovery_mismatch'`.
- Migration 0017's dedup table is the source of truth (per the existing pattern).

### Peter — Endurance theme on dashboard

New composer [lib/coach/peter-dashboard/compose-endurance.ts](../../lib/coach/peter-dashboard/). Theme:

- **Volume trend** (this week vs target, vs last 4 weeks)
- **Intensity distribution** (% time in each zone over 4 weeks)
- **Phase alignment** (does actual training match prescribed phase?)
- **Strength↔endurance balance** (lifting days vs endurance days, interference rule output)
- **Severity grading** (`ok` | `attention` | `concern`) and cluster-detection inputs

Added to [lib/coach/peter-dashboard/index.ts](../../lib/coach/peter-dashboard/) orchestrator parallel-run. Link-themes can pair Endurance with Recovery (high volume + suppressed HRV = under-recovery cluster), with Recomp (insufficient endurance volume during fat-loss phase = "missing cardio for deficit" cluster), and with Performance (lift performance drop during high endurance weeks = interference cluster).

[PETER_BASE](../../lib/coach/system-prompts.ts) prompt updated to teach Peter how to read the Endurance theme block, with explicit cluster examples.

### Snapshot prefix injection

[lib/coach/snapshot.ts](../../lib/coach/snapshot.ts) gains new blocks (after BASELINES_LIVE_30D / BASELINES_HISTORICAL, before peter-dashboard injection):

```
ENDURANCE_PROFILE:
  Discipline: cycling
  Phase: aerobic_base (set 2026-05-30)
  Weekly volume target: 5h
  Threshold HR: 162 bpm (calibrated 2026-05-30)
  HR cap (Z2): 135 bpm

ENDURANCE_LOAD_7D:
  TSS sum (7d): 412
  Endurance hours (7d): 4.5
  vs 28d rolling avg: 0.95× (within normal)
  Z2 minutes (7d): 268

LAST_3_ENDURANCE_ACTIVITIES:
  2026-05-29 | cycling | 75min | avg HR 134 | TSS 65 | Z2:62 Z3:13
  2026-05-27 | cycling | 90min | avg HR 138 | TSS 82 | Z2:78 Z3:12
  2026-05-25 | cycling | 60min | avg HR 132 | TSS 51 | Z2:55 Z3:5
```

Phase 1: blocks are always present in the snapshot (no flag). When `endurance_profile` is NULL, blocks render as "ENDURANCE_PROFILE: not configured" — coaches are taught to suggest setup.

## Strength↔endurance interference autoregulation

### Phase 1 — light rule

In [lib/coach/interference/check-interference.ts](../../lib/coach/) (new):

```ts
function strengthVolumeAdjustment(profile: EnduranceProfile, endurance7dHours: number): {
  adjustment: 'none' | 'reduce_15pct' | 'reduce_30pct';
  rationale: string;
} {
  if (profile.phase === 'aerobic_base' && endurance7dHours < 5) {
    return { adjustment: 'none', rationale: 'Z2 base volume too low to cause interference.' };
  }
  if (profile.phase === 'build' && endurance7dHours > 8) {
    return { adjustment: 'reduce_15pct', rationale: 'Build-phase endurance volume causing measurable interference.' };
  }
  // ... etc
  return { adjustment: 'none', rationale: '' };
}
```

In Phase 1, the rule almost always returns `'none'` (Z2 phase + low volume). Wired into [compose-prescription](../../lib/coach/prescription/) so the seam exists. Output also surfaces on Peter's dashboard Endurance theme.

### Phase 2 — formal rules

New module `lib/coach/interference/` with rules:
- **Volume-based:** weekly endurance > 8h → strength volume × 0.85
- **Schedule conflict:** big-legs day within 24h of long ride / brick → re-order
- **Intensity overlap:** Z4/Z5 day + heavy lower-body same day → split
- **Recovery weeks:** strength deload synced to endurance recovery week

Formal rules are out of scope for Phase 1. Land the module, document the seam, ship the easy rule. Real rules show up when triathlon phase needs them.

## UI surfaces

### New `/endurance` page

Pattern mirrors `/metrics` and `/coach`. SSR-hydrate with TanStack Query per the [client cache convention](../../CLAUDE.md#client-cache-tanstack-query--read-this-before-adding-interactive-queries).

- **`/endurance?sub=activities`** (default): timeline of recent rides/runs. Each row: date, sport, duration, distance, avg HR, TSS, HR-zone sparkline, link to Strava activity (opens `https://www.strava.com/activities/{external_id}` in new tab). Pagination: 30/page, infinite scroll.
- **`/endurance?sub=plan`**: this week's `endurance_session_plan` rendered as 7-day cards (M-Su). Each prescribed day shows type, duration, HR target, intent text. Today's card is highlighted. Past days show ✅ / 🚫 / ➖ adherence chip (matched / missed / swapped). Below the week: block-level `endurance_focus` (weekly target hours, current week's actual vs target).
- **`/endurance?sub=trends`**: weekly volume bar chart (last 12 weeks), Z2 minutes line, HR drift trend, intensity distribution stacked bar. **CTL/ATL/TSB chart deferred** until 6 weeks of post-launch data.

Files:
- `app/endurance/page.tsx` (server, SSR-hydrate)
- `app/endurance/_sub/ActivitiesSubPill.tsx`, `_sub/PlanSubPill.tsx`, `_sub/TrendsSubPill.tsx`
- `components/endurance/EnduranceClient.tsx`
- `components/endurance/ActivityRow.tsx`
- `lib/query/fetchers/enduranceActivities.ts` (server + browser variants per convention)
- `lib/query/hooks/useEnduranceActivities.ts`
- `lib/query/keys.ts` — add `endurance.*` keys

### `/profile` — endurance setup section

New section component `components/profile/EnduranceSetupSection.tsx`:

- **Strava connection card**: status (connected / disconnected), last sync timestamp, "Connect Strava" / "Disconnect" button. Connect button → `/api/strava/auth`.
- **Threshold HR input** (numeric, calibration source dropdown: "manual" / "lab test" / "estimated from data" — only "manual" actually does anything in Phase 1).
- **Phase selector** (radio: aerobic_base / build / race_prep / taper / off_season — Phase 1 ship locks to aerobic_base, others greyed with "Available in Phase 2" tooltip).
- **Discipline selector** (radio: cycling / running / triathlon — same Phase 1 lock to cycling).
- **Weekly volume target** (slider, 1-15 hours, Carter-recommended default = 5h for current phase).

API: `POST /api/profile/endurance-profile` mirrors `POST /api/profile/nutrition-overrides` shape. Partial updates: undefined keeps, null clears, value sets. Writes to `athlete_profile_documents.endurance_profile`.

### Morning brief — endurance block

When today's `endurance_session_plan[weekday]` is not `'rest'`, brief assembler [lib/morning/brief/index.ts](../../lib/morning/brief/) adds an endurance block to the `MorningBriefCard.ui` jsonb:

```ts
type EnduranceBlock = {
  type: 'endurance';
  session_type: 'z2_ride' | 'z2_run' | 'tempo' | 'intervals' | 'long' | 'brick';
  sport: 'cycling' | 'running' | 'swimming';
  duration_min: number;
  hr_cap?: number;
  hr_target_range?: [number, number];
  description: string;
  intent: string;       // e.g., "Fat oxidation + mitochondrial density"
};
```

Rendered by a new `EnduranceBriefBlock.tsx` component, placed in the brief between session block and macros block. Visual treatment: heart icon, HR target prominent, duration as a chip.

If today is BOTH a strength day AND an endurance day, both blocks render. Stack order: strength first (heavier session), endurance second.

### `/coach?tab=dashboard` — Endurance theme card

New theme card in Peter's dashboard. Position: after Plan adherence, before Goal distance (logical grouping with execution metrics).

Theme card shows: severity chip, headline (e.g., "Z2 volume on track — 4.5/5h this week"), 2-3 key facts, deep-link to `/endurance?sub=trends`.

### `/coach/trends` — Endurance section

Add fourth section ([app/coach/trends/page.tsx](../../app/coach/trends/) `?section=performance|composition|cross|endurance`):

- Weekly volume trend (Recharts line)
- Intensity distribution (stacked bar over 12 weeks)
- HR drift / aerobic decoupling (lower = fitter)
- Sport breakdown (in Phase 2 / triathlon: 3-color stacked bar)

Composer [lib/coach/trends/compose-endurance.ts](../../lib/coach/trends/) added to orchestrator. Section state in URL `?section=endurance`.

### Bottom navigation

`/endurance` added to `BottomNav.tsx`. Tab order: Home / Meal / Coach / **Endurance** / Trends. Endurance icon: heart-with-arrows (or similar — design choice). Tab fits since `/strength` was already collapsed into `/coach` sub-pill.

Or: keep current tab count and stuff `/endurance` under `/coach?tab=endurance` similar to how Peter's dashboard is `/coach?tab=dashboard`. **Recommended:** dedicated `/endurance` top-level tab, because the page has 3 sub-pills and Carter-driven prescriptions — too much weight for a coach sub-tab.

## Phase 1 deliverable scope

Concretely buildable in this spec's plan:

**Data:**
- Migration `0038_endurance_pillar.sql` (table + columns + aggregation function)
- `lib/data/types.ts` updates (`EnduranceActivity`, `EnduranceProfile`, `EnduranceSessionPlan`, `EnduranceFocus`)

**Integration:**
- `lib/strava/{client,oauth,ingest}.ts` and `lib/strava/types.ts`
- `app/api/strava/{auth,callback,sync,backfill,webhook,disconnect}/route.ts`
- `scripts/strava-subscribe-webhook.mjs`

**Coach:**
- `lib/coach/endurance/{compose-z2-base,tss,hr-zones,training-load}.ts`
- `lib/coach/endurance/types.ts`
- `lib/coach/tools.ts` — 7 new tools, partition assignments, HMAC actions for propose/commit
- `lib/coach/chat-stream.ts` — `PERSIST_RESULT_TOOLS` + `modeAllowsTool` updates
- `lib/coach/snapshot.ts` — endurance blocks
- `lib/coach/system-prompts.ts` — CARTER_BASE, NORA_BASE, REMI_BASE, PETER_BASE updates
- `lib/coach/peter-dashboard/compose-endurance.ts` + orchestrator hook + link-themes update
- `lib/coach/proactive/check-endurance-volume-spike.ts` + cron route registration
- `lib/coach/interference/check-interference.ts` (light rule + seam)
- `lib/coach/adherence.ts` updates (endurance adherence pass + `endurance_status` field)

**UI:**
- `app/endurance/page.tsx` + sub-pills
- `components/endurance/{EnduranceClient,ActivityRow}.tsx`
- `components/profile/EnduranceSetupSection.tsx`
- `components/morning/EnduranceBriefBlock.tsx` + brief assembler integration
- `components/coach/PeterDashboardClient.tsx` — Endurance theme card
- `app/coach/trends/` — Endurance section
- `components/layout/BottomNav.tsx` — `/endurance` tab
- `lib/query/fetchers/enduranceActivities.ts` + `lib/query/hooks/useEnduranceActivities.ts` + `lib/query/keys.ts`

**Cron:**
- `vercel.json` — `/api/strava/sync` at 09:00 UTC daily

**Scripts:**
- `scripts/strava-subscribe-webhook.mjs` — one-shot webhook registration
- `scripts/audit-endurance-ingest.mjs` — verify `daily_logs.endurance_*` matches `sum_endurance_for_day` for last 30 days

**Env vars (`.env.example` + Vercel):**
- `STRAVA_CLIENT_ID`
- `STRAVA_CLIENT_SECRET`
- `STRAVA_VERIFY_TOKEN` (random 32-char, for webhook subscription validation)
- `STRAVA_WEBHOOK_CALLBACK_URL` (e.g., `https://health-app-delta-ruby.vercel.app/api/strava/webhook`)

## Phase 2+ deferred scope

Explicitly NOT in Phase 1:

- **Triathlon phase composers** (`compose-build`, `compose-race-prep`, `compose-taper`)
- **Brick workouts** in the planner
- **Swim metrics** (CSS, SWOLF, pool/OWS distinction)
- **Power-meter TSS** (formula module is ready, swap on ingest is one branch)
- **Formal interference autoregulation rules** in `lib/coach/interference/`
- **TrainingPeaks integration** (read prescriptions, write Carter prescriptions)
- **Garmin Connect API integration**
- **CTL/ATL/TSB chart on `/endurance?sub=trends`** (math is ready, chart waits for ~6 weeks of data)
- **HR drift / aerobic decoupling chart**
- **Aerobic threshold auto-detection** from data (vs manual entry)
- **Coach Felix split** — separate endurance specialist coach
- **Race calendar** (target races + automatic taper trigger)
- **Sport-specific intensity distribution** in Peter dashboard (3-color triathlon split)

## Risks & open questions

**Risks:**

1. **Strava partner approval is fast (24-48h typically) but does require app submission with icons + privacy policy URL.** Existing `/privacy` page covers the policy requirement. Icons are a tiny pre-work item; user is creating the app during spec write.

2. **TRIMP-based hrTSS is noisy without a calibrated threshold HR.** Phase 1 ships a "ballpark" load number with a clear "Calibrate threshold HR to enable training-load tracking" CTA on `/profile`. Until calibrated, `tss` is NULL on `endurance_activities` rows and `endurance_load` is NULL on `daily_logs`. Coach prompts handle the NULL case explicitly.

3. **Strava webhook delivery is not 100% reliable.** Mitigation: daily cron `/api/strava/sync` for last 7 days catches misses. Backfill endpoint covers gaps.

4. **WHOOP strain and Strava-derived TSS coexist without reconciliation.** Risk: user sees two "training load" numbers and gets confused. Mitigation: Peter dashboard's Endurance theme explicitly explains the distinction (WHOOP = whole-body autonomic strain, TSS = endurance-specific training load). Snapshot teaches coaches the same.

5. **Adding `/endurance` as a fifth bottom-nav tab.** 5 tabs is the iOS limit but visually crowded on smaller phones. Acceptable for v1; revisit if user finds it cramped. Alternative is folding it as a `/coach?tab=endurance` sub-tab, rejected because endurance has its own 3-sub-pill page and Carter-driven prescriptions.

**Open questions (resolve during plan or first implementation slice):**

1. **Backfill window default.** Strava can return years of history. Sensible default for `/api/strava/backfill` UI button: 90 days (covers training context for coach without overwhelming initial seed). Full history available via `?since=YYYY-MM-DD`.

2. **Z2 prescription default volume.** Carter's `propose_endurance_week` default for `aerobic_base` phase: 4 rides × 75min = 5h/wk OR 5 rides × 60min = 5h/wk? Pick during prescription engine implementation; both work; 4×75 has less workout-management overhead.

3. **HR cap calculation default.** Two options when user hasn't manually set the HR cap: (a) `threshold_hr × 0.83` (Coggan Z2 upper); (b) `180 - age` (Maffetone MAF). Both have research support. Phase 1 default to Coggan because we already have threshold_hr as the calibration anchor; expose Maffetone as alternative in `/profile` if user prefers.

4. **Brief block on long-bike days.** If user does a 4-hour ride and it overlaps with morning brief generation time, brief generation might fire before Strava webhook delivers the activity. Brief is regenerated on-demand from `/coach`? No — brief is one-per-day. Decision: brief reflects prescribed plan, not actual. Adherence chip on tomorrow's brief covers "did you do it" retrospectively. No special handling needed.

5. **Concurrent strength and endurance day fueling.** When today's plan has both lift + endurance, Nora's fueling recommendation needs to know order (lift first vs endurance first). Phase 1: assume user lifts in AM, rides PM. Phase 2 surface a per-day order preference.

## Migration order

1. `supabase/migrations/0038_endurance_pillar.sql` — table + daily_logs columns + athlete_profile_documents.endurance_profile + training_weeks.endurance_session_plan + training_blocks.endurance_focus + sum_endurance_for_day function

Migration numbering follows from 0037 (block_outcomes). No parallel arc reserves 0038 on the current branch list.

## Audit plan

After implementation:

- `AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-endurance-ingest.mjs` — verifies for each date in the last 30 days that `daily_logs.endurance_load` equals `sum_endurance_for_day(user_id, date).tss_sum` and `daily_logs.endurance_minutes` equals the `duration_s/60` sum. Catches webhook misses, computation drift, or stale `daily_logs` writes.

- Manual coach smoke test: ask Carter "what's my endurance plan this week?" — verify he reads `endurance_session_plan` from `training_weeks` and doesn't fabricate.

- Manual smoke: complete a Strava ride, verify webhook fires, `endurance_activities` row appears within 60s, `daily_logs` columns update, `/endurance?sub=activities` shows the new row, morning brief tomorrow shows correct adherence chip.

## Success criteria

- Strava OAuth completes, webhook subscription active, recent activity ingest works end-to-end.
- `/endurance` page renders activities, plan, trends.
- `/profile` endurance setup writes valid `endurance_profile`.
- Carter prescribes a Z2 week via `propose_endurance_week` / `commit_endurance_week`, week persists, brief picks up the prescription.
- TSS computed correctly for ingested activities with calibrated threshold_hr.
- Peter dashboard surfaces Endurance theme; severity grading visibly responds to weekly volume changes.
- Audit script passes (zero drift across 30-day window).
- No regressions in existing strength / nutrition / recovery surfaces.
