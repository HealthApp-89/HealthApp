// lib/coach/endurance/compose-z2-base.ts — Phase 1 prescription composer.
// Produces a Z2-only week from threshold HR + weekly volume target.
// Output is the same EnduranceSessionPlan shape Phase 2 composers will return.

import { defaultZ2Cap, derivedHrZones } from "./hr-zones";
import type {
  EnduranceProfile,
  EnduranceSessionEntry,
  EnduranceSessionPlan,
} from "./types";

export type ComposerInput = {
  profile: EnduranceProfile;
  /** Weekday number 0=Sun..6=Sat for the prescribed Z2 day. Phase 1 default: 3 (Wed). */
  preferredDay?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
};

export type ComposerResult =
  | { ok: true; plan: EnduranceSessionPlan; rationale: string }
  | { ok: false; reason: string };

/**
 * Phase 1 composer rules:
 *  - Discipline: cycling only (running/triathlon → not implemented).
 *  - Phase: aerobic_base only (other phases → not implemented).
 *  - Total prescribed minutes = weekly_volume_target_hours * 60.
 *  - Split into 60-min Z2 rides, capped at 5 rides/wk.
 *    At 1h target → 1 × 60min. At 4h → 4 × 60min. At 90min target → 1 × 90min.
 *  - HR cap = profile.threshold_hr * 0.83 (defaultZ2Cap) when threshold_hr set;
 *    otherwise plan still produced but hr_cap omitted (caller flags calibration).
 *  - Days chosen starting from preferredDay (default Wed), spread evenly across the week.
 */
export function composeZ2Base(input: ComposerInput): ComposerResult {
  const { profile, preferredDay = 3 } = input;
  if (profile.discipline !== "cycling") {
    return { ok: false, reason: `Composer Phase 1 supports cycling only; got ${profile.discipline}` };
  }
  if (profile.phase !== "aerobic_base") {
    return { ok: false, reason: `Composer Phase 1 supports aerobic_base only; got ${profile.phase}` };
  }
  const totalMinutes = Math.round(profile.weekly_volume_target_hours * 60);
  if (totalMinutes <= 0) {
    return { ok: false, reason: "weekly_volume_target_hours must be > 0" };
  }

  // Decide number of sessions: prefer 60min/session, cap at 5/wk.
  const PREFERRED_SESSION_MIN = 60;
  const maxSessions = 5;
  const sessionCount = Math.min(maxSessions, Math.max(1, Math.round(totalMinutes / PREFERRED_SESSION_MIN)));
  const perSession = Math.round(totalMinutes / sessionCount);

  // Spread days starting from preferredDay, every ⌈7/n⌉ days.
  const stride = Math.max(1, Math.floor(7 / sessionCount));
  const days: (0|1|2|3|4|5|6)[] = [];
  for (let i = 0; i < sessionCount; i += 1) {
    days.push(((preferredDay + i * stride) % 7) as 0|1|2|3|4|5|6);
  }

  const hrCap = profile.threshold_hr ? defaultZ2Cap(profile.threshold_hr) : undefined;
  const z2Range = profile.threshold_hr ? derivedHrZones(profile.threshold_hr).z2 : undefined;

  const entry: EnduranceSessionEntry = {
    type: "z2_ride",
    sport: "cycling",
    duration_min: perSession,
    ...(hrCap !== undefined ? { hr_cap: hrCap } : {}),
    ...(z2Range !== undefined ? { hr_target_range: z2Range } : {}),
    description:
      `${perSession}min Z2 ride` +
      (z2Range ? `, HR ${z2Range[0]}-${z2Range[1]}` : ", HR uncalibrated") +
      ", fat oxidation + aerobic base.",
  };

  const plan: EnduranceSessionPlan = {};
  for (const d of days) plan[d] = entry;

  return {
    ok: true,
    plan,
    rationale:
      `${sessionCount} session${sessionCount > 1 ? "s" : ""} × ${perSession}min Z2 cycling = ${sessionCount * perSession}min/wk ` +
      `(target ${totalMinutes}min). Z2 only at this phase — fat oxidation + mitochondrial density.`,
  };
}
