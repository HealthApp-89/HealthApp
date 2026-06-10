// app/api/coach/recipe-discovery/check/route.ts
//
// Daily cron — walks profiles, picks at most one save-recipe candidate per
// user per day. Writes a chat_messages row with kind='proactive_nudge' + the
// save_recipe payload variant. Idempotent on (user_id, fired_on, trigger_key)
// via proactive_nudge_dedup (migration 0017).
//
// Runs at 03:45 UTC (after eating-identity sync at 03:30) — see vercel.json.

import { NextResponse } from "next/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { pickDiscoveryCandidate } from "@/lib/coach/nora-suggestions/recipe-discovery";
import { getUserTimezone } from "@/lib/time/get-user-tz";
import { todayInUserTz } from "@/lib/time";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  const secret = process.env.CRON_SECRET;
  if (!auth || !secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabase = createSupabaseServiceRoleClient();
  const { data: profiles, error } = await supabase
    .from("profiles")
    .select("user_id, eating_identity_cache");
  if (error) {
    return NextResponse.json(
      { error: "read_failed", detail: error.message },
      { status: 500 },
    );
  }

  const fired: Array<{ user_id: string; sig: string }> = [];
  const skipped: Array<{ user_id: string; reason: string }> = [];

  for (const p of profiles ?? []) {
    if (!p.eating_identity_cache) {
      skipped.push({ user_id: p.user_id, reason: "no_identity_cache" });
      continue;
    }
    const tz = await getUserTimezone(p.user_id);
    const today = todayInUserTz(new Date(), tz);
    const cand = await pickDiscoveryCandidate({
      supabase,
      userId: p.user_id,
      identity: p.eating_identity_cache,
      today,
    });
    if (!cand) {
      skipped.push({ user_id: p.user_id, reason: "no_candidate" });
      continue;
    }

    // Write the chat_messages nudge row. Speaker is Nora (recipe discovery is
    // a nutrition-domain nudge). thread='nora' so it surfaces in her tab.
    const { data: inserted, error: msgErr } = await supabase
      .from("chat_messages")
      .insert({
        user_id: p.user_id,
        role: "assistant",
        speaker: "nora",
        thread: "nora",
        kind: "proactive_nudge",
        content: "",
        ui: {
          schema_version: 1,
          trigger_type: "save_recipe",
          trigger_key: `save_recipe:${cand.combo_signature}`,
          severity: "info",
          headline: `Save "${cand.suggested_name}" as a recipe?`,
          body_md: `You've logged this combo ${cand.co_occurrence_count}× recently. Tap save to make it 1-tap to log next time.`,
          deep_link: { label: "View library", href: "/profile/library" },
          speaker: "nora",
          payload: {
            kind: "save_recipe",
            combo_signature: cand.combo_signature,
            items: cand.items,
            suggested_name: cand.suggested_name,
            co_occurrence_count: cand.co_occurrence_count,
            last_seen: cand.last_seen,
            avg_slot: cand.avg_slot,
            per_100g: cand.per_100g,
          },
        },
      })
      .select("id")
      .single();
    if (msgErr || !inserted) {
      console.error("recipe-discovery: insert chat_messages failed", p.user_id, msgErr);
      skipped.push({ user_id: p.user_id, reason: "insert_failed" });
      continue;
    }

    // Stamp the dedup row. Primary key is (user_id, trigger_key, fired_on);
    // a same-day re-fire hits 23505 and is silently absorbed (cron is meant
    // to be idempotent within the day).
    const { error: dedupErr } = await supabase.from("proactive_nudge_dedup").insert({
      user_id: p.user_id,
      trigger_key: `save_recipe:${cand.combo_signature}`,
      fired_on: today,
      chat_message_id: (inserted as { id: string }).id,
    });
    if (dedupErr && dedupErr.code !== "23505") {
      console.error("recipe-discovery: dedup write failed", p.user_id, dedupErr);
    }

    fired.push({ user_id: p.user_id, sig: cand.combo_signature });
  }

  return NextResponse.json({
    fired_count: fired.length,
    skipped_count: skipped.length,
    fired,
  });
}
