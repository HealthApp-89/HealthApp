// app/api/coach/block-progress/route.ts
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { computeBlockProgress } from "@/lib/query/fetchers/blockProgress";
import { getUserTimezone } from "@/lib/time/get-user-tz";

export async function GET() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const tz = await getUserTimezone(user.id);
    const payload = await computeBlockProgress(supabase, user.id, tz);
    return NextResponse.json(payload);
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message ?? "unknown error" },
      { status: 500 },
    );
  }
}
