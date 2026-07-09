// lib/query/fetchers/trainingWeek.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TrainingWeek } from "@/lib/data/types";
import { createFetcher } from "@/lib/query/fetchers/create-fetcher";

const COLS =
  "id, user_id, block_id, week_start, session_plan, exercise_overrides, session_prescriptions, planned_activities, weekly_focus, intensity_modifier, rir_target, research_phase, proposed_by, chat_message_id, committed_at, created_at, updated_at";

const trainingWeek = createFetcher(
  async (supabase: SupabaseClient, userId: string, weekStart: string): Promise<TrainingWeek | null> => {
    const { data, error } = await supabase
      .from("training_weeks")
      .select(COLS)
      .eq("user_id", userId)
      .eq("week_start", weekStart)
      .maybeSingle();
    if (error) throw error;
    return (data as TrainingWeek | null) ?? null;
  },
);

/** Server-side: fetch the single training_week row for `weekStart`, or null
 *  if not committed. Throws on supabase errors so TanStack Query lights up
 *  isError. */
export const fetchTrainingWeekServer = trainingWeek.server;
export const fetchTrainingWeekBrowser = trainingWeek.browser;
