// lib/coach/voice/triggers.ts
//
// Coach Carter escalation triggers. Pure function over recent daily_logs +
// workouts + today's protein vs. floor — same inputs always produce the same
// directives. No I/O.
//
// Each fired trigger contributes a single directive string that the chat /
// brief system-prompt builder appends as "Active escalation triggers for THIS
// turn". The directives instruct the model how Carter should address the
// pattern; the determination of WHETHER a pattern is present stays here.

import type { DailyLog } from "@/lib/data/types";

export type TriggerKey =
  | "short_sleep_streak"
  | "missed_sessions_streak"
  | "hrv_trending_down"
  | "steps_drop"
  | "protein_below_floor_today";

export type TriggerDirective = {
  key: TriggerKey;
  directive: string;
  severity: "info" | "warn" | "alert";
};

type Input = {
  today: Date;
  /** Last ~30 days of daily_logs, ordered ASCENDING by date. */
  dailyLogs: DailyLog[];
  /** Last 14 days of workouts. type is the session label (Chest, Legs, etc.). */
  workoutsLast14d: Array<{ date: string; type: string | null }>;
  /** g/day floor for today (depends on bodyweight + GLP-1 mode). */
  proteinFloor_g: number;
  /** Today's logged protein in g, or null if not yet logged. */
  proteinToday_g: number | null;
};

/**
 * Pure: same inputs always produce same outputs. No I/O.
 * Computes which Coach Carter escalation triggers fire today.
 */
export function computeActiveTriggers(input: Input): TriggerDirective[] {
  const out: TriggerDirective[] = [];

  // Short-sleep streak: 3+ nights <6h in last 7 days. Treat 0/null as
  // "not logged" — only flag rows that actually have a sleep value < 6.
  const last7 = input.dailyLogs.slice(-7);
  const shortSleeps = last7.filter(
    (l) => (l.sleep_hours ?? 0) > 0 && (l.sleep_hours ?? 0) < 6,
  ).length;
  if (shortSleeps >= 3) {
    out.push({
      key: "short_sleep_streak",
      severity: "warn",
      directive: `User has ${shortSleeps} short sleeps (<6h) in the last 7 days. Address it directly. Ask about cause (caffeine, stress, schedule). Don't lecture.`,
    });
  }

  // Missed sessions: expected 6 workouts in 14 days. Fire when actual is
  // 2+ below expectation. workoutsLast14d already excludes anything that
  // didn't log; this is missed-by-default.
  const expected14 = 6;
  const actual14 = input.workoutsLast14d.length;
  if (actual14 <= expected14 - 2) {
    const missed = expected14 - actual14;
    out.push({
      key: "missed_sessions_streak",
      severity: "alert",
      directive: `User has ${missed} fewer sessions than expected in the last 14 days. Call the streak. Demand a plan: 'We make it up this week, or we re-cut the block. Which?'`,
    });
  }

  // HRV trending down 10+ consecutive days. We require 10 non-null HRV
  // samples in the last 12 logs, then compute slope as (last - first) / 10.
  // Threshold: slope < -0.3 ms/day ≈ -3 ms across the window. Aligns with
  // "trending down 10+ ms" from the spec without demanding strict
  // monotonicity (sleep noise on any one night shouldn't reset the streak).
  const recentHrv = input.dailyLogs
    .slice(-12)
    .map((l) => l.hrv)
    .filter((v): v is number => v != null);
  if (recentHrv.length >= 10) {
    const tail = recentHrv.slice(-10);
    const slope = (tail[tail.length - 1] - tail[0]) / 10;
    if (slope < -0.3) {
      out.push({
        key: "hrv_trending_down",
        severity: "warn",
        directive: `HRV has trended down ~${Math.abs(Math.round(slope * 10))} ms over 10 days. Flag it as a system signal. Consider proposing a deload week.`,
      });
    }
  }

  // Steps drop week-over-week >30%. Need full 7+7 day coverage; partial
  // weeks (start-of-history) skip this trigger.
  const last7Steps = last7.map((l) => l.steps ?? 0);
  const prior7Steps = input.dailyLogs.slice(-14, -7).map((l) => l.steps ?? 0);
  if (last7Steps.length === 7 && prior7Steps.length === 7) {
    const avgRecent = last7Steps.reduce((a, b) => a + b, 0) / 7;
    const avgPrior = prior7Steps.reduce((a, b) => a + b, 0) / 7;
    if (avgPrior > 0 && avgRecent / avgPrior < 0.7) {
      out.push({
        key: "steps_drop",
        severity: "info",
        directive: `Daily steps dropped ${Math.round((1 - avgRecent / avgPrior) * 100)}% week-over-week. One pointed mention. Don't nag.`,
      });
    }
  }

  // Always-on: protein below floor today. Only fires when there IS a logged
  // value — null means "not yet logged today", which Carter shouldn't call
  // out yet (the day isn't over).
  if (input.proteinToday_g != null && input.proteinToday_g < input.proteinFloor_g) {
    out.push({
      key: "protein_below_floor_today",
      severity: "alert",
      directive: `Today's logged protein is ${input.proteinToday_g} g — floor is ${input.proteinFloor_g} g. Call it out explicitly: 'Protein's at ${input.proteinToday_g} g. Floor is ${input.proteinFloor_g} g. That's the lever for this cut.'`,
    });
  }

  return out;
}
