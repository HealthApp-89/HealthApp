"use client";
import { useEffect, useRef, useState } from "react";
import type { SearchCandidate } from "@/lib/food/types";
import { fmtNum } from "@/lib/ui/score";

const QTY_PRESETS = [50, 100, 150, 200] as const;

export function FoodSearchPicker({
  onPicked,
  onCancel,
}: {
  /** Called when the user picks a candidate AND enters a qty. */
  onPicked: (candidate: SearchCandidate, qty_g: number) => void;
  /** Optional cancel handler — shown as a "Cancel" button when provided. */
  onCancel?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SearchCandidate | null>(null);
  const [qty, setQty] = useState<number | "">(100);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/food/search?q=${encodeURIComponent(query)}`);
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "search_failed");
        setResults(json.candidates ?? []);
      } catch (e) {
        setError((e as Error).message);
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query]);

  if (selected) {
    return (
      <div className="space-y-3">
        <div className="rounded-md border border-zinc-700 bg-zinc-900/60 p-3 text-sm">
          <div className="font-medium">{selected.name}</div>
          <div className="text-xs text-zinc-400">
            per 100g: {fmtNum(selected.per_100g.kcal)} kcal · {fmtNum(selected.per_100g.protein_g)} P · {fmtNum(selected.per_100g.carbs_g)} C · {fmtNum(selected.per_100g.fat_g)} F
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-400">Qty</span>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            value={qty}
            onChange={(e) => {
              const v = e.target.value;
              setQty(v === "" ? "" : Number(v));
            }}
            className="w-20 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-100"
          />
          <span className="text-xs text-zinc-400">g</span>
          <div className="ml-auto flex gap-1">
            {QTY_PRESETS.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => setQty(q)}
                className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300"
              >
                {q}
              </button>
            ))}
          </div>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => setSelected(null)} className="flex-1 rounded-md border border-zinc-700 py-2 text-sm">
            Back to results
          </button>
          <button
            type="button"
            onClick={() => {
              if (typeof qty !== "number" || qty <= 0) return;
              onPicked(selected, qty);
              setSelected(null);
              setQty(100);
            }}
            disabled={typeof qty !== "number" || qty <= 0}
            className="flex-1 rounded-md bg-zinc-100 py-2 text-sm text-zinc-900 disabled:opacity-50"
          >
            Add
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search foods..."
        className="w-full rounded-md border border-zinc-800 bg-zinc-900 p-3 text-sm text-zinc-100 placeholder:text-zinc-500"
      />
      {loading && <p className="text-xs text-zinc-500">Searching…</p>}
      {error && <p className="text-xs text-red-400">{error}</p>}
      {!loading && query.trim().length >= 2 && results.length === 0 && !error && (
        <p className="text-xs text-zinc-500">No matches. Try a simpler query.</p>
      )}
      {results.length > 0 && (
        <ul className="max-h-80 divide-y divide-zinc-800 overflow-y-auto rounded-md border border-zinc-800">
          {results.map((c, idx) => (
            <li key={`${c.source}-${c.canonical_id ?? idx}`}>
              <button
                type="button"
                onClick={() => setSelected(c)}
                className="flex w-full items-start justify-between gap-2 p-3 text-left text-sm hover:bg-zinc-900/60"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{c.name}</div>
                  <div className="text-xs text-zinc-400">
                    per 100g: {fmtNum(c.per_100g.kcal)} kcal · {fmtNum(c.per_100g.protein_g)} P · {fmtNum(c.per_100g.carbs_g)} C · {fmtNum(c.per_100g.fat_g)} F
                  </div>
                </div>
                <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-zinc-400">
                  {c.source === "db" ? "DB" : c.source === "off" ? "OFF" : "USDA"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {onCancel && (
        <button type="button" onClick={onCancel} className="w-full rounded-md border border-zinc-700 py-2 text-sm">
          Cancel
        </button>
      )}
    </div>
  );
}
