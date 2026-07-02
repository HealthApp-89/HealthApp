// components/chat/ChatChips.tsx
"use client";

import { useState } from "react";
import { COLOR } from "@/lib/ui/theme";
import type { MorningChip, MorningUI } from "@/lib/data/types";

export function ChatChips({
  ui,
  onSlotAnswer,
  onAction,
}: {
  ui: MorningUI;
  onSlotAnswer: (slot: string, value: string | number | string[]) => void;
  onAction: (action: "recheck" | "skip_whoop" | "retry_recommendation" | "retry_brief") => void;
}) {
  const chips = ui.chips ?? [];
  const [selected, setSelected] = useState<Set<string | number>>(new Set());

  if (chips.length === 0) return null;

  // Multi-select: collect, then "Apply" button.
  if (ui.multi_select) {
    const slot = isSlotChip(chips[0]) ? chips[0].slot : "";
    return (
      <div style={{ padding: "10px 14px", display: "flex", flexWrap: "wrap", gap: "6px" }}>
        {chips.map((c) => {
          if (!isSlotChip(c)) return null;
          const on = selected.has(c.value);
          return (
            <button
              key={String(c.value)}
              type="button"
              onClick={() =>
                setSelected((s) => {
                  const next = new Set(s);
                  if (on) next.delete(c.value);
                  else next.add(c.value);
                  return next;
                })
              }
              style={chipStyle(on)}
            >
              {c.label}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => onSlotAnswer(slot, Array.from(selected) as string[])}
          disabled={selected.size === 0}
          style={{
            ...chipStyle(true),
            background: selected.size === 0 ? COLOR.surfaceAlt : COLOR.accent,
            opacity: selected.size === 0 ? 0.5 : 1,
            marginLeft: "auto",
          }}
        >
          Apply
        </button>
      </div>
    );
  }

  // Single-select.
  return (
    <div style={{ padding: "10px 14px", display: "flex", flexWrap: "wrap", gap: "6px" }}>
      {chips.map((c, i) => {
        if (isActionChip(c)) {
          return (
            <button
              key={i}
              type="button"
              onClick={() => onAction(c.action)}
              style={chipStyle(false)}
            >
              {c.label}
            </button>
          );
        }
        return (
          <button
            key={i}
            type="button"
            onClick={() => onSlotAnswer(c.slot, c.value)}
            style={chipStyle(false)}
          >
            {c.label}
          </button>
        );
      })}
    </div>
  );
}

function chipStyle(active: boolean): React.CSSProperties {
  return {
    padding: "8px 14px",
    borderRadius: "999px",
    background: active ? COLOR.accent : COLOR.surfaceAlt,
    color: active ? "#fff" : COLOR.textStrong,
    border: "none",
    fontSize: "13px",
    fontWeight: 600,
    cursor: "pointer",
  };
}

function isActionChip(c: MorningChip): c is Extract<MorningChip, { action: string }> {
  return "action" in c;
}

function isSlotChip(c: MorningChip): c is Extract<MorningChip, { slot: string }> {
  return "slot" in c;
}
