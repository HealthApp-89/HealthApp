// lib/query/fetchers/coachRecent.ts
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import type { MorningBriefCard } from "@/lib/data/types";

export type RecentDay = {
  day: string;            // ISO date YYYY-MM-DD
  band: string | null;    // readiness band string when known
};

/**
 * Returns up to `limit` recent days that received a morning brief, newest first.
 *
 * The readiness band is read from `chat_messages.ui` for the morning-brief
 * card on that day. We could alternatively store it on `checkins` directly,
 * but it lives in the brief payload today — querying chat_messages keeps
 * the source of truth in one place.
 *
 * Throws on Supabase errors so TanStack Query lights up `isError`.
 */
export async function fetchCoachRecentBrowser(
  userId: string,
  limit = 30,
): Promise<RecentDay[]> {
  const supabase = createSupabaseBrowserClient();

  // Strategy: fetch the latest morning_brief messages, derive day + band.
  // This avoids needing a separate checkins query for the days list.
  const { data, error } = await supabase
    .from("chat_messages")
    .select("created_at, ui")
    .eq("user_id", userId)
    .eq("kind", "morning_brief")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;

  // Reduce to one row per day (latest brief wins), preserving order.
  const seen = new Set<string>();
  const result: RecentDay[] = [];
  for (const row of data ?? []) {
    const day = (row.created_at as string).slice(0, 10);
    if (seen.has(day)) continue;
    seen.add(day);
    const ui = (row.ui ?? null) as Partial<MorningBriefCard> | null;
    const band = ui?.readiness?.band ?? null;
    result.push({ day, band });
  }
  return result;
}
