// app/api/chat/mark-thread-seen/route.ts
//
// POST /api/chat/mark-thread-seen { thread: 'peter'|'carter'|'nora'|'remi' }
//
// Stamps profiles.chat_last_seen[thread] = now(). Called by specialist
// pages (Strength/Diet/Health) and Metrics (Peter) on mount so the
// BottomNav unread dot for that coach clears.

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const VALID_THREADS = ["peter", "carter", "nora", "remi"] as const;

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  const raw = body as { thread?: unknown };
  const thread = typeof raw.thread === "string" ? raw.thread : "";
  if (!VALID_THREADS.includes(thread as (typeof VALID_THREADS)[number])) {
    return NextResponse.json({ ok: false, error: "invalid thread" }, { status: 400 });
  }

  // Read-then-write (RLS-scoped) — there's no native JSONB-merge helper
  // across the supabase-js + postgres path, so we round-trip the column.
  const { data: profile } = await supabase
    .from("profiles")
    .select("chat_last_seen")
    .eq("user_id", user.id)
    .maybeSingle();
  const current = (profile?.chat_last_seen as Record<string, string> | null) ?? {};
  const next = { ...current, [thread]: new Date().toISOString() };

  const { error } = await supabase
    .from("profiles")
    .update({ chat_last_seen: next })
    .eq("user_id", user.id);
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
