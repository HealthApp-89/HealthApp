// lib/coach/intelligence/recovery-readiness.ts
//
// Recovery Readiness Composer (Layer 2) — correlates HRV, RHR, sleep quality,
// and strain across the last 7 days into a single readiness signal coaches can
// ground in. Replaces single-metric reasoning with multi-metric correlation.
//
// Pure function — no Supabase calls, no side effects.
// Deterministic: identical input → identical output.
// Uses Remi's canonical thresholds from REMI_BASE.

import { z } from "zod";
import { isMeaningfulDeviation } from "@/lib/whoop/baselines";
import type { Rolling30dBaselines } from "@/lib/data/types";

// ---------------------------------------------------------------------------
// Input type (mirrors coach-history.ts DailyLogRow — recovery-relevant fields)
// ---------------------------------------------------------------------------

/** Daily log row shape consumed by this composer. */
export type DailyLogRow = {
  date: string;
  hrv: number | null;
  resting_hr: number | null;
  recovery: number | null;
  sleep_hours: number | null;
  sleep_score: number | null;
  deep_sleep_hours: number | null;
  strain: number | null;
};

// ---------------------------------------------------------------------------
// Result type + Zod schema
// ---------------------------------------------------------------------------

export const RecoveryReadinessResultSchema = z.object({
  /** Overall readiness status */
  status: z.enum(["recovering_well", "stalled", "warning_overreach"]),
  /** 0-1, higher with more non-null data days */
  confidence: z.number().min(0).max(1),
  /** Short human-readable strings for each contributing factor actually observed */
  drivers: z.array(z.string()),
  /** Action recommendation */
  recommendation: z.enum(["continue_training", "consider_deload", "seek_medical"]),
  /** One-sentence plain-English summary coaches can quote */
  narrative: z.string().min(1),
});

export type RecoveryReadinessResult = z.infer<typeof RecoveryReadinessResultSchema>;

// ---------------------------------------------------------------------------
// Thresholds (from REMI_BASE — canonical rules)
// ---------------------------------------------------------------------------

/** HRV % drop below baseline mean: signal threshold */
const HRV_DROP_SIGNAL_PCT = 5; // 5% drop sustained 3+ days = signal
/** HRV % drop below baseline mean: action threshold */
const HRV_DROP_ACTION_PCT = 7; // 7% drop sustained 5+ days = action (deload territory)
/** Minimum days in last 5 for HRV action threshold  */
const HRV_ACTION_MIN_DAYS_OF_5 = 3; // ≥3 of last 5 days
/** RHR elevation that constitutes overreach when sustained */
const RHR_OVERREACH_BPM = 5; // +5 bpm above baseline mean sustained 5+ days
/** Days of sustained RHR elevation for overreach */
const RHR_OVERREACH_SUSTAINED_DAYS = 5;
/** Sleep score below which it's "meaningful" */
const SLEEP_MEANINGFUL_THRESHOLD = 70;
/** Sleep score below which it's "action" level */
const SLEEP_ACTION_THRESHOLD = 60;
/** Strain spike ratio vs 7d mean that is worth flagging as a driver */
const STRAIN_SPIKE_RATIO = 1.4;

// ---------------------------------------------------------------------------
// Internal analysis helpers
// ---------------------------------------------------------------------------

type HrvAnalysis = {
  /** Days in last 7 where HRV dropped >= signalPct% below baseline AND isMeaningfulDeviation */
  signalDropDays: number;
  /** Days in last 5 where HRV dropped >= actionPct% below baseline AND isMeaningfulDeviation */
  actionDropDaysOf5: number;
  /** Median HRV drop % vs baseline (for narrative) — null if no data */
  avgDropPct: number | null;
  /** Whether a meaningful HRV deviation exists on any day */
  anySignalDeviation: boolean;
};

function analyzeHrv(logs: DailyLogRow[], baselines: Rolling30dBaselines | null): HrvAnalysis {
  if (!baselines || baselines.hrv.mean === null) {
    return { signalDropDays: 0, actionDropDaysOf5: 0, avgDropPct: null, anySignalDeviation: false };
  }

  const baseline = baselines.hrv;
  const mean = baseline.mean!;

  let signalDropDays = 0;
  let actionDropDaysOf5 = 0;
  let anySignalDeviation = false;
  const dropPcts: number[] = [];

  // Count all 7 days for signal threshold
  for (const log of logs) {
    if (log.hrv === null) continue;
    const isSignal = isMeaningfulDeviation(log.hrv, baseline);
    const dropPct = ((mean - log.hrv) / mean) * 100;

    if (isSignal && dropPct >= HRV_DROP_SIGNAL_PCT) {
      signalDropDays++;
      anySignalDeviation = true;
    }
    if (isSignal) anySignalDeviation = true;
    if (dropPct > 0) dropPcts.push(dropPct);
  }

  // Count last 5 days for action threshold (indices 0..4 — most recent first)
  const last5 = logs.slice(0, 5);
  for (const log of last5) {
    if (log.hrv === null) continue;
    const isSignal = isMeaningfulDeviation(log.hrv, baseline);
    const dropPct = ((mean - log.hrv) / mean) * 100;
    if (isSignal && dropPct >= HRV_DROP_ACTION_PCT) {
      actionDropDaysOf5++;
    }
  }

  const avgDropPct = dropPcts.length > 0
    ? dropPcts.reduce((a, b) => a + b, 0) / dropPcts.length
    : null;

  return { signalDropDays, actionDropDaysOf5, avgDropPct, anySignalDeviation };
}

type RhrAnalysis = {
  /** Days in last 7 where RHR was >= overreachBpm above baseline AND isMeaningfulDeviation */
  elevatedDays: number;
  /** Whether the elevation is sustained long enough to be overreach */
  isSustainedOverreach: boolean;
  /** Average RHR elevation vs baseline (for narrative) — null if no data */
  avgElevation: number | null;
};

function analyzeRhr(logs: DailyLogRow[], baselines: Rolling30dBaselines | null): RhrAnalysis {
  if (!baselines || baselines.rhr.mean === null) {
    return { elevatedDays: 0, isSustainedOverreach: false, avgElevation: null };
  }

  const baseline = baselines.rhr;
  const mean = baseline.mean!;

  let elevatedDays = 0;
  const elevations: number[] = [];

  for (const log of logs) {
    if (log.resting_hr === null) continue;
    const isSignal = isMeaningfulDeviation(log.resting_hr, baseline);
    const elevation = log.resting_hr - mean;

    if (isSignal && elevation >= RHR_OVERREACH_BPM) {
      elevatedDays++;
    }
    if (elevation > 0) elevations.push(elevation);
  }

  const isSustainedOverreach = elevatedDays >= RHR_OVERREACH_SUSTAINED_DAYS;
  const avgElevation = elevations.length > 0
    ? elevations.reduce((a, b) => a + b, 0) / elevations.length
    : null;

  return { elevatedDays, isSustainedOverreach, avgElevation };
}

type SleepAnalysis = {
  avgScore: number | null;
  /** Days where sleep_score < SLEEP_ACTION_THRESHOLD */
  actionDays: number;
  /** Days where sleep_score < SLEEP_MEANINGFUL_THRESHOLD */
  meaningfulDays: number;
  isActionLevel: boolean;
};

function analyzeSleep(logs: DailyLogRow[]): SleepAnalysis {
  const scores = logs.filter((l) => l.sleep_score !== null).map((l) => l.sleep_score!);
  if (scores.length === 0) {
    return { avgScore: null, actionDays: 0, meaningfulDays: 0, isActionLevel: false };
  }

  const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
  const actionDays = scores.filter((s) => s < SLEEP_ACTION_THRESHOLD).length;
  const meaningfulDays = scores.filter((s) => s < SLEEP_MEANINGFUL_THRESHOLD).length;
  // "action level" when majority of days (or average) are below action threshold
  const isActionLevel = actionDays >= Math.ceil(scores.length / 2) || avgScore < SLEEP_ACTION_THRESHOLD;

  return { avgScore, actionDays, meaningfulDays, isActionLevel };
}

type StrainAnalysis = {
  /** Whether last 1-2 days had a spike vs 7d mean */
  hasRecentSpike: boolean;
  recentAvg: number | null;
  weekMean: number | null;
};

function analyzeStrain(logs: DailyLogRow[]): StrainAnalysis {
  const strainValues = logs.filter((l) => l.strain !== null).map((l) => l.strain!);
  if (strainValues.length === 0) {
    return { hasRecentSpike: false, recentAvg: null, weekMean: null };
  }

  const weekMean = strainValues.reduce((a, b) => a + b, 0) / strainValues.length;

  // last 1-2 days = indices 0 and 1 (most recent first)
  const recentValues = logs.slice(0, 2).filter((l) => l.strain !== null).map((l) => l.strain!);
  if (recentValues.length === 0) {
    return { hasRecentSpike: false, recentAvg: null, weekMean };
  }

  const recentAvg = recentValues.reduce((a, b) => a + b, 0) / recentValues.length;
  const hasRecentSpike = recentAvg > weekMean * STRAIN_SPIKE_RATIO;

  return { hasRecentSpike, recentAvg, weekMean };
}

/** Count days with at least one non-null key metric (HRV, RHR, or sleep_score). */
function countNonNullDays(logs: DailyLogRow[]): number {
  return logs.filter(
    (l) => l.hrv !== null || l.resting_hr !== null || l.sleep_score !== null,
  ).length;
}

// ---------------------------------------------------------------------------
// Main composer
// ---------------------------------------------------------------------------

/**
 * Compose a RecoveryReadinessResult from 7 days of daily logs and rolling
 * 30-day baselines.
 *
 * @param dailyLogs    Last 7 days of daily_logs rows (most recent first or any order).
 * @param baselines    Rolling 30-day WHOOP baselines, or null for new users.
 * @returns RecoveryReadinessResult validated against RecoveryReadinessResultSchema.
 */
export function composeRecoveryReadiness(
  dailyLogs: DailyLogRow[],
  baselines: Rolling30dBaselines | null,
): RecoveryReadinessResult {
  // ── Edge case: empty input ───────────────────────────────────────────────
  if (dailyLogs.length === 0) {
    const empty: RecoveryReadinessResult = {
      status: "stalled",
      confidence: 0.3,
      drivers: [],
      recommendation: "continue_training",
      narrative: "Not enough recent recovery data to assess.",
    };
    // Validate and return
    const parsed = RecoveryReadinessResultSchema.safeParse(empty);
    if (!parsed.success) {
      throw new Error(
        `composeRecoveryReadiness: empty-input output failed schema validation — ${JSON.stringify(parsed.error.issues)}`,
      );
    }
    return parsed.data;
  }

  // ── Data coverage & confidence ───────────────────────────────────────────
  const nonNullDays = countNonNullDays(dailyLogs);
  const baselineMissing =
    baselines === null ||
    (baselines.hrv.mean === null && baselines.rhr.mean === null);

  // Raw coverage-based confidence
  let confidence = Math.max(0.3, nonNullDays / 7);
  // Cap at 0.5 when baselines not available
  if (baselineMissing) {
    confidence = Math.min(confidence, 0.5);
  }
  // Round to 2 decimal places
  confidence = Math.round(confidence * 100) / 100;

  // ── Metric analysis ──────────────────────────────────────────────────────
  const hrv = analyzeHrv(dailyLogs, baselines);
  const rhr = analyzeRhr(dailyLogs, baselines);
  const sleep = analyzeSleep(dailyLogs);
  const strain = analyzeStrain(dailyLogs);

  // ── Driver accumulation ──────────────────────────────────────────────────
  const drivers: string[] = [];

  // HRV drivers
  if (hrv.avgDropPct !== null && hrv.signalDropDays > 0) {
    const pct = Math.round(hrv.avgDropPct);
    drivers.push(`HRV -${pct}% vs baseline (signal, ${hrv.signalDropDays}d of ${Math.min(dailyLogs.length, 7)})`);
  } else if (hrv.anySignalDeviation && !baselineMissing) {
    drivers.push("HRV meaningful deviation vs baseline");
  }

  // RHR drivers
  if (rhr.elevatedDays > 0 && rhr.avgElevation !== null) {
    const bpm = Math.round(rhr.avgElevation * 10) / 10;
    drivers.push(`RHR +${bpm}bpm vs baseline (${rhr.elevatedDays}d elevated)`);
  }

  // Sleep drivers
  if (sleep.avgScore !== null) {
    if (sleep.isActionLevel) {
      drivers.push(`sleep_score avg ${Math.round(sleep.avgScore)} (action <60)`);
    } else if (sleep.meaningfulDays > 0) {
      drivers.push(`sleep_score avg ${Math.round(sleep.avgScore)} (<70 meaningful, ${sleep.meaningfulDays}d)`);
    }
  }

  // Strain spike driver (noted but alone doesn't set status)
  if (strain.hasRecentSpike && strain.recentAvg !== null && strain.weekMean !== null) {
    const recentRounded = Math.round(strain.recentAvg * 10) / 10;
    const weekRounded = Math.round(strain.weekMean * 10) / 10;
    drivers.push(`strain spike: recent avg ${recentRounded} vs 7d mean ${weekRounded}`);
  }

  // ── Illness cluster detection ────────────────────────────────────────────
  // Seek medical: RHR+5 sustained AND sleep<60 AND HRV signal drop together
  const isIllnessCluster =
    rhr.isSustainedOverreach &&
    sleep.isActionLevel &&
    hrv.anySignalDeviation &&
    !baselineMissing;

  // ── Status decision ──────────────────────────────────────────────────────
  //
  // warning_overreach if:
  //   (A) HRV drop ≥7% confirmed-signal sustained ≥3 of last 5 days
  //   (B) RHR +5bpm sustained 5d
  //   (C) HRV signal-drop AND sleep_score <60
  //
  // seek_medical only when illness cluster: (B) AND sleep<60 AND HRV down — all three together.
  //
  // stalled: metrics flat/below baseline but not crossing action thresholds.
  // recovering_well: otherwise.

  const isHrvActionLevel =
    hrv.actionDropDaysOf5 >= HRV_ACTION_MIN_DAYS_OF_5 && !baselineMissing;
  const isRhrOverreach = rhr.isSustainedOverreach && !baselineMissing;
  const isHrvSignalPlusBadSleep =
    hrv.anySignalDeviation && sleep.isActionLevel && !baselineMissing;

  // Also detect warning_overreach via absolute sleep score alone when baselines missing
  const isAbsoluteActionSleep =
    sleep.isActionLevel && baselineMissing;

  const isWarningOverreach =
    isHrvActionLevel ||
    isRhrOverreach ||
    isHrvSignalPlusBadSleep ||
    isAbsoluteActionSleep;

  // Stalled: there are below-baseline signals (signal drops, moderate HRV down, poor sleep)
  // but we haven't crossed action thresholds
  const isStalled =
    !isWarningOverreach &&
    (hrv.signalDropDays > 0 ||
      (sleep.avgScore !== null && sleep.avgScore < SLEEP_MEANINGFUL_THRESHOLD) ||
      (rhr.elevatedDays > 0 && !baselineMissing));

  let status: RecoveryReadinessResult["status"];
  let recommendation: RecoveryReadinessResult["recommendation"];

  if (isWarningOverreach) {
    status = "warning_overreach";
    recommendation = isIllnessCluster ? "seek_medical" : "consider_deload";
  } else if (isStalled) {
    status = "stalled";
    recommendation = "continue_training";
  } else {
    status = "recovering_well";
    recommendation = "continue_training";
  }

  // ── Narrative ────────────────────────────────────────────────────────────
  let narrative: string;

  if (baselineMissing) {
    // No baselines available — absolute thresholds only
    const sleepNote =
      sleep.avgScore !== null
        ? ` Sleep score averaging ${Math.round(sleep.avgScore)}.`
        : "";
    narrative =
      status === "stalled"
        ? `Baseline still establishing — using absolute thresholds only; metrics suggest monitoring is warranted.${sleepNote}`
        : status === "warning_overreach"
          ? `Baseline still establishing — absolute thresholds indicate elevated stress (sleep score ${sleep.avgScore !== null ? Math.round(sleep.avgScore) : "unknown"}); reduce load and monitor.`
          : `Baseline still establishing — no absolute-threshold alerts; continue current approach while baselines build.`;
  } else if (status === "warning_overreach") {
    const parts: string[] = [];
    if (hrv.avgDropPct !== null && hrv.signalDropDays > 0) {
      parts.push(`HRV down ${Math.round(hrv.avgDropPct)}% from your 30-day baseline across ${hrv.signalDropDays} of the last ${Math.min(dailyLogs.length, 7)} days`);
    }
    if (rhr.elevatedDays > 0 && rhr.avgElevation !== null) {
      parts.push(`RHR up ${Math.round(rhr.avgElevation * 10) / 10} bpm for ${rhr.elevatedDays}d`);
    }
    if (sleep.avgScore !== null && sleep.avgScore < SLEEP_MEANINGFUL_THRESHOLD) {
      parts.push(`sleep score ${Math.round(sleep.avgScore)}`);
    }
    const pattern = recommendation === "seek_medical" ? "illness pattern" : "overreach pattern";
    const action = recommendation === "seek_medical"
      ? "consider seeing a doctor if symptoms persist."
      : "a deload is warranted.";
    narrative = parts.length > 0
      ? `${parts.join(" with ")} — ${pattern}; ${action}`
      : `Multiple recovery metrics indicate ${pattern}; ${action}`;
  } else if (status === "stalled") {
    const parts: string[] = [];
    if (hrv.avgDropPct !== null && hrv.signalDropDays > 0) {
      parts.push(`HRV running slightly below baseline (${hrv.signalDropDays}d)`);
    }
    if (sleep.avgScore !== null && sleep.avgScore < SLEEP_MEANINGFUL_THRESHOLD) {
      parts.push(`sleep score at ${Math.round(sleep.avgScore)}`);
    }
    if (rhr.elevatedDays > 0) {
      parts.push(`RHR slightly elevated`);
    }
    const signal = parts.length > 0 ? parts.join(", ") + " — " : "";
    narrative = `${signal}metrics are below your baseline but haven't crossed action thresholds; continue training and monitor closely.`;
  } else {
    // recovering_well
    const hrvNote =
      hrv.avgDropPct === null || hrv.signalDropDays === 0
        ? "HRV stable near baseline"
        : "HRV within normal variation";
    const sleepNote =
      sleep.avgScore !== null
        ? `, sleep score ${Math.round(sleep.avgScore)}`
        : "";
    narrative = `${hrvNote}, RHR on target${sleepNote} — recovery is on track; continue planned training.`;
  }

  // ── Build and validate result ─────────────────────────────────────────────
  const result: RecoveryReadinessResult = {
    status,
    confidence,
    drivers,
    recommendation,
    narrative,
  };

  const parsed = RecoveryReadinessResultSchema.safeParse(result);
  if (!parsed.success) {
    throw new Error(
      `composeRecoveryReadiness: output failed schema validation — ${JSON.stringify(parsed.error.issues)}`,
    );
  }

  return parsed.data;
}
