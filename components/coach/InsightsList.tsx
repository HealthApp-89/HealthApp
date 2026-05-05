"use client";

import { useState } from "react";
import { Card } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { COLOR } from "@/lib/ui/theme";

export type Insight = {
  priority: "high" | "medium" | "low" | string;
  category: string;
  title: string;
  body: string;
};

function priorityToTone(p: string): "danger" | "warning" | "success" | "neutral" {
  if (p === "high")   return "danger";
  if (p === "medium") return "warning";
  if (p === "low")    return "success";
  return "neutral";
}

export function InsightsList({ insights }: { insights: Insight[] }) {
  const [open, setOpen] = useState<number>(-1);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      {insights.map((x, i) => {
        const expanded = open === i;
        return (
          <button
            type="button"
            key={i}
            onClick={() => setOpen(expanded ? -1 : i)}
            style={{
              textAlign: "left",
              background: "none",
              border: "none",
              padding: 0,
              cursor: "pointer",
              width: "100%",
            }}
          >
            <Card variant="compact">
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <Pill tone={priorityToTone(x.priority)}>
                  {x.priority.toUpperCase()}
                </Pill>
                <span
                  style={{
                    fontSize: "10px",
                    textTransform: "uppercase",
                    letterSpacing: "0.1em",
                    color: COLOR.textFaint,
                  }}
                >
                  {x.category}
                </span>
                <span
                  style={{
                    fontSize: "13px",
                    fontWeight: 600,
                    color: COLOR.textStrong,
                    flex: 1,
                  }}
                >
                  {x.title}
                </span>
                <span
                  style={{
                    color: COLOR.textFaint,
                    transition: "transform 120ms",
                    transform: expanded ? "rotate(90deg)" : undefined,
                    fontSize: "16px",
                  }}
                >
                  ›
                </span>
              </div>
              {expanded && (
                <div
                  style={{
                    fontSize: "12px",
                    color: COLOR.textMid,
                    lineHeight: 1.5,
                    marginTop: "10px",
                    paddingLeft: "4px",
                  }}
                >
                  {x.body}
                </div>
              )}
            </Card>
          </button>
        );
      })}
    </div>
  );
}
