import type { DailyLog } from "@/lib/data/types";
import { SESSION_PLANS, getTodaySession, type PlannedExercise } from "./sessionPlans";

const HRV_BASELINE_DEFAULT = 33;

export type FeelInput = {
  readiness: number | null; // 1-10
  energyLabel: string | null; // 'low' | 'medium' | 'high'
  mood: string | null;
  soreness: string | null;          // legacy free-text; readiness math no longer reads this
  notes: string | null;
  // 0007 additions
  sick: boolean;
  fatigue: "none" | "some" | "heavy" | null;
  sorenessAreas: string[] | null;
  sorenessSeverity: "mild" | "sharp" | null;
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

const MODE_REST: IntensityMode = {
  label: "⚫ REST DAY",
  color: "#6b7280",
  multiplier: 0,
  desc: "Body needs rest. Skip training or do gentle mobility only.",
};
const MODE_LIGHT: IntensityMode = {
  label: "🔴 LIGHT / RECOVERY",
  color: "#ff453a",
  multiplier: 0.7,
  desc: "Low readiness — keep it light, high reps, no failure. Mobility priority.",
};
const MODE_MODERATE: IntensityMode = {
  label: "🟡 MODERATE",
  color: "#ffd60a",
  multiplier: 0.85,
  desc: "Moderate readiness — reduce working weight by 10–15%, focus on form.",
};
const MODE_FULL: IntensityMode = {
  label: "🟢 FULL SESSION",
  color: "#86efac",
  multiplier: 0.95,
  desc: "Good readiness — train at full intensity, stop 1 rep shy of failure.",
};
const MODE_PUSH: IntensityMode = {
  label: "⚡ PUSH HARD",
  color: "#30d158",
  multiplier: 1.0,
  desc: "Peak readiness — go for PRs on your primary lifts today.",
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

  // Energy nudge: ±5% to feelPct based on self-reported energy. Capped at 100.
  // Lets "felt 8/10 with low energy" diverge from "felt 8/10 with high energy".
  const energyFactor =
    feel?.energyLabel === "low"  ? 0.9 :
    feel?.energyLabel === "high" ? 1.05 :
    1.0;
  const feelPctRaw = feelScore > 0 ? (feelScore / 10) * 100 : null;
  const feelPct = feelPctRaw !== null ? Math.min(100, feelPctRaw * energyFactor) : null;

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
  // Hard overrides — applied before any score band.
  if (feel?.sick) return MODE_REST;
  if (feel?.sorenessSeverity === "sharp") return MODE_LIGHT;
  if (feel?.fatigue === "heavy") return MODE_MODERATE;
  const mildAreas = feel?.sorenessAreas?.length ?? 0;
  if (feel?.sorenessSeverity === "mild" && mildAreas >= 3) return MODE_MODERATE;

  // Score-banded logic (unchanged from before — same thresholds).
  const s = readiness.score;
  if (s >= 80) return MODE_PUSH;
  if (s >= 65) return MODE_FULL;
  if (s >= 50) return MODE_MODERATE;
  if (s >= 35) return MODE_LIGHT;
  return MODE_REST;
}

export function buildDailyPlan(
  log: Pick<DailyLog, "hrv" | "sleep_score" | "recovery"> | null,
  feel: FeelInput | null,
  hrvBaseline?: number,
  override?: {
    sessionType?: string | null;
    intensityMultiplier?: number | null;
  },
): DailyPlan {
  const readiness = computeDailyReadiness(log, feel, hrvBaseline);
  const mode = getIntensityMode(readiness, feel);
  const sessionType = override?.sessionType ?? getTodaySession();
  const effectiveMult = override?.intensityMultiplier ?? mode.multiplier;
  const exercises = (SESSION_PLANS[sessionType] ?? []).map((ex) => {
    if (!ex.baseKg) {
      return { ...ex, target: ex.reps ?? "—", adjusted: false };
    }
    const adjKg =
      effectiveMult === 0 ? 0 : Math.round(ex.baseKg * effectiveMult * 2) / 2;
    const adjReps =
      effectiveMult >= 0.85
        ? ex.baseReps!
        : Math.round((ex.baseReps ?? 8) * 1.2);
    const target = effectiveMult === 0 ? "Skip" : `${adjKg}kg × ${adjReps} × ${ex.sets ?? 3}`;
    const isPRAttempt = effectiveMult >= 1.0;
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
