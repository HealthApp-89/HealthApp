// POST /api/chat/morning/revert-patch
//
// Undo today's auto-applied morning-ladder patch: restore the exact `from`
// values recorded in the repatch_log entry and append a morning_checkin_revert
// entry (append-only log — nothing is deleted). Idempotent: a second call
// 404s with "already_reverted".

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getUserTimezone } from "@/lib/time/get-user-tz";
import { todayInUserTz } from "@/lib/time";
import { daysBetweenIso, mondayOfIso } from "@/lib/time/dates";
import { WEEKDAY_LONG_ORDER } from "@/lib/coach/prescription/upsert-week-prescription";
import {
  revertDayExercises,
  hasMorningPatchEntry,
  hasMorningRevertEntry,
} from "@/lib/coach/prescription/patch-today";
import type { RepatchLogEntry, SessionPrescriptions, TrainingWeek, WeekdayLong } from "@/lib/data/types";

export async function POST() {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const tz = await getUserTimezone(user.id);
  const todayIso = todayInUserTz(new Date(), tz);
  const weekStart = mondayOfIso(todayIso);

  const { data: weekData, error: readErr } = await supabase
    .from("training_weeks")
    .select("session_prescriptions, repatch_log")
    .eq("user_id", user.id)
    .eq("week_start", weekStart)
    .maybeSingle();
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });
  const week = weekData as Pick<TrainingWeek, "session_prescriptions" | "repatch_log"> | null;
  if (!week?.session_prescriptions) return NextResponse.json({ error: "no_week" }, { status: 404 });

  const log = Array.isArray(week.repatch_log) ? (week.repatch_log as RepatchLogEntry[]) : [];
  if (!hasMorningPatchEntry(log, todayIso)) return NextResponse.json({ error: "no_patch" }, { status: 404 });
  if (hasMorningRevertEntry(log, todayIso)) return NextResponse.json({ error: "already_reverted" }, { status: 404 });

  const patchEntry = [...log].reverse().find(
    (e) => e.reason === "morning_checkin" && e.workout_date === todayIso,
  )!;

  const todayIdx = daysBetweenIso(weekStart, todayIso);
  if (todayIdx == null || todayIdx < 0 || todayIdx > 6) {
    return NextResponse.json({ error: "no_week" }, { status: 404 });
  }
  const weekdayLong: WeekdayLong = WEEKDAY_LONG_ORDER[todayIdx];
  const prescriptions = week.session_prescriptions as SessionPrescriptions;
  const current = prescriptions[weekdayLong] ?? [];
  // No exercises stored for today means externally-inconsistent data; reverting would write empty day, refuse.
  if (current.length === 0) return NextResponse.json({ error: "no_week" }, { status: 404 });

  const restored = revertDayExercises(current, patchEntry.changes);
  const revertEntry: RepatchLogEntry = {
    at: new Date().toISOString(),
    reason: "morning_checkin_revert",
    workout_date: todayIso,
    // Inverse diff for the audit trail, restricted to fields revertDayExercises actually restores.
    changes: patchEntry.changes
      .filter((c) => c.field === "baseKg" || c.field === "baseReps" || c.field === "sets" || c.field === "rir")
      .map((c) => ({ ...c, from: c.to, to: c.from })),
  };

  const { error: writeErr } = await supabase
    .from("training_weeks")
    .update({
      session_prescriptions: { ...prescriptions, [weekdayLong]: restored },
      repatch_log: [...log, revertEntry],
    })
    .eq("user_id", user.id)
    .eq("week_start", weekStart);
  if (writeErr) return NextResponse.json({ error: writeErr.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
