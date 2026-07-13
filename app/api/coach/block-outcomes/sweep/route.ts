// app/api/coach/block-outcomes/sweep/route.ts
//
// Daily cron at 02:00 UTC. Scans for training_blocks whose end_date has
// passed and lack a block_outcomes row, runs generateBlockOutcome for
// each, inserts the row, and writes a chat_messages.kind='block_outcome'
// card so the next chat open surfaces it. Idempotent on unique(block_id).

import { NextResponse } from "next/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { generateBlockOutcome } from "@/lib/coach/block-outcomes";
import { generateOutcomeNarrative } from "@/lib/coach/block-outcomes/narrative";
import { todayInUserTz, USER_TIMEZONE } from "@/lib/time";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabase = createSupabaseServiceRoleClient();
  // Cron sweep operates across all users; use the env-var fallback for "today".
  const today = todayInUserTz(new Date(), USER_TIMEZONE);

  const { data: blocks, error } = await supabase
    .from("training_blocks")
    .select("id, user_id, start_date, end_date, primary_lift")
    .lt("end_date", today);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const summary = {
    scanned: 0,
    written: 0,
    skipped: 0,
    failed: 0,
    errors: [] as Array<{ block_id: string; message: string }>,
  };

  for (const b of blocks ?? []) {
    summary.scanned += 1;

    const { data: existing } = await supabase
      .from("block_outcomes")
      .select("id")
      .eq("block_id", b.id)
      .maybeSingle();
    if (existing) { summary.skipped += 1; continue; }

    if (b.primary_lift == null) { summary.skipped += 1; continue; }

    try {
      const { payload } = await generateBlockOutcome({ supabase, userId: b.user_id, blockId: b.id });

      const { narrative } = await generateOutcomeNarrative({
        payload,
        blockWindow: { start_date: b.start_date as string, end_date: b.end_date as string },
      });

      const { error: insErr } = await supabase
        .from("block_outcomes")
        .insert({
          block_id: payload.block_id,
          user_id: payload.user_id,
          primary_lift: payload.primary_lift,
          target_value_kg: payload.target_value_kg,
          target_metric: payload.target_metric,
          end_working_kg: payload.end_working_kg,
          target_hit: payload.target_hit,
          target_hit_at_week: payload.target_hit_at_week,
          block_phase_at_end: payload.block_phase_at_end,
          lessons: payload.lessons,
          recommended_next_focus: payload.recommended_next_focus,
          recommended_target_value_kg: payload.recommended_target_value_kg,
          narrative_md: narrative,
        });
      if (insErr) throw insErr;

      await supabase.from("chat_messages").insert({
        user_id: payload.user_id,
        role: "assistant",
        kind: "block_outcome",
        content: `Block complete: ${payload.primary_lift} focus, ${payload.block_phase_at_end}.`,
        speaker: "carter",
        ui: { block_id: payload.block_id },
      });

      summary.written += 1;
    } catch (e) {
      summary.failed += 1;
      summary.errors.push({ block_id: b.id, message: (e as Error).message });
    }
  }

  return NextResponse.json({ ok: true, summary });
}
