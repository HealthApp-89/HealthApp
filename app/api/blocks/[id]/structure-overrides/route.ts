// app/api/blocks/[id]/structure-overrides/route.ts
//
// PATCH — write or clear a session_type key inside
// training_blocks.session_structure_overrides (migration 0051).
//
// Body: { session_type: string, override: { order?, sets? } | null }
//
//  - null override  → delete this session_type's key (auto-set column to NULL
//                     when the resulting object is empty).
//  - non-null       → validate order/sets against the UNION of
//                     SESSION_PLANS[session_type] names and the current week's
//                     resolved names for days with this session type, then
//                     merge-write the key.
//
// Guards:
//  1. Block must exist, be owned by the session user, and have status='active'
//     (→ 404 / 409).
//  2. session_type must be a key of SESSION_PLANS.
//  3. order/sets validated against the union set of names.
//
// Side-effects after a successful write:
//  A. Re-run prescribeWeek for the CURRENT week and upsert
//     training_weeks.session_prescriptions (so the engine immediately sees the
//     new structure preference).
//  B. Apply the override's order + sets into the current week's
//     manual_session_edits for every weekday whose session type matches
//     session_type, so the UI sees the change without waiting for Sunday cron.

import { NextResponse } from "next/server";
import { createSupabaseServerClient, createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { SESSION_PLANS } from "@/lib/coach/sessionPlans";
import { getUserTimezone } from "@/lib/time/get-user-tz";
import { todayInUserTz } from "@/lib/time";
import { currentWeekMonday } from "@/lib/coach/week";
import { readSessionForDay } from "@/lib/coach/session-plan-reader";
import { resolveSessionPlan } from "@/lib/logger/resolve-plan";
import { upsertWeekPrescription, WEEKDAY_LONG_ORDER } from "@/lib/coach/prescription/upsert-week-prescription";
import type {
  SessionStructureOverrides,
  ManualSessionEdits,
  WeekdayLong,
  TrainingBlock,
  TrainingWeek,
  SessionPrescriptions,
  ExerciseOverrides,
} from "@/lib/data/types";
import type { SupabaseClient } from "@supabase/supabase-js";

function validateOverride(
  override: { order?: unknown; sets?: unknown },
  allowedNames: Set<string>,
): { ok: true } | { ok: false; error: string } {
  // Validate order: must be a permutation of allowed names when present.
  if (override.order !== undefined) {
    if (!Array.isArray(override.order)) {
      return { ok: false, error: "order must be an array of exercise names" };
    }
    const orderArr = override.order as unknown[];
    if (!orderArr.every((n) => typeof n === "string")) {
      return { ok: false, error: "order entries must be strings" };
    }
    const names = orderArr as string[];
    if (names.length !== allowedNames.size) {
      return {
        ok: false,
        error: `order must be a complete permutation of the session's exercises (expected ${allowedNames.size} names, got ${names.length})`,
      };
    }
    for (const n of names) {
      if (!allowedNames.has(n)) {
        return { ok: false, error: `order contains unknown exercise name "${n}"` };
      }
    }
    // Check for duplicates by comparing unique count.
    if (new Set(names).size !== names.length) {
      return { ok: false, error: "order contains duplicate exercise names" };
    }
  }

  // Validate sets: integer 1–10 per named exercise.
  if (override.sets !== undefined) {
    if (typeof override.sets !== "object" || override.sets === null || Array.isArray(override.sets)) {
      return { ok: false, error: "sets must be an object mapping exercise names to integers" };
    }
    const setsMap = override.sets as Record<string, unknown>;
    for (const [name, count] of Object.entries(setsMap)) {
      if (!allowedNames.has(name)) {
        return { ok: false, error: `sets contains unknown exercise name "${name}"` };
      }
      if (!Number.isInteger(count) || (count as number) < 1 || (count as number) > 10) {
        return { ok: false, error: `sets["${name}"] must be an integer between 1 and 10` };
      }
    }
  }

  return { ok: true };
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: blockId } = await ctx.params;

  // Session auth.
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  // Parse body.
  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ ok: false, error: "body must be valid JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ ok: false, error: "body must be an object" }, { status: 400 });
  }
  const b = body as Record<string, unknown>;

  if (typeof b.session_type !== "string" || !SESSION_PLANS[b.session_type]) {
    return NextResponse.json(
      { ok: false, error: `session_type must be a key of SESSION_PLANS (${Object.keys(SESSION_PLANS).join("|")})`, code: "invalid_session_type" },
      { status: 400 },
    );
  }
  const sessionType = b.session_type;

  const rawOverride = "override" in b ? b.override : undefined;
  if (rawOverride !== null && rawOverride !== undefined && typeof rawOverride !== "object") {
    return NextResponse.json({ ok: false, error: "override must be an object or null" }, { status: 400 });
  }

  const sr = createSupabaseServiceRoleClient() as unknown as SupabaseClient;

  // Load + own-check the block.
  const { data: blockRow, error: blockErr } = await supabase
    .from("training_blocks")
    .select("*")
    .eq("id", blockId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (blockErr) {
    return NextResponse.json({ ok: false, error: `block fetch failed: ${blockErr.message}` }, { status: 500 });
  }
  if (!blockRow) {
    return NextResponse.json(
      { ok: false, error: `block ${blockId} not found or not owned`, code: "not_found" },
      { status: 404 },
    );
  }
  const block = blockRow as TrainingBlock;
  if (block.status !== "active") {
    return NextResponse.json(
      { ok: false, error: `block ${blockId} is not active (status=${block.status})`, code: "not_active" },
      { status: 409 },
    );
  }

  // Determine timezone and current week.
  const tz = await getUserTimezone(user.id);
  const todayIso = todayInUserTz(new Date(), tz);
  const thisMonday = currentWeekMonday(new Date(), tz);

  // Build the union of allowed names:
  //   SESSION_PLANS[session_type] names UNION current week's resolved names for
  //   all days scheduled as session_type.
  const staticNames = new Set<string>(SESSION_PLANS[sessionType].map((e) => e.name));

  // Load current week row for resolved-names union + side-effects.
  const { data: weekRow, error: weekErr } = await supabase
    .from("training_weeks")
    .select("*")
    .eq("user_id", user.id)
    .eq("week_start", thisMonday)
    .maybeSingle();
  if (weekErr) {
    return NextResponse.json({ ok: false, error: `week fetch failed: ${weekErr.message}` }, { status: 500 });
  }
  const week = (weekRow as TrainingWeek | null) ?? null;

  const allowedNames = new Set(staticNames);
  if (week) {
    // For every weekday whose session type is sessionType, resolve the exercise
    // names and add them to the union.
    for (const wd of WEEKDAY_LONG_ORDER) {
      const dayType = readSessionForDay(week.session_plan as Record<string, string>, wd);
      if (dayType === sessionType) {
        const dayResolved = await resolveSessionPlan({
          supabase: sr,
          userId: user.id,
          sessionType,
          weekdayLong: wd,
          weekOverrides: (week.exercise_overrides as ExerciseOverrides | null) ?? null,
          weekPrescriptions: (week.session_prescriptions as SessionPrescriptions | null) ?? null,
          manualEdits: null,
        });
        for (const e of dayResolved.exercises) allowedNames.add(e.name);
      }
    }
  }

  // Read-modify-write of session_structure_overrides.
  const existingOverrides = (block.session_structure_overrides as SessionStructureOverrides | null) ?? {};

  let updatedOverrides: SessionStructureOverrides;
  if (rawOverride === null || rawOverride === undefined) {
    // Clear this session_type's key.
    const { [sessionType]: _removed, ...rest } = existingOverrides;
    updatedOverrides = rest;
  } else {
    const overrideObj = rawOverride as { order?: unknown; sets?: unknown };
    const validation = validateOverride(overrideObj, allowedNames);
    if (!validation.ok) {
      return NextResponse.json({ ok: false, error: validation.error, code: "invalid_override" }, { status: 422 });
    }
    updatedOverrides = {
      ...existingOverrides,
      [sessionType]: overrideObj as { order?: string[]; sets?: Record<string, number> },
    };
  }

  const newOverridesValue = Object.keys(updatedOverrides).length === 0 ? null : updatedOverrides;

  const { error: blockWriteErr } = await sr
    .from("training_blocks")
    .update({ session_structure_overrides: newOverridesValue, updated_at: new Date().toISOString() })
    .eq("id", blockId)
    .eq("user_id", user.id);
  if (blockWriteErr) {
    return NextResponse.json({ ok: false, error: `block write failed: ${blockWriteErr.message}` }, { status: 500 });
  }

  // Side-effect A: re-run prescribeWeek for the current week so the engine
  // immediately sees the new structure preference in session_prescriptions.
  if (week) {
    try {
      await upsertWeekPrescription({
        supabase: sr,
        userId: user.id,
        weekStart: thisMonday,
        todayIso,
        // Preserve days through yesterday so past days aren't rewritten.
        preserveDaysThrough: todayIso,
      });
    } catch (e) {
      console.error("[structure-overrides] prescribeWeek failed (non-fatal):", e);
      // Non-fatal: the block override was already written; the cron will catch up Sunday.
    }
  }

  // Side-effect B: apply override's order + sets into manual_session_edits for
  // every weekday in the current week that matches session_type, so the UI sees
  // the change immediately without waiting for the prescription.
  if (week && rawOverride !== null && rawOverride !== undefined) {
    const overrideObj = rawOverride as { order?: string[]; sets?: Record<string, number> };
    const existingManual = (week.manual_session_edits as ManualSessionEdits | null) ?? {};
    let manualUpdated = { ...existingManual };

    for (const wd of WEEKDAY_LONG_ORDER) {
      const dayType = readSessionForDay(week.session_plan as Record<string, string>, wd);
      if (dayType !== sessionType) continue;

      // Resolve the day's exercise list to get correct names for the manual edit.
      const dayResolved = await resolveSessionPlan({
        supabase: sr,
        userId: user.id,
        sessionType,
        weekdayLong: wd,
        weekOverrides: (week.exercise_overrides as ExerciseOverrides | null) ?? null,
        weekPrescriptions: (week.session_prescriptions as SessionPrescriptions | null) ?? null,
        manualEdits: null,
      });
      const dayNames = new Set(dayResolved.exercises.map((e) => e.name));

      // Build a day-edit from the override: filter order/sets to only names
      // that exist in this specific day's exercises (union might include extra).
      const dayEdit: { order?: string[]; exercises?: Record<string, { sets?: number }> } = {};

      if (overrideObj.order) {
        const filteredOrder = overrideObj.order.filter((n) => dayNames.has(n));
        if (filteredOrder.length === dayResolved.exercises.length) {
          dayEdit.order = filteredOrder;
        }
      }
      if (overrideObj.sets) {
        const filteredSets: Record<string, { sets?: number }> = {};
        for (const [name, count] of Object.entries(overrideObj.sets)) {
          if (dayNames.has(name)) filteredSets[name] = { sets: count };
        }
        if (Object.keys(filteredSets).length > 0) {
          dayEdit.exercises = { ...(dayEdit.exercises ?? {}), ...filteredSets };
        }
      }

      if (dayEdit.order || dayEdit.exercises) {
        manualUpdated = { ...manualUpdated, [wd as WeekdayLong]: dayEdit };
      }
    }

    const newManualValue = Object.keys(manualUpdated).length === 0 ? null : manualUpdated;
    const { error: manualWriteErr } = await sr
      .from("training_weeks")
      .update({ manual_session_edits: newManualValue, updated_at: new Date().toISOString() })
      .eq("user_id", user.id)
      .eq("week_start", thisMonday);
    if (manualWriteErr) {
      console.error("[structure-overrides] manual_session_edits write failed (non-fatal):", manualWriteErr.message);
      // Non-fatal: block override already written; manual edits are convenience only.
    }
  }

  return NextResponse.json({
    ok: true,
    session_structure_overrides: newOverridesValue,
  });
}
