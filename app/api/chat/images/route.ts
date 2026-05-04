// app/api/chat/images/route.ts
//
// POST multipart/form-data with field "file". Validates size + MIME, uploads
// to Supabase Storage at <user_id>/_unattached/<uuid>.<ext> via service role,
// inserts a chat_message_images row with message_id = NULL, returns the new
// row id and a 1h signed URL for the optimistic preview.

import { NextResponse } from "next/server";
import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "@/lib/supabase/server";
import { randomUUID } from "node:crypto";

export const dynamic = "force-dynamic";

const MAX_BYTES = 4 * 1024 * 1024; // 4 MB
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_UNATTACHED_OLDER_THAN_1H = 50;

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
    return NextResponse.json({ ok: false, reason: "bad_mime", mime: file.type }, { status: 415 });
  }

  const sr = createSupabaseServiceRoleClient();

  // Rate guard: cap unattached images older than 1h to prevent retry-loop leaks.
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count } = await sr
    .from("chat_message_images")
    .select("id", { count: "exact", head: true })
    .is("message_id", null)
    .lt("created_at", oneHourAgo)
    .like("storage_path", `${user.id}/%`);
  if ((count ?? 0) > MAX_UNATTACHED_OLDER_THAN_1H) {
    return NextResponse.json(
      { ok: false, reason: "too_many_unattached" },
      { status: 429 },
    );
  }

  const ext = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
  const uuid = randomUUID();
  const path = `${user.id}/_unattached/${uuid}.${ext}`;

  const { error: upErr } = await sr.storage
    .from("chat-images")
    .upload(path, file, { contentType: file.type, upsert: false });
  if (upErr) {
    return NextResponse.json(
      { ok: false, reason: "upload_failed", error: upErr.message },
      { status: 500 },
    );
  }

  const { data: row, error: insErr } = await sr
    .from("chat_message_images")
    .insert({
      storage_path: path,
      mime: file.type,
      bytes: file.size,
    })
    .select("id")
    .single();
  if (insErr || !row) {
    // Best-effort: try to clean up the uploaded object so we don't leak.
    await sr.storage.from("chat-images").remove([path]);
    return NextResponse.json(
      { ok: false, reason: "db_insert_failed", error: insErr?.message },
      { status: 500 },
    );
  }

  const { data: signed } = await sr.storage
    .from("chat-images")
    .createSignedUrl(path, 60 * 60); // 1 hour, just for the optimistic preview

  return NextResponse.json({
    ok: true,
    id: row.id,
    signed_url: signed?.signedUrl ?? null,
  });
}
