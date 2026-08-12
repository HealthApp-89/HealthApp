# Fused strain — cardiovascular + mechanical daily load

**Date:** 2026-08-12
**Status:** design approved, ready for planning
**Replaces:** the Edwards-TRIMP strain derivation in [lib/coach/garmin/derive-strain.ts](../../../lib/coach/garmin/derive-strain.ts)

## Problem

`daily_logs.strain` reads far too low, and reads *lowest* on exactly the days the
athlete trains hardest. On 2026-08-10 he moved 19,913 kg — the highest tonnage in
the dataset — and the day scored **5.22**. Comparable sessions under WHOOP scored
16–19. On 2026-08-01 he walked 6,603 steps and the day scored **0.00**.

Three independent causes, measured against live data:

1. **The 50%-HRmax floor discards most of the day.** Edwards TRIMP assigns zone
   weight 0 below 50% HRmax — 91.5 bpm at his Tanaka-estimated HRmax of 183. His
   all-day mean HR runs 57–70. On 17 of the last 21 days, **>96% of samples scored
   exactly zero**; on 2026-08-01, all 720 did.

2. **2-minute sampling cannot see lifting.** The ingested all-day HR stream is
   exactly 720 samples/day and is not densified during activity. A 45-minute
   session yields ~22 samples, and HR falls between sets, so most land in Z0/Z1.
   For 2026-08-11 the watch's own activity file recorded **max HR 168**; the
   all-day stream we ingest peaked at **120** the same day.

3. **The log map saturates before the scale does.** `strain = 5·ln(1+0.04·TRIMP)`
   needs TRIMP 587 to reach 16 and 1,489 to reach 18. The observed 98th percentile
   is 410 → 14.28. The top of the 0–21 scale is unreachable.

Distribution comparison — Garmin era (71 d) vs the clean WHOOP window (Apr–May, 61 d):

| percentile | WHOOP | Garmin-derived |
|---|---|---|
| p10 | 1.51 | 0.74 |
| p50 | 5.35 | 5.49 |
| p90 | **14.37** | **11.03** |
| p98 | 15.88 | 14.28 |

The median is well calibrated. The failure is at both tails: hard days undershoot
by ~3 points, easy days collapse to zero.

### A note on the existing calibration claim

[derive-strain.ts:9](../../../lib/coach/garmin/derive-strain.ts#L9) claims
`RMSE 1.89 over 27 days` from a grid-search fit against WHOOP. This is **not
reproducible from the database**: every June overlap day now fits the formula with
RMSE exactly 0.000, because Garmin's own values were written over June's
`daily_logs.strain` when the movement/energy cluster cut over. The WHOOP ground
truth for that window is gone. Only April–May survives as clean reference — which
is why *Calibration and backfill* makes freezing it a hard precondition.

## Goal

One number, 0–21, in `daily_logs.strain`, that rises when the athlete trains hard
**by any modality** — and that stays comparable over time, across sensor changes,
so trends remain readable.

Consistency over WHOOP parity: minor absolute differences from WHOOP do not
matter. A break in the series does.

## The model

Three additive load terms through one saturating curve:

```
load   = baseline_trimp          // all-day HR, outside activity windows
       + activity_trimp          // per-activity HR, densest series available
       + w × mechanical_load     // logger working sets

strain = min(21, A · ln(1 + k · load))
```

### Provisional constants, and the refit that finalises them

The exploratory fit used a **two-term** form, because the probe pulled activity HR
for the calibration window but not all-day HR:

```
strain = min(21, 3.5 + 4.5 · ln(1 + 0.0706 · (activity_trimp + 0.00795 · mechanical)))
```

— i.e. baseline was a fixed **+3.5 strain constant**, not a load term. That form
scores every rest day 3.50 while the actual rest days scatter 0.91–9.61, which is
precisely the collapse-to-a-constant failure the baseline term exists to fix.

`A = 4.5`, `k = 0.0706`, `w = 0.00795` are therefore **provisional**. `w` under
that fit means **1 TRIMP unit ≈ 126 kg of tonnage**.

The three-term form above is the design. Its constants are refit during
implementation (*Calibration and backfill*, step 2), once its step 3 has
backfilled all-day HR for the
calibration window — verified available (`2026-04-15` returns 717 samples). The
refit is expected to lower `A`'s intercept role and improve rest-day accuracy;
the audit threshold under *Verification* is set with that headroom.

### Why all three terms

Candidate models under the provisional two-term form, RMSE against 61 labelled
days (27 strength-activity days of which 25 carry tonnage, 2 cycling, 32 rest):

| model | inputs | RMSE |
|---|---|---|
| cardio only, from 1 s activity HR | HR | 1.81 |
| tonnage only | logger | 2.57 |
| Garmin's own `activityTrainingLoad` + tonnage | HR + logger | 1.72 |
| **cardio TRIMP + w × tonnage, one curve** | **HR + logger** | **1.56** |

Neither term alone suffices. Garmin's own derived load is *worse* than our TRIMP,
so `activityTrainingLoad` / `aerobicTrainingEffect` / `anaerobicTrainingEffect`
are stored as metadata and **never used as model inputs**.

Representative fits:

| date | session | actual | model |
|---|---|---|---|
| 2026-05-18 | 16,499 kg | 16.25 | 15.84 |
| 2026-05-11 | 14,768 kg | 15.88 | 15.27 |
| 2026-04-24 | 10,238 kg | 14.44 | 13.73 |
| 2026-04-15 | 81 min road bike | 14.32 | 14.92 |
| 2026-04-22 | 41-set light day | 6.26 | 7.29 |

### Cardio term: Banister, not Edwards

Banister TRIMP over interval `i`:

```
HRr   = clamp((bpm − hrRest) / (hrMax − hrRest), 0, 1)
trimp = Σ minutes_i × HRr_i × 0.64 · e^(1.92 · HRr_i)
```

Scores elevation above *resting*, continuously, with no zone cliff. Ordinary
living lands ~2–4 instead of 0. Both `banisterTrimp` and `edwardsTrimp` already
exist in [derive-strain.ts](../../../lib/coach/garmin/derive-strain.ts) and are
reused unchanged; only the caller changes.

`hrRest` comes from the day's `resting_hr` (fallback 50, as today). `hrMax` stays
the Tanaka estimate `208 − 0.7·age` = 183. Observed max across the window is 182,
so the estimate is sound; refining it from observed peaks is out of scope.

### Baseline term excludes activity windows

The all-day 2-minute stream and any activity stream cover the same wall-clock
during a session. Summing both double-counts. Samples falling inside a retained
activity's `[started_at, started_at + duration]` are excluded from the baseline
term. This is the only interaction between the two cardio terms.

### Mechanical term: tonnage, refined but scale-preserving

Base quantity is `Σ (kg × reps)` over **non-warmup** sets, which is what the fit
was performed on.

Raw tonnage treats a 100 kg deadlift set and a 25 kg curl set as equivalent. Two
refinements, both **normalised so they redistribute between exercises without
moving the aggregate scale** — this is what keeps the fitted `w` valid.

The refinements are multiplied together and the **product** is clamped to
0.85–1.15, not each factor separately. Clamping factors individually leaves the
product free to reach [0.85³, 1.15³] = [0.61, 1.52] — a ±52% swing rather than
the ±15% the band is meant to express, and a heavy deadlift set taken past its
RIR target reaches 1.40 on its own. The per-session bound is what makes `w`,
fitted on raw tonnage, still meaningful for any individual day.

- **Muscle-mass weighting** from `getExerciseMuscles().primary`, reusing the
  existing large/small classification in
  [session-structure](../../../lib/coach/session-structure/).
- **Relative intensity** — load as a fraction of the exercise's current e1RM,
  falling back to neutral when no e1RM reference exists. The reference is the
  best Brzycki e1RM among the session's own non-warmup 1–12 rep sets rather than
  [bestComparisonValue](../../../lib/coach/e1rm.ts)'s history lookup: a
  per-exercise history query would make the backfill quadratic, and since this
  is a bounded redistribution factor the two agree on the day's top set anyway.

Normalisation is explicit: the weighted sum is rescaled so that replaying the 25
calibration sessions reproduces their mean raw tonnage. The *Verification*
audit asserts
this.

**RIR cannot be calibrated, and is therefore bounded.** Per-set RIR arrived in
migration 0045 (July 2026); the April–May calibration sessions came from Strong
CSV and carry none. RIR therefore applies a **bounded ±15% modulation centred on
the block's `rir_target`** — a session at target is unchanged — rather than a
fitted coefficient. Inventing a weight with no labelled data behind it would be
fabrication.

Set count is deliberately **not** an input: it correlates *negatively* with strain
(−0.358) in the calibration window, because high-set days are arms and mobility
with light loads while 19-set days are deadlift days. Load is the driver.

### Why sensor changes do not break the series

The mechanical term is device-independent and dominates on hard days. On
2026-05-18: cardio 75 TRIMP, mechanical 16,499 × 0.00795 = **131** — 64% of load
under the provisional fit. A 25% shift in measured cardio moves that day
15.84 → 16.22 (**+0.38**). On a pure-cardio day the same shift is worth roughly a
point, damped by the log curve. Adding the baseline term at refit lowers the
mechanical share somewhat without changing the conclusion: sensor changes perturb
lifting days by well under a point.

## Hardware context

The athlete's setup during and after this work:

| domain | device | HR |
|---|---|---|
| strength sessions | Garmin CIRQA arm band, activity started manually from Garmin Connect | arm PPG |
| cardio (bike, padel) | Fenix 8 + HRM chest strap | ECG |

All historical data is Fenix-recorded. The design therefore **never branches on
device**: it consumes whatever HR series arrive and records what it received.

Evidence on placement, for the record: chest-strap ECG runs ~1–3 bpm error against
12-lead; wrist PPG during weight training runs 9–15 bpm MAE and 12–30+ on
wrist-flexion movements; upper-arm PPG sits between them, materially better than
wrist because proximal placement suppresses motion artifact. The arm band is
therefore the right sensor for the modality where wrist PPG fails worst.

## Data acquisition

The sidecar ([collector.py](../../../sidecar/garmin/collector.py)) gains an
activity pass per collected day:

- `get_activities_by_date(d, d)` for summaries.
- `get_activity_details(activityId, maxchart=4000, maxpoly=0)` for the HR stream,
  read via `metricDescriptors` → `directTimestamp` / `directHeartRate`.

Posted under a new `activities: [...]` key on the existing payload. **The sidecar
stays derivation-free** — TRIMP is computed app-side, per its existing contract.

Verified available per activity: `activityId`, `startTimeLocal`, `duration`,
`averageHR`, `maxHR`, `hrTimeInZone_1..5`, `activityTrainingLoad`,
`aerobicTrainingEffect`, `anaerobicTrainingEffect`, `differenceBodyBattery`,
`totalSets`, `totalReps`, `deviceId`. HR detail returned 1,164–2,445 points per
activity across the calibration window.

Payload size: ~2,000 points/activity at ~20 bytes → ~40 KB/activity;
`BACKFILL_DAYS=4` with one activity/day is well inside the route's limits. The
ingest route's `maxDuration` stays 30 s; if backfill runs push past it, the
backfill script is the path, not the daily route.

## Storage

### New table `garmin_activities` (migration `0058`)

One row per activity, RLS self-read as with every other table.

| column | notes |
|---|---|
| `user_id`, `external_id` | unique `(user_id, external_id)` |
| `local_date` | day attribution via `profiles.timezone`, per the repo-wide rule |
| `activity_type` | Garmin `typeKey` |
| `started_at`, `duration_s` | |
| `avg_hr`, `max_hr` | |
| `device_id`, `hr_source` | `hr_source` ∈ `wrist \| arm \| chest \| unknown` |
| `hr_sample_count`, `hr_median_gap_s` | what was actually received, not assumed |
| `zone_seconds` jsonb | `hrTimeInZone_1..5` |
| `garmin_load`, `aerobic_te`, `anaerobic_te`, `body_battery_diff` | metadata only, never model inputs |
| `trimp` | derived Banister value |
| `hr_samples` jsonb | raw `[[ts, bpm]]` |
| `superseded_by` | set when dedup drops this row in favour of another |

Storing the raw stream is deliberate: recalibrating later must not require
re-fetching two years of history through an unofficial API.

**Not `endurance_activities`.** That table is Strava-owned with hrTSS semantics and
feeds `daily_logs.endurance_*` for the endurance pillar. Folding Garmin rows in
would double-count every ride present in both services and silently change what
Carter reads.

### `daily_logs` additions

- `hr_sample_density` — median all-day gap in seconds, so a sampling change is
  recorded rather than inferred.

`strain` itself is replaced in place. Every existing consumer — coach snapshot,
[impact.ts](../../../lib/coach/impact.ts), recovery intelligence, trends —
inherits the new number with no changes. `deriveReadiness` does **not** read
strain, so readiness is unaffected.

`garmin_daily.trimp_edwards` / `trimp_banister` stay as shadow columns.

## Activity ↔ session matching

The CIRQA activity is started by hand from Garmin Connect, then the logger session
is started separately, so the two timestamps differ by seconds to minutes. Matching
is **tolerant, never equality**:

> A strength-type activity matches a logger `workouts` row when their
> `[start, end]` intervals overlap **and** their starts are within **30 minutes**.

On a match: the activity's HR stream supplies the session's cardio term, its window
is excluded from the baseline term, and the logger supplies the mechanical term.

Both unmatched cases degrade sensibly:

- **Logger workout, no activity** — the session window (from `workouts.started_at`
  through the last set's `started_at + work_seconds`) is sliced out of the all-day
  stream for the cardio term. Lower density, but the mechanical term dominates
  these days anyway.
- **Activity, no logger workout** — cardio only, no mechanical term. Correct: the
  athlete did something he did not log.

### Cross-device dedup

A 24/7 band will record rides alongside the Fenix. Activities from **different
`device_id`s whose windows overlap** collapse to one, preferring the record with
the better HR source (`chest` > `arm` > `wrist` > `unknown`), then the denser
sample stream. The loser keeps its row with `superseded_by` set — dropped from
computation, retained for audit. `(user_id, external_id)` alone cannot express
this, which is why the rule is window-based.

## Compute module

`lib/coach/strain/` — pure, node-testable under the existing
`lib/**/__tests__/**/*.test.ts` vitest glob:

| file | responsibility |
|---|---|
| `baseline-load.ts` | all-day HR minus retained activity windows → TRIMP |
| `activity-load.ts` | one activity's HR stream → TRIMP |
| `mechanical-load.ts` | logger working sets → tonnage-equivalent |
| `match-sessions.ts` | activity ↔ workout matching + cross-device dedup |
| `compose.ts` | sum → log map → clamp |
| `constants.ts` | the frozen fit, with provenance |

`recomputeStrainForDay(userId, date)` becomes the **single writer** of
`daily_logs.strain`, called from exactly three places:

- `POST /api/ingest/garmin`
- `POST /api/logger/session`
- `DELETE /api/logger/session/[workout_id]`

The logger calls are non-fatal, matching the existing `clearStaleOpeners`
precedent on that route — a strain recompute must never fail a session commit.

Today's number stays partial until the next morning's collector run, since the
watch has not synced. What changes is that committing a session moves it
immediately via the mechanical term, instead of the day reading 0.4 until tomorrow.

## Calibration and backfill

Ordering is a hard constraint. Step 1 must land before step 4 or the ruler dies
with the rows it is made of.

1. **Freeze the labelled set** to `scripts/fixtures/strain-calibration-2026.json`
   — 61 days of `(date, whoop_strain, activity summaries + HR-derived TRIMP,
   tonnage, sets)`, committed to the repo.
2. **Refit under the three-term form and freeze constants** into `constants.ts`
   with provenance comments naming the fixture and the fit date. This supersedes
   the provisional two-term constants quoted above; those are recorded only so the
   refit can be checked against a known starting point. The refit requires
   all-day HR for the calibration window, so in practice step 3's backfill runs
   first for that range and the fit follows.
3. **Backfill `garmin_activities`** from the all-day-HR floor forward. Probed:
   `2026-04-15` returns 717 samples, `2026-03-01` returns 0 — the exact boundary
   is found during implementation. Activity history itself reaches 2024-09.
4. **Recompute `daily_logs.strain`** across that whole range, so the series uses
   one formula end to end.
5. **Jan–Mar 2026 stays untouched** — no all-day HR exists to recompute it. Those
   rows remain WHOOP-legacy. The boundary date is recorded so the trend layer can
   annotate it rather than read a step change as a fitness change.

Backfill runs as a script under the established
`node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local`
pattern, idempotent, with a printed diff and a `--yes` gate.

## Verification

- **Unit tests** per pure module in `lib/coach/strain/__tests__/`. Note the
  repo-wide constraint: vitest is node-environment and scans `lib/**` only, so all
  logic stays out of `.tsx`.
- **`scripts/audit-strain-calibration.mjs`** — replays the frozen fixture through
  the composer and asserts **RMSE ≤ 1.8**, plus the scale-preservation property of
  the mechanical refinements. This is the regression gate: touching the constants,
  the composer, or the muscle/intensity weighting fails it loudly.
- **`scripts/audit-strain-recompute.mjs`** — asserts stored `daily_logs.strain`
  equals a fresh recompute for the last 30 days, catching ingest drift and missed
  recompute triggers.

## Out of scope

- No second UI metric, no cardio/mechanical split in the interface.
- No per-muscle fatigue model.
- No change to `deriveReadiness` (it does not read strain).
- No changes to the Strava/endurance pillar or `endurance_activities`.
- No push notifications.
- No HRmax refinement from observed peaks.
- Sensor-type auto-detection beyond storing `device_id` and a resolved
  `hr_source`; if Garmin does not expose the sensor, the fallback is an explicit
  switch-date on `profiles`, not inference from HR characteristics.

## Open risks

- **CIRQA in-session sampling density is unverified.** If it feeds only the 2-minute
  all-day stream and produces no dense activity record, the cardio term degrades
  toward today's quality on strength days. Mitigated structurally: the mechanical
  term is 64% of load on hard sessions, and 2-minute sampling is adequate for the
  steady efforts (bike, padel) where there is no mechanical term. `hr_sample_density`
  records what actually arrived so the degradation is visible rather than silent.
- **`training_readiness` may be Fenix-only.** `daily_logs.recovery` maps from it
  ([map-metrics.ts:58](../../../lib/coach/garmin/map-metrics.ts#L58)). If CIRQA
  does not report it and the Fenix is worn only for cardio, the recovery column
  goes null on strength days and `deriveReadiness` loses an input. Out of scope
  here; flagged as separate work to resolve before any device change.
- **2026-05-25 is the largest residual** (actual 19.49, model 15.34). Unexplained;
  retained in the fixture rather than dropped, so the audit threshold reflects it.
