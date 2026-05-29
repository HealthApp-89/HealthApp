// app/api/chat/nudge-dismiss/route.ts
//
// Dismiss a proactive nudge — writes a proactive_nudge_dedup row keyed by
// (user_id, trigger_key, fired_on=today). Row existence alone is the dedup
// signal; the cron's existing 30-day window lookup against
// proactive_nudge_dedup blocks re-fires.
//
// v1 adaptation (Task 17 Adaptation A, option b):
//
// The plan's source attempted to set a `dismissed_at` timestamptz on the row
// and use a 90-day post-dismiss block. Migration 0017 schema does not have
// that column — `proactive_nudge_dedup` is (user_id, trigger_key, fired_on,
// fired_at, chat_message_id). Adding the column would require a new
// migration; the row-existence-as-signal approach is functionally sufficient
// for v1.
//
// Effective dedup window: matches the recipe-discovery cron's 30-day
// `RATE_LIMIT_WINDOW_DAYS` lookup (see lib/coach/nora-suggestions/
// recipe-discovery.ts). An explicit 90-day post-dismiss block is deferred to
// v2 (requires schema change + cron query update).

import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const Body = z.object({ trigger_key: z.string().min(1) });

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const today = new Date().toISOString().slice(0, 10);

  // Upsert: if the cron already inserted the row earlier today, the conflict
  // is a no-op (we have nothing additional to write since there's no
  // dismissed_at column in v1). If the row doesn't exist (user dismissed a
  // card surfaced via a different path), we insert it so subsequent cron runs
  // see the trigger as already-fired.
  const { error } = await supabase
    .from("proactive_nudge_dedup")
    .upsert(
      {
        user_id: user.id,
        trigger_key: parsed.data.trigger_key,
        fired_on: today,
      },
      { onConflict: "user_id,trigger_key,fired_on" },
    );
  if (error) {
    return NextResponse.json(
      { error: "write_failed", detail: error.message },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
