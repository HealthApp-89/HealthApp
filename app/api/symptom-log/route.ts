// app/api/symptom-log/route.ts
//
// POST   /api/symptom-log              — create a new symptom_log_entries row
// DELETE /api/symptom-log?id=<uuid>    — delete a row owned by the user
//
// RLS on symptom_log_entries gates ownership; the route just relays the
// authenticated client's request.

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const VALID_KINDS = ["sickness", "injury", "soreness", "other"] as const;

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  const raw = body as { kind?: unknown; notes?: unknown };
  const kind = typeof raw.kind === "string" ? raw.kind : "";
  const notes = typeof raw.notes === "string" ? raw.notes.trim() : "";

  if (!VALID_KINDS.includes(kind as (typeof VALID_KINDS)[number])) {
    return NextResponse.json({ ok: false, error: "invalid kind" }, { status: 400 });
  }
  if (notes.length === 0) {
    return NextResponse.json({ ok: false, error: "notes required" }, { status: 400 });
  }
  if (notes.length > 2000) {
    return NextResponse.json({ ok: false, error: "notes too long" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("symptom_log_entries")
    .insert({ user_id: user.id, kind, notes })
    .select("id, kind, notes, created_at")
    .single();

  if (error || !data) {
    return NextResponse.json(
      { ok: false, error: error?.message ?? "insert failed" },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true, entry: data });
}

export async function DELETE(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!id || !UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400 });
  }

  const { error } = await supabase
    .from("symptom_log_entries")
    .delete()
    .eq("id", id)
    .eq("user_id", user.id);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
