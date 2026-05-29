// app/api/profile/rotation-priority/route.ts
//
// POST { lift: 'squat'|'bench'|'deadlift'|'ohp'|null } — updates
// profiles.rotation_priority_lift for the authenticated user. Cookie-
// bound, RLS-respecting. Used by the /profile UI dropdown.

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  let body: { lift: string | null };
  try {
    body = (await req.json()) as { lift: string | null };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const lift = body.lift;
  if (lift !== null && !["squat", "bench", "deadlift", "ohp"].includes(lift)) {
    return NextResponse.json({ error: "Invalid lift" }, { status: 400 });
  }

  const { error } = await supabase
    .from("profiles")
    .update({ rotation_priority_lift: lift })
    .eq("user_id", user.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, lift });
}
