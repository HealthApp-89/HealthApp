"use client";
import { useState } from "react";
import type { MealSlot, SearchCandidate, FoodLogEntry } from "@/lib/food/types";
import { FoodSearchPicker } from "./FoodSearchPicker";
import { DraftReview } from "./DraftReview";
import { fmtNum } from "@/lib/ui/score";

type DraftItem = { candidate: SearchCandidate; qty_g: number };

export function MealLoggerSearchTab({
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
  const [picks, setPicks] = useState<DraftItem[]>([]);
  const [draft, setDraft] = useState<Pick<FoodLogEntry, "id" | "items" | "totals" | "is_estimated"> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const addPick = (candidate: SearchCandidate, qty_g: number) => {
    setPicks((prev) => [...prev, { candidate, qty_g }]);
  };

  const buildDraft = async () => {
    if (picks.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/food/draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          items: picks,
          meal_slot: mealSlot,
          eaten_at: eatenAt,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "draft_failed");
      setDraft(json.entry);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
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
      setDraft(null);
      setPicks([]);
      onCommitted();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    if (draft) {
      await fetch(`/api/food/entries/${draft.id}`, { method: "DELETE" }).catch(() => {});
    }
    setDraft(null);
    setPicks([]);
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
    <div className="space-y-4">
      {picks.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs uppercase tracking-wider text-zinc-400">In this meal ({picks.length})</div>
          <ul className="divide-y divide-zinc-800 rounded-md border border-zinc-800">
            {picks.map((p, idx) => (
              <li key={idx} className="flex items-center justify-between p-2 text-sm">
                <div className="min-w-0">
                  <div className="truncate">{p.candidate.name}</div>
                  <div className="text-xs text-zinc-400">{fmtNum(p.qty_g)} g</div>
                </div>
                <button
                  type="button"
                  onClick={() => setPicks((prev) => prev.filter((_, i) => i !== idx))}
                  aria-label="Remove"
                  className="ml-2 shrink-0 rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-red-400"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={buildDraft}
            disabled={busy}
            className="w-full rounded-md bg-zinc-100 py-2 text-sm text-zinc-900 disabled:opacity-50"
          >
            {busy ? "..." : `Review (${picks.length} item${picks.length === 1 ? "" : "s"})`}
          </button>
        </div>
      )}
      {error && <p className="text-xs text-red-400">{error}</p>}
      <FoodSearchPicker onPicked={addPick} />
    </div>
  );
}
