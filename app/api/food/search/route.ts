// app/api/food/search/route.ts
//
// GET ?q=<query>&limit=20 → SearchCandidate[]
// Used by <FoodSearchPicker/> (SEARCH tab + Edit-swap "change food").

import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { searchFoods } from "@/lib/food/search";

const QuerySchema = z.object({
  q: z.string().min(2).max(100),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export async function GET(req: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse({
    q: url.searchParams.get("q"),
    limit: url.searchParams.get("limit") ?? undefined,
  });
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });

  const candidates = await searchFoods(parsed.data.q, parsed.data.limit);
  return NextResponse.json({ candidates });
}
