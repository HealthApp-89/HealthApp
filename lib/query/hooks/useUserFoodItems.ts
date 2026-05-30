"use client";
import { useQuery } from "@tanstack/react-query";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import {
  fetchUserFoodItemsBrowser,
  fetchUserFoodItemsRecentBrowser,
} from "@/lib/query/fetchers/userFoodItems";
import { queryKeys } from "@/lib/query/keys";

export function useUserFoodItems(userId: string) {
  const supabase = createSupabaseBrowserClient();
  return useQuery({
    queryKey: queryKeys.userFoodItems.all(userId),
    queryFn: () => fetchUserFoodItemsBrowser(supabase, userId),
  });
}

export function useUserFoodItemsRecent(userId: string) {
  const supabase = createSupabaseBrowserClient();
  return useQuery({
    queryKey: queryKeys.userFoodItems.recent(userId),
    queryFn: () => fetchUserFoodItemsRecentBrowser(supabase, userId),
  });
}
