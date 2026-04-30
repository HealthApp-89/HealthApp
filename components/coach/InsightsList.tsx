"use client";

import { useState } from "react";
import { PrioBox } from "@/components/ui/PrioBox";

export type Insight = {
  priority: "high" | "medium" | "low" | string;
  category: string;
  title: string;
  body: string;
};

export function InsightsList({ insights }: { insights: Insight[] }) {
  const [open, setOpen] = useState<number>(-1);
  return (
    <div className="flex flex-col gap-2">
      {insights.map((x, i) => {
        const expanded = open === i;
        return (
          <button
            type="button"
            key={i}
            onClick={() => setOpen(expanded ? -1 : i)}
            className="text-left rounded-[12px] px-3.5 py-3 transition-colors"
            style={{
              background: "rgba(255,255,255,0.025)",
              border: "1px solid rgba(255,255,255,0.07)",
            }}
          >
            <div className="flex items-center gap-2">
              <PrioBox level={x.priority} />
              <span className="text-[9px] uppercase tracking-[0.1em] text-white/30">
                {x.category}
              </span>
              <span className="text-[13px] font-medium flex-1">{x.title}</span>
              <span
                className="text-white/25 transition-transform"
                style={{ transform: expanded ? "rotate(90deg)" : undefined }}
              >
                ›
              </span>
            </div>
            {expanded && (
              <div className="text-xs text-white/55 leading-relaxed mt-2.5 pl-[15px]">
                {x.body}
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}
