// app/api/health/photo-url/route.ts
//
// GET ?path=<storage-key>. Verifies the path is under the calling user's
// prefix, mints a 1h signed URL via service-role. Used by MeasurementCard
// thumbnails and the fullscreen viewer.
import { NextResponse } from "next/server";
import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const path = url.searchParams.get("path");
  if (!path) {
    return NextResponse.json({ ok: false, reason: "missing_path" }, { status: 400 });
  }
  if (!path.startsWith(`${user.id}/`)) {
    return NextResponse.json({ ok: false, reason: "forbidden" }, { status: 403 });
  }

  const sr = createSupabaseServiceRoleClient();
  const { data: signed, error } = await sr.storage
    .from("health-photos")
    .createSignedUrl(path, 60 * 60);
  if (error || !signed) {
    return NextResponse.json(
      { ok: false, reason: "sign_failed", error: error?.message },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true, signed_url: signed.signedUrl });
}
