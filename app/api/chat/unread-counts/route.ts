// app/api/chat/unread-counts/route.ts
//
// GET /api/chat/unread-counts
// → { ok: true, counts: { peter: 0, carter: 2, nora: 0, remi: 1 } }
//
// For each of the four coach threads, counts assistant messages
// (kind in coach|morning_brief|weekly_review|proactive_nudge) with
// created_at > profiles.chat_last_seen[thread]. Surfaced as dots on
// the BottomNav tabs (Strength → carter, Diet → nora, Health → remi,
// Metrics → peter).

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const THREADS = ["peter", "carter", "nora", "remi"] as const;
const VISIBLE_KINDS = ["coach", "morning_brief", "weekly_review", "proactive_nudge", "workout_debrief"];

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("chat_last_seen")
    .eq("user_id", user.id)
    .maybeSingle();
  const lastSeen = (profile?.chat_last_seen as Record<string, string> | null) ?? {};

  // Four head-count queries in parallel. supabase-js `count: 'exact'` with
  // `head: true` returns just the count, no rows.
  const counts: Record<string, number> = { peter: 0, carter: 0, nora: 0, remi: 0 };
  await Promise.all(
    THREADS.map(async (t) => {
      let q = supabase
        .from("chat_messages")
        .select("*", { count: "exact", head: true })
        .eq("user_id", user.id)
        .eq("thread", t)
        .eq("role", "assistant")
        .in("kind", VISIBLE_KINDS);
      const since = lastSeen[t];
      if (since) q = q.gt("created_at", since);
      const { count } = await q;
      counts[t] = count ?? 0;
    }),
  );

  return NextResponse.json({ ok: true, counts });
}
