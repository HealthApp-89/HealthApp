// app/onboarding/start-plan-intake.ts
//
// Server action invoked by /profile's "Generate plan" CTA. Creates a fresh
// draft athlete_profile_documents row by cloning the active intake_payload,
// strips chat-elicited fields (so Beats 2-5 re-elicit fresh), and returns
// the new draft id so the client can redirect to /coach?mode=intake&doc=<id>.

"use server";

import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "@/lib/supabase/server";
import type { IntakePayload } from "@/lib/data/types";

export async function startPlanIntake(): Promise<
  { ok: true; doc_id: string } | { ok: false; error: string }
> {
  const userClient = await createSupabaseServerClient();
  const {
    data: { user },
  } = await userClient.auth.getUser();
  if (!user) return { ok: false, error: "unauthorized" };

  const sr = createSupabaseServiceRoleClient();

  // If there's already an open draft (any version), return its id so the user
  // resumes mid-flow instead of stacking drafts. This mirrors the
  // single-draft-per-user invariant from Phase 1.
  const { data: existingDraft } = await sr
    .from("athlete_profile_documents")
    .select("id")
    .eq("user_id", user.id)
    .eq("status", "draft")
    .maybeSingle();
  if (existingDraft) return { ok: true, doc_id: existingDraft.id };

  // Load active doc to copy intake_payload from
  const { data: active, error: loadErr } = await sr
    .from("athlete_profile_documents")
    .select("intake_payload, version")
    .eq("user_id", user.id)
    .eq("status", "active")
    .maybeSingle();
  if (loadErr) return { ok: false, error: loadErr.message };
  if (!active) return { ok: false, error: "no active profile to base draft on" };

  // Strip chat-elicited fields so Beats 2-5 re-elicit fresh. Form-elicited
  // fields (goals, health, training, etc.) carry forward unchanged. Chronotype
  // on sleep_recovery is preserved as a durable preference.
  const baseIntake = active.intake_payload as IntakePayload & {
    goal_narrative_chat?: string;
    coaching_preferences?: unknown;
    free_form_constraints?: string;
    sanity_overrides?: Record<string, boolean>;
  };
  const draftIntake: typeof baseIntake = { ...baseIntake };
  delete draftIntake.goal_narrative_chat;
  delete draftIntake.coaching_preferences;
  delete draftIntake.free_form_constraints;
  delete draftIntake.sanity_overrides;

  // Compute next version as MAX(version) + 1 across ALL statuses for this
  // user — not active.version + 1. The unique index on (user_id, version)
  // doesn't filter on status, so a discarded row at version N still occupies
  // that slot. If the user's prior intake stalled and was later discarded,
  // a naive active.version + 1 collides with that row's version. Pull the
  // true high-water mark instead.
  const { data: maxRow, error: maxErr } = await sr
    .from("athlete_profile_documents")
    .select("version")
    .eq("user_id", user.id)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (maxErr) return { ok: false, error: maxErr.message };
  const nextVersion = (maxRow?.version ?? active.version) + 1;

  // Create the draft row at the next version number
  const { data: draft, error: insErr } = await sr
    .from("athlete_profile_documents")
    .insert({
      user_id: user.id,
      version: nextVersion,
      status: "draft",
      intake_payload: draftIntake,
    })
    .select("id")
    .single();
  if (insErr) return { ok: false, error: insErr.message };

  return { ok: true, doc_id: draft.id };
}
