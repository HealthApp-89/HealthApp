// app/api/blocks/recommendation/route.ts
import { NextResponse } from "next/server";
import { createSupabaseServerClient, createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { computeTargetRecommendation } from "@/lib/coach/prescription/calibrate-target";
import { getUserTimezone } from "@/lib/time/get-user-tz";
import { todayInUserTz } from "@/lib/time";
import type { SupabaseClient } from "@supabase/supabase-js";

const LIFTS = ["squat", "bench", "deadlift", "ohp"] as const;
type Lift = (typeof LIFTS)[number];

export async function GET(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const lift = url.searchParams.get("lift") as Lift | null;
  if (!lift || !LIFTS.includes(lift)) {
    return NextResponse.json(
      { ok: false, error: "lift param must be one of squat|bench|deadlift|ohp", code: "invalid_input" },
      { status: 422 },
    );
  }

  const sr = createSupabaseServiceRoleClient() as unknown as SupabaseClient;
  const tz = await getUserTimezone(user.id);
  const todayIso = todayInUserTz(new Date(), tz);

  const rec = await computeTargetRecommendation({ supabase: sr, userId: user.id, lift, todayIso });
  return NextResponse.json({
    ok: true,
    recommended_target: rec.recommended_target,
    sanity_bounds: rec.sanity_bounds,
    current_e1rm: rec.current_e1rm,
    slope_kg_per_wk: rec.slope_kg_per_wk,
    used: rec.used,
  });
}
