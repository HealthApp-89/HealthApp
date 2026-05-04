// components/chat/ChatPanel.tsx
"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";
import type { ChatMessage } from "@/lib/chat/types";
import { ChatThread } from "./ChatThread";
import { ChatComposer } from "./ChatComposer";
import { postSse } from "./sseClient";

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
  | { type: "wait"; message: string | null };

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
    default:
      return state;
  }
}

export default function ChatPanel({ onClose }: { onClose: () => void }) {
  const [state, dispatch] = useReducer(reducer, {
    loaded: false,
    messages: [],
    hasMoreOlder: false,
    inFlightAssistantId: null,
    inFlightWaitMessage: null,
  });

  const panelRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Load history on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch("/api/chat/messages?limit=50");
      const json = (await res.json()) as { ok: boolean; messages?: ChatMessage[] };
      if (cancelled) return;
      if (json.ok && json.messages) {
        // Server returns desc; we want asc for render.
        dispatch({ type: "loaded", messages: json.messages.slice().reverse() });
      } else {
        dispatch({ type: "loaded", messages: [] });
      }
    })();
    return () => {
      cancelled = true;
      abortRef.current?.abort();
    };
  }, []);

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
    if (!state.hasMoreOlder) return { added: 0 };
    const res = await fetch(`/api/chat/messages?limit=50&before=${encodeURIComponent(beforeIso)}`);
    const json = (await res.json()) as { ok: boolean; messages?: ChatMessage[] };
    if (!json.ok || !json.messages) return { added: 0 };
    const older = json.messages.slice().reverse();
    dispatch({ type: "prepend", messages: older, hasMore: older.length >= 50 });
    return { added: older.length };
  }, [state.hasMoreOlder]);

  const send = useCallback(
    async (content: string, imageIds: string[]) => {
      // Optimistic user message.
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
          { content, image_ids: imageIds },
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
    [],
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
        <div className="text-sm font-semibold text-white/90">Coach</div>
        <button
          type="button"
          onClick={onClose}
          className="text-white/60 hover:text-white text-lg leading-none w-8 h-8 flex items-center justify-center"
          aria-label="Close chat"
        >
          ×
        </button>
      </div>

      {!state.loaded && (
        <div className="flex-1 flex items-center justify-center text-white/30 text-sm">
          loading…
        </div>
      )}
      {state.loaded && (
        <ChatThread messages={state.messages} onLoadOlder={loadOlder} onRetry={onRetry} />
      )}

      {state.inFlightWaitMessage && (
        <div className="px-4 py-2 text-[11px] text-amber-300/80 border-t border-white/[0.06]">
          {state.inFlightWaitMessage}
        </div>
      )}

      <ChatComposer disabled={state.inFlightAssistantId !== null} onSend={send} />
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
