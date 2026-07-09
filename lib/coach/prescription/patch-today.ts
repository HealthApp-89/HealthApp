// lib/coach/prescription/patch-today.ts
//
// Morning-ladder prescription patches: converts the reactive ladder's graded
// rungs (load_down / volume_down) into real, revertible changes on TODAY's
// session_prescriptions entry. Escalation rungs (swap_exercise / swap_day)
// stay with the BriefCoachSuggestion chip — numbers are not the remedy there.
// Load (baseKg) is NEVER touched — volume + RIR are the levers, matching
// lightenExercise's evidence-based design.
//
// Pure helpers live at the top (fixture-audited); the async apply primitive
// applyMorningPatch and revert plumbing are below (route-consumed).
//
// Spec: docs/superpowers/specs/2026-07-09-morning-ladder-prescription-patches-design.md

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CheckinRow, SessionPrescriptions, TrainingWeek, WeekdayLong } from "@/lib/data/types";
import type { PlannedExercise } from "@/lib/coach/sessionPlans";
import type { RepatchChange, RepatchLogEntry } from "@/lib/data/types";
import type { ReactiveRung } from "@/lib/coach/activity/reactive-ladder";
import type { MuscleRegion } from "@/lib/coach/activity/types";
import { SESSION_REGION_MAP } from "@/lib/coach/activity/sequence-week";
import { lightenExercise, exerciseRegion } from "@/lib/coach/prescription/prescribe-week";
import { selectReactiveRung } from "@/lib/coach/activity/reactive-ladder";
import { readSessionForDay } from "@/lib/coach/session-plan-reader";
import { mondayOfIso, diffDay } from "@/lib/coach/prescription/repatch-week";
import { WEEKDAY_LONG_ORDER } from "@/lib/coach/prescription/upsert-week-prescription";
import { daysBetweenIso } from "@/lib/time/dates";
import { hasMorningPatchEntry, hasMorningRevertEntry } from "@/lib/coach/prescription/patch-log";
// sorenessAreasToRegions and loadRecentActivityForBrief are dynamically imported
// inside applyMorningPatch to avoid pulling next/headers into the pure-function
// module graph (which would break the fixture audit script).

/** True when the exercise is region-gated INTO the patch: its own region is
 *  affected, or (unknown region) its session's regions overlap the affected
 *  set. Mirrors lightenExercise's gating exactly. */
function isAffected(ex: PlannedExercise, sessionType: string, regions: MuscleRegion[]): boolean {
  const exReg = exerciseRegion(ex.name);
  if (exReg !== null) return regions.includes(exReg);
  const sessionRegs = SESSION_REGION_MAP[sessionType] ?? [];
  return sessionRegs.some((r) => regions.includes(r));
}

/** Map a reactive-ladder rung to a transform of today's exercise list.
 *   load_down   → RIR +1 (cap 5) on affected working exercises; all else held.
 *   volume_down → lightenExercise tiering (sets/reps cuts + RIR bumps).
 *   none / swap_exercise / swap_day → identity (returns the input array). */
export function patchExercisesForRung(
  exercises: PlannedExercise[],
  rung: ReactiveRung,
  sessionType: string,
  regions: MuscleRegion[],
): PlannedExercise[] {
  if (rung === "volume_down") {
    return exercises.map((ex) => lightenExercise(ex, sessionType, regions));
  }
  if (rung !== "load_down") return exercises;
  return exercises.map((ex) => {
    if (ex.warmup) return ex;
    if (ex.sets == null && ex.baseReps == null) return ex;
    if (!isAffected(ex, sessionType, regions)) return ex;
    return { ...ex, rir: Math.min(5, (ex.rir ?? 2) + 1) };
  });
}

// Client-safe log guards (hasMorningPatchEntry / hasMorningRevertEntry) are
// imported at the top and re-exported below so server-side consumers can import
// everything from one place.
export { hasMorningPatchEntry, hasMorningRevertEntry };

const REVERTIBLE_FIELDS = new Set(["baseKg", "baseReps", "sets", "rir"]);

/** Restore the `from` values of a morning patch onto today's exercise list.
 *  Only numeric fields are revertible — the morning patch never adds or
 *  removes exercises, so `added`/`removed` changes are skipped defensively.
 *  Exercises matched by name on non-warmup rows (diffDay's convention). */
export function revertDayExercises(
  exercises: PlannedExercise[],
  changes: RepatchChange[],
): PlannedExercise[] {
  return exercises.map((ex) => {
    if (ex.warmup) return ex;
    const mine = changes.filter(
      (c) => c.exercise === ex.name && REVERTIBLE_FIELDS.has(c.field),
    );
    if (mine.length === 0) return ex;
    const out = { ...ex };
    for (const c of mine) {
      const field = c.field as "baseKg" | "baseReps" | "sets" | "rir";
      if (c.from == null) delete out[field];
      else out[field] = c.from as number;
    }
    return out;
  });
}

// ── apply primitive (route-consumed) ────────────────────────────────────────

const SHORT_WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/** Auto-apply the morning-ladder patch to TODAY's session_prescriptions.
 *  Returns null on every no-op path (no check-in, rung not graded, no stored
 *  prescriptions, REST/Mobility, already patched today, empty diff).
 *  Throws only on Supabase write errors — callers wrap in try/catch. */
export async function applyMorningPatch(opts: {
  supabase: SupabaseClient;
  userId: string;
  todayIso: string;
}): Promise<{ applied: boolean; changes: RepatchChange[] } | null> {
  const { supabase, userId, todayIso } = opts;

  // 1. Today's check-in → rung inputs. No soreness reported → nothing to do
  //    from the soreness path; recent activity alone can still grade a rung.
  const { data: checkinData } = await supabase
    .from("checkins")
    .select("soreness_areas, soreness_severity, fatigue")
    .eq("user_id", userId)
    .eq("date", todayIso)
    .maybeSingle();
  const checkin = checkinData as Pick<CheckinRow, "soreness_areas" | "soreness_severity" | "fatigue"> | null;
  if (!checkin) return null;

  // 2. Current week row + today's stored prescription entry.
  const weekStart = mondayOfIso(todayIso);
  const { data: weekData } = await supabase
    .from("training_weeks")
    .select("session_plan, session_prescriptions, repatch_log")
    .eq("user_id", userId)
    .eq("week_start", weekStart)
    .maybeSingle();
  const week = weekData as Pick<TrainingWeek, "session_plan" | "session_prescriptions" | "repatch_log"> | null;
  if (!week?.session_prescriptions) return null;

  const todayIdx = daysBetweenIso(weekStart, todayIso);
  if (todayIdx == null || todayIdx < 0 || todayIdx > 6) return null;
  const weekdayLong: WeekdayLong = WEEKDAY_LONG_ORDER[todayIdx];
  const stored = (week.session_prescriptions as SessionPrescriptions)[weekdayLong];
  if (!stored || stored.length === 0) return null;

  const sessionType = readSessionForDay(week.session_plan ?? {}, SHORT_WEEKDAYS[todayIdx]);
  if (!sessionType || sessionType === "REST" || sessionType === "Mobility") return null;

  // 3. Idempotency: one morning patch per day (covers brief_failed retries).
  const log = Array.isArray(week.repatch_log) ? (week.repatch_log as RepatchLogEntry[]) : [];
  if (hasMorningPatchEntry(log, todayIso)) return null;

  // 4. Grade the rung exactly as the brief does.
  const sessionRegions = SESSION_REGION_MAP[sessionType] ?? [];
  const { sorenessAreasToRegions } = await import("@/lib/morning/brief/assembler");
  const { loadRecentActivityForBrief } = await import("@/lib/morning/brief/data-sources");
  const soreRegions = sorenessAreasToRegions(checkin.soreness_areas ?? null);
  const recentActivity = await loadRecentActivityForBrief(supabase, userId, todayIso);
  const ladder = selectReactiveRung({
    sessionRegions,
    soreRegions,
    soreSeverity: checkin.soreness_severity ?? null,
    fatigue: checkin.fatigue ?? null,
    recentActivity,
  });
  if (ladder.rung !== "load_down" && ladder.rung !== "volume_down") return null;

  // 5. Transform, diff, write.
  const patched = patchExercisesForRung(stored, ladder.rung, sessionType, ladder.regions);
  const changes = diffDay(stored, patched, weekdayLong);
  if (changes.length === 0) return null;

  const entry: RepatchLogEntry = {
    at: new Date().toISOString(),
    reason: "morning_checkin",
    workout_date: todayIso,
    changes,
  };
  const nextPrescriptions: SessionPrescriptions = {
    ...(week.session_prescriptions as SessionPrescriptions),
    [weekdayLong]: patched,
  };
  const { error } = await supabase
    .from("training_weeks")
    .update({ session_prescriptions: nextPrescriptions, repatch_log: [...log, entry] })
    .eq("user_id", userId)
    .eq("week_start", weekStart);
  if (error) throw error;

  return { applied: true, changes };
}
