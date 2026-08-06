// app/api/food/history/route.ts
//
// GET ?from=YYYY-MM-DD&to=YYYY-MM-DD → committed entries grouped by date+slot.
// Server clamps `from` to today-365d. Powers HistoryPickerSheet.
//
// Days are bounded and grouped in the athlete's profiles.timezone, not UTC.
// UTC slicing misfiled every entry logged between local midnight and the UTC
// offset (00:00–04:00 for Asia/Dubai) onto the previous day.

import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getUserTimezone } from "@/lib/time/get-user-tz";
import { localDayRangeUtc, todayInUserTz, ymdInUserTz } from "@/lib/time";
import type { MealSlot, FoodLogEntry, HistoryDay } from "@/lib/food/types";

const QuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const COLS = "id, user_id, eaten_at, meal_slot, kind, raw_input, items, totals, is_estimated, is_favorite, status, created_at, updated_at";

/** How far back the picker may reach. A year comfortably covers a returning
 *  athlete; the old 60d bound hid 13 of 15 logged days after a 41-day gap. */
const MAX_LOOKBACK_DAYS = 365;

function clampLowerBound(from: string, today: string): string {
  const min = new Date(`${today}T00:00:00Z`);
  min.setUTCDate(min.getUTCDate() - MAX_LOOKBACK_DAYS);
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

  const tz = await getUserTimezone(user.id);
  const today = todayInUserTz(new Date(), tz);
  const from = clampLowerBound(parsed.data.from, today);

  // Local calendar days → the half-open UTC instant range covering them.
  const { startUtc } = localDayRangeUtc(from, tz);
  const { endUtc } = localDayRangeUtc(parsed.data.to, tz);

  const { data, error } = await supabase
    .from("food_log_entries")
    .select(COLS)
    .eq("user_id", user.id)
    .eq("status", "committed")
    .gte("eaten_at", startUtc)
    .lt("eaten_at", endUtc)
    .order("eaten_at", { ascending: false });
  if (error) {
    console.error("[/api/food/history] query failed", error);
    return NextResponse.json({ error: "query_failed" }, { status: 500 });
  }

  const dayMap = new Map<string, Record<MealSlot, FoodLogEntry[]>>();
  for (const e of (data ?? []) as FoodLogEntry[]) {
    const d = ymdInUserTz(new Date(e.eaten_at), tz);
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
