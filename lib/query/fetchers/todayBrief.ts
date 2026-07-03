// lib/query/fetchers/todayBrief.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MorningBriefCard } from "@/lib/data/types";
import { createFetcher } from "@/lib/query/fetchers/create-fetcher";

const COLS = "ui, created_at";

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
 * Both variants throw on Supabase error so TanStack Query lights up `isError`.
 *
 * Server variant takes the supabase client as an argument so the caller (a
 * Server Component) controls cookie/auth scoping — mirrors the pattern in
 * dailyLogs.ts.
 */

/** Shared pure filter: pick the row whose recap.yesterday_date + 1 === today. */
function pickTodayBrief(
  rows: Array<{ ui: unknown; created_at: string }> | null,
  today: string,
): MorningBriefCard | null {
  for (const row of rows ?? []) {
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

const todayBrief = createFetcher(
  async (supabase: SupabaseClient, userId: string, today: string): Promise<MorningBriefCard | null> => {
    const { data, error } = await supabase
      .from("chat_messages")
      .select(COLS)
      .eq("user_id", userId)
      .eq("kind", "morning_brief")
      .order("created_at", { ascending: false })
      .limit(3);

    if (error) throw error;
    return pickTodayBrief(data ?? null, today);
  },
);

/** Server-side variant — uses the SSR Supabase client (cookie-bound, RLS). */
export const fetchTodayBriefServer = todayBrief.server;
/** Browser-side variant — uses the browser Supabase client (cookie-bound, RLS). */
export const fetchTodayBriefBrowser = todayBrief.browser;
