// app/api/chat/coach/ensure-opener/route.ts
//
// Ensures there's a coach opener for today. The chat default state used to
// show four mostly-disabled suggestion chips and a static "Message your
// coach…" placeholder — dead UX. A real coach opens with what they noticed.
//
// Behaviour:
//   - If ANY chat_messages with kind='coach' exists for this user today
//     (user TZ), do nothing. The void is already filled (either the prior
//     opener or a user-initiated turn).
//   - Otherwise, generate a one-line opener via Haiku, insert it as an
//     assistant 'coach' message, return it.
//
// Idempotent. The "any coach message today" check is the guard; concurrent
// callers may race, but the worst case is two openers — harmless and
// surfaces in the chat thread as two short greetings.
//
// POST: returns { ok: true, message?: ChatMessage, skipped?: true }
//   401 unauthorized
//   500 generation_failed

import { NextResponse } from "next/server";
import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "@/lib/supabase/server";
import { todayInUserTz } from "@/lib/time";
import { fetchOpenerContext, generateOpener } from "@/lib/coach/opener";

export const dynamic = "force-dynamic";

export async function POST() {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  }
  const sr = createSupabaseServiceRoleClient();
  const today = todayInUserTz();

  // Idempotency: any coach-kind message today?
  // We compare on UTC-date-string of created_at; the route is single-user so
  // a fixed UTC bucket roughly aligned with user-tz today is sufficient.
  const todayStart = `${today}T00:00:00Z`;
  const tomorrow = (() => {
    const d = new Date(todayStart);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString();
  })();
  const { data: existing } = await sr
    .from("chat_messages")
    .select("id")
    .eq("user_id", user.id)
    .eq("kind", "coach")
    .gte("created_at", todayStart)
    .lt("created_at", tomorrow)
    .limit(1)
    .maybeSingle();
  if (existing) {
    return NextResponse.json({ ok: true, skipped: true });
  }

  let opener: string;
  try {
    const ctx = await fetchOpenerContext(sr, user.id);
    opener = await generateOpener(ctx);
    if (!opener || opener.length < 4) {
      throw new Error("empty_opener");
    }
  } catch (err) {
    console.error("[opener] generation failed", err);
    return NextResponse.json({ ok: false, reason: "generation_failed" }, { status: 500 });
  }

  const { data: inserted, error: insertErr } = await sr
    .from("chat_messages")
    .insert({
      user_id: user.id,
      role: "assistant",
      kind: "coach",
      content: opener,
      status: "done",
    })
    .select("id, role, kind, content, ui, created_at, updated_at, status, error, model, tool_calls")
    .single();
  if (insertErr || !inserted) {
    console.error("[opener] insert failed", insertErr);
    return NextResponse.json({ ok: false, reason: "insert_failed" }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    message: {
      ...inserted,
      images: [],
    },
  });
}
