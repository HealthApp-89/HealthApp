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
// clarification text always sits above-and-visible while the actionable
// card sits at the bottom where the eye lands.
//
// Submit path:
//   1. POST /api/food/parse → returns { entry, needs_clarification }
//   2. Insert the user bubble.
//   3a. needs_clarification=false → insert a Nora preview row, pinned card
//       renders, user taps Confirm.
//   3b. needs_clarification=true  → insert a Nora *text* bubble with a
//       deterministic clarification (no LLM round-trip), plus the preview
//       row. The conversation text is visible in the feed; the preview
//       stays pinned below for action.
//
// The pinned-bottom pattern + deterministic clarification fixes a UX bug
// where the preview was shown inline at insert-time, hiding Nora's later
// clarifying message above it, and where the prior /api/chat round-trip
// leaked an internal "[meal_log] Draft entry..." briefing into the chat as
// a visible user bubble.

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
};

/** Build a one-sentence clarification grounded in the parse result. Avoids
 *  an LLM round-trip for the common "we resolved everything but a couple
 *  items are estimates" case. Pure function — easier to tweak than a prompt. */
function buildClarificationText(items: FoodItem[]): string {
  const fuzzy = items.filter((it) => it.confidence !== "high");
  if (fuzzy.length === 0) return "";
  if (fuzzy.length === 1) {
    const it = fuzzy[0];
    return `Quick check on the **${it.name}** — that's an estimate (~${Math.round(it.kcal)} kcal). Tap Confirm to keep it, or Edit to adjust.`;
  }
  const names = fuzzy.map((it) => it.name).join(", ");
  return `A few items are estimates: **${names}**. Tap Confirm to keep them as-is, or Edit to adjust.`;
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

    // 1. POST /api/food/parse — wrapped so a network throw doesn't leave
    //    busy=true forever (which would look like a permanently dead button).
    let parseRes: Response;
    try {
      parseRes = await fetch("/api/food/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, meal_slot: mealSlot, eaten_at: eatenAt }),
      });
    } catch (e) {
      console.error("[meal-log] /api/food/parse fetch threw", e);
      setBusy(false);
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
    if (!parseRes.ok) {
      const detail = await parseRes.text().catch(() => "");
      console.error("[meal-log] /api/food/parse non-OK", parseRes.status, detail);
      setBusy(false);
      setMessages((prev) => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          speaker: "nora",
          content: `I couldn't read that (HTTP ${parseRes.status}). Try rephrasing.`,
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

    // 2. Insert the user bubble.
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
        ui: null,
      })
      .select("id, speaker, content, ui, created_at")
      .single();
    if (userErr) {
      console.error("[meal-log] user insert failed", userErr);
      setBusy(false);
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
      return;
    }

    // 3. If clarification is warranted, insert a Nora *text* bubble with a
    //    deterministic explanation. Composed locally — no LLM round-trip
    //    needed for the common "we resolved everything but some items are
    //    estimates" case. The pinned preview card below the feed remains
    //    the action surface.
    const inserts: ThreadMessage[] = [];
    if (userRow) inserts.push(userRow as ThreadMessage);

    if (parseJson.needs_clarification) {
      const clarification = buildClarificationText(parseJson.entry.items);
      if (clarification) {
        const { data: noraTextRow } = await supabase
          .from("chat_messages")
          .insert({
            user_id: userId,
            role: "assistant",
            content: clarification,
            status: "done",
            speaker: "nora",
            kind: "meal_log",
            mode: "meal_log",
            ui: null,
          })
          .select("id, speaker, content, ui, created_at")
          .single();
        if (noraTextRow) inserts.push(noraTextRow as ThreadMessage);
      }
    }

    // 4. Insert the preview row LAST so it sorts after the clarification
    //    text by created_at and the pinned-preview picks it up as "newest
    //    draft" without needing a separate code path.
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
        ui: { mode: "preview", entry_id: parseJson.entry.id },
      })
      .select("id, speaker, content, ui, created_at")
      .single();
    if (noraErr) {
      console.error("[meal-log] preview insert failed", noraErr);
      setBusy(false);
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
      return;
    }
    if (noraPreviewRow) inserts.push(noraPreviewRow as ThreadMessage);

    setMessages((prev) => [...prev, ...inserts]);
    setDrafts((prev) => ({ ...prev, [parseJson.entry.id]: parseJson.entry }));
    setInput("");
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
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, activeDraft?.id, activeDraft?.items.length, editingId]);

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
          // Plain Nora text (deterministic clarification).
          return (
            <div key={m.id} className="flex">
              <div className="rounded-2xl bg-zinc-800 text-zinc-200 px-3 py-2 text-sm max-w-[85%] whitespace-pre-wrap">
                {m.content}
              </div>
            </div>
          );
        })}
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
