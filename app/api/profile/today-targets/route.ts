// app/api/profile/today-targets/route.ts
//
// GET → { targets: TodayTargets | null }
// Thin wrapper over getTodayTargets so the browser can read today's resolved
// macros / sleep / GLP-1-aware fields without doing the cross-table compute
// client-side. Used by the useTodayTargets hook.

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getTodayTargets } from "@/lib/morning/brief/get-today-targets";

export async function GET() {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const targets = await getTodayTargets(supabase, user.id);
  return NextResponse.json({ targets });
}
