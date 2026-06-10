"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { BottomSheet } from "@/components/ui/BottomSheet";
import { macrosForQty, type FoodItem, type FoodLogEntry } from "@/lib/food/types";
import { fmtNum } from "@/lib/ui/score";
import { MEAL_SLOTS, mealSlotLabel } from "@/lib/food/meal-slot";
import type { MealSlot } from "@/lib/food/types";
import { useFoodItemFavorites } from "@/lib/query/hooks/useFoodItemFavorites";
import { useProfile } from "@/lib/query/hooks/useProfile";

export function FoodEntryEditSheet({
  entry,
  userId,
  onClose,
}: {
  entry: FoodLogEntry;
  userId: string;
  onClose: () => void;
}) {
  const [items, setItems] = useState<FoodItem[]>(entry.items);
  // Per-row qty input strings so the user can transiently clear a field
  // (empty / "0" / mid-edit) without snapping back to 0. Committed numeric
  // values still live on `items`; this just decouples the input value from
  // the source-of-truth number.
  const [qtyStrings, setQtyStrings] = useState<string[]>(() =>
    entry.items.map((it) => String(it.qty_g)),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mealSlot, setMealSlot] = useState<MealSlot>(entry.meal_slot);
  const [eatenAt, setEatenAt]   = useState<string>(entry.eaten_at);
  const qc = useQueryClient();
  const { data: itemFavorites = [] } = useFoodItemFavorites(userId);
  const { data: profile } = useProfile(userId);
  const tz = profile?.timezone ?? "UTC";

  const isItemFavorite = (name: string) =>
    itemFavorites.some((f) => f.name.toLowerCase() === name.toLowerCase());

  const setQtyString = (idx: number, raw: string) => {
    setQtyStrings((prev) => prev.map((s, i) => (i === idx ? raw : s)));
    const n = parseFloat(raw);
    if (!Number.isFinite(n) || n <= 0) return; // hold last good macros until valid
    setItems((prev) =>
      prev.map((it, i) => {
        if (i !== idx) return it;
        const macros = macrosForQty(it.per_100g, n);
        return { ...it, qty_g: n, ...macros };
      }),
    );
  };

  const invalidate = async () => {
    // Match MealLoggerSheet pattern: predicate-based invalidation works without
    // userId (single-user app), matches all food-entries and daily-logs queries.
    await qc.invalidateQueries({
      predicate: (q) => q.queryKey[0] === "food-entries",
    });
    await qc.invalidateQueries({
      predicate: (q) => q.queryKey[0] === "daily-logs",
    });
  };

  const save = async () => {
    // Refuse if any qty input is empty / 0 / non-numeric. The server enforces
    // the same invariant; failing fast on the client gives a clearer error
    // than a Zod path string.
    const badIdx = qtyStrings.findIndex((s) => {
      const n = parseFloat(s);
      return !Number.isFinite(n) || n <= 0;
    });
    if (badIdx >= 0) {
      setError(`Set a quantity > 0 for "${items[badIdx].name}".`);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/food/entries/${entry.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items, meal_slot: mealSlot, eaten_at: eatenAt }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({ error: "update_failed" }));
        throw new Error(json.error || "update_failed");
      }
      await invalidate();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const del = async () => {
    if (!confirm("Delete this entry?")) return;
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/food/entries/${entry.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({ error: "delete_failed" }));
        throw new Error(json.error || "delete_failed");
      }
      await invalidate();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <BottomSheet open onClose={onClose} title="Edit meal">
      <div className="space-y-3 p-4">
        <div className="grid grid-cols-2 gap-2">
          <label className="text-xs text-zinc-400">
            Meal
            <select
              value={mealSlot}
              onChange={(e) => setMealSlot(e.target.value as MealSlot)}
              className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 p-2 text-sm text-zinc-100"
            >
              {MEAL_SLOTS.map((s) => (
                <option key={s} value={s}>{mealSlotLabel(s)}</option>
              ))}
            </select>
          </label>

          <label className="text-xs text-zinc-400">
            Time
            <input
              type="datetime-local"
              value={toLocalInputValue(eatenAt, tz)}
              onChange={(e) => setEatenAt(fromLocalInputValue(e.target.value, tz))}
              className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 p-2 text-sm text-zinc-100"
            />
          </label>
        </div>
        {items.map((it, idx) => (
          <div key={idx} className="rounded-md border border-zinc-800 p-3">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium">{it.name}</div>
              <button
                type="button"
                aria-label={isItemFavorite(it.name) ? "Unfavorite item" : "Favorite item"}
                onClick={async () => {
                  const starred = isItemFavorite(it.name);
                  try {
                    if (starred) {
                      const fav = itemFavorites.find((f) => f.name.toLowerCase() === it.name.toLowerCase());
                      if (!fav) return;
                      await fetch(`/api/food/item-favorites/${fav.id}`, { method: "DELETE" });
                    } else {
                      await fetch("/api/food/item-favorites", {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({
                          name: it.name,
                          qty_g: it.qty_g,
                          per_100g: it.per_100g,
                          source: it.source,
                          db_ref: it.db_ref ?? null,
                          default_meal_slot: entry.meal_slot,
                        }),
                      });
                    }
                    await qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === "food-item-favorites" });
                    await qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === "food-library" });
                  } catch (e) {
                    console.error("Failed to toggle favorite:", e);
                  }
                }}
                className="text-lg"
              >
                {isItemFavorite(it.name) ? "★" : "☆"}
              </button>
            </div>
            <label className="mt-2 block text-xs text-zinc-400">
              Quantity (g)
              <input
                type="number"
                inputMode="decimal"
                value={qtyStrings[idx] ?? ""}
                onChange={(e) => setQtyString(idx, e.target.value)}
                onFocus={(e) => e.currentTarget.select()}
                className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 p-2 text-sm text-zinc-100"
              />
            </label>
            <div className="mt-2 text-xs text-zinc-500">
              {fmtNum(it.kcal)} kcal · {fmtNum(it.protein_g)} P ·{" "}
              {fmtNum(it.carbs_g)} C · {fmtNum(it.fat_g)} F
            </div>
          </div>
        ))}
        {error && <p className="text-xs text-red-400">{error}</p>}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={del}
            disabled={busy}
            className="flex-1 rounded-md border border-red-700 py-2 text-sm text-red-400"
          >
            Delete
          </button>
          <button
            type="button"
            onClick={save}
            disabled={busy}
            className="flex-1 rounded-md bg-zinc-100 py-2 text-sm text-zinc-900"
          >
            {busy ? "..." : "Save"}
          </button>
        </div>
      </div>
    </BottomSheet>
  );
}

// `datetime-local` expects "YYYY-MM-DDTHH:mm" in *local* time, no seconds
// or timezone suffix. The HTML element is bound to the device clock by
// spec, but the user's coaching timezone (profile.timezone) is the source
// of truth here — Abdelouahed may edit an entry from a hotel laptop on
// a different tz than his Dubai-anchored app. So we render the input
// value in the user's tz, and on input change we recover the UTC instant
// for the same naive wall-clock in that same tz.
function toLocalInputValue(iso: string, tz: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === t)?.value ?? "00";
  const hh = get("hour") === "24" ? "00" : get("hour");
  return `${get("year")}-${get("month")}-${get("day")}T${hh}:${get("minute")}`;
}

function fromLocalInputValue(v: string, tz: string): string {
  // Interpret the naive "Y-M-DTH:M" string as wall-clock time in `tz`,
  // recovering the UTC instant. Computes the tz's offset at the candidate
  // UTC moment and subtracts it. This works across DST because we always
  // ask Intl what the offset *is* for that specific moment.
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(v);
  if (!m) return new Date(v).toISOString();
  const [, y, mo, d, h, mi] = m;
  const guess = Date.UTC(+y, +mo - 1, +d, +h, +mi);
  // Ask Intl what wall-clock `tz` reads at `guess`. The delta from our
  // intended wall-clock is the local-vs-UTC offset we need to subtract.
  const guessDate = new Date(guess);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(guessDate);
  const get = (t: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === t)?.value ?? "00";
  const tzWallMs = Date.UTC(
    +get("year"),
    +(get("month")) - 1,
    +get("day"),
    +(get("hour") === "24" ? "00" : get("hour")),
    +get("minute"),
  );
  const offsetMs = tzWallMs - guess;
  return new Date(guess - offsetMs).toISOString();
}
