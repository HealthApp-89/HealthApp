// lib/query/hooks/useFoodItemFavorites.ts
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchFoodItemFavoritesBrowser } from "@/lib/query/fetchers/foodItemFavorites";

export function useFoodItemFavorites(userId: string) {
  return useQuery({
    queryKey: queryKeys.foodItemFavorites.all(userId),
    queryFn: fetchFoodItemFavoritesBrowser,
    enabled: !!userId,
  });
}
