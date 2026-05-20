// lib/query/fetchers/checkinsRange.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import type { CheckinRow } from "@/lib/data/types";

const RANGE_COLS =
  "date, intake_state, sick, fatigue, bloating, soreness_areas, soreness_severity";

/** Narrow shape used for the intake history list — only the columns needed for
 *  date + flag display. The full CheckinRow is heavier and not needed here. */
export type CheckinRangeRow = Pick<
  CheckinRow,
  | "date"
  | "intake_state"
  | "sick"
  | "fatigue"
  | "bloating"
  | "soreness_areas"
  | "soreness_severity"
>;

/** Server-side variant — accepts the SSR Supabase client (cookie-bound, RLS). */
export async function fetchCheckinsRangeServer(
  supabase: SupabaseClient,
  userId: string,
  from: string,
  to: string,
): Promise<CheckinRangeRow[]> {
  const { data, error } = await supabase
    .from("checkins")
    .select(RANGE_COLS)
    .eq("user_id", userId)
    .gte("date", from)
    .lte("date", to)
    .order("date", { ascending: false });
  if (error) throw error;
  return (data ?? []) as CheckinRangeRow[];
}

/** Browser-side variant — self-constructs the browser Supabase client. */
export async function fetchCheckinsRangeBrowser(
  userId: string,
  from: string,
  to: string,
): Promise<CheckinRangeRow[]> {
  const supabase = createSupabaseBrowserClient();
  const { data, error } = await supabase
    .from("checkins")
    .select(RANGE_COLS)
    .eq("user_id", userId)
    .gte("date", from)
    .lte("date", to)
    .order("date", { ascending: false });
  if (error) throw error;
  return (data ?? []) as CheckinRangeRow[];
}
