// lib/query/fetchers/enduranceActivities.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import type { EnduranceActivity } from "@/lib/data/types";

// Projection covers everything the dashboard cards need: identity (id,
// external_id, sport), timing (started_at, local_date, duration_s),
// distance + HR + zone distribution for the workload view, and tss for
// the load chart. If you add a column the dashboard reads, append it
// here — a missing column shows up as a permanently-blank field rather
// than a load failure.
const COLS =
  "id, started_at, local_date, sport, duration_s, distance_m, avg_hr, max_hr, tss, hr_zone_distribution, external_id";

/** Server-side variant — uses the SSR Supabase client (cookie-bound, RLS). */
export async function fetchEnduranceActivitiesServer(
  supabase: SupabaseClient,
  userId: string,
  from: string,
  to: string,
): Promise<EnduranceActivity[]> {
  const { data, error } = await supabase
    .from("endurance_activities")
    .select(COLS)
    .eq("user_id", userId)
    .is("deleted_at", null)
    .gte("local_date", from)
    .lte("local_date", to)
    .order("started_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as EnduranceActivity[];
}

/** Browser-side variant — uses the browser Supabase client (cookie-bound, RLS). */
export async function fetchEnduranceActivitiesBrowser(
  userId: string,
  from: string,
  to: string,
): Promise<EnduranceActivity[]> {
  const supabase = createSupabaseBrowserClient();
  const { data, error } = await supabase
    .from("endurance_activities")
    .select(COLS)
    .eq("user_id", userId)
    .is("deleted_at", null)
    .gte("local_date", from)
    .lte("local_date", to)
    .order("started_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as EnduranceActivity[];
}
