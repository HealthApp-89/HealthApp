// app/api/chat/morning/recommendation/route.ts
//
// POST: deliver today's structured morning brief as the next assistant
// message in the morning_intake thread. Replaces the prior free-text
// recommendation (which streamed via SSE) with a single JSON response
// containing a kind='morning_brief' message and its structured ui jsonb
// payload (MorningBriefCard).
//
// Body: {} | {skip_whoop: true}
// Status codes preserved from the prior implementation:
//   401 unauthorized
//   409 no_row | already_delivered
//   425 awaiting_whoop (only when no skip_whoop and WHOOP data missing)
//   500 brief_failed (AI generation failed — state transitions, client retries)
//   200 success — JSON body { ok: true, message }

import { NextResponse } from "next/server";
import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "@/lib/supabase/server";
import { todayInUserTz } from "@/lib/time";
import type { CheckinRow, DailyLog, MorningBriefCard } from "@/lib/data/types";
import { buildMorningBrief } from "@/lib/morning/brief";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as { skip_whoop?: boolean };
  const today = todayInUserTz();
  const sr = createSupabaseServiceRoleClient();

  // Fetch today's checkin row
  const { data: row } = await sr
    .from("checkins")
    .select("*")
    .eq("user_id", user.id)
    .eq("date", today)
    .maybeSingle<CheckinRow>();
  if (!row) {
    return NextResponse.json({ ok: false, reason: "no_row" }, { status: 409 });
  }

  // Idempotency: brief already delivered for today
  if (row.intake_state === "brief_delivered") {
    const existing = await loadExistingBriefMessage(sr, user.id, today);
    if (existing) {
      return NextResponse.json({ ok: false, reason: "already_delivered", message: existing }, { status: 409 });
    }
    return NextResponse.json({ ok: false, reason: "already_delivered" }, { status: 409 });
  }

  // Concurrency: another request is in flight
  if (row.intake_state === "assembling_brief") {
    return NextResponse.json({ ok: false, reason: "assembling" }, { status: 409 });
  }

  // WHOOP gating: same as legacy behaviour
  const { data: log } = await sr
    .from("daily_logs")
    .select("*")
    .eq("user_id", user.id)
    .eq("date", today)
    .maybeSingle<DailyLog>();
  if (!body.skip_whoop && (!log || log.recovery == null)) {
    if (row.intake_state !== "awaiting_whoop") {
      await sr.from("checkins").upsert(
        { user_id: user.id, date: today, intake_state: "awaiting_whoop" },
        { onConflict: "user_id,date" },
      );
    }
    return NextResponse.json({ ok: false, reason: "awaiting_whoop" }, { status: 425 });
  }

  // Pipeline: transition to assembling, generate, write, transition to delivered
  await sr.from("checkins").upsert(
    { user_id: user.id, date: today, intake_state: "assembling_brief" },
    { onConflict: "user_id,date" },
  );

  let card: MorningBriefCard;
  try {
    card = await buildMorningBrief(sr, user.id);
  } catch (err) {
    console.error("[morning brief] AI generation failed", err);
    await sr.from("checkins").upsert(
      { user_id: user.id, date: today, intake_state: "brief_failed" },
      { onConflict: "user_id,date" },
    );
    return NextResponse.json({ ok: false, reason: "brief_failed" }, { status: 500 });
  }

  // Write the assistant message
  const contentSummary = composeContentFallback(card);
  const { data: inserted, error: insertErr } = await sr
    .from("chat_messages")
    .insert({
      user_id: user.id,
      role: "assistant",
      kind: "morning_brief",
      content: contentSummary,
      ui: card,
    })
    .select("id, role, kind, content, ui, created_at")
    .single();
  if (insertErr || !inserted) {
    console.error("[morning brief] insert failed", insertErr);
    await sr.from("checkins").upsert(
      { user_id: user.id, date: today, intake_state: "brief_failed" },
      { onConflict: "user_id,date" },
    );
    return NextResponse.json({ ok: false, reason: "insert_failed" }, { status: 500 });
  }

  await sr.from("checkins").upsert(
    { user_id: user.id, date: today, intake_state: "brief_delivered" },
    { onConflict: "user_id,date" },
  );

  return NextResponse.json({ ok: true, message: inserted });
}

async function loadExistingBriefMessage(
  sr: ReturnType<typeof createSupabaseServiceRoleClient>,
  userId: string,
  today: string,
) {
  const { data } = await sr
    .from("chat_messages")
    .select("id, role, kind, content, ui, created_at")
    .eq("user_id", userId)
    .eq("kind", "morning_brief")
    .gte("created_at", `${today}T00:00:00Z`)
    .lte("created_at", `${today}T23:59:59Z`)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

/** Plain-text fallback for `chat_messages.content`. Renders in chat history
 *  lists / clients that don't know how to consume `kind='morning_brief'`. */
function composeContentFallback(card: MorningBriefCard): string {
  const sessionLine = card.variant === "training"
    ? `Today: ${card.session.type} at ${card.session.start_time}`
    : "Today: REST";
  return `Morning brief — ${sessionLine}. Readiness ${card.readiness.band}. Tap to view the full card.`;
}
