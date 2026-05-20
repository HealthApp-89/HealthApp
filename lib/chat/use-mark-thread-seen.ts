// lib/chat/use-mark-thread-seen.ts
"use client";

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { markThreadSeen } from "@/lib/chat/mark-thread-seen";
import type { Speaker } from "@/lib/data/types";

/** Stamps profiles.chat_last_seen[thread] = now() on mount, then
 *  invalidates the unread-counts query so the BottomNav dot clears
 *  promptly. Used by the four coach pages (Strength/Diet/Health/Metrics). */
export function useMarkThreadSeen(thread: Speaker): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    let cancelled = false;
    void markThreadSeen(thread).then(() => {
      if (cancelled) return;
      void queryClient.invalidateQueries({ queryKey: queryKeys.unreadCounts.all() });
    });
    return () => {
      cancelled = true;
    };
  }, [thread, queryClient]);
}
