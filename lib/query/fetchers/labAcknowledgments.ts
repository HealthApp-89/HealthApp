import type { SupabaseClient } from "@supabase/supabase-js";

export type LabAcks = Record<string, string | null>;

export async function fetchLabAcknowledgmentsBrowser(
  supabase: SupabaseClient,
  userId: string,
): Promise<LabAcks> {
  const { data, error } = await supabase
    .from("profiles")
    .select("lab_acknowledgments")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return (data?.lab_acknowledgments ?? {}) as LabAcks;
}

export async function fetchLabAcknowledgmentsServer(
  supabase: SupabaseClient,
  userId: string,
): Promise<LabAcks> {
  return fetchLabAcknowledgmentsBrowser(supabase, userId);
}
