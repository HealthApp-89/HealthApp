// lib/coach/carter-context/this-weeks-prescription.ts
//
// Builds the "This week's prescription" context block appended to Carter's
// system prompt. This is the deterministic output of prescribeWeek —
// load × reps × sets per exercise per day — that Carter must quote verbatim.
//
// Resolution chain (single source of truth for "what should the athlete lift
// this week"):
//   1. training_weeks.session_prescriptions for the current week (written
//      by the Sunday cron, by commit_week_plan, or by the get_week_prescription
//      tool's first invocation)
//   2. on-the-fly prescribeWeek() — falls back when no row exists yet
//   3. null — when there's no training_weeks row at all (Carter degrades to
//      query_exercise_library; the framework-state block still primes him on
//      the block-level rule)
//
// Goal: kill prose-fabricated weight tables. Carter cannot invent loads if
// the canonical answer is sitting in his system prompt.

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  SessionPrescriptions,
  TrainingBlock,
  TrainingWeek,
  WeekdayLong,
} from "@/lib/data/types";
import { currentWeekMonday } from "@/lib/coach/week";
import { prescribeWeek } from "@/lib/coach/prescription/prescribe-week";
import { todayInUserTz } from "@/lib/time";
import { getUserTimezone } from "@/lib/time/get-user-tz";

const WEEKDAY_ORDER: ReadonlyArray<WeekdayLong> = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

export async function buildThisWeeksPrescriptionBlock(args: {
  supabase: SupabaseClient;
  userId: string;
}): Promise<string | null> {
  const { supabase, userId } = args;
  const tz = await getUserTimezone(userId);
  const weekStart = currentWeekMonday(new Date(), tz);
  const todayIso = todayInUserTz(new Date(), tz);

  const { data: tw } = await supabase
    .from("training_weeks")
    .select("*")
    .eq("user_id", userId)
    .eq("week_start", weekStart)
    .maybeSingle();
  const week = (tw as TrainingWeek | null) ?? null;
  if (!week) return null;

  let prescription = week.session_prescriptions as SessionPrescriptions | null;
  let source: "stored" | "computed_on_the_fly";

  if (prescription && Object.keys(prescription).length > 0) {
    source = "stored";
  } else {
    // No stored prescription — compute. We don't persist here (the Sunday
    // cron and the get_week_prescription tool both write; injecting into
    // every chat turn would race with the user editing the row). The
    // computation is cheap (one rule-engine pass) and deterministic.
    const { data: blocks } = await supabase
      .from("training_blocks")
      .select("*")
      .eq("user_id", userId)
      .eq("status", "active")
      .maybeSingle();
    const block = (blocks as TrainingBlock | null) ?? null;
    try {
      prescription = await prescribeWeek({ supabase, userId, block, week, todayIso });
      source = "computed_on_the_fly";
    } catch (e) {
      console.warn("[this-weeks-prescription] prescribeWeek failed", e);
      return null;
    }
  }

  if (!prescription || Object.keys(prescription).length === 0) return null;

  const lines: string[] = [];
  lines.push("<this_weeks_prescription>");
  lines.push(
    `This is the deterministic per-exercise prescription for the current training week (Mon-start ${weekStart}). ` +
      `It was ${source === "stored" ? "committed at Sunday planning and stored" : "computed on the fly from prescribeWeek"} ` +
      `(rule engine, not LLM). Quote these numbers verbatim when the athlete asks "what should I lift?". ` +
      `Never invent your own loads, reps, or sets in prose — your role is to narrate the prescription, not to compute it.`,
  );
  lines.push("");

  for (const weekday of WEEKDAY_ORDER) {
    const exercises = prescription[weekday];
    if (!exercises || exercises.length === 0) continue;
    lines.push(`**${weekday}:**`);
    for (const ex of exercises) {
      const parts: string[] = [];
      if (ex.warmup) parts.push("(warmup)");
      const kg = ex.baseKg != null ? `${ex.baseKg} kg` : "bodyweight";
      const reps =
        ex.baseReps != null ? `× ${ex.baseReps}` : ex.reps != null ? `× ${ex.reps}` : "";
      const sets = ex.sets != null ? ` × ${ex.sets} sets` : "";
      parts.push(`${ex.name}: ${kg} ${reps}${sets}`.trim());
      if (ex.note) parts.push(`— ${ex.note}`);
      lines.push(`- ${parts.join(" ")}`);
    }
    lines.push("");
  }

  lines.push("</this_weeks_prescription>");
  return lines.join("\n");
}
