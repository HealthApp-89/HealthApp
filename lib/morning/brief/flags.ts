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
} from "@/lib/data/types";

/** Matches GLP-1 + brand-name variants. Case-insensitive, word-boundaries
 *  on the abbreviation so "GLPNotADrug" doesn't fire. */
const GLP1_REGEX = /\b(glp[-\s]?1|ozempic|wegovy|mounjaro|zepbound|semaglutide|tirzepatide|liraglutide|saxenda)\b/i;

export type FlagInputs = {
  activeProfile: AthleteProfileDocument | null;
  /** A partially-assembled card — needs readiness.band and recap.protein_actual_g
   *  + macros.protein_target_g; doesn't need advice_md. */
  card: Omit<MorningBriefCard, "advice_md">;
};

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

  return {
    has_glp1: GLP1_REGEX.test(meds),
    alcohol_low_readiness_warning: drinks > 0 && inputs.card.readiness.band === "low",
    has_active_injuries: injuries.length > 0,
    poor_sleep_efficiency,
    missed_protein_yesterday,
  };
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
