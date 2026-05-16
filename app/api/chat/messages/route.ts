// app/api/chat/messages/route.ts
//
// GET — paginated history with signed URLs for images.
// POST — added in next task (SSE streaming).

import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "@/lib/supabase/server";
import type { ChatMessage, ChatMessageImage, ChatRole, ChatStatus } from "@/lib/chat/types";
import { type RichMessage, type ContentBlock } from "@/lib/anthropic/client";
import { runChatStream, emptyUsageTotals } from "@/lib/coach/chat-stream";
import type { ToolCallLog, MorningUI, WeeklyReviewCardUI } from "@/lib/data/types";
import { buildSnapshot, buildEphemeralHeader } from "@/lib/coach/snapshot";
import { todayInUserTz } from "@/lib/time";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildSystemPrompt } from "@/lib/coach/planning-prompts";
import type { ChatMode } from "@/lib/data/types";
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
  const kindRaw = url.searchParams.get("kind") ?? "coach";
  // Coach lane includes morning_brief so the regenerate_morning_brief tool's
  // refreshed card renders inline in normal coach chat (the original brief
  // also surfaces here — minor history duplication is acceptable; gives the
  // user context for what's already known).
  const kinds =
    kindRaw === "morning_intake"
      ? ["morning_intake", "morning_brief"]
      : ["coach", "morning_brief", "weekly_review"];
  const limitRaw = parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit = Math.min(MAX_LIMIT, Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : DEFAULT_LIMIT);

  let q = supabase
    .from("chat_messages")
    .select("id, role, content, status, error, model, kind, ui, tool_calls, mode, created_at, updated_at")
    .eq("user_id", user.id)
    .in("kind", kinds)
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
    kind: (r.kind as "coach" | "morning_intake" | "morning_brief" | "weekly_review") ?? "coach",
    ui: (r.ui as MorningUI | WeeklyReviewCardUI | null) ?? null,
    tool_calls: (r as { tool_calls?: import("@/lib/data/types").ToolCallLog[] | null }).tool_calls ?? null,
    mode: (r as { mode?: import("@/lib/data/types").ChatMode }).mode ?? "default",
  }));

  return NextResponse.json({ ok: true, messages });
}

const MAX_CONTENT_LEN = 8000;
const MAX_IMAGES = 8;
const ROLLING_WINDOW = 30;
const UNATTACHED_WINDOW_MIN = 15;
const DAILY_USER_MSG_CAP = 200;
const MODEL = "claude-sonnet-4-5";

type SendBody = { content?: string; image_ids?: string[]; mode?: string; doc?: string };

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

  const requestedMode: ChatMode | null =
    body.mode === "plan_week" || body.mode === "setup_block" || body.mode === "intake"
      ? body.mode
      : null;

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

  // Self-heal: clean up any stranded streaming row for this user older than
  // 5 minutes BEFORE the RPC. The single-streaming-row-per-user unique partial
  // index (migration 0005) otherwise 23505s every send forever after a prior
  // pre-stream throw or process kill. The pre-stream try/catch below catches
  // future throws, but this inline sweep handles pre-existing strands without
  // needing a cron (Vercel Hobby plan caps crons at 2 + daily granularity).
  const streamingCutoff = new Date(Date.now() - 5 * 60_000).toISOString();
  await sr
    .from("chat_messages")
    .update({
      status: "error",
      error: "self_heal_stuck_streaming",
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", user.id)
    .eq("status", "streaming")
    .lt("updated_at", streamingCutoff);

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

  // Resolve effective chat mode for this turn:
  //   1. Explicit request param wins
  //   2. Else inherit from the most recent prior chat_messages row (if non-default)
  //   3. Else 'default'
  let effectiveMode: ChatMode = "default";
  if (requestedMode) {
    effectiveMode = requestedMode;
  } else {
    const { data: prior } = await sr
      .from("chat_messages")
      .select("mode")
      .eq("user_id", user.id)
      .neq("id", rpcTyped.user_message_id)
      .neq("id", rpcTyped.assistant_message_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (
      prior?.mode === "plan_week" ||
      prior?.mode === "setup_block" ||
      prior?.mode === "intake"
    ) {
      effectiveMode = prior.mode;
    }
  }

  // Parse optional doc reference (UUID string passed by the intake-mode UI).
  // Defense-in-depth: format-validate against UUID before passing to executors.
  // The (id, user_id, status='draft') triple-eq in each executor enforces
  // ownership, but a clean UUID gate avoids surfacing malformed-input DB
  // errors as opaque "draft_not_found" surface text.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let draftDocId: string | null = null;
  if (typeof body.doc === "string" && UUID_RE.test(body.doc)) {
    draftDocId = body.doc;
  }

  // Stamp both rows with the resolved mode.
  await sr
    .from("chat_messages")
    .update({ mode: effectiveMode, updated_at: new Date().toISOString() })
    .in("id", [rpcTyped.user_message_id, rpcTyped.assistant_message_id]);

  // Three independent reads in parallel: user's editable system prompt,
  // the cached 14-day snapshot prefix, and the rolling chat-history window.
  // Use buildSnapshot (not buildSnapshotText) so we can exclude nowLine from
  // the cached block — it's a per-turn timestamp that would otherwise stale
  // the cache. The ephemeral header below provides a fresh NOW for the model.
  //
  // Wrapped in try/catch: any throw here (Vercel timeout, network glitch, a
  // code bug like profile-renderer TypeErrors) would otherwise strand the
  // assistant row in status='streaming' — permanently locking the chat surface
  // via the unique partial index chat_messages_one_streaming_per_user.
  // On failure: mark the row as error and return JSON 500 so the client
  // surfaces the error state rather than a frozen composer.
  async function signedUrl(path: string): Promise<string> {
    const { data } = await sr.storage
      .from("chat-images")
      .createSignedUrl(path, 24 * 60 * 60);
    return data?.signedUrl ?? "";
  }

  type WindowRow = { id: string; role: string; content: string; created_at: string };
  let finalSystemPrompt: string;
  let snapshot: string;
  let windowAsc: WindowRow[];
  let imgsByMsg: Map<string, { storage_path: string }[]>;
  let messages: RichMessage[];

  try {
    const sinceDate = new Date(`${todayInUserTz()}T00:00:00Z`);
    sinceDate.setUTCDate(sinceDate.getUTCDate() - 14);
    const since = sinceDate.toISOString().slice(0, 10);

    const [
      { data: profileRow },
      { body: snapshotBody },
      { data: windowRows },
    ] = await Promise.all([
      sr.from("profiles")
        .select("system_prompt")
        .eq("user_id", user.id)
        .maybeSingle(),
      buildSnapshot({
        supabase: sr as unknown as SupabaseClient,
        userId: user.id,
        since,
        workoutLimit: 5,
      }),
      sr.from("chat_messages")
        .select("id, role, content, created_at")
        .eq("user_id", user.id)
        .neq("status", "streaming")
        .neq("id", rpcTyped.user_message_id)
        .order("created_at", { ascending: false })
        .limit(ROLLING_WINDOW),
    ]);

    snapshot = snapshotBody;

    // Resolve effective system prompt via mode-aware assembler.
    const userPromptOverride =
      typeof profileRow?.system_prompt === "string" && profileRow.system_prompt.length > 0
        ? profileRow.system_prompt
        : null;
    finalSystemPrompt = await buildSystemPrompt({
      supabase: sr as unknown as SupabaseClient,
      userId: user.id,
      mode: effectiveMode,
      userPromptOverride,
    });

    windowAsc = ((windowRows ?? []) as WindowRow[]).slice().reverse();

    // For images on user messages in the window, attach signed URLs as image
    // content blocks.
    const windowMsgIds = windowAsc.map((m) => m.id);
    imgsByMsg = new Map<string, { storage_path: string }[]>();
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

    // Position 0: cached snapshot prefix.
    messages = [
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
  } catch (setupErr) {
    console.error("[chat] pre-stream setup threw — marking assistant row as error", setupErr);
    await sr
      .from("chat_messages")
      .update({
        status: "error",
        error: `pre_stream_setup_failed: ${setupErr instanceof Error ? setupErr.message : String(setupErr)}`,
        updated_at: new Date().toISOString(),
      })
      .eq("id", rpcTyped.assistant_message_id);
    return NextResponse.json(
      {
        ok: false,
        reason: "setup_failed",
        error: setupErr instanceof Error ? setupErr.message : "setup error",
      },
      { status: 500 },
    );
  }

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
      const usageSink = emptyUsageTotals();
      try {
        for await (const ev of runChatStream({
          userId: user.id,
          systemPrompt: finalSystemPrompt,
          messages,
          signal: req.signal,
          sr,
          toolCallSink,
          usageSink,
          assistantMessageId: assistantId,
          mode: effectiveMode,
          draftDocId,
        })) {
          if (req.signal.aborted) {
            aborted = true;
            errored = "aborted";
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

        // Revalidate /coach and /strength after successful write tools.
        // Without this, useTrainingWeek's 60s staleTime would mask a fresh
        // commit_week_plan / commit_block / commit_plan write for up to a
        // minute after the user approved it in chat. revalidatePath busts
        // the Next.js cache for the route on next navigation; TanStack
        // queries hydrated server-side from a fresh load see the new data.
        if (!errored) {
          const COMMIT_TOOLS = new Set([
            "commit_week_plan",
            "commit_block",
            "commit_plan",
          ]);
          const committed = toolCallSink.some(
            (c) => COMMIT_TOOLS.has(c.name) && c.error === null,
          );
          if (committed) {
            revalidatePath("/coach");
            revalidatePath("/strength");
          }
        }

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

        // Structured log line for observability. Includes prompt-cache hit
        // ratio so we can tune ephemeral TTLs and snapshot stability.
        const totalCachable = usageSink.cache_read_input_tokens + usageSink.cache_creation_input_tokens;
        const cacheHitPct = totalCachable > 0
          ? Math.round((usageSink.cache_read_input_tokens / totalCachable) * 100)
          : null;
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
            usage: {
              rounds: usageSink.rounds,
              input_tokens: usageSink.input_tokens,
              output_tokens: usageSink.output_tokens,
              cache_creation_input_tokens: usageSink.cache_creation_input_tokens,
              cache_read_input_tokens: usageSink.cache_read_input_tokens,
              cache_hit_pct: cacheHitPct,
            },
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
