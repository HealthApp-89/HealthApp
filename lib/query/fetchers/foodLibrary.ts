// lib/query/fetchers/foodLibrary.ts
import type { FoodLibrarySections } from "@/lib/food/types";

export async function fetchFoodLibraryBrowser(
  slot: string | null,
  q: string,
): Promise<FoodLibrarySections> {
  const params = new URLSearchParams();
  if (slot) params.set("slot", slot);
  if (q) params.set("q", q);
  const res = await fetch(`/api/food/library?${params}`);
  if (!res.ok) throw new Error(`food-library ${res.status}`);
  const json = await res.json();
  return json as FoodLibrarySections;
}
