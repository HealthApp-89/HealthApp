// lib/query/fetchers/checkinsRange.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CheckinRow } from "@/lib/data/types";
import { createFetcher } from "@/lib/query/fetchers/create-fetcher";

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

const checkinsRange = createFetcher(
  async (supabase: SupabaseClient, userId: string, from: string, to: string): Promise<CheckinRangeRow[]> => {
    const { data, error } = await supabase
      .from("checkins")
      .select(RANGE_COLS)
      .eq("user_id", userId)
      .gte("date", from)
      .lte("date", to)
      .order("date", { ascending: false });
    if (error) throw error;
    return (data ?? []) as CheckinRangeRow[];
  },
);

/** Server-side variant — accepts the SSR Supabase client (cookie-bound, RLS). */
export const fetchCheckinsRangeServer = checkinsRange.server;
/** Browser-side variant — self-constructs the browser Supabase client. */
export const fetchCheckinsRangeBrowser = checkinsRange.browser;
