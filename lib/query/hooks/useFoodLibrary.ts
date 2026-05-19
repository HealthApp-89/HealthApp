// lib/query/hooks/useFoodLibrary.ts
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchFoodLibraryBrowser } from "@/lib/query/fetchers/foodLibrary";

export function useFoodLibrary(userId: string, slot: string | null, q: string) {
  return useQuery({
    queryKey: queryKeys.foodLibrary.sections(userId, slot, q),
    queryFn: () => fetchFoodLibraryBrowser(slot, q),
    enabled: !!userId,
    staleTime: 30_000,
  });
}
