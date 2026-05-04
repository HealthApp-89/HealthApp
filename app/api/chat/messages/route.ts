// app/api/chat/messages/route.ts
//
// GET — paginated history with signed URLs for images.
// POST — added in next task (SSE streaming).

import { NextResponse } from "next/server";
import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "@/lib/supabase/server";
import type { ChatMessage, ChatMessageImage, ChatRole, ChatStatus } from "@/lib/chat/types";

export const dynamic = "force-dynamic";

const SIGNED_URL_TTL_SECONDS = 24 * 60 * 60; // 24h
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function GET(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const before = url.searchParams.get("before"); // ISO timestamp, exclusive
  const limitRaw = parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit = Math.min(MAX_LIMIT, Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : DEFAULT_LIMIT);

  let q = supabase
    .from("chat_messages")
    .select("id, role, content, status, error, model, created_at, updated_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (before) q = q.lt("created_at", before);

  const { data: rows, error } = await q;
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const messageIds = (rows ?? []).map((r) => r.id);
  let images: { id: string; message_id: string; storage_path: string; mime: string; bytes: number; width: number | null; height: number | null }[] = [];
  if (messageIds.length > 0) {
    const { data: imgRows } = await supabase
      .from("chat_message_images")
      .select("id, message_id, storage_path, mime, bytes, width, height")
      .in("message_id", messageIds);
    images = imgRows ?? [];
  }

  // Mint signed URLs in one batch via service-role (storage RLS would also
  // permit user-scoped client, but this avoids per-image round trips).
  const sr = createSupabaseServiceRoleClient();
  const imagesByMsg = new Map<string, ChatMessageImage[]>();
  for (const img of images) {
    const { data: signed } = await sr.storage
      .from("chat-images")
      .createSignedUrl(img.storage_path, SIGNED_URL_TTL_SECONDS);
    const arr = imagesByMsg.get(img.message_id) ?? [];
    arr.push({
      id: img.id,
      storage_path: img.storage_path,
      mime: img.mime,
      bytes: img.bytes,
      width: img.width,
      height: img.height,
      signed_url: signed?.signedUrl ?? "",
    });
    imagesByMsg.set(img.message_id, arr);
  }

  const messages: ChatMessage[] = (rows ?? []).map((r) => ({
    id: r.id,
    role: r.role as ChatRole,
    content: r.content,
    status: r.status as ChatStatus,
    error: r.error,
    model: r.model,
    created_at: r.created_at,
    updated_at: r.updated_at,
    images: imagesByMsg.get(r.id) ?? [],
  }));

  return NextResponse.json({ ok: true, messages });
}
