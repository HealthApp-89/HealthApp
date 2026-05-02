import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** GET /api/recommendations?week=YYYY-MM-DD
 *  Returns the recommendations for the given week_start (defaults to the most recent). */
export async function GET(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const week = url.searchParams.get("week");

  let q = supabase
    .from("coach_recommendations")
    .select("id, week_start, text, category, priority, position, done, updated_at")
    .eq("user_id", user.id)
    .order("position", { ascending: true });

  if (week && /^\d{4}-\d{2}-\d{2}$/.test(week)) {
    q = q.eq("week_start", week);
  } else {
    const { data: latest } = await supabase
      .from("coach_recommendations")
      .select("week_start")
      .eq("user_id", user.id)
      .order("week_start", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!latest) return NextResponse.json({ ok: true, week: null, items: [] });
    q = q.eq("week_start", latest.week_start);
  }

  const { data, error } = await q;
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({
    ok: true,
    week: data?.[0]?.week_start ?? week ?? null,
    items: data ?? [],
  });
}

/** PATCH /api/recommendations
 *  Body: { id: string, done?: boolean, text?: string }
 *  Toggle completion or edit recommendation text. */
export async function PATCH(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  if (!body?.id) return NextResponse.json({ ok: false, error: "missing id" }, { status: 400 });

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof body.done === "boolean") patch.done = body.done;
  if (typeof body.text === "string" && body.text.trim()) patch.text = body.text.trim();

  if (Object.keys(patch).length === 1) {
    return NextResponse.json({ ok: false, error: "nothing to update" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("coach_recommendations")
    .update(patch)
    .eq("id", body.id)
    .eq("user_id", user.id)
    .select("id, done, text, updated_at")
    .single();

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, item: data });
}
