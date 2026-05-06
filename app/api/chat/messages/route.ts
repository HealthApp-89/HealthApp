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
import { type RichMessage, type ContentBlock } from "@/lib/anthropic/client";
import { runChatStream } from "@/lib/coach/chat-stream";
import type { ToolCallLog } from "@/lib/data/types";
import { buildSnapshotText, buildEphemeralHeader } from "@/lib/coach/snapshot";
import {
  DEFAULT_SYSTEM_PROMPT,
  SCHEMA_EXPLAINER,
} from "@/lib/coach/system-prompts";
import type { SupabaseClient } from "@supabase/supabase-js";
import { formatSseEvent } from "@/lib/chat/sse";

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

  // Mint signed URLs in parallel via service-role (storage RLS would also
  // permit user-scoped client, but this avoids per-image round trips).
  const sr = createSupabaseServiceRoleClient();
  const signedImages: ChatMessageImage[] = await Promise.all(
    images.map(async (img) => {
      const { data: signed } = await sr.storage
        .from("chat-images")
        .createSignedUrl(img.storage_path, SIGNED_URL_TTL_SECONDS);
      return {
        id: img.id,
        storage_path: img.storage_path,
        mime: img.mime,
        bytes: img.bytes,
        width: img.width,
        height: img.height,
        signed_url: signed?.signedUrl ?? "",
      };
    }),
  );

  const imagesByMsg = new Map<string, ChatMessageImage[]>();
  images.forEach((img, i) => {
    const arr = imagesByMsg.get(img.message_id) ?? [];
    arr.push(signedImages[i]);
    imagesByMsg.set(img.message_id, arr);
  });

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

const MAX_CONTENT_LEN = 8000;
const MAX_IMAGES = 8;
const ROLLING_WINDOW = 30;
const UNATTACHED_WINDOW_MIN = 15;
const DAILY_USER_MSG_CAP = 200;
const MODEL = "claude-sonnet-4-5";

type SendBody = { content?: string; image_ids?: string[] };

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  }

  let body: SendBody;
  try {
    body = (await req.json()) as SendBody;
  } catch {
    return NextResponse.json({ ok: false, reason: "invalid_json" }, { status: 400 });
  }

  const content = (body.content ?? "").replace(/\x00/g, "");
  const imageIds = Array.isArray(body.image_ids) ? body.image_ids : [];

  if (content.length === 0 && imageIds.length === 0) {
    return NextResponse.json({ ok: false, reason: "empty" }, { status: 400 });
  }
  if (content.length > MAX_CONTENT_LEN) {
    return NextResponse.json({ ok: false, reason: "content_too_long" }, { status: 413 });
  }
  if (imageIds.length > MAX_IMAGES) {
    return NextResponse.json({ ok: false, reason: "too_many_images" }, { status: 413 });
  }

  const sr = createSupabaseServiceRoleClient();

  // Soft daily cap — runaway-retry guard.
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const { count: userMsgCount } = await sr
    .from("chat_messages")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .eq("role", "user")
    .gte("created_at", todayStart.toISOString());
  if ((userMsgCount ?? 0) >= DAILY_USER_MSG_CAP) {
    return NextResponse.json({ ok: false, reason: "daily_cap" }, { status: 429 });
  }

  // Verify image_ids: ownership via storage_path prefix, unattached, fresh.
  if (imageIds.length > 0) {
    const cutoff = new Date(Date.now() - UNATTACHED_WINDOW_MIN * 60_000).toISOString();
    const { data: imgRows, error: imgErr } = await sr
      .from("chat_message_images")
      .select("id, storage_path, message_id, created_at")
      .in("id", imageIds);
    if (imgErr) {
      return NextResponse.json({ ok: false, reason: "image_check_failed" }, { status: 500 });
    }
    if (!imgRows || imgRows.length !== imageIds.length) {
      return NextResponse.json({ ok: false, reason: "image_not_found" }, { status: 400 });
    }
    for (const r of imgRows) {
      if (!r.storage_path.startsWith(`${user.id}/`)) {
        return NextResponse.json({ ok: false, reason: "image_not_owned" }, { status: 403 });
      }
      if (r.message_id !== null) {
        return NextResponse.json({ ok: false, reason: "image_already_attached" }, { status: 400 });
      }
      if (r.created_at < cutoff) {
        return NextResponse.json({ ok: false, reason: "image_expired" }, { status: 400 });
      }
    }
  }

  // Atomic three-write: user msg + image attach + assistant stub.
  const { data: rpcRow, error: rpcErr } = await sr
    .rpc("chat_send_user_message", {
      p_user_id: user.id,
      p_content: content,
      p_image_ids: imageIds,
      p_model: MODEL,
    })
    .single();

  if (rpcErr) {
    // 23505 → in-flight stream already exists.
    const code = (rpcErr as { code?: string }).code;
    if (code === "23505") {
      return NextResponse.json({ ok: false, reason: "in_flight_stream" }, { status: 409 });
    }
    return NextResponse.json({ ok: false, reason: "rpc_failed", error: rpcErr.message }, { status: 500 });
  }
  if (!rpcRow) {
    return NextResponse.json({ ok: false, reason: "rpc_no_row" }, { status: 500 });
  }
  const rpcTyped = rpcRow as { user_message_id: string; assistant_message_id: string };
  const assistantId = rpcTyped.assistant_message_id;

  // Resolve effective system prompt: SCHEMA_EXPLAINER + (user override OR default).
  const { data: profileRow } = await sr
    .from("profiles")
    .select("system_prompt")
    .eq("user_id", user.id)
    .maybeSingle();
  const userPrompt =
    typeof profileRow?.system_prompt === "string" && profileRow.system_prompt.length > 0
      ? profileRow.system_prompt
      : DEFAULT_SYSTEM_PROMPT;
  const finalSystemPrompt = `${SCHEMA_EXPLAINER}\n\n---\n\n${userPrompt}`;

  // Build the cache-aware Anthropic message structure.
  const snapshot = await buildSnapshotText({ userId: user.id });

  // Pull the rolling window: last N messages BEFORE the just-inserted user
  // turn and the streaming assistant stub (both are appended explicitly below).
  type WindowRow = { id: string; role: string; content: string; created_at: string };
  const { data: windowRows } = await sr
    .from("chat_messages")
    .select("id, role, content, created_at")
    .eq("user_id", user.id)
    .neq("status", "streaming")
    .neq("id", rpcTyped.user_message_id)
    .order("created_at", { ascending: false })
    .limit(ROLLING_WINDOW);
  const windowAsc: WindowRow[] = ((windowRows ?? []) as WindowRow[]).slice().reverse();

  // For images on user messages in the window, attach signed URLs as image
  // content blocks.
  const windowMsgIds = windowAsc.map((m) => m.id);
  const imgsByMsg = new Map<string, { storage_path: string }[]>();
  if (windowMsgIds.length > 0) {
    const { data: winImgs } = await sr
      .from("chat_message_images")
      .select("message_id, storage_path")
      .in("message_id", windowMsgIds);
    for (const r of (winImgs ?? []) as { message_id: string; storage_path: string }[]) {
      const list = imgsByMsg.get(r.message_id) ?? [];
      list.push({ storage_path: r.storage_path });
      imgsByMsg.set(r.message_id, list);
    }
  }

  async function signedUrl(path: string): Promise<string> {
    const { data } = await sr.storage
      .from("chat-images")
      .createSignedUrl(path, 24 * 60 * 60);
    return data?.signedUrl ?? "";
  }

  // Position 0: cached snapshot prefix.
  const messages: RichMessage[] = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: snapshot,
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
    },
  ];

  // Slice the rolling window to start with a user message — Anthropic requires
  // alternating roles starting with user after the cached prefix.
  let startIdx = 0;
  while (startIdx < windowAsc.length && windowAsc[startIdx].role !== "user") startIdx++;
  for (let i = startIdx; i < windowAsc.length; i++) {
    const m = windowAsc[i];
    const blocks: ContentBlock[] = [];
    if (m.role === "user") {
      const imgs = imgsByMsg.get(m.id) ?? [];
      for (const img of imgs) {
        const url = await signedUrl(img.storage_path);
        if (url) blocks.push({ type: "image", source: { type: "url", url } });
      }
    }
    if (m.content) blocks.push({ type: "text", text: m.content });
    messages.push({
      role: m.role as "user" | "assistant",
      content: blocks.length > 0 ? blocks : "",
    });
  }

  // Append the new user turn (text + images via signed URL).
  const newTurnBlocks: ContentBlock[] = [];
  if (imageIds.length > 0) {
    const { data: newImgs } = await sr
      .from("chat_message_images")
      .select("storage_path")
      .in("id", imageIds);
    for (const img of newImgs ?? []) {
      const url = await signedUrl(img.storage_path);
      if (url) newTurnBlocks.push({ type: "image", source: { type: "url", url } });
    }
  }
  if (content) newTurnBlocks.push({ type: "text", text: content });
  // Ephemeral header is the FIRST text block of the new user turn (preceding
  // the actual content). Stays out of the cached snapshot prefix and adjacent
  // to the user's question so the model has the freshest context next to the
  // ask. Not marked cache_control — must NOT be cached.
  const ephemeralHeader = await buildEphemeralHeader({
    supabase: sr as unknown as SupabaseClient,
    userId: user.id,
  });
  const headerBlock: ContentBlock = { type: "text", text: ephemeralHeader };
  messages.push({ role: "user", content: [headerBlock, ...newTurnBlocks] });

  // Open the SSE response stream.
  const startedAt = Date.now();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let accumulated = "";
      let aborted = false;
      let errored: string | null = null;

      const onAbort = () => {
        aborted = true;
      };
      req.signal.addEventListener("abort", onAbort);

      const toolCallSink: ToolCallLog[] = [];
      try {
        for await (const ev of runChatStream({
          userId: user.id,
          systemPrompt: finalSystemPrompt,
          messages: messages as unknown as Parameters<typeof runChatStream>[0]["messages"],
          signal: req.signal,
          sr,
          toolCallSink,
        })) {
          if (req.signal.aborted) {
            aborted = true;
            break;
          }
          if (ev.type === "delta") {
            accumulated += ev.text;
            controller.enqueue(
              encoder.encode(formatSseEvent({ event: "delta", data: { text: ev.text } })),
            );
          } else if (ev.type === "tool_call_start") {
            controller.enqueue(
              encoder.encode(
                formatSseEvent({
                  event: "tool_call_start",
                  data: { id: ev.id, name: ev.name, input: ev.input },
                }),
              ),
            );
          } else if (ev.type === "tool_call_done") {
            controller.enqueue(
              encoder.encode(
                formatSseEvent({
                  event: "tool_call_done",
                  data: { id: ev.id, ok: ev.ok, ms: ev.ms },
                }),
              ),
            );
          } else if (ev.type === "error") {
            errored = ev.message;
            break;
          } else if (ev.type === "done") {
            // handled below
          }
        }
      } catch (e) {
        errored = (e as Error).message;
      } finally {
        req.signal.removeEventListener("abort", onAbort);

        // Persist the final state of the assistant stub. tool_calls is set
        // even on error/abort paths so we keep the diagnostic record.
        const finalStatus = errored ? "error" : "done";
        await sr
          .from("chat_messages")
          .update({
            content: accumulated,
            status: finalStatus,
            error: errored,
            tool_calls: toolCallSink.length > 0 ? toolCallSink : null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", assistantId);

        // Emit terminal SSE events for the client.
        if (errored) {
          controller.enqueue(
            encoder.encode(
              formatSseEvent({
                event: "done",
                data: { message_id: assistantId, partial: true },
              }),
            ),
          );
          controller.enqueue(
            encoder.encode(formatSseEvent({ event: "error", data: { message: errored } })),
          );
        } else {
          controller.enqueue(
            encoder.encode(
              formatSseEvent({ event: "done", data: { message_id: assistantId } }),
            ),
          );
        }

        // Structured log line for observability.
        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify({
            evt: "chat_turn",
            user_id: user.id,
            window: windowAsc.length,
            images: imageIds.length,
            status: aborted ? "aborted" : finalStatus,
            tool_calls: toolCallSink.length,
            tool_errors: toolCallSink.filter((c) => c.error !== null).length,
            latency_ms: Date.now() - startedAt,
          }),
        );

        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
