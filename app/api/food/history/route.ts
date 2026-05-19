// app/api/food/history/route.ts
//
// GET ?from=YYYY-MM-DD&to=YYYY-MM-DD → committed entries grouped by date+slot.
// Server clamps `from` to today-60d. Powers HistoryPickerSheet.

import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { MealSlot, FoodLogEntry, HistoryDay } from "@/lib/food/types";

const QuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const COLS = "id, user_id, eaten_at, meal_slot, kind, raw_input, items, totals, is_estimated, is_favorite, status, created_at, updated_at";

function utcDate(iso: string): string {
  return iso.slice(0, 10);
}

function clampLowerBound(from: string): string {
  const min = new Date();
  min.setUTCDate(min.getUTCDate() - 60);
  const minIso = min.toISOString().slice(0, 10);
  return from < minIso ? minIso : from;
}

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

  const from = clampLowerBound(parsed.data.from);
  const toExclusiveDate = new Date(`${parsed.data.to}T00:00:00Z`);
  toExclusiveDate.setUTCDate(toExclusiveDate.getUTCDate() + 1);
  const toExclusive = `${toExclusiveDate.toISOString().slice(0, 10)}T00:00:00Z`;

  const { data, error } = await supabase
    .from("food_log_entries")
    .select(COLS)
    .eq("user_id", user.id)
    .eq("status", "committed")
    .gte("eaten_at", `${from}T00:00:00Z`)
    .lt("eaten_at", toExclusive)
    .order("eaten_at", { ascending: false });
  if (error) {
    console.error("[/api/food/history] query failed", error);
    return NextResponse.json({ error: "query_failed" }, { status: 500 });
  }

  const dayMap = new Map<string, Record<MealSlot, FoodLogEntry[]>>();
  for (const e of (data ?? []) as FoodLogEntry[]) {
    const d = utcDate(e.eaten_at);
    if (!dayMap.has(d)) {
      dayMap.set(d, { breakfast: [], lunch: [], dinner: [], snack: [] });
    }
    dayMap.get(d)![e.meal_slot].push(e);
  }

  const days: HistoryDay[] = [...dayMap.entries()]
    .map(([date, slots]) => ({ date, slots }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  return NextResponse.json({ days });
}
