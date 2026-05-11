// app/api/chat/morning/retry-brief/route.ts
//
// POST: retry the morning brief generation. Only valid when
// checkins.intake_state === 'brief_failed' for today.

import { NextResponse } from "next/server";
import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "@/lib/supabase/server";
import { todayInUserTz } from "@/lib/time";
import type { CheckinRow, MorningBriefCard } from "@/lib/data/types";
import { buildMorningBrief } from "@/lib/morning/brief";

export const dynamic = "force-dynamic";

export async function POST() {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  }

  const today = todayInUserTz();
  const sr = createSupabaseServiceRoleClient();

  const { data: row } = await sr
    .from("checkins")
    .select("intake_state")
    .eq("user_id", user.id)
    .eq("date", today)
    .maybeSingle<Pick<CheckinRow, "intake_state">>();
  if (!row) {
    return NextResponse.json({ ok: false, reason: "no_row" }, { status: 409 });
  }
  if (row.intake_state !== "brief_failed") {
    return NextResponse.json({ ok: false, reason: "not_in_retry_state" }, { status: 409 });
  }

  await sr.from("checkins").upsert(
    { user_id: user.id, date: today, intake_state: "assembling_brief" },
    { onConflict: "user_id,date" },
  );

  let card: MorningBriefCard;
  try {
    card = await buildMorningBrief(sr, user.id);
  } catch (err) {
    console.error("[morning brief retry] AI generation failed", err);
    await sr.from("checkins").upsert(
      { user_id: user.id, date: today, intake_state: "brief_failed" },
      { onConflict: "user_id,date" },
    );
    return NextResponse.json({ ok: false, reason: "brief_failed" }, { status: 500 });
  }

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
    console.error("[morning brief retry] insert failed", insertErr);
    await sr.from("checkins").upsert(
      { user_id: user.id, date: today, intake_state: "brief_failed" },
      { onConflict: "user_id,date" },
    );
    return NextResponse.json({ ok: false, reason: "insert_failed" }, { status: 500 });
  }

  try {
    const { error: stateErr } = await sr.from("checkins").upsert(
      { user_id: user.id, date: today, intake_state: "brief_delivered" },
      { onConflict: "user_id,date" },
    );
    if (stateErr) {
      console.error("[morning brief retry] final state upsert failed (brief inserted, state may be stranded at assembling_brief)", stateErr);
      // Don't fail the request — the brief is delivered.
    }
  } catch (stateErr) {
    console.error("[morning brief retry] final state upsert threw (brief inserted, state may be stranded at assembling_brief)", stateErr);
  }

  return NextResponse.json({ ok: true, message: inserted });
}

function composeContentFallback(card: MorningBriefCard): string {
  const sessionLine = card.variant === "training"
    ? `Today: ${card.session.type} at ${card.session.start_time}`
    : "Today: REST";
  return `Morning brief — ${sessionLine}. Readiness ${card.readiness.band}. Tap to view the full card.`;
}
