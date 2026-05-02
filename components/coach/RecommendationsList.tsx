"use client";

import { useState, useTransition } from "react";
import { PrioBox } from "@/components/ui/PrioBox";

export type Recommendation = {
  id: string;
  week_start: string;
  text: string;
  category: string | null;
  priority: string | null;
  position: number;
  done: boolean;
};

type Props = {
  initial: Recommendation[];
  weekStart: string | null;
};

export function RecommendationsList({ initial, weekStart }: Props) {
  const [items, setItems] = useState<Recommendation[]>(initial);
  const [isPending, startTransition] = useTransition();
  const [pendingId, setPendingId] = useState<string | null>(null);

  function toggle(id: string, done: boolean) {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, done } : it)));
    setPendingId(id);
    startTransition(async () => {
      const res = await fetch("/api/recommendations", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, done }),
      });
      if (!res.ok) {
        // revert
        setItems((prev) => prev.map((it) => (it.id === id ? { ...it, done: !done } : it)));
      }
      setPendingId(null);
    });
  }

  if (!items.length) {
    return (
      <div
        className="rounded-[14px] px-4 py-5 text-center"
        style={{
          background: "rgba(255,255,255,0.025)",
          border: "1px dashed rgba(255,255,255,0.1)",
        }}
      >
        <p className="text-sm text-white/40">No recommendations for this week yet.</p>
        <p className="text-[11px] text-white/25 mt-1.5">
          Run a weekly review on the Last week tab to seed them.
        </p>
      </div>
    );
  }

  const doneCount = items.filter((i) => i.done).length;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-between items-center px-1">
        <span className="text-[10px] uppercase tracking-[0.1em] text-white/35">
          Week of {weekStart}
        </span>
        <span className="text-[10px] text-white/40 font-mono">
          {doneCount} / {items.length}
        </span>
      </div>
      {items.map((r) => {
        const rowPending = isPending && pendingId === r.id;
        return (
          <label
            key={r.id}
            className="flex gap-3 items-start rounded-[12px] px-3.5 py-3 cursor-pointer transition-colors"
            style={{
              background: r.done ? "rgba(74,222,128,0.06)" : "rgba(255,255,255,0.025)",
              border: `1px solid ${r.done ? "rgba(74,222,128,0.2)" : "rgba(255,255,255,0.07)"}`,
              opacity: rowPending ? 0.6 : 1,
            }}
          >
            <input
              type="checkbox"
              checked={r.done}
              disabled={rowPending}
              onChange={(e) => toggle(r.id, e.target.checked)}
              className="mt-1 accent-emerald-400"
            />
            <div className="flex-1">
              <div className="flex gap-2 items-center mb-1">
                {r.priority && <PrioBox level={r.priority} />}
                {r.category && (
                  <span className="text-[9px] uppercase tracking-[0.1em] text-white/30">
                    {r.category}
                  </span>
                )}
              </div>
              <div
                className="text-[13px] leading-relaxed"
                style={{
                  color: r.done ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.85)",
                  textDecoration: r.done ? "line-through" : "none",
                }}
              >
                {r.text}
              </div>
            </div>
          </label>
        );
      })}
    </div>
  );
}
