// lib/coach/proactive/index.ts
//
// Orchestrator: takes a CoachTrendsPayload, runs all 3 trigger checks,
// dedups against chat_messages (7-day window per trigger_key), and either
// inserts the rendered card or reports it as suppressed.
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

  const events: ProactiveEvent[] = [
    ...checkPlateau(trends),
    ...checkOffPace(trends),
    ...checkHrv(trends),
  ];

  const fired: ProactiveRunResult["fired"] = [];
  const suppressed: ProactiveRunResult["suppressed"] = [];

  for (const event of events) {
    const card = renderCard(event);

    if (dry_run) {
      fired.push({ event, card });
      continue;
    }

    // Dedup query — has a card for this trigger_key landed in the last 7d?
    const cutoff = new Date(Date.now() - DEDUP_WINDOW_MS).toISOString();
    const { data: recent, error: lookupErr } = await supabase
      .from("chat_messages")
      .select("id")
      .eq("user_id", userId)
      .eq("kind", "proactive_nudge")
      .filter("ui->>trigger_key", "eq", event.trigger_key)
      .gte("created_at", cutoff)
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

    const { error: insertErr } = await supabase.from("chat_messages").insert({
      user_id: userId,
      role: "assistant",
      kind: "proactive_nudge",
      content: card.headline,
      ui: card,
    });
    if (insertErr) {
      throw new Error(
        `proactive insert failed for ${event.trigger_key}: ${insertErr.message}`,
      );
    }
    fired.push({ event, card });
  }

  return { fired, suppressed };
}
