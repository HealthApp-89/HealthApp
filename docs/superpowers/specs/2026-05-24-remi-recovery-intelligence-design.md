# Recovery trends view + Remi proactive intelligence + prompt expansion

**Status:** Draft
**Date:** 2026-05-24
**Owner:** Abdelouahed

## Summary

Three surfaces, one coach. Mirrors the Nora arc (`feat/nutrition-trends-nora-intelligence`, merging 2026-05-24) for Remi — the Recovery specialist who today has 3 tools, 1 proactive trigger, and no dedicated visualization surface.

1. **Trends pill (A)** — new sub-pill `Trends` on `/health`, between the existing `Coach` and `Log` pills. 17 recovery-analytics cards across HRV/RHR, sleep architecture, strain×recovery balance, body signals, subjective signals, and mobility.
2. **Proactive intelligence (B)** — 13 new triggers under `lib/coach/proactive/`, all owned by Remi, fired by the existing daily cron. Goes from 1 trigger (`hrv_below_baseline`) to 14.
3. **REMI_BASE prompt expansion (C)** — 13 additions across interpretive thresholds, sleep hygiene prescription menu, illness escalation rules, soreness-vs-pain distinction, trigger-card awareness, and hand-off etiquette refinement.

One shared compute spine. Single small migration (`0031_sleep_start_end.sql`) so WHOOP's sleep onset/offset times back the bedtime-drift trigger and consistency card. Two implementation plans afterward (UI plan + triggers-and-prompt plan), one design.

## Goals

- Give Remi a real visualization surface — currently the Coach pill on `/health` shows today's snapshot only; weekly/monthly recovery trends live nowhere.
- Make Remi proactive on the same signals the trends surface visualizes: HRV chronic depression, sleep debt, recovery streaks, overreach setups, pre-symptomatic illness, recurring soreness, lingering sickness.
- Sharpen Remi's voice: interpretive thresholds (noise vs signal), concrete sleep-hygiene prescriptions, illness escalation rules, DOMS-vs-pain distinction, awareness of his own trigger cards.
- Reuse existing infrastructure: `lib/coach/trends/` payload pattern, `lib/coach/proactive/` cron + dedup, `MetricCard` sparkline, `SubPillNav`, the SSR-hydrate + TanStack Query pattern.

## Non-goals

- New tools in Remi's partition. He keeps `query_daily_logs` (recovery columns), `mark_mobility_done`, `unmark_mobility_done`. Triggers + prompt changes do the lifting.
- Daily "Remi's read" card or weekly recovery review. v1 ships proactive nudges + trends surface only.
- Long-range windows (6mo, 1y). 28d daily + 12w weekly is enough; WHOOP data is dense but visual real estate is not.
- Cross-metric scatter beyond strain-vs-next-day-recovery and HRV-vs-subjective-fatigue. Deferred to a future "Cross" surface.
- Push notifications. Mirrors Nora arc — chat cards only.
- HMAC propose/commit tools for Remi (e.g. "propose deload"). Deload decisions are Peter's lane; Remi flags, Peter executes.
- Mobility cadence prescriptions (3x/week, etc.). Defer to a separate mobility-prescription arc.

## Decisions locked during brainstorm

1. **Pill placement**: new pill `Trends` on `/health`, between `Coach` and `Log`. Not on `/coach/trends` (Peter's territory). `/health` already has header "Remi" — this completes Remi's app surface.
2. **v1 viz scope**: all 17 cards (the ⭐ must-haves and 🔵 v2-candidates from the brainstorm), shipped together. 6 clusters × 1–4 cards each.
3. **v1 trigger scope**: 13 triggers (the ⭐ + 🔵 set), all owned by Remi.
4. **v1 prompt scope**: 13 additions, all written into `REMI_BASE` as a single source of truth.
5. **Schema change**: one small migration `0031_sleep_start_end.sql` adds `daily_logs.sleep_start_at timestamptz`, `sleep_end_at timestamptz`. WHOOP sync extended to populate. Required for `bedtime_drift` trigger + Bedtime/wake consistency card.
6. **Mobility cards**: include the mobility completion streak card in v1, but no new triggers around mobility adherence — feels like nagging without a stronger "why" story.
7. **Co-existence**: keep the existing `hrv_below_baseline` trigger (single-day heads-up) alongside the new `hrv_chronic_depression` (sustained-signal action). Distinct dedup keys. Same speaker (Remi).

## Architecture

### Sub-pill surface — `/health?tab=trends`

```
app/health/page.tsx                          # SUB_TABS gains { key: "trends", label: "Trends" }
components/health/HealthTrendsClient.tsx     # new — TanStack Query consumer, renders 5 sections
components/health/trends/
  ├── HrvAutonomicSection.tsx                # cluster 1: HRV/RHR (4 cards)
  ├── SleepSection.tsx                       # cluster 2: sleep (4 cards)
  ├── StrainRecoverySection.tsx              # cluster 3: strain × recovery (4 cards)
  ├── BodySignalsSection.tsx                 # cluster 4: skin temp, resp rate, spo2 (3 cards)
  ├── SubjectiveSection.tsx                  # cluster 5: soreness, fatigue×sickness, subj vs obj (3 cards)
  └── MobilityCard.tsx                       # cluster 6: 1 card (completion heat-map)
```

5 sections + 1 standalone card, 17 cards total. Each section is a column of cards. Mobile-first, ~1 card per screen row.

### Compute spine — extend `lib/coach/trends/`

Today: `lib/coach/trends/compose-recovery.ts` produces `RecoveryTrend` (HRV / RHR / sleep avgs / recovery / strain — scalars only). It's read by `/coach/trends` (Peter's surface) and is already wired into the existing `hrv_below_baseline` check.

New work:

```
lib/coach/recovery-intelligence/
  ├── compose-recovery-daily.ts        # 28d daily series for HRV, RHR, sleep h, sleep score, deep, REM, strain, recovery
  ├── compose-recovery-weekly.ts       # 12w weekly aggregates (avg, distribution counts)
  ├── compose-sleep-architecture.ts    # 14d daily deep/REM/light breakdown
  ├── compose-sleep-consistency.ts     # 28d bedtime/wake midpoint + SD calc (depends on 0031 migration)
  ├── compose-subjective.ts            # 28d soreness areas matrix, fatigue tier timeline, sickness ticks
  ├── compose-mobility.ts              # 28d mobility completion streak
  └── thresholds.ts                    # All shared thresholds (HRV noise %, sleep debt h, etc.)
```

Each composer is pure: takes `(supabase, userId, today)`, returns a typed payload. No mutation. Shared `thresholds.ts` is the single source of truth between the cards (for reference-band rendering) and the triggers (for fire conditions) — same number, two consumers.

The existing `lib/coach/trends/compose-recovery.ts` stays as-is; the new module is parallel and richer. Both feed the trends payload eventually, but for v1 the recovery-intelligence composers ship a dedicated payload through a new fetcher:

```
lib/query/fetchers/recoveryIntelligence.ts        # SSR + browser fetchers (browser throws — SSR hydrate only, like coachTrends)
lib/query/hooks/useRecoveryIntelligence.ts        # TanStack hook
lib/query/keys.ts                                 # add recoveryIntelligence: { one(userId) }
```

### Proactive triggers — extend `lib/coach/proactive/`

Same primitive as the Nora arc: daily cron at `/api/coach/proactive/check` (already live, `CRON_SECRET`-gated, 11:00 UTC) reads a payload, evaluates each trigger function, writes `chat_messages.kind='proactive_nudge'` rows with `speaker='remi'`. 7-day dedup via `proactive_nudge_dedup` keyed `(user_id, trigger_key, fired_on)`.

New trigger files (one per trigger):

```
lib/coach/proactive/
  ├── check-hrv-chronic.ts             # NEW — sustained HRV depression
  ├── check-rhr-elevated.ts            # NEW
  ├── check-sleep-debt.ts              # NEW
  ├── check-low-recovery-streak.ts     # NEW
  ├── check-strain-recovery.ts         # NEW
  ├── check-skin-temp.ts               # NEW
  ├── check-recurring-soreness.ts      # NEW
  ├── check-sickness-lingering.ts      # NEW
  ├── check-deep-sleep-deficit.ts      # NEW
  ├── check-bedtime-drift.ts           # NEW — depends on migration 0031
  ├── check-respiratory-rate.ts        # NEW
  ├── check-heavy-fatigue.ts           # NEW
  ├── check-post-strain-undersleep.ts  # NEW
  ├── check-hrv.ts                     # EXISTING — keeps firing single-day signal
  └── index.ts                         # TRIGGER_OWNER updated, runProactiveChecks() registers new fns
```

Each check function takes the assembled recovery payload (the new composers' outputs) and returns `ProactiveEvent[]` — same shape as the Nora checks. Render templates live in `lib/coach/proactive/render-card.ts` (extending the existing file with one render function per new trigger).

`TRIGGER_OWNER` in `lib/coach/proactive/index.ts` gets 13 new `'remi'` entries.

### Prompt expansion — `REMI_BASE` in `lib/coach/system-prompts.ts`

Single edit. Adds ~350 words to the existing 230-word prompt. New sections appended in a structured order: interpretive thresholds → sleep hygiene playbook → illness/soreness escalation → trigger-card awareness → hand-off etiquette refinement. Full text in §C.

### Schema migration — `0031_sleep_start_end.sql`

```sql
alter table daily_logs
  add column if not exists sleep_start_at timestamptz,
  add column if not exists sleep_end_at   timestamptz;
```

WHOOP sleep API already returns `start` and `end` per sleep record (`lib/whoop.ts:84–85`). `buildWhoopDayRows` extended to populate. Backfill via `scripts/rekey-whoop.mts --since 2024-01-01 --yes`.

Without this migration: `bedtime_drift` trigger + "Bedtime/wake consistency" card cannot ship. Hard prerequisite. ~10 LoC + a backfill run.

## Section A — The 17 cards in detail

Each card spec: **what / window / chart / source / threshold lines**.

### Cluster 1 — HRV & RHR (autonomic state)

| # | Card | Window | Chart | Source | Thresholds shown |
|---|---|---|---|---|---|
| A1 | **HRV vs baseline** | 28d daily | Line chart + dashed personal baseline + ±1 SD band | `daily_logs.hrv`, `profiles.whoop_baselines.hrv_mean` + `hrv_sd` | Baseline line; ±1 SD band shaded |
| A2 | **RHR vs baseline** | 28d daily | Line + dashed baseline + +5 bpm reference line | `daily_logs.resting_hr`, `profiles.whoop_baselines.resting_hr_mean` | Baseline line; +5 bpm illness/overreach reference |
| A3 | **HRV weekly avg** | 12w bars | Bar chart + baseline line overlay | Derived from `daily_logs.hrv`, weekly windowed | Baseline line |

### Cluster 2 — Sleep architecture & consistency

| # | Card | Window | Chart | Source | Thresholds shown |
|---|---|---|---|---|---|
| A4 | **Sleep hours** | 28d daily | Bar + 7d rolling avg line + target band (7–9h) | `daily_logs.sleep_hours` | Target band 7–9h |
| A5 | **Sleep score vs hours** | 28d | Twin sparklines (score 0–100, hours 0–10) | `daily_logs.sleep_score`, `sleep_hours` | Score reference 70 (meaningful), 60 (action) |
| A6 | **Sleep architecture mix** | 14d daily | Stacked bar: deep / REM / light | `daily_logs.deep_sleep_hours`, `rem_sleep_hours`, `sleep_hours` (light = total − deep − REM) | None — orientation card |
| A7 | **Bedtime/wake consistency** | 28d | Dot plot (y = clock time 18:00–10:00, x = date), two series (bedtime, wake) | `daily_logs.sleep_start_at`, `sleep_end_at` (NEW from 0031) | ±30min reference band around midpoint |

### Cluster 3 — Strain × Recovery balance

| # | Card | Window | Chart | Source | Thresholds shown |
|---|---|---|---|---|---|
| A8 | **Recovery distribution** | 28d | Stacked bar by week: low (<34) / ok (34–66) / high (≥67) day counts | `daily_logs.recovery` | None — distribution view |
| A9 | **Strain : Recovery balance** | 28d | Two lines, dual y-axis (strain 0–21, recovery 0–100) | `daily_logs.strain`, `recovery` | Overreach band shading when both lines diverge unfavorably 5+ days |
| A10 | **Day-of-week strain** | 12w | Bar by weekday (avg strain Mon–Sun) | Derived | Athlete's weekly load shape |
| A11 | **Post-high-strain recovery** | 28d | Scatter (x = yesterday strain, y = today recovery) | Derived | Trend line + ±1 SD |

### Cluster 4 — Body signals (illness / overreach early warning)

| # | Card | Window | Chart | Source | Thresholds shown |
|---|---|---|---|---|---|
| A12 | **Skin temp deviation** | 28d daily | Line + ±0.3°C reference band around personal baseline | `daily_logs.skin_temp_c`, computed personal 28d baseline | ±0.3°C reference; +0.4°C alert line |
| A13 | **Respiratory rate** | 28d daily | Line + dashed personal baseline + +1 bpm reference | `daily_logs.respiratory_rate`, computed personal 28d baseline | +1 bpm reference |

### Cluster 5 — Subjective signals (from checkins)

| # | Card | Window | Chart | Source | Thresholds shown |
|---|---|---|---|---|---|
| A14 | **Soreness heat-map** | 28d | Body-region grid: rows (chest/back/legs/shoulders/arms/core) × cols (days), cell shade = severity (none/mild/sharp) | `checkins.soreness_areas`, `soreness_severity` | None — pattern view |
| A15 | **Fatigue × sickness timeline** | 28d | Stacked timeline: fatigue tier color (none/some/heavy) + sickness ticks | `checkins.fatigue`, `sick`, `sickness_notes` | Sickness streaks highlighted |
| A16 | **Subjective vs objective** | 28d | HRV line + fatigue tier dots overlaid on same axis | `daily_logs.hrv` + `checkins.fatigue` | None — calibration view |

### Cluster 6 — Mobility (Remi's only write surface)

| # | Card | Window | Chart | Source | Thresholds shown |
|---|---|---|---|---|---|
| A17 | **Mobility completion streak** | 28d | Calendar heat-map (4w × 7d grid, filled = mobility done) | `workouts` rows where `type='Mobility'` AND `source='chat'` (written by `mark_mobility_done`, idempotent on `external_id='chat-mobility-${date}'`) | Current streak counter |

(The brainstorm prose said "16 cards" — that was an undercount of the ⭐+🔵 set. True count is 17. The spec is the source of truth.)

## Section B — The 13 triggers in detail

All triggers: `owner = 'remi'`, `dedup_window = 7d`, `payload` shape captures the numeric signal for the render template + chat-history reference.

| # | `trigger_key` | Signal | Threshold | Payload | Deep-link |
|---|---|---|---|---|---|
| B1 | `hrv_chronic_depression` | HRV 7d avg vs personal baseline | ≤ −7% for 5+ of last 7 days | `{ vs_baseline_pct_7d, days_depressed, baseline_30d }` | `/health?tab=trends#hrv-vs-baseline` |
| B2 | `rhr_elevated` | RHR 7d avg vs personal baseline | +5 bpm sustained 5+ days | `{ vs_baseline_bpm_7d, days_elevated, baseline_30d }` | `#rhr-vs-baseline` |
| B3 | `sleep_debt_accumulated` | Σ (8h − actual) over last 7 days | Debt ≥ 5h (avg <7.3h) | `{ debt_hours_7d, avg_hours_7d }` | `#sleep-hours` |
| B4 | `low_recovery_streak` | Recovery <34% (red tier) | 4+ consecutive days | `{ streak_days, avg_recovery_pct }` | `#recovery-distribution` |
| B5 | `strain_recovery_imbalance` | 7d strain avg ≥14 AND 7d recovery avg <40% | Both conditions | `{ strain_avg_7d, recovery_avg_7d }` | `#strain-recovery` |
| B6 | `skin_temp_elevated` | Skin temp vs personal 28d baseline | 3+ consecutive days >+0.4°C | `{ delta_c_avg, days_elevated, baseline_28d }` | `#skin-temp` |
| B7 | `recurring_soreness_area` | Same `soreness_areas` entry | ≥5 of last 14 checkins, severity-weighted (sharp = 2× mild) | `{ area, occurrences, severity_weighted_score }` | `#soreness-heatmap` |
| B8 | `sickness_lingering` | `checkins.sick = true` | 4+ consecutive days | `{ streak_days, latest_notes }` | `#fatigue-sickness` |
| B9 | `deep_sleep_deficit` | 14d avg deep sleep | <1.0h OR <12% of total | `{ avg_deep_h_14d, avg_pct_14d }` | `#sleep-architecture` |
| B10 | `bedtime_drift` | Bedtime SD over last 14d | >75min (requires `sleep_start_at` from migration 0031) | `{ sd_minutes_14d, mean_bedtime_hhmm }` | `#bedtime-consistency` |
| B11 | `respiratory_rate_elevated` | RR vs personal baseline | 3+ days >+1 breath/min | `{ delta_bpm_avg, days_elevated, baseline_28d }` | `#respiratory-rate` |
| B12 | `heavy_fatigue_cluster` | `checkins.fatigue='heavy'` | 3+ of last 7 days | `{ heavy_days_count, dates }` | `#fatigue-sickness` |
| B13 | `post_strain_undersleep` | Day-after-strain ≥15 had sleep <7h | 2+ occurrences in 14d | `{ occurrences, pairs: [{strain_date, strain, sleep_date, sleep_h}] }` | `#sleep-hours` |

### Render template style

Render templates follow the existing `lib/coach/proactive/render-card.ts` pattern: small object with `{ headline, body, deep_link_label, deep_link_href, speaker: 'remi' }`. Body prose is deterministic, with light variant rotation (3 phrasings per trigger, picked by `fired_on` hash for variety).

Example for B1 (`hrv_chronic_depression`):

```ts
{
  headline: "HRV trending below baseline",
  body: "Your 7-day HRV average is 8% below baseline, depressed 5 of the last 7 days. This is a pattern, not a single rough day. Consider a deload week or cut intensity 20–30% for the next 5 days. Want me to flag this to Peter?",
  deep_link_label: "See HRV trend",
  deep_link_href: "/health?tab=trends#hrv-vs-baseline",
  speaker: "remi",
}
```

### Co-existence with existing `hrv_below_baseline` (single-day)

Keep both. `hrv_below_baseline` is the single-day heads-up ("yesterday looked rough"). `hrv_chronic_depression` is the sustained-signal action ("this is real, deload"). Distinct dedup keys (`hrv_below_baseline` vs `hrv_chronic_depression`). They can fire on the same day without conflict — different conversation.

### Multi-fire potential

The maximalist trigger set means on a bad week, Remi could legitimately fire 4–5 cards in a single day (e.g., HRV chronic + RHR elevated + skin temp elevated + sickness lingering). This is intentional — each signal is independently actionable, and the chat UI already groups same-speaker cards. If multi-fire feels noisy in practice, a v2 introduces a "Remi's read" daily-cap card that summarizes the others (similar to how Peter's morning brief consolidates).

## Section C — Full updated `REMI_BASE`

Net additions: ~350 words. Existing identity/scope paragraph kept verbatim; new sections appended.

```
You are Remi, the recovery and sleep specialist on Peter's team. Peter is the Head Coach. The athlete's turn was routed to you because the question is in your lane: day-to-day recovery interpretation, HRV trends vs personal baseline, sleep architecture, training stress vs recovery balance, illness flags, mobility prescription.

Your scope is the athlete's recovery state — what HRV / sleep / strain say about today and the last few days. Peter owns the strategic balance of stress and recovery across blocks.

When you answer:
- Speak in concrete numbers (HRV ms, recovery %, sleep hours, sleep score, strain). Cite specific dates from query_daily_logs results.
- Use the athlete's WHOOP baselines (in the snapshot) to interpret today's numbers — HRV "low" only makes sense relative to their personal 30-day baseline.
- Reply concisely (2-5 sentences for normal questions; longer for analysis).
- For mobility completion signals ("done with my stretches"), call mark_mobility_done.

You can read recovery + sleep columns on daily_logs (hrv, resting_hr, recovery, sleep_*, deep_sleep_hours, rem_sleep_hours, spo2, skin_temp_c, respiratory_rate, strain). You do NOT have access to query_workouts (you read training stress via the strain column on daily_logs) or nutrition or body composition data.

## Interpretive thresholds — noise vs signal

- Day-to-day HRV swings of ±3% are noise. A drop ≥5% off baseline sustained 3+ days is signal. A drop ≥7% sustained 5+ days is action — deload territory.
- RHR ±3 bpm is noise. +5 bpm sustained 5+ days is illness or overreach until proven otherwise. Cross-check with skin temp deviation.
- Sleep score <70 is meaningful, <60 is action. Sleep hours <7 a single night is recoverable. <7 for 5+ nights is debt that compounds.
- Skin temp +0.3°C suspect, +0.5°C sustained = real (illness, hot environment training, or late luteal phase if applicable).
- A single low-recovery day (<34%) is normal noise; 3+ consecutive low-recovery days is a pattern worth surfacing.

## Sleep hygiene — the prescription menu

When sleep score is low and hours are fine, prescribe one concrete fix at a time, not a wall of advice:
- Caffeine cutoff 8 hours pre-bed (caffeine half-life is 5–6h).
- No food 3 hours pre-bed — late food suppresses deep sleep.
- No alcohol on training days — any amount suppresses REM.
- Cool dark room (16–19°C), no screens for the last 30min.
- Bedtime within a 30-minute window every night — consistency matters more than total hours.

Bedtime consistency over 14 days is a real lever: bedtime SD >75min wrecks HRV regardless of total sleep. Surface this when an athlete fixates on "I'm getting 8 hours though."

Morning bright light within 30 min of waking sets that night's melatonin. Late training (<3h before bed) elevates strain into sleep — useful to mention if the strain×recovery trends show a pattern.

## Illness, soreness, and pain

- Sickness 1 day: rest, hydrate, train light or skip — your call as athlete.
- Sickness 3+ days: suggest doctor visit, especially if fever or fatigue dominates. Don't train through fever.
- Pre-symptomatic illness signal (skin temp + RHR both elevated without sick=true): proactively suggest a rest day or Z2 substitute. The body is fighting something.
- General soreness 24–72h after a new stimulus (DOMS) is expected; train through with reduced intensity.
- Sharp localized pain, or soreness in the same spot for 5+ checkins in 14d, is overuse — flag to Carter with an `@Carter` mention and suggest exercise rotation, don't prescribe the rotation yourself.

## Your own trigger cards

When chat history shows a recent `proactive_nudge` from you, reference it directly ("as I flagged Tuesday…") instead of re-explaining the trigger. The athlete already has the card; your job is to extend it, not repeat it.

## Hand-off etiquette

Don't speculate on other lanes — name who can answer:
- `@Peter` for strategic decisions: deload now? change block? skip this week?
- `@Carter` for exercise rotation when recurring soreness is the cause.
- `@Nora` for "is my recovery low because I'm undereating / under-hydrating?"

Your voice: calm, observational. You're the team's pulse-check. You notice patterns before they become problems.
```

## Data shapes

```ts
// lib/coach/recovery-intelligence/types.ts

export type RecoveryDailyPoint = {
  date: string;
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
  sleep_start_at: string | null;  // from migration 0031
  sleep_end_at: string | null;    // from migration 0031
};

export type SubjectivePoint = {
  date: string;
  fatigue: 'none' | 'some' | 'heavy' | null;
  sick: boolean;
  sickness_notes: string | null;
  soreness_areas: string[];
  soreness_severity: 'mild' | 'sharp' | null;
  mobility_done: boolean; // derived: exists row in `workouts` with type='Mobility' AND source='chat' for this date
};

export type RecoveryIntelligencePayload = {
  schema_version: 1;
  window_days_daily: 28;
  window_weeks_long: 12;
  daily: RecoveryDailyPoint[];           // last 28 days
  weekly: WeeklyAggregate[];             // last 12 weeks
  subjective: SubjectivePoint[];         // last 28 days
  baselines: {
    hrv_mean: number | null;
    hrv_sd: number | null;
    resting_hr_mean: number | null;
    skin_temp_baseline_c: number | null;       // computed personal 28d
    respiratory_rate_baseline_bpm: number | null; // computed personal 28d
  };
  derived: {
    hrv_cv_28d: number | null;
    sleep_debt_7d_hours: number | null;
    bedtime_mean_minutes: number | null;       // null if migration 0031 not yet backfilled
    bedtime_sd_minutes: number | null;         // null if migration 0031 not yet backfilled
    mobility_current_streak_days: number;
    mobility_completion_pct_28d: number;
  };
};
```

## Implementation order

Two implementation plans after this design lands.

### Plan 1 — UI + compute (Trends pill)

1. Migration `0031_sleep_start_end.sql` + WHOOP sync extension + backfill via `scripts/rekey-whoop.mts`.
2. `lib/coach/recovery-intelligence/thresholds.ts` (the shared numbers).
3. `lib/coach/recovery-intelligence/compose-*.ts` (6 composer modules, pure, fully typed).
4. `lib/query/fetchers/recoveryIntelligence.ts` + hook + key registration.
5. `app/health/page.tsx` — add `trends` to `SUB_TABS`, prefetch payload, conditional render.
6. `components/health/HealthTrendsClient.tsx` + 5 section components + 1 mobility card.
7. Recharts cards reuse the existing `MetricCard` sparkline primitive where applicable; new patterns (heat-map, dot-plot, dual-axis) are inline.
8. Audit script `scripts/audit-recovery-intelligence.mjs` — verify composer outputs match raw `daily_logs` aggregations for a sample window.

### Plan 2 — Triggers + prompt

1. 13 `check-*.ts` files under `lib/coach/proactive/` consuming the new payload.
2. `lib/coach/proactive/render-card.ts` extended with 13 render functions.
3. `lib/coach/proactive/index.ts` — `TRIGGER_OWNER` updated, `runProactiveChecks()` registers new functions.
4. `lib/coach/system-prompts.ts` — `REMI_BASE` expanded with the §C text.
5. Audit script `scripts/audit-remi-triggers.mjs` — for the AUDIT_USER_ID, dry-run each new trigger against current data and report would-fire/would-skip with reasons. Mirrors the Nora-arc audit pattern.

Plan 2 depends on Plan 1's composers + payload type — start Plan 2 only when `RecoveryIntelligencePayload` is stable.

## Audit / verification

- **`scripts/audit-recovery-intelligence.mjs`** (new) — for a given `AUDIT_USER_ID`, compose the full payload, sanity-check each derived field against raw `daily_logs` and `checkins` queries. Catches off-by-one window math.
- **`scripts/audit-remi-triggers.mjs`** (new) — dry-run all 14 Remi triggers (13 new + existing `hrv_below_baseline`) against current data. Reports for each: `would_fire | would_dedup | would_skip` with reason. Run after Plan 2 lands, before enabling the cron registration.
- **Manual QA on `/health?tab=trends`** — load the page, verify each of the 17 cards renders without errors against the dev user's data. Document any data-completeness gaps (e.g. user has <14d of `checkins` so subjective cards show empty states).

## Out of scope / future

- **Carter cross-reference**: when `recurring_soreness_area` fires, automatically flag to Carter via a routing handoff. v1 just suggests `@Carter` in prose; v2 wires the structured handoff.
- **Remi propose/commit tools** — e.g. `propose_deload({weeks, intensity_cut_pct})` that Peter or the athlete confirms. Out of scope; Remi flags, Peter executes.
- **Daily "Remi's read" consolidation card** — if multi-fire becomes noisy in practice, a daily-cap card summarizes Remi's signals into one. v2 if needed.
- **Mobility prescription engine** — Remi today only marks completion; doesn't prescribe a routine. Separate arc.
- **Cycle phase tracking** (for users where it applies) — would change skin temp / HRV interpretation. Separate arc, out of scope for single-user app today.
- **Bedtime drift action chips** — e.g. "Lock 23:00 ±15min this week" with an HMAC commit. Out of scope.
- **WHOOP Journal data** (alcohol, caffeine, etc.) — would massively improve sleep-hygiene specificity. Separate ingest arc.
- **Push notifications** for severe triggers (e.g. `sickness_lingering` day 5+). Mirrors Nora arc — deferred across the board.
