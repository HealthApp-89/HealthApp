"use client";

import { COLOR, RADIUS } from "@/lib/ui/theme";
import type { ChatMode } from "@/lib/data/types";

const MODE_LABEL: Record<Exclude<ChatMode, "default">, string> = {
  plan_week: "PLAN WEEK",
  setup_block: "SETUP BLOCK",
  intake: "PLAN INTAKE",
};

export function ModeBanner({
  mode,
  context,
  onExit,
}: {
  mode: ChatMode;
  context?: string;
  onExit?: () => void;
}) {
  if (mode === "default") return null;
  const label = MODE_LABEL[mode];

  return (
    <div
      style={{
        position: "sticky",
        top: 0,
        zIndex: 5,
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 14px",
        background: COLOR.accentSoft,
        color: COLOR.accent,
      }}
    >
      <span
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: "0.06em",
          background: COLOR.accent,
          color: COLOR.surface,
          padding: "3px 8px",
          borderRadius: RADIUS.pill,
        }}
      >
        {label}
      </span>
      {context ? (
        <span
          style={{
            fontSize: 12,
            color: COLOR.accentDeep,
            fontWeight: 500,
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {context}
        </span>
      ) : (
        <span style={{ flex: 1 }} />
      )}
      <button
        onClick={() => onExit?.()}
        style={{
          background: "transparent",
          border: "none",
          color: COLOR.accent,
          cursor: "pointer",
          fontSize: 16,
          fontWeight: 700,
          padding: "0 4px",
          lineHeight: 1,
        }}
        aria-label="Exit mode"
      >
        ✕
      </button>
    </div>
  );
}
