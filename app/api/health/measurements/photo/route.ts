// app/api/health/measurements/photo/route.ts
//
// POST multipart/form-data with field "file". Validates size + MIME, uploads
// to `health-photos/<user_id>/measurements/_unattached/<uuid>.<ext>`, returns
// the storage path + a 1h signed URL for the optimistic preview.
//
// "Unattached" path segment marks blobs not yet linked to a body_measurements
// row — left in place if the user closes the modal mid-flow (acceptable leak,
// see spec § Risks; sweep cron deferred).

import { NextResponse } from "next/server";
import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "@/lib/supabase/server";
import { randomUUID } from "node:crypto";

export const dynamic = "force-dynamic";

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB — scanner exports occasionally exceed 4 MB
const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
]);

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ ok: false, reason: "invalid_form" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ ok: false, reason: "missing_file" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ ok: false, reason: "too_large" }, { status: 413 });
  }
  if (!ALLOWED_MIME.has(file.type)) {
    return NextResponse.json(
      { ok: false, reason: "bad_mime", mime: file.type },
      { status: 415 },
    );
  }

  const ext =
    file.type === "image/png"
      ? "png"
      : file.type === "image/webp"
      ? "webp"
      : file.type === "image/heic"
      ? "heic"
      : "jpg";
  const uuid = randomUUID();
  const path = `${user.id}/measurements/_unattached/${uuid}.${ext}`;

  const sr = createSupabaseServiceRoleClient();
  const { error: upErr } = await sr.storage
    .from("health-photos")
    .upload(path, file, { contentType: file.type, upsert: false });
  if (upErr) {
    return NextResponse.json(
      { ok: false, reason: "upload_failed", error: upErr.message },
      { status: 500 },
    );
  }

  const { data: signed } = await sr.storage
    .from("health-photos")
    .createSignedUrl(path, 60 * 60); // 1 hour, optimistic preview only

  return NextResponse.json({
    ok: true,
    path,
    signed_url: signed?.signedUrl ?? null,
  });
}
