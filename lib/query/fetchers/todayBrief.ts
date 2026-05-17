// lib/query/fetchers/todayBrief.ts
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import type { MorningBriefCard } from "@/lib/data/types";

/**
 * Returns today's morning_brief `ui` payload, or null when no brief has been
 * delivered yet. Anchored on `recap.yesterday_date + 1` (the same user-tz
 * heuristic coachRecent.ts uses) so we don't suffer the UTC vs user-tz
 * off-by-one on chat_messages.created_at near local midnight.
 *
 * We pull the newest `morning_brief` row in a small lookback window and
 * filter client-side. The window of 3 days is wide enough to cover the
 * UTC/user-tz boundary; "today" is decided by date math, not `created_at`.
 *
 * Throws on Supabase error so TanStack Query lights up `isError`.
 */
export async function fetchTodayBriefBrowser(
  userId: string,
  today: string,
): Promise<MorningBriefCard | null> {
  const supabase = createSupabaseBrowserClient();

  const { data, error } = await supabase
    .from("chat_messages")
    .select("ui, created_at")
    .eq("user_id", userId)
    .eq("kind", "morning_brief")
    .order("created_at", { ascending: false })
    .limit(3);

  if (error) throw error;

  for (const row of data ?? []) {
    const ui = (row.ui ?? null) as MorningBriefCard | null;
    if (!ui) continue;
    const yesterday = ui.recap?.yesterday_date;
    if (!yesterday) continue;
    // brief day = yesterday + 1, computed without going through Date to
    // avoid timezone hazards. Mirrors coachRecent.ts:addOneDayYmd.
    const [y, m, d] = yesterday.split("-").map((s) => parseInt(s, 10));
    if (!y || !m || !d) continue;
    const utcMs = Date.UTC(y, m - 1, d) + 24 * 60 * 60 * 1000;
    const next = new Date(utcMs);
    const yy = next.getUTCFullYear();
    const mm = String(next.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(next.getUTCDate()).padStart(2, "0");
    const day = `${yy}-${mm}-${dd}`;
    if (day === today) return ui;
  }

  return null;
}
