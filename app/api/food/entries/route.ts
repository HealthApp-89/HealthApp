// app/api/food/entries/route.ts
//
// GET ?from=YYYY-MM-DD&to=YYYY-MM-DD → array of committed FoodLogEntry rows.
// Used by useFoodEntries hook AND by the coach's query_food_log tool handler.

import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const QuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export async function GET(req: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse({
    from: url.searchParams.get("from"),
    to: url.searchParams.get("to"),
  });
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });

  const { data, error } = await supabase
    .from("food_log_entries")
    .select("id, user_id, eaten_at, meal_slot, kind, raw_input, items, totals, is_estimated, is_favorite, status, created_at, updated_at")
    .eq("user_id", user.id)
    .eq("status", "committed")
    .gte("eaten_at", `${parsed.data.from}T00:00:00Z`)
    .lte("eaten_at", `${parsed.data.to}T23:59:59Z`)
    .order("eaten_at", { ascending: false });
  if (error) {
    console.error("[/api/food/entries] query failed", error);
    return NextResponse.json({ error: "query_failed" }, { status: 500 });
  }
  return NextResponse.json({ entries: data ?? [] });
}
