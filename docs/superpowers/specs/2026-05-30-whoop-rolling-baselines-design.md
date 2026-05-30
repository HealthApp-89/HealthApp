# WHOOP Rolling Baselines — Design

**Date:** 2026-05-30
**Status:** Approved (awaiting implementation plan)
**Owner:** single-user app, Abdelouahed
**Relation to other work:** Foundational fix for the entire recovery-intelligence layer. Affects HRV/RHR/recovery/sleep/resp-rate-based comparisons in the morning brief band derivation, every HRV proactive trigger, recovery intelligence thresholds, session debrief autoregulation, Peter's dashboard, the weekly review's recovery section, the trends chart anchors, and the snapshot prefix sent to every coach. No other spec touches the baseline source; this is the only place this work is centralized.

## Problem

`profiles.whoop_baselines` is a static jsonb blob, manually seeded once on 2026-04-24 and never auto-updated. The seed shape captures a snapshot of WHOOP's own UI at that moment:

```jsonc
{
  "hrv_6mo_avg": 33,
  "hrv_prior_6mo_avg": 41,
  "hrv_peak_monthly": 45,
  "hrv_peak_period": "Oct 2025",
  // … rhr, recovery, sleep, resp_rate equivalents
  "recorded_at": "2026-04-24"
}
```

Two structural problems:

1. **The baseline is contaminated by a prior training modality.** During the period these means were drawn from, the athlete was doing ~12 hours/week of endurance work. HRV is highly modality-dependent: endurance training elevates resting HRV via vagal tone; strength training has minimal effect on resting HRV (Plews & Laursen 2014; Buchheit et al. 2012). The 33 ms recent mean and the 41 ms prior mean are both biased upward relative to what's normal for the athlete on the current strength-focused program. Every consumer that asks "is today abnormal?" against these numbers gets the wrong answer.

2. **The baseline never updates.** Even ignoring the modality shift, freezing a baseline against a 2026-04-24 snapshot means seasonal drift, training adaptation, age effects, and any future modality changes silently corrupt every downstream comparison. WHOOP itself uses a trailing ~30-day window for this exact reason.

Concretely, the failure modes today:

- **False HRV-suppression nudges.** [check-hrv.ts](../../lib/coach/proactive/check-hrv.ts) and [check-hrv-chronic.ts](../../lib/coach/proactive/check-hrv-chronic.ts) compare current HRV to the static 33 ms mean. When the athlete's current strength-program HRV settles in the high 20s / low 30s, the trigger fires constantly, training the user to ignore it.
- **Misleading recovery band derivation.** [assembler.ts](../../lib/morning/brief/assembler.ts) `deriveReadinessBand` reads the baseline HRV; a contaminated baseline biases the band toward "low" days that aren't really low for the current program.
- **Wrong autoregulation deload triggers.** [compose-autoregulation.ts](../../lib/coach/session-debrief/compose-autoregulation.ts) reads HRV/RHR baselines to decide whether to deload — same contamination, same wrong decisions.
- **Coach narration cites a stale anchor.** [snapshot.ts](../../lib/coach/snapshot.ts) sends `BASELINES: {whoop_baselines jsonb}` into every coach's prompt prefix. Peter, Carter, and Remi all narrate against the 33 ms anchor and reach conclusions that don't match what the athlete observes day-to-day.

## Goals

1. **Trailing 30-day rolling baseline** for five WHOOP metrics: HRV, RHR, recovery score, sleep performance, respiratory rate. Mirrors WHOOP's own published methodology for their internal comparison anchor.

2. **Deterministic daily refresh** via a `CRON_SECRET`-gated route at 08:30 UTC, immediately after the existing WHOOP sync at 08:00 UTC. Idempotent upserts.

3. **Cold-start safety.** During the first 14 days of available data, baseline is `null` and consumers suppress baseline-relative comparisons (status `'establishing'`). From day 14 to day 29, baseline is computed but consumers caveat (status `'partial'`). From day 30 onward, normal operation (status `'stable'`).

4. **SD-aware noise gating.** Each baseline ships with its 30-day standard deviation. Consumers treat deviations within ±0.5 × SD as noise, not signal — the Hopkins "smallest worthwhile change" concept. This is the most opinionated change and is expected to noticeably reduce false-positive nudges.

5. **Historical context preserved.** The existing static keys (`hrv_6mo_avg`, `hrv_prior_6mo_avg`, `hrv_peak_monthly`, `hrv_peak_period`, and the equivalents for the other 4 metrics) are not deleted. They are recharacterized as biographical context. Coach prompts are taught the distinction explicitly: rolling 30d drives "is today abnormal?"; historical anchors drive "where did I come from?".

6. **Manual recalibration surface.** A new "Baselines" section on `/profile` displays the current rolling 30d for each metric (mean ± SD, days in window, status chip) and exposes a "Recalibrate now" button that invokes the same compute path the cron uses. Useful after long gaps where WHOOP data was missing.

7. **Single source of truth for all consumers.** Every site currently reading the static `whoop_baselines.hrv_6mo_avg` (or equivalent) is updated to prefer `rolling_30d.hrv.mean` with a defensive fallback to the legacy field. Eleven call sites identified — list in §7.

8. **No AI in the baseline path.** Pure SQL aggregation + arithmetic. AI consumes the output via the snapshot prefix.

## Non-goals

- **Per-block reset.** The training_blocks abstraction is conceptually appealing as a baseline boundary, but a simple 30d rolling window adapts to modality shifts within ~30 days anyway — adding a block-boundary reset would couple this work to the prescription engine for no measurable additional accuracy.
- **EWMA / exponentially-weighted recency.** Considered and deferred. A simple arithmetic mean over 30 days is easier to reason about and explain in coach narration. If SD reveals too much noise post-launch, EWMA is a layered v2.
- **Time-series storage of baselines.** Yesterday's baseline is uninteresting; we don't need history. A jsonb extension on `profiles.whoop_baselines` is enough. If a future feature wants "your baseline drifted over the last quarter," that's a new table at that point.
- **Editing the historical anchor keys via UI.** Read-only on `/profile` for now; the seed stays as-is.
- **Touching skin_temp / SpO2.** Both use intraday delta vs the night's sleep itself — no baseline involved, no work needed.

## Architecture

### New module: `lib/whoop/baselines.ts`

Exports two functions:

```typescript
type BaselineStatus = 'establishing' | 'partial' | 'stable';

type MetricBaseline = {
  mean: number | null;     // null when status='establishing'
  sd: number | null;       // null when status='establishing'
  days: number;            // count of non-null observations in window
  status: BaselineStatus;
};

type Rolling30dBaselines = {
  computed_at: string;     // ISO8601
  hrv: MetricBaseline;
  rhr: MetricBaseline;
  recovery: MetricBaseline;
  sleep_performance: MetricBaseline;
  resp_rate: MetricBaseline;
};

export async function computeWhoopBaselines(
  userId: string,
  asOf: Date
): Promise<Rolling30dBaselines>;

export async function persistBaselines(
  userId: string,
  baselines: Rolling30dBaselines
): Promise<void>;
```

`computeWhoopBaselines` queries `daily_logs` for the 30 days ending at `asOf` (exclusive of `asOf` itself — today's data may be incomplete), computes mean and SD for each metric, and assigns status:

- `establishing` if `days < 14`
- `partial` if `14 ≤ days < 30`
- `stable` if `days ≥ 30` (note: requires 30 *days with data*, not 30 *calendar days* — gaps in sync don't artificially demote status)

`persistBaselines` reads the existing `profiles.whoop_baselines`, merges the new `rolling_30d` key (preserving all historical keys), and writes back. Service-role client only — RLS-bypassing because the cron runs without a user session.

Column mapping (from `daily_logs`):

| Baseline metric | Source column |
|---|---|
| `hrv` | `hrv` |
| `rhr` | `resting_hr` |
| `recovery` | `recovery` |
| `sleep_performance` | `sleep_score` |
| `resp_rate` | `respiratory_rate` |

The `rolling_30d.sleep_performance` and `rolling_30d.resp_rate` key names are kept (rather than renaming to match `sleep_score` / `respiratory_rate`) to stay consistent with the legacy seed keys (`sleep_performance_6mo_avg`, `resp_rate_6mo_avg`) and with WHOOP's own UI vocabulary.

### New route: `app/api/whoop/baselines/sync/route.ts`

`POST` handler, `CRON_SECRET`-gated via `Authorization: Bearer ${CRON_SECRET}` (matches the pattern in `app/api/whoop/sync/route.ts`). Iterates all users with WHOOP tokens — same loop pattern the sync route uses — so the cron stays correct if the app ever serves more than one user.

```typescript
export async function POST(req: Request) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }
  const supabase = createSupabaseServiceRoleClient();
  const { data: tokenRows } = await supabase
    .from('whoop_tokens')
    .select('user_id');

  const results: Record<string, unknown> = {};
  for (const { user_id } of tokenRows ?? []) {
    try {
      const baselines = await computeWhoopBaselines(user_id, new Date());
      await persistBaselines(user_id, baselines);
      results[user_id] = { ok: true, status: baselines };
    } catch (e) {
      results[user_id] = { ok: false, error: String(e) };
    }
  }
  return Response.json(results);
}
```

Registered in `vercel.json` as a daily cron at `30 8 * * *` (08:30 UTC, 30 minutes after the existing `0 8 * * *` WHOOP sync). Sequential, not parallel — sync must land first so the baseline reads include today's row if it arrived on time.

### New route: `app/api/profile/baselines/recalibrate/route.ts`

`POST` handler, session-authenticated (RLS-respecting, not service-role). Invokes the same compute path. Used by the "Recalibrate now" button on `/profile`. Returns the fresh `rolling_30d` block in the response so the UI can update without a refetch.

### Storage shape

Extends the existing `profiles.whoop_baselines` jsonb. No migration required — jsonb is permissive. New structure:

```jsonc
{
  // Legacy keys (preserved as biographical context — see §5)
  "hrv_6mo_avg": 33,
  "hrv_prior_6mo_avg": 41,
  "hrv_peak_monthly": 45,
  "hrv_peak_period": "Oct 2025",
  "rhr_6mo_avg": 58,
  // ... etc — all existing keys retained verbatim

  // New: this work
  "rolling_30d": {
    "computed_at": "2026-05-30T08:30:00Z",
    "hrv":               { "mean": 31.2, "sd": 4.1, "days": 30, "status": "stable" },
    "rhr":               { "mean": 59.4, "sd": 2.8, "days": 30, "status": "stable" },
    "recovery":          { "mean": 58,   "sd": 14,  "days": 30, "status": "stable" },
    "sleep_performance": { "mean": 76,   "sd": 9,   "days": 28, "status": "partial" },
    "resp_rate":         { "mean": 17.6, "sd": 0.4, "days": 30, "status": "stable" }
  }
}
```

### TypeScript types

Extend `lib/data/types.ts` to type the new shape:

```typescript
export type BaselineStatus = 'establishing' | 'partial' | 'stable';

export type MetricBaseline = {
  mean: number | null;
  sd: number | null;
  days: number;
  status: BaselineStatus;
};

export type Rolling30dBaselines = {
  computed_at: string;
  hrv: MetricBaseline;
  rhr: MetricBaseline;
  recovery: MetricBaseline;
  sleep_performance: MetricBaseline;
  resp_rate: MetricBaseline;
};

export type WhoopBaselinesJsonb = {
  // Legacy keys (optional — may be missing for users seeded after this work lands)
  hrv_6mo_avg?: number;
  hrv_prior_6mo_avg?: number;
  hrv_peak_monthly?: number;
  hrv_peak_period?: string;
  rhr_6mo_avg?: number;
  rhr_prior_6mo_avg?: number;
  rhr_best_monthly?: number;
  rhr_best_period?: string;
  recovery_6mo_avg?: number;
  recovery_prior_6mo_avg?: number;
  resp_rate_6mo_avg?: number;
  sleep_performance_6mo_avg?: number;
  sleep_performance_prior_6mo_avg?: number;
  // … (full list mirrors current seed)

  // New
  rolling_30d?: Rolling30dBaselines;
};
```

## Cold-start behavior

The 30d window is sparse on day 1 of a reset (e.g., a new user, or a user reconnecting WHOOP after a long gap). Policy:

| days | status | consumer behavior |
|---|---|---|
| < 14 | `establishing` | All baseline-relative comparisons suppressed. Cards display "Establishing baseline · N/14 days" instead of a delta chip. Snapshot prefix tells Peter "rolling 30d not yet established; do not cite a baseline." Proactive triggers don't fire. |
| 14–29 | `partial` | Baseline computed and used normally, but snapshot prefix appends "baseline still stabilizing (N/30 days)." Proactive triggers fire. Recovery intel uses computed baseline. |
| ≥ 30 | `stable` | Normal operation, no caveats. |

For the immediate migration: the athlete already has months of WHOOP data in `daily_logs`, so on first run the 30d window will be fully populated. `status` will be `'stable'` from day 1. The cold-start logic exists to handle future gaps and any subsequent user.

## SD-aware noise gating ("smallest worthwhile change")

The Hopkins/Buchheit SWC concept: a daily HRV reading that differs from baseline mean by less than 0.5 × SD is statistical noise, not signal. Adopted across all baseline-relative comparisons:

```typescript
function isMeaningfulDeviation(
  today: number,
  baseline: MetricBaseline
): boolean {
  if (baseline.mean === null || baseline.sd === null) return false;
  return Math.abs(today - baseline.mean) > 0.5 * baseline.sd;
}
```

Applied in:

- **Proactive HRV triggers** ([check-hrv.ts](../../lib/coach/proactive/check-hrv.ts), [check-hrv-chronic.ts](../../lib/coach/proactive/check-hrv-chronic.ts)) — only fire when today's HRV is below `baseline.mean - 0.5 × baseline.sd`.
- **Recovery intelligence thresholds** ([recovery-intelligence/index.ts](../../lib/coach/recovery-intelligence/index.ts)) — current band-shift thresholds become SD-relative rather than absolute.
- **Session debrief autoregulation** ([compose-autoregulation.ts](../../lib/coach/session-debrief/compose-autoregulation.ts)) — deload triggers gated by SD.

Expected effect: significant reduction in false-positive nudges, particularly on the HRV side where day-to-day variability is naturally high.

## Historical anchor retention

The legacy keys are not deleted. They are recharacterized:

| Question | Source |
|---|---|
| "Is today abnormal?" | `rolling_30d.{metric}.mean` (new) |
| "How does this week compare to last week?" | `daily_logs` rolling 7d vs `rolling_30d` (new) |
| "Where did I come from?" | `hrv_peak_monthly` / `hrv_peak_period` / `hrv_prior_6mo_avg` (legacy, biographical) |

Coach prompt updates (added to `PETER_BASE`, `CARTER_BASE`, `REMI_BASE`, and the plan-builder narrator prompt):

> Your `BASELINES` block now includes a `rolling_30d` section (trailing 30-day mean and SD for HRV/RHR/recovery/sleep performance/respiratory rate) and a set of historical anchor fields (`hrv_6mo_avg`, `hrv_peak_monthly`, etc.). Use `rolling_30d` for any "is today abnormal?" framing — it reflects the athlete's current training modality. Use the historical anchors only when explicitly narrating where the athlete came from (e.g., "your endurance-phase peak was 45 ms in Oct 2025") — they are biographical context, not a current comparison target. Do not cite the legacy `*_6mo_avg` figures as "your baseline."

## UI surface

New "Baselines" section on `/profile`, rendered by a new client component `components/profile/BaselinesSection.tsx`. Fetches via the existing `useProfile` hook (already selects `whoop_baselines`).

Layout:

```
┌─────────────────────────────────────────────────┐
│ Rolling 30-day baselines       [Recalibrate now]│
│ Updated 2026-05-30 08:30 UTC                    │
├─────────────────────────────────────────────────┤
│ HRV               31.2 ± 4.1 ms      30/30 ✓    │
│ Resting HR        59.4 ± 2.8 bpm     30/30 ✓    │
│ Recovery score    58 ± 14            30/30 ✓    │
│ Sleep performance 76 ± 9 %           28/30 ●    │
│ Respiratory rate  17.6 ± 0.4 rpm     30/30 ✓    │
├─────────────────────────────────────────────────┤
│ ▾ Historical anchors (biographical context)     │
│   HRV peak: 45 ms (Oct 2025)                    │
│   HRV 6mo avg: 33 ms                            │
│   HRV prior 6mo avg: 41 ms                      │
│   … (rest of legacy keys, collapsed by default) │
└─────────────────────────────────────────────────┘
```

Status icons: `✓` stable, `●` partial, `…` establishing. The "Recalibrate now" button POSTs to `/api/profile/baselines/recalibrate`, optimistically updates, and rolls back on error. Disabled state during in-flight.

The historical anchors subsection is collapsed by default — it's labeled as biographical context, present for transparency but not the primary surface.

## Consumer migration

Every site reading `whoop_baselines.hrv` (or the implicit `hrv_6mo_avg`) gets updated. Eleven call sites:

| File | Today | After |
|---|---|---|
| [recovery-intelligence/index.ts](../../lib/coach/recovery-intelligence/index.ts) | reads `hrv_6mo_avg`, `rhr_6mo_avg` | reads `rolling_30d.hrv.mean`, `rolling_30d.rhr.mean`; gates with SD |
| [proactive/check-hrv.ts](../../lib/coach/proactive/check-hrv.ts) | acute HRV drop vs static baseline | acute drop vs `rolling_30d.hrv.mean - 0.5×sd` |
| [proactive/check-hrv-chronic.ts](../../lib/coach/proactive/check-hrv-chronic.ts) | chronic HRV depression vs static baseline | chronic vs `rolling_30d.hrv.mean - 0.5×sd` over 7d |
| [proactive/check-skin-temp.ts](../../lib/coach/proactive/check-skin-temp.ts) | reads `resp_rate_6mo_avg` for the skin-temp+resp combo trigger | reads `rolling_30d.resp_rate.mean`; SD-gated |
| [session-debrief/compose-autoregulation.ts](../../lib/coach/session-debrief/compose-autoregulation.ts) | deload trigger vs static HRV/RHR baseline | deload vs `rolling_30d.*.mean ± 0.5×sd` |
| [snapshot.ts](../../lib/coach/snapshot.ts) | sends full `whoop_baselines` jsonb | sends same jsonb (now richer); prompt teaches which keys mean what |
| [trends/compose-recovery.ts](../../lib/coach/trends/compose-recovery.ts) | chart anchor line = static HRV baseline | anchor line = `rolling_30d.hrv.mean`; legend updated |
| [morning/brief/assembler.ts](../../lib/morning/brief/assembler.ts) | `deriveReadinessBand` reads static HRV baseline | reads `rolling_30d.hrv.mean`; cold-start returns `band='unknown'` |
| [morning/brief/data-sources.ts](../../lib/morning/brief/data-sources.ts) | selects `whoop_baselines` (whole blob) | unchanged (whole blob still needed for biographical context in advice prompt) |
| [peter-dashboard/compose-fatigue.ts](../../lib/coach/peter-dashboard/compose-fatigue.ts) | reads static HRV baseline | reads `rolling_30d.hrv.mean` |

The weekly review reads baselines transitively via [trends/compose-recovery.ts](../../lib/coach/trends/compose-recovery.ts) (called from [weekly-review/compose-trends.ts](../../lib/coach/weekly-review/compose-trends.ts)) — fixing the trends composer carries through to the weekly review §4 with no additional change.

Each consumer also imports and uses `isMeaningfulDeviation()` from `lib/whoop/baselines.ts` for SD-aware gating.

Fallback policy at each site: `rolling_30d?.hrv?.mean ?? hrv_6mo_avg ?? null`. If even the legacy is null, skip the baseline-relative comparison. This makes the migration safe even if the cron hasn't run yet on first deploy.

## Cron registration

[vercel.json](../../vercel.json):

```json
{
  "crons": [
    { "path": "/api/whoop/sync",            "schedule": "0 8 * * *" },
    { "path": "/api/whoop/baselines/sync",  "schedule": "30 8 * * *" }
  ]
}
```

30-minute offset chosen because the WHOOP sync at 08:00 typically completes in well under 5 minutes, but 30 minutes leaves comfortable headroom if WHOOP's API is slow that morning.

## Audit script

New script `scripts/audit-rolling-baselines.mjs`. Read-only. Set `AUDIT_USER_ID`. Verifies:

1. `profiles.whoop_baselines.rolling_30d` exists and has all 5 metric keys.
2. Each metric's `days` field matches a re-query of the underlying `daily_logs` window (no off-by-one in the 30d window).
3. Each metric's `mean` matches a fresh arithmetic mean of the same window (no aggregation drift).
4. `computed_at` is within the last 26 hours (cron is running).
5. Status assignment is consistent with `days` (establishing/partial/stable thresholds).
6. SD calculation matches a fresh `stddev` over the window.

Run via:

```bash
AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs \
  --experimental-strip-types --env-file=.env.local \
  scripts/audit-rolling-baselines.mjs
```

## Migrations

None. The jsonb is permissive — adding the `rolling_30d` key is a pure write. The first cron invocation populates it; until then, all consumers fall back to the legacy keys (or `null` where legacy is missing).

If a future change wants to enforce shape on the jsonb, a CHECK constraint can be added at that point.

## Rollout

1. Ship the module + cron + route + types + audit script.
2. Manually invoke the cron once via curl to populate `rolling_30d` on day 1.
3. Run the audit script to verify shape and arithmetic.
4. Ship the consumer migrations in a second commit (one PR for safety). Each consumer is independently safe due to the fallback policy in §7.
5. Ship the `/profile` UI surface third. Pure read-side, no risk.
6. Update PETER_BASE / CARTER_BASE / REMI_BASE prompts in a fourth commit. AI behavior change only.

If any step misbehaves, the previous step is the safe rollback point — each step is independently revertible without breaking the next.

## Observability

The first week post-rollout, watch:

- **Proactive nudge fire rate.** Expected to drop noticeably for HRV-based triggers (the SD gating + corrected baseline together should kill the false positives).
- **Recovery band distribution.** Expected to shift away from a "low"-skewed distribution toward a more balanced split.
- **Coach narration accuracy.** Spot-check via chat that Peter/Carter/Remi cite `rolling_30d` values when discussing today vs baseline, and only cite `hrv_peak_monthly` etc. when explicitly narrating history.

No new dashboard for this — chat history and the `/coach` surface are the observation channels.

## Risk

The main risk is that the new SD-gated thresholds suppress a real signal. Mitigation: SD gating is layered on top of the existing absolute thresholds where present, not replacing them. A genuinely large deviation (>0.5 × SD AND below the prior absolute threshold) still fires. Only borderline cases get filtered.

Secondary risk: cron failure leaves `rolling_30d.computed_at` stale. The `/profile` UI surfaces `computed_at` prominently so the user notices if it stops updating. The audit script's check #4 (computed_at within 26 hours) catches this systematically.

## Open questions

None. All decisions are taken; this is implementation-ready.
