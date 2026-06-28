/**
 * Proactive week-sequencing planner (pure, deterministic, no I/O).
 *
 * Given the week's session plan, planned activities, available days, and
 * optional training block, detects muscle-region conflicts and emits:
 *   - proposedPlan  — rearranged day→session-type map (=== input when no move
 *                     possible or needed)
 *   - lightenDays   — weekday (short) → overlapping regions to trim load on
 *   - flags         — unresolvable conflicts for coach/athlete review
 *
 * Resolution ladder (per conflict):
 *   1. MOVE  — find a non-conflicting available day to swap/relocate the heavy
 *              session; mutate proposedPlan.
 *   2. LIGHTEN — no free slot; emit lightenDays entry for the conflicting day.
 *   3. FLAG  — conflict on multiple days with no escape; emit a flag.
 *
 * Conflict detection is bidirectional: a heavy session the day BEFORE an
 * activity falls within the activity's forward recovery window; a heavy session
 * the day AFTER an activity falls within the activity's backward recovery
 * window. Both directions are checked.
 */

import type { SessionPlan, TrainingBlock, Weekday } from "@/lib/data/types";
import type { PlannedActivity, MuscleRegion } from "./types";
import { activityRegions, recoveryWindowHours, regionOverlap } from "./model";

// ─────────────────────────────────────────────────────────────────────────────
// Session-type → loaded muscle regions (v1 local map).
// Derived from SESSION_PLANS exercise categories:
//   Legs   — barbell squat, leg press, hip thrust, RDL → legs + lower_back (hinges)
//   Chest  — bench press, OHP, lateral raise → chest + shoulders
//   Back   — deadlift (hinge), lat pulldown, rows → back + lower_back
//   Arms   — arnold press, curls, lateral raise → arms + shoulders
//   Mobility / REST — no significant load
// ─────────────────────────────────────────────────────────────────────────────
export const SESSION_REGION_MAP: Record<string, MuscleRegion[]> = {
  Legs: ["legs", "lower_back"],
  Chest: ["chest", "shoulders"],
  Back: ["back", "lower_back"],
  Arms: ["arms", "shoulders"],
  Mobility: [],
  REST: [],
};

/** Returns the loaded regions for a given session type (empty for unknown). */
function sessionRegions(sessionType: string): MuscleRegion[] {
  return SESSION_REGION_MAP[sessionType] ?? [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Weekday utilities
// ─────────────────────────────────────────────────────────────────────────────

const WEEKDAY_SHORT: Weekday[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const WEEKDAY_LONG = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** YYYY-MM-DD → short weekday ("Mon"…"Sun"). Monday-relative, ISO week. */
function dateToWeekday(dateIso: string): Weekday {
  const d = new Date(dateIso + "T12:00:00Z");
  // getUTCDay(): 0=Sun, 1=Mon, …, 6=Sat
  // Remap: Sun(0)→6, Mon(1)→0, …, Sat(6)→5
  const idx = (d.getUTCDay() + 6) % 7;
  return WEEKDAY_SHORT[idx];
}

/** 0=Mon … 6=Sun index from Weekday short name. */
function weekdayIndex(wd: Weekday): number {
  return WEEKDAY_SHORT.indexOf(wd);
}

/** Absolute difference in days between two weekday indices. Min of wrap vs direct. */
function daysBetween(idxA: number, idxB: number): number {
  const direct = Math.abs(idxA - idxB);
  return Math.min(direct, 7 - direct);
}

// ─────────────────────────────────────────────────────────────────────────────
// Priority: does the training block's primary lift live in this session?
// Used to increase separation priority for the athlete's main focus.
// ─────────────────────────────────────────────────────────────────────────────

/** Maps PrimaryLift strings to the session type that trains them primarily. */
const LIFT_SESSION: Record<string, string> = {
  squat: "Legs",
  deadlift: "Back",
  bench: "Chest",
  ohp: "Chest",
};

function isPrioritySession(sessionType: string, block: TrainingBlock | null | undefined): boolean {
  if (!block?.primary_lift) return false;
  return LIFT_SESSION[block.primary_lift] === sessionType;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export type ActivityConflictFlag = {
  /** The activity that caused the conflict. */
  activity: PlannedActivity;
  /** The session type that could not be moved or lightened. */
  sessionType: string;
  /** The weekday (short) of the session. */
  sessionDay: Weekday;
  /** Overlapping muscle regions. */
  overlapRegions: MuscleRegion[];
  /** Human-readable reason. */
  reason: string;
};

export type DaysAvailable = {
  mon: boolean;
  tue: boolean;
  wed: boolean;
  thu: boolean;
  fri: boolean;
  sat: boolean;
  sun: boolean;
};

export type ProposeLayoutArgs = {
  /** The committed session plan for the week (weekday→session-type). */
  sessionPlan: SessionPlan;
  /** Activities planned/detected for the same week. */
  plannedActivities: PlannedActivity[];
  /** Which weekdays the athlete is available to train. */
  daysAvailable: DaysAvailable;
  /** Active training block (used for priority gating). May be null/undefined. */
  block?: TrainingBlock | null;
  /** Today's date ISO string (YYYY-MM-DD), for context only. */
  today?: string;
};

export type ProposeLayoutResult = {
  proposedPlan: SessionPlan;
  /** Weekday short key → regions to trim from that session's volume. */
  lightenDays: Record<string, MuscleRegion[]>;
  flags: ActivityConflictFlag[];
};

// ─────────────────────────────────────────────────────────────────────────────
// DaysAvailable helpers
// ─────────────────────────────────────────────────────────────────────────────

const DAYS_AVAIL_KEYS: Array<keyof DaysAvailable> = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

function isDayAvailable(daysAvailable: DaysAvailable, wd: Weekday): boolean {
  const key = DAYS_AVAIL_KEYS[weekdayIndex(wd)];
  return daysAvailable[key] ?? false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Conflict detection
// ─────────────────────────────────────────────────────────────────────────────

type ConflictEntry = {
  sessionDay: Weekday;
  sessionType: string;
  overlapRegions: MuscleRegion[];
  activity: PlannedActivity;
  /** recoveryWindowHours for the activity — determines severity of the conflict. */
  windowHours: number;
  /** True when block.primary_lift lives in this session. */
  isPriority: boolean;
};

/**
 * Finds all conflicts between the session plan and planned activities.
 * A conflict occurs when:
 *   - A session loads muscle regions that overlap the activity's regions, AND
 *   - The session day is within the activity's recovery window (either
 *     direction: session before → activity stressed region hasn't recovered;
 *     session after → region stressed by activity hasn't recovered for lifting).
 */
function detectConflicts(
  plan: SessionPlan,
  activities: PlannedActivity[],
  block: TrainingBlock | null | undefined,
): ConflictEntry[] {
  const conflicts: ConflictEntry[] = [];

  for (const activity of activities) {
    const actDay = dateToWeekday(activity.date);
    const actIdx = weekdayIndex(actDay);
    const actRegs = activityRegions(activity.type);
    if (actRegs.length === 0) continue; // activity loads nothing (type=other)

    const windowHours = recoveryWindowHours(activity.type, activity.intensity_estimate);
    // Convert to fractional days for comparison (day difference × 24h/day).
    // A same-day session is 0 days apart (always within any window > 0h).
    const windowDays = windowHours / 24;

    for (const [wd, sessionType] of Object.entries(plan) as [Weekday, string][]) {
      if (!sessionType || sessionType === "REST" || sessionType === "Mobility") continue;

      const sesRegs = sessionRegions(sessionType);
      if (sesRegs.length === 0) continue;

      const overlap = regionOverlap(sesRegs, actRegs);
      if (overlap.length === 0) continue;

      const sesIdx = weekdayIndex(wd);
      const dist = daysBetween(actIdx, sesIdx);

      // Bidirectional check: within recovery window in either direction.
      if (dist < windowDays) {
        conflicts.push({
          sessionDay: wd,
          sessionType,
          overlapRegions: overlap,
          activity,
          windowHours,
          isPriority: isPrioritySession(sessionType, block),
        });
      }
    }
  }

  // Sort deterministically: by sessionDay index, then activity date.
  conflicts.sort((a, b) => {
    const dayDiff = weekdayIndex(a.sessionDay) - weekdayIndex(b.sessionDay);
    if (dayDiff !== 0) return dayDiff;
    return a.activity.date.localeCompare(b.activity.date);
  });

  return conflicts;
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolution: move
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tries to find an available day in the plan where the conflicting session can
 * be moved such that the move resolves ALL activity conflicts for that session.
 *
 * Rules:
 *  - The target day must be available (daysAvailable).
 *  - The target day must currently hold a REST or Mobility session (i.e., it's
 *    "free" to take over, or the current holder is non-conflicting).
 *  - After the move, the session must not conflict with any planned activity.
 *  - Prefer days with the smallest distance from the original (stability).
 *
 * Returns the target Weekday if found, or null.
 */
function findMoveTarget(
  conflictDay: Weekday,
  sessionType: string,
  currentPlan: SessionPlan,
  activities: PlannedActivity[],
  daysAvailable: DaysAvailable,
): Weekday | null {
  const candidates: Array<{ day: Weekday; dist: number }> = [];

  for (const wd of WEEKDAY_SHORT) {
    if (wd === conflictDay) continue;
    if (!isDayAvailable(daysAvailable, wd)) continue;

    // Target day must be free (REST or Mobility or unset).
    const existing = currentPlan[wd];
    if (existing && existing !== "REST" && existing !== "Mobility") continue;

    // After hypothetical move: does the session conflict with any activity?
    const sesIdx = weekdayIndex(wd);
    let hasConflict = false;

    for (const activity of activities) {
      const actDay = dateToWeekday(activity.date);
      const actIdx = weekdayIndex(actDay);
      const actRegs = activityRegions(activity.type);
      if (actRegs.length === 0) continue;

      const windowHours = recoveryWindowHours(activity.type, activity.intensity_estimate);
      const windowDays = windowHours / 24;
      const dist = daysBetween(sesIdx, actIdx);

      const overlap = regionOverlap(sessionRegions(sessionType), actRegs);
      if (overlap.length > 0 && dist < windowDays) {
        hasConflict = true;
        break;
      }
    }

    if (!hasConflict) {
      // Use linear (non-wrapping) distance so that Sun (idx=6) is not treated as
      // "close" to Mon (idx=0). Prefer forward moves within the same calendar week.
      const linearDist = Math.abs(weekdayIndex(conflictDay) - sesIdx);
      candidates.push({ day: wd, dist: linearDist });
    }
  }

  if (candidates.length === 0) return null;

  // Prefer the nearest free day by linear distance (stable moves), then
  // weekday index for determinism when distances are equal.
  candidates.sort((a, b) => {
    if (a.dist !== b.dist) return a.dist - b.dist;
    return weekdayIndex(a.day) - weekdayIndex(b.day);
  });

  return candidates[0].day;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────────────────

export function proposeActivityAwareLayout(args: ProposeLayoutArgs): ProposeLayoutResult {
  const { sessionPlan, plannedActivities, daysAvailable, block } = args;

  // GRACEFUL: no activities → return reference-equal proposedPlan, empty rest.
  if (plannedActivities.length === 0) {
    return {
      proposedPlan: sessionPlan,
      lightenDays: {},
      flags: [],
    };
  }

  // Work with a mutable copy of the plan.
  let proposedPlan: SessionPlan = { ...sessionPlan };

  const lightenDays: Record<string, MuscleRegion[]> = {};
  const flags: ActivityConflictFlag[] = [];

  // Detect initial conflicts.
  let conflicts = detectConflicts(proposedPlan, plannedActivities, block ?? null);

  if (conflicts.length === 0) {
    // No conflicts detected — return reference-equal to input.
    return {
      proposedPlan: sessionPlan,
      lightenDays: {},
      flags: [],
    };
  }

  // Process conflicts by session day, grouping multiple activities per day.
  // Use a Set to track which session days have already been resolved.
  const resolvedMoves = new Set<Weekday>();
  const lightened = new Set<Weekday>();
  const flagged = new Set<string>(); // `${sessionDay}:${activity.date}`

  // Iterate until no conflicts remain or we can no longer resolve.
  // We process each unique conflicting session day once.
  const processedDays = new Set<Weekday>();

  for (const conflict of conflicts) {
    const { sessionDay, sessionType, overlapRegions, activity } = conflict;

    if (processedDays.has(sessionDay)) {
      // Already attempted resolution for this day in this pass.
      // Check if it was moved away — if so, there's no session on this day anymore.
      if (!proposedPlan[sessionDay] || proposedPlan[sessionDay] === "REST") continue;
    }
    processedDays.add(sessionDay);

    // Verify conflict still exists in current proposedPlan (a prior move may have cleared it).
    const currentSession = proposedPlan[sessionDay];
    if (!currentSession || currentSession === "REST" || currentSession === "Mobility") continue;

    // Re-check actual overlap with current session type.
    const currentOverlap = regionOverlap(sessionRegions(currentSession), activityRegions(activity.type));
    if (currentOverlap.length === 0) continue;

    const windowDays = conflict.windowHours / 24;
    const dist = daysBetween(weekdayIndex(sessionDay), weekdayIndex(dateToWeekday(activity.date)));
    if (dist >= windowDays) continue; // No longer a conflict (e.g., after an earlier move shifted the plan).

    // ── Resolution ladder ──────────────────────────────────────────────────

    // 1. MOVE: find a free available slot outside all activity windows.
    if (!resolvedMoves.has(sessionDay)) {
      const targetDay = findMoveTarget(
        sessionDay,
        currentSession,
        proposedPlan,
        plannedActivities,
        daysAvailable,
      );

      if (targetDay !== null) {
        // Perform the swap: move session to targetDay, put REST on sessionDay.
        const displaced = proposedPlan[targetDay]; // "REST" / "Mobility" / undefined
        proposedPlan = {
          ...proposedPlan,
          [targetDay]: currentSession,
          [sessionDay]: displaced ?? "REST",
        };
        resolvedMoves.add(sessionDay);
        continue; // Move resolved this conflict.
      }
    }

    // 2. LIGHTEN: no free slot available. Accumulate regions per day.
    const key = `${sessionDay}:${activity.date}`;
    if (!flagged.has(key) && !lightened.has(sessionDay)) {
      // Check if this day was already lightened from a different activity.
      if (!lightenDays[sessionDay]) {
        lightenDays[sessionDay] = [];
      }
      // Merge overlap regions (deduplicate).
      for (const r of currentOverlap) {
        if (!lightenDays[sessionDay].includes(r)) {
          lightenDays[sessionDay].push(r);
        }
      }
      lightened.add(sessionDay);
    } else if (lightened.has(sessionDay)) {
      // Day already lightened — additional conflict with a DIFFERENT activity
      // means we have unavoidable adjacency from multiple directions → FLAG.
      const flagKey = `${sessionDay}:${activity.type}:${activity.date}`;
      if (!flagged.has(flagKey)) {
        flagged.add(flagKey);
        flags.push({
          activity,
          sessionType: currentSession,
          sessionDay,
          overlapRegions: currentOverlap,
          reason:
            `${currentSession} on ${sessionDay} overlaps ${activity.type} (${activity.intensity_estimate}) ` +
            `on ${activity.date} and cannot be moved. Multiple activity conflicts are unavoidable.`,
        });
      }
    }
  }

  // Post-pass: catch any unresolved conflicts on days NOT yet lightened or moved.
  // This handles the edge case where a session day was NOT processed in the first
  // pass because the conflict arose indirectly (e.g., a moved session landing
  // adjacent to a second activity). Already-lightened and already-moved days are
  // skipped — they were handled in the first pass.
  const remaining = detectConflicts(proposedPlan, plannedActivities, block ?? null);

  for (const conflict of remaining) {
    const { sessionDay, sessionType, overlapRegions, activity } = conflict;

    // Skip days already resolved by a move in the first pass (the new location
    // is conflict-free by construction; the old slot is now REST).
    if (resolvedMoves.has(sessionDay)) continue;

    // Skip days already lightened (the lighten note was already emitted in the
    // first pass; the second-activity escalation was also handled there).
    if (lightened.has(sessionDay)) continue;

    // Current session on this day (after moves).
    const currentSession = proposedPlan[sessionDay];
    if (!currentSession || currentSession === "REST" || currentSession === "Mobility") continue;

    const flagKey = `${sessionDay}:${activity.type}:${activity.date}`;
    if (flagged.has(flagKey)) continue;

    // New unprocessed conflict: lighten first, escalate to flag if a second
    // activity also conflicts with this day.
    if (!lightenDays[sessionDay]) {
      lightenDays[sessionDay] = [...overlapRegions];
      lightened.add(sessionDay);
    } else {
      // Already lightened in post-pass for a different activity → flag.
      flagged.add(flagKey);
      flags.push({
        activity,
        sessionType: currentSession,
        sessionDay,
        overlapRegions,
        reason:
          `${currentSession} on ${sessionDay} overlaps ${activity.type} (${activity.intensity_estimate}) ` +
          `on ${activity.date} — unavoidable conflict after all resolution options exhausted.`,
      });
    }
  }

  // Sort flags deterministically.
  flags.sort((a, b) => {
    const dayDiff = weekdayIndex(a.sessionDay) - weekdayIndex(b.sessionDay);
    if (dayDiff !== 0) return dayDiff;
    return a.activity.date.localeCompare(b.activity.date);
  });

  // Dedup lightenDays regions.
  for (const day of Object.keys(lightenDays)) {
    lightenDays[day] = [...new Set(lightenDays[day])];
  }

  return { proposedPlan, lightenDays, flags };
}
