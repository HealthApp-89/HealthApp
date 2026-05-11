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
//   8. UPDATE with COALESCE-on-first-edit (set original=current) OR
//      identity-restore-clears (set original=null) OR no-op (subsequent edit).
//   9. Return SwapResult.

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { applySwap, detectConflicts, plansEqual } from "@/lib/training-weeks/apply-swap";
import { readSessionForDay } from "@/lib/coach/session-plan-reader";
import { SESSION_PLANS } from "@/lib/coach/sessionPlans";
import type {
  SessionPlan,
  SwapBody,
  SwapConflictResponse,
  SwapResult,
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
  "id, user_id, block_id, week_start, session_plan, original_session_plan, weekly_focus, intensity_modifier, rir_target, research_phase, proposed_by, chat_message_id, committed_at, created_at, updated_at";

function isWeekday(s: unknown): s is Weekday {
  return typeof s === "string" && WEEKDAYS.has(s);
}

function isYmd(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
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
  if (b.action === "swap") {
    if (!isWeekday(b.target_day)) {
      return { error: "target_day must be one of Mon|Tue|Wed|Thu|Fri|Sat|Sun" };
    }
    return { action: "swap", source_day: b.source_day, target_day: b.target_day };
  }
  // action === 'replace'
  if (typeof b.session_type !== "string" || !REPLACE_TYPES.has(b.session_type)) {
    return {
      error: `session_type must be one of: ${[...REPLACE_TYPES].sort().join(", ")}`,
    };
  }
  return { action: "replace", source_day: b.source_day, session_type: b.session_type };
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

  // 8. UPDATE
  const update: Record<string, unknown> = {
    session_plan: newPlan,
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

  // 9. Build response — before/after at source_day
  const before =
    readSessionForDay(current as Record<string, string>, body.source_day) ?? "";
  const after =
    readSessionForDay(newPlan as Record<string, string>, body.source_day) ?? "";

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
