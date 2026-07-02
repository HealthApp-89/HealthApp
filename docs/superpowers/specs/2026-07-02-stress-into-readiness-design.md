# Stress into the Readiness Composite — Design

**Date:** 2026-07-02
**Status:** Approved (design) — pending spec review
**Depends on:** the Garmin cutover (`stress_avg` is Garmin-owned on `daily_logs`; shipped 2026-07-02)

## Goal

Add Garmin's all-day **Stress** as a modest, independent term in the single readiness composite (`deriveReadiness`), so the ring/brief reflect yesterday's autonomic load — without double-counting the HRV signal it's partly derived from.

## Context & rationale

`deriveReadiness` ([lib/ui/score.ts](../../../lib/ui/score.ts)) is the ONE readiness computation (dashboard ring + morning brief both call it). Current weights (renormalized over present signals):

| term | weight | notes |
|---|---|---|
| HRV / RHR / sleep_score / deep_sleep | 3 / 3 / 2 / 1 (=9, ~64%) | recovery cluster; feeds `recoverySubScore` → the red-recovery floor |
| morning feel | 3.5 (~25%) | |
| protein / calories / carbs / steps | 0.5 / 0.5 / 0.25 / 0.25 (~11%) | lifestyle, yesterday-sourced |

**Why Stress only (not Body Battery):** Body Battery and Stress are BOTH HRV-derived. The composite already weights HRV heavily, so adding both raw would triple-count the autonomic signal and drown out sleep/nutrition/feel. Of the two, **Stress (yesterday's all-day average) is the one genuinely independent addition** — morning HRV is a ~5-min overnight snapshot and can't see the daytime autonomic load Stress captures. Body Battery is mostly redundant with HRV+sleep and is deferred. Folding in Training Readiness (which already integrates both) was considered and rejected — it leans on Garmin's black box and partially duplicates our transparent HRV/sleep terms.

## Design

### 1. New term in `deriveReadiness`
- **Anchors** (values ascending, scores descending — same shape as `A_RHR`; calm rewards, high stress penalizes; aligned to Garmin's bands ≤25 rest / 26–50 low / 51–75 medium / 76–100 high):
  ```ts
  const A_STRESS: Anchors = [[20, 95], [35, 78], [50, 55], [65, 32], [80, 12]];
  ```
  `scoreFromAnchors` clamps ≤20→95 and ≥80→12.
- **Weight:** `const W_STRESS = 0.75;` — lands stress at ~5% of the composite (0.75 / 14.75 when all present); recovery cluster stays dominant (~61%). Starting value; tunable during the soak.
- **Added via the plain `add()` path, NOT `addRecovery()`** — stress nudges the *score* but is deliberately excluded from `recoverySubScore`, so it can never on its own force the red-recovery floor band. The floor stays purely about overnight physiology (HRV/sleep/RHR).
- **Input:** extend `ReadinessInputs.log`'s `Pick<DailyLog, …>` with `"stress_avg"`; in the composite body add:
  ```ts
  if (log.stress_avg != null) add(scoreFromAnchors(log.stress_avg, A_STRESS), W_STRESS);
  ```
- **Graceful degradation:** when `stress_avg` is null the term renormalizes out (existing behavior of the weighted mean). No change to `MIN_WEIGHT_FOR_SCORE`.

### 2. Timing — yesterday-sourced (both blend sites)
Stress is an all-day metric (not in the overnight today-pass), so it lands on *yesterday's* complete row — the correct "yesterday's load" timing, alongside steps/strain/calories. Both `deriveReadiness` callers build a today-recovery + yesterday-load blend; add an explicit yesterday override (needed because `...today` spreads today's null `stress_avg`):
- **Brief:** `readinessLog()` ([lib/morning/brief/assembler.ts:203](../../../lib/morning/brief/assembler.ts)) — add `stress_avg: y?.stress_avg ?? null,`.
- **Ring:** `scoreLog` ([components/dashboard/TodayClient.tsx:102](../../../components/dashboard/TodayClient.tsx)) — add `stress_avg: prevLog?.stress_avg ?? null,`, and add `"stress"` to the `fellBackToPrior` set when `prevLog.stress_avg != null` (so the impact chip reads "yest. —").

### 3. Impact breakdown (visibility — separable)
`impact.ts` ([lib/coach/impact.ts](../../../lib/coach/impact.ts)) is a standalone qualitative classifier (not derived from the weights; it doesn't need to sum to the score). Add a `"stress"` `ImpactKey` + `classifyStress(value)` so the ring's drill-down and the coach can cite "stress elevated yesterday — dragging." Bands: ≤33 positive (calm), 34–60 neutral, >60 negative. Color positive `#30d158`-family / negative red / neutral grey, matching the module's convention. This is a display enhancement; the score is correct without it, so it is its own task and can be cut if it grows.

## Testing

`scripts/audit-readiness-score.mjs` gains fixtures:
- calm stress (e.g. 25) lifts the score vs. the same day with stress absent;
- high stress (e.g. 75) drags the score below the stress-absent baseline;
- `stress_avg = null` → identical score to pre-change (renormalizes out);
- **stress does NOT change `recoverySubScore` or the band via the floor** — a red-recovery day with calm stress stays band-capped; a green-recovery day with high stress is nudged in score but the floor logic is untouched.

Verify: `npm run typecheck` + `npm run build` + `node … scripts/audit-readiness-score.mjs`.

## Non-goals / deferred

- **Body Battery** in the composite — redundant with HRV+sleep; revisit only if the soak shows the ring still misses drained days.
- **Training Readiness** fold-in — rejected (black box + overlap).
- **Stress in the red-recovery floor** — rejected (floor is overnight physiology only).
- **Re-tune** `W_STRESS` + `A_STRESS` on felt-vs-ring data during the same soak window as the recovery-floor calibration (~mid-to-late July).
