"use client";
// components/log/MealLoggerChatTab.tsx
//
// The "CHAT" tab inside MealLoggerSheet. One Nora thread, scoped to today.
// Persistent across sheet open/close (rows live in chat_messages with
// kind='meal_log'). Composer holds text input + mic + barcode + send.
//
// Layout: chronological message feed (user / Nora text / committed chips)
// scrolls in the upper region. The most recent pending draft, if any,
// renders as a PINNED preview card right above the composer — so Nora's
// streamed clarification text always sits above-and-visible while the
// actionable card sits at the bottom where the eye lands.
//
// Composer state machine:
//   * no active draft → next send POSTs /api/food/parse (new meal entry)
//   * active draft    → next send POSTs /api/chat/messages with
//     mode=meal_log, speaker=nora, and hidden_context describing the draft.
//     The chat-route streams Nora's response over SSE; she may call
//     search_library / pick_library_item / save_to_library, which mutate
//     the draft row server-side. On tool_call_done for pick_library_item,
//     we refetch the draft so the pinned preview reflects the change.
//   * "+ New meal" pill (visible only when there's an active draft) cancels
//     the current draft and returns the composer to parse mode.
//
// Why an LLM dialog: deterministic clarification text couldn't react to
// natural replies like "the raw kind" or "save it as my breakfast staple"
// — and the three library tools wired in Task 10 (search_library,
// pick_library_item, save_to_library) only earn their keep when Nora can
// pick them based on actual conversation. hidden_context is the side-
// channel that tells Nora about the draft without leaking the briefing as
// a visible user bubble (the old /api/chat round-trip did that).

import { useEffect, useRef, useState } from "react";
import type { MealSlot, FoodLogEntry, FoodItem } from "@/lib/food/types";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { MealLoggerPreviewCard } from "./MealLoggerPreviewCard";
import { MealLoggerEditor } from "./MealLoggerEditor";

type ThreadMessage = {
  id: string;
  speaker: "user" | "nora";
  content: string;
  ui: { mode: "preview" | "committed" | "cancelled"; entry_id?: string } | null;
  created_at: string;
  draft_entry_id?: string | null;
};

/** Build the hidden_context block we feed into Nora's system prompt for a
 *  meal-log turn. Tells her which draft she's editing + per-item state so
 *  she can call pick_library_item / save_to_library with the right
 *  entry_id and item_index without having to ask the user. Never appears
 *  in the user-visible thread. */
function buildDraftContext(entry: FoodLogEntry): string {
  const lines = entry.items.map(
    (it: FoodItem, idx) =>
      `  [${idx}] ${it.name} — ${it.qty_g}g, ${Math.round(it.kcal)} kcal, confidence=${it.confidence ?? "n/a"}`,
  );
  return [
    `entry_id: ${entry.id}`,
    `meal_slot: ${entry.meal_slot}`,
    `items (${entry.items.length}):`,
    ...lines,
    "",
    "Use this entry_id when calling pick_library_item or referencing the draft.",
    "Use the bracketed item_index when calling pick_library_item.",
  ].join("\n");
}

/** Parse a single SSE event chunk into (event, data). Returns null when
 *  the chunk doesn't form a complete event yet. */
function parseSseEvent(block: string): { event: string; data: unknown } | null {
  let ev = "", dataLine = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("event: ")) ev = line.slice(7);
    else if (line.startsWith("data: ")) dataLine = line.slice(6);
  }
  if (!ev || !dataLine) return null;
  try {
    return { event: ev, data: JSON.parse(dataLine) };
  } catch {
    return null;
  }
}

type Props = {
  userId: string;
  mealSlot: MealSlot;
  eatenAt: string;
  onCommitted: () => Promise<void>;
};

export function MealLoggerChatTab({ userId, mealSlot, eatenAt, onCommitted }: Props) {
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [drafts, setDrafts] = useState<Record<string, FoodLogEntry>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  // In-flight Nora reply being streamed token-by-token. Rendered as a
  // standalone bubble at the end of the feed; cleared once the chat-route's
  // `done` event lands (the persisted row then surfaces in the next thread
  // refetch). Decoupled from `messages` so we don't double-render.
  const [streamingNora, setStreamingNora] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const supabase = createSupabaseBrowserClient();

  // Initial fetch: thread rows belonging to in-flight drafts only.
  useEffect(() => {
    const fetchThread = async () => {
      // First: get the user's active draft entry ids. Drafts are
      // food_log_entries rows with status='draft'. Cancelled drafts are
      // hard-deleted by cancelActiveDraft, so the set is naturally bounded.
      const { data: drafts, error: draftsErr } = await supabase
        .from("food_log_entries")
        .select("id, eaten_at, meal_slot, kind, items, totals, is_estimated, is_favorite, status, recipe_id")
        .eq("user_id", userId)
        .eq("status", "draft");
      if (draftsErr) {
        console.error("[chat-tab] drafts fetch failed", draftsErr);
        return;
      }
      const draftIds = (drafts ?? []).map((d) => d.id);
      if (draftIds.length === 0) {
        setMessages([]);
        setDrafts({});
        return;
      }

      const { data, error } = await supabase
        .from("chat_messages")
        .select("id, speaker, content, ui, created_at, draft_entry_id")
        .eq("user_id", userId)
        .eq("kind", "meal_log")
        .in("draft_entry_id", draftIds)
        .order("created_at", { ascending: true });
      if (error) {
        console.error("[chat-tab] thread fetch failed", error);
        return;
      }
      setMessages((data ?? []) as ThreadMessage[]);

      // Hydrate the drafts map from the rows we already fetched.
      const dict: Record<string, FoodLogEntry> = {};
      for (const e of (drafts ?? []) as unknown as FoodLogEntry[]) dict[e.id] = e;
      setDrafts(dict);
    };
    fetchThread();
  }, [userId, supabase]);

  /** Refetch a draft entry by id and merge into the drafts map. Called after
   *  Nora's tool calls (pick_library_item) mutate the row server-side so the
   *  pinned preview card re-renders with the new items/totals. */
  const refetchDraft = async (entryId: string) => {
    const { data: entries } = await supabase
      .from("food_log_entries")
      .select("id, eaten_at, meal_slot, kind, items, totals, is_estimated, is_favorite, status, recipe_id")
      .eq("id", entryId)
      .limit(1);
    const entry = (entries ?? [])[0] as unknown as FoodLogEntry | undefined;
    if (entry) setDrafts((prev) => ({ ...prev, [entry.id]: entry }));
  };

  /** Refetch thread rows belonging to in-flight drafts and merge — preserves
   *  local-only state (committed stamps written ahead of refetch) by keying on id. */
  const refetchThread = async () => {
    const { data: drafts } = await supabase
      .from("food_log_entries")
      .select("id")
      .eq("user_id", userId)
      .eq("status", "draft");
    const draftIds = (drafts ?? []).map((d) => d.id);
    if (draftIds.length === 0) {
      setMessages([]);
      return;
    }

    const { data } = await supabase
      .from("chat_messages")
      .select("id, speaker, content, ui, created_at, draft_entry_id")
      .eq("user_id", userId)
      .eq("kind", "meal_log")
      .in("draft_entry_id", draftIds)
      .order("created_at", { ascending: true });
    if (!data) return;
    setMessages((prev) => {
      const byId = new Map(prev.map((m) => [m.id, m]));
      for (const r of data as ThreadMessage[]) {
        const existing = byId.get(r.id);
        byId.set(r.id, existing?.ui?.mode === "committed" ? existing : r);
      }
      return Array.from(byId.values()).sort(
        (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
      );
    });
  };

  /** Stream a Nora reply via /api/chat/messages SSE. The chat-route writes
   *  its own user + assistant rows; we tail the stream for deltas, render
   *  them as a transient `streamingNora` bubble, watch tool_call_done events
   *  for pick_library_item (and refetch the draft when one lands), and on
   *  `done` refetch the thread + clear the streaming bubble. */
  const streamNoraReply = async (userText: string, draft: FoodLogEntry) => {
    setStreamingNora("");
    let res: Response;
    try {
      res = await fetch("/api/chat/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: userText,
          mode: "meal_log",
          speaker_override: "nora",
          hidden_context: buildDraftContext(draft),
        }),
      });
    } catch (e) {
      console.error("[meal-log] /api/chat/messages fetch threw", e);
      setStreamingNora(null);
      setMessages((prev) => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          speaker: "nora",
          content: `Network error: ${(e as Error).message}`,
          ui: null,
          created_at: new Date().toISOString(),
        },
      ]);
      return;
    }
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "");
      console.error("[meal-log] chat stream non-OK", res.status, detail);
      setStreamingNora(null);
      setMessages((prev) => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          speaker: "nora",
          content: `Nora couldn't reply (HTTP ${res.status}).`,
          ui: null,
          created_at: new Date().toISOString(),
        },
      ]);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let accumulated = "";
    let refetchedDraft = false;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE events are blank-line-terminated. Split on \n\n; keep the
      // tail (possibly an incomplete event) in the buffer.
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const block of parts) {
        const ev = parseSseEvent(block);
        if (!ev) continue;
        if (ev.event === "delta") {
          const d = ev.data as { text?: string };
          if (typeof d.text === "string") {
            accumulated += d.text;
            setStreamingNora(accumulated);
          }
        } else if (ev.event === "tool_call_done") {
          // Refetch the draft once after any successful pick_library_item or
          // save_to_library call — both can change items[] or totals. We
          // refetch lazily (once per stream) since the draft state lives in
          // a single row; multiple tool calls coalesce into one refetch.
          const d = ev.data as { ok?: boolean };
          if (d.ok && !refetchedDraft) {
            refetchedDraft = true;
            void refetchDraft(draft.id);
          }
        } else if (ev.event === "done" || ev.event === "error") {
          // Stream is finished; refetch the thread to pick up Nora's
          // persisted assistant row + the user row the chat-route wrote.
          setStreamingNora(null);
          await refetchThread();
          // Final draft refetch in case a tool call's effect landed in the
          // final round and we haven't already refetched.
          await refetchDraft(draft.id);
        }
      }
    }
    // Stream closed without a terminal event; clean up anyway.
    if (accumulated.length > 0 && streamingNora !== null) {
      setStreamingNora(null);
      await refetchThread();
    }
  };

  /** Compute the active draft inline so send() doesn't have to capture it
   *  from a closure over a render-derived value. Mirrors the same selection
   *  the render does below. */
  const findActiveDraft = (): FoodLogEntry | null => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (
        m.speaker === "nora" &&
        m.ui?.mode === "preview" &&
        m.ui.entry_id &&
        drafts[m.ui.entry_id]
      ) {
        return drafts[m.ui.entry_id];
      }
    }
    return null;
  };

  /** New-meal path: /api/food/parse → insert user bubble + preview row.
   *  Nora isn't invoked yet; if needs_clarification=true, the caller (send)
   *  follows up with streamNoraReply for her first turn. */
  const parseNewMeal = async (text: string): Promise<FoodLogEntry | null> => {
    let parseRes: Response;
    try {
      parseRes = await fetch("/api/food/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, meal_slot: mealSlot, eaten_at: eatenAt }),
      });
    } catch (e) {
      console.error("[meal-log] /api/food/parse fetch threw", e);
      setMessages((prev) => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          speaker: "nora",
          content: `Network error: ${(e as Error).message}`,
          ui: null,
          created_at: new Date().toISOString(),
        },
      ]);
      return null;
    }
    if (!parseRes.ok) {
      const detail = await parseRes.text().catch(() => "");
      console.error("[meal-log] /api/food/parse non-OK", parseRes.status, detail);
      // Surface the upstream error detail so the user can self-diagnose
      // (Haiku output bad JSON, rate-limit, Vercel timeout) without having
      // to open DevTools — diet-tab error triage 2026-05-22.
      let parsedDetail = "";
      try {
        const j = JSON.parse(detail) as { error?: string; detail?: string };
        parsedDetail = [j.error, j.detail].filter(Boolean).join(": ");
      } catch {
        parsedDetail = detail.slice(0, 160);
      }
      setMessages((prev) => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          speaker: "nora",
          content: `I couldn't read that (HTTP ${parseRes.status}).${parsedDetail ? `\n${parsedDetail}` : ""}`,
          ui: null,
          created_at: new Date().toISOString(),
        },
      ]);
      return null;
    }
    const parseJson = (await parseRes.json()) as {
      entry: FoodLogEntry;
      needs_clarification: boolean;
    };

    // Insert user bubble, then preview row. (The Nora text bubble for
    // clarification is no longer composed locally — Nora's first LLM turn
    // produces it when streamNoraReply runs.)
    const inserts: ThreadMessage[] = [];
    const { data: userRow, error: userErr } = await supabase
      .from("chat_messages")
      .insert({
        user_id: userId,
        role: "user",
        content: text,
        status: "done",
        speaker: "user",
        kind: "meal_log",
        mode: "meal_log",
        draft_entry_id: parseJson.entry.id,
        ui: null,
      })
      .select("id, speaker, content, ui, created_at")
      .single();
    if (userErr) {
      console.error("[meal-log] user insert failed", userErr);
      setMessages((prev) => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          speaker: "nora",
          content: `Couldn't save the message: ${userErr.message}`,
          ui: null,
          created_at: new Date().toISOString(),
        },
      ]);
      return null;
    }
    if (userRow) inserts.push(userRow as ThreadMessage);

    const { data: noraPreviewRow, error: noraErr } = await supabase
      .from("chat_messages")
      .insert({
        user_id: userId,
        role: "assistant",
        content: "",
        status: "done",
        speaker: "nora",
        kind: "meal_log",
        mode: "meal_log",
        draft_entry_id: parseJson.entry.id,
        ui: { mode: "preview", entry_id: parseJson.entry.id },
      })
      .select("id, speaker, content, ui, created_at")
      .single();
    if (noraErr) {
      console.error("[meal-log] preview insert failed", noraErr);
      setMessages((prev) => [
        ...prev,
        ...inserts,
        {
          id: `err-${Date.now()}`,
          speaker: "nora",
          content: `Couldn't save the preview: ${noraErr.message}`,
          ui: null,
          created_at: new Date().toISOString(),
        },
      ]);
      return null;
    }
    if (noraPreviewRow) inserts.push(noraPreviewRow as ThreadMessage);

    setMessages((prev) => [...prev, ...inserts]);
    setDrafts((prev) => ({ ...prev, [parseJson.entry.id]: parseJson.entry }));
    // Return the entry only if clarification is needed — signal to caller
    // to follow up with Nora's first LLM turn. Otherwise return null and the
    // user can act on the pinned preview directly.
    return parseJson.needs_clarification ? parseJson.entry : null;
  };

  /** Send dispatch:
   *    no active draft  → parseNewMeal()
   *    active draft     → streamNoraReply() (LLM dialog)
   *  After a new-meal parse that flagged needs_clarification, automatically
   *  trigger Nora's first LLM turn with the draft as hidden_context. */
  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      const active = findActiveDraft();
      if (active) {
        await streamNoraReply(text, active);
      } else {
        const entryNeedingChat = await parseNewMeal(text);
        if (entryNeedingChat) {
          // Nora's first LLM turn — uses the freshly-parsed draft.
          await streamNoraReply(text, entryNeedingChat);
        }
      }
      setInput("");
    } finally {
      setBusy(false);
    }
  };

  /** Explicit "start fresh" — cancels the active draft (DELETE entry,
   *  filter preview row out of the thread) so the next send goes through
   *  parseNewMeal instead of streamNoraReply. */
  const cancelActiveDraft = async () => {
    const active = findActiveDraft();
    if (!active) return;
    // Find the matching preview row in the thread so we can drop it.
    const previewMsg = [...messages].reverse().find(
      (m) =>
        m.speaker === "nora" &&
        m.ui?.mode === "preview" &&
        m.ui.entry_id === active.id,
    );
    await fetch(`/api/food/entries/${active.id}`, { method: "DELETE" }).catch(
      (e) => console.warn("[meal-log] DELETE entry failed (best-effort)", e),
    );
    if (previewMsg) {
      setMessages((prev) => prev.filter((m) => m.id !== previewMsg.id));
    }
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[active.id];
      return next;
    });
  };

  const handleVoice = async () => {
    type SpeechRecognitionInstance = {
      lang: string;
      interimResults: boolean;
      continuous: boolean;
      onresult: ((ev: { results: ArrayLike<{ 0: { transcript: string } }> }) => void) | null;
      onend: (() => void) | null;
      start: () => void;
      stop: () => void;
    };
    type SpeechWindow = Window & {
      SpeechRecognition?: new () => SpeechRecognitionInstance;
      webkitSpeechRecognition?: new () => SpeechRecognitionInstance;
    };
    const w = window as SpeechWindow;
    const SR = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!SR) {
      alert("Voice not supported on this browser.");
      return;
    }
    const rec = new SR();
    rec.lang = "en-US";
    rec.interimResults = false;
    rec.continuous = false;
    rec.onresult = (ev) => {
      const transcript = ev.results[0][0].transcript;
      setInput((prev) => (prev ? `${prev} ${transcript}` : transcript));
    };
    rec.onend = () => setRecording(false);
    rec.start();
    setRecording(true);
  };

  const handleBarcode = () => {
    // v1: no in-browser camera flow — open the existing SCAN endpoint via
    // /api/food/barcode by manual UPC entry as a fallback. Replace with a
    // camera component in a follow-up.
    const upc = prompt("Enter barcode (UPC):");
    if (!upc || !/^\d{6,14}$/.test(upc)) return;
    fetch("/api/food/barcode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ upc, qty_g: 100, meal_slot: mealSlot, eaten_at: eatenAt }),
    })
      .then((r) => r.json())
      .then((j: { entry?: FoodLogEntry }) => {
        if (!j.entry) return;
        const entry = j.entry;
        setDrafts((prev) => ({ ...prev, [entry.id]: entry }));
        supabase
          .from("chat_messages")
          .insert({
            user_id: userId,
            role: "assistant",
            content: "",
            status: "done",
            speaker: "nora",
            kind: "meal_log",
            mode: "meal_log",
          draft_entry_id: entry.id,
            ui: { mode: "preview", entry_id: entry.id },
          })
          .select("id, speaker, content, ui, created_at")
          .single()
          .then(({ data }) => {
            if (data) setMessages((prev) => [...prev, data as ThreadMessage]);
          });
      });
  };

  // Pinned-preview selection: the most recent meal_log row whose ui.mode is
  // 'preview' AND whose entry is still in our drafts map (we filter out the
  // row from the chronological feed below). When the user Confirms, the row
  // flips to ui.mode='committed' and the pinned section clears naturally.
  const activePreviewMsg = [...messages]
    .reverse()
    .find(
      (m) =>
        m.speaker === "nora" &&
        m.ui?.mode === "preview" &&
        m.ui.entry_id !== undefined &&
        drafts[m.ui.entry_id] !== undefined,
    );
  const activeDraft = activePreviewMsg?.ui?.entry_id
    ? drafts[activePreviewMsg.ui.entry_id]
    : null;

  // Auto-scroll on new messages so the latest content (and the pinned preview
  // when it appears) is visible without the user reaching for the trackpad.
  // Includes streamingNora.length so the bubble follows Nora's tokens.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, activeDraft?.id, activeDraft?.items.length, editingId, streamingNora?.length]);

  return (
    <div className="flex flex-col h-[420px] -mx-4 -mb-4">
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-4 py-2 space-y-3">
        {messages.length === 0 && (
          <div className="text-zinc-500 text-sm py-8 text-center">
            Tell Nora what you ate. She&apos;ll figure out the macros.
          </div>
        )}
        {messages.map((m) => {
          if (m.speaker === "user") {
            return (
              <div key={m.id} className="flex justify-end">
                <div className="rounded-2xl bg-blue-600 text-white px-3 py-2 text-sm max-w-[80%]">
                  {m.content}
                </div>
              </div>
            );
          }
          // nora
          // Preview rows render in the pinned section below — skip here so
          // they don't appear twice and so chronological order in the feed
          // stays user → Nora-text without a card breaking it up.
          if (m.ui?.mode === "preview") return null;
          if (m.ui?.mode === "committed") {
            return (
              <div key={m.id} className="flex">
                <div className="rounded-full bg-emerald-900/60 text-emerald-200 px-3 py-1 text-xs">
                  ✓ logged · {mealSlot}
                </div>
              </div>
            );
          }
          // Plain Nora text bubble (LLM-streamed reply, persisted via the
          // chat-route after `done`).
          return (
            <div key={m.id} className="flex">
              <div className="rounded-2xl bg-zinc-800 text-zinc-200 px-3 py-2 text-sm max-w-[85%] whitespace-pre-wrap">
                {m.content}
              </div>
            </div>
          );
        })}
        {/* In-flight streaming Nora bubble. Replaced by the persisted row on
            `done`. Shows a thin pulse glyph when content is still empty so
            the user gets feedback that Nora is thinking before tokens land. */}
        {streamingNora !== null && (
          <div className="flex">
            <div className="rounded-2xl bg-zinc-800 text-zinc-200 px-3 py-2 text-sm max-w-[85%] whitespace-pre-wrap">
              {streamingNora.length > 0 ? streamingNora : <span className="text-zinc-500">…</span>}
            </div>
          </div>
        )}
        {/* Pinned active draft: editor when editing, preview otherwise. Lives
            at the bottom of the scroll area so it's always above the composer
            and visually after any Nora clarification text. */}
        {activeDraft && activePreviewMsg && (
          editingId === activeDraft.id ? (
            <MealLoggerEditor
              entry={activeDraft}
              onSaved={(u) => {
                setDrafts((p) => ({ ...p, [u.id]: u }));
                setEditingId(null);
              }}
              onCancel={() => setEditingId(null)}
            />
          ) : (
            <MealLoggerPreviewCard
              entry={activeDraft}
              onCommitted={async () => {
                // Stamp a "committed" bubble in place of the preview row so
                // the pinned section clears and a chip appears in the feed.
                const previewId = activePreviewMsg.id;
                await supabase
                  .from("chat_messages")
                  .update({ ui: { mode: "committed", entry_id: activeDraft.id } })
                  .eq("id", previewId);
                setMessages((prev) =>
                  prev.map((x) =>
                    x.id === previewId
                      ? { ...x, ui: { mode: "committed", entry_id: activeDraft.id } }
                      : x,
                  ),
                );
                setDrafts((prev) => {
                  const next = { ...prev };
                  delete next[activeDraft.id];
                  return next;
                });
                await onCommitted();
              }}
              onCancelled={() => {
                setMessages((prev) => prev.filter((x) => x.id !== activePreviewMsg.id));
                setDrafts((prev) => {
                  const next = { ...prev };
                  delete next[activeDraft.id];
                  return next;
                });
              }}
              onEdit={() => setEditingId(activeDraft.id)}
            />
          )
        )}
      </div>
      {/* "+ New meal" pill — only when there's an active draft. Tapping
          cancels the draft (DELETE entry, drop preview row) so the next
          send is treated as a new meal entry instead of a reply to Nora. */}
      {activeDraft && (
        <div className="border-t border-zinc-800 px-3 pt-2 flex">
          <button
            type="button"
            onClick={cancelActiveDraft}
            className="text-xs text-zinc-400 hover:text-zinc-200 underline underline-offset-2"
          >
            + New meal (cancels current draft)
          </button>
        </div>
      )}
      <div className={`${activeDraft ? "" : "border-t border-zinc-800"} px-3 py-2 flex items-center gap-2`}>
        <button
          type="button"
          onClick={handleVoice}
          className={`px-2 py-1.5 rounded ${recording ? "text-red-400" : "text-zinc-400"}`}
          title="Voice"
        >
          🎤
        </button>
        <button
          type="button"
          onClick={handleBarcode}
          className="px-2 py-1.5 rounded text-zinc-400"
          title="Barcode"
        >
          ⌗
        </button>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder={activeDraft ? "Reply to Nora…" : "Tell Nora what you ate…"}
          className="flex-1 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-100 placeholder-zinc-500 text-sm px-3 py-2 focus:outline-none focus:border-zinc-600"
        />
        <button
          type="button"
          disabled={!input.trim() || busy}
          onClick={send}
          className="rounded-lg bg-zinc-100 text-zinc-900 px-3 py-2 text-xs font-medium disabled:opacity-50"
        >
          {busy ? "…" : "Send"}
        </button>
      </div>
    </div>
  );
}
