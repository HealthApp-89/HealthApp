// lib/query/hooks/useActiveNudges.ts
//
// Reads proactive_nudge_dedup rows in the last 7 days. Drives the
// InlineNudgeCallout decoration on trends cards: a callout shows when
// a matching trigger_key has fired within the dedup window (i.e. the
// chat-row nudge has either been delivered or is still in the active
// dedup window).

import { useQuery } from "@tanstack/react-query";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { queryKeys } from "@/lib/query/keys";

export type ActiveNudgeRow = {
  trigger_key: string;
  fired_at: string;
};

export function useActiveNudges(userId: string) {
  return useQuery<ActiveNudgeRow[]>({
    queryKey: queryKeys.activeNudges.byUser(userId),
    queryFn: async () => {
      const supabase = createSupabaseBrowserClient();
      const cutoff = new Date(Date.now() - 7 * 86400000).toISOString();
      const { data, error } = await supabase
        .from("proactive_nudge_dedup")
        .select("trigger_key, fired_at")
        .eq("user_id", userId)
        .gte("fired_at", cutoff)
        .order("fired_at", { ascending: false });
      if (error) throw error;
      return (data as ActiveNudgeRow[] | null) ?? [];
    },
    staleTime: 60_000,
  });
}
