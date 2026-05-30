// app/api/profile/endurance-profile/route.ts
//
// POST → partial update of endurance_profile on the user's active
// athlete_profile_documents row. Same semantics as
// /api/profile/nutrition-overrides: undefined keeps, null clears, value sets.
//
// Validation:
//   - discipline / phase: enum (only Carter can change these via chat; UI ships
//     them as display-only in Phase 1, but the schema accepts them defensively)
//   - threshold_hr: int in [80, 220] or null
//   - hr_max:       int in [120, 230] or null
//   - ftp_watts:    int in [50, 600]  or null
//   - weekly_volume_target_hours: number in [0.5, 20]
//   - Unknown top-level keys rejected (.strict).

import { NextResponse } from "next/server";
import { z } from "zod";
import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "@/lib/supabase/server";
import type { EnduranceProfile } from "@/lib/coach/endurance/types";

const PatchSchema = z
  .object({
    discipline: z.enum(["cycling", "running", "triathlon"]).optional(),
    phase: z
      .enum(["aerobic_base", "build", "race_prep", "taper", "off_season"])
      .optional(),
    threshold_hr: z.number().int().min(80).max(220).nullable().optional(),
    hr_max: z.number().int().min(120).max(230).nullable().optional(),
    ftp_watts: z.number().int().min(50).max(600).nullable().optional(),
    weekly_volume_target_hours: z.number().min(0.5).max(20).optional(),
  })
  .strict();

const DEFAULTS: EnduranceProfile = {
  discipline: "cycling",
  phase: "aerobic_base",
  threshold_hr: null,
  hr_max: null,
  hr_zones: null,
  ftp_watts: null,
  threshold_pace_s_per_km: null,
  weekly_volume_target_hours: 1,
  current_race: null,
  set_at: new Date(0).toISOString(),
};

export async function POST(req: Request) {
  const sb = await createSupabaseServerClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const parsed = PatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // Look up the active athlete profile row (status = 'active' is the same
  // filter fetchActiveProfileServer uses across the app).
  const svc = createSupabaseServiceRoleClient();
  const { data: row, error: readErr } = await svc
    .from("athlete_profile_documents")
    .select("id, endurance_profile")
    .eq("user_id", user.id)
    .eq("status", "active")
    .maybeSingle();
  if (readErr) {
    return NextResponse.json({ error: readErr.message }, { status: 500 });
  }
  if (!row) {
    return NextResponse.json({ error: "no_active_profile" }, { status: 400 });
  }

  // Merge patch into existing endurance_profile. null clears a nullable
  // field; undefined keeps current value. Defaults seed any missing keys
  // so the column always satisfies the EnduranceProfile shape after first
  // write.
  const existing =
    (row.endurance_profile as EnduranceProfile | null) ?? DEFAULTS;
  const merged: EnduranceProfile = {
    ...existing,
    ...parsed.data,
    set_at: new Date().toISOString(),
  };

  const { error: upErr } = await svc
    .from("athlete_profile_documents")
    .update({ endurance_profile: merged })
    .eq("id", row.id);
  if (upErr) {
    console.error(
      "[/api/profile/endurance-profile] update failed",
      upErr,
    );
    return NextResponse.json({ error: "update_failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, endurance_profile: merged });
}
