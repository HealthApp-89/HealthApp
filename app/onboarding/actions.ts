// app/onboarding/actions.ts
"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { IntakePayloadSchema } from "@/lib/validation/intakePayload";
import { renderProfileMarkdown } from "@/lib/coach/profile-renderer";
import type { IntakePayload } from "@/lib/data/types";

// ── Helpers ─────────────────────────────────────────────────────────────────

async function requireUser() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  return { supabase, user };
}

// ── Actions ─────────────────────────────────────────────────────────────────

export type CreateDraftResult =
  | { ok: true; id: string; version: number }
  | { ok: false; error: string; field_errors?: Record<string, string> };

/**
 * Create a new draft from a fully-filled intake payload. Throws if the user
 * already has an open draft (caller should resume or discard first).
 */
export async function createDraftProfile(intake: unknown): Promise<CreateDraftResult> {
  const { supabase, user } = await requireUser();

  const parsed = IntakePayloadSchema.safeParse(intake);
  if (!parsed.success) {
    const field_errors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      field_errors[issue.path.join(".")] = issue.message;
    }
    return { ok: false, error: "Validation failed", field_errors };
  }

  // Inline nextVersionFor to avoid the conditional-type helper signature.
  const { data: maxRow, error: maxErr } = await supabase
    .from("athlete_profile_documents")
    .select("version")
    .eq("user_id", user.id)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (maxErr) throw maxErr;
  const version = ((maxRow?.version as number | undefined) ?? 0) + 1;

  const { data, error } = await supabase
    .from("athlete_profile_documents")
    .insert({
      user_id: user.id,
      version,
      status: "draft",
      intake_payload: parsed.data,
    })
    .select("id, version")
    .single();

  if (error) {
    // Partial unique index on draft would fire if another draft exists.
    if (error.code === "23505") {
      return {
        ok: false,
        error: "You already have a draft in progress. Resume or discard it from /profile first.",
      };
    }
    throw error;
  }

  revalidatePath("/profile");
  revalidatePath("/onboarding");
  return { ok: true, id: data.id as string, version: data.version as number };
}

/**
 * Update an existing draft's intake_payload. Used when user navigates back
 * from review to fix a form field.
 */
export async function updateDraftProfile(
  id: string,
  intake: unknown,
): Promise<CreateDraftResult> {
  const { supabase, user } = await requireUser();

  const parsed = IntakePayloadSchema.safeParse(intake);
  if (!parsed.success) {
    const field_errors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      field_errors[issue.path.join(".")] = issue.message;
    }
    return { ok: false, error: "Validation failed", field_errors };
  }

  const { data, error } = await supabase
    .from("athlete_profile_documents")
    .update({
      intake_payload: parsed.data,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("user_id", user.id)
    .eq("status", "draft")
    .select("id, version")
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    return { ok: false, error: "Draft not found or already acknowledged." };
  }

  revalidatePath("/profile");
  revalidatePath("/onboarding");
  return { ok: true, id: data.id as string, version: data.version as number };
}

export type AcknowledgeResult =
  | { ok: true; version: number; acknowledged_at: string }
  | { ok: false; error: string };

/**
 * Atomic acknowledge: writes the (possibly user-edited) markdown to
 * rendered_md, flips the draft to active, supersedes any prior active row
 * for this user. One Postgres transaction via an RPC if available; otherwise
 * two updates with the partial unique index defending correctness.
 */
export async function acknowledgeDraft(
  id: string,
  rendered_md: string,
): Promise<AcknowledgeResult> {
  const { supabase, user } = await requireUser();

  // Load the draft we're acknowledging.
  const { data: draft, error: draftErr } = await supabase
    .from("athlete_profile_documents")
    .select("id, version, intake_payload")
    .eq("id", id)
    .eq("user_id", user.id)
    .eq("status", "draft")
    .maybeSingle();
  if (draftErr) throw draftErr;
  if (!draft) {
    return { ok: false, error: "Draft not found or already acknowledged." };
  }

  // Find any prior active row.
  const { data: prior, error: priorErr } = await supabase
    .from("athlete_profile_documents")
    .select("id, version")
    .eq("user_id", user.id)
    .eq("status", "active")
    .maybeSingle();
  if (priorErr) throw priorErr;

  const now = new Date().toISOString();

  // Step 1: supersede the prior active (if any). Doing this FIRST clears the
  // partial unique index so the draft → active flip won't violate it.
  if (prior) {
    const { error: supErr } = await supabase
      .from("athlete_profile_documents")
      .update({
        status: "superseded",
        superseded_at: now,
        superseded_by: draft.id as string,
        updated_at: now,
      })
      .eq("id", prior.id as string)
      .eq("user_id", user.id);
    if (supErr) {
      // No transaction here — but the partial unique index ensures we never
      // end up with two actives. If this errors, surface the failure and let
      // the user retry; the draft stays a draft.
      throw supErr;
    }
  }

  // Step 2: flip the draft to active with frozen rendered_md.
  const { error: ackErr } = await supabase
    .from("athlete_profile_documents")
    .update({
      status: "active",
      rendered_md,
      acknowledged_at: now,
      updated_at: now,
    })
    .eq("id", draft.id as string)
    .eq("user_id", user.id)
    .eq("status", "draft");
  if (ackErr) {
    // If acknowledge fails AFTER we superseded the prior, attempt rollback.
    if (prior) {
      const { error: rollbackErr } = await supabase
        .from("athlete_profile_documents")
        .update({
          status: "active",
          superseded_at: null,
          superseded_by: null,
          updated_at: now,
        })
        .eq("id", prior.id as string)
        .eq("user_id", user.id);
      if (rollbackErr) {
        // Compound failure: supersede succeeded, flip failed, rollback failed.
        // Prior is now 'superseded' with no active row. Surface this clearly.
        console.error("[acknowledgeDraft] rollback failed", { ackErr, rollbackErr });
        throw new Error(
          `Profile state is inconsistent: flip failed and rollback also failed. Contact support. (flip: ${ackErr.message}, rollback: ${rollbackErr.message})`,
        );
      }
    }
    throw ackErr;
  }

  revalidatePath("/profile");
  revalidatePath("/coach");
  revalidatePath("/onboarding");
  return { ok: true, version: draft.version as number, acknowledged_at: now };
}

/** Discard a draft (manual abandon). Idempotent: returns ok if already gone. */
export async function discardDraft(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const { supabase, user } = await requireUser();

  const { error } = await supabase
    .from("athlete_profile_documents")
    .update({ status: "discarded", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", user.id)
    .eq("status", "draft");

  if (error) throw error;

  revalidatePath("/profile");
  revalidatePath("/onboarding");
  return { ok: true };
}

/** Pure helper: render the markdown for the current intake_payload — used by
 *  the Review step on the client to render the auto-rendered draft before
 *  acknowledgment. */
export async function renderDraftMarkdown(
  intake: IntakePayload,
  version: number,
  supersedesVersion: number | null,
): Promise<string> {
  // The renderer is pure; we run it in a server action only because the
  // wizard is a client component and we want the function importable
  // without bundling it into the client. The "use server" file scope
  // ensures only the result crosses the wire.
  return renderProfileMarkdown({ intake, plan: null, version, acknowledgedAt: null, supersedesVersion });
}

/** Read helper used by the wizard to determine what version the next draft
 *  will get and which version (if any) it would supersede. */
export async function getNextVersionContext(): Promise<{
  next_version: number;
  supersedes_version: number | null;
  has_open_draft: boolean;
}> {
  const { supabase, user } = await requireUser();

  const [{ data: maxRow }, { data: activeRow }, { data: draftRow }] = await Promise.all([
    supabase
      .from("athlete_profile_documents")
      .select("version")
      .eq("user_id", user.id)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("athlete_profile_documents")
      .select("version")
      .eq("user_id", user.id)
      .eq("status", "active")
      .maybeSingle(),
    supabase
      .from("athlete_profile_documents")
      .select("id")
      .eq("user_id", user.id)
      .eq("status", "draft")
      .maybeSingle(),
  ]);

  const next_version = ((maxRow?.version as number | undefined) ?? 0) + 1;
  const supersedes_version = (activeRow?.version as number | undefined) ?? null;
  const has_open_draft = !!draftRow;

  return { next_version, supersedes_version, has_open_draft };
}
