/**
 * Reactive autoregulation rung selector
 *
 * Given today's soreness signals + recent activity load + session muscle regions,
 * picks the mildest sufficient intervention from the graded ladder:
 *
 *   none → load_down → volume_down → swap_exercise → swap_day
 *
 * Decision is purely deterministic — no AI calls, no side effects.
 *
 * ─── Threshold table (severity × intensity → rung) ───────────────────────────
 *
 * SORENESS PATH
 *   mild, no other stressors              → load_down
 *   mild + (some fatigue OR moderate act) → volume_down
 *   sharp, on non-primary region          → swap_exercise
 *   sharp, on PRIMARY region              → swap_day
 *   sharp + heavy fatigue (any region)    → swap_day  (fatigue override)
 *
 * RECENT ACTIVITY PATH (withinRecoveryWindow = true, regions overlap session)
 *   light                                 → load_down
 *   moderate                              → volume_down
 *   hard, partial overlap (< all session primary) → swap_exercise
 *   hard, heavy overlap (≥ 50 % of session regions covered) → swap_day
 *
 * COMBINED ESCALATION (max of soreness-path and activity-path rungs)
 *   mild + light  → load_down  (stays low)
 *   mild + hard   → escalated by activity path → swap_exercise / swap_day
 *   sharp + any   → already swap_exercise or swap_day; activity path cannot lower it
 *
 * GRACE RULE
 *   No overlapping soreness AND no in-window overlapping activity → none.
 *   This is load-bearing: avoids false positives on rest days.
 */

import { regionOverlap } from "./model";
import type { MuscleRegion, ActivityIntensity } from "./types";

// ─── public types ─────────────────────────────────────────────────────────────

export type ReactiveRung = "none" | "load_down" | "volume_down" | "swap_exercise" | "swap_day";

export interface RecentActivitySignal {
  regions: MuscleRegion[];
  intensity: ActivityIntensity;
  /** True when the activity's recovery window has not yet elapsed. */
  withinRecoveryWindow: boolean;
}

export interface ReactiveRungArgs {
  /** Muscle regions targeted by today's planned session. First element is primary. */
  sessionRegions: MuscleRegion[];
  /** Regions the athlete reported as sore during morning intake. */
  soreRegions: MuscleRegion[];
  /** "mild" = dull/diffuse, "sharp" = acute/sharp pain. null = none reported. */
  soreSeverity: "mild" | "sharp" | null;
  /** Self-reported systemic fatigue. */
  fatigue: "none" | "some" | "heavy" | null;
  /** Recent activities still inside their recovery window. */
  recentActivity: RecentActivitySignal[];
}

export interface ReactiveRungResult {
  rung: ReactiveRung;
  /** The muscle regions that triggered the escalation (empty for "none"). */
  regions: MuscleRegion[];
  /** Human-readable justification — always populated for non-"none" rungs. */
  rationale: string;
}

// ─── rung ordering ────────────────────────────────────────────────────────────

const RUNG_ORDER: ReactiveRung[] = ["none", "load_down", "volume_down", "swap_exercise", "swap_day"];

function rungLevel(r: ReactiveRung): number {
  return RUNG_ORDER.indexOf(r);
}

function higherRung(a: ReactiveRung, b: ReactiveRung): ReactiveRung {
  return rungLevel(a) >= rungLevel(b) ? a : b;
}

// ─── soreness path ────────────────────────────────────────────────────────────

interface SorenessPathResult {
  rung: ReactiveRung;
  affectedRegions: MuscleRegion[];
  reason: string;
}

function evaluateSorenessPath(args: ReactiveRungArgs): SorenessPathResult {
  const { sessionRegions, soreRegions, soreSeverity, fatigue } = args;

  // No soreness reported
  if (!soreSeverity || soreRegions.length === 0) {
    return { rung: "none", affectedRegions: [], reason: "" };
  }

  const overlap = regionOverlap(soreRegions, sessionRegions);
  if (overlap.length === 0) {
    // Soreness doesn't touch today's session regions — no impact
    return { rung: "none", affectedRegions: [], reason: "" };
  }

  const heavyFatigue = fatigue === "heavy";
  const someFatigue = fatigue === "some";
  const primaryRegion = sessionRegions[0];
  const hitsPRIMARY = overlap.includes(primaryRegion);

  if (soreSeverity === "sharp") {
    // Sharp on primary, or any sharp + heavy fatigue → swap the entire day
    if (hitsPRIMARY || heavyFatigue) {
      return {
        rung: "swap_day",
        affectedRegions: overlap,
        reason: heavyFatigue
          ? `Sharp soreness in ${overlap.join(", ")} combined with heavy systemic fatigue — too risky to train.`
          : `Sharp soreness in primary session region (${primaryRegion}) — session cannot proceed safely.`,
      };
    }
    // Sharp on a non-primary region → swap the affected exercise(s)
    return {
      rung: "swap_exercise",
      affectedRegions: overlap,
      reason: `Sharp soreness in ${overlap.join(", ")} — substitute exercises loading those regions.`,
    };
  }

  // Mild soreness from here
  // Mild + some fatigue → volume_down
  if (someFatigue || heavyFatigue) {
    return {
      rung: "volume_down",
      affectedRegions: overlap,
      reason: `Mild soreness in ${overlap.join(", ")} combined with ${fatigue} fatigue — reduce volume.`,
    };
  }

  // Mild, no extra fatigue → load_down
  return {
    rung: "load_down",
    affectedRegions: overlap,
    reason: `Mild soreness in ${overlap.join(", ")} — reduce load on affected exercises.`,
  };
}

// ─── recent activity path ─────────────────────────────────────────────────────

interface ActivityPathResult {
  rung: ReactiveRung;
  affectedRegions: MuscleRegion[];
  reason: string;
}

function evaluateActivityPath(args: ReactiveRungArgs): ActivityPathResult {
  const { sessionRegions } = args;

  // Filter to activities that are: (a) within window AND (b) regions overlap session
  const relevant = args.recentActivity.filter((a) => {
    if (!a.withinRecoveryWindow) return false;
    return regionOverlap(a.regions, sessionRegions).length > 0;
  });

  if (relevant.length === 0) {
    return { rung: "none", affectedRegions: [], reason: "" };
  }

  // Accumulate the worst-case rung across all relevant activities
  let worstRung: ReactiveRung = "none";
  let worstRegions: MuscleRegion[] = [];
  let worstReason = "";

  for (const act of relevant) {
    const overlap = regionOverlap(act.regions, sessionRegions);

    let rung: ReactiveRung;
    let reason: string;

    if (act.intensity === "light") {
      rung = "load_down";
      reason = `Light activity still in recovery window — reduce loads on ${overlap.join(", ")}.`;
    } else if (act.intensity === "moderate") {
      rung = "volume_down";
      reason = `Moderate activity still in recovery window — reduce volume on ${overlap.join(", ")}.`;
    } else {
      // hard intensity
      // "Heavily overlapping" = the activity covers > 50 % of the session's regions
      // (strict majority — ties such as 1/2 are still only partial → swap_exercise).
      // The primary-region shortcut lives on the soreness path only; the activity
      // path uses a straight ratio test so a single-region hit on a 2+ region session
      // is treated as partial overlap, not a full-day block.
      const overlapRatio = overlap.length / sessionRegions.length;
      if (overlapRatio > 0.5) {
        rung = "swap_day";
        reason = `Hard activity still in recovery window — regions ${overlap.join(", ")} heavily overlap today's session.`;
      } else {
        rung = "swap_exercise";
        reason = `Hard activity still in recovery window — substitute exercises loading ${overlap.join(", ")}.`;
      }
    }

    if (rungLevel(rung) > rungLevel(worstRung)) {
      worstRung = rung;
      worstRegions = overlap;
      worstReason = reason;
    }
  }

  return { rung: worstRung, affectedRegions: worstRegions, reason: worstReason };
}

// ─── combined escalation: soreness × activity ─────────────────────────────────
//
// When both signals are present, an activity signal can escalate a soreness-based rung
// (e.g. mild soreness + hard overlapping activity → swap_exercise or swap_day).
// The final rung is max(soreness-path, activity-path).
//
// Exception: a non-null activity rung combined with mild soreness caps at the
// activity rung (activity can only raise, not lower).

// ─── main export ──────────────────────────────────────────────────────────────

/**
 * Select the mildest sufficient reactive rung given today's physiological signals.
 *
 * Pure function — no I/O, no side effects.
 */
export function selectReactiveRung(args: ReactiveRungArgs): ReactiveRungResult {
  const { sessionRegions } = args;

  // Guard: empty session means no intervention possible
  if (sessionRegions.length === 0) {
    return { rung: "none", regions: [], rationale: "No session regions specified." };
  }

  const sorenessResult = evaluateSorenessPath(args);
  const activityResult = evaluateActivityPath(args);

  // Take the higher of the two independent paths
  const finalRung = higherRung(sorenessResult.rung, activityResult.rung);

  if (finalRung === "none") {
    return { rung: "none", regions: [], rationale: "No overlapping signals — train as planned." };
  }

  // Combine affected regions from both paths (union, preserving insertion order)
  const regionSet = new Set<MuscleRegion>([
    ...sorenessResult.affectedRegions,
    ...activityResult.affectedRegions,
  ]);
  const regions = Array.from(regionSet);

  // Use the reason from whichever path produced the final (highest) rung
  const rationale =
    rungLevel(sorenessResult.rung) >= rungLevel(activityResult.rung)
      ? sorenessResult.reason
      : activityResult.reason;

  return { rung: finalRung, regions, rationale };
}
