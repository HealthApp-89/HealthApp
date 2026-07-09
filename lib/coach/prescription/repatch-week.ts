// lib/coach/prescription/repatch-week.ts
//
// Mid-week feed-forward: after a workout commits, re-run the deterministic
// engine for the REMAINING days of the current week and persist the result.
// Past days (≤ today) are never rewritten — they are the historical record of
// what was actually prescribed. When the recompute changes any future day, an
// audit entry is appended to training_weeks.repatch_log; the workout debrief
// surfaces it as a "Plan updated" note. Deterministic and idempotent: firing
// again with unchanged inputs produces an empty diff and writes nothing.
//
// Spec: docs/superpowers/specs/2026-07-09-effort-aware-engine-midweek-repatch-design.md

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  RepatchChange,
  RepatchLogEntry,
  SessionPrescriptions,
  WeekdayLong,
} from "@/lib/data/types";
import type { PlannedExercise } from "@/lib/coach/sessionPlans";
import { daysBetweenIso } from "@/lib/time/dates";
import {
  upsertWeekPrescription,
  WEEKDAY_LONG_ORDER,
} from "@/lib/coach/prescription/upsert-week-prescription";
import { fmtNum } from "@/lib/ui/score";

/** Monday (ISO date) of the week containing `iso`. Pure date arithmetic on a
 *  caller-supplied date — the caller owns the timezone question. */
export function mondayOfIso(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  const dow = (d.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

const NUMERIC_FIELDS = ["baseKg", "baseReps", "sets", "rir"] as const;

/** First non-warmup entry per exercise name (working-set row). Warmup rows
 *  are augmentation artifacts and excluded from the diff. */
function workingByName(day: PlannedExercise[]): Map<string, PlannedExercise> {
  const out = new Map<string, PlannedExercise>();
  for (const ex of day) {
    if (ex.warmup) continue;
    if (!out.has(ex.name)) out.set(ex.name, ex);
  }
  return out;
}

/** Field-level diff between stored and next prescriptions, restricted to
 *  weekdays STRICTLY AFTER todayIso. Pure; exported for the audit script. */
export function diffFutureDays(opts: {
  stored: SessionPrescriptions;
  next: SessionPrescriptions;
  weekStart: string;
  todayIso: string;
}): RepatchChange[] {
  const todayIdx = daysBetweenIso(opts.weekStart, opts.todayIso);
  if (todayIdx == null) return [];
  const changes: RepatchChange[] = [];

  for (let i = todayIdx + 1; i < WEEKDAY_LONG_ORDER.length; i++) {
    const weekday: WeekdayLong = WEEKDAY_LONG_ORDER[i];
    const storedDay = workingByName(opts.stored[weekday] ?? []);
    const nextDay = workingByName(opts.next[weekday] ?? []);

    for (const [name, s] of storedDay) {
      const n = nextDay.get(name);
      if (!n) {
        changes.push({ weekday, exercise: name, field: "removed", from: name, to: null });
        continue;
      }
      for (const field of NUMERIC_FIELDS) {
        const from = s[field] ?? null;
        const to = n[field] ?? null;
        if (from !== to) changes.push({ weekday, exercise: name, field, from, to });
      }
    }
    for (const name of nextDay.keys()) {
      if (!storedDay.has(name)) {
        changes.push({ weekday, exercise: name, field: "added", from: null, to: name });
      }
    }
  }
  return changes;
}

/** Deterministic "Plan updated" note lines for the workout debrief — one per
 *  changed weekday. Pure; exported for the audit script and Task 6. */
export function formatRepatchNotes(entry: RepatchLogEntry): string[] {
  const byDay = new Map<string, string[]>();
  for (const c of entry.changes) {
    let frag: string | null = null;
    if (c.field === "baseKg") frag = `${c.exercise} ${fmtNum(Number(c.from))} → ${fmtNum(Number(c.to))} kg`;
    else if (c.field === "sets") frag = `${c.exercise} ${fmtNum(Number(c.from))} → ${fmtNum(Number(c.to))} sets`;
    else if (c.field === "baseReps") frag = `${c.exercise} ${fmtNum(Number(c.from))} → ${fmtNum(Number(c.to))} reps`;
    else if (c.field === "rir") frag = `${c.exercise} RIR ${fmtNum(Number(c.from))} → ${fmtNum(Number(c.to))}`;
    else if (c.field === "added") frag = `${c.exercise} added`;
    else if (c.field === "removed") frag = `${c.exercise} removed`;
    if (!frag) continue;
    const list = byDay.get(c.weekday) ?? [];
    list.push(frag);
    byDay.set(c.weekday, list);
  }
  return [...byDay.entries()].map(
    ([day, frags]) => `Plan updated for ${day}: ${frags.join(", ")}`,
  );
}

/** Re-run the engine for the remaining days of the current week. Returns
 *  null when there is nothing committed to repatch (no training_weeks row or
 *  no stored session_prescriptions — the Sunday cron / commit flow owns first
 *  writes). Otherwise returns the field-level diff; appends a repatch_log
 *  entry only when the diff is non-empty. */
export async function repatchRemainingWeek(opts: {
  supabase: SupabaseClient;
  userId: string;
  /** Today in the USER's timezone (callers derive via getUserTimezone +
   *  todayInUserTz). Days ≤ today are never rewritten. */
  todayIso: string;
  reason: string;
  /** YYYY-MM-DD of the triggering workout, for the audit entry. */
  workoutDate?: string;
}): Promise<{ changed: boolean; changes: RepatchChange[] } | null> {
  const { supabase, userId, todayIso } = opts;
  const weekStart = mondayOfIso(todayIso);

  const { data: row, error } = await supabase
    .from("training_weeks")
    .select("session_prescriptions, repatch_log")
    .eq("user_id", userId)
    .eq("week_start", weekStart)
    .maybeSingle();
  if (error) throw error;

  const stored = (row?.session_prescriptions as SessionPrescriptions | null) ?? null;
  if (!row || !stored || Object.keys(stored).length === 0) return null;

  const result = await upsertWeekPrescription({
    supabase,
    userId,
    weekStart,
    todayIso,
    preserveDaysThrough: todayIso,
  });

  const changes = diffFutureDays({
    stored,
    next: result.session_prescriptions,
    weekStart,
    todayIso,
  });
  if (changes.length === 0) return { changed: false, changes: [] };

  const entry: RepatchLogEntry = {
    at: new Date().toISOString(),
    reason: opts.reason,
    workout_date: opts.workoutDate ?? null,
    changes,
  };
  const log = Array.isArray(row.repatch_log) ? (row.repatch_log as RepatchLogEntry[]) : [];
  const { error: logErr } = await supabase
    .from("training_weeks")
    .update({ repatch_log: [...log, entry] })
    .eq("user_id", userId)
    .eq("week_start", weekStart);
  if (logErr) throw logErr;

  return { changed: true, changes };
}
