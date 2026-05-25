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
import { executeCommitMealLog } from "@/lib/coach/tools";
import { SPEAKERS } from "@/lib/data/types";
import { CHAT_MODEL } from "@/lib/anthropic/models";
import { findFabricatedNumbers } from "@/lib/coach/fabrication-check";
import type { ToolCallLog, MorningUI, WeeklyReviewCardUI, Speaker } from "@/lib/data/types";
import { buildSnapshot, buildEphemeralHeader } from "@/lib/coach/snapshot";
import { todayInUserTz } from "@/lib/time";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildSystemPrompt } from "@/lib/coach/planning-prompts";
import type { ChatMode, DailyLog } from "@/lib/data/types";
import { formatSseEvent } from "@/lib/chat/sse";
import { computeActiveTriggers } from "@/lib/coach/voice/triggers";
import { getTodayTargets } from "@/lib/morning/brief/get-today-targets";
import { buildPeterContextBlock } from "@/lib/coach/peter-context";
import { loadLatestPeterDashboard } from "@/lib/coach/peter-dashboard";

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

  // Sweep stranded streaming rows so the chat UI doesn't stay frozen on the
  // pulsing dots after a Vercel function hit maxDuration mid-turn (the
  // try/finally that flips status='done'/'error' never runs when the process
  // is killed). The POST self-heal handles this on the next user send, but
  // viewers reloading a chat with no intent to send needed their own sweep.
  // 90s cutoff matches the chat function's maxDuration (60s) + a safety
  // margin so we don't kill an actually-in-flight stream.
  const streamingCutoff = new Date(Date.now() - 90_000).toISOString();
  const sweepClient = createSupabaseServiceRoleClient();
  await sweepClient
    .from("chat_messages")
    .update({
      status: "error",
      error: "self_heal_stuck_streaming",
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", user.id)
    .eq("status", "streaming")
    .lt("created_at", streamingCutoff);

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

  const threadRaw = url.searchParams.get("thread");
  const VALID_THREADS = ["peter", "carter", "nora", "remi"] as const;
  const thread = VALID_THREADS.includes(threadRaw as typeof VALID_THREADS[number])
    ? (threadRaw as typeof VALID_THREADS[number])
    : null;

  let q = supabase
    .from("chat_messages")
    .select("id, role, content, status, error, model, speaker, thread, kind, ui, tool_calls, mode, created_at, updated_at")
    .eq("user_id", user.id)
    .in("kind", kinds)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (thread) q = q.eq("thread", thread);
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
    speaker: (r as { speaker?: import("@/lib/data/types").ChatSpeaker }).speaker ?? ("peter" as const),
    thread: ((r as { thread?: import("@/lib/data/types").Speaker }).thread ?? "peter") as import("@/lib/data/types").Speaker,
    kind: (r.kind as "coach" | "morning_intake" | "morning_brief" | "weekly_review") ?? "coach",
    ui: (r.ui as MorningUI | WeeklyReviewCardUI | null) ?? null,
    tool_calls: (r as { tool_calls?: import("@/lib/data/types").ToolCallLog[] | null }).tool_calls ?? null,
    mode: (r as { mode?: import("@/lib/data/types").ChatMode }).mode ?? "default",
  }));

  return NextResponse.json({ ok: true, messages });
}

const MAX_CONTENT_LEN = 8000;
const MAX_IMAGES = 8;
/** Hard cap on the number of historical messages fetched for the rolling
 *  window. Anchored at 30 — most chats reference far less. */
const ROLLING_WINDOW = 30;
/** Soft token budget for the rolling window after fetching. Anthropic's
 *  context window is 200k, but a long chat history with images can easily
 *  push the rolling window alone past 15k tokens. We cap rolling-window
 *  contribution at ~6k tokens by trimming oldest-first once the cumulative
 *  estimate exceeds the budget. Snapshot prefix + new turn are NOT counted
 *  here — they have separate budgets. */
const ROLLING_TOKEN_BUDGET = 6000;
/** Crude tokens-per-char ratio for English chat prose. Real value drifts
 *  by domain (Sonnet ≈ 3.5 for English, ~3 with lots of numbers/jargon).
 *  Erring high keeps us under-budget rather than over. */
const TOKENS_PER_CHAR = 1 / 3.5;
/** Approximate token cost per image reference (URL-based images sent to
 *  Claude are billed by their dimensions; this is a conservative floor for
 *  the small/medium uploads typical of chat). */
const TOKENS_PER_IMAGE = 85;
/** Window (minutes) during which an unattached upload can be claimed by a
 *  send. Bumped 15 → 60 so users can compose a message slowly after dropping
 *  in a photo without hitting "image expired" on send. */
const UNATTACHED_WINDOW_MIN = 60;
const DAILY_USER_MSG_CAP = 200;
/** When the user has already sent >= this many messages today, append a
 *  "be terser" instruction to the system prompt. Soft-degrades cost + tone
 *  before the hard 429 at DAILY_USER_MSG_CAP. */
const TERSE_MODE_THRESHOLD = 150;
const MODEL = CHAT_MODEL;

type SendBody = {
  content?: string;
  image_ids?: string[];
  mode?: string;
  doc?: string;
  /** Picks a specific coach for the response. One of peter|carter|nora|remi.
   *  Set by ChatPanel's `thread` prop (per-coach pages) — the user is on
   *  Carter's page, so Carter answers. Ignored in intake mode (single-voice). */
  speaker_override?: string;
  /** Side-channel context for Nora-in-meal-log. Threaded into runChatStream's
   *  mealLogDraftContext opt so it lands in Nora's system prompt for this
   *  turn but NEVER becomes a visible chat_messages.content. Used by
   *  MealLoggerChatTab to tell Nora "you're working on draft entry X with
   *  these items at these confidences" without leaking into the thread. */
  hidden_context?: string;
};

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
    body.mode === "plan_week" ||
    body.mode === "setup_block" ||
    body.mode === "intake" ||
    body.mode === "meal_log"
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
  const terseMode = (userMsgCount ?? 0) >= TERSE_MODE_THRESHOLD;

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

  // Resolve effective chat mode for this turn. Mode is fully client-driven:
  // the ModeBanner X button clears the URL param and the client stops sending
  // `mode` in the body. The old behaviour silently inherited from the prior
  // assistant turn — useful for multi-turn planning, but the leak across
  // tab-switches and after explicit Exit was the audit's flagged footgun.
  // Now: explicit `mode` in request body wins; absent = default.
  const effectiveMode: ChatMode = requestedMode ?? "default";

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

  // Pull the draft entry id out of hidden_context for meal_log mode. The
  // MealLoggerChatTab includes a line `entry_id: <uuid>` in the hidden
  // context for every reply turn; we tag both the user and assistant rows
  // with it so the post-commit DELETE can scope by draft_entry_id.
  let mealLogDraftEntryId: string | null = null;
  if (effectiveMode === "meal_log" && typeof body.hidden_context === "string") {
    const m = body.hidden_context.match(/entry_id:\s*([0-9a-f-]{36})/i);
    if (m) mealLogDraftEntryId = m[1];
  }

  // Stamp both rows with the resolved mode + kind + (for meal_log) the
  // draft entry tag. kind defaults to 'coach' from the table; for meal_log
  // mode we need 'meal_log' so the MealLoggerChatTab thread query picks up
  // the assistant reply and the post-commit DELETE-by-draft_entry_id finds
  // these rows.
  const stampPatch: {
    mode: ChatMode;
    updated_at: string;
    kind?: "meal_log";
    draft_entry_id?: string;
  } = {
    mode: effectiveMode,
    updated_at: new Date().toISOString(),
  };
  if (effectiveMode === "meal_log") {
    stampPatch.kind = "meal_log";
    if (mealLogDraftEntryId) stampPatch.draft_entry_id = mealLogDraftEntryId;
  }
  await sr
    .from("chat_messages")
    .update(stampPatch)
    .in("id", [rpcTyped.user_message_id, rpcTyped.assistant_message_id]);

  // ── Pre-stream routing ────────────────────────────────────────────────
  // Intake mode is single-voice (Peter). All other modes run the router.
  const overrideRaw = typeof body.speaker_override === "string" ? body.speaker_override : "";
  const overrideSpeaker: Speaker | null = SPEAKERS.includes(overrideRaw as Speaker)
    ? (overrideRaw as Speaker)
    : null;

  // Every active chat surface (Strength/Diet/Health/Metrics) passes
  // speaker_override = the page's thread (set by ChatPanel's `thread` prop).
  // Intake mode is single-voice (Peter). With the legacy /coach surface
  // gone, classifyTurn is no longer needed — the speaker is just the
  // override or 'peter' as fallback. system_routing audit rows are no
  // longer written; the historical ones in the DB stay as is.
  const initialSpeaker: Speaker = overrideSpeaker ?? "peter";

  // Stamp both rows (user + assistant) with the resolved thread lane so
  // per-thread history filters work from day one.
  await sr
    .from("chat_messages")
    .update({ thread: initialSpeaker, updated_at: new Date().toISOString() })
    .in("id", [rpcTyped.user_message_id, rpcTyped.assistant_message_id]);

  // Stamp the assistant stub with the chosen speaker so the SSE chip swap
  // matches and the final persisted row carries the correct attribution.
  await sr
    .from("chat_messages")
    .update({
      speaker: initialSpeaker,
      thread: initialSpeaker,
      updated_at: new Date().toISOString(),
    })
    .eq("id", rpcTyped.assistant_message_id);

  // ── Approval-token intercept ──────────────────────────────────────────
  // When the user taps Approve on a proposal card, ChatPanel sends
  // `[approve:<token>]` as the user message. The legacy flow was to push
  // this to Anthropic and let the speaker call commit_X({approval_token}).
  // That breaks for meal_log because the embedded-payload token is ~7000
  // chars / ~1700 output tokens — close to MAX_TOKENS=2000. The model
  // either truncates the token (signature mismatch → loop) or just streams
  // its way through the entire 60s Vercel budget echoing it back. Even
  // after the ref-shrink fix landed, in-flight 7k-char tokens still hung,
  // and the model occasionally dropped the token argument entirely.
  //
  // The commit step is deterministic — verify the token, do the thing.
  // No reason to round-trip through the model. We dispatch directly,
  // synthesize a short assistant message, and stream a one-shot SSE
  // response. Other commit_* actions still go through the model (their
  // tokens are small and they need the LLM to compose the follow-up
  // narrative); only meal_log intercepts for now.
  const approveMatch = content.trim().match(/^\[approve:([^\]]+)\]$/);
  if (approveMatch) {
    const token = approveMatch[1];
    let approveAction: string | null = null;
    try {
      const parts = token.split(".");
      if (parts.length === 2) {
        const env = JSON.parse(
          Buffer.from(parts[0], "base64url").toString("utf8"),
        ) as { action?: string };
        approveAction = env.action ?? null;
      }
    } catch {
      // Malformed token — fall through to the Anthropic path so the
      // existing error surface handles it.
    }

    if (approveAction === "meal_log") {
      const t0 = Date.now();
      const result = await executeCommitMealLog({
        supabase: sr,
        userId: user.id,
        input: { approval_token: token },
      });
      const elapsed = Date.now() - t0;

      const content = result.ok
        ? `Logged to ${result.data.meal_slot} ✅ — ${result.data.item_count} items, ${Math.round(result.data.totals.kcal)} kcal · ${Math.round(result.data.totals.protein_g)}P / ${Math.round(result.data.totals.carbs_g)}C / ${Math.round(result.data.totals.fat_g)}F. Today: ${Math.round(result.data.day_totals.kcal)} kcal · ${Math.round(result.data.day_totals.protein_g)}P / ${Math.round(result.data.day_totals.carbs_g)}C / ${Math.round(result.data.day_totals.fat_g)}F.`
        : result.error.error;

      const toolCallLog: ToolCallLog = {
        name: "commit_meal_log",
        input: { approval_token: `${token.slice(0, 24)}…` },
        ms: elapsed,
        result_rows: result.ok ? 1 : 0,
        range_days: 0,
        truncated: false,
        error: result.ok ? null : result.error.error,
        result: result.ok ? result.data : undefined,
      };

      await sr
        .from("chat_messages")
        .update({
          content,
          status: result.ok ? "done" : "error",
          error: result.ok ? null : result.error.error,
          tool_calls: [toolCallLog],
          updated_at: new Date().toISOString(),
        })
        .eq("id", rpcTyped.assistant_message_id);

      // Synthesize the SSE response the client expects: one delta with
      // the full text, then a done event carrying the tool_calls so the
      // proposal card can flip to its committed state in-place.
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              formatSseEvent({ event: "delta", data: { text: content } }),
            ),
          );
          if (!result.ok) {
            controller.enqueue(
              encoder.encode(
                formatSseEvent({
                  event: "done",
                  data: {
                    message_id: rpcTyped.assistant_message_id,
                    partial: true,
                    tool_calls: [toolCallLog],
                  },
                }),
              ),
            );
            controller.enqueue(
              encoder.encode(
                formatSseEvent({
                  event: "error",
                  data: { message: result.error.error },
                }),
              ),
            );
          } else {
            controller.enqueue(
              encoder.encode(
                formatSseEvent({
                  event: "done",
                  data: {
                    message_id: rpcTyped.assistant_message_id,
                    tool_calls: [toolCallLog],
                  },
                }),
              ),
            );
          }
          controller.close();
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
        },
      });
    }
  }

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
    const todayIso = todayInUserTz();
    const sinceDate = new Date(`${todayIso}T00:00:00Z`);
    sinceDate.setUTCDate(sinceDate.getUTCDate() - 14);
    const since = sinceDate.toISOString().slice(0, 10);

    // Carter escalation triggers: last 30 days of daily_logs (sleep/hrv/
    // steps/protein) + last 14 days of workouts (count vs expected 6).
    const triggersSinceDate = new Date(`${todayIso}T00:00:00Z`);
    triggersSinceDate.setUTCDate(triggersSinceDate.getUTCDate() - 30);
    const triggersSince = triggersSinceDate.toISOString().slice(0, 10);
    const workoutsSinceDate = new Date(`${todayIso}T00:00:00Z`);
    workoutsSinceDate.setUTCDate(workoutsSinceDate.getUTCDate() - 14);
    const workoutsSince = workoutsSinceDate.toISOString().slice(0, 10);

    const [
      { data: profileRow },
      { body: snapshotBody },
      { data: windowRows },
      { data: trigDailyLogsRows },
      { data: trigWorkoutsRows },
      todayTargets,
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
        .neq("kind", "system_routing")
        .order("created_at", { ascending: false })
        .limit(ROLLING_WINDOW),
      sr.from("daily_logs")
        .select("date, sleep_hours, hrv, steps, protein_g")
        .eq("user_id", user.id)
        .gte("date", triggersSince)
        .lte("date", todayIso)
        .order("date", { ascending: true }),
      sr.from("workouts")
        .select("date, type")
        .eq("user_id", user.id)
        .gte("date", workoutsSince)
        .lte("date", todayIso),
      // getTodayTargets — null when athlete profile not active. We catch
      // separately so a profile read failure doesn't kill the chat turn;
      // the triggers compute falls back to a static protein floor.
      getTodayTargets(sr as unknown as SupabaseClient, user.id).catch((err) => {
        console.warn("[chat/triggers] getTodayTargets failed", err);
        return null;
      }),
    ]);

    snapshot = snapshotBody;

    // Compute Carter active triggers for this turn. Protein floor source of
    // truth is the active plan / GLP-1 mode (getTodayTargets.protein_g).
    // Fallback to 180 g when no active plan exists — a reasonable default
    // for a ~95 kg cutting athlete at 1.8 g/kg. The numeric default never
    // applies to a user who has completed onboarding.
    const trigDailyLogs = (trigDailyLogsRows ?? []) as DailyLog[];
    const todayLog = trigDailyLogs.find((l) => l.date === todayIso) ?? null;
    const proteinToday_g = todayLog?.protein_g ?? null;
    const proteinFloor_g = todayTargets?.protein_g ?? 180;
    const trigWorkouts = (trigWorkoutsRows ?? []) as Array<{ date: string; type: string | null }>;
    const activeTriggers = computeActiveTriggers({
      today: new Date(`${todayIso}T00:00:00Z`),
      dailyLogs: trigDailyLogs,
      workoutsLast14d: trigWorkouts,
      proteinFloor_g,
      proteinToday_g,
    });

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
      activeTriggers,
    });

    // Graceful degradation as the user approaches the daily cap: append a
    // terseness directive so replies stay short rather than hard-failing
    // every send once DAILY_USER_MSG_CAP hits. NOT cached — appended after
    // the cached prefix so the cache prefix stays stable.
    if (terseMode) {
      finalSystemPrompt = `${finalSystemPrompt}\n\n---\n\nHIGH-VOLUME MODE: You're approaching the daily message cap. Default to 1-2 sentences per reply unless the question explicitly requires depth. Skip recap; answer the question.`;
    }

    // windowRows is desc (newest first). Build the image map first so the
    // token-budget walk can include image cost, then walk newest → oldest
    // dropping anything beyond ROLLING_TOKEN_BUDGET. We bias toward recent
    // context: the model needs the last few turns more than the 20th-back.
    const rawWindow = ((windowRows ?? []) as WindowRow[]).slice(); // desc
    const allWindowIds = rawWindow.map((m) => m.id);
    imgsByMsg = new Map<string, { storage_path: string }[]>();
    if (allWindowIds.length > 0) {
      const { data: winImgs } = await sr
        .from("chat_message_images")
        .select("message_id, storage_path")
        .in("message_id", allWindowIds);
      for (const r of (winImgs ?? []) as { message_id: string; storage_path: string }[]) {
        const list = imgsByMsg.get(r.message_id) ?? [];
        list.push({ storage_path: r.storage_path });
        imgsByMsg.set(r.message_id, list);
      }
    }

    let runningTokens = 0;
    const keptDesc: WindowRow[] = [];
    for (const m of rawWindow) {
      const textTokens = Math.ceil((m.content?.length ?? 0) * TOKENS_PER_CHAR);
      const imageTokens = (imgsByMsg.get(m.id)?.length ?? 0) * TOKENS_PER_IMAGE;
      const cost = textTokens + imageTokens;
      if (runningTokens + cost > ROLLING_TOKEN_BUDGET && keptDesc.length > 0) {
        // Stop adding older context once we'd overshoot. Always keep at
        // least one prior message (the immediate predecessor) so the new
        // turn has SOMETHING to reference.
        break;
      }
      runningTokens += cost;
      keptDesc.push(m);
    }
    windowAsc = keptDesc.slice().reverse();

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
    // The @-mention preprocessing that classifyTurn used to do (strip `@Carter`
    // from the user's text before showing it to the model) is gone with the
    // router. The DB row and the model now see identical content. If users
    // start prefixing @-mentions and want them stripped, that's a small
    // helper for a future PR.
    const llmText = content;
    if (llmText) newTurnBlocks.push({ type: "text", text: llmText });
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
      // Speaker for the active turn — always the pre-stream router's choice
      // now that mid-stream handoff is removed.
      const activeSpeaker: Speaker = initialSpeaker;
      // Build the specialist-activity context block for Peter turns. Non-blocking
      // on failure — a DB error here should never prevent the chat from streaming.
      const peterContext = initialSpeaker === "peter"
        ? await buildPeterContextBlock(sr, user.id).catch((err) => {
            console.warn("[chat] buildPeterContextBlock failed", err);
            return null;
          })
        : null;
      const peterDashboardBlock = initialSpeaker === "peter"
        ? await loadLatestPeterDashboard(sr, user.id, new Date().toISOString().slice(0, 10))
            .then((row) => row?.narrative_md ?? null)
            .catch((err) => {
              console.warn("[chat] loadLatestPeterDashboard failed", err);
              return null;
            })
        : null;
      try {
        // Drain one runChatStream pass, piping all SSE events to the client.
        // Pin to local — TS loses control-flow narrowing through async closures.
        const userId = user.id;
        async function drainStream(
          streamSpeaker: Speaker,
          streamMessages: RichMessage[],
        ): Promise<void> {
          for await (const ev of runChatStream({
            userId,
            systemPrompt: finalSystemPrompt,
            messages: streamMessages,
            signal: req.signal,
            sr,
            toolCallSink,
            usageSink,
            assistantMessageId: assistantId,
            mode: effectiveMode,
            draftDocId,
            speaker: streamSpeaker,
            peterContext,
            peterDashboardBlock,
            mealLogDraftContext: typeof body.hidden_context === "string" && body.hidden_context.length > 0
              ? body.hidden_context
              : null,
          })) {
            if (req.signal.aborted) {
              aborted = true;
              errored = "aborted";
              return;
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
              return;
            } else if (ev.type === "done") {
              // handled below
            }
          }
        }

        await drainStream(activeSpeaker, messages);
      } catch (e) {
        errored = (e as Error).message;
      } finally {
        req.signal.removeEventListener("abort", onAbort);

        // Persist the final state of the assistant stub. tool_calls is set
        // even on error/abort paths so we keep the diagnostic record.
        // speaker reflects the pre-stream router's chosen coach — always
        // initialSpeaker now that mid-stream handoff is removed.
        const finalStatus = errored ? "error" : "done";
        await sr
          .from("chat_messages")
          .update({
            content: accumulated,
            status: finalStatus,
            error: errored,
            speaker: activeSpeaker,
            thread: activeSpeaker,
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
            revalidatePath("/coach");
          }
        }

        // Emit terminal SSE events for the client. tool_calls is included in
        // the `done` payload (when non-empty) so the client can patch the
        // assistant message in-place without a follow-up GET refetch — saves
        // a round trip and a render flash for every turn that used a tool.
        const persistedToolCalls = toolCallSink.length > 0 ? toolCallSink : null;
        if (errored) {
          controller.enqueue(
            encoder.encode(
              formatSseEvent({
                event: "done",
                data: { message_id: assistantId, partial: true, tool_calls: persistedToolCalls },
              }),
            ),
          );
          controller.enqueue(
            encoder.encode(formatSseEvent({ event: "error", data: { message: errored } })),
          );
        } else {
          controller.enqueue(
            encoder.encode(
              formatSseEvent({
                event: "done",
                data: { message_id: assistantId, tool_calls: persistedToolCalls },
              }),
            ),
          );
        }

        // Fabrication observability: extract numerics from the assistant
        // turn and flag any not present in the model's provable sources.
        // Non-blocking — purely a logging signal for weekly review of
        // hallucination rate. Heavy false-positive tolerance (small ints,
        // ±1 rounding, snapshot text + tool results + window all merged).
        let fabricated: string[] = [];
        try {
          if (!errored && accumulated.length > 0) {
            fabricated = findFabricatedNumbers(accumulated, {
              snapshot: snapshot ?? "",
              toolCalls: toolCallSink,
              recentMessageTexts: [
                ...windowAsc.map((m) => m.content ?? ""),
                content ?? "",
              ],
            });
          }
        } catch (err) {
          // Defensive: a regex bomb or weird text shouldn't break the log.
          console.error("[chat_turn] fabrication-check threw", err);
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
            window_token_est: Math.round(
              windowAsc.reduce(
                (sum, m) =>
                  sum +
                  Math.ceil((m.content?.length ?? 0) * TOKENS_PER_CHAR) +
                  (imgsByMsg?.get(m.id)?.length ?? 0) * TOKENS_PER_IMAGE,
                0,
              ),
            ),
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
            fabricated_numbers: fabricated.length > 0 ? fabricated : null,
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
