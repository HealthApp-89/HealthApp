import { NextResponse } from "next/server";
import { createSupabaseServerClient, createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { generateRawToken, hashToken, tokenPrefix } from "@/lib/ingest/auth";

/** GET — return token metadata (prefix, dates) without the raw token.
 *  POST — rotate: create a new token, return raw value once. Old token is replaced. */

export async function GET() {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });

  const { data } = await supabase
    .from("ingest_tokens")
    .select("token_prefix, created_at, last_used_at, last_used_source")
    .eq("user_id", user.id)
    .maybeSingle();

  return NextResponse.json({ ok: true, token: data });
}

export async function POST() {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });

  const raw = generateRawToken();
  const sr = createSupabaseServiceRoleClient();
  const { error } = await sr.from("ingest_tokens").upsert({
    user_id: user.id,
    token_hash: hashToken(raw),
    token_prefix: tokenPrefix(raw),
    created_at: new Date().toISOString(),
    last_used_at: null,
    last_used_source: null,
  });
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, token: raw, prefix: tokenPrefix(raw) });
}

export async function DELETE() {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });

  const sr = createSupabaseServiceRoleClient();
  const { error } = await sr.from("ingest_tokens").delete().eq("user_id", user.id);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
