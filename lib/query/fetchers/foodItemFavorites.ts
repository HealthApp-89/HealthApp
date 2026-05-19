// lib/query/fetchers/foodItemFavorites.ts
import type { FoodItemFavorite } from "@/lib/food/types";

export async function fetchFoodItemFavoritesBrowser(): Promise<FoodItemFavorite[]> {
  const res = await fetch("/api/food/item-favorites");
  if (!res.ok) throw new Error(`food-item-favorites ${res.status}`);
  const json = (await res.json()) as { favorites: FoodItemFavorite[] };
  return json.favorites;
}
