// app/api/profile/recurring-activities/route.ts
//
// POST → replace profiles.recurring_activities for the authenticated user.
// Body: RecurringActivity[] (Zod-validated against RecurringActivitySchema).
//
// Auth: session-auth (RLS-respecting server client). Mirrors
// /api/profile/nutrition-overrides for the auth + update pattern.

import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { RecurringActivitySchema } from "@/lib/coach/activity/types";

const BodySchema = z.array(RecurringActivitySchema);

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return NextResponse.json({ error: "body must be valid JSON" }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const activities = parsed.data;

  const { error } = await supabase
    .from("profiles")
    .update({ recurring_activities: activities })
    .eq("user_id", user.id);

  if (error) {
    console.error("[/api/profile/recurring-activities] update failed", error);
    return NextResponse.json({ error: "update_failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, recurring_activities: activities });
}
