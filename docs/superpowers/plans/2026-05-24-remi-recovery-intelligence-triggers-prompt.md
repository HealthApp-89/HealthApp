# Remi Recovery Intelligence — Proactive Triggers + Prompt Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship 13 new proactive triggers under Remi's ownership (going from 1 to 14 total), wire them into the existing daily cron, and expand `REMI_BASE` with interpretive thresholds, sleep hygiene playbook, illness/soreness escalation rules, trigger-card awareness, and hand-off etiquette.

**Architecture:** Each new check is a pure function consuming the `RecoveryIntelligencePayload` produced in Plan 1. The cron route computes both payloads (the existing `CoachTrendsPayload` for Nora/Carter checks AND the new `RecoveryIntelligencePayload` for Remi). The orchestrator `runProactiveChecks` accepts both and dispatches each check to the right input. Render templates extend the existing `render-card.ts` with one render-fn per trigger. `REMI_BASE` gets a single source-of-truth expansion in `lib/coach/system-prompts.ts`.

**Tech Stack:** Same as Plan 1. Verification: `npm run typecheck` + the dedicated audit script at the end + manual cron dry-run.

**Spec:** [docs/superpowers/specs/2026-05-24-remi-recovery-intelligence-design.md](../specs/2026-05-24-remi-recovery-intelligence-design.md)

**Prereq:** Plan 1 complete (`RecoveryIntelligencePayload` + `generateRecoveryIntelligence` exist and are typed). Plan 2 depends on the payload shape being stable.

---

## File Structure

**New files:**
```
lib/coach/proactive/check-hrv-chronic.ts
lib/coach/proactive/check-rhr-elevated.ts
lib/coach/proactive/check-sleep-debt.ts
lib/coach/proactive/check-low-recovery-streak.ts
lib/coach/proactive/check-strain-recovery.ts
lib/coach/proactive/check-skin-temp.ts
lib/coach/proactive/check-recurring-soreness.ts
lib/coach/proactive/check-sickness-lingering.ts
lib/coach/proactive/check-deep-sleep-deficit.ts
lib/coach/proactive/check-bedtime-drift.ts
lib/coach/proactive/check-respiratory-rate.ts
lib/coach/proactive/check-heavy-fatigue.ts
lib/coach/proactive/check-post-strain-undersleep.ts
scripts/audit-remi-triggers.mjs
```

**Modified files:**
```
lib/coach/proactive/index.ts        # TRIGGER_OWNER += 13 entries; runProactiveChecks accepts recovery payload
lib/coach/proactive/render-card.ts  # +13 render functions
app/api/coach/proactive/check/route.ts  # compute recovery payload + pass to orchestrator
lib/coach/system-prompts.ts         # REMI_BASE expansion
```

---

## Task 1: Orchestrator signature — accept recovery payload

**Files:**
- Modify: `lib/coach/proactive/index.ts`
- Modify: `app/api/coach/proactive/check/route.ts`

- [ ] **Step 1: Update `runProactiveChecks` signature**

In `lib/coach/proactive/index.ts`, find:

```ts
export async function runProactiveChecks(args: {
  supabase: SupabaseClient;
  userId: string;
  trends: CoachTrendsPayload;
  dry_run?: boolean;
}): Promise<ProactiveRunResult> {
  const { supabase, userId, trends, dry_run } = args;
```

Replace with:

```ts
export async function runProactiveChecks(args: {
  supabase: SupabaseClient;
  userId: string;
  trends: CoachTrendsPayload;
  recoveryIntelligence: RecoveryIntelligencePayload;
  dry_run?: boolean;
}): Promise<ProactiveRunResult> {
  const { supabase, userId, trends, recoveryIntelligence, dry_run } = args;
```

Add the import near the top:

```ts
import type { RecoveryIntelligencePayload } from "@/lib/coach/recovery-intelligence/types";
```

- [ ] **Step 2: Update the cron route to compute both payloads**

In `app/api/coach/proactive/check/route.ts`, find:

```ts
let trends;
try {
  trends = await generateCoachTrends({ supabase: sb, userId, today });
} catch (err) {
```

Replace the entire trends-compute block with parallel compute of both payloads:

```ts
let trends;
let recoveryIntelligence;
try {
  [trends, recoveryIntelligence] = await Promise.all([
    generateCoachTrends({ supabase: sb, userId, today }),
    generateRecoveryIntelligence({ supabase: sb, userId, today }),
  ]);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  return NextResponse.json(
    { error: "trends compute failed", detail: msg },
    { status: 500 },
  );
}
```

Find the `runProactiveChecks({ supabase: sb, userId, trends })` call and replace with:

```ts
result = await runProactiveChecks({ supabase: sb, userId, trends, recoveryIntelligence });
```

Add the import at the top:

```ts
import { generateRecoveryIntelligence } from "@/lib/coach/recovery-intelligence";
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```
Expected: no errors. The added parameter is unused for now (no new checks wired yet) but the signature is in place for Tasks 2–14.

- [ ] **Step 4: Commit**

```bash
git add lib/coach/proactive/index.ts app/api/coach/proactive/check/route.ts
git commit -m "feat(remi): proactive cron threads RecoveryIntelligencePayload"
```

---

## Task 2: `hrv_chronic_depression` check

**Files:**
- Create: `lib/coach/proactive/check-hrv-chronic.ts`

- [ ] **Step 1: Write the check**

```ts
// lib/coach/proactive/check-hrv-chronic.ts
//
// Fires when 5+ of the last 7 days have HRV ≥7% below the 30d baseline.
// Distinct from the existing `hrv_below_baseline` (single-day −5% via 4w
// avg). This one is the sustained-signal "action" sibling.

import type { ProactiveEvent } from "@/lib/data/types";
import type { RecoveryIntelligencePayload } from "@/lib/coach/recovery-intelligence/types";
import {
  HRV_CHRONIC_PCT, HRV_CHRONIC_MIN_DAYS, HRV_CHRONIC_OF_LAST_DAYS,
} from "@/lib/coach/recovery-intelligence/thresholds";

export function checkHrvChronic(p: RecoveryIntelligencePayload): ProactiveEvent[] {
  const baseline = p.baselines.hrv_mean;
  if (baseline == null || baseline <= 0) return [];

  const last7 = p.daily.slice(-HRV_CHRONIC_OF_LAST_DAYS);
  const depressed = last7.filter(
    (d) => d.hrv != null && (d.hrv - baseline) / baseline <= HRV_CHRONIC_PCT,
  );
  if (depressed.length < HRV_CHRONIC_MIN_DAYS) return [];

  return [{
    trigger_type: "hrv_chronic_depression",
    trigger_key: "hrv_chronic_depression",
    payload: {
      vs_baseline_pct_7d: p.derived.hrv_vs_baseline_pct_7d,
      avg_7d: p.derived.hrv_avg_7d,
      baseline_30d: baseline,
      days_depressed: depressed.length,
    },
  }];
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck && \
git add lib/coach/proactive/check-hrv-chronic.ts && \
git commit -m "feat(remi): check-hrv-chronic — 5-of-7 sustained signal"
```

---

## Task 3: `rhr_elevated` check

**Files:**
- Create: `lib/coach/proactive/check-rhr-elevated.ts`

- [ ] **Step 1: Write the check**

```ts
// lib/coach/proactive/check-rhr-elevated.ts
//
// Fires when 5+ of the last 7 days have RHR ≥+5 bpm vs the 30d baseline.
// First clear illness/overreach signal — often precedes symptoms by 24-48h.

import type { ProactiveEvent } from "@/lib/data/types";
import type { RecoveryIntelligencePayload } from "@/lib/coach/recovery-intelligence/types";
import {
  RHR_ELEVATED_BPM, RHR_ELEVATED_MIN_DAYS, RHR_ELEVATED_OF_LAST_DAYS,
} from "@/lib/coach/recovery-intelligence/thresholds";

export function checkRhrElevated(p: RecoveryIntelligencePayload): ProactiveEvent[] {
  const baseline = p.baselines.resting_hr_mean;
  if (baseline == null) return [];

  const last7 = p.daily.slice(-RHR_ELEVATED_OF_LAST_DAYS);
  const elevated = last7.filter(
    (d) => d.resting_hr != null && d.resting_hr - baseline >= RHR_ELEVATED_BPM,
  );
  if (elevated.length < RHR_ELEVATED_MIN_DAYS) return [];

  return [{
    trigger_type: "rhr_elevated",
    trigger_key: "rhr_elevated",
    payload: {
      vs_baseline_bpm_7d: p.derived.rhr_vs_baseline_bpm_7d,
      avg_7d: p.derived.rhr_avg_7d,
      baseline_30d: baseline,
      days_elevated: elevated.length,
    },
  }];
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck && \
git add lib/coach/proactive/check-rhr-elevated.ts && \
git commit -m "feat(remi): check-rhr-elevated — 5-of-7 +5 bpm illness flag"
```

---

## Task 4: `sleep_debt_accumulated` check

**Files:**
- Create: `lib/coach/proactive/check-sleep-debt.ts`

- [ ] **Step 1: Write the check**

```ts
// lib/coach/proactive/check-sleep-debt.ts
//
// Fires when 7-day sleep debt (Σ max(0, 8 − actual)) ≥ 5 hours.
// Picks up both "many short nights" and "one zero-sleep crisis" patterns.

import type { ProactiveEvent } from "@/lib/data/types";
import type { RecoveryIntelligencePayload } from "@/lib/coach/recovery-intelligence/types";
import { SLEEP_DEBT_HOURS } from "@/lib/coach/recovery-intelligence/thresholds";

export function checkSleepDebt(p: RecoveryIntelligencePayload): ProactiveEvent[] {
  const debt = p.derived.sleep_debt_7d_hours;
  if (debt == null || debt < SLEEP_DEBT_HOURS) return [];

  const last7 = p.daily.slice(-7).map((d) => d.sleep_hours).filter((v): v is number => v != null);
  const avg = last7.length === 0 ? null : last7.reduce((a, b) => a + b, 0) / last7.length;

  return [{
    trigger_type: "sleep_debt_accumulated",
    trigger_key: "sleep_debt_accumulated",
    payload: { debt_hours_7d: debt, avg_hours_7d: avg },
  }];
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck && \
git add lib/coach/proactive/check-sleep-debt.ts && \
git commit -m "feat(remi): check-sleep-debt — 7d cumulative threshold"
```

---

## Task 5: `low_recovery_streak` check

**Files:**
- Create: `lib/coach/proactive/check-low-recovery-streak.ts`

- [ ] **Step 1: Write the check**

```ts
// lib/coach/proactive/check-low-recovery-streak.ts
//
// Fires when recovery has been <34% for 4+ consecutive days ending today.
// Single low-recovery days are noise; 4+ in a row is a pattern.

import type { ProactiveEvent } from "@/lib/data/types";
import type { RecoveryIntelligencePayload } from "@/lib/coach/recovery-intelligence/types";
import {
  RECOVERY_LOW_TIER, LOW_RECOVERY_STREAK_DAYS,
} from "@/lib/coach/recovery-intelligence/thresholds";

export function checkLowRecoveryStreak(p: RecoveryIntelligencePayload): ProactiveEvent[] {
  // Walk backward from today, count consecutive low days.
  let streak = 0;
  const sum: number[] = [];
  for (let i = p.daily.length - 1; i >= 0; i--) {
    const r = p.daily[i].recovery;
    if (r == null) break;
    if (r >= RECOVERY_LOW_TIER) break;
    streak++;
    sum.push(r);
  }
  if (streak < LOW_RECOVERY_STREAK_DAYS) return [];

  const avg = sum.reduce((a, b) => a + b, 0) / sum.length;
  return [{
    trigger_type: "low_recovery_streak",
    trigger_key: "low_recovery_streak",
    payload: { streak_days: streak, avg_recovery_pct: avg },
  }];
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck && \
git add lib/coach/proactive/check-low-recovery-streak.ts && \
git commit -m "feat(remi): check-low-recovery-streak — 4+ consecutive red days"
```

---

## Task 6: `strain_recovery_imbalance` check

**Files:**
- Create: `lib/coach/proactive/check-strain-recovery.ts`

- [ ] **Step 1: Write the check**

```ts
// lib/coach/proactive/check-strain-recovery.ts
//
// Fires when 7d avg strain ≥14 AND 7d avg recovery <40%. Classic
// overreach setup — high load + low body-readiness.

import type { ProactiveEvent } from "@/lib/data/types";
import type { RecoveryIntelligencePayload } from "@/lib/coach/recovery-intelligence/types";
import {
  STRAIN_HIGH_AVG_7D, RECOVERY_LOW_AVG_7D,
} from "@/lib/coach/recovery-intelligence/thresholds";

export function checkStrainRecovery(p: RecoveryIntelligencePayload): ProactiveEvent[] {
  const strain = p.derived.strain_avg_7d;
  const recovery = p.derived.recovery_avg_7d;
  if (strain == null || recovery == null) return [];
  if (strain < STRAIN_HIGH_AVG_7D || recovery >= RECOVERY_LOW_AVG_7D) return [];

  return [{
    trigger_type: "strain_recovery_imbalance",
    trigger_key: "strain_recovery_imbalance",
    payload: { strain_avg_7d: strain, recovery_avg_7d: recovery },
  }];
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck && \
git add lib/coach/proactive/check-strain-recovery.ts && \
git commit -m "feat(remi): check-strain-recovery — overreach setup"
```

---

## Task 7: `skin_temp_elevated` check

**Files:**
- Create: `lib/coach/proactive/check-skin-temp.ts`

- [ ] **Step 1: Write the check**

```ts
// lib/coach/proactive/check-skin-temp.ts
//
// Fires when skin temp is >+0.4°C above the personal 28d baseline for
// 3+ consecutive days ending today. Pre-symptomatic illness signal.

import type { ProactiveEvent } from "@/lib/data/types";
import type { RecoveryIntelligencePayload } from "@/lib/coach/recovery-intelligence/types";
import {
  SKIN_TEMP_DELTA_C, SKIN_TEMP_SUSTAINED_DAYS,
} from "@/lib/coach/recovery-intelligence/thresholds";

export function checkSkinTemp(p: RecoveryIntelligencePayload): ProactiveEvent[] {
  const baseline = p.baselines.skin_temp_baseline_c;
  if (baseline == null) return [];

  let streak = 0;
  let sum = 0;
  for (let i = p.daily.length - 1; i >= 0; i--) {
    const t = p.daily[i].skin_temp_c;
    if (t == null) break;
    if (t - baseline < SKIN_TEMP_DELTA_C) break;
    streak++;
    sum += t - baseline;
  }
  if (streak < SKIN_TEMP_SUSTAINED_DAYS) return [];

  return [{
    trigger_type: "skin_temp_elevated",
    trigger_key: "skin_temp_elevated",
    payload: {
      delta_c_avg: sum / streak,
      days_elevated: streak,
      baseline_28d: baseline,
    },
  }];
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck && \
git add lib/coach/proactive/check-skin-temp.ts && \
git commit -m "feat(remi): check-skin-temp — pre-symptomatic illness flag"
```

---

## Task 8: `recurring_soreness_area` check

**Files:**
- Create: `lib/coach/proactive/check-recurring-soreness.ts`

- [ ] **Step 1: Write the check**

```ts
// lib/coach/proactive/check-recurring-soreness.ts
//
// Fires when a single body region appears in soreness_areas for 5+ of
// the last 14 checkins. 'sharp' counts double for severity weighting,
// so 3 sharps + 2 mild = 8 score (still triggers).

import type { ProactiveEvent } from "@/lib/data/types";
import type { RecoveryIntelligencePayload } from "@/lib/coach/recovery-intelligence/types";
import {
  RECURRING_SORENESS_OCCURRENCES, RECURRING_SORENESS_WINDOW_DAYS,
} from "@/lib/coach/recovery-intelligence/thresholds";

export function checkRecurringSoreness(p: RecoveryIntelligencePayload): ProactiveEvent[] {
  const window = p.subjective.slice(-RECURRING_SORENESS_WINDOW_DAYS);
  const tallies: Record<string, { count: number; score: number }> = {};
  for (const day of window) {
    const weight = day.soreness_severity === "sharp" ? 2 : 1;
    for (const area of day.soreness_areas) {
      tallies[area] = tallies[area] ?? { count: 0, score: 0 };
      tallies[area].count += 1;
      tallies[area].score += weight;
    }
  }
  const out: ProactiveEvent[] = [];
  for (const [area, { count, score }] of Object.entries(tallies)) {
    if (count >= RECURRING_SORENESS_OCCURRENCES) {
      out.push({
        // Per-area key: 'recurring_soreness_legs', etc. Distinct dedup
        // windows per area so chest + legs can both fire same day.
        trigger_type: "recurring_soreness_area",
        trigger_key: `recurring_soreness_${area}`,
        payload: { area, occurrences: count, severity_weighted_score: score },
      });
    }
  }
  return out;
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck && \
git add lib/coach/proactive/check-recurring-soreness.ts && \
git commit -m "feat(remi): check-recurring-soreness — per-area overuse"
```

---

## Task 9: `sickness_lingering` check

**Files:**
- Create: `lib/coach/proactive/check-sickness-lingering.ts`

- [ ] **Step 1: Write the check**

```ts
// lib/coach/proactive/check-sickness-lingering.ts
//
// Fires when sick=true on 4+ consecutive checkins ending today. This is
// the "consider doctor visit" prompt, not the "you're sick today" prompt.

import type { ProactiveEvent } from "@/lib/data/types";
import type { RecoveryIntelligencePayload } from "@/lib/coach/recovery-intelligence/types";
import { SICKNESS_LINGERING_DAYS } from "@/lib/coach/recovery-intelligence/thresholds";

export function checkSicknessLingering(p: RecoveryIntelligencePayload): ProactiveEvent[] {
  let streak = 0;
  let latest_notes: string | null = null;
  for (let i = p.subjective.length - 1; i >= 0; i--) {
    if (!p.subjective[i].sick) break;
    streak++;
    if (latest_notes === null) latest_notes = p.subjective[i].sickness_notes;
  }
  if (streak < SICKNESS_LINGERING_DAYS) return [];

  return [{
    trigger_type: "sickness_lingering",
    trigger_key: "sickness_lingering",
    payload: { streak_days: streak, latest_notes },
  }];
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck && \
git add lib/coach/proactive/check-sickness-lingering.ts && \
git commit -m "feat(remi): check-sickness-lingering — 4d doctor prompt"
```

---

## Task 10: `deep_sleep_deficit` check

**Files:**
- Create: `lib/coach/proactive/check-deep-sleep-deficit.ts`

- [ ] **Step 1: Write the check**

```ts
// lib/coach/proactive/check-deep-sleep-deficit.ts
//
// Fires when 14d deep-sleep avg is <1.0h OR <12% of total sleep.
// Either condition alone fires; not both required.

import type { ProactiveEvent } from "@/lib/data/types";
import type { RecoveryIntelligencePayload } from "@/lib/coach/recovery-intelligence/types";
import {
  DEEP_SLEEP_DEFICIT_HOURS, DEEP_SLEEP_DEFICIT_PCT, DEEP_SLEEP_WINDOW_DAYS,
} from "@/lib/coach/recovery-intelligence/thresholds";

export function checkDeepSleepDeficit(p: RecoveryIntelligencePayload): ProactiveEvent[] {
  const window = p.sleep_architecture.slice(-DEEP_SLEEP_WINDOW_DAYS);
  const deeps = window.map((w) => w.deep_hours).filter((v): v is number => v != null);
  if (deeps.length < 5) return [];

  const avgDeep = deeps.reduce((a, b) => a + b, 0) / deeps.length;

  const totals = window.map((w) => w.total_hours).filter((v): v is number => v != null);
  const avgTotal = totals.length === 0 ? null : totals.reduce((a, b) => a + b, 0) / totals.length;
  const pct = avgTotal && avgTotal > 0 ? avgDeep / avgTotal : null;

  if (avgDeep >= DEEP_SLEEP_DEFICIT_HOURS && (pct == null || pct >= DEEP_SLEEP_DEFICIT_PCT)) {
    return [];
  }

  return [{
    trigger_type: "deep_sleep_deficit",
    trigger_key: "deep_sleep_deficit",
    payload: { avg_deep_h_14d: avgDeep, avg_pct_14d: pct },
  }];
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck && \
git add lib/coach/proactive/check-deep-sleep-deficit.ts && \
git commit -m "feat(remi): check-deep-sleep-deficit — 14d under-floor"
```

---

## Task 11: `bedtime_drift` check

**Files:**
- Create: `lib/coach/proactive/check-bedtime-drift.ts`

- [ ] **Step 1: Write the check**

```ts
// lib/coach/proactive/check-bedtime-drift.ts
//
// Fires when bedtime SD over the last 14 days is >75 min. Reads the
// derived stat computed by composeSleepConsistency (Plan 1 Task 7).
// Returns no events if migration 0031 hasn't been backfilled yet
// (bedtime_sd_minutes will be null).

import type { ProactiveEvent } from "@/lib/data/types";
import type { RecoveryIntelligencePayload } from "@/lib/coach/recovery-intelligence/types";
import { BEDTIME_DRIFT_SD_MINUTES } from "@/lib/coach/recovery-intelligence/thresholds";

export function checkBedtimeDrift(p: RecoveryIntelligencePayload): ProactiveEvent[] {
  const sd = p.derived.bedtime_sd_minutes;
  const mean = p.derived.bedtime_mean_minutes;
  if (sd == null) return [];
  if (sd < BEDTIME_DRIFT_SD_MINUTES) return [];

  // Convert mean minutes-after-18 back to HH:MM for the payload.
  const meanHHMM = mean == null ? null : (() => {
    const totalMinutes = (18 * 60 + mean) % (24 * 60);
    const hh = Math.floor(totalMinutes / 60);
    const mm = Math.floor(totalMinutes % 60);
    return `${hh.toString().padStart(2, "0")}:${mm.toString().padStart(2, "0")}`;
  })();

  return [{
    trigger_type: "bedtime_drift",
    trigger_key: "bedtime_drift",
    payload: { sd_minutes_14d: sd, mean_bedtime_hhmm: meanHHMM },
  }];
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck && \
git add lib/coach/proactive/check-bedtime-drift.ts && \
git commit -m "feat(remi): check-bedtime-drift — 14d SD >75min"
```

---

## Task 12: `respiratory_rate_elevated` check

**Files:**
- Create: `lib/coach/proactive/check-respiratory-rate.ts`

- [ ] **Step 1: Write the check**

```ts
// lib/coach/proactive/check-respiratory-rate.ts
//
// Fires when RR is >+1 bpm above personal 28d baseline for 3+ days.
// Often the earliest infection signal (precedes skin temp).

import type { ProactiveEvent } from "@/lib/data/types";
import type { RecoveryIntelligencePayload } from "@/lib/coach/recovery-intelligence/types";
import {
  RR_DELTA_BPM, RR_SUSTAINED_DAYS,
} from "@/lib/coach/recovery-intelligence/thresholds";

export function checkRespiratoryRate(p: RecoveryIntelligencePayload): ProactiveEvent[] {
  const baseline = p.baselines.respiratory_rate_baseline_bpm;
  if (baseline == null) return [];

  let streak = 0;
  let sum = 0;
  for (let i = p.daily.length - 1; i >= 0; i--) {
    const r = p.daily[i].respiratory_rate;
    if (r == null) break;
    if (r - baseline < RR_DELTA_BPM) break;
    streak++;
    sum += r - baseline;
  }
  if (streak < RR_SUSTAINED_DAYS) return [];

  return [{
    trigger_type: "respiratory_rate_elevated",
    trigger_key: "respiratory_rate_elevated",
    payload: {
      delta_bpm_avg: sum / streak,
      days_elevated: streak,
      baseline_28d: baseline,
    },
  }];
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck && \
git add lib/coach/proactive/check-respiratory-rate.ts && \
git commit -m "feat(remi): check-respiratory-rate — early infection signal"
```

---

## Task 13: `heavy_fatigue_cluster` check

**Files:**
- Create: `lib/coach/proactive/check-heavy-fatigue.ts`

- [ ] **Step 1: Write the check**

```ts
// lib/coach/proactive/check-heavy-fatigue.ts
//
// Fires when fatigue='heavy' on 3+ of the last 7 checkins. Subjective
// counterpart to the HRV chronic check — catches cases where objective
// numbers are fine but the athlete feels wrecked (life stress, illness
// brewing, sleep quality crash that score didn't catch).

import type { ProactiveEvent } from "@/lib/data/types";
import type { RecoveryIntelligencePayload } from "@/lib/coach/recovery-intelligence/types";
import {
  HEAVY_FATIGUE_DAYS, HEAVY_FATIGUE_WINDOW_DAYS,
} from "@/lib/coach/recovery-intelligence/thresholds";

export function checkHeavyFatigue(p: RecoveryIntelligencePayload): ProactiveEvent[] {
  const window = p.subjective.slice(-HEAVY_FATIGUE_WINDOW_DAYS);
  const heavyDays = window.filter((s) => s.fatigue === "heavy");
  if (heavyDays.length < HEAVY_FATIGUE_DAYS) return [];

  return [{
    trigger_type: "heavy_fatigue_cluster",
    trigger_key: "heavy_fatigue_cluster",
    payload: {
      heavy_days_count: heavyDays.length,
      dates: heavyDays.map((d) => d.date),
    },
  }];
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck && \
git add lib/coach/proactive/check-heavy-fatigue.ts && \
git commit -m "feat(remi): check-heavy-fatigue — subjective cluster"
```

---

## Task 14: `post_strain_undersleep` check

**Files:**
- Create: `lib/coach/proactive/check-post-strain-undersleep.ts`

- [ ] **Step 1: Write the check**

```ts
// lib/coach/proactive/check-post-strain-undersleep.ts
//
// Fires when there are 2+ pairs in the last 14d where day N had strain
// ≥15 and day N+1 had sleep_hours <7. Coaching cue: protect post-hard-day
// sleep.

import type { ProactiveEvent } from "@/lib/data/types";
import type { RecoveryIntelligencePayload } from "@/lib/coach/recovery-intelligence/types";
import {
  POST_STRAIN_THRESHOLD, POST_STRAIN_SLEEP_FLOOR_H,
  POST_STRAIN_OCCURRENCES, POST_STRAIN_WINDOW_DAYS,
} from "@/lib/coach/recovery-intelligence/thresholds";

export function checkPostStrainUndersleep(p: RecoveryIntelligencePayload): ProactiveEvent[] {
  const window = p.daily.slice(-POST_STRAIN_WINDOW_DAYS);
  const pairs: Array<{ strain_date: string; strain: number; sleep_date: string; sleep_h: number }> = [];
  for (let i = 0; i < window.length - 1; i++) {
    const a = window[i];
    const b = window[i + 1];
    if (a.strain == null || b.sleep_hours == null) continue;
    if (a.strain >= POST_STRAIN_THRESHOLD && b.sleep_hours < POST_STRAIN_SLEEP_FLOOR_H) {
      pairs.push({ strain_date: a.date, strain: a.strain, sleep_date: b.date, sleep_h: b.sleep_hours });
    }
  }
  if (pairs.length < POST_STRAIN_OCCURRENCES) return [];

  return [{
    trigger_type: "post_strain_undersleep",
    trigger_key: "post_strain_undersleep",
    payload: { occurrences: pairs.length, pairs },
  }];
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck && \
git add lib/coach/proactive/check-post-strain-undersleep.ts && \
git commit -m "feat(remi): check-post-strain-undersleep — 2+ pairs in 14d"
```

---

## Task 15: Render templates for the 13 triggers

**Files:**
- Modify: `lib/coach/proactive/render-card.ts`

Each render function follows the pattern of the existing `renderHrv` / `renderRecompSuccess`: returns a `ProactiveNudgeCard` with `headline`, `body_md`, `severity`, `deep_link`, `speaker: 'remi'`. Use the existing `pickVariant` helper for deterministic variant rotation.

- [ ] **Step 1: Open `lib/coach/proactive/render-card.ts` and locate the `renderCard` dispatcher at line 59**

The dispatcher uses `switch (event.trigger_type)`. We'll add 13 new cases. Each case calls a new render function defined later in the file.

- [ ] **Step 2: Add the 13 cases to the dispatcher switch**

Find the closing `}` of the dispatcher's switch. Just before it, insert:

```ts
    case "hrv_chronic_depression":     return renderHrvChronic(event, ctx);
    case "rhr_elevated":               return renderRhrElevated(event, ctx);
    case "sleep_debt_accumulated":     return renderSleepDebt(event, ctx);
    case "low_recovery_streak":        return renderLowRecoveryStreak(event, ctx);
    case "strain_recovery_imbalance":  return renderStrainRecovery(event, ctx);
    case "skin_temp_elevated":         return renderSkinTemp(event, ctx);
    case "recurring_soreness_area":    return renderRecurringSoreness(event, ctx);
    case "sickness_lingering":         return renderSicknessLingering(event, ctx);
    case "deep_sleep_deficit":         return renderDeepSleepDeficit(event, ctx);
    case "bedtime_drift":              return renderBedtimeDrift(event, ctx);
    case "respiratory_rate_elevated":  return renderRespiratoryRate(event, ctx);
    case "heavy_fatigue_cluster":      return renderHeavyFatigue(event, ctx);
    case "post_strain_undersleep":     return renderPostStrainUndersleep(event, ctx);
```

- [ ] **Step 3: Add the 13 render functions at the bottom of the file**

```ts
// ── Remi recovery triggers (Plan 2) ─────────────────────────────────────────

function renderHrvChronic(event: ProactiveEvent, ctx?: RenderContext): ProactiveNudgeCard {
  const pct = Math.round(Math.abs((event.payload.vs_baseline_pct_7d as number ?? 0) * 100));
  const days = event.payload.days_depressed as number;
  const variants = [
    `Your 7-day HRV average is ${pct}% below baseline, depressed ${days} of the last 7 days. This is a pattern, not a single rough day. Consider cutting intensity 20–30% for the next 5 days, or take a true rest day.`,
    `${pct}% below baseline ${days} of 7 — sustained. The autonomic system isn't bouncing back. Worth a deload conversation with @Peter, or pull back this week's heaviest session.`,
    `HRV has been depressed ${days} of the last 7 days (${pct}% off baseline). Single-day dips are noise; this many in a row is signal. Time to back off.`,
  ];
  const idx = pickVariant({ userId: ctx?.userId ?? "", triggerKey: event.trigger_key, today: ctx?.today ?? "", count: variants.length });
  return {
    schema_version: 1, trigger_type: "hrv_chronic_depression", trigger_key: event.trigger_key,
    severity: "warn",
    headline: `HRV ${pct}% below baseline · ${days} of 7 days`,
    body_md: variants[idx],
    deep_link: { label: "See HRV trend →", href: "/health?tab=trends#hrv-vs-baseline" },
    speaker: "remi",
  };
}

function renderRhrElevated(event: ProactiveEvent, ctx?: RenderContext): ProactiveNudgeCard {
  const bpm = Math.round(event.payload.vs_baseline_bpm_7d as number);
  const days = event.payload.days_elevated as number;
  const variants = [
    `Resting HR is +${bpm} bpm above your baseline ${days} of the last 7 days. First illness signal — cross-check skin temp; if it's also up, you're likely fighting something. Pull back the next training session.`,
    `RHR has been running +${bpm} bpm for ${days} days. Could be illness brewing, sleep debt, or overreach. Hydrate, sleep early, easy training only until it normalizes.`,
  ];
  const idx = pickVariant({ userId: ctx?.userId ?? "", triggerKey: event.trigger_key, today: ctx?.today ?? "", count: variants.length });
  return {
    schema_version: 1, trigger_type: "rhr_elevated", trigger_key: event.trigger_key,
    severity: "warn",
    headline: `RHR +${bpm} bpm · ${days} of 7 days`,
    body_md: variants[idx],
    deep_link: { label: "See RHR trend →", href: "/health?tab=trends#rhr-vs-baseline" },
    speaker: "remi",
  };
}

function renderSleepDebt(event: ProactiveEvent, ctx?: RenderContext): ProactiveNudgeCard {
  const debt = Math.round((event.payload.debt_hours_7d as number) * 10) / 10;
  const avg = event.payload.avg_hours_7d as number | null;
  const avgStr = avg != null ? `${(Math.round(avg * 10) / 10).toFixed(1)}h` : "—";
  const variants = [
    `${debt}h of sleep debt over the last 7 days (avg ${avgStr}/night). This compounds — HRV and recovery scores will follow. Tonight: bed 30 min earlier than your usual.`,
    `7-day sleep debt is ${debt}h. The body doesn't catch up over the weekend like the brain does. Pick one fix tonight: caffeine off by 14:00, no screens after 22:30, or bed by 22:30.`,
  ];
  const idx = pickVariant({ userId: ctx?.userId ?? "", triggerKey: event.trigger_key, today: ctx?.today ?? "", count: variants.length });
  return {
    schema_version: 1, trigger_type: "sleep_debt_accumulated", trigger_key: event.trigger_key,
    severity: "warn",
    headline: `${debt}h sleep debt · last 7 days`,
    body_md: variants[idx],
    deep_link: { label: "See sleep hours →", href: "/health?tab=trends#sleep-hours" },
    speaker: "remi",
  };
}

function renderLowRecoveryStreak(event: ProactiveEvent, ctx?: RenderContext): ProactiveNudgeCard {
  const streak = event.payload.streak_days as number;
  const avg = Math.round(event.payload.avg_recovery_pct as number);
  const variants = [
    `Recovery has been in the red (${avg}% avg) for ${streak} consecutive days. This is grind territory. Talk to @Peter about deloading the rest of this week — pushing further compounds rather than adapts.`,
    `${streak} days in a row under 34% recovery (avg ${avg}%). The body is asking for a break. Z2 only or full rest day until recovery breaks 50% again.`,
  ];
  const idx = pickVariant({ userId: ctx?.userId ?? "", triggerKey: event.trigger_key, today: ctx?.today ?? "", count: variants.length });
  return {
    schema_version: 1, trigger_type: "low_recovery_streak", trigger_key: event.trigger_key,
    severity: "warn",
    headline: `${streak} consecutive red recovery days`,
    body_md: variants[idx],
    deep_link: { label: "See recovery distribution →", href: "/health?tab=trends#recovery-distribution" },
    speaker: "remi",
  };
}

function renderStrainRecovery(event: ProactiveEvent, ctx?: RenderContext): ProactiveNudgeCard {
  const strain = (Math.round((event.payload.strain_avg_7d as number) * 10) / 10).toFixed(1);
  const recovery = Math.round(event.payload.recovery_avg_7d as number);
  const variants = [
    `7-day strain avg ${strain} with recovery sitting at ${recovery}%. This is the overreach setup — load up, body down. One of two things needs to change this week: less strain, or more recovery (sleep, food, true rest day).`,
    `Strain × recovery balance is off — averaging ${strain} strain into ${recovery}% recovery. If this continues, expect HRV depression next week. Easier sessions or a rest day buys you next week's quality.`,
  ];
  const idx = pickVariant({ userId: ctx?.userId ?? "", triggerKey: event.trigger_key, today: ctx?.today ?? "", count: variants.length });
  return {
    schema_version: 1, trigger_type: "strain_recovery_imbalance", trigger_key: event.trigger_key,
    severity: "warn",
    headline: `Strain × recovery imbalance · overreach risk`,
    body_md: variants[idx],
    deep_link: { label: "See balance chart →", href: "/health?tab=trends#strain-recovery" },
    speaker: "remi",
  };
}

function renderSkinTemp(event: ProactiveEvent, ctx?: RenderContext): ProactiveNudgeCard {
  const delta = (Math.round((event.payload.delta_c_avg as number) * 10) / 10).toFixed(1);
  const days = event.payload.days_elevated as number;
  const variants = [
    `Skin temp +${delta}°C above baseline for ${days} consecutive days. Pre-symptomatic illness signal — your body is fighting something before you feel it. Take a rest day or Z2 substitute today.`,
    `${days} days of skin temp running +${delta}°C. Could be illness brewing, hot training environment, or cycle phase. If RHR is also up, it's likely the first. Cross-check with the RHR card.`,
  ];
  const idx = pickVariant({ userId: ctx?.userId ?? "", triggerKey: event.trigger_key, today: ctx?.today ?? "", count: variants.length });
  return {
    schema_version: 1, trigger_type: "skin_temp_elevated", trigger_key: event.trigger_key,
    severity: "warn",
    headline: `Skin temp +${delta}°C · ${days} days running`,
    body_md: variants[idx],
    deep_link: { label: "See skin temp →", href: "/health?tab=trends#skin-temp" },
    speaker: "remi",
  };
}

function renderRecurringSoreness(event: ProactiveEvent, ctx?: RenderContext): ProactiveNudgeCard {
  const area = event.payload.area as string;
  const occ = event.payload.occurrences as number;
  const variants = [
    `${area} flagged sore on ${occ} of the last 14 checkins. That's overuse, not normal DOMS. Worth flagging @Carter — pattern swap or volume cut on the movements that hit this region.`,
    `${occ} soreness flags on ${area} in 14 days. If it's the same exercise stack each week, this is the body asking for rotation. Talk to @Carter about substituting the heaviest ${area}-dominant lift.`,
  ];
  const idx = pickVariant({ userId: ctx?.userId ?? "", triggerKey: event.trigger_key, today: ctx?.today ?? "", count: variants.length });
  return {
    schema_version: 1, trigger_type: "recurring_soreness_area", trigger_key: event.trigger_key,
    severity: "warn",
    headline: `Recurring ${area} soreness · ${occ}/14 days`,
    body_md: variants[idx],
    deep_link: { label: "See soreness heat-map →", href: "/health?tab=trends#soreness-heatmap" },
    speaker: "remi",
  };
}

function renderSicknessLingering(event: ProactiveEvent, ctx?: RenderContext): ProactiveNudgeCard {
  const streak = event.payload.streak_days as number;
  const notes = (event.payload.latest_notes as string | null) ?? "no specific notes";
  const variants = [
    `Sick ${streak} days running ("${notes}"). At this length consider a doctor visit, especially if fever or fatigue is dominant. Don't try to train through fever — it's the immune system asking for resources.`,
    `${streak} consecutive sickness days. Most acute illness resolves in 1-3 days; ${streak}+ is worth a clinician's eyes. Rest, fluids, no training, and book a visit if symptoms haven't peaked yet.`,
  ];
  const idx = pickVariant({ userId: ctx?.userId ?? "", triggerKey: event.trigger_key, today: ctx?.today ?? "", count: variants.length });
  return {
    schema_version: 1, trigger_type: "sickness_lingering", trigger_key: event.trigger_key,
    severity: "warn",
    headline: `Sick ${streak} days — consider a doctor`,
    body_md: variants[idx],
    deep_link: { label: "See sickness timeline →", href: "/health?tab=trends#fatigue-sickness" },
    speaker: "remi",
  };
}

function renderDeepSleepDeficit(event: ProactiveEvent, ctx?: RenderContext): ProactiveNudgeCard {
  const h = (Math.round((event.payload.avg_deep_h_14d as number) * 10) / 10).toFixed(1);
  const pct = event.payload.avg_pct_14d as number | null;
  const pctStr = pct != null ? `${Math.round(pct * 100)}%` : "—";
  const variants = [
    `Deep sleep averaging ${h}h (${pctStr} of total) over the last 14 days. Common culprits: late food, alcohol on training days, late training (<3h pre-bed). Pick one to remove this week.`,
    `${h}h deep sleep avg — under floor. Deep sleep is where physical recovery happens. Cool room (16–19°C), no food in the 3h before bed, no alcohol on training days.`,
  ];
  const idx = pickVariant({ userId: ctx?.userId ?? "", triggerKey: event.trigger_key, today: ctx?.today ?? "", count: variants.length });
  return {
    schema_version: 1, trigger_type: "deep_sleep_deficit", trigger_key: event.trigger_key,
    severity: "warn",
    headline: `Deep sleep deficit · 14d avg ${h}h`,
    body_md: variants[idx],
    deep_link: { label: "See sleep architecture →", href: "/health?tab=trends#sleep-architecture" },
    speaker: "remi",
  };
}

function renderBedtimeDrift(event: ProactiveEvent, ctx?: RenderContext): ProactiveNudgeCard {
  const sd = Math.round(event.payload.sd_minutes_14d as number);
  const mean = event.payload.mean_bedtime_hhmm as string | null;
  const meanStr = mean ?? "—";
  const variants = [
    `Bedtime varied by ${sd} min (SD) over the last 14 days, averaging ${meanStr}. Consistency matters more than total hours — pick a 30-min target window around ${meanStr} and hold it for a week, then reassess.`,
    `Bedtime SD is ${sd} min — that's the lever. Hours might be 8 but with bedtime swinging by ${sd} min nightly, HRV will reflect the inconsistency. Lock a window: ${meanStr} ±15 min.`,
  ];
  const idx = pickVariant({ userId: ctx?.userId ?? "", triggerKey: event.trigger_key, today: ctx?.today ?? "", count: variants.length });
  return {
    schema_version: 1, trigger_type: "bedtime_drift", trigger_key: event.trigger_key,
    severity: "warn",
    headline: `Bedtime drift · SD ${sd} min over 14d`,
    body_md: variants[idx],
    deep_link: { label: "See bedtime consistency →", href: "/health?tab=trends#bedtime-consistency" },
    speaker: "remi",
  };
}

function renderRespiratoryRate(event: ProactiveEvent, ctx?: RenderContext): ProactiveNudgeCard {
  const delta = (Math.round((event.payload.delta_bpm_avg as number) * 10) / 10).toFixed(1);
  const days = event.payload.days_elevated as number;
  const variants = [
    `Respiratory rate +${delta} bpm above baseline for ${days} days. Often the earliest infection signal — appears before skin temp or symptoms. Easy training today; watch for skin temp confirming.`,
    `RR up ${delta} bpm for ${days} days. The autonomic nervous system runs RR on autopilot, so changes are involuntary signals. If skin temp also rises, you're fighting something.`,
  ];
  const idx = pickVariant({ userId: ctx?.userId ?? "", triggerKey: event.trigger_key, today: ctx?.today ?? "", count: variants.length });
  return {
    schema_version: 1, trigger_type: "respiratory_rate_elevated", trigger_key: event.trigger_key,
    severity: "warn",
    headline: `Respiratory rate +${delta} · ${days} days`,
    body_md: variants[idx],
    deep_link: { label: "See respiratory rate →", href: "/health?tab=trends#respiratory-rate" },
    speaker: "remi",
  };
}

function renderHeavyFatigue(event: ProactiveEvent, ctx?: RenderContext): ProactiveNudgeCard {
  const count = event.payload.heavy_days_count as number;
  const variants = [
    `"Heavy" fatigue reported on ${count} of the last 7 mornings. Even if HRV looks fine, this is the body talking. Trust the subjective — back off intensity until it lifts.`,
    `${count} heavy-fatigue mornings in 7 days. Life stress, hidden sleep quality issues, or undereating can drive this independently of HRV. Worth a 1-day full rest to reset.`,
  ];
  const idx = pickVariant({ userId: ctx?.userId ?? "", triggerKey: event.trigger_key, today: ctx?.today ?? "", count: variants.length });
  return {
    schema_version: 1, trigger_type: "heavy_fatigue_cluster", trigger_key: event.trigger_key,
    severity: "warn",
    headline: `${count} heavy fatigue days in 7`,
    body_md: variants[idx],
    deep_link: { label: "See fatigue timeline →", href: "/health?tab=trends#fatigue-sickness" },
    speaker: "remi",
  };
}

function renderPostStrainUndersleep(event: ProactiveEvent, ctx?: RenderContext): ProactiveNudgeCard {
  const occ = event.payload.occurrences as number;
  const variants = [
    `${occ} times in the last 14 days, you went hard (strain ≥15) and slept <7h after. The night after the hardest sessions is when recovery happens — protect it. Move late-day training earlier or lock a tighter post-training bedtime.`,
    `Pattern: high-strain day → short sleep, ${occ}x in 14 days. The body uses sleep to consolidate the training stimulus. Cutting sleep on those nights is the most expensive cost-cut you can make.`,
  ];
  const idx = pickVariant({ userId: ctx?.userId ?? "", triggerKey: event.trigger_key, today: ctx?.today ?? "", count: variants.length });
  return {
    schema_version: 1, trigger_type: "post_strain_undersleep", trigger_key: event.trigger_key,
    severity: "warn",
    headline: `Post-strain undersleep · ${occ} in 14d`,
    body_md: variants[idx],
    deep_link: { label: "See sleep hours →", href: "/health?tab=trends#sleep-hours" },
    speaker: "remi",
  };
}
```

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck
```
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add lib/coach/proactive/render-card.ts
git commit -m "feat(remi): render templates for 13 new Remi triggers"
```

---

## Task 16: Wire all 13 checks into `runProactiveChecks`

**Files:**
- Modify: `lib/coach/proactive/index.ts`

- [ ] **Step 1: Import the 13 new check functions**

At the top of `lib/coach/proactive/index.ts`, alongside the existing check imports, add:

```ts
import { checkHrvChronic }          from "./check-hrv-chronic";
import { checkRhrElevated }         from "./check-rhr-elevated";
import { checkSleepDebt }           from "./check-sleep-debt";
import { checkLowRecoveryStreak }   from "./check-low-recovery-streak";
import { checkStrainRecovery }      from "./check-strain-recovery";
import { checkSkinTemp }            from "./check-skin-temp";
import { checkRecurringSoreness }   from "./check-recurring-soreness";
import { checkSicknessLingering }   from "./check-sickness-lingering";
import { checkDeepSleepDeficit }    from "./check-deep-sleep-deficit";
import { checkBedtimeDrift }        from "./check-bedtime-drift";
import { checkRespiratoryRate }     from "./check-respiratory-rate";
import { checkHeavyFatigue }        from "./check-heavy-fatigue";
import { checkPostStrainUndersleep } from "./check-post-strain-undersleep";
```

- [ ] **Step 2: Extend `TRIGGER_OWNER`**

Find the `TRIGGER_OWNER` const. Add the 13 entries beneath the existing Nora entries:

```ts
  // NEW — all Remi.
  hrv_chronic_depression:    "remi",
  rhr_elevated:              "remi",
  sleep_debt_accumulated:    "remi",
  low_recovery_streak:       "remi",
  strain_recovery_imbalance: "remi",
  skin_temp_elevated:        "remi",
  recurring_soreness_area:   "remi",  // semantic prefix (keys are per-area)
  sickness_lingering:        "remi",
  deep_sleep_deficit:        "remi",
  bedtime_drift:             "remi",
  respiratory_rate_elevated: "remi",
  heavy_fatigue_cluster:     "remi",
  post_strain_undersleep:    "remi",
```

- [ ] **Step 3: Update `ownerForTrigger` for the per-area soreness keys**

The recurring-soreness keys look like `recurring_soreness_legs`, `recurring_soreness_chest`, etc. The existing `ownerForTrigger` already handles colon-prefix splitting; we need it to handle underscore-prefix matching too for the per-area case. Add a fallback inside `ownerForTrigger`:

Find:

```ts
function ownerForTrigger(triggerKey: string): Speaker {
  const colonPrefix = triggerKey.split(":")[0];
  const owner = TRIGGER_OWNER[colonPrefix] ?? TRIGGER_OWNER[triggerKey];
  if (!owner) {
    throw new Error(`proactive: no owning coach for trigger '${triggerKey}'`);
  }
  return owner;
}
```

Replace with:

```ts
function ownerForTrigger(triggerKey: string): Speaker {
  // Colon-namespaced (e.g. "plateau:bench").
  const colonPrefix = triggerKey.split(":")[0];
  // Underscore-namespaced for per-area triggers
  // (e.g. "recurring_soreness_legs" → "recurring_soreness_area").
  const isAreaKey = /^recurring_soreness_(chest|back|legs|shoulders|arms|core)$/.test(triggerKey);
  const lookupKey = isAreaKey ? "recurring_soreness_area" : triggerKey;
  const owner = TRIGGER_OWNER[colonPrefix] ?? TRIGGER_OWNER[lookupKey];
  if (!owner) {
    throw new Error(`proactive: no owning coach for trigger '${triggerKey}'`);
  }
  return owner;
}
```

- [ ] **Step 4: Wire the 13 checks into the events array**

Find the `const events: ProactiveEvent[] = [...]` block inside `runProactiveChecks`. Add the 13 new checks (all take only `recoveryIntelligence`, none need supabase/userId/today plumbing):

```ts
const events: ProactiveEvent[] = [
  ...checkPlateau(trends),
  ...checkOffPace(trends),
  ...checkHrv(trends),
  ...checkRecomp(trends),
  ...await checkProteinFloor(trends, { supabase, userId, today }),
  ...checkMonotoneProtein(trends),
  ...checkFriedHeavy(trends),
  ...await checkTrainingUndereat(trends, { supabase, userId, today }),
  // Remi — read from recovery payload only.
  ...checkHrvChronic(recoveryIntelligence),
  ...checkRhrElevated(recoveryIntelligence),
  ...checkSleepDebt(recoveryIntelligence),
  ...checkLowRecoveryStreak(recoveryIntelligence),
  ...checkStrainRecovery(recoveryIntelligence),
  ...checkSkinTemp(recoveryIntelligence),
  ...checkRecurringSoreness(recoveryIntelligence),
  ...checkSicknessLingering(recoveryIntelligence),
  ...checkDeepSleepDeficit(recoveryIntelligence),
  ...checkBedtimeDrift(recoveryIntelligence),
  ...checkRespiratoryRate(recoveryIntelligence),
  ...checkHeavyFatigue(recoveryIntelligence),
  ...checkPostStrainUndersleep(recoveryIntelligence),
];
```

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck
```
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add lib/coach/proactive/index.ts
git commit -m "feat(remi): wire 13 checks into runProactiveChecks + TRIGGER_OWNER"
```

---

## Task 17: Expand `REMI_BASE` prompt

**Files:**
- Modify: `lib/coach/system-prompts.ts`

- [ ] **Step 1: Locate `REMI_BASE`**

In `lib/coach/system-prompts.ts`, find `export const REMI_BASE = ...` (lines ~118–131 as of this branch).

- [ ] **Step 2: Replace the entire `REMI_BASE` string with the expanded version**

Replace the existing template literal with the verbatim text from the spec §C. Use the exact text from `docs/superpowers/specs/2026-05-24-remi-recovery-intelligence-design.md` § "Section C — Full updated `REMI_BASE`" — that is the source of truth, copy it byte-for-byte from the spec.

The shape stays a single backticked template literal exported as `REMI_BASE`.

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```
Expected: no errors.

- [ ] **Step 4: Smoke test in chat**

```bash
npm run dev
```

Navigate to `/coach`, ensure Remi is the active speaker (use the coach picker if needed), and ask: *"My HRV has been low — what does that mean?"*

Expected: Remi's reply references the new interpretive thresholds (mentions noise vs signal vs action ranges) rather than the old generic "consider checking sleep" tone. If the reply still sounds generic, the prompt change didn't take effect — restart `npm run dev` so the prompt is reloaded.

- [ ] **Step 5: Commit**

```bash
git add lib/coach/system-prompts.ts
git commit -m "feat(remi): expand REMI_BASE with thresholds, hygiene, escalation, hand-off"
```

---

## Task 18: Audit script for Remi triggers

**Files:**
- Create: `scripts/audit-remi-triggers.mjs`

- [ ] **Step 1: Write the script**

```js
// scripts/audit-remi-triggers.mjs
//
// For AUDIT_USER_ID, dry-runs the 14 Remi triggers (13 new + existing
// hrv_below_baseline) against current data and reports for each:
// would_fire | would_skip with reason. Doesn't write to chat_messages or
// proactive_nudge_dedup — pass dry_run=true.
//
// Usage:
//   AUDIT_USER_ID=<uuid> node \
//     --import ./scripts/alias-loader.mjs \
//     --experimental-strip-types \
//     --env-file=.env.local \
//     scripts/audit-remi-triggers.mjs

import { createClient } from "@supabase/supabase-js";
import { generateCoachTrends } from "@/lib/coach/trends";
import { generateRecoveryIntelligence } from "@/lib/coach/recovery-intelligence";
import { runProactiveChecks } from "@/lib/coach/proactive";

const userId = process.env.AUDIT_USER_ID;
if (!userId) { console.error("AUDIT_USER_ID required"); process.exit(1); }

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const today = new Date().toISOString().slice(0, 10);
console.log(`audit-remi-triggers · user ${userId} · today ${today}\n`);

const [trends, recoveryIntelligence] = await Promise.all([
  generateCoachTrends({ supabase, userId, today }),
  generateRecoveryIntelligence({ supabase, userId, today }),
]);

const result = await runProactiveChecks({
  supabase, userId, trends, recoveryIntelligence, dry_run: true,
});

const remiTriggerPrefixes = [
  "hrv_below_baseline", "hrv_chronic_depression",
  "rhr_elevated", "sleep_debt_accumulated",
  "low_recovery_streak", "strain_recovery_imbalance",
  "skin_temp_elevated", "recurring_soreness_",
  "sickness_lingering", "deep_sleep_deficit",
  "bedtime_drift", "respiratory_rate_elevated",
  "heavy_fatigue_cluster", "post_strain_undersleep",
];

const isRemi = (key) => remiTriggerPrefixes.some((p) => key.startsWith(p));

const remiFired = result.fired.filter((f) => isRemi(f.event.trigger_key));
console.log(`── Remi triggers WOULD fire (${remiFired.length}) ──`);
for (const f of remiFired) {
  console.log(`  ✓ ${f.event.trigger_key}`);
  console.log(`    ${f.card.headline}`);
  console.log(`    payload: ${JSON.stringify(f.event.payload)}`);
}

const allRemiKeys = remiTriggerPrefixes.filter((p) => !p.endsWith("_")); // exclude per-area family
const firedKeys = new Set(remiFired.map((f) => f.event.trigger_key));
const wouldSkip = allRemiKeys.filter((k) => !firedKeys.has(k));
console.log(`\n── Remi triggers WOULD skip (${wouldSkip.length}) ──`);
for (const k of wouldSkip) console.log(`  · ${k}`);

console.log(`\n── shape sanity ──`);
console.log(`  recoveryIntelligence.daily: ${recoveryIntelligence.daily.length}`);
console.log(`  recoveryIntelligence.subjective: ${recoveryIntelligence.subjective.length}`);
console.log(`  hrv baseline: ${recoveryIntelligence.baselines.hrv_mean}`);
console.log(`  rhr baseline: ${recoveryIntelligence.baselines.resting_hr_mean}`);
console.log(`  skin temp baseline: ${recoveryIntelligence.baselines.skin_temp_baseline_c}`);
console.log(`  bedtime_sd_minutes: ${recoveryIntelligence.derived.bedtime_sd_minutes}`);
process.exit(0);
```

- [ ] **Step 2: Run it**

```bash
AUDIT_USER_ID=<your-dev-uuid> node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-remi-triggers.mjs
```
Expected: prints the lists of would-fire / would-skip triggers + shape sanity. Confirm:
- `hrv baseline` is non-null (else most checks degrade to "would skip" — backfill via WHOOP).
- `bedtime_sd_minutes` is non-null if migration 0031 was backfilled (else `bedtime_drift` always skips).
- `recoveryIntelligence.subjective` is 28 entries; if many `fatigue=null`, that means the user hasn't done many morning intakes (degrades subjective triggers gracefully).

- [ ] **Step 3: Document in CLAUDE.md**

Find the `## Scripts` section and add:

```md
- [scripts/audit-remi-triggers.mjs](scripts/audit-remi-triggers.mjs) — dry-runs the 14 Remi proactive triggers against current data and reports would-fire / would-skip lists + shape sanity. Set `AUDIT_USER_ID`. Run via: `AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-remi-triggers.mjs`.
```

- [ ] **Step 4: Commit**

```bash
git add scripts/audit-remi-triggers.mjs CLAUDE.md
git commit -m "feat(remi): audit-remi-triggers — dry-run all 14 Remi checks"
```

---

## Task 19: End-to-end cron smoke (live, not dry-run)

- [ ] **Step 1: Run the cron locally with the auth header**

```bash
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/coach/proactive/check
```
(Make sure `npm run dev` is running and `CRON_SECRET` is in your shell.)

Expected JSON response with `ok: true`, plus `fired_keys` containing whatever triggers actually fired for your dev user, and `suppressed_keys` showing dedup blocks for anything that fired in the last 7 days.

- [ ] **Step 2: Verify chat_messages got the rows**

In a SQL editor or via supabase shell:

```sql
select created_at, trigger_key := ui->>'trigger_key', headline := ui->>'headline', speaker
from chat_messages
where user_id = '<your-uuid>' and kind = 'proactive_nudge' and speaker = 'remi'
order by created_at desc limit 10;
```

Expected: rows match the `fired_keys` from Step 1. Speaker is consistently `remi` (no leakage to Peter/Nora/Carter).

- [ ] **Step 3: Re-run the cron**

```bash
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/coach/proactive/check
```

Expected: `fired` count is 0 (or close to it) because the dedup window suppresses re-fires. `suppressed_keys` should now contain the keys from Step 1.

- [ ] **Step 4: If something didn't fire that should have, debug via the audit script**

```bash
AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-remi-triggers.mjs
```

The audit script will tell you whether the check evaluated to `would_fire` (in which case dedup is the suppressor — check `proactive_nudge_dedup`) or `would_skip` (in which case the data doesn't meet the threshold — look at the shape sanity output for missing baselines).

- [ ] **Step 5: No commit for this task** (smoke only)

---

## Plan 2 complete

13 new Remi proactive triggers are live, render templates are wired, `REMI_BASE` carries the expanded coaching playbook, and the audit script verifies the whole chain.

Combined with Plan 1, Remi now has:
- A dedicated 17-card Trends pill on `/health` (Plan 1)
- 14 proactive triggers total (1 existing + 13 new) — parity-plus with Nora's arc
- An interpretive prompt with concrete thresholds, sleep-hygiene prescription menu, illness/soreness escalation rules, trigger-card awareness, and explicit `@Peter` / `@Carter` / `@Nora` hand-off rules

Spec deliverables A, B, C all shipped.
