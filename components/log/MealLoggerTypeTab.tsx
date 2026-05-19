"use client";
import { useState } from "react";
import type { FoodLogEntry, MealSlot } from "@/lib/food/types";
import { fmtNum } from "@/lib/ui/score";

export function MealLoggerTypeTab({
  mealSlot,
  eatenAt,
  onCommitted,
}: {
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
      <div className="space-y-3">
        <ul className="divide-y divide-zinc-800 rounded-md border border-zinc-800">
          {draft.items.map((it, idx) => (
            <li key={idx} className="p-3 text-sm">
              <div className="flex items-baseline justify-between">
                <span className="font-medium">{it.name}</span>
                {it.source === "llm" && (
                  <span className="text-xs text-amber-400">estimated</span>
                )}
              </div>
              <div className="text-xs text-zinc-400">
                {fmtNum(it.qty_g)} g · {fmtNum(it.kcal)} kcal · {fmtNum(it.protein_g)} P · {fmtNum(it.carbs_g)} C · {fmtNum(it.fat_g)} F
              </div>
            </li>
          ))}
        </ul>
        <div className="text-sm">
          Total: <strong>{fmtNum(draft.totals.kcal)} kcal</strong> · {fmtNum(draft.totals.protein_g)} P · {fmtNum(draft.totals.carbs_g)} C · {fmtNum(draft.totals.fat_g)} F
        </div>
        {error && <p className="text-xs text-red-400">{error}</p>}
        <div className="flex gap-2">
          <button type="button" onClick={discard} disabled={busy} className="flex-1 rounded-md border border-zinc-700 py-2 text-sm">
            Discard
          </button>
          <button type="button" onClick={commit} disabled={busy} className="flex-1 rounded-md bg-zinc-100 py-2 text-sm text-zinc-900">
            {busy ? "..." : "Commit"}
          </button>
        </div>
      </div>
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
        className="w-full rounded-md border border-zinc-800 bg-zinc-900 p-3 text-sm"
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
