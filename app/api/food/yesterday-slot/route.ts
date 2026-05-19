// app/api/food/yesterday-slot/route.ts
//
// GET ?date=YYYY-MM-DD&slot=breakfast → { has_entries, entry_ids? }
// Powers the per-slot "Copy yesterday's <slot>" pill on MealSlotEmptyCard.
// `date` is the CURRENT date; the route looks up entries for the PRIOR day.

import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const QuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  slot: z.enum(["breakfast", "lunch", "dinner", "snack"]),
});

function priorDate(d: string): string {
  const dt = new Date(`${d}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}

export async function GET(req: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse({
    date: url.searchParams.get("date"),
    slot: url.searchParams.get("slot"),
  });
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });

  const yesterday = priorDate(parsed.data.date);
  const dayAfter = parsed.data.date;

  const { data, error } = await supabase
    .from("food_log_entries")
    .select("id")
    .eq("user_id", user.id)
    .eq("status", "committed")
    .eq("meal_slot", parsed.data.slot)
    .gte("eaten_at", `${yesterday}T00:00:00Z`)
    .lt("eaten_at", `${dayAfter}T00:00:00Z`);
  if (error) return NextResponse.json({ error: "query_failed" }, { status: 500 });

  const ids = (data ?? []).map((r) => r.id);
  return NextResponse.json({
    has_entries: ids.length > 0,
    entry_ids: ids.length > 0 ? ids : undefined,
  });
}
