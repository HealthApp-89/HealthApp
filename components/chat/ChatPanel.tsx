// components/chat/ChatPanel.tsx
"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ChatMessage } from "@/lib/chat/types";
import type { ChatMode, MorningBriefCard, MorningUI, Speaker } from "@/lib/data/types";
import { ChatThread } from "./ChatThread";
import { ChatComposer } from "./ChatComposer";
import { ModeBanner } from "./ModeBanner";
import { postSse } from "./sseClient";
import { ChatChips } from "./ChatChips";
import { ComposerSuggestionChips } from "./ComposerSuggestionChips";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { useDailyLogs } from "@/lib/query/hooks/useDailyLogs";
import { useCheckin } from "@/lib/query/hooks/useCheckin";
import { todayInUserTz, ymdInUserTz } from "@/lib/time";
import { COLOR } from "@/lib/ui/theme";

/** Coach / Morning kind toggle. URL-driven (`?kind=morning_intake`) so refresh
 *  preserves the user's choice and MorningTrigger can deep-link in. */
function KindChips({
  current,
  onChange,
}: {
  current: "coach" | "morning_intake";
  onChange: (k: "coach" | "morning_intake") => void;
}) {
  return (
    <div style={{ display: "flex", gap: "4px" }}>
      {(["coach", "morning_intake"] as const).map((m) => {
        const label = m === "coach" ? "Coach" : "Morning";
        const active = current === m;
        return (
          <button
            key={m}
            type="button"
            onClick={() => onChange(m)}
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
  );
}

/** Narrow `chat_messages.ui` to the chip-rendering shape used by morning
 *  intake turns. The DB column carries different jsonb shapes per `kind`
 *  (MorningUI for morning_intake, MorningBriefCard for morning_brief,
 *  WeeklyReviewCardUI for weekly_review). Returns null when the message
 *  isn't a chip-bearing intake turn. */
function morningUiOf(m: ChatMessage | undefined): MorningUI | null {
  if (!m || m.kind !== "morning_intake") return null;
  const ui = m.ui as MorningUI | null;
  return ui ?? null;
}

/** For morning_intake, scope thread to today's messages only — yesterday's
 *  morning checkin shouldn't appear in today's panel and would otherwise
 *  block the auto-start guard from firing the next-day fresh prompt.
 *  Coach mode keeps cross-day history at the dispatch layer; render-time
 *  scoping to today+yesterday lives in the render path (see scopeCoachForRender). */
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

function shiftYmd(ymd: string, days: number): string {
  const dt = new Date(ymd + "T12:00:00Z");
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** Render-time scope for the coach lane. Default view shows today + yesterday
 *  (in user TZ) so a yesterday-evening proactive nudge or last morning's brief
 *  remain accessible without dragging the full thread history into view.
 *  Anything older is hidden behind an "↑ Show N earlier messages" pill that
 *  flips `showAll` to true to reveal everything currently loaded in state. */
function scopeCoachForRender(
  messages: ChatMessage[],
  todayYmd: string,
  showAll: boolean,
): ChatMessage[] {
  if (showAll) return messages;
  const yesterdayYmd = shiftYmd(todayYmd, -1);
  return messages.filter((m) => {
    const ymd = ymdInUserTz(new Date(m.created_at));
    return ymd === todayYmd || ymd === yesterdayYmd;
  });
}

type State = {
  loaded: boolean;
  messages: ChatMessage[];
  hasMoreOlder: boolean;
  inFlightAssistantId: string | null;
  inFlightWaitMessage: string | null;
  /** True from the moment a send() begins until the assistant stream
   *  finalizes (success or error). Distinct from inFlightAssistantId,
   *  which only becomes non-null on the FIRST delta. The composer
   *  disable check ORs both so the user can't fire a second message in
   *  the (often multi-second) gap between send-start and first delta —
   *  that second message used to land 409 in_flight_stream, retry after
   *  the first stream ended, and visually land OUT OF ORDER below the
   *  reply it preceded. */
  pendingSend: boolean;
};

type Action =
  | { type: "loaded"; messages: ChatMessage[] }
  | { type: "prepend"; messages: ChatMessage[]; hasMore: boolean }
  | { type: "append_user"; message: ChatMessage }
  | { type: "append_assistant_stub"; id: string; speaker?: Speaker }
  | { type: "append_delta"; id: string; text: string }
  | { type: "finalize_assistant"; id: string; status: "done" | "error"; error?: string; partial?: boolean }
  | { type: "replace_id"; tempId: string; serverId: string }
  | { type: "remove_temp_user"; tempId: string }
  | { type: "wait"; message: string | null }
  | { type: "add_message"; message: ChatMessage }
  | { type: "remove_id"; id: string }
  | { type: "patch_message"; id: string; patch: Partial<ChatMessage> }
  | { type: "set_pending_send"; value: boolean };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "loaded":
      return { ...state, loaded: true, messages: action.messages, hasMoreOlder: action.messages.length >= 50 };
    case "prepend":
      return { ...state, messages: [...action.messages, ...state.messages], hasMoreOlder: action.hasMore };
    case "append_user":
      return { ...state, messages: [...state.messages, action.message] };
    case "append_assistant_stub": {
      // Default to peter so morning-intake / retry paths (which don't pass a
      // speaker) stay attributed to the Head Coach. Per-coach surfaces
      // (Strength/Diet/Health) pass speaker so the SpeakerChip on the
      // streaming stub matches the coach the server will stamp the DB row
      // with — otherwise the chip reads PETER until a page refetch.
      const stubSpeaker: Speaker = action.speaker ?? "peter";
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
            speaker: stubSpeaker,
            thread: stubSpeaker,
            kind: "coach" as const,
            ui: null,
            tool_calls: null,
          },
        ],
      };
    }
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
      // Idempotent — silently no-op if a message with this id is already in
      // state. Defends against the post-stream refetch (which may add a row
      // we already optimistically inserted) from creating duplicate keys.
      if (state.messages.some((m) => m.id === action.message.id)) return state;
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
    case "set_pending_send":
      return { ...state, pendingSend: action.value };
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
  embedded = false,
  thread,
}: {
  onClose?: () => void;
  /** Initial conversation lane; tab clicks at runtime override this. */
  initialKind?: "coach" | "morning_intake";
  userId: string;
  initialMode?: ChatMode;
  initialModeContext?: string;
  /** Athlete-profile draft doc id, required when initialMode='intake'.
   *  Threaded through to /api/chat/messages as body.doc so the route can
   *  inject it into the Phase 2 tool executors' ToolCtx. */
  draftDocId?: string;
  /** When true, render feed + composer in-flow (no fixed overlay chrome).
   *  Used by /coach page to host chat as a primary surface. The FAB-summoned
   *  overlay path leaves this unset and gets the legacy overlay UI. */
  embedded?: boolean;
  /** When set, scopes this chat surface to a single coach's thread.
   *  - History GET appends `&thread=${thread}` so only this coach's turns +
   *    user replies on this thread render.
   *  - Composer's speaker_override defaults to `thread`, pinning Carter /
   *    Nora / Remi / Peter as the responder regardless of the router.
   *  - Picker UI is hidden — the page IS the coach's page.
   *  When omitted (legacy /coach surface), behavior is unchanged. */
  thread?: Speaker;
}) {
  const [mode, setMode] = useState<ChatMode>(initialMode);
  const [composerHint, setComposerHint] = useState<string | undefined>(undefined);
  // Composer empty/focused state, lifted from ChatComposer via callbacks so
  // sibling UI (ComposerSuggestionChips) can render only when the composer
  // is empty and not focused.
  const [composerText, setComposerText] = useState("");
  const [composerFocused, setComposerFocused] = useState(false);
  // Composer coach-picker lock. null = Auto (router decides). Cleared
  // after each successful send via the finally block in send().
  const [lockedSpeaker, setLockedSpeaker] = useState<Speaker | null>(null);
  const [state, dispatch] = useReducer(reducer, {
    loaded: false,
    messages: [],
    hasMoreOlder: false,
    inFlightAssistantId: null,
    inFlightWaitMessage: null,
    pendingSend: false,
  });

  const [currentMode, setCurrentMode] = useState<"coach" | "morning_intake">(initialKind);
  const [sickInFlight, setSickInFlight] = useState(false);

  const router = useRouter();
  /** Kind chip click writes the URL (preserving other params) and updates
   *  internal state. Parent uses `key={initialKind}` to remount on external
   *  URL changes (e.g. MorningTrigger redirect); the local setState here
   *  covers the in-panel click path so the user sees an immediate UI swap. */
  const handleKindChange = useCallback((m: "coach" | "morning_intake") => {
    if (m === currentMode) return;
    const url = new URL(window.location.href);
    url.searchParams.set("kind", m);
    router.replace(url.pathname + "?" + url.searchParams.toString(), { scroll: false });
    setCurrentMode(m);
  }, [currentMode, router]);
  /** When false (default), the coach lane renders only today + yesterday;
   *  a pill above the thread reveals older messages on tap. Reset on every
   *  mode switch — opening the Coach tab fresh shouldn't carry over a prior
   *  expansion. */
  const [showAllCoach, setShowAllCoach] = useState(false);
  useEffect(() => {
    setShowAllCoach(false);
  }, [currentMode]);

  const panelRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const recommendationRunningRef = useRef(false);
  const startFiredRef = useRef(false);
  const intakeStartFiredRef = useRef(false);

  // Load history on mount or when currentMode / thread changes.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const threadQs = thread ? `&thread=${thread}` : "";
      const res = await fetch(`/api/chat/messages?limit=50&kind=${currentMode}${threadQs}`);
      const json = (await res.json()) as { ok: boolean; messages?: ChatMessage[] };
      if (cancelled) return;
      if (json.ok && json.messages) {
        // Server returns desc; we want asc for render.
        const asc = json.messages.slice().reverse();
        const scoped = scopeForMode(asc, currentMode, today);
        dispatch({ type: "loaded", messages: scoped });

        // Coach lane: if no coach-kind message exists for today and no special
        // mode is active, fire the opener endpoint. Skipped server-side if a
        // turn was already created today, so this is safe to call eagerly.
        if (currentMode === "coach" && mode === "default") {
          const hasCoachToday = scoped.some(
            (m) => m.kind === "coach" && ymdInUserTz(new Date(m.created_at)) === today,
          );
          if (!hasCoachToday) {
            try {
              const op = await fetch("/api/chat/coach/ensure-opener", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
              });
              if (op.ok) {
                const opJson = (await op.json()) as { ok: boolean; message?: ChatMessage; skipped?: boolean };
                if (opJson.ok && opJson.message && !cancelled) {
                  dispatch({ type: "add_message", message: opJson.message });
                }
              }
            } catch {
              // Non-fatal — the user can still send a message without the opener.
            }
          }
        }
      } else {
        dispatch({ type: "loaded", messages: [] });
      }
    })();
    return () => {
      cancelled = true;
      abortRef.current?.abort();
    };
    // `today` and `mode` intentionally not in deps — today is a render-time
    // string and mode changes shouldn't re-fetch history.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentMode, thread]);

  // iOS PWA keyboard handling: subscribe to visualViewport.resize and
  // translate the panel up by the keyboard's intrusion.
  useEffect(() => {
    const el = panelRef.current;
    if (!el || typeof window === "undefined" || !window.visualViewport || embedded) return;
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

      // Lock the composer immediately. Without this, the multi-second gap
      // between send-start and first-delta lets the user fire a second
      // message that lands 409 in_flight_stream, retries after the first
      // stream finishes, and visually appears AFTER the assistant reply it
      // was meant to precede. Pair with the finally below.
      dispatch({ type: "set_pending_send", value: true });

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
        speaker: "user" as const,
        thread: thread ?? "peter",
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
        const resolvedOverride = lockedSpeaker ?? thread;
        for await (const ev of postSse(
          "/api/chat/messages",
          {
            content,
            image_ids: imageIds,
            mode,
            doc: draftDocId,
            ...(resolvedOverride && { speaker_override: resolvedOverride }),
          },
          { signal: ac.signal },
        )) {
          if (ev.type === "delta") {
            if (!assistantStubAdded) {
              // The server already created a stub on its side. We mirror that
              // locally on first delta so streaming visualisation works.
              assistantId = `stub-${crypto.randomUUID()}`;
              currentId = assistantId;
              dispatch({ type: "append_assistant_stub", id: assistantId, speaker: resolvedOverride ?? undefined });
              assistantStubAdded = true;
            }
            dispatch({ type: "append_delta", id: assistantId!, text: ev.text });
          } else if (ev.type === "done") {
            if (!assistantStubAdded) {
              // No deltas (extremely short reply or aborted before first delta).
              assistantId = `stub-${crypto.randomUUID()}`;
              currentId = assistantId;
              dispatch({ type: "append_assistant_stub", id: assistantId, speaker: resolvedOverride ?? undefined });
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
            // tool_calls now arrive inline on the done event (saves a refetch
            // round trip for the common case). Patch the message right away so
            // proposal cards render without flash.
            const finalizedId = ev.message_id;
            const inlineToolCalls = ev.tool_calls ?? null;
            if (inlineToolCalls) {
              dispatch({
                type: "patch_message",
                id: finalizedId,
                patch: { tool_calls: inlineToolCalls },
              });
            }
            // Side-effect tools insert NEW chat_messages rows that the SSE
            // stream doesn't carry — only refetch when at least one such tool
            // was called.
            const hasSideEffectInsert = (inlineToolCalls ?? []).some(
              (c) => c.name === "regenerate_morning_brief",
            );
            if (hasSideEffectInsert) {
              void (async () => {
                try {
                  const r = await fetch(`/api/chat/messages?limit=5&kind=coach`);
                  const j = (await r.json()) as { ok: boolean; messages?: ChatMessage[] };
                  if (j.ok && j.messages) {
                    const fresh = j.messages.find((m) => m.id === finalizedId);
                    const finalizedAt = fresh?.created_at ?? null;
                    const sinceMs = finalizedAt
                      ? new Date(finalizedAt).getTime() - 5000
                      : Date.now() - 60_000;
                    for (const m of j.messages) {
                      if (m.id === finalizedId) continue;
                      if (state.messages.some((existing) => existing.id === m.id)) continue;
                      if (new Date(m.created_at).getTime() < sinceMs) continue;
                      dispatch({ type: "add_message", message: m });
                    }
                  }
                } catch {
                  // Best-effort.
                }
              })();
            }
          } else if (ev.type === "handoff") {
            // Peter delegated to a specialist. The server resets its own
            // accumulated buffer to "" so only the specialist's reply is
            // persisted; mirror that here: swap the in-flight stub's speaker
            // and blank its content. ChatThread will then render a
            // HandoffLine between Peter's prior turn (if any) and the
            // freshly-swapped stub, and the SpeakerChip flips to the
            // specialist's name as deltas resume. Briefing prose is
            // displayed only live — replayed history (which doesn't carry
            // this event) renders HandoffLine with briefing=null.
            if (assistantStubAdded && assistantId) {
              dispatch({
                type: "patch_message",
                id: assistantId,
                patch: { speaker: ev.to, content: "" },
              });
            }
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
        dispatch({ type: "set_pending_send", value: false });
        // Auto-clear the picker lock after each send so subsequent messages
        // default to auto-routing again.
        setLockedSpeaker(null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mode, draftDocId, lockedSpeaker, thread],
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
      let parkedSilently = false;
      // Hold the deterministic card in a closure so each advice_delta can
      // patch the message's ui with the latest accumulated advice text.
      let card: MorningBriefCard | null = null;
      let advice = "";

      try {
        const res = await fetch("/api/chat/morning/recommendation", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        const isSse = (res.headers.get("content-type") ?? "").startsWith("text/event-stream");
        if (!isSse) {
          // Pre-flight gate failed (425 / 409 / unauthorized). Branch on reason.
          const json = await res.json().catch(() => ({} as { reason?: string; message?: unknown }));
          const reason = (json as { reason?: string }).reason ?? "unknown";

          if (res.status === 425) {
            // awaiting_whoop — refetch to surface the SYNC_WHOOP_PROMPT turn.
            parkedSilently = true;
          } else if (reason === "already_delivered" && (json as { message?: unknown }).message) {
            dispatch({ type: "add_message", message: (json as { message: ChatMessage }).message });
          } else if (reason === "brief_failed") {
            // Retry chip will surface via the morning intake polling layer.
          } else if (!res.ok) {
            dispatch({ type: "append_assistant_stub", id: tempId });
            dispatch({ type: "finalize_assistant", id: tempId, status: "error" });
          }
          queryClient.invalidateQueries({ queryKey: queryKeys.checkin.one(userId, today) });
          if (parkedSilently) {
            const refresh = await fetch(`/api/chat/messages?limit=50&kind=${currentMode}`);
            const histJson = (await refresh.json()) as { ok: boolean; messages?: ChatMessage[] };
            if (histJson.ok && histJson.messages) {
              dispatch({
                type: "loaded",
                messages: scopeForMode(histJson.messages.slice().reverse(), currentMode, today),
              });
            }
          }
          return;
        }

        // SSE streaming success path: consume frames inline so we have direct
        // access to the brief_card event (postSse drops it through unrecognised
        // pathways otherwise — but our extended ChatStreamEvent now carries it).
        if (!res.body) {
          dispatch({ type: "append_assistant_stub", id: tempId });
          dispatch({ type: "finalize_assistant", id: tempId, status: "error", error: "no body" });
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let done = false;
        while (!done) {
          const r = await reader.read();
          if (r.done) break;
          buf += decoder.decode(r.value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) !== -1) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            let eventName = "";
            let dataLine = "";
            for (const line of frame.split("\n")) {
              if (line.startsWith("event:")) eventName = line.slice(6).trim();
              else if (line.startsWith("data:")) dataLine = line.slice(5).trim();
            }
            if (!dataLine) continue;
            let data: unknown;
            try {
              data = JSON.parse(dataLine);
            } catch {
              // Malformed frame (e.g. proxy keep-alive comment, truncated
              // chunk that won't reassemble). Skip rather than crash the loop.
              continue;
            }
            const d = data as Record<string, unknown>;
            if (eventName === "brief_card") {
              card = d.card as MorningBriefCard;
              dispatch({
                type: "add_message",
                message: {
                  id: tempId,
                  role: "assistant",
                  content: "",
                  status: "streaming",
                  error: null,
                  model: null,
                  speaker: "peter" as const,
                  thread: thread ?? "peter",
                  kind: "morning_brief",
                  ui: { ...card, advice_md: "" },
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                  images: [],
                  tool_calls: null,
                },
              });
            } else if (eventName === "delta") {
              if (!card) continue;
              advice += d.text as string;
              dispatch({
                type: "patch_message",
                id: tempId,
                patch: { ui: { ...card, advice_md: advice } },
              });
            } else if (eventName === "done") {
              if (card) {
                dispatch({ type: "replace_id", tempId, serverId: d.message_id as string });
                dispatch({
                  type: "patch_message",
                  id: d.message_id as string,
                  patch: { status: "done", ui: { ...card, advice_md: advice } },
                });
              }
              done = true;
            } else if (eventName === "error") {
              dispatch({ type: "remove_id", id: tempId });
              done = true;
            }
          }
        }
      } catch (e) {
        dispatch({ type: "finalize_assistant", id: tempId, status: "error", error: String(e) });
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.checkin.one(userId, today) });
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
          speaker: "user" as const,
          thread: thread ?? "peter",
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

  // Render-time scope for the coach lane (today + yesterday by default).
  // Computed inline so the toggle is instant — no refetch — and so
  // morning_intake mode (already scoped at dispatch) is unaffected.
  //
  // useMemo'd to preserve array identity across keystrokes: ChatPanel
  // re-renders on every composerText change (sibling chip visibility gating).
  // Without memoization, scopeCoachForRender() returns a fresh array
  // reference every render → ChatThread's messages prop changes → its
  // children deep-re-render → with cards (MorningBriefCard, WeeklyReviewCard,
  // etc.) this manifests as multi-second typing lag.
  const renderedMessages = useMemo(
    () =>
      currentMode === "coach"
        ? scopeCoachForRender(state.messages, today, showAllCoach)
        : state.messages,
    [currentMode, state.messages, today, showAllCoach],
  );
  const hiddenEarlierCount = state.messages.length - renderedMessages.length;

  // Stable callbacks for the memoized ChatThread. Inline arrows here would
  // create a new ref every render and bypass React.memo entirely.
  const handleSendUserMessageFromThread = useCallback(
    (text: string) => {
      void send(text, []);
    },
    [send],
  );
  const handleFocusComposerFromThread = useCallback((p: string) => {
    setComposerHint(p);
  }, []);
  const handleStop = useCallback(() => {
    abortRef.current?.abort();
  }, []);
  const showEarlierPill =
    currentMode === "coach" && !showAllCoach && hiddenEarlierCount > 0;

  // Embedded mode: render feed + composer in-flow (no overlay chrome).
  // Used by /coach. FAB-summoned overlay path falls through to the legacy
  // return below.
  if (embedded) {
    return (
      <div
        ref={panelRef}
        style={{
          display: "flex",
          flexDirection: "column",
          flex: 1,
          minHeight: 0,
        }}
      >
        {(!thread || thread === "remi") && (
          <div style={{ padding: "0 12px 8px" }}>
            <KindChips current={currentMode} onChange={handleKindChange} />
          </div>
        )}
        <ModeBanner
          mode={mode}
          context={initialModeContext}
          onExit={() => setMode("default")}
        />

        {!state.loaded && (
          <div
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: COLOR.textMuted,
              fontSize: 13,
            }}
          >
            loading…
          </div>
        )}
        {showEarlierPill && (
          <ShowEarlierPill
            hiddenCount={hiddenEarlierCount}
            onShow={() => setShowAllCoach(true)}
          />
        )}
        {state.loaded && (
          // No overflowY here — ChatThread's inner div owns the scroll
          // surface (it manages auto-scroll-to-bottom via scrollRef). Nesting
          // two scroll containers fought each other and broke the auto-scroll.
          <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
            <ChatThread
              userId={userId}
              messages={renderedMessages}
              onLoadOlder={loadOlder}
              onRetry={onRetry}
              onSendUserMessage={handleSendUserMessageFromThread}
              onFocusComposer={handleFocusComposerFromThread}
            />
          </div>
        )}

        {state.inFlightWaitMessage && (
          <div
            style={{
              padding: "8px 14px",
              fontSize: 11,
              color: COLOR.warning,
              borderTop: `1px solid ${COLOR.divider}`,
              background: COLOR.warningSoft,
            }}
          >
            {state.inFlightWaitMessage}
          </div>
        )}

        {currentMode === "morning_intake" &&
          (() => {
            const last = state.messages[state.messages.length - 1];
            if (!last || last.role !== "assistant" || last.status !== "done") return null;
            const morningUi = morningUiOf(last);
            if (!morningUi || !morningUi.chips || morningUi.chips.length === 0) return null;
            return (
              <ChatChips
                key={last.id}
                ui={morningUi}
                onSlotAnswer={onSlotAnswer}
                onAction={onAction}
              />
            );
          })()}

        {(() => {
          const last = state.messages[state.messages.length - 1];
          const morningUi = morningUiOf(last);
          const hideComposer =
            currentMode === "morning_intake" &&
            !!morningUi?.chips &&
            morningUi.chips.length > 0 &&
            !morningUi.allow_text;
          if (hideComposer) return null;

          const isMorningTextTurn =
            currentMode === "morning_intake" &&
            last?.role === "assistant" &&
            morningUi?.allow_text === true;

          // Suggestion chips visible only on the coach lane in default chat
          // mode, when the composer is empty and unfocused. The chips
          // prefill+submit through the same send() callback the composer's
          // send button uses, so all standard guards (inFlightAssistantId,
          // optimistic dispatch, /api/chat/messages) apply unchanged.
          const showSuggestionChips =
            currentMode === "coach" &&
            mode === "default" &&
            !composerText &&
            !composerFocused;

          return (
            <>
              {showSuggestionChips && (
                <ComposerSuggestionChips
                  userId={userId}
                  todayDate={today}
                  onPrefillAndSubmit={(text) => {
                    // Reset focus state — the chip submission programmatically
                    // sends without going through the textarea, so the
                    // textarea's onBlur may not fire reliably when the chip
                    // button steals focus. Reset proactively so chips reappear
                    // after inFlightAssistantId clears.
                    setComposerFocused(false);
                    void send(text, []);
                  }}
                />
              )}
              <ChatComposer
                disabled={state.inFlightAssistantId !== null || state.pendingSend}
                onSend={isMorningTextTurn ? (content) => sendMorningFreeText(content) : send}
                placeholder={currentMode === "coach" ? composerPlaceholder : undefined}
                onTextChange={setComposerText}
                onFocus={() => setComposerFocused(true)}
                onBlur={() => setComposerFocused(false)}
                streaming={state.inFlightAssistantId !== null}
                onStop={handleStop}
                lockedSpeaker={lockedSpeaker}
                onLockChange={setLockedSpeaker}
                showPicker={!thread && currentMode === "coach" && mode !== "intake" && mode !== "setup_block"}
              />
            </>
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
        <KindChips current={currentMode} onChange={handleKindChange} />
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
      {showEarlierPill && (
        <ShowEarlierPill
          hiddenCount={hiddenEarlierCount}
          onShow={() => setShowAllCoach(true)}
        />
      )}
      {state.loaded && (
        <ChatThread
          userId={userId}
          messages={renderedMessages}
          onLoadOlder={loadOlder}
          onRetry={onRetry}
          onSendUserMessage={handleSendUserMessageFromThread}
          onFocusComposer={handleFocusComposerFromThread}
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
        const morningUi = morningUiOf(last);
        if (!morningUi || !morningUi.chips || morningUi.chips.length === 0) return null;
        // Fix 4: key by last.id so the multi-select Set state remounts fresh on
        // each prompt transition, preventing stale selections carrying over.
        return (
          <ChatChips
            key={last.id}
            ui={morningUi}
            onSlotAnswer={onSlotAnswer}
            onAction={onAction}
          />
        );
      })()}

      {(() => {
        const last = state.messages[state.messages.length - 1];
        const morningUi = morningUiOf(last);
        const hideComposer =
          currentMode === "morning_intake" &&
          !!morningUi?.chips &&
          morningUi.chips.length > 0 &&
          !morningUi.allow_text;
        if (hideComposer) return null;

        // Morning intake: text submissions during allow_text turns route to the
        // intake state machine, not the free-form coach endpoint.
        const isMorningTextTurn =
          currentMode === "morning_intake" &&
          last?.role === "assistant" &&
          morningUi?.allow_text === true;

        return (
          <ChatComposer
            disabled={state.inFlightAssistantId !== null || state.pendingSend}
            onSend={isMorningTextTurn ? (content) => sendMorningFreeText(content) : send}
            placeholder={currentMode === "coach" ? composerPlaceholder : undefined}
            streaming={state.inFlightAssistantId !== null}
            onStop={() => abortRef.current?.abort()}
            lockedSpeaker={lockedSpeaker}
            onLockChange={setLockedSpeaker}
            showPicker={!thread && currentMode === "coach" && mode !== "intake" && mode !== "setup_block"}
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

function ShowEarlierPill({
  hiddenCount,
  onShow,
}: {
  hiddenCount: number;
  onShow: () => void;
}) {
  const label = `↑ Show ${hiddenCount} earlier ${hiddenCount === 1 ? "message" : "messages"}`;
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "center",
        padding: "8px 12px 4px",
      }}
    >
      <button
        type="button"
        onClick={onShow}
        style={{
          background: COLOR.surfaceAlt,
          color: COLOR.textMid,
          border: "none",
          borderRadius: 9999,
          padding: "6px 14px",
          fontSize: 11,
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        {label}
      </button>
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
