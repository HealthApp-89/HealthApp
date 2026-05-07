// lib/query/fetchers/checkin.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

const COLS = "readiness, energy_label, mood, soreness, feel_notes";

export type Checkin = {
  readiness: number | null;
  energy_label: string | null;
  mood: string | null;
  soreness: string | null;
  feel_notes: string | null;
};

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
