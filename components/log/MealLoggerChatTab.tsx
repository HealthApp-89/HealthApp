"use client";
// components/log/MealLoggerChatTab.tsx
//
// The "CHAT" tab inside MealLoggerSheet. One Nora thread, scoped to today.
// Persistent across sheet open/close (rows live in chat_messages with
// kind='meal_log'). Composer holds text input + mic + barcode + send.
//
// Submit path:
//   1. POST /api/food/parse → returns { entry, needs_clarification }
//   2. Write a user row + a Nora "preview" row to chat_messages so the
//      preview card renders inline.
//   3a. needs_clarification=false → preview only; user taps Confirm.
//   3b. needs_clarification=true  → also POST /api/chat/messages with
//       mode='meal_log' and speaker_override='nora'. The chat-route writes
//       its own user + assistant rows for the clarifying turn; we refetch
//       the thread after a short delay to show Nora's question.
//
// The component does NOT manage draft state in React beyond the entry cache;
// the chat_messages thread IS the state, refreshed on each interaction.

import { useEffect, useRef, useState } from "react";
import type { MealSlot, FoodLogEntry } from "@/lib/food/types";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { MealLoggerPreviewCard } from "./MealLoggerPreviewCard";
import { MealLoggerEditor } from "./MealLoggerEditor";

type ThreadMessage = {
  id: string;
  speaker: "user" | "nora";
  content: string;
  ui: { mode: "preview" | "committed" | "cancelled"; entry_id?: string } | null;
  created_at: string;
};

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
  const inputRef = useRef<HTMLInputElement>(null);
  const supabase = createSupabaseBrowserClient();

  // Initial fetch: today's meal_log rows.
  useEffect(() => {
    const fetchThread = async () => {
      const todayUtcStart = new Date();
      todayUtcStart.setHours(0, 0, 0, 0);
      const { data, error } = await supabase
        .from("chat_messages")
        .select("id, speaker, content, ui, created_at")
        .eq("user_id", userId)
        .eq("kind", "meal_log")
        .gte("created_at", todayUtcStart.toISOString())
        .order("created_at", { ascending: true });
      if (error) {
        console.error("[chat-tab] thread fetch failed", error);
        return;
      }
      setMessages((data ?? []) as ThreadMessage[]);

      // Hydrate draft entries referenced by any preview-mode message.
      const entryIds = (data ?? [])
        .map((m) => (m as ThreadMessage).ui?.entry_id)
        .filter((x): x is string => typeof x === "string");
      if (entryIds.length > 0) {
        const { data: entries } = await supabase
          .from("food_log_entries")
          .select("id, eaten_at, meal_slot, kind, items, totals, is_estimated, is_favorite, status, recipe_id")
          .in("id", entryIds);
        const dict: Record<string, FoodLogEntry> = {};
        for (const e of (entries ?? []) as unknown as FoodLogEntry[]) dict[e.id] = e;
        setDrafts(dict);
      }
    };
    fetchThread();
  }, [userId, supabase]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setBusy(true);

    // 1. POST /api/food/parse
    const parseRes = await fetch("/api/food/parse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, meal_slot: mealSlot, eaten_at: eatenAt }),
    });
    if (!parseRes.ok) {
      setBusy(false);
      // Inline error bubble — keep it simple.
      setMessages((prev) => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          speaker: "nora",
          content: "I couldn't read that. Try rephrasing.",
          ui: null,
          created_at: new Date().toISOString(),
        },
      ]);
      return;
    }
    const parseJson = (await parseRes.json()) as {
      entry: FoodLogEntry;
      needs_clarification: boolean;
    };

    // 2. Write a user row + a Nora preview row to chat_messages. The chat-
    //    route infra owns the heavyweight insert/stub flow; for the happy
    //    path we sidestep it and persist directly. Mirror the columns the
    //    /api/chat/messages route uses (role, status, speaker, kind, mode).
    const { data: userRow } = await supabase
      .from("chat_messages")
      .insert({
        user_id: userId,
        role: "user",
        content: text,
        status: "done",
        speaker: "user",
        kind: "meal_log",
        mode: "meal_log",
        ui: null,
      })
      .select("id, speaker, content, ui, created_at")
      .single();
    const { data: noraRow } = await supabase
      .from("chat_messages")
      .insert({
        user_id: userId,
        role: "assistant",
        content: "",
        status: "done",
        speaker: "nora",
        kind: "meal_log",
        mode: "meal_log",
        ui: { mode: "preview", entry_id: parseJson.entry.id },
      })
      .select("id, speaker, content, ui, created_at")
      .single();

    setMessages((prev) => [
      ...prev,
      ...(userRow ? [userRow as ThreadMessage] : []),
      ...(noraRow ? [noraRow as ThreadMessage] : []),
    ]);
    setDrafts((prev) => ({ ...prev, [parseJson.entry.id]: parseJson.entry }));
    setInput("");

    // 3. If clarification needed, ping /api/chat/messages in mode=meal_log.
    //    The chat route writes its own rows; we refetch after a beat to show
    //    Nora's question. Streaming response is intentionally ignored — the
    //    persisted final state is what we care about for the preview surface.
    if (parseJson.needs_clarification) {
      const briefing =
        `[meal_log] Draft entry ${parseJson.entry.id} has low-confidence items: ` +
        parseJson.entry.items
          .map((it, i) => `[${i}] ${it.name} (${it.confidence ?? "n/a"})`)
          .join(", ");
      fetch("/api/chat/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "meal_log",
          speaker_override: "nora",
          content: briefing,
        }),
      }).catch(() => undefined);

      setTimeout(async () => {
        const { data } = await supabase
          .from("chat_messages")
          .select("id, speaker, content, ui, created_at")
          .eq("user_id", userId)
          .eq("kind", "meal_log")
          .gte("created_at", new Date(Date.now() - 30_000).toISOString())
          .order("created_at", { ascending: true });
        if (data) {
          setMessages((prev) => {
            // Merge new rows in; preserve existing ones (they may carry local-only
            // UI state like committed/cancelled stamps we wrote ahead of refetch).
            const byId = new Map(prev.map((m) => [m.id, m]));
            for (const r of data as ThreadMessage[]) byId.set(r.id, r);
            return Array.from(byId.values()).sort(
              (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
            );
          });
        }
      }, 1500);
    }

    setBusy(false);
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
            ui: { mode: "preview", entry_id: entry.id },
          })
          .select("id, speaker, content, ui, created_at")
          .single()
          .then(({ data }) => {
            if (data) setMessages((prev) => [...prev, data as ThreadMessage]);
          });
      });
  };

  return (
    <div className="flex flex-col h-[420px] -mx-4 -mb-4">
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-2 space-y-3">
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
          if (m.ui?.mode === "preview" && m.ui.entry_id && drafts[m.ui.entry_id]) {
            const draft = drafts[m.ui.entry_id];
            if (editingId === draft.id) {
              return (
                <MealLoggerEditor
                  key={m.id}
                  entry={draft}
                  onSaved={(u) => {
                    setDrafts((p) => ({ ...p, [u.id]: u }));
                    setEditingId(null);
                  }}
                  onCancel={() => setEditingId(null)}
                />
              );
            }
            return (
              <MealLoggerPreviewCard
                key={m.id}
                entry={draft}
                onCommitted={async () => {
                  // Stamp a "committed" bubble.
                  await supabase
                    .from("chat_messages")
                    .insert({
                      user_id: userId,
                      role: "assistant",
                      content: "",
                      status: "done",
                      speaker: "nora",
                      kind: "meal_log",
                      mode: "meal_log",
                      ui: { mode: "committed", entry_id: draft.id },
                    });
                  setMessages((prev) =>
                    prev.map((x) =>
                      x.id === m.id
                        ? { ...x, ui: { mode: "committed", entry_id: draft.id } }
                        : x,
                    ),
                  );
                  await onCommitted();
                }}
                onCancelled={() => {
                  setMessages((prev) => prev.filter((x) => x.id !== m.id));
                  setDrafts((prev) => {
                    const next = { ...prev };
                    delete next[draft.id];
                    return next;
                  });
                }}
                onEdit={() => setEditingId(draft.id)}
              />
            );
          }
          if (m.ui?.mode === "committed") {
            return (
              <div key={m.id} className="flex">
                <div className="rounded-full bg-emerald-900/60 text-emerald-200 px-3 py-1 text-xs">
                  ✓ logged · {mealSlot}
                </div>
              </div>
            );
          }
          // Plain Nora text (clarifying question from /api/chat/messages).
          return (
            <div key={m.id} className="flex">
              <div className="rounded-2xl bg-zinc-800 text-zinc-200 px-3 py-2 text-sm max-w-[85%]">
                {m.content}
              </div>
            </div>
          );
        })}
      </div>
      <div className="border-t border-zinc-800 px-3 py-2 flex items-center gap-2">
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
          placeholder="Tell Nora what you ate…"
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
