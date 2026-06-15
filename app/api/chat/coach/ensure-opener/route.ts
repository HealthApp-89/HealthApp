// app/api/chat/coach/ensure-opener/route.ts
//
// Ensures there's a coach opener for today. The chat default state used to
// show four mostly-disabled suggestion chips and a static "Message your
// coach…" placeholder — dead UX. A real coach opens with what they noticed.
//
// Behaviour:
//   - If ANY chat_messages with kind='coach' exists for this user+thread
//     within the rolling IDEMPOTENCY_WINDOW_HOURS (UTC `created_at`), do
//     nothing. The void is already filled.
//   - Otherwise, generate a one-line opener via Haiku, insert it as an
//     assistant 'coach' message, return it.
//
// Idempotent. The rolling-window check is the guard; concurrent callers may
// race, but the worst case is two openers — harmless and surfaces in the
// chat thread as two short greetings.
//
// POST: returns { ok: true, message?: ChatMessage, skipped?: true }
//   401 unauthorized
//   500 generation_failed

import { NextResponse } from "next/server";
import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "@/lib/supabase/server";
import { fetchOpenerContext, generateOpener } from "@/lib/coach/opener";
import { SPEAKERS, type Speaker } from "@/lib/data/types";

export const dynamic = "force-dynamic";

/** Rolling window for "have we already sent this coach an opener?".
 *  Wider than 24h is wasteful; narrower risks TZ-edge double-fires (the
 *  prior `today + T00:00:00Z` boundary mismatched user-TZ Dubai by 4h and
 *  produced 7 phantom openers on 2026-06-09 22:38–22:41 UTC when reloading
 *  the broken page). 18h is the sweet spot — covers a normal day with
 *  margin, but small enough that yesterday's opener doesn't suppress
 *  today's. */
const IDEMPOTENCY_WINDOW_HOURS = 18;

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  }

  // Active coach thread. Client passes the surface the user is on (Carter
  // for /strength, Nora for /diet, Remi for /health, Peter for /coach).
  // Without it the opener lands in Peter's thread regardless of where the
  // user is and never surfaces on the carter/nora/remi side — and the row
  // returned with undefined speaker crashes HandoffLine downstream.
  let thread: Speaker = "peter";
  try {
    const body = (await req.json()) as { thread?: string } | null;
    if (body && typeof body.thread === "string" && (SPEAKERS as readonly string[]).includes(body.thread)) {
      thread = body.thread as Speaker;
    }
  } catch {
    // No body — keep default. Older clients fall through to Peter, matching
    // the prior (broken) behaviour without crashing.
  }

  const sr = createSupabaseServiceRoleClient();

  // Idempotency: did this thread already get an opener in the rolling window?
  // Thread-scoped so Carter's surface doesn't get skipped by an existing
  // Peter-thread opener.
  const cutoff = new Date(
    Date.now() - IDEMPOTENCY_WINDOW_HOURS * 60 * 60 * 1000,
  ).toISOString();
  const { data: existing } = await sr
    .from("chat_messages")
    .select("id")
    .eq("user_id", user.id)
    .eq("kind", "coach")
    .eq("thread", thread)
    .gte("created_at", cutoff)
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
      speaker: thread,
      thread,
    })
    .select(
      "id, role, kind, content, ui, created_at, updated_at, status, error, model, tool_calls, speaker, thread",
    )
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
