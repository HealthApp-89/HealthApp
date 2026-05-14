// app/onboarding/discard-plan-intake-draft.ts
//
// Server action invoked by /profile's "Discard intake draft" button. Marks
// any open draft athlete_profile_documents row as status='discarded' so the
// user can start a fresh intake via startPlanIntake. Recovery path for
// stalled/abandoned intake conversations.

"use server";

import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "@/lib/supabase/server";

export async function discardPlanIntakeDraft(): Promise<
  { ok: true; discarded: number } | { ok: false; error: string }
> {
  const userClient = await createSupabaseServerClient();
  const {
    data: { user },
  } = await userClient.auth.getUser();
  if (!user) return { ok: false, error: "unauthorized" };

  const sr = createSupabaseServiceRoleClient();
  const { data, error } = await sr
    .from("athlete_profile_documents")
    .update({ status: "discarded", updated_at: new Date().toISOString() })
    .eq("user_id", user.id)
    .eq("status", "draft")
    .select("id");

  if (error) return { ok: false, error: error.message };
  return { ok: true, discarded: (data ?? []).length };
}
