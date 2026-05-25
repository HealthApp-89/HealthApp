// app/api/profile/goal/route.ts
//
// GET + PUT for the structured goal fields on the user's latest acknowledged
// athlete_profile_documents row. These columns were added in migration 0035
// for the Peter Dashboard's Goal-distance theme and are explicitly mutable
// on the acknowledged document (they didn't exist when prior versions were
// acknowledged, so they're treated as backfillable fields).

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";

export const dynamic = "force-dynamic";

type GoalKind = "lift_e1rm" | "bodyweight_kg" | "bodyfat_pct";
const VALID_KINDS: GoalKind[] = ["lift_e1rm", "bodyweight_kg", "bodyfat_pct"];
const VALID_LIFTS = ["bench", "deadlift", "squat", "ohp"];

type GoalRow = {
  goal_kind: GoalKind | null;
  goal_metric: string | null;
  goal_target: number | null;
  goal_target_date: string | null;
};

export async function GET() {
  const sb = await createSupabaseServerClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { data, error } = await sb
    .from("athlete_profile_documents")
    .select("goal_kind, goal_metric, goal_target, goal_target_date")
    .eq("user_id", user.id)
    .not("acknowledged_at", "is", null)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ goal: (data as GoalRow | null) ?? null });
}

export async function PUT(req: Request) {
  const sb = await createSupabaseServerClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: Partial<GoalRow>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  // Validate.
  if (body.goal_kind != null && !VALID_KINDS.includes(body.goal_kind)) {
    return NextResponse.json({ error: "invalid_goal_kind" }, { status: 400 });
  }
  if (body.goal_kind === "lift_e1rm" && (!body.goal_metric || !VALID_LIFTS.includes(body.goal_metric))) {
    return NextResponse.json({ error: "lift_e1rm_requires_metric" }, { status: 400 });
  }
  if (body.goal_target != null && (!Number.isFinite(body.goal_target) || body.goal_target <= 0)) {
    return NextResponse.json({ error: "goal_target_must_be_positive" }, { status: 400 });
  }
  if (body.goal_target_date != null && !/^\d{4}-\d{2}-\d{2}$/.test(body.goal_target_date)) {
    return NextResponse.json({ error: "goal_target_date_must_be_yyyy_mm_dd" }, { status: 400 });
  }

  // Find latest acknowledged doc.
  const { data: doc, error: lookupErr } = await sb
    .from("athlete_profile_documents")
    .select("id")
    .eq("user_id", user.id)
    .not("acknowledged_at", "is", null)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lookupErr) return NextResponse.json({ error: lookupErr.message }, { status: 500 });
  if (!doc) return NextResponse.json({ error: "no_acknowledged_profile" }, { status: 404 });

  // Update goal_* columns in place. Metric is nulled when kind isn't lift_e1rm.
  const update: Partial<GoalRow> = {
    goal_kind: body.goal_kind ?? null,
    goal_metric: body.goal_kind === "lift_e1rm" ? (body.goal_metric ?? null) : null,
    goal_target: body.goal_target ?? null,
    goal_target_date: body.goal_target_date ?? null,
  };
  const { error: updErr } = await sb
    .from("athlete_profile_documents")
    .update(update)
    .eq("id", doc.id);
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  // Coach dashboard reads the goal at composer time; revalidate so the next
  // /coach page load picks up the new goal without waiting for the cron.
  revalidatePath("/coach");
  revalidatePath("/profile");

  return NextResponse.json({ ok: true });
}
