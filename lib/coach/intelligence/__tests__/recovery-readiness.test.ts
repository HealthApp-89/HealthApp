// lib/coach/intelligence/__tests__/recovery-readiness.test.ts
//
// Tests for composeRecoveryReadiness() — the recovery readiness composer.
// Run via: npx vitest lib/coach/intelligence/

import { describe, it, expect } from "vitest";
import {
  composeRecoveryReadiness,
  RecoveryReadinessResultSchema,
  type DailyLogRow,
} from "../recovery-readiness";
import type { Rolling30dBaselines, MetricBaseline } from "@/lib/data/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Optional fields object for makeLog — all default to null. */
type DailyLogFields = {
  hrv?: number | null;
  resting_hr?: number | null;
  recovery?: number | null;
  sleep_hours?: number | null;
  sleep_score?: number | null;
  deep_sleep_hours?: number | null;
  strain?: number | null;
};

function makeLog(date: string, fields: DailyLogFields = {}): DailyLogRow {
  return {
    date,
    hrv: fields.hrv !== undefined ? fields.hrv : null,
    resting_hr: fields.resting_hr !== undefined ? fields.resting_hr : null,
    recovery: fields.recovery !== undefined ? fields.recovery : null,
    sleep_hours: fields.sleep_hours !== undefined ? fields.sleep_hours : null,
    sleep_score: fields.sleep_score !== undefined ? fields.sleep_score : null,
    deep_sleep_hours: fields.deep_sleep_hours !== undefined ? fields.deep_sleep_hours : null,
    strain: fields.strain !== undefined ? fields.strain : null,
  };
}

/**
 * Build a 7-day window of daily logs.
 * `overrides` is keyed by day index (0 = most recent, 6 = oldest).
 * Unspecified days get the `defaults` values.
 */
function makeDailyLogs(
  defaults: DailyLogFields,
  overrides: Record<number, Partial<DailyLogFields>> = {},
): DailyLogRow[] {
  const logs: DailyLogRow[] = [];
  for (let i = 0; i < 7; i++) {
    // i=0 → today, i=6 → 6 days ago
    const d = new Date("2026-06-26");
    d.setUTCDate(d.getUTCDate() - i);
    const date = d.toISOString().slice(0, 10);
    const dayOverride = overrides[i] ?? {};
    logs.push(makeLog(date, { ...defaults, ...dayOverride }));
  }
  return logs;
}

/** Build a stable MetricBaseline. */
function makeBaseline(mean: number, sd: number): MetricBaseline {
  return { mean, sd, days: 30, status: "stable" };
}

/** Build a stable Rolling30dBaselines. */
function makeBaselines(
  hrv: number,
  hrvSd: number,
  rhr: number,
  rhrSd: number,
): Rolling30dBaselines {
  return {
    computed_at: "2026-06-26T00:00:00.000Z",
    hrv: makeBaseline(hrv, hrvSd),
    rhr: makeBaseline(rhr, rhrSd),
    recovery: makeBaseline(65, 10),
    sleep_performance: makeBaseline(75, 8),
    resp_rate: makeBaseline(16, 1),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("composeRecoveryReadiness", () => {
  // ── Test 1: Clear overreach ──────────────────────────────────────────────
  it("returns warning_overreach + consider_deload when HRV -8% confirmed signal 4/5 days + RHR +6bpm", () => {
    // Baseline HRV = 62 ms, SD = 5. -8% = ~57.04. isMeaningfulDeviation checks |57 - 62| = 5 > 0.5*5=2.5 → signal
    // Baseline RHR = 50 bpm, SD = 3. +6bpm = 56. |56 - 50| = 6 > 0.5*3=1.5 → signal
    const baselines = makeBaselines(62, 5, 50, 3);
    // HRV at ~57 (8% below 62) on days 0–4, day 5 normal, day 6 normal → 5/7 days down
    // RHR at 56 (+6 bpm above 50) all 7 days → 7 days elevated
    const logs = makeDailyLogs(
      { hrv: 57, resting_hr: 56, recovery: 45, sleep_score: 68, strain: 12 },
      {
        5: { hrv: 63, resting_hr: 50 }, // day 5 normal
        6: { hrv: 64, resting_hr: 51 }, // day 6 normal
      },
    );

    const result = composeRecoveryReadiness(logs, baselines);

    expect(result.status).toBe("warning_overreach");
    expect(result.recommendation).toBe("consider_deload");
    expect(result.confidence).toBeGreaterThan(0.5);
    expect(result.drivers.length).toBeGreaterThan(0);
    expect(result.narrative).toBeTruthy();
  });

  // ── Test 2: Healthy ──────────────────────────────────────────────────────
  it("returns recovering_well + continue_training when HRV at baseline, RHR stable, sleep 80+", () => {
    // Baseline HRV = 62, SD = 5. At-baseline HRV = 63 (within SD)
    // Baseline RHR = 50, SD = 3. Stable RHR = 50
    const baselines = makeBaselines(62, 5, 50, 3);
    const logs = makeDailyLogs({
      hrv: 63,
      resting_hr: 50,
      recovery: 75,
      sleep_score: 82,
      strain: 10,
    });

    const result = composeRecoveryReadiness(logs, baselines);

    expect(result.status).toBe("recovering_well");
    expect(result.recommendation).toBe("continue_training");
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  // ── Test 3: Stalled ──────────────────────────────────────────────────────
  it("returns stalled when HRV flat slightly under baseline within noise band", () => {
    // Baseline HRV = 62, SD = 5. HRV at 60.5 = |60.5-62|=1.5 < 0.5*5=2.5 → noise (NOT signal)
    // RHR near baseline (within noise)
    const baselines = makeBaselines(62, 5, 50, 3);
    const logs = makeDailyLogs({
      hrv: 60.5, // within noise band (< 0.5 SD below baseline)
      resting_hr: 51, // within noise
      recovery: 55, // below normal but not alarming
      sleep_score: 65, // below 70 but not action-level
      strain: 11,
    });

    const result = composeRecoveryReadiness(logs, baselines);

    expect(result.status).toBe("stalled");
    // stalled always recommends continue_training with a watch note
    expect(result.recommendation).toBe("continue_training");
  });

  // ── Test 4: Illness cluster → seek_medical ───────────────────────────────
  it("returns warning_overreach + seek_medical for illness cluster (RHR+5 5d + sleep<60 + HRV down)", () => {
    // Baseline HRV = 62, SD = 4. HRV at 55 = |55-62|=7 > 0.5*4=2 → confirmed signal, > 7% drop
    // Baseline RHR = 50, SD = 3. RHR at 56 = |56-50|=6 > 0.5*3=1.5 → signal, +6 bpm sustained all 7 days
    // Sleep score < 60 all days
    const baselines = makeBaselines(62, 4, 50, 3);
    const logs = makeDailyLogs({
      hrv: 55, // well below baseline (~11% drop, confirmed signal)
      resting_hr: 56, // +6 bpm, confirmed signal, all 7 days
      recovery: 30,
      sleep_score: 55, // < 60 action threshold
      strain: 8,
    });

    const result = composeRecoveryReadiness(logs, baselines);

    expect(result.status).toBe("warning_overreach");
    expect(result.recommendation).toBe("seek_medical");
  });

  // ── Test 5: Sparse data → low confidence ────────────────────────────────
  it("returns confidence ≤ 0.4 with only 2 non-null HRV/RHR/sleep days of 7", () => {
    const baselines = makeBaselines(62, 5, 50, 3);
    // Only days 0 and 1 have data, the rest are null
    const logs = makeDailyLogs(
      { hrv: null, resting_hr: null, recovery: null, sleep_score: null, strain: null },
      {
        0: { hrv: 63, resting_hr: 50, sleep_score: 75 },
        1: { hrv: 61, resting_hr: 51, sleep_score: 72 },
      },
    );

    const result = composeRecoveryReadiness(logs, baselines);

    expect(result.confidence).toBeLessThanOrEqual(0.4);
  });

  // ── Test 6: Null baselines → confidence capped 0.5 ──────────────────────
  it("caps confidence at 0.5 when baselines is null and mentions baseline establishing", () => {
    const logs = makeDailyLogs({
      hrv: 60,
      resting_hr: 52,
      recovery: 65,
      sleep_score: 72,
      strain: 10,
    });

    const result = composeRecoveryReadiness(logs, null);

    expect(result.confidence).toBeLessThanOrEqual(0.5);
    // Narrative should mention no baselines
    expect(result.narrative.toLowerCase()).toMatch(/baseline|establishing/);
  });

  // ── Test 7: Empty input → safe stalled default ───────────────────────────
  it("returns safe stalled default on empty dailyLogs without throwing", () => {
    expect(() => {
      const result = composeRecoveryReadiness([], null);
      expect(result.status).toBe("stalled");
      expect(result.confidence).toBe(0.3);
      expect(result.narrative).toMatch(/Not enough recent recovery data/i);
      expect(result.recommendation).toBe("continue_training");
    }).not.toThrow();
  });

  // ── Test 8: Validates against RecoveryReadinessResultSchema ─────────────
  it("output validates against RecoveryReadinessResultSchema for all cases", () => {
    const baselines = makeBaselines(62, 5, 50, 3);
    const cases = [
      // overreach
      makeDailyLogs({ hrv: 57, resting_hr: 56, recovery: 45, sleep_score: 68, strain: 12 }),
      // healthy
      makeDailyLogs({ hrv: 63, resting_hr: 50, recovery: 75, sleep_score: 82, strain: 10 }),
      // stalled
      makeDailyLogs({ hrv: 60.5, resting_hr: 51, recovery: 55, sleep_score: 65, strain: 11 }),
      // empty
      [],
    ];

    for (const logs of cases) {
      const result = composeRecoveryReadiness(logs, baselines);
      const parsed = RecoveryReadinessResultSchema.safeParse(result);
      if (!parsed.success) {
        throw new Error(
          `Schema validation failed: ${JSON.stringify(parsed.error.issues, null, 2)}`,
        );
      }
      expect(parsed.success).toBe(true);
    }
  });

  // ── Additional: HRV ≥7% drop sustained 3+ of last 5 days triggers warning ─
  it("triggers warning_overreach when HRV ≥7% drop confirmed signal on 3 of last 5 days", () => {
    // Baseline HRV = 65, SD = 5. -7% = ~60.45. isMeaningfulDeviation: |60 - 65| = 5 > 2.5 → signal
    const baselines = makeBaselines(65, 5, 55, 4);
    const logs = makeDailyLogs(
      { hrv: 62, resting_hr: 56, recovery: 58, sleep_score: 67, strain: 13 },
      {
        // days 0, 1, 2 = HRV ~8% below baseline and confirmed signal
        0: { hrv: 59 }, // |59-65|=6 > 2.5 → signal. 59/65 = 9.2% drop
        1: { hrv: 60 }, // |60-65|=5 > 2.5 → signal. 60/65 = 7.7% drop
        2: { hrv: 60 }, // signal, 7.7% drop
        3: { hrv: 65 }, // at baseline
        4: { hrv: 66 }, // at baseline
        5: { hrv: 64 },
        6: { hrv: 65 },
      },
    );

    const result = composeRecoveryReadiness(logs, baselines);

    expect(result.status).toBe("warning_overreach");
  });

  // ── Additional: strain spike is noted as a driver ────────────────────────
  it("notes a strain spike in drivers when last 1-2 days strain is above 7d mean", () => {
    const baselines = makeBaselines(62, 5, 50, 3);
    // All days have modest strain except last 2 which are very high
    const logs = makeDailyLogs(
      { hrv: 62, resting_hr: 50, recovery: 70, sleep_score: 78, strain: 8 },
      {
        0: { strain: 19 }, // spike
        1: { strain: 18 }, // spike
      },
    );

    const result = composeRecoveryReadiness(logs, baselines);
    // Strain spike alone doesn't set status to warning_overreach
    // but should appear in drivers
    const strainDriver = result.drivers.some((d) => d.toLowerCase().includes("strain"));
    expect(strainDriver).toBe(true);
  });

  // ── Additional: null baselines uses only absolute thresholds ─────────────
  it("falls back to absolute thresholds (sleep_score) when baselines null", () => {
    // sleep_score < 60 action threshold; without baselines, can't check HRV/RHR deviation
    const logs = makeDailyLogs({
      hrv: 55,
      resting_hr: 60,
      recovery: 30,
      sleep_score: 55, // < 60 → action
      strain: 9,
    });

    const result = composeRecoveryReadiness(logs, null);

    // Should pick up on poor sleep_score even without baselines
    expect(result.status).not.toBe("recovering_well");
    expect(result.confidence).toBeLessThanOrEqual(0.5);
  });

  // ── Additional: HRV signal drop combined with sleep <60 → warning_overreach ──
  it("returns warning_overreach when HRV confirmed signal drop AND sleep_score < 60", () => {
    // HRV signal drop (not necessarily 7%+) combined with sleep <60 = warning_overreach per spec
    const baselines = makeBaselines(62, 4, 50, 3);
    const logs = makeDailyLogs({
      hrv: 55, // |55-62|=7 > 0.5*4=2 → confirmed signal (~11% drop)
      resting_hr: 52, // slightly elevated but under +5 threshold
      recovery: 40,
      sleep_score: 55, // < 60
      strain: 10,
    });

    const result = composeRecoveryReadiness(logs, baselines);

    expect(result.status).toBe("warning_overreach");
    expect(result.recommendation).toBe("consider_deload");
  });
});
