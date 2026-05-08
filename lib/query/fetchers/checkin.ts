// lib/query/fetchers/checkin.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import type { CheckinRow } from "@/lib/data/types";

const COLS =
  "readiness, energy_label, mood, soreness, feel_notes, " +
  "sick, sickness_notes, fatigue, bloating, soreness_areas, soreness_severity, intake_state";

/** Narrow shape returned by the dashboard / log fetchers — only the columns
 *  we render or feed into readiness math. The full row lives on the server. */
export type Checkin = Pick<
  CheckinRow,
  | "readiness"
  | "energy_label"
  | "mood"
  | "soreness"
  | "feel_notes"
  | "sick"
  | "sickness_notes"
  | "fatigue"
  | "bloating"
  | "soreness_areas"
  | "soreness_severity"
  | "intake_state"
>;

export async function fetchCheckinServer(
  supabase: SupabaseClient,
  userId: string,
  date: string,
): Promise<Checkin | null> {
  const { data, error } = await supabase
    .from("checkins")
    .select(COLS)
    .eq("user_id", userId)
    .eq("date", date)
    .maybeSingle();
  if (error) throw error;
  return (data as Checkin | null) ?? null;
}

export async function fetchCheckinBrowser(
  userId: string,
  date: string,
): Promise<Checkin | null> {
  const supabase = createSupabaseBrowserClient();
  const { data, error } = await supabase
    .from("checkins")
    .select(COLS)
    .eq("user_id", userId)
    .eq("date", date)
    .maybeSingle();
  if (error) throw error;
  return (data as Checkin | null) ?? null;
}
