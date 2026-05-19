// app/api/food/cache-pick/route.ts
//
// GET ?canonical_id=<uuid> → { source } — look up an existing cache row's source.
// POST { candidate: SearchCandidate } → { canonical_id, source } — write a fresh
//   OFF/USDA candidate to food_db_cache and return its canonical_id.
//
// Used by <DraftReview/>'s "Change food" swap. /api/food/draft does the same
// inline; this endpoint exists so Edit-swap doesn't need to spin a throwaway draft.
//
// TODO (multi-user): the POST handler accepts client-supplied per_100g macros
// and writes them to the shared food_db_cache. In the single-user threat
// model this is moot, but if other users ever share the cache, a malicious
// client could inject fabricated macros that surface in other users' trigram
// lookups. Mitigation when needed: re-fetch from the candidate.source API
// server-side and compare, or tag client-pick rows with source='manual' so
// they don't pollute the USDA/OFF lookup signal.
//
// TODO: food_db_cache has no (source, name) uniqueness for upc-null rows;
// repeated picks of the same OFF/USDA result accumulate duplicate rows.
// Harmless (trigram lookup picks one) but worth a dedup migration.

import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient, createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import type { FoodDbCacheRow } from "@/lib/food/types";

const CandidateSchema = z.object({
  name: z.string().min(1),
  per_100g: z.object({
    kcal: z.number().nonnegative(),
    protein_g: z.number().nonnegative(),
    carbs_g: z.number().nonnegative(),
    fat_g: z.number().nonnegative(),
    fiber_g: z.number().nonnegative(),
  }),
  source: z.enum(["db", "off", "usda"]),
  canonical_id: z.string().uuid().nullable(),
  image_url: z.string().url().nullable(),
});

export async function GET(req: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const canonical_id = url.searchParams.get("canonical_id");
  if (!canonical_id) return NextResponse.json({ error: "missing_canonical_id" }, { status: 400 });

  const service = createSupabaseServiceRoleClient();
  const { data } = await service
    .from("food_db_cache")
    .select("source")
    .eq("canonical_id", canonical_id)
    .single();
  if (!data) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ source: (data as { source: string }).source });
}

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const json = await req.json().catch(() => null);
  const parsed = z.object({ candidate: CandidateSchema }).safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });

  const { candidate } = parsed.data;
  if (candidate.source === "db") {
    if (!candidate.canonical_id) return NextResponse.json({ error: "db_candidate_missing_canonical_id" }, { status: 400 });
    const service = createSupabaseServiceRoleClient();
    const { data } = await service
      .from("food_db_cache")
      .select("source")
      .eq("canonical_id", candidate.canonical_id)
      .single();
    if (!data) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ canonical_id: candidate.canonical_id, source: (data as { source: string }).source });
  }

  const db_source: "openfoodfacts" | "usda" = candidate.source === "off" ? "openfoodfacts" : "usda";
  const service = createSupabaseServiceRoleClient();
  const { data: inserted, error } = await service
    .from("food_db_cache")
    .insert({
      source: db_source,
      upc: null,
      name: candidate.name,
      per_100g: candidate.per_100g,
      serving_size_g: null,
      raw_payload: { picked_via: "edit-swap", at: new Date().toISOString() },
    })
    .select("*")
    .single();
  if (error || !inserted) {
    console.error("[/api/food/cache-pick] insert failed", error);
    return NextResponse.json({ error: "cache_insert_failed" }, { status: 500 });
  }
  return NextResponse.json({
    canonical_id: (inserted as FoodDbCacheRow).canonical_id,
    source: db_source,
  });
}
