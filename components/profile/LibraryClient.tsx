"use client";
// components/profile/LibraryClient.tsx
//
// Renders the user's user_food_items list. Read-via-hook, write-via-fetch
// against /api/food/user-items/[id]. The Manage-Library page hands us the
// userId (resolved server-side); we don't refetch auth here.

import { useState } from "react";
import { useUserFoodItems } from "@/lib/query/hooks/useUserFoodItems";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fmtNum } from "@/lib/ui/score";
import type { UserFoodItem } from "@/lib/food/types";

export function LibraryClient({ userId }: { userId: string }) {
  const { data: items, isLoading, isError } = useUserFoodItems(userId);
  const queryClient = useQueryClient();
  const [busyId, setBusyId] = useState<string | null>(null);

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this library item? Past logs are kept.")) return;
    setBusyId(id);
    const res = await fetch(`/api/food/user-items/${id}`, { method: "DELETE" });
    if (res.ok) {
      await queryClient.invalidateQueries({ queryKey: queryKeys.userFoodItems.all(userId) });
    }
    setBusyId(null);
  };

  if (isLoading) return <div className="p-4 text-zinc-500">Loading…</div>;
  if (isError) return <div className="p-4 text-amber-400">Couldn&apos;t load library.</div>;
  const rows = items ?? [];

  return (
    <main className="px-4 py-6 max-w-2xl mx-auto">
      <h1 className="text-xl font-semibold text-zinc-100 mb-1">My Library</h1>
      <p className="text-zinc-500 text-sm mb-6">
        Saved foods and recipes. These resolve first when you log meals.
      </p>
      {rows.length === 0 && (
        <div className="text-zinc-600 text-sm py-12 text-center">
          Nothing saved yet. Use &ldquo;Save to library&rdquo; in the meal log to add items.
        </div>
      )}
      <ul className="space-y-2">
        {rows.map((it: UserFoodItem) => {
          const isRecipe = it.composite_of !== null;
          return (
            <li
              key={it.id}
              className="rounded-2xl bg-zinc-900 border border-zinc-800 p-3 text-sm"
            >
              <div className="flex items-baseline justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="text-zinc-100 truncate">{it.name}</div>
                  <div className="text-xs text-zinc-500 mt-0.5">
                    {isRecipe
                      ? `Recipe · ${it.composite_of?.length ?? 0} ingredients · default ${fmtNum(it.default_serving_g ?? 0)}g`
                      : `${fmtNum(it.per_100g?.kcal ?? 0)} kcal · ${fmtNum(it.per_100g?.protein_g ?? 0)}P / 100g`}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={busyId === it.id}
                  onClick={() => handleDelete(it.id)}
                  className="text-zinc-500 hover:text-amber-400 text-xs"
                >
                  {busyId === it.id ? "…" : "Delete"}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </main>
  );
}
