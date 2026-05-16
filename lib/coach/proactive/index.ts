// lib/coach/proactive/index.ts
//
// Orchestrator: takes a CoachTrendsPayload, runs all 3 trigger checks,
// dedups against proactive_nudge_dedup (migration 0017 — dedicated table,
// not chat_messages), and either inserts the rendered card or reports it
// as suppressed.
//
// Caller responsibilities:
//   - Compute the trends payload once (single generateCoachTrends call).
//   - Pass a service-role supabase client (this writes chat_messages).
//
// The dry_run flag short-circuits the dedup lookup AND the insert — it
// returns the set of events that WOULD fire on a clean slate. Used by
// scripts/audit-proactive-cron.mjs.

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  CoachTrendsPayload,
  ProactiveEvent,
  ProactiveNudgeCard,
} from "@/lib/data/types";
import { checkPlateau } from "./check-plateau";
import { checkOffPace } from "./check-off-pace";
import { checkHrv } from "./check-hrv";
import { renderCard } from "./render-card";
import { todayInUserTz } from "@/lib/time";

const DEDUP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type ProactiveRunResult = {
  fired: Array<{ event: ProactiveEvent; card: ProactiveNudgeCard }>;
  suppressed: Array<{ event: ProactiveEvent; reason: "dedup_7d" }>;
};

export async function runProactiveChecks(args: {
  supabase: SupabaseClient;
  userId: string;
  trends: CoachTrendsPayload;
  dry_run?: boolean;
}): Promise<ProactiveRunResult> {
  const { supabase, userId, trends, dry_run } = args;
  const today = todayInUserTz();

  const events: ProactiveEvent[] = [
    ...checkPlateau(trends),
    ...checkOffPace(trends),
    ...checkHrv(trends),
  ];

  const fired: ProactiveRunResult["fired"] = [];
  const suppressed: ProactiveRunResult["suppressed"] = [];

  for (const event of events) {
    // Voice variety: pick the template variant deterministically from the
    // user_id + trigger_key + ISO week-of-year, so the same trigger fired in
    // different weeks rotates through phrasings without RNG (test-stable).
    const card = renderCard(event, { userId, today });

    if (dry_run) {
      fired.push({ event, card });
      continue;
    }

    // Dedup: dedicated proactive_nudge_dedup table (migration 0017).
    // chat_messages-based check was fragile to user deletion — deleting a
    // nudge row used to reset the window. Now the dedup row is independent
    // and survives chat-row deletion.
    const cutoff = new Date(Date.now() - DEDUP_WINDOW_MS).toISOString();
    const { data: recent, error: lookupErr } = await supabase
      .from("proactive_nudge_dedup")
      .select("trigger_key")
      .eq("user_id", userId)
      .eq("trigger_key", event.trigger_key)
      .gte("fired_at", cutoff)
      .limit(1)
      .maybeSingle();
    if (lookupErr) {
      throw new Error(
        `proactive dedup lookup failed for ${event.trigger_key}: ${lookupErr.message}`,
      );
    }
    if (recent) {
      suppressed.push({ event, reason: "dedup_7d" });
      continue;
    }

    const { data: inserted, error: insertErr } = await supabase
      .from("chat_messages")
      .insert({
        user_id: userId,
        role: "assistant",
        kind: "proactive_nudge",
        content: card.headline,
        ui: card,
      })
      .select("id")
      .single();
    if (insertErr || !inserted) {
      throw new Error(
        `proactive insert failed for ${event.trigger_key}: ${insertErr?.message ?? "no row"}`,
      );
    }

    // Stamp the dedup row. Same-day re-fires hit the primary-key conflict
    // and are silently absorbed — that's the (user_id, trigger_key, fired_on)
    // unique. Cross-day re-fires within the 7-day window are blocked by the
    // lookup above.
    const { error: dedupErr } = await supabase.from("proactive_nudge_dedup").insert({
      user_id: userId,
      trigger_key: event.trigger_key,
      fired_on: today,
      chat_message_id: (inserted as { id: string }).id,
    });
    if (dedupErr && dedupErr.code !== "23505") {
      // 23505 = unique violation — fine, dedup row already exists for today.
      // Anything else (RLS, permission, network) is worth surfacing.
      console.error(
        `[proactive] dedup row insert failed for ${event.trigger_key} (chat_message persisted)`,
        dedupErr,
      );
    }
    fired.push({ event, card });
  }

  return { fired, suppressed };
}
