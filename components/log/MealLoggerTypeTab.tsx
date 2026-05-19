"use client";
import { useState } from "react";
import type { FoodLogEntry, MealSlot } from "@/lib/food/types";
import { DraftReview } from "./DraftReview";

export function MealLoggerTypeTab({
  userId,
  mealSlot,
  eatenAt,
  onCommitted,
}: {
  userId: string;
  mealSlot: MealSlot;
  eatenAt: string;
  onCommitted: () => void;
}) {
  const [text, setText] = useState("");
  const [draft, setDraft] = useState<Pick<FoodLogEntry, "id" | "items" | "totals" | "is_estimated"> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parse = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/food/parse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, meal_slot: mealSlot, eaten_at: eatenAt }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "parse_failed");
      setDraft(json.entry);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (!draft) return;
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/food/commit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entry_id: draft.id }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({ error: "commit_failed" }));
        throw new Error(json.error || "commit_failed");
      }
      setText("");
      setDraft(null);
      onCommitted();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    if (!draft) return;
    await fetch(`/api/food/entries/${draft.id}`, { method: "DELETE" }).catch(() => {});
    setDraft(null);
    setText("");
  };

  if (draft) {
    return (
      <DraftReview
        entry={draft}
        userId={userId}
        mealSlot={mealSlot}
        onChange={setDraft}
        busy={busy}
        error={error}
        onCommit={commit}
        onDiscard={discard}
      />
    );
  }

  return (
    <div className="space-y-3">
      <label className="text-xs uppercase tracking-wider text-zinc-400">What did you eat?</label>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        placeholder="e.g. 200g grilled chicken breast and 1 cup white rice"
        className="w-full rounded-md border border-zinc-800 bg-zinc-900 p-3 text-sm text-zinc-100 placeholder:text-zinc-500"
      />
      {error && <p className="text-xs text-red-400">{error}</p>}
      <button
        type="button"
        onClick={parse}
        disabled={busy || text.trim().length < 3}
        className="w-full rounded-md bg-zinc-100 py-2 text-sm text-zinc-900 disabled:opacity-50"
      >
        {busy ? "Parsing..." : "Parse"}
      </button>
    </div>
  );
}
