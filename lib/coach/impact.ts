import type { DailyLog } from "@/lib/data/types";

export type ImpactSign = "positive" | "neutral" | "negative";

export type ImpactKey =
  | "hrv"
  | "rhr"
  | "recovery"
  | "sleep"
  | "steps"
  | "strain"
  | "protein"
  | "calories";

export type ImpactSegment = {
  key: ImpactKey;
  label: string;
  /** Sign: positive helps today's readiness, negative drags it down. Neutral
   *  is in-band (or missing — sign is "neutral" with value=null). */
  sign: ImpactSign;
  /** 0..1 — how strongly the metric is helping/hurting. Drives stroke opacity. */
  magnitude: number;
  /** Hex string. Positive uses the metric's vivid palette color; negative is
   *  red; neutral grey. UI consumes directly so no theme wiring needed. */
  color: string;
  /** Raw value (or null if the column is missing today). Shown on hover/drill. */
  value: number | null;
  /** Short human-readable reason — e.g. "above 7.5h target". */
  reason: string;
};

export type ImpactResult = {
  segments: ImpactSegment[];
  positiveCount: number;
  negativeCount: number;
  /** Net signal in -1..1. Positive = today is helping; negative = dragging. */
  net: number;
};

const COLOR_POSITIVE: Record<ImpactKey, string> = {
  hrv: "#00f5c4",
  rhr: "#00f5c4",
  recovery: "#6bcb77",
  sleep: "#a29bfe",
  steps: "#00f5c4",
  strain: "#ff9f43",
  protein: "#ff6f91",
  calories: "#ffd93d",
};

const COLOR_NEGATIVE = "#ff6b6b";
const COLOR_NEUTRAL = "#5a6478";

const LABELS: Record<ImpactKey, string> = {
  hrv: "HRV",
  rhr: "Resting HR",
  recovery: "Recovery",
  sleep: "Sleep",
  steps: "Steps",
  strain: "Strain",
  protein: "Protein",
  calories: "Calories",
};

/** Clamp x to [lo, hi]. */
function clamp(x: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, x));
}

function neutralSegment(key: ImpactKey, reason: string): ImpactSegment {
  return {
    key,
    label: LABELS[key],
    sign: "neutral",
    magnitude: 0,
    color: COLOR_NEUTRAL,
    value: null,
    reason,
  };
}

function classifyHRV(v: number | null, baseline: number): ImpactSegment {
  if (v === null) return neutralSegment("hrv", "no data");
  const ratio = v / baseline;
  if (ratio >= 0.95) {
    return {
      key: "hrv",
      label: LABELS.hrv,
      sign: "positive",
      magnitude: clamp((ratio - 0.95) * 4, 0.4, 1), // 0.95→0.4, 1.2→1.0
      color: COLOR_POSITIVE.hrv,
      value: v,
      reason: `${Math.round(ratio * 100)}% of baseline`,
    };
  }
  if (ratio < 0.8) {
    return {
      key: "hrv",
      label: LABELS.hrv,
      sign: "negative",
      magnitude: clamp((0.8 - ratio) * 3.3, 0.4, 1),
      color: COLOR_NEGATIVE,
      value: v,
      reason: `${Math.round(ratio * 100)}% of baseline`,
    };
  }
  return { ...neutralSegment("hrv", "within range"), value: v };
}

function classifyRHR(v: number | null): ImpactSegment {
  if (v === null) return neutralSegment("rhr", "no data");
  if (v <= 60) {
    return {
      key: "rhr",
      label: LABELS.rhr,
      sign: "positive",
      magnitude: clamp((60 - v) / 15 + 0.4, 0.4, 1), // 60→0.4, 45+→1.0
      color: COLOR_POSITIVE.rhr,
      value: v,
      reason: `${Math.round(v)} bpm`,
    };
  }
  if (v > 70) {
    return {
      key: "rhr",
      label: LABELS.rhr,
      sign: "negative",
      magnitude: clamp((v - 70) / 15 + 0.4, 0.4, 1),
      color: COLOR_NEGATIVE,
      value: v,
      reason: `${Math.round(v)} bpm — elevated`,
    };
  }
  return { ...neutralSegment("rhr", "within band"), value: v };
}

function classifyRecovery(v: number | null): ImpactSegment {
  if (v === null) return neutralSegment("recovery", "no data");
  if (v >= 67) {
    return {
      key: "recovery",
      label: LABELS.recovery,
      sign: "positive",
      magnitude: clamp((v - 67) / 33 + 0.4, 0.4, 1), // 67→0.4, 100→1.0
      color: COLOR_POSITIVE.recovery,
      value: v,
      reason: `${Math.round(v)}% — green`,
    };
  }
  if (v < 34) {
    return {
      key: "recovery",
      label: LABELS.recovery,
      sign: "negative",
      magnitude: clamp((34 - v) / 34 + 0.4, 0.4, 1),
      color: COLOR_NEGATIVE,
      value: v,
      reason: `${Math.round(v)}% — red`,
    };
  }
  return { ...neutralSegment("recovery", `${Math.round(v)}% — yellow`), value: v };
}

function classifySleep(score: number | null, hours: number | null): ImpactSegment {
  // Prefer score (0-100 from WHOOP); fall back to hours vs 7.5h target.
  if (score != null) {
    if (score >= 80) {
      return {
        key: "sleep",
        label: LABELS.sleep,
        sign: "positive",
        magnitude: clamp((score - 80) / 20 + 0.4, 0.4, 1),
        color: COLOR_POSITIVE.sleep,
        value: score,
        reason: `score ${Math.round(score)}/100`,
      };
    }
    if (score < 60) {
      return {
        key: "sleep",
        label: LABELS.sleep,
        sign: "negative",
        magnitude: clamp((60 - score) / 60 + 0.4, 0.4, 1),
        color: COLOR_NEGATIVE,
        value: score,
        reason: `score ${Math.round(score)}/100`,
      };
    }
    return { ...neutralSegment("sleep", `score ${Math.round(score)}/100`), value: score };
  }
  if (hours != null) {
    if (hours >= 7.5) {
      return {
        key: "sleep",
        label: LABELS.sleep,
        sign: "positive",
        magnitude: clamp((hours - 7.5) / 1.5 + 0.4, 0.4, 1),
        color: COLOR_POSITIVE.sleep,
        value: hours,
        reason: `${hours.toFixed(1)} h — at/above target`,
      };
    }
    if (hours < 6) {
      return {
        key: "sleep",
        label: LABELS.sleep,
        sign: "negative",
        magnitude: clamp((6 - hours) / 3 + 0.4, 0.4, 1),
        color: COLOR_NEGATIVE,
        value: hours,
        reason: `${hours.toFixed(1)} h — under-slept`,
      };
    }
    return { ...neutralSegment("sleep", `${hours.toFixed(1)} h`), value: hours };
  }
  return neutralSegment("sleep", "no data");
}

function classifySteps(v: number | null): ImpactSegment {
  if (v === null) return neutralSegment("steps", "no data");
  if (v >= 8000) {
    return {
      key: "steps",
      label: LABELS.steps,
      sign: "positive",
      magnitude: clamp((v - 8000) / 7000 + 0.4, 0.4, 1), // 8k→0.4, 15k+→1.0
      color: COLOR_POSITIVE.steps,
      value: v,
      reason: `${Math.round(v).toLocaleString()} — past goal`,
    };
  }
  if (v < 3000) {
    return {
      key: "steps",
      label: LABELS.steps,
      sign: "negative",
      magnitude: clamp((3000 - v) / 3000 + 0.4, 0.4, 1),
      color: COLOR_NEGATIVE,
      value: v,
      reason: `${Math.round(v).toLocaleString()} — sedentary`,
    };
  }
  return {
    ...neutralSegment("steps", `${Math.round(v).toLocaleString()}`),
    value: v,
  };
}

function classifyStrain(strain: number | null, recovery: number | null): ImpactSegment {
  if (strain === null) return neutralSegment("strain", "no data");
  // Productive zone: 10-15 (moderate). Above 15 with low recovery = overreach.
  if (strain >= 10 && strain <= 15) {
    return {
      key: "strain",
      label: LABELS.strain,
      sign: "positive",
      magnitude: clamp((Math.min(strain, 13) - 10) / 3 + 0.4, 0.4, 1),
      color: COLOR_POSITIVE.strain,
      value: strain,
      reason: `${strain.toFixed(1)} — productive load`,
    };
  }
  if (strain > 15 && recovery !== null && recovery < 50) {
    return {
      key: "strain",
      label: LABELS.strain,
      sign: "negative",
      magnitude: clamp((strain - 15) / 6 + 0.4, 0.4, 1),
      color: COLOR_NEGATIVE,
      value: strain,
      reason: `${strain.toFixed(1)} on low recovery — overreach`,
    };
  }
  return {
    ...neutralSegment("strain", strain < 5 ? `${strain.toFixed(1)} — light` : `${strain.toFixed(1)}`),
    value: strain,
  };
}

function classifyProtein(g: number | null, weightKg: number | null): ImpactSegment {
  if (g === null) return neutralSegment("protein", "no data");
  if (weightKg === null) {
    return {
      ...neutralSegment("protein", `${Math.round(g)} g — weight unknown`),
      value: g,
    };
  }
  const target = 1.6 * weightKg;
  const yellowFloor = target * 0.85;
  if (g >= target) {
    return {
      key: "protein",
      label: LABELS.protein,
      sign: "positive",
      magnitude: clamp((g - target) / target + 0.4, 0.4, 1),
      color: COLOR_POSITIVE.protein,
      value: g,
      reason: `${Math.round(g)} / ${Math.round(target)} g target`,
    };
  }
  if (g >= yellowFloor) {
    return {
      ...neutralSegment(
        "protein",
        `${Math.round(g)} g — ${Math.round((1 - g / target) * 100)}% under target`,
      ),
      value: g,
    };
  }
  return {
    key: "protein",
    label: LABELS.protein,
    sign: "negative",
    magnitude: clamp((yellowFloor - g) / yellowFloor + 0.4, 0.4, 1),
    color: COLOR_NEGATIVE,
    value: g,
    reason: `${Math.round(g)} g — well under ${Math.round(target)} g target`,
  };
}

function classifyCalories(eaten: number | null, target: number | null): ImpactSegment {
  if (eaten === null) return neutralSegment("calories", "no data");
  if (target === null) {
    return {
      ...neutralSegment("calories", `${Math.round(eaten)} kcal — target unknown`),
      value: eaten,
    };
  }
  const ratio = eaten / target;
  // ±10% of target = green; ±10–20% = yellow; beyond ±20% = red.
  if (ratio >= 0.9 && ratio <= 1.1) {
    return {
      key: "calories",
      label: LABELS.calories,
      sign: "positive",
      // Strongest green at ratio=1.0, fades toward edges of the green band.
      magnitude: clamp(1 - Math.abs(1 - ratio) * 5, 0.4, 1),
      color: COLOR_POSITIVE.calories,
      value: eaten,
      reason: `${Math.round(eaten)} / ${Math.round(target)} kcal target`,
    };
  }
  const offPct = Math.round(Math.abs(ratio - 1) * 100);
  const dir = ratio < 1 ? "under" : "over";
  if (ratio >= 0.8 && ratio <= 1.2) {
    return {
      ...neutralSegment("calories", `${Math.round(eaten)} kcal — ${offPct}% ${dir}`),
      value: eaten,
    };
  }
  return {
    key: "calories",
    label: LABELS.calories,
    sign: "negative",
    magnitude: clamp((Math.abs(ratio - 1) - 0.2) * 3 + 0.4, 0.4, 1),
    color: COLOR_NEGATIVE,
    value: eaten,
    reason: `${Math.round(eaten)} kcal — ${offPct}% ${dir} target`,
  };
}

/** Deterministic per-metric impact classification for the dashboard donut.
 *  Pure function — no DB calls — so it can be unit-tested or memoised freely.
 *  Threshold sources are the same constants the rest of the app already uses
 *  (`hrvStatus`, `RecoveryBars`, the 7.5h sleep target, the 8000-step goal).
 *
 *  Returns segments in stable display order so the donut's ring layout is
 *  consistent across days. */
export function computeImpact(
  log: DailyLog | null,
  hrvBaseline: number,
  /** Most recent known weight (kg). Used as the protein-target denominator —
   *  falls back when today's row is missing weight. */
  weightKg: number | null = null,
  /** Daily kcal target (BMR × activity factor). Caller computes from profile. */
  calorieTarget: number | null = null,
): ImpactResult {
  const segments: ImpactSegment[] = log
    ? [
        classifyHRV(log.hrv, hrvBaseline),
        classifyRHR(log.resting_hr),
        classifyRecovery(log.recovery),
        classifySleep(log.sleep_score, log.sleep_hours),
        classifySteps(log.steps),
        classifyStrain(log.strain, log.recovery),
        classifyProtein(log.protein_g, weightKg ?? log.weight_kg),
        classifyCalories(log.calories_eaten, calorieTarget),
      ]
    : [
        neutralSegment("hrv", "no data"),
        neutralSegment("rhr", "no data"),
        neutralSegment("recovery", "no data"),
        neutralSegment("sleep", "no data"),
        neutralSegment("steps", "no data"),
        neutralSegment("strain", "no data"),
        neutralSegment("protein", "no data"),
        neutralSegment("calories", "no data"),
      ];

  let positiveCount = 0;
  let negativeCount = 0;
  let net = 0;
  for (const s of segments) {
    if (s.sign === "positive") {
      positiveCount += 1;
      net += s.magnitude;
    } else if (s.sign === "negative") {
      negativeCount += 1;
      net -= s.magnitude;
    }
  }
  net = clamp(net / segments.length, -1, 1);

  return { segments, positiveCount, negativeCount, net };
}
