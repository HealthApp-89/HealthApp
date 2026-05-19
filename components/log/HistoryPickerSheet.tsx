"use client";

import { useState } from "react";
import { BottomSheet } from "@/components/ui/BottomSheet";
import { MEAL_SLOTS } from "@/lib/food/meal-slot";
import { HistoryPickerDateBar } from "./HistoryPickerDateBar";
import { HistoryPickerBucket, type SelectedItem } from "./HistoryPickerBucket";
import { HistoryPickerSlotCard } from "./HistoryPickerSlotCard";
import { useFoodHistory } from "@/lib/query/hooks/useFoodHistory";
import { todayInUserTz } from "@/lib/time";
import type { FoodLogEntry, MealSlot } from "@/lib/food/types";

function offsetDate(iso: string, deltaDays: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

export function HistoryPickerSheet({
  open,
  onClose,
  userId,
  initialDestinationSlot,
  initialEatenAt,
  onCommitted,
}: {
  open: boolean;
  onClose: () => void;
  userId: string;
  initialDestinationSlot: MealSlot;
  initialEatenAt: string;
  onCommitted: () => void;
}) {
  const today = todayInUserTz();
  const minDate = offsetDate(today, -60);

  const [date, setDate] = useState(offsetDate(today, -1)); // yesterday by default
  const [selected, setSelected] = useState<SelectedItem[]>([]);
  const [destinationSlot, setDestinationSlot] = useState<MealSlot>(initialDestinationSlot);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch a single day's worth of entries.
  const { data: days = [], isLoading } = useFoodHistory(userId, date, date);
  const dayData = days[0];

  // Build the checked-checkbox set by (entry.id, itemIdx). An item is checked
  // if ANY bucket entry matches its (entry_id, name, qty_g). Adding the same
  // item twice keeps the checkbox checked once; unchecking removes from the
  // bucket entirely.
  const checkedSet = new Set<string>();
  for (const day of days) {
    for (const slot of MEAL_SLOTS) {
      day.slots[slot].forEach((entry) => {
        entry.items.forEach((item, idx) => {
          const inBucket = selected.some(
            (s) =>
              s.source_entry_id === entry.id &&
              s.item.name === item.name &&
              s.item.qty_g === item.qty_g,
          );
          if (inBucket) checkedSet.add(`${entry.id}::${idx}`);
        });
      });
    }
  }

  const toggleItem = (entry: FoodLogEntry, itemIdx: number) => {
    const item = entry.items[itemIdx];
    const matches = (s: SelectedItem) =>
      s.source_entry_id === entry.id && s.item.name === item.name && s.item.qty_g === item.qty_g;
    const isInBucket = selected.some(matches);
    if (isInBucket) {
      setSelected((prev) => prev.filter((s) => !matches(s)));
    } else {
      setSelected((prev) => [
        ...prev,
        { item, source_entry_id: entry.id, source_date: date },
      ]);
    }
  };

  const selectAllInSlot = (entries: FoodLogEntry[]) => {
    setSelected((prev) => {
      const next = [...prev];
      for (const entry of entries) {
        for (const item of entry.items) {
          const exists = next.some(
            (s) => s.source_entry_id === entry.id && s.item.name === item.name && s.item.qty_g === item.qty_g,
          );
          if (!exists) {
            next.push({ item, source_entry_id: entry.id, source_date: date });
          }
        }
      }
      return next;
    });
  };

  const removeFromBucket = (idx: number) => {
    setSelected((prev) => prev.filter((_, i) => i !== idx));
  };

  const clearAll = () => setSelected([]);

  const commit = async () => {
    if (selected.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const draftRes = await fetch("/api/food/library/draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source_kind: "history_picker",
          items: selected.map((s) => s.item),
          source_entry_ids: [...new Set(selected.map((s) => s.source_entry_id))],
          meal_slot: destinationSlot,
          eaten_at: initialEatenAt,
        }),
      });
      if (!draftRes.ok) {
        const json = await draftRes.json().catch(() => ({ error: "draft_failed" }));
        throw new Error(json.error || "draft_failed");
      }
      const { entry } = await draftRes.json();
      const commitRes = await fetch("/api/food/commit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entry_id: entry.id }),
      });
      if (!commitRes.ok) {
        const json = await commitRes.json().catch(() => ({ error: "commit_failed" }));
        throw new Error(json.error || "commit_failed");
      }
      clearAll();
      onCommitted();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <BottomSheet open={open} onClose={onClose} title="Pick items from history">
      <HistoryPickerDateBar
        date={date}
        onChange={setDate}
        minDate={minDate}
        maxDate={today}
      />
      <HistoryPickerBucket
        selected={selected}
        destinationSlot={destinationSlot}
        onChangeDestination={setDestinationSlot}
        onRemove={removeFromBucket}
        onClearAll={clearAll}
      />
      <div className="space-y-3 p-3">
        {isLoading && <p className="text-xs text-zinc-500">Loading…</p>}
        {!isLoading && !dayData && (
          <p className="text-xs text-zinc-500">No entries logged on {date}.</p>
        )}
        {dayData && MEAL_SLOTS.map((slot) => (
          <HistoryPickerSlotCard
            key={slot}
            date={dayData.date}
            slot={slot}
            entries={dayData.slots[slot]}
            selectedKeys={checkedSet}
            onToggleItem={toggleItem}
            onSelectAllInSlot={selectAllInSlot}
          />
        ))}
      </div>
      {error && <p className="px-3 pb-2 text-xs text-red-400">{error}</p>}
      <div className="sticky bottom-0 border-t border-zinc-800 bg-zinc-950 p-3">
        <button
          type="button"
          onClick={commit}
          disabled={busy || selected.length === 0}
          className="w-full rounded-md bg-zinc-100 py-2 text-sm text-zinc-900 disabled:opacity-50"
        >
          {busy ? "…" : `Add ${selected.length} item${selected.length === 1 ? "" : "s"} to ${destinationSlot}`}
        </button>
      </div>
    </BottomSheet>
  );
}
