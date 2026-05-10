// app/api/health/measurements/[id]/route.ts
//
// DELETE one measurement row. RLS scopes by user_id, but we re-check before
// blob removal so we don't fire a service-role delete on someone else's path.
// Photo blob is best-effort: if the storage delete fails we still return ok
// (orphan blob is preferable to a stuck row).
import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  if (!id) {
    return NextResponse.json({ ok: false, reason: "missing_id" }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  }

  // Read first to grab photo_path + verify ownership via RLS.
  const { data: existing, error: readErr } = await supabase
    .from("body_measurements")
    .select("id, user_id, photo_path")
    .eq("id", id)
    .single();
  if (readErr || !existing) {
    return NextResponse.json({ ok: false, reason: "not_found" }, { status: 404 });
  }
  if (existing.user_id !== user.id) {
    // Defensive: RLS should have already filtered, but belt-and-braces.
    return NextResponse.json({ ok: false, reason: "forbidden" }, { status: 403 });
  }

  const { error: delErr } = await supabase
    .from("body_measurements")
    .delete()
    .eq("id", id);
  if (delErr) {
    return NextResponse.json(
      { ok: false, reason: "db_error", error: delErr.message },
      { status: 500 },
    );
  }

  if (existing.photo_path) {
    const sr = createSupabaseServiceRoleClient();
    await sr.storage.from("health-photos").remove([existing.photo_path]);
    // Best-effort: ignore failure.
  }

  revalidatePath("/health");
  return NextResponse.json({ ok: true });
}
