// lib/morning/brief/flags.ts
//
// Deterministic flag computation for the morning brief AI advice prompt.
// Each flag is one threshold check or regex match against the inputs.
// Adding a new flag in v1.1 is two lines: one here (compute) + one in
// advice-prompt.ts (describe when AI mentions it).

import type {
  AdviceFlags,
  AthleteProfileDocument,
  MorningBriefCard,
  MuscleVolumeFlag,
  MuscleVolumeSnapshot,
  StrengthMuscleVolume,
  WeeklyReviewRow,
} from "@/lib/data/types";
import { TARGETED_MUSCLE_GROUPS } from "@/lib/data/types";
import {
  evaluateMuscleVolumeGap,
  rankMuscleVolumeFlags,
} from "@/lib/coach/muscle-volume";
import type { TodayTargets } from "@/lib/morning/brief/get-today-targets";

/** Matches GLP-1 + brand-name variants. Case-insensitive, word-boundaries
 *  on the abbreviation so "GLPNotADrug" doesn't fire. Also exported for
 *  the /profile regenerate-with-GLP-1 CTA gate — single source of truth so
 *  both surfaces detect the same medications. */
export const GLP1_MED_REGEX =
  /\b(glp[-\s]?1|ozempic|wegovy|mounjaro|zepbound|semaglutide|tirzepatide|liraglutide|saxenda)\b/i;
const GLP1_REGEX = GLP1_MED_REGEX;

export type FlagInputs = {
  activeProfile: AthleteProfileDocument | null;
  /** A partially-assembled card — needs readiness.band and recap.protein_actual_g
   *  + macros.protein_target_g; doesn't need advice_md. */
  card: Omit<MorningBriefCard, "advice_md">;
  /** Pass the result of getTodayTargets() so the glp1 flag can read mode +
   *  deficit alarm state without re-querying daily_logs. null when no active
   *  athlete profile exists. */
  targets: TodayTargets | null;
  /** THIS week's committed weekly_review for this user (if any). Used to
   *  derive phase_transition_this_week by comparing block_phase_now to
   *  the previous committed review's block_phase_now. */
  thisWeekCommittedReview?: WeeklyReviewRow | null;
  /** The previous-week committed weekly_review (if any). Used for the
   *  same comparison. Null when no prior review exists. */
  previousCommittedReview?: WeeklyReviewRow | null;
};

/** Computes the structured GLP-1 flag from the athlete profile's health.glp1_status
 *  (for active/medication/dose) and TodayTargets (for mode + deficit alarm state).
 *
 *  When glp1_status is absent, `active` is false but `mode` is still threaded
 *  through so Task 6 can branch on classical + diet_break. */
function computeGlp1Flag(
  activeProfile: AthleteProfileDocument | null,
  targets: TodayTargets | null,
): AdviceFlags["glp1"] {
  const status = activeProfile?.intake_payload.health.glp1_status ?? null;
  if (!status) {
    return {
      active: false,
      medication: null,
      dose_mg: null,
      mode: targets?.mode ?? null,
      deficit_alarm_triggered: false,
      rolling_7d_avg_deficit: null,
    };
  }
  return {
    active: true,
    medication: status.medication,
    dose_mg: status.dose_mg,
    mode: targets?.mode ?? null,
    deficit_alarm_triggered: targets?.deficit_alarm?.triggered ?? false,
    rolling_7d_avg_deficit: targets?.deficit_alarm?.rolling_7d_avg_deficit ?? null,
  };
}

export function computeAdviceFlags(inputs: FlagInputs): AdviceFlags {
  const meds = inputs.activeProfile?.intake_payload.health.medications ?? "";
  const drinks = inputs.activeProfile?.intake_payload.nutrition.alcohol_drinks_per_week ?? 0;
  const injuries = inputs.activeProfile?.intake_payload.health.active_injuries ?? [];
  const bedtime = inputs.activeProfile?.intake_payload.sleep_recovery.typical_bedtime;
  const wakeTime = inputs.activeProfile?.intake_payload.sleep_recovery.typical_wake_time;
  const avgSleep = inputs.activeProfile?.intake_payload.sleep_recovery.avg_sleep_hours ?? 0;

  const timeInBed = computeTimeInBed(bedtime, wakeTime);
  const poor_sleep_efficiency =
    timeInBed !== null && avgSleep > 0 && timeInBed - avgSleep > 1;

  const proteinTarget = inputs.card.macros.protein_target_g;
  const proteinActual = inputs.card.recap.protein_actual_g;
  const missed_protein_yesterday =
    proteinActual !== null && proteinTarget > 0 && proteinActual < proteinTarget * 0.9;

  // GLP-1 detection falls back to medication-string regex when glp1_status is
  // absent (older profiles captured before the structured field existed).
  const glp1Flag = computeGlp1Flag(inputs.activeProfile, inputs.targets);
  const glp1Active = glp1Flag.active || GLP1_REGEX.test(meds);

  return {
    glp1: { ...glp1Flag, active: glp1Active },
    alcohol_low_readiness_warning: drinks > 0 && inputs.card.readiness.band === "low",
    has_active_injuries: injuries.length > 0,
    poor_sleep_efficiency,
    missed_protein_yesterday,
    coach_swap_suggested: inputs.card.coach_suggestion?.kind === "swap_to_mobility",
    phase_transition_this_week:
      inputs.thisWeekCommittedReview && inputs.previousCommittedReview
        ? inputs.thisWeekCommittedReview.payload.header.block_phase_now !==
          inputs.previousCommittedReview.payload.header.block_phase_now
        : inputs.thisWeekCommittedReview != null,
        // No previous review = first ever committed week = treat as transition.
  };
}

/** Evaluate all 10 targeted muscle groups; return the top 2 flags ranked by
 *  urgency. Caller embeds these in the Advice prompt + session-block UI. */
export function evaluateMuscleVolumeGapsForBrief(args: {
  snapshot: MuscleVolumeSnapshot;
  muscleVolume: StrengthMuscleVolume | null;
  currentBlockWeek: number | null;
  isTrainingDay: boolean;
  todayWeekday: "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";
  daysLeftInWeek: number;
}): MuscleVolumeFlag[] {
  const {
    snapshot,
    muscleVolume,
    currentBlockWeek,
    isTrainingDay,
    todayWeekday,
    daysLeftInWeek,
  } = args;

  if (!muscleVolume) return [];

  const allFlags: MuscleVolumeFlag[] = [];
  for (const g of TARGETED_MUSCLE_GROUPS) {
    const flag = evaluateMuscleVolumeGap(
      g,
      snapshot.rolling_avg_8wk[g],
      snapshot.current_week_to_date[g],
      muscleVolume.bands[g],
      muscleVolume.ramp_recipe,
      currentBlockWeek ?? 3, // mid-block default when no active block
      daysLeftInWeek,
      isTrainingDay,
      todayWeekday,
    );
    if (flag) allFlags.push(flag);
  }

  return rankMuscleVolumeFlags(allFlags).slice(0, 2);
}

/** Returns time in bed in hours, accounting for crossing midnight.
 *  Returns null if either timestamp is missing or malformed. */
function computeTimeInBed(
  bedtime: string | undefined,
  wakeTime: string | undefined,
): number | null {
  if (!bedtime || !wakeTime) return null;
  const bParts = bedtime.split(":");
  const wParts = wakeTime.split(":");
  if (bParts.length !== 2 || wParts.length !== 2) return null;
  const bh = Number(bParts[0]);
  const bm = Number(bParts[1]);
  const wh = Number(wParts[0]);
  const wm = Number(wParts[1]);
  if ([bh, bm, wh, wm].some((n) => !Number.isFinite(n))) return null;
  let minutesInBed = (wh * 60 + wm) - (bh * 60 + bm);
  if (minutesInBed < 0) minutesInBed += 24 * 60; // crossed midnight
  return minutesInBed / 60;
}
