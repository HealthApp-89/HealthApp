"use client";
import { useState } from "react";
import type { FoodItem, FoodLogEntry, SearchCandidate } from "@/lib/food/types";
import { fmtNum } from "@/lib/ui/score";
import { macrosForQty } from "@/lib/food/types";
import { FoodSearchPicker } from "./FoodSearchPicker";

const QTY_PRESETS = [50, 100, 150, 200] as const;

/** Sums kcal/P/C/F/fiber across items — used for local totals after a PATCH.
 *  The server also recomputes; this lets the UI update without a round-trip. */
function sumItems(items: FoodItem[]) {
  return items.reduce(
    (acc, it) => ({
      kcal:      acc.kcal      + it.kcal,
      protein_g: acc.protein_g + it.protein_g,
      carbs_g:   acc.carbs_g   + it.carbs_g,
      fat_g:     acc.fat_g     + it.fat_g,
      fiber_g:   acc.fiber_g   + it.fiber_g,
    }),
    { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 },
  );
}

export function DraftReview({
  entry,
  onChange,
  busy,
  error,
  onCommit,
  onDiscard,
}: {
  entry: Pick<FoodLogEntry, "id" | "items" | "totals" | "is_estimated">;
  /** Called after a successful PATCH with the updated entry. */
  onChange: (updated: Pick<FoodLogEntry, "id" | "items" | "totals" | "is_estimated">) => void;
  busy: boolean;
  error: string | null;
  onCommit: () => Promise<void>;
  onDiscard: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<number | null>(null);
  const [editQty, setEditQty] = useState<number>(0);
  const [editError, setEditError] = useState<string | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const [pickingFor, setPickingFor] = useState<number | null>(null);

  const startEdit = (idx: number) => {
    setEditing(idx);
    setEditQty(entry.items[idx].qty_g);
    setEditError(null);
  };

  const cancelEdit = () => {
    setEditing(null);
    setEditError(null);
    setPickingFor(null);
  };

  const patchItems = async (updatedItems: FoodItem[]): Promise<boolean> => {
    setEditBusy(true);
    setEditError(null);
    try {
      const res = await fetch(`/api/food/entries/${entry.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items: updatedItems }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({ error: "patch_failed" }));
        throw new Error(json.error || "patch_failed");
      }
      onChange({
        ...entry,
        items: updatedItems,
        totals: sumItems(updatedItems),
        is_estimated: updatedItems.some((it) => it.source === "llm"),
      });
      return true;
    } catch (e) {
      setEditError((e as Error).message);
      return false;
    } finally {
      setEditBusy(false);
    }
  };

  const saveQty = async () => {
    if (editing === null || editQty <= 0) return;
    const updatedItems = entry.items.map((it, idx) => {
      if (idx !== editing) return it;
      const macros = macrosForQty(it.per_100g, editQty);
      return { ...it, qty_g: editQty, ...macros };
    });
    const ok = await patchItems(updatedItems);
    if (ok) setEditing(null);
  };

  const deleteRow = async (idx: number) => {
    if (entry.items.length === 1) {
      // Last row → treat as Discard (delete the whole draft via parent's handler)
      await onDiscard();
      return;
    }
    const updatedItems = entry.items.filter((_, i) => i !== idx);
    await patchItems(updatedItems);
  };

  const swapFood = async (idx: number, candidate: SearchCandidate, qty_g: number) => {
    setEditBusy(true);
    setEditError(null);
    try {
      let canonical_id = candidate.canonical_id;
      let db_source: "usda" | "openfoodfacts" | "manual" = "openfoodfacts";

      if (candidate.source === "db") {
        if (!canonical_id) throw new Error("db_candidate_missing_canonical_id");
        const r = await fetch(`/api/food/cache-pick?canonical_id=${canonical_id}`);
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || "cache_lookup_failed");
        db_source = j.source;
      } else {
        const r = await fetch("/api/food/cache-pick", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ candidate }),
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || "cache_pick_failed");
        canonical_id = j.canonical_id;
        db_source = j.source;
      }

      const macros = macrosForQty(candidate.per_100g, qty_g);
      const newItem: FoodItem = {
        name: candidate.name,
        qty_g,
        ...macros,
        per_100g: candidate.per_100g,
        source: "db",
        db_ref: { source: db_source, canonical_id: canonical_id! },
        confidence: "high",
        match_score: 1.0,
      };

      const updatedItems = entry.items.map((it, i) => (i === idx ? newItem : it));
      const ok = await patchItems(updatedItems);
      if (ok) {
        setEditing(null);
        setPickingFor(null);
      }
    } catch (e) {
      setEditError((e as Error).message);
    } finally {
      setEditBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <ul className="divide-y divide-zinc-800 rounded-md border border-zinc-800">
        {entry.items.map((it, idx) => {
          if (editing === idx) {
            if (pickingFor === idx) {
              return (
                <li key={idx} className="space-y-2 bg-zinc-900/60 p-3 text-sm">
                  <div className="text-xs uppercase tracking-wider text-zinc-400">
                    Replacing: {it.name}
                  </div>
                  <FoodSearchPicker
                    onPicked={(candidate, qty_g) => swapFood(idx, candidate, qty_g)}
                    onCancel={() => setPickingFor(null)}
                  />
                </li>
              );
            }
            return (
              <li key={idx} className="space-y-2 bg-zinc-900/60 p-3 text-sm">
                <div className="text-xs uppercase tracking-wider text-zinc-400">
                  Editing: {it.name}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-zinc-400">Qty</span>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={editQty}
                    onChange={(e) => setEditQty(Number(e.target.value))}
                    className="w-20 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-100"
                  />
                  <span className="text-xs text-zinc-400">g</span>
                  <div className="ml-auto flex gap-1">
                    {QTY_PRESETS.map((q) => (
                      <button
                        key={q}
                        type="button"
                        onClick={() => setEditQty(q)}
                        className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300"
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                </div>
                {editError && <p className="text-xs text-red-400">{editError}</p>}
                <button
                  type="button"
                  onClick={() => setPickingFor(idx)}
                  className="text-xs text-zinc-400 underline"
                >
                  Change food →
                </button>
                <div className="flex gap-2">
                  <button type="button" onClick={cancelEdit} disabled={editBusy} className="flex-1 rounded-md border border-zinc-700 py-1 text-xs">
                    Cancel
                  </button>
                  <button type="button" onClick={saveQty} disabled={editBusy || editQty <= 0} className="flex-1 rounded-md bg-zinc-100 py-1 text-xs text-zinc-900">
                    {editBusy ? "..." : "Save"}
                  </button>
                </div>
              </li>
            );
          }
          return (
            <li key={idx} className="flex items-start justify-between gap-2 p-3 text-sm">
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="font-medium">{it.name}</span>
                  {it.source === "llm" && (
                    <span className="text-xs text-amber-400">estimated</span>
                  )}
                </div>
                <div className="text-xs text-zinc-400">
                  {fmtNum(it.qty_g)} g · {fmtNum(it.kcal)} kcal · {fmtNum(it.protein_g)} P · {fmtNum(it.carbs_g)} C · {fmtNum(it.fat_g)} F
                </div>
              </div>
              <div className="flex shrink-0 gap-1">
                <button
                  type="button"
                  onClick={() => startEdit(idx)}
                  aria-label={`Edit ${it.name}`}
                  disabled={editBusy}
                  className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                >
                  ✎
                </button>
                <button
                  type="button"
                  onClick={() => deleteRow(idx)}
                  aria-label={`Delete ${it.name}`}
                  disabled={editBusy}
                  className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-red-400"
                >
                  ×
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      <div className="text-sm">
        Total: <strong>{fmtNum(entry.totals.kcal)} kcal</strong> · {fmtNum(entry.totals.protein_g)} P · {fmtNum(entry.totals.carbs_g)} C · {fmtNum(entry.totals.fat_g)} F
      </div>
      {(error || editError) && editing === null && <p className="text-xs text-red-400">{error ?? editError}</p>}
      <div className="flex gap-2">
        <button type="button" onClick={onDiscard} disabled={busy} className="flex-1 rounded-md border border-zinc-700 py-2 text-sm">
          Discard
        </button>
        <button type="button" onClick={onCommit} disabled={busy} className="flex-1 rounded-md bg-zinc-100 py-2 text-sm text-zinc-900">
          {busy ? "..." : "Commit"}
        </button>
      </div>
    </div>
  );
}
