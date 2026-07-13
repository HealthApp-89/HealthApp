// app/api/injuries/[id]/route.ts
//
// PATCH → resolve, un-resolve, or edit an existing injury owned by the session user.
//
// - { status: "resolved" } → stamps resolved_at = now()
// - { status: "active" }   → clears resolved_at
// - Any other editable fields (area, side, cause, severity, onset_date,
//   affected_lifts, affected_session_types, notes) are validated and merged.
// - updated_at is always set (no DB trigger — reviewer-flagged requirement).

import { NextResponse } from "next/server";
import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "@/lib/supabase/server";
import { validateInjuryInput } from "@/lib/coach/injuries";
import { getUserTimezone } from "@/lib/time/get-user-tz";
import { todayInUserTz } from "@/lib/time";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { InjuryStatus } from "@/lib/data/types";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });

  const { id } = await params;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, reason: "invalid_json" }, { status: 400 });
  }

  // Ownership check via session client (RLS ensures user can only read their own rows).
  const { data: existing, error: fetchErr } = await supabase
    .from("injuries")
    .select("user_id, status, onset_date, severity, area, side, cause, affected_lifts, affected_session_types, notes")
    .eq("id", id)
    .maybeSingle();

  if (fetchErr) {
    return NextResponse.json({ ok: false, error: fetchErr.message }, { status: 500 });
  }
  if (!existing) {
    return NextResponse.json({ ok: false, reason: "not_found" }, { status: 404 });
  }
  if (existing.user_id !== user.id) {
    return NextResponse.json({ ok: false, reason: "forbidden" }, { status: 403 });
  }

  const sr = createSupabaseServiceRoleClient() as unknown as SupabaseClient;
  const now = new Date().toISOString();

  // Build the update payload — start with always-present updated_at.
  const update: Record<string, unknown> = { updated_at: now };

  // Status transitions.
  if ("status" in body) {
    const newStatus = body.status as InjuryStatus;
    if (newStatus !== "active" && newStatus !== "resolved") {
      return NextResponse.json(
        { ok: false, error: "status must be 'active' or 'resolved'", code: "invalid_status" },
        { status: 422 },
      );
    }
    update.status = newStatus;
    if (newStatus === "resolved") {
      update.resolved_at = now;
    } else {
      update.resolved_at = null;
    }
  }

  // Editable field validation (only validate fields that are present in body).
  const editableKeys = [
    "area", "side", "cause", "severity", "onset_date",
    "affected_lifts", "affected_session_types", "notes",
  ] as const;
  const hasEditableFields = editableKeys.some((k) => k in body);

  if (hasEditableFields) {
    const tz = await getUserTimezone(user.id);
    const todayIso = todayInUserTz(new Date(), tz);

    // Merge supplied values with existing values for validation.
    const merged = {
      area: ("area" in body ? body.area : existing.area) as string,
      side: ("side" in body ? body.side : existing.side) as string | null | undefined,
      cause: ("cause" in body ? body.cause : existing.cause) as string | null | undefined,
      severity: ("severity" in body ? body.severity : existing.severity) as string | undefined,
      onset_date: ("onset_date" in body ? body.onset_date : existing.onset_date) as string | undefined,
      affected_lifts: ("affected_lifts" in body ? body.affected_lifts : existing.affected_lifts) as string[] | undefined,
      affected_session_types: ("affected_session_types" in body ? body.affected_session_types : existing.affected_session_types) as string[] | undefined,
      notes: ("notes" in body ? body.notes : existing.notes) as string | null | undefined,
    };

    const v = validateInjuryInput(merged, todayIso);
    if (!v.ok) {
      return NextResponse.json({ ok: false, error: v.error, code: v.code }, { status: 422 });
    }

    // Only write fields that were explicitly supplied.
    if ("area" in body) update.area = v.data.area;
    if ("side" in body) update.side = v.data.side;
    if ("cause" in body) update.cause = v.data.cause;
    if ("severity" in body) update.severity = v.data.severity;
    if ("onset_date" in body) update.onset_date = v.data.onset_date;
    if ("affected_lifts" in body) update.affected_lifts = v.data.affected_lifts;
    if ("affected_session_types" in body) update.affected_session_types = v.data.affected_session_types;
    if ("notes" in body) update.notes = v.data.notes;
  }

  const { data, error } = await sr
    .from("injuries")
    .update(update)
    .eq("id", id)
    .eq("user_id", user.id)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, injury: data });
}
