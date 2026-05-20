// lib/query/hooks/useUnreadCounts.ts
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";

type UnreadCounts = {
  peter: number;
  carter: number;
  nora: number;
  remi: number;
};

/** Per-thread unread counts for the BottomNav dots. 30s staleTime so the
 *  dot updates within half a minute of new specialist activity without
 *  hammering the API on every tab swap. */
export function useUnreadCounts() {
  return useQuery<UnreadCounts>({
    queryKey: queryKeys.unreadCounts.all(),
    queryFn: async () => {
      const res = await fetch("/api/chat/unread-counts");
      if (!res.ok) throw new Error("unread-counts request failed");
      const json = (await res.json()) as { ok: boolean; counts: UnreadCounts };
      if (!json.ok) throw new Error("unread-counts not ok");
      return json.counts;
    },
    staleTime: 30_000,
  });
}
