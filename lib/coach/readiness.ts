import type { DailyLog } from "@/lib/data/types";
import { SESSION_PLANS, getTodaySession, type PlannedExercise } from "./sessionPlans";

const HRV_BASELINE_DEFAULT = 33;

export type FeelInput = {
  readiness: number | null; // 1-10
  energyLabel: string | null; // Low / Medium / High
  mood: string | null;
  soreness: string | null;
  notes: string | null;
};

export type ReadinessSummary = {
  score: number;
  whoopScore: number;
  feelScore: number | null;
  hrv: number;
  whoopRecovery: number;
  sleep: number;
  feelRaw: number;
  hasFeel: boolean;
};

export type IntensityMode = {
  label: string;
  color: string;
  multiplier: number;
  desc: string;
};

export type DailyPlan = {
  readiness: ReadinessSummary;
  mode: IntensityMode;
  sessionType: string;
  exercises: (PlannedExercise & {
    target: string;
    adjKg?: number;
    adjReps?: number;
    adjusted?: boolean;
    isPRAttempt?: boolean;
  })[];
};

export function computeDailyReadiness(
  log: Pick<DailyLog, "hrv" | "sleep_score" | "recovery"> | null,
  feel: FeelInput | null,
  hrvBaseline = HRV_BASELINE_DEFAULT,
): ReadinessSummary {
  const hrv = log?.hrv ?? 0;
  const sleep = log?.sleep_score ?? 0;
  const whoopRecovery = log?.recovery ?? 0;
  const feelScore = feel?.readiness ?? 0;

  const hrvScore = hrv > 0 ? Math.min(100, (hrv / hrvBaseline) * 80) : 0;
  const whoopScore = hrvScore * 0.4 + whoopRecovery * 0.4 + sleep * 0.2;
  const feelPct = feelScore > 0 ? (feelScore / 10) * 100 : null;
  const combined = feelPct !== null ? whoopScore * 0.65 + feelPct * 0.35 : whoopScore;

  return {
    score: Math.round(combined),
    whoopScore: Math.round(whoopScore),
    feelScore: feelPct !== null ? Math.round(feelPct) : null,
    hrv,
    whoopRecovery,
    sleep,
    feelRaw: feelScore,
    hasFeel: feelScore > 0,
  };
}

export function getIntensityMode(readiness: ReadinessSummary, feel: FeelInput | null): IntensityMode {
  const s = readiness.score;
  const sorenessLen = (feel?.soreness ?? "").length;
  const hasMuscleWarning = sorenessLen > 5;

  if (s >= 80 && !hasMuscleWarning) {
    return {
      label: "⚡ PUSH HARD",
      color: "#4ade80",
      multiplier: 1.0,
      desc: "Peak readiness — go for PRs on your primary lifts today.",
    };
  }
  if (s >= 65) {
    return {
      label: "🟢 FULL SESSION",
      color: "#86efac",
      multiplier: 0.95,
      desc: "Good readiness — train at full intensity, stop 1 rep shy of failure.",
    };
  }
  if (s >= 50) {
    return {
      label: "🟡 MODERATE",
      color: "#fbbf24",
      multiplier: 0.85,
      desc: "Moderate readiness — reduce working weight by 10–15%, focus on form.",
    };
  }
  if (s >= 35) {
    return {
      label: "🔴 LIGHT / RECOVERY",
      color: "#f87171",
      multiplier: 0.7,
      desc: "Low readiness — keep it light, high reps, no failure. Mobility priority.",
    };
  }
  return {
    label: "⚫ REST DAY",
    color: "#6b7280",
    multiplier: 0,
    desc: "Body needs rest. Skip training or do gentle mobility only.",
  };
}

export function buildDailyPlan(
  log: Pick<DailyLog, "hrv" | "sleep_score" | "recovery"> | null,
  feel: FeelInput | null,
  hrvBaseline?: number,
): DailyPlan {
  const readiness = computeDailyReadiness(log, feel, hrvBaseline);
  const mode = getIntensityMode(readiness, feel);
  const sessionType = getTodaySession();
  const exercises = (SESSION_PLANS[sessionType] ?? []).map((ex) => {
    if (!ex.baseKg) {
      return { ...ex, target: ex.reps ?? "—", adjusted: false };
    }
    const adjKg =
      mode.multiplier === 0 ? 0 : Math.round(ex.baseKg * mode.multiplier * 2) / 2;
    const adjReps =
      mode.multiplier >= 0.85
        ? ex.baseReps!
        : Math.round((ex.baseReps ?? 8) * 1.2);
    const target = mode.multiplier === 0 ? "Skip" : `${adjKg}kg × ${adjReps} × ${ex.sets ?? 3}`;
    const isPRAttempt = mode.multiplier >= 1.0;
    return {
      ...ex,
      target,
      adjKg,
      adjReps,
      adjusted: adjKg !== ex.baseKg,
      isPRAttempt,
    };
  });
  return { readiness, mode, sessionType, exercises };
}
