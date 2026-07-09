// app/api/training-weeks/[week_start]/swap/route.ts
//
// Mid-week schedule swap endpoint. Single mutation surface for both:
//   - Strength tab DaySwapSheet (preview-then-confirm flow)
//   - Morning brief BriefCoachSuggestion chip (?confirm=true unconditional)
//
// Server flow:
//   1. Auth (cookie-bound supabase, RLS-respecting)
//   2. Load training_weeks row by (user_id, week_start). 404 if missing.
//   3. Validate body (action, days, session_type closed-set for replace).
//   4. Compute new plan via applySwap.
//   5. Identity check — 200 no-op when new === current.
//   6. Conflict check via detectConflicts.
//      - ?confirm=false (default) AND conflicts non-empty → 409 with preview.
//      - Otherwise → proceed.
//   7. Identity-restore detection — if new === original, set original to NULL.
//   8. Clear exercise_overrides[weekday] for any day whose session type
//      changed. Stale overrides would hold exercises for the old session
//      type. NULL the entire column when the resulting map is empty.
//   8b. Recompute session_prescriptions via prescribeWeek when any weekday's
//      session type changed. session_prescriptions is the new top of the
//      resolver chain — stale entries leak prior-session exercises into the
//      strength card body while the header shows the new type. Fallback on
//      engine failure: clear changed-day entries.
//   9. UPDATE with COALESCE-on-first-edit (set original=current) OR
//      identity-restore-clears (set original=null) OR no-op (subsequent edit).
//  10. Return SwapResult.

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { applySwap, detectConflicts, plansEqual } from "@/lib/training-weeks/apply-swap";
import { readSessionForDay, SHORT_TO_FULL } from "@/lib/coach/session-plan-reader";
import { SESSION_PLANS } from "@/lib/coach/sessionPlans";
import { prescribeWeek } from "@/lib/coach/prescription/prescribe-week";
import { mergePreservedDays, WEEKDAY_LONG_ORDER } from "@/lib/coach/prescription/upsert-week-prescription";
import { mondayOfIso } from "@/lib/coach/prescription/repatch-week";
import { daysBetweenIso, isoDaysAgo } from "@/lib/time/dates";
import { getUserTimezone } from "@/lib/time/get-user-tz";
import { todayInUserTz } from "@/lib/time";
import { buildExplicitIntervention, recordIntervention } from "@/lib/coach/interventions/record";
import type {
  BlockPhase,
  ExerciseOverrides,
  ReactiveSwapContext,
  SessionPlan,
  SessionPrescriptions,
  SwapBody,
  SwapConflictResponse,
  SwapResult,
  TrainingBlock,
  TrainingWeek,
  Weekday,
} from "@/lib/data/types";

const WEEKDAYS: ReadonlySet<string> = new Set([
  "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun",
]);

/** Closed set of valid session_type strings for action='replace'.
 *  Computed once at module load: SESSION_PLANS keys ∪ {'REST', 'Mobility'}. */
const REPLACE_TYPES: ReadonlySet<string> = new Set([
  ...Object.keys(SESSION_PLANS),
  "REST",
  "Mobility",
]);

const TRAINING_WEEK_SELECT =
  "id, user_id, block_id, week_start, session_plan, original_session_plan, exercise_overrides, session_prescriptions, endurance_session_plan, weekly_focus, intensity_modifier, rir_target, research_phase, proposed_by, chat_message_id, committed_at, created_at, updated_at";

function isWeekday(s: unknown): s is Weekday {
  return typeof s === "string" && WEEKDAYS.has(s);
}

function isYmd(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/** Loosely validates a ReactiveSwapContext from the request body.
 *  Returns undefined when the field is absent or malformed — reactive_context
 *  is always optional; a bad shape is silently dropped rather than rejecting
 *  the entire swap request. */
function parseReactiveContext(raw: unknown): ReactiveSwapContext | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if ((r.rung !== "swap_exercise" && r.rung !== "swap_day") ||
      typeof r.rationale !== "string") return undefined;
  const regions = Array.isArray(r.regions)
    ? (r.regions as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  return { rung: r.rung, rationale: r.rationale, regions };
}

function parseBody(raw: unknown): SwapBody | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "body must be an object" };
  const b = raw as Record<string, unknown>;
  if (b.action !== "swap" && b.action !== "replace") {
    return { error: "action must be 'swap' or 'replace'" };
  }
  if (!isWeekday(b.source_day)) {
    return { error: "source_day must be one of Mon|Tue|Wed|Thu|Fri|Sat|Sun" };
  }
  const reactive_context = parseReactiveContext(b.reactive_context);
  if (b.action === "swap") {
    if (!isWeekday(b.target_day)) {
      return { error: "target_day must be one of Mon|Tue|Wed|Thu|Fri|Sat|Sun" };
    }
    return { action: "swap", source_day: b.source_day, target_day: b.target_day, reactive_context };
  }
  // action === 'replace'
  if (typeof b.session_type !== "string" || !REPLACE_TYPES.has(b.session_type)) {
    return {
      error: `session_type must be one of: ${[...REPLACE_TYPES].sort().join(", ")}`,
    };
  }
  return { action: "replace", source_day: b.source_day, session_type: b.session_type, reactive_context };
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ week_start: string }> },
) {
  const { week_start } = await ctx.params;
  if (!isYmd(week_start)) {
    return NextResponse.json({ ok: false, error: "week_start must be YYYY-MM-DD" }, { status: 400 });
  }

  const url = new URL(req.url);
  const confirm = url.searchParams.get("confirm") === "true";

  // 1. Auth
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  // 3. Parse body
  let bodyRaw: unknown;
  try {
    bodyRaw = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "body must be valid JSON" }, { status: 400 });
  }
  const parsed = parseBody(bodyRaw);
  if ("error" in parsed) {
    return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
  }
  const body: SwapBody = parsed;

  // 2. Load
  const { data: row, error: loadErr } = await supabase
    .from("training_weeks")
    .select(TRAINING_WEEK_SELECT)
    .eq("user_id", user.id)
    .eq("week_start", week_start)
    .maybeSingle();
  if (loadErr) {
    return NextResponse.json({ ok: false, error: `load failed: ${loadErr.message}` }, { status: 500 });
  }
  if (!row) {
    return NextResponse.json(
      { ok: false, error: `no training_weeks row for week_start=${week_start}` },
      { status: 404 },
    );
  }

  const current = row.session_plan as SessionPlan;
  const original = row.original_session_plan as SessionPlan | null;

  // 4. Compute new plan
  const newPlan = applySwap(current, body);

  // 5. Identity check
  if (plansEqual(newPlan, current)) {
    return NextResponse.json(
      {
        week: row as TrainingWeek,
        swap: {
          source_day: body.source_day,
          action: body.action,
          before:
            readSessionForDay(current as Record<string, string>, body.source_day) ?? "",
          after:
            readSessionForDay(current as Record<string, string>, body.source_day) ?? "",
        },
      } satisfies SwapResult,
      { status: 200 },
    );
  }

  // 6. Conflict gate
  if (!confirm) {
    const conflicts = detectConflicts(current, body);
    if (conflicts.length > 0) {
      return NextResponse.json(
        { conflicts, preview_plan: newPlan } satisfies SwapConflictResponse,
        { status: 409 },
      );
    }
  }

  // 7. Identity-restore detection
  const isIdentityRestore = original !== null && plansEqual(newPlan, original);

  // Pre-compute which weekdays' session_type changed in the swap. The
  // session_plan jsonb may use short ("Mon") or full ("Monday") keys
  // depending on the writer (Carter writes full names); routing every read
  // through readSessionForDay keeps the loop key-form-agnostic. A raw
  // current[shortKey] comparison would always read undefined on full-name
  // plans and silently report "no changes" — making overrides cleanup AND
  // prescription invalidation no-ops.
  const currentRec = current as Record<string, string>;
  const newPlanRec = newPlan as Record<string, string>;
  const changedFull: string[] = [];
  for (const shortKey of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const) {
    const before = readSessionForDay(currentRec, shortKey);
    const after = readSessionForDay(newPlanRec, shortKey);
    if (before !== after) changedFull.push(SHORT_TO_FULL[shortKey]);
  }

  // 8. Clear exercise_overrides for any day whose session type changed.
  //    Stale overrides would hold exercises for the previous session type.
  const currentOverrides =
    (row.exercise_overrides as ExerciseOverrides | null) ?? null;
  let nextOverrides: ExerciseOverrides | null = currentOverrides;
  if (currentOverrides && changedFull.length > 0) {
    const drop = changedFull.filter((k) => currentOverrides[k]);
    if (drop.length > 0) {
      const cleaned: ExerciseOverrides = { ...currentOverrides };
      for (const k of drop) delete cleaned[k];
      nextOverrides = Object.keys(cleaned).length > 0 ? cleaned : null;
    }
  }

  // 8b. Recompute session_prescriptions when any weekday's session type changed.
  //     session_prescriptions is the top of the resolution chain in
  //     getEffectiveSessionPlan, so a stale entry leaks the previous session's
  //     exercises into TodayPlanCard's body while the header shows the new type.
  //     Recompute via the same engine the Sunday cron uses against the post-swap
  //     session_plan. On recompute failure, fall back to clearing changed-day
  //     entries so we never write a header/body-mismatch state.
  const currentPrescriptions =
    (row.session_prescriptions as SessionPrescriptions | null) ?? null;
  let nextPrescriptions: SessionPrescriptions | null = currentPrescriptions;
  if (currentPrescriptions && changedFull.length > 0) {
    const { data: blockRow } = await supabase
      .from("training_blocks")
      .select("*")
      .eq("user_id", user.id)
      .eq("status", "active")
      .maybeSingle();
    const block = (blockRow as TrainingBlock | null) ?? null;

    const workingRow: TrainingWeek = {
      ...(row as TrainingWeek),
      session_plan: newPlan,
      exercise_overrides: nextOverrides,
      session_prescriptions: currentPrescriptions,
    };

    try {
      const tz = await getUserTimezone(user.id);
      const todayIso = todayInUserTz(new Date(), tz);
      const computed = await prescribeWeek({
        supabase,
        userId: user.id,
        block,
        week: workingRow,
        todayIso,
      });
      // Preserve days ≤ today verbatim (they may carry a morning patch or a
      // mid-week repatch) — UNLESS this swap changed today's session type, in
      // which case today must be recomputed for the new type (boundary =
      // yesterday). Only applies when editing the current week; for other
      // weeks the boundary math in mergePreservedDays no-ops or preserves
      // everything, matching "past days are the historical record".
      const todayIdx = daysBetweenIso(mondayOfIso(todayIso), todayIso);
      const todayWeekday = todayIdx != null ? WEEKDAY_LONG_ORDER[todayIdx] : null;
      const todayChanged = todayWeekday != null && changedFull.includes(todayWeekday);
      nextPrescriptions = mergePreservedDays({
        computed,
        stored: currentPrescriptions,
        weekStart: row.week_start,
        preserveDaysThrough: todayChanged ? isoDaysAgo(todayIso, 1) : todayIso,
      });
    } catch (e) {
      console.error("[swap] prescription recompute failed; clearing stale entries", e);
      const cleared: SessionPrescriptions = { ...currentPrescriptions };
      for (const k of changedFull) delete cleared[k as keyof SessionPrescriptions];
      nextPrescriptions = Object.keys(cleared).length > 0 ? cleared : null;
    }
  }

  // 9. UPDATE
  const update: Record<string, unknown> = {
    session_plan: newPlan,
    exercise_overrides: nextOverrides,
    session_prescriptions: nextPrescriptions,
    updated_at: new Date().toISOString(),
  };
  if (isIdentityRestore) {
    update.original_session_plan = null;
  } else if (original === null) {
    // First edit — snapshot the committed plan.
    update.original_session_plan = current;
  }
  // else: original is already set, subsequent non-restore edit — leave it alone.

  const { data: updated, error: updateErr } = await supabase
    .from("training_weeks")
    .update(update)
    .eq("user_id", user.id)
    .eq("week_start", week_start)
    .select(TRAINING_WEEK_SELECT)
    .single();
  if (updateErr || !updated) {
    return NextResponse.json(
      { ok: false, error: `update failed: ${updateErr?.message ?? "no row returned"}` },
      { status: 500 },
    );
  }

  // 10. Build response — before/after at source_day
  const before =
    readSessionForDay(current as Record<string, string>, body.source_day) ?? "";
  const after =
    readSessionForDay(newPlan as Record<string, string>, body.source_day) ?? "";

  // 11. Record intervention (best-effort — NEVER blocks the swap response).
  //     Only fires when the swap originated from a reactive morning-brief
  //     suggestion (body.reactive_context is present). Uses exercise_swap kind
  //     (closest fit for both swap_exercise and swap_day rungs).
  const capturedReactiveCtx = body.reactive_context; // narrow for async closure
  if (capturedReactiveCtx) {
    void (async () => {
      try {
        // Resolve block context — use the training_weeks row's block_id + a
        // lightweight block select. Falls back to null fields when no active block.
        const blockId = (row as TrainingWeek).block_id ?? null;
        let blockPhase: BlockPhase | null = null;
        let blockWeek: number | null = null;

        if (blockId) {
          const { data: blk } = await supabase
            .from("training_blocks")
            .select("id, status, current_week, block_phase")
            .eq("id", blockId)
            .maybeSingle();
          if (blk) {
            blockPhase = (blk as { block_phase?: BlockPhase }).block_phase ?? null;
            blockWeek = (blk as { current_week?: number }).current_week ?? null;
          }
        }

        // Resolve today's date in the user's timezone for the started_on stamp.
        // Falls back to week_start (Monday of the week) on any error.
        let startedOn = week_start;
        try {
          const tz = await getUserTimezone(user.id);
          startedOn = todayInUserTz(new Date(), tz);
        } catch {
          // tz lookup failed — week_start is an acceptable fallback
        }

        const built = buildExplicitIntervention({
          kind: "exercise_swap",
          started_on: startedOn,
          block_id: blockId,
          block_phase: blockPhase,
          block_week: blockWeek,
          // from_exercise: the original session type (what was swapped away from)
          from_exercise: before || body.source_day,
          // to_exercise: the replacement session type ("Mobility" in swap_day case)
          to_exercise: after || (body.action === "replace" ? body.session_type : ""),
          // reason: closest SwapContext reason — activity/soreness overlap maps to "pain"
          reason: "pain",
        });

        // Stamp the sore regions + rung into context for the evaluator
        (built.context as Record<string, unknown>)["reactive_rung"] = capturedReactiveCtx.rung;
        (built.context as Record<string, unknown>)["reactive_rationale"] = capturedReactiveCtx.rationale;
        if (capturedReactiveCtx.regions.length > 0) {
          (built.context as Record<string, unknown>)["reactive_regions"] = capturedReactiveCtx.regions;
        }

        await recordIntervention(supabase, user.id, built);
      } catch (e) {
        // Capture failure must NEVER surface as a swap error. Log + continue.
        console.warn("[swap] intervention capture failed — swap already succeeded", e);
      }
    })();
  }

  return NextResponse.json(
    {
      week: updated as TrainingWeek,
      swap: {
        source_day: body.source_day,
        action: body.action,
        before,
        after,
      },
    } satisfies SwapResult,
    { status: 200 },
  );
}
