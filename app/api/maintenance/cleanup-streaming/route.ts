// app/api/maintenance/cleanup-streaming/route.ts
//
// Vercel cron endpoint. Runs every 5 minutes. Marks any chat_messages row
// stuck in status='streaming' for more than 5 minutes as status='error'.
//
// The single-streaming-row-per-user unique partial index in migration 0005
// otherwise locks the user out indefinitely if any pre-stream throw or
// Vercel-timeout strands a row. This is the safety net.

import { NextResponse } from "next/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  // Auth: mirrors /api/whoop/sync pattern (Bearer CRON_SECRET).
  const auth = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  const isCron = cronSecret && auth === `Bearer ${cronSecret}`;

  if (!isCron) {
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  }

  const sr = createSupabaseServiceRoleClient();
  const cutoff = new Date(Date.now() - 5 * 60_000).toISOString();

  const { data, error } = await sr
    .from("chat_messages")
    .update({
      status: "error",
      error: "watchdog_cleanup_stuck_streaming",
      updated_at: new Date().toISOString(),
    })
    .eq("status", "streaming")
    .lt("updated_at", cutoff)
    .select("id, user_id, mode, kind");

  if (error) {
    console.error("[cleanup-streaming] error", error);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const cleaned = data ?? [];
  if (cleaned.length > 0) {
    console.warn(`[cleanup-streaming] cleaned ${cleaned.length} stuck rows`, cleaned);
  }
  return NextResponse.json({ ok: true, cleaned: cleaned.length });
}
