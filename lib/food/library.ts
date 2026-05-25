// lib/food/library.ts
//
// CRUD helpers for user_food_items (the personal library). The API routes
// in app/api/food/library/* are thin shells around these.
//
// Two access patterns:
//   - Per-user (RLS-respecting): create/list/update/delete from a request-
//     bound supabase client; auth.uid() enforces ownership.
//   - Service-role (lookup chain): lookupLibraryByName runs with the service
//     role and an explicit user_id parameter — used by resolveItemMacros and
//     by chat-stream tool executors that already have the userId from
//     supabase.auth.getUser() in the calling route.
//
// The trigram threshold mirrors lib/food/lookup.ts (0.6). Library hits
// always carry confidence='high' — the user vetted these themselves.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import type {
  UserFoodItem,
  UserFoodItemSource,
  UserFoodComposite,
  FoodMacros,
} from "@/lib/food/types";

const TRGM_THRESHOLD = 0.6;

export type CreateLibraryItemInput =
  | {
      kind: "item";
      name: string;
      per_100g: FoodMacros;
      source: Extract<UserFoodItemSource, "user_manual" | "user_label">;
      notes?: string | null;
    }
  | {
      kind: "recipe";
      name: string;
      composite_of: UserFoodComposite[];
      default_serving_g: number;
      source: Extract<UserFoodItemSource, "user_recipe">;
      notes?: string | null;
    };

/** Create a library row. Validates the one-shape constraint up-front so the
 *  Postgres CHECK only fires on programmer error. user_id is required because
 *  the table's INSERT policy is `with check (auth.uid() = user_id)` and the
 *  column has no DEFAULT — passing the cookie-bound supabase client alone is
 *  not enough, the row must carry the id explicitly. */
export async function createLibraryItem(
  supabase: SupabaseClient,
  userId: string,
  input: CreateLibraryItemInput,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  if (input.kind === "item") {
    if (!input.per_100g) return { ok: false, error: "per_100g required for kind=item" };
  } else {
    if (!input.composite_of?.length) return { ok: false, error: "composite_of required for kind=recipe" };
    if (!Number.isFinite(input.default_serving_g) || input.default_serving_g <= 0) {
      return { ok: false, error: "default_serving_g must be a positive number" };
    }
  }
  const row =
    input.kind === "item"
      ? {
          user_id: userId,
          name: input.name,
          per_100g: input.per_100g,
          composite_of: null,
          default_serving_g: null,
          source: input.source,
          notes: input.notes ?? null,
        }
      : {
          user_id: userId,
          name: input.name,
          per_100g: null,
          composite_of: input.composite_of,
          default_serving_g: input.default_serving_g,
          source: input.source,
          notes: input.notes ?? null,
        };
  const { data, error } = await supabase
    .from("user_food_items")
    .insert(row)
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };
  return { ok: true, id: (data as { id: string }).id };
}

export async function listLibraryItems(
  supabase: SupabaseClient,
  q?: string,
  limit = 50,
): Promise<UserFoodItem[]> {
  let query = supabase
    .from("user_food_items")
    .select("*")
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (q && q.trim().length >= 2) {
    query = query.ilike("name", `%${q.trim()}%`);
  }
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as UserFoodItem[];
}

export async function updateLibraryItem(
  supabase: SupabaseClient,
  id: string,
  patch: Partial<{
    name: string;
    per_100g: FoodMacros | null;
    composite_of: UserFoodComposite[] | null;
    default_serving_g: number | null;
    notes: string | null;
  }>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await supabase.from("user_food_items").update(patch).eq("id", id);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function deleteLibraryItem(
  supabase: SupabaseClient,
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await supabase.from("user_food_items").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** Trigram fuzzy lookup over the user's library. Used by resolveItemMacros
 *  as the first leg of the chain. Uses ilike as the trigram operator fallback
 *  since pg_trgm's `%` is index-friendly but server-side `similarity()`
 *  RPC isn't defined here; the gin_trgm_ops index speeds up ilike too. */
export async function lookupLibraryByName(
  userId: string,
  name: string,
): Promise<UserFoodItem | null> {
  const supabase = createSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .from("user_food_items")
    .select("*")
    .eq("user_id", userId)
    .ilike("name", `%${name}%`)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.warn("[food-library] lookupLibraryByName failed", error);
    return null;
  }
  return (data as UserFoodItem | null) ?? null;
}

void TRGM_THRESHOLD; // reserved for the trigram RPC path; ilike covers v1.
