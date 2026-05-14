// lib/query/fetchers/coachRecent.ts
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import type { MorningBriefCard } from "@/lib/data/types";

export type RecentDay = {
  day: string;            // ISO YYYY-MM-DD — user-tz anchored
  band: string | null;
};

/**
 * Increment a YYYY-MM-DD string by one day without going through Date
 * (which would re-introduce timezone hazards). Uses Date.UTC internally
 * for the day-math but operates on a UTC-anchored midnight, so DST is
 * irrelevant. Returns YYYY-MM-DD.
 */
function addOneDayYmd(ymd: string): string {
  // Parse "YYYY-MM-DD" → Date.UTC(y, m-1, d), bump 1 day, format back.
  const [y, m, d] = ymd.split("-").map((s) => parseInt(s, 10));
  if (!y || !m || !d) return ymd; // malformed input; defensive no-op
  const utcMs = Date.UTC(y, m - 1, d) + 24 * 60 * 60 * 1000;
  const next = new Date(utcMs);
  const yy = next.getUTCFullYear();
  const mm = String(next.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(next.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/**
 * Returns up to `limit` recent days that received a morning brief,
 * newest-first. The day is derived from the brief's recap.yesterday_date
 * + 1 (user-tz anchored). Dedups on the same day (latest brief wins
 * per descending order).
 *
 * Why not chat_messages.created_at? That's a UTC timestamp; slicing to
 * 10 chars off-by-ones for any brief assembled before the user's local
 * midnight rolls over to UTC midnight (always true for UTC+1 and above
 * before noon). recap.yesterday_date is already user-tz anchored on the
 * server (assembler.ts:145 derives it from todayInUserTz()).
 */
export async function fetchCoachRecentBrowser(
  userId: string,
  limit = 30,
): Promise<RecentDay[]> {
  const supabase = createSupabaseBrowserClient();

  const { data, error } = await supabase
    .from("chat_messages")
    .select("created_at, ui")
    .eq("user_id", userId)
    .eq("kind", "morning_brief")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;

  const seen = new Set<string>();
  const result: RecentDay[] = [];
  for (const row of data ?? []) {
    const ui = (row.ui ?? null) as MorningBriefCard | null;
    if (!ui) continue;
    const yesterday = ui.recap?.yesterday_date;
    if (!yesterday) continue;
    const day = addOneDayYmd(yesterday);
    if (seen.has(day)) continue;
    seen.add(day);
    const band = ui.readiness?.band ?? null;
    result.push({ day, band });
  }
  return result;
}
