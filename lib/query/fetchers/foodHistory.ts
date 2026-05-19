// lib/query/fetchers/foodHistory.ts
import type { HistoryDay } from "@/lib/food/types";

export async function fetchFoodHistoryBrowser(
  from: string,
  to: string,
): Promise<HistoryDay[]> {
  const res = await fetch(`/api/food/history?from=${from}&to=${to}`);
  if (!res.ok) throw new Error(`food-history ${res.status}`);
  const json = (await res.json()) as { days: HistoryDay[] };
  return json.days;
}
