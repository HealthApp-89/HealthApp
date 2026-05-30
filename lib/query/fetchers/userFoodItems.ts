// lib/query/fetchers/userFoodItems.ts
//
// Server + browser fetchers for user_food_items (the personal library that
// backs Nora's meal-log mode + the Manage Library page at /profile/library).
// Both variants share the same select shape and throw on Supabase error so
// TanStack Query lights up isError.
//
// Sibling fetcher foodLibrary.ts handles the v1.1 favorites/recent/frequent
// "sections" payload — different shape, different consumer (Library tab).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { UserFoodItem } from "@/lib/food/types";

const SELECT = "id, user_id, name, per_100g, composite_of, default_serving_g, source, notes, created_at, updated_at";

export async function fetchUserFoodItemsServer(
  supabase: SupabaseClient,
  userId: string,
): Promise<UserFoodItem[]> {
  const { data, error } = await supabase
    .from("user_food_items")
    .select(SELECT)
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(200);
  if (error) throw error;
  return (data ?? []) as unknown as UserFoodItem[];
}

export async function fetchUserFoodItemsBrowser(
  supabase: SupabaseClient,
  userId: string,
): Promise<UserFoodItem[]> {
  const { data, error } = await supabase
    .from("user_food_items")
    .select(SELECT)
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(200);
  if (error) throw error;
  return (data ?? []) as unknown as UserFoodItem[];
}

export async function fetchUserFoodItemsRecentServer(
  supabase: SupabaseClient,
  userId: string,
): Promise<UserFoodItem[]> {
  const { data, error } = await supabase
    .from("user_food_items")
    .select(SELECT)
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(8);
  if (error) throw error;
  return (data ?? []) as unknown as UserFoodItem[];
}

export async function fetchUserFoodItemsRecentBrowser(
  supabase: SupabaseClient,
  userId: string,
): Promise<UserFoodItem[]> {
  const { data, error } = await supabase
    .from("user_food_items")
    .select(SELECT)
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(8);
  if (error) throw error;
  return (data ?? []) as unknown as UserFoodItem[];
}
