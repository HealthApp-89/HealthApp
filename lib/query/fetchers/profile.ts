// lib/query/fetchers/profile.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

const COLS = "name, age, height_cm, goal, system_prompt, whoop_baselines, disable_yazio_ingest, disable_strong_ingest";

export type Profile = {
  name: string | null;
  age: number | null;
  height_cm: number | null;
  goal: string | null;
  system_prompt: string | null;
  whoop_baselines: Record<string, unknown> | null;
  disable_yazio_ingest: boolean;
  disable_strong_ingest: boolean;
};

export async function fetchProfileServer(
  supabase: SupabaseClient,
  userId: string,
): Promise<Profile | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select(COLS)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return (data as Profile | null) ?? null;
}

export async function fetchProfileBrowser(userId: string): Promise<Profile | null> {
  const supabase = createSupabaseBrowserClient();
  const { data, error } = await supabase
    .from("profiles")
    .select(COLS)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return (data as Profile | null) ?? null;
}
