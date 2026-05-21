"use client";

import { COLOR, RADIUS } from "@/lib/ui/theme";
import type { ChatMode } from "@/lib/data/types";

const MODE_LABEL: Record<Exclude<ChatMode, "default">, string> = {
  plan_week: "PLAN WEEK",
  setup_block: "SETUP BLOCK",
  intake: "PLAN INTAKE",
  meal_log: "LOG MEAL",
};

const MODE_SUBLABEL: Record<Exclude<ChatMode, "default">, string> = {
  plan_week: "Coach tools narrowed to weekly planning.",
  setup_block: "Coach tools narrowed to block setup.",
  intake: "Coach tools narrowed to profile intake.",
  meal_log: "Coach tools narrowed to meal logging.",
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
        borderBottom: `2px solid ${COLOR.accent}`,
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
          flexShrink: 0,
        }}
      >
        {label}
      </span>
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          gap: 1,
        }}
      >
        {context ? (
          <span
            style={{
              fontSize: 12,
              color: COLOR.accentDeep,
              fontWeight: 600,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {context}
          </span>
        ) : null}
        <span
          style={{
            fontSize: 11,
            color: COLOR.accentDeep,
            opacity: 0.8,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {MODE_SUBLABEL[mode]} Tap × to exit.
        </span>
      </div>
      <button
        onClick={() => onExit?.()}
        style={{
          background: COLOR.surface,
          border: `1px solid ${COLOR.accent}`,
          borderRadius: RADIUS.pill,
          color: COLOR.accent,
          cursor: "pointer",
          fontSize: 12,
          fontWeight: 700,
          padding: "4px 12px",
          lineHeight: 1,
          flexShrink: 0,
        }}
        aria-label="Exit mode"
      >
        Exit ✕
      </button>
    </div>
  );
}
