/**
 * lib/coach/activity/render-activities-block.ts
 *
 * Pure renderer — no I/O. Produces the ## PLANNED ACTIVITIES snapshot block
 * from pre-fetched PlannedActivity[] and RecurringActivity[].
 *
 * Returns null when both arrays are empty so the caller can omit the block
 * entirely (keeping the coach context byte-identical to pre-feature when there
 * are no activities).
 */

import { activityRegions, recoveryWindowHours } from "./model";
import type { PlannedActivity, RecurringActivity, ActivityType } from "./types";

const WEEKDAY_SHORT: Record<number, string> = {
  0: "Sun",
  1: "Mon",
  2: "Tue",
  3: "Wed",
  4: "Thu",
  5: "Fri",
  6: "Sat",
};

/** Returns the short weekday name for a YYYY-MM-DD date string (UTC). */
function weekdayShort(dateIso: string): string {
  const d = new Date(`${dateIso}T12:00:00Z`);
  return WEEKDAY_SHORT[d.getUTCDay()] ?? dateIso;
}

/** Formats a MuscleRegion[] as a readable phrase ("legs + lower back"). */
function formatRegions(regions: string[]): string {
  return regions.map((r) => r.replace("_", " ")).join(" + ");
}

/**
 * Builds the one-line load note from the unique set of activity types present.
 * Cites muscle regions from activityRegions() and recovery window from
 * recoveryWindowHours() for the dominant intensity.
 */
function buildLoadNote(activities: PlannedActivity[]): string | null {
  if (activities.length === 0) return null;

  // Collect unique types + their peak intensity (hard > moderate > light).
  const intensityRank: Record<string, number> = { light: 0, moderate: 1, hard: 2 };
  const peakByType = new Map<ActivityType, PlannedActivity["intensity_estimate"]>();
  for (const a of activities) {
    const current = peakByType.get(a.type);
    if (!current || intensityRank[a.intensity_estimate] > intensityRank[current]) {
      peakByType.set(a.type, a.intensity_estimate);
    }
  }

  const parts: string[] = [];
  for (const [type, intensity] of peakByType) {
    const regions = activityRegions(type);
    const windowH = recoveryWindowHours(type, intensity);
    if (regions.length === 0 && type === "other") {
      parts.push(`${type}: ${windowH}h recovery window at ${intensity} intensity`);
    } else if (regions.length > 0) {
      parts.push(
        `${type} loads ${formatRegions(regions)}; competes with heavy ${regions[0]}-targeting work within ~${windowH}h`,
      );
    }
  }

  if (parts.length === 0) return null;
  return `Load note: ${parts.join(". ")}.`;
}

/**
 * Renders the ## PLANNED ACTIVITIES block for injection into the coach
 * snapshot prefix.
 *
 * @param activities  This-week planned activities (declared + recurring
 *                    materialized + detected), already merged and sorted.
 * @param recurring   Raw recurring templates (for the "Recurring" summary line).
 * @returns           The formatted block string, or null when both inputs are
 *                    empty (caller must omit the block in that case).
 */
export function renderPlannedActivitiesBlock(
  activities: PlannedActivity[],
  recurring: RecurringActivity[],
): string | null {
  const hasActivities = activities.length > 0;
  const hasRecurring = recurring.length > 0;

  if (!hasActivities && !hasRecurring) return null;

  const lines: string[] = ["## PLANNED ACTIVITIES"];

  if (hasActivities) {
    lines.push("This week:");
    for (const a of activities) {
      const wd = weekdayShort(a.date);
      lines.push(`  ${a.date} (${wd}) — ${a.type} [${a.intensity_estimate}] (${a.source})`);
    }
  } else {
    lines.push("This week: (none committed)");
  }

  if (hasRecurring) {
    const recurringDesc = recurring
      .map((r) => {
        const days = r.weekdays.map((d) => WEEKDAY_SHORT[d] ?? String(d)).join("/");
        return `${r.type} ${days} (${r.typical_intensity})`;
      })
      .join(", ");
    lines.push(`Recurring: ${recurringDesc}`);
  }

  const loadNote = buildLoadNote(activities);
  if (loadNote) lines.push(loadNote);

  return lines.join("\n");
}
