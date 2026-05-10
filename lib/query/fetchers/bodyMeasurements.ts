// lib/query/fetchers/bodyMeasurements.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import type { BodyMeasurement } from "@/lib/data/types";

const COLS =
  "id, user_id, measured_on, neck_cm, left_upper_arm_cm, right_upper_arm_cm, chest_cm, high_waist_cm, mid_waist_cm, low_waist_cm, hips_cm, left_thigh_cm, left_thigh_min_cm, right_thigh_cm, right_thigh_min_cm, left_calf_cm, right_calf_cm, photo_path, notes, created_at";

/** Cap. Personal-app: nobody hits 60 monthly measurements in human time. */
const MAX_ROWS = 60;

/** Server variant — caller (Server Component) supplies the SSR Supabase
 *  client so cookie/auth scoping is explicit. */
export async function fetchBodyMeasurementsServer(
  supabase: SupabaseClient,
  userId: string,
): Promise<BodyMeasurement[]> {
  const { data, error } = await supabase
    .from("body_measurements")
    .select(COLS)
    .eq("user_id", userId)
    .order("measured_on", { ascending: false })
    .limit(MAX_ROWS);
  if (error) throw error;
  return (data ?? []) as BodyMeasurement[];
}

/** Browser variant — self-constructs the cookie-bound browser client. */
export async function fetchBodyMeasurementsBrowser(
  userId: string,
): Promise<BodyMeasurement[]> {
  const supabase = createSupabaseBrowserClient();
  const { data, error } = await supabase
    .from("body_measurements")
    .select(COLS)
    .eq("user_id", userId)
    .order("measured_on", { ascending: false })
    .limit(MAX_ROWS);
  if (error) throw error;
  return (data ?? []) as BodyMeasurement[];
}
