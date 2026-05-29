// lib/query/hooks/useBlockOutcome.ts
"use client";

import { useQuery } from "@tanstack/react-query";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { queryKeys } from "@/lib/query/keys";
import type { BlockOutcome } from "@/lib/data/types";

/** Browser-side fetcher for a single `block_outcomes` row keyed by
 *  `training_blocks.id`. RLS enforces per-user scoping. Returns `null` when
 *  the block has no outcome yet (cron hasn't closed it) or when `blockId`
 *  is null/empty. */
export function useBlockOutcome(blockId: string | null) {
  return useQuery<BlockOutcome | null>({
    queryKey: queryKeys.blockOutcome(blockId ?? ""),
    enabled: !!blockId,
    queryFn: async () => {
      if (!blockId) return null;
      const supabase = createSupabaseBrowserClient();
      const { data, error } = await supabase
        .from("block_outcomes")
        .select("*")
        .eq("block_id", blockId)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as BlockOutcome | null;
    },
  });
}
