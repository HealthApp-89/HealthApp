"use client";

import { useState, useMemo } from "react";
import { useDebouncedValue } from "@/lib/ui/use-debounced-value";
import { LibraryRow } from "./LibraryRow";
import { LibrarySection } from "./LibrarySection";
import type { FoodLibrarySections, FoodMacros, MealSlot } from "@/lib/food/types";
import { useFoodLibrary } from "@/lib/query/hooks/useFoodLibrary";

export function MealLoggerLibraryTab({
  userId,
  mealSlot,
  eatenAt,
  onCommitted,
  onOpenHistoryPicker,
}: {
  userId: string;
  mealSlot: MealSlot;
  eatenAt: string;
  onCommitted: () => void;
  onOpenHistoryPicker: () => void;
}) {
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 300);
  const { data, isLoading } = useFoodLibrary(userId, mealSlot, debouncedQuery);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lowerQ = debouncedQuery.toLowerCase().trim();
  const filterRow = (name: string) =>
    !lowerQ || name.toLowerCase().includes(lowerQ);

  const tapLibraryDraft = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/food/library/draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ meal_slot: mealSlot, eaten_at: eatenAt, ...body }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({ error: "draft_failed" }));
        throw new Error(json.error || "draft_failed");
      }
      const { entry } = await res.json();
      const commitRes = await fetch("/api/food/commit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entry_id: entry.id }),
      });
      if (!commitRes.ok) {
        const json = await commitRes.json().catch(() => ({ error: "commit_failed" }));
        throw new Error(json.error || "commit_failed");
      }
      onCommitted();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const filteredFavMeals = useMemo(
    () => (data?.favorite_meals ?? []).filter((m) =>
      m.items.some((i: { name: string }) => filterRow(i.name)),
    ),
    [data, lowerQ],
  );
  const filteredFavItems = useMemo(
    () => (data?.favorite_items ?? []).filter((i) => filterRow(i.name)),
    [data, lowerQ],
  );
  const filteredRecent = useMemo(
    () => (data?.recent ?? []).filter((r) => filterRow(r.name)),
    [data, lowerQ],
  );
  const filteredFrequent = useMemo(
    () => (data?.frequent ?? []).filter((f) => filterRow(f.name)),
    [data, lowerQ],
  );
  const catalog = data?.catalog ?? [];

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={onOpenHistoryPicker}
        className="w-full rounded-md border border-zinc-700 py-2 text-sm text-zinc-100"
      >
        📚 Pick from history
      </button>

      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search foods, meals…"
        className="w-full rounded-md border border-zinc-800 bg-zinc-900 p-3 text-sm text-zinc-100 placeholder:text-zinc-500"
      />

      {error && <p className="text-xs text-red-400">{error}</p>}
      {isLoading && <p className="text-xs text-zinc-500">Loading…</p>}
      {busy && <p className="text-xs text-zinc-500">Logging…</p>}

      <LibrarySection
        title="★ Favorites"
        count={filteredFavMeals.length + filteredFavItems.length}
        empty="No favorites yet — star a meal or food."
      >
        {filteredFavMeals.map((m: FoodLibrarySections["favorite_meals"][number]) => (
          <LibraryRow
            key={`meal-${m.id}`}
            label={m.items.map((i: { name: string }) => i.name).join(", ")}
            subLabel={`meal · ${m.meal_slot}`}
            macros={m.totals}
            onTap={() => tapLibraryDraft({ source_kind: "favorite_meal", source_id: m.id })}
          />
        ))}
        {filteredFavItems.map((i) => (
          <LibraryRow
            key={`item-${i.id}`}
            label={i.name}
            qty_g={Number(i.qty_g)}
            macros={i.per_100g as unknown as FoodMacros}
            onTap={() => tapLibraryDraft({ source_kind: "favorite_item", source_id: i.id })}
          />
        ))}
      </LibrarySection>

      <LibrarySection title="🕓 Recent (last 30 days)" count={filteredRecent.length} empty="No recent items.">
        {filteredRecent.map((r) => (
          <LibraryRow
            key={`recent-${r.name}`}
            label={r.name}
            qty_g={Number(r.qty_g)}
            macros={r.per_100g as unknown as FoodMacros}
            onTap={() => tapLibraryDraft({
              source_kind: "recent",
              item: {
                name: r.name,
                qty_g: Number(r.qty_g),
                kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0,
                per_100g: r.per_100g,
                source: r.source,
                db_ref: r.db_ref ?? null,
              },
            })}
          />
        ))}
      </LibrarySection>

      <LibrarySection title="📊 Frequent (last 30 days)" count={filteredFrequent.length} empty="Eat more meals to see frequent items.">
        {filteredFrequent.map((f) => (
          <LibraryRow
            key={`freq-${f.name}`}
            label={`${f.name} (×${f.occurrence_count})`}
            qty_g={Number(f.qty_g)}
            macros={f.per_100g as unknown as FoodMacros}
            onTap={() => tapLibraryDraft({
              source_kind: "frequent",
              item: {
                name: f.name,
                qty_g: Number(f.qty_g),
                kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0,
                per_100g: f.per_100g,
                source: f.source,
                db_ref: f.db_ref ?? null,
              },
            })}
          />
        ))}
      </LibrarySection>

      {debouncedQuery.length > 0 && (
        <LibrarySection title="📚 Catalog" count={catalog.length} empty="No catalog matches.">
          {catalog.map((c) => (
            <LibraryRow
              key={`cat-${c.canonical_id}`}
              label={c.name}
              sourceChip={c.source === "openfoodfacts" ? "off" : c.source === "usda" ? "usda" : null}
              macros={c.per_100g as unknown as FoodMacros}
              onTap={() => tapLibraryDraft({ source_kind: "catalog", source_id: c.canonical_id })}
            />
          ))}
        </LibrarySection>
      )}
    </div>
  );
}
