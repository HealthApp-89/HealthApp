// lib/query/fetchers/profile.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PrimaryLift, DietaryExclusions } from "@/lib/data/types";
import type { RecurringActivity } from "@/lib/coach/activity/types";
import { createFetcher } from "@/lib/query/fetchers/create-fetcher";

const COLS = "name, age, height_cm, goal, system_prompt, whoop_baselines, disable_yazio_ingest, disable_strong_ingest, rotation_priority_lift, dietary_exclusions, timezone, recurring_activities, created_at";

export type Profile = {
  name: string | null;
  age: number | null;
  height_cm: number | null;
  goal: string | null;
  system_prompt: string | null;
  whoop_baselines: Record<string, unknown> | null;
  disable_yazio_ingest: boolean;
  disable_strong_ingest: boolean;
  rotation_priority_lift: PrimaryLift | null;
  dietary_exclusions: DietaryExclusions | null;
  timezone: string;
  recurring_activities: RecurringActivity[];
  created_at: string;
};

const profile = createFetcher(
  async (supabase: SupabaseClient, userId: string): Promise<Profile | null> => {
    const { data, error } = await supabase
      .from("profiles")
      .select(COLS)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw error;
    return (data as Profile | null) ?? null;
  },
);

export const fetchProfileServer = profile.server;
export const fetchProfileBrowser = profile.browser;
