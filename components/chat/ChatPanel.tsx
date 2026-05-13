// components/chat/ChatPanel.tsx
"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { ChatMessage } from "@/lib/chat/types";
import type { ChatMode } from "@/lib/data/types";
import { ChatThread } from "./ChatThread";
import { ChatComposer } from "./ChatComposer";
import { ModeBanner } from "./ModeBanner";
import { postSse } from "./sseClient";
import { ChatChips } from "./ChatChips";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { useDailyLogs } from "@/lib/query/hooks/useDailyLogs";
import { useCheckin } from "@/lib/query/hooks/useCheckin";
import { todayInUserTz, ymdInUserTz } from "@/lib/time";
import { COLOR } from "@/lib/ui/theme";

/** For morning_intake, scope thread to today's messages only — yesterday's
 *  morning checkin shouldn't appear in today's panel and would otherwise
 *  block the auto-start guard from firing the next-day fresh prompt.
 *  Coach mode keeps cross-day history (intentional there). */
function scopeForMode(
  messages: ChatMessage[],
  mode: "coach" | "morning_intake",
  todayYmd: string,
): ChatMessage[] {
  if (mode !== "morning_intake") return messages;
  return messages.filter(
    (m) => ymdInUserTz(new Date(m.created_at)) === todayYmd,
  );
}

type State = {
  loaded: boolean;
  messages: ChatMessage[];
  hasMoreOlder: boolean;
  inFlightAssistantId: string | null;
  inFlightWaitMessage: string | null;
};

type Action =
  | { type: "loaded"; messages: ChatMessage[] }
  | { type: "prepend"; messages: ChatMessage[]; hasMore: boolean }
  | { type: "append_user"; message: ChatMessage }
  | { type: "append_assistant_stub"; id: string }
  | { type: "append_delta"; id: string; text: string }
  | { type: "finalize_assistant"; id: string; status: "done" | "error"; error?: string; partial?: boolean }
  | { type: "replace_id"; tempId: string; serverId: string }
  | { type: "remove_temp_user"; tempId: string }
  | { type: "wait"; message: string | null }
  | { type: "add_message"; message: ChatMessage }
  | { type: "remove_id"; id: string }
  | { type: "patch_message"; id: string; patch: Partial<ChatMessage> };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "loaded":
      return { ...state, loaded: true, messages: action.messages, hasMoreOlder: action.messages.length >= 50 };
    case "prepend":
      return { ...state, messages: [...action.messages, ...state.messages], hasMoreOlder: action.hasMore };
    case "append_user":
      return { ...state, messages: [...state.messages, action.message] };
    case "append_assistant_stub":
      return {
        ...state,
        inFlightAssistantId: action.id,
        messages: [
          ...state.messages,
          {
            id: action.id,
            role: "assistant",
            content: "",
            status: "streaming",
            error: null,
            model: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            images: [],
            kind: "coach" as const,
            ui: null,
            tool_calls: null,
          },
        ],
      };
    case "append_delta":
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === action.id ? { ...m, content: m.content + action.text } : m,
        ),
      };
    case "finalize_assistant":
      return {
        ...state,
        inFlightAssistantId: null,
        messages: state.messages.map((m) =>
          m.id === action.id
            ? { ...m, status: action.status, error: action.error ?? null }
            : m,
        ),
      };
    case "replace_id":
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === action.tempId ? { ...m, id: action.serverId } : m,
        ),
      };
    case "remove_temp_user":
      return { ...state, messages: state.messages.filter((m) => m.id !== action.tempId) };
    case "wait":
      return { ...state, inFlightWaitMessage: action.message };
    case "add_message":
      return { ...state, messages: [...state.messages, action.message] };
    case "remove_id":
      return { ...state, messages: state.messages.filter((m) => m.id !== action.id) };
    case "patch_message":
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === action.id ? { ...m, ...action.patch } : m,
        ),
      };
    default:
      return state;
  }
}

export default function ChatPanel({
  onClose,
  initialKind = "coach",
  userId,
  initialMode = "default",
  initialModeContext,
  draftDocId,
}: {
  onClose: () => void;
  /** Initial conversation lane; tab clicks at runtime override this. */
  initialKind?: "coach" | "morning_intake";
  userId: string;
  initialMode?: ChatMode;
  initialModeContext?: string;
  /** Athlete-profile draft doc id, required when initialMode='intake'.
   *  Threaded through to /api/chat/messages as body.doc so the route can
   *  inject it into the Phase 2 tool executors' ToolCtx. */
  draftDocId?: string;
}) {
  const [mode, setMode] = useState<ChatMode>(initialMode);
  const [composerHint, setComposerHint] = useState<string | undefined>(undefined);
  const [state, dispatch] = useReducer(reducer, {
    loaded: false,
    messages: [],
    hasMoreOlder: false,
    inFlightAssistantId: null,
    inFlightWaitMessage: null,
  });

  const [currentMode, setCurrentMode] = useState<"coach" | "morning_intake">(initialKind);
  const [sickInFlight, setSickInFlight] = useState(false);

  const panelRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const recommendationRunningRef = useRef(false);
  const startFiredRef = useRef(false);
  const intakeStartFiredRef = useRef(false);

  // Load history on mount or when currentMode changes.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/chat/messages?limit=50&kind=${currentMode}`);
      const json = (await res.json()) as { ok: boolean; messages?: ChatMessage[] };
      if (cancelled) return;
      if (json.ok && json.messages) {
        // Server returns desc; we want asc for render.
        const asc = json.messages.slice().reverse();
        dispatch({ type: "loaded", messages: scopeForMode(asc, currentMode, today) });
      } else {
        dispatch({ type: "loaded", messages: [] });
      }
    })();
    return () => {
      cancelled = true;
      abortRef.current?.abort();
    };
    // `today` is intentionally not in deps — it's a render-time string that
    // would only change at midnight (and the panel is unlikely to span that).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentMode]);

  // iOS PWA keyboard handling: subscribe to visualViewport.resize and
  // translate the panel up by the keyboard's intrusion.
  useEffect(() => {
    const el = panelRef.current;
    if (!el || typeof window === "undefined" || !window.visualViewport) return;
    const vv = window.visualViewport;
    const update = () => {
      const intrusion = window.innerHeight - vv.height - vv.offsetTop;
      el.style.transform = intrusion > 0 ? `translateY(${-intrusion}px)` : "";
    };
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    update();
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);

  const loadOlder = useCallback(async (beforeIso: string) => {
    // Morning thread is one day at a time — older messages are yesterday's
    // checkin (and would just be filtered out by scopeForMode anyway, leading
    // to an empty-fetch loop with the IntersectionObserver).
    if (currentMode === "morning_intake") return { added: 0 };
    if (!state.hasMoreOlder) return { added: 0 };
    const res = await fetch(`/api/chat/messages?limit=50&kind=${currentMode}&before=${encodeURIComponent(beforeIso)}`);
    const json = (await res.json()) as { ok: boolean; messages?: ChatMessage[] };
    if (!json.ok || !json.messages) return { added: 0 };
    const older = json.messages.slice().reverse();
    dispatch({ type: "prepend", messages: older, hasMore: older.length >= 50 });
    return { added: older.length };
  }, [state.hasMoreOlder, currentMode]);

  const send = useCallback(
    async (content: string, imageIds: string[]) => {
      // Clear composer hint after each send.
      setComposerHint(undefined);

      // Optimistic user message — hide [approve:] messages visually but still
      // send them so the server processes the approval.
      const tempId = `tmp-${crypto.randomUUID()}`;
      const tempMsg: ChatMessage = {
        id: tempId,
        role: "user",
        content,
        status: "done",
        error: null,
        model: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        images: [], // optimistic — we don't have signed URLs for the new uploads here
        kind: "coach" as const,
        ui: null,
        tool_calls: null,
      };
      dispatch({ type: "append_user", message: tempMsg });

      const ac = new AbortController();
      abortRef.current = ac;

      let assistantStubAdded = false;
      let assistantId: string | null = null;
      let currentId: string | null = null;
      try {
        for await (const ev of postSse(
          "/api/chat/messages",
          { content, image_ids: imageIds, mode, doc: draftDocId },
          { signal: ac.signal },
        )) {
          if (ev.type === "delta") {
            if (!assistantStubAdded) {
              // The server already created a stub on its side. We mirror that
              // locally on first delta so streaming visualisation works.
              assistantId = `stub-${crypto.randomUUID()}`;
              currentId = assistantId;
              dispatch({ type: "append_assistant_stub", id: assistantId });
              assistantStubAdded = true;
            }
            dispatch({ type: "append_delta", id: assistantId!, text: ev.text });
          } else if (ev.type === "done") {
            if (!assistantStubAdded) {
              // No deltas (extremely short reply or aborted before first delta).
              assistantId = `stub-${crypto.randomUUID()}`;
              currentId = assistantId;
              dispatch({ type: "append_assistant_stub", id: assistantId });
              assistantStubAdded = true;
            }
            // Swap to server id and finalize.
            dispatch({ type: "replace_id", tempId: assistantId!, serverId: ev.message_id });
            currentId = ev.message_id;
            dispatch({
              type: "finalize_assistant",
              id: ev.message_id,
              status: "done",
              partial: ev.partial,
            });
            // The SSE stream emits tool_call_start/done but NOT result payloads
            // (would bloat the wire). The route's finally block persists
            // tool_calls to the DB just before emitting `done`. Pull them back
            // here so inline proposal cards (propose_plan, propose_block,
            // propose_week_plan) render on the freshly-finalized message
            // without forcing a page reload.
            const finalizedId = ev.message_id;
            void (async () => {
              try {
                const r = await fetch(`/api/chat/messages?limit=3&kind=coach`);
                const j = (await r.json()) as { ok: boolean; messages?: ChatMessage[] };
                if (j.ok && j.messages) {
                  const fresh = j.messages.find((m) => m.id === finalizedId);
                  if (fresh) {
                    dispatch({
                      type: "patch_message",
                      id: finalizedId,
                      patch: {
                        tool_calls: fresh.tool_calls ?? null,
                        ui: fresh.ui ?? null,
                        content: fresh.content,
                      },
                    });
                  }
                }
              } catch {
                // Best-effort: card stays hidden until user reloads. Not blocking.
              }
            })();
          } else if (ev.type === "error") {
            // Two cases: 409 in-flight (no stub created), or mid-stream error.
            if (ev.message === "in_flight_stream") {
              dispatch({
                type: "wait",
                message: "Another tab is replying — waiting…",
              });
              dispatch({ type: "remove_temp_user", tempId });
              // Poll until in-flight clears.
              await pollUntilNoStreaming();
              dispatch({ type: "wait", message: null });
              // Recursive retry once.
              return send(content, imageIds);
            }
            if (assistantStubAdded && currentId) {
              dispatch({
                type: "finalize_assistant",
                id: currentId,
                status: "error",
                error: ev.message,
              });
            }
          }
        }
      } catch (e) {
        if ((e as Error).name !== "AbortError" && assistantStubAdded && currentId) {
          dispatch({
            type: "finalize_assistant",
            id: currentId,
            status: "error",
            error: (e as Error).message,
          });
        }
      } finally {
        abortRef.current = null;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mode, draftDocId],
  );

  const onRetry = useCallback(
    (errorMessageId: string) => {
      // Find the user message immediately preceding this error message and
      // re-send it.
      const idx = state.messages.findIndex((m) => m.id === errorMessageId);
      if (idx <= 0) return;
      const prev = state.messages[idx - 1];
      if (prev.role !== "user") return;
      void send(prev.content, []);
    },
    [state.messages, send],
  );

  // ── Morning intake hooks & handlers ─────────────────────────────────────────

  const queryClient = useQueryClient();
  const today = todayInUserTz();

  const { data: todayCheckin } = useCheckin(userId, today);

  // Only fetch the daily log on demand (when in morning_intake mode and we
  // might need to detect WHOOP recovery arrival).
  const todayLogQuery = useDailyLogs(userId, today, today, {
    enabled: currentMode === "morning_intake",
    refetchInterval:
      todayCheckin?.intake_state === "awaiting_whoop" ? 5 * 60 * 1000 : false,
  });

  const runRecommendation = useCallback(
    async (body: { skip_whoop: boolean }) => {
      const tempId = `stub-${crypto.randomUUID()}`;
      dispatch({ type: "append_assistant_stub", id: tempId });
      let parkedSilently = false;
      try {
        const res = await fetch("/api/chat/morning/recommendation", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        if (res.status === 425) {
          // awaiting_whoop — recommendation can't be delivered yet.
          // Remove the placeholder stub and refetch so the server-inserted
          // SYNC_WHOOP_PROMPT turn appears.
          parkedSilently = true;
          dispatch({ type: "remove_id", id: tempId });
        } else if (!res.ok) {
          const json = await res.json().catch(() => ({} as { reason?: string; message?: unknown }));
          const reason = (json as { reason?: string }).reason ?? "unknown";

          if (reason === "already_delivered" && (json as { message?: unknown }).message) {
            // 409 already_delivered with message payload: render the existing brief.
            dispatch({ type: "remove_id", id: tempId });
            dispatch({
              type: "add_message",
              message: (json as { message: ChatMessage }).message,
            });
          } else if (reason === "brief_failed") {
            // 500 brief_failed — remove placeholder; retry chip surfaces via the
            // existing morning intake polling layer when intake_state='brief_failed'.
            dispatch({ type: "remove_id", id: tempId });
          } else {
            // Other failures: surface a generic error bubble (existing pattern).
            dispatch({ type: "finalize_assistant", id: tempId, status: "error" });
          }
        } else {
          // 200 success: add the returned message to local state directly.
          const json = (await res.json()) as { ok: true; message: ChatMessage };
          dispatch({ type: "remove_id", id: tempId });
          dispatch({ type: "add_message", message: json.message });
        }
      } catch (e) {
        dispatch({ type: "finalize_assistant", id: tempId, status: "error", error: String(e) });
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.checkin.one(userId, today) });

      if (parkedSilently) {
        // Refetch so the server-inserted SYNC_WHOOP_PROMPT turn appears.
        const refresh = await fetch(`/api/chat/messages?limit=50&kind=${currentMode}`);
        const histJson = (await refresh.json()) as { ok: boolean; messages?: ChatMessage[] };
        if (histJson.ok && histJson.messages) {
          dispatch({
            type: "loaded",
            messages: scopeForMode(histJson.messages.slice().reverse(), currentMode, today),
          });
        }
      }
    },
    [queryClient, today, userId, currentMode],
  );

  const sendMorningFreeText = useCallback(
    async (value: string) => {
      const trimmed = value.trim();

      // Optimistic local user message
      const tempUserId = `tmp-${crypto.randomUUID()}`;
      dispatch({
        type: "append_user",
        message: {
          id: tempUserId,
          role: "user",
          content: trimmed,
          status: "done",
          error: null,
          model: null,
          kind: "morning_intake",
          ui: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          images: [],
        },
      });

      // Optimistic local assistant stub for streaming
      const tempAssistantId = `stub-${crypto.randomUUID()}`;
      dispatch({ type: "append_assistant_stub", id: tempAssistantId });

      let serverAssistantId: string | null = null;
      try {
        for await (const ev of postSse("/api/chat/morning/intake", {
          kind: "free_text",
          value: trimmed,
        })) {
          if (ev.type === "delta") {
            dispatch({ type: "append_delta", id: tempAssistantId, text: ev.text });
          } else if (ev.type === "done") {
            serverAssistantId = ev.message_id;
            dispatch({ type: "replace_id", tempId: tempAssistantId, serverId: ev.message_id });
            dispatch({ type: "finalize_assistant", id: ev.message_id, status: "done" });
          } else if (ev.type === "error") {
            dispatch({
              type: "finalize_assistant",
              id: serverAssistantId ?? tempAssistantId,
              status: "error",
              error: ev.message,
            });
          }
        }
      } catch (e) {
        dispatch({
          type: "finalize_assistant",
          id: serverAssistantId ?? tempAssistantId,
          status: "error",
          error: String(e),
        });
      }

      // Invalidate so the auto-fire effect picks up intake_state='awaiting_whoop'
      queryClient.invalidateQueries({ queryKey: queryKeys.checkin.one(userId, today) });

      // Refetch the thread so the parked WHOOP-sync turn (or any other server-inserted
      // assistant turns) shows up.
      const refresh = await fetch(`/api/chat/messages?limit=50&kind=${currentMode}`);
      const histJson = (await refresh.json()) as { ok: boolean; messages?: ChatMessage[] };
      if (histJson.ok && histJson.messages) {
        dispatch({
          type: "loaded",
          messages: scopeForMode(histJson.messages.slice().reverse(), currentMode, today),
        });
      }
    },
    [queryClient, userId, today, currentMode],
  );

  // Fix 1: In-flight guard — prevents duplicate recommendation streams while
  // intake_state is still transitioning from awaiting_whoop to delivered.
  const tryRunRecommendation = useCallback(
    async (body: { skip_whoop: boolean }) => {
      if (recommendationRunningRef.current) return;
      recommendationRunningRef.current = true;
      try {
        await runRecommendation(body);
      } finally {
        recommendationRunningRef.current = false;
      }
    },
    [runRecommendation],
  );

  // Fix 2: Reset startFiredRef when currentMode changes so re-entering morning_intake
  // mode after visiting coach can start a fresh session.
  useEffect(() => {
    startFiredRef.current = false;
  }, [currentMode]);

  // When morning intake mode mounts and there are no messages yet, kick off
  // /start so the bot inserts the first scripted question.
  // startFiredRef prevents re-firing if the POST succeeds but the subsequent
  // thread refetch fails (messages.length stays 0 but we must not retry).
  useEffect(() => {
    if (currentMode !== "morning_intake") return;
    if (!state.loaded) return;
    if (state.messages.length > 0) return;
    if (startFiredRef.current) return;
    startFiredRef.current = true;
    void (async () => {
      try {
        const res = await fetch("/api/chat/morning/intake", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "start" }),
        });
        if (res.ok) {
          const refresh = await fetch(`/api/chat/messages?limit=50&kind=${currentMode}`);
          const json = (await refresh.json()) as { ok: boolean; messages?: ChatMessage[] };
          if (json.ok && json.messages) {
            dispatch({
            type: "loaded",
            messages: scopeForMode(json.messages.slice().reverse(), currentMode, today),
          });
          }
        }
      } catch {
        // Refetch may fail; the ref-based guard prevents re-fire from this hook.
        // User can close + reopen the panel to retry.
      }
    })();
  }, [currentMode, state.loaded, state.messages.length]);

  // When the coach intake mode (mode='intake') is opened, auto-send a
  // starter user turn so the AI surfaces Beat 1 per INTAKE_PROMPT. Without
  // this kickoff the chat sits empty — there's no state-machine driver on
  // the coach lane (unlike morning intake which has its own kickoff hook).
  //
  // The naive guard `state.messages.length > 0` doesn't work because the
  // chat panel loads the last 50 coach messages, so any prior coach activity
  // would skip the kickoff. Real guard: only skip if the very last loaded
  // message is itself a recent intake-mode turn (the user is resuming an
  // in-flight intake conversation).
  useEffect(() => {
    if (currentMode !== "coach") return;
    if (mode !== "intake") return;
    if (!state.loaded) return;
    if (intakeStartFiredRef.current) return;
    if (!draftDocId) return;

    // If the most recent loaded message is a recent intake-mode turn,
    // treat as resume — let the user type to continue.
    const last = state.messages[state.messages.length - 1];
    const RESUME_WINDOW_MS = 24 * 60 * 60 * 1000;
    const isResume =
      last &&
      last.mode === "intake" &&
      Date.now() - new Date(last.created_at).getTime() < RESUME_WINDOW_MS;
    if (isResume) return;

    intakeStartFiredRef.current = true;
    void send("Let's start.", []);
  }, [currentMode, mode, state.loaded, state.messages, draftDocId, send]);

  const onSlotAnswer = useCallback(
    async (slot: string, value: string | number | string[]) => {
      const res = await fetch("/api/chat/morning/intake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slot, value }),
      });
      void res; // Refetch the thread regardless of status — server may have inserted assistant turns
      const refresh = await fetch(`/api/chat/messages?limit=50&kind=${currentMode}`);
      const histJson = (await refresh.json()) as { ok: boolean; messages?: ChatMessage[] };
      if (histJson.ok && histJson.messages) {
        dispatch({
          type: "loaded",
          messages: scopeForMode(histJson.messages.slice().reverse(), currentMode, today),
        });
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.checkin.one(userId, today) });
    },
    [currentMode, queryClient, today, userId],
  );

  const onAction = useCallback(
    async (action: "whoop_sync" | "skip_whoop" | "retry_recommendation" | "retry_brief") => {
      if (action === "retry_brief") {
        const tempId = `stub-${crypto.randomUUID()}`;
        dispatch({ type: "append_assistant_stub", id: tempId });
        try {
          const res = await fetch("/api/chat/morning/retry-brief", { method: "POST" });
          dispatch({ type: "remove_id", id: tempId });
          if (res.ok) {
            const json = (await res.json()) as { ok: true; message: ChatMessage };
            dispatch({ type: "add_message", message: json.message });
          } else {
            const errorId = `err-${crypto.randomUUID()}`;
            dispatch({ type: "append_assistant_stub", id: errorId });
            dispatch({ type: "finalize_assistant", id: errorId, status: "error", error: "Retry failed — please try again." });
          }
        } catch (e) {
          dispatch({ type: "remove_id", id: tempId });
          const errorId = `err-${crypto.randomUUID()}`;
          dispatch({ type: "append_assistant_stub", id: errorId });
          dispatch({ type: "finalize_assistant", id: errorId, status: "error", error: String(e) });
        }
        queryClient.invalidateQueries({ queryKey: queryKeys.checkin.one(userId, today) });
        return;
      }
      if (action === "whoop_sync") {
        try {
          const res = await fetch("/api/whoop/sync", { method: "GET" });
          if (!res.ok) throw new Error(`http_${res.status}`);
          await queryClient.invalidateQueries({
            queryKey: queryKeys.dailyLogs.range(userId, today, today),
          });
          // Fix 1: use tryRunRecommendation to guard against double-fire.
          await tryRunRecommendation({ skip_whoop: false });
        } catch (e) {
          // Fix 3: dispatch a client-only error message instead of POSTing
          // free_text, which would corrupt feel_notes and re-transition the
          // state machine, compounding the awaiting_whoop loop.
          const errorId = `err-${crypto.randomUUID()}`;
          dispatch({ type: "append_assistant_stub", id: errorId });
          dispatch({
            type: "finalize_assistant",
            id: errorId,
            status: "error",
            error: `WHOOP sync failed: ${String(e)}. Tap "Try again" or "Skip" below.`,
          });
        }
        return;
      }
      if (action === "skip_whoop") {
        // Fix 1: use tryRunRecommendation to guard against double-fire.
        await tryRunRecommendation({ skip_whoop: true });
        return;
      }
      if (action === "retry_recommendation") {
        // Fix 1: use tryRunRecommendation to guard against double-fire.
        await tryRunRecommendation({ skip_whoop: false });
        return;
      }
    },
    [queryClient, today, userId, tryRunRecommendation],
  );

  // Auto-fire recommendation when state transitions to awaiting_whoop and
  // today's log has recovery (cron arrived in background, or sync just landed).
  // Fix 1: tryRunRecommendation guards against re-fire while intake_state is
  // still transitioning from awaiting_whoop to delivered.
  useEffect(() => {
    if (currentMode !== "morning_intake") return;
    if (todayCheckin?.intake_state !== "awaiting_whoop") return;
    const log = todayLogQuery.data?.[0];
    if (!log || log.recovery == null) return;
    void tryRunRecommendation({ skip_whoop: false });
  }, [currentMode, todayCheckin?.intake_state, todayLogQuery.data, tryRunRecommendation]);

  // ── Render ───────────────────────────────────────────────────────────────────

  const composerPlaceholder =
    composerHint ??
    (mode === "plan_week"
      ? "Tell the coach how you're feeling…"
      : mode === "setup_block"
        ? "What do you want to focus on this block?"
        : mode === "intake"
          ? "Talk through your plan…"
          : undefined);

  return (
    <div
      ref={panelRef}
      className="fixed inset-0 z-50 flex flex-col bg-[#080e1a] sm:left-auto sm:right-4 sm:top-4 sm:bottom-4 sm:w-[420px] sm:rounded-2xl sm:border sm:border-white/10 sm:shadow-2xl"
      style={{
        height: "100svh",
        maxHeight: "-webkit-fill-available" as unknown as string,
      }}
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06]">
        <div style={{ display: "flex", gap: "4px", padding: "4px 0 0" }}>
          {(["coach", "morning_intake"] as const).map((m) => {
            const label = m === "coach" ? "Coach" : "Morning";
            const active = currentMode === m;
            return (
              <button
                key={m}
                type="button"
                onClick={() => setCurrentMode(m)}
                style={{
                  padding: "6px 14px",
                  borderRadius: "999px",
                  background: active ? COLOR.accentSoft : "transparent",
                  color: active ? COLOR.accent : COLOR.textMid,
                  border: "none",
                  fontSize: "12px",
                  fontWeight: active ? 700 : 500,
                  cursor: "pointer",
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-white/60 hover:text-white text-lg leading-none w-8 h-8 flex items-center justify-center"
          aria-label="Close chat"
        >
          ×
        </button>
      </div>

      <ModeBanner
        mode={mode}
        context={initialModeContext}
        onExit={() => setMode("default")}
      />

      {!state.loaded && (
        <div className="flex-1 flex items-center justify-center text-white/30 text-sm">
          loading…
        </div>
      )}
      {state.loaded && (
        <ChatThread
          userId={userId}
          messages={state.messages}
          onLoadOlder={loadOlder}
          onRetry={onRetry}
          onSendUserMessage={(text) => void send(text, [])}
          onFocusComposer={(p) => setComposerHint(p)}
        />
      )}

      {state.inFlightWaitMessage && (
        <div className="px-4 py-2 text-[11px] text-amber-300/80 border-t border-white/[0.06]">
          {state.inFlightWaitMessage}
        </div>
      )}

      {currentMode === "morning_intake" && (() => {
        const last = state.messages[state.messages.length - 1];
        if (!last || last.role !== "assistant" || last.status !== "done") return null;
        if (!last.ui || !last.ui.chips || last.ui.chips.length === 0) return null;
        // Fix 4: key by last.id so the multi-select Set state remounts fresh on
        // each prompt transition, preventing stale selections carrying over.
        return (
          <ChatChips
            key={last.id}
            ui={last.ui}
            onSlotAnswer={onSlotAnswer}
            onAction={onAction}
          />
        );
      })()}

      {(() => {
        const last = state.messages[state.messages.length - 1];
        const hideComposer =
          currentMode === "morning_intake" &&
          !!last?.ui?.chips &&
          last.ui.chips.length > 0 &&
          !last.ui.allow_text;
        if (hideComposer) return null;

        // Morning intake: text submissions during allow_text turns route to the
        // intake state machine, not the free-form coach endpoint.
        const isMorningTextTurn =
          currentMode === "morning_intake" &&
          last?.role === "assistant" &&
          last?.ui?.allow_text === true;

        return (
          <ChatComposer
            disabled={state.inFlightAssistantId !== null}
            onSend={isMorningTextTurn ? (content) => sendMorningFreeText(content) : send}
            placeholder={currentMode === "coach" ? composerPlaceholder : undefined}
          />
        );
      })()}

      {currentMode === "morning_intake" && !todayCheckin?.sick && (
        <div style={{ padding: "8px 14px 10px", textAlign: "center" }}>
          <button
            type="button"
            disabled={sickInFlight}
            onClick={async () => {
              if (sickInFlight) return;
              const ok = window.confirm(
                "Flag yourself as sick? This locks today's plan to REST. (Undo on the Log page.)",
              );
              if (!ok) return;
              setSickInFlight(true);
              try {
                const res = await fetch("/api/chat/morning/intake", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ kind: "declare_sick" }),
                });
                if (res.ok) {
                  const refresh = await fetch(`/api/chat/messages?limit=50&kind=${currentMode}`);
                  const json = (await refresh.json()) as { ok: boolean; messages?: ChatMessage[] };
                  if (json.ok && json.messages) {
                    dispatch({
            type: "loaded",
            messages: scopeForMode(json.messages.slice().reverse(), currentMode, today),
          });
                  }
                  queryClient.invalidateQueries({ queryKey: queryKeys.checkin.one(userId, today) });
                } else {
                  // Surface the error inline so the user has feedback.
                  const errorId = `err-${crypto.randomUUID()}`;
                  dispatch({ type: "append_assistant_stub", id: errorId });
                  dispatch({
                    type: "finalize_assistant",
                    id: errorId,
                    status: "error",
                    error: `Couldn't flag sickness: HTTP ${res.status}`,
                  });
                }
              } catch (e) {
                const errorId = `err-${crypto.randomUUID()}`;
                dispatch({ type: "append_assistant_stub", id: errorId });
                dispatch({
                  type: "finalize_assistant",
                  id: errorId,
                  status: "error",
                  error: `Couldn't flag sickness: ${String(e)}`,
                });
              } finally {
                setSickInFlight(false);
              }
            }}
            style={{
              background: "none",
              border: "none",
              color: COLOR.textFaint,
              fontSize: "11px",
              textDecoration: "underline",
              cursor: sickInFlight ? "default" : "pointer",
              opacity: sickInFlight ? 0.5 : 1,
            }}
          >
            I&apos;m coming down with something
          </button>
        </div>
      )}
    </div>
  );
}

async function pollUntilNoStreaming(intervalMs = 1500, maxMs = 90_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const res = await fetch("/api/chat/messages?limit=1");
    const json = (await res.json()) as { ok: boolean; messages?: { status: string }[] };
    if (json.ok && json.messages && json.messages.length > 0 && json.messages[0].status !== "streaming") {
      return;
    }
  }
}
