// app/api/injuries/route.ts
//
// POST  → create an injury record for the session-authed user.
// GET   → list injuries (active first, then onset_date desc within group).
//
// Session auth via createSupabaseServerClient; writes via service-role AFTER
// auth check (matching the repo idiom in app/api/blocks/route.ts).

import { NextResponse } from "next/server";
import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "@/lib/supabase/server";
import { validateInjuryInput } from "@/lib/coach/injuries";
import { getUserTimezone } from "@/lib/time/get-user-tz";
import { todayInUserTz } from "@/lib/time";
import type { SupabaseClient } from "@supabase/supabase-js";

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, reason: "invalid_json" }, { status: 400 });
  }

  const tz = await getUserTimezone(user.id);
  const todayIso = todayInUserTz(new Date(), tz);

  const v = validateInjuryInput(
    {
      area: body.area as string,
      side: body.side as string | undefined,
      cause: body.cause as string | undefined,
      severity: body.severity as string | undefined,
      onset_date: body.onset_date as string | undefined,
      affected_lifts: body.affected_lifts as string[] | undefined,
      affected_session_types: body.affected_session_types as string[] | undefined,
      notes: body.notes as string | undefined,
    },
    todayIso,
  );
  if (!v.ok) {
    return NextResponse.json({ ok: false, error: v.error, code: v.code }, { status: 422 });
  }

  const sr = createSupabaseServiceRoleClient() as unknown as SupabaseClient;
  const now = new Date().toISOString();

  const { data, error } = await sr
    .from("injuries")
    .insert({
      user_id: user.id,
      area: v.data.area,
      side: v.data.side,
      cause: v.data.cause,
      severity: v.data.severity,
      onset_date: v.data.onset_date,
      status: "active",
      affected_lifts: v.data.affected_lifts,
      affected_session_types: v.data.affected_session_types,
      notes: v.data.notes,
      created_at: now,
      updated_at: now,
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, injury: data }, { status: 201 });
}

export async function GET() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });

  // 'active' sorts before 'resolved' alphabetically — gives active-first ordering.
  const { data, error } = await supabase
    .from("injuries")
    .select("*")
    .eq("user_id", user.id)
    .order("status", { ascending: true })
    .order("onset_date", { ascending: false });

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, injuries: data ?? [] });
}
