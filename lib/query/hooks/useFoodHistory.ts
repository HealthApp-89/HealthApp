// lib/query/hooks/useFoodHistory.ts
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchFoodHistoryBrowser } from "@/lib/query/fetchers/foodHistory";

export function useFoodHistory(userId: string, from: string, to: string) {
  return useQuery({
    queryKey: queryKeys.foodHistory.range(userId, from, to),
    queryFn: () => fetchFoodHistoryBrowser(from, to),
    enabled: !!userId && !!from && !!to,
  });
}
