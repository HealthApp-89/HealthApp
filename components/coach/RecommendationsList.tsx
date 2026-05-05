"use client";

import { useState, useTransition } from "react";
import { Card } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { COLOR } from "@/lib/ui/theme";

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

function priorityToTone(p: string): "danger" | "warning" | "success" | "neutral" {
  if (p === "high")   return "danger";
  if (p === "medium") return "warning";
  if (p === "low")    return "success";
  return "neutral";
}

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
      <Card variant="compact">
        <p style={{ fontSize: "14px", color: COLOR.textMuted, textAlign: "center", margin: "8px 0 4px" }}>
          No recommendations for this week yet.
        </p>
        <p style={{ fontSize: "11px", color: COLOR.textFaint, textAlign: "center", marginTop: "6px" }}>
          Run a weekly review on the Last week tab to seed them.
        </p>
      </Card>
    );
  }

  const doneCount = items.filter((i) => i.done).length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0 4px" }}>
        <span style={{ fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.1em", color: COLOR.textMuted }}>
          Week of {weekStart}
        </span>
        <span style={{ fontSize: "10px", color: COLOR.textFaint, fontFamily: "var(--font-mono, monospace)" }}>
          {doneCount} / {items.length}
        </span>
      </div>
      {items.map((r) => {
        const rowPending = isPending && pendingId === r.id;
        return (
          <label
            key={r.id}
            style={{
              display: "flex",
              gap: "12px",
              alignItems: "flex-start",
              borderRadius: "16px",
              padding: "12px 14px",
              cursor: "pointer",
              background: r.done ? COLOR.successSoft : COLOR.surface,
              border: `1px solid ${r.done ? COLOR.success + "44" : COLOR.divider}`,
              boxShadow: "0 2px 8px rgba(20,30,80,0.05)",
              opacity: rowPending ? 0.6 : 1,
              transition: "opacity 120ms",
            }}
          >
            <input
              type="checkbox"
              checked={r.done}
              disabled={rowPending}
              onChange={(e) => toggle(r.id, e.target.checked)}
              style={{ marginTop: "2px", accentColor: COLOR.success, cursor: "pointer" }}
            />
            <div style={{ flex: 1 }}>
              {(r.priority || r.category) && (
                <div style={{ display: "flex", gap: "8px", alignItems: "center", marginBottom: "6px" }}>
                  {r.priority && (
                    <Pill tone={priorityToTone(r.priority)}>
                      {r.priority.toUpperCase()}
                    </Pill>
                  )}
                  {r.category && (
                    <span
                      style={{
                        fontSize: "10px",
                        textTransform: "uppercase",
                        letterSpacing: "0.1em",
                        color: COLOR.textFaint,
                      }}
                    >
                      {r.category}
                    </span>
                  )}
                </div>
              )}
              <div
                style={{
                  fontSize: "13px",
                  lineHeight: 1.5,
                  color: r.done ? COLOR.textMuted : COLOR.textStrong,
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
