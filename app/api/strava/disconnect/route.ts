// app/api/strava/disconnect/route.ts — POST to revoke + delete tokens.

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { deauthorizeUser } from "@/lib/strava/client";

export async function POST() {
  const sb = await createSupabaseServerClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  await deauthorizeUser(user.id);
  return NextResponse.json({ ok: true });
}
