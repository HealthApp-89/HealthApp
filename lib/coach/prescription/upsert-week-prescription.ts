// lib/coach/prescription/upsert-week-prescription.ts
//
// Single seam that converts prescribeWeek's deterministic output into a
// committed training_weeks row. Called by:
//   - the Sunday cron (/api/coach/sunday-prescriptions/sync), once per
//     active-block user, for next_week_start
//   - the get_week_prescription chat tool, on demand for {current|next}
//   - executeCommitWeekPlan, as the last write step (so the row stored is
//     the engine's verdict, not Carter's narration)
//   - repatchRemainingWeek (lib/coach/prescription/repatch-week.ts), mid-week
//     after each workout commit, with preserveDaysThrough=today
//
// Single seam = single set of invariants:
//   * session_prescriptions is ALWAYS the freshly-computed prescribeWeek
//     output, except when preserveDaysThrough is set: weekdays ≤ that date
//     keep the stored row verbatim (see mergePreservedDays). Never accepts a
//     Carter-supplied payload.
//   * Other training_weeks columns (session_plan, rir_target, etc.) are
//     preserved when the row already exists, or seeded from the prior week
//     when creating a new row.
//   * applyMorningPatch (lib/coach/prescription/patch-today.ts) is the third
//     sanctioned writer of session_prescriptions — it patches TODAY's entry
//     directly (single-day read-modify-write logged to repatch_log), not
//     through this seam.
//   * executeCommitWeekPlan (lib/coach/tools.ts) deliberately performs a
//     FULL-week rewrite with no preservation — re-committing a plan supersedes
//     any same-week patches/repatches by design.
//   * Idempotent on (user_id, week_start) via upsert.

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  SessionPlan,
  SessionPrescriptions,
  TrainingBlock,
  TrainingWeek,
  WeekdayLong,
} from "@/lib/data/types";
import { prescribeWeek, computeActivityLayoutProposal } from "@/lib/coach/prescription/prescribe-week";
import type { ActivityConflictFlag } from "@/lib/coach/activity/sequence-week";
import type { MuscleRegion } from "@/lib/coach/activity/types";
import { daysBetweenIso } from "@/lib/time/dates";

/** Summary of the activity-aware layout proposal for a week.
 *  When `hasMoves` is true, the athlete should be prompted to review
 *  and optionally approve the proposed session-day changes.
 *  Apply via POST /api/training-weeks/[week_start]/apply-activity-layout. */
export type ActivityLayoutProposal = {
  proposedPlan: SessionPlan;
  lightenDays: Record<string, MuscleRegion[]>;
  flags: ActivityConflictFlag[];
  /** True when proposedPlan differs from the committed session_plan. */
  hasMoves: boolean;
  /** True when unresolvable conflicts exist (require athlete decision). */
  hasFlags: boolean;
};

export type UpsertWeekPrescriptionResult = {
  week_start: string;
  block_id: string | null;
  session_prescriptions: SessionPrescriptions;
  /** True when a fresh training_weeks row was inserted; false when an
   *  existing row was updated. The caller can use this to decide whether
   *  to emit a "first prescription written" event downstream. */
  inserted: boolean;
  /** Activity-aware layout proposal. hasMoves=false and hasFlags=false
   *  when no activities are detected (graceful no-op). */
  activityLayoutProposal: ActivityLayoutProposal;
};

/** Helper: weekday names for callers that need to walk a SessionPrescriptions
 *  result in display order (Monday-first). */
export const WEEKDAY_LONG_ORDER: ReadonlyArray<WeekdayLong> = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

/** Merge freshly-computed prescriptions with the stored row so that weekdays
 *  ≤ `preserveDaysThrough` keep their stored state VERBATIM — including
 *  absence (a stored week with no Tuesday entry stays without one). Weekdays
 *  strictly after the boundary take the fresh computation. Pure; exported for
 *  scripts/audit-prescription-rules.mjs. Used by the mid-week repatch so past
 *  days remain the historical record of what was actually prescribed. */
export function mergePreservedDays(opts: {
  computed: SessionPrescriptions;
  stored: SessionPrescriptions | null;
  weekStart: string;
  preserveDaysThrough: string;
}): SessionPrescriptions {
  const idx = daysBetweenIso(opts.weekStart, opts.preserveDaysThrough);
  if (idx == null || idx < 0) return opts.computed;
  const out: SessionPrescriptions = { ...opts.computed };
  for (let i = 0; i <= Math.min(idx, 6); i++) {
    const day = WEEKDAY_LONG_ORDER[i];
    const storedDay = opts.stored?.[day];
    if (storedDay != null) out[day] = storedDay;
    else delete out[day];
  }
  return out;
}

export async function upsertWeekPrescription(opts: {
  supabase: SupabaseClient;
  userId: string;
  /** Monday (UTC) of the week being prescribed. */
  weekStart: string;
  /** Today's ISO date in the user's TZ — drives block-phase week-of-block
   *  math. Passed in rather than computed so the function stays pure-ish
   *  and easily testable. */
  todayIso: string;
  /** When set (ISO date), weekdays ≤ this date keep the STORED row's
   *  prescriptions verbatim (including absence); only strictly-later weekdays
   *  take the fresh computation. Used by the mid-week repatch. Omitted →
   *  full-week write (Sunday cron / commit_week_plan behavior, unchanged). */
  preserveDaysThrough?: string;
}): Promise<UpsertWeekPrescriptionResult> {
  const { supabase, userId, weekStart, todayIso } = opts;

  // Active block (may be null — non-block weeks still get a prescription so
  // the logger has somewhere to read from; just no phase-aware progression).
  const { data: blocks } = await supabase
    .from("training_blocks")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();
  const block = (blocks as TrainingBlock | null) ?? null;

  // Existing row for this week (if any) — preserve session_plan, focus,
  // rir_target etc. so the cron doesn't clobber Carter's label decisions.
  const { data: existingRows } = await supabase
    .from("training_weeks")
    .select("*")
    .eq("user_id", userId)
    .eq("week_start", weekStart)
    .maybeSingle();
  const existing = (existingRows as TrainingWeek | null) ?? null;

  // When no existing row, seed session_plan from the most recent committed
  // week — that gives the cron a reasonable starting point so prescribeWeek
  // has weekday labels to walk. Carter can later overwrite via the regular
  // propose_week_plan flow.
  let workingRow: TrainingWeek;
  if (existing) {
    workingRow = existing;
  } else {
    const { data: priorRows } = await supabase
      .from("training_weeks")
      .select("*")
      .eq("user_id", userId)
      .lt("week_start", weekStart)
      .order("week_start", { ascending: false })
      .limit(1);
    const prior = (priorRows?.[0] as TrainingWeek | undefined) ?? null;
    // Synthetic working row — prescribeWeek only reads session_plan +
    // rir_target. block_id/id/etc. are filled in by the upsert below.
    workingRow = {
      ...(prior ?? ({} as TrainingWeek)),
      id: "",
      user_id: userId,
      block_id: block?.id ?? null,
      week_start: weekStart,
      session_plan: prior?.session_plan ?? {},
      original_session_plan: null,
      exercise_overrides: null,
      session_prescriptions: null,
      weekly_focus: prior?.weekly_focus ?? null,
      intensity_modifier: prior?.intensity_modifier ?? {},
      rir_target: prior?.rir_target ?? null,
      research_phase: prior?.research_phase ?? null,
      proposed_by: "coach",
      chat_message_id: null,
      endurance_session_plan: prior?.endurance_session_plan ?? null,
      committed_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  }

  const prescription = await prescribeWeek({
    supabase,
    userId,
    block,
    week: workingRow,
    todayIso,
  });

  const finalPrescription = opts.preserveDaysThrough
    ? mergePreservedDays({
        computed: prescription,
        stored: existing?.session_prescriptions ?? null,
        weekStart,
        preserveDaysThrough: opts.preserveDaysThrough,
      })
    : prescription;

  // Compute the activity layout proposal in parallel with the DB write.
  // Graceful: any failure → empty proposal (hasMoves=false, hasFlags=false).
  const layoutProposalPromise = computeActivityLayoutProposal({
    supabase,
    userId,
    block,
    week: workingRow,
    todayIso,
  });

  // Split INSERT vs UPDATE explicitly. Using `.upsert()` here would trip the
  // NOT NULL constraint on session_plan when the row exists — Postgres
  // validates the would-be INSERT row before applying ON CONFLICT, so a
  // payload that omits session_plan (intending to preserve it) violates the
  // constraint at parse time.
  if (existing) {
    const { error } = await supabase
      .from("training_weeks")
      .update({
        session_prescriptions: finalPrescription,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId)
      .eq("week_start", weekStart);
    if (error) throw error;
  } else {
    const { error } = await supabase
      .from("training_weeks")
      .insert({
        user_id: userId,
        week_start: weekStart,
        block_id: block?.id ?? null,
        session_plan: workingRow.session_plan,
        weekly_focus: workingRow.weekly_focus,
        intensity_modifier: workingRow.intensity_modifier ?? {},
        rir_target: workingRow.rir_target,
        research_phase: workingRow.research_phase,
        proposed_by: "coach",
        endurance_session_plan: workingRow.endurance_session_plan,
        session_prescriptions: finalPrescription,
        committed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    if (error) throw error;
  }

  // Await the layout proposal (computed concurrently with the DB write above).
  const activityLayoutProposal = await layoutProposalPromise;

  return {
    week_start: weekStart,
    block_id: block?.id ?? null,
    session_prescriptions: finalPrescription,
    inserted: !existing,
    activityLayoutProposal,
  };
}
