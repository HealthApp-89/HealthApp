"use client";

import { COLOR } from "@/lib/ui/theme";
import type { ChatMode } from "@/lib/data/types";

export function ModeBanner({
  mode,
  context,
  onExit,
}: {
  mode: ChatMode;
  context?: string;
  onExit: () => void;
}) {
  if (mode === "default") return null;
  const label = mode === "plan_week" ? "Planning" : "Block setup";

  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "8px 12px",
        background: COLOR.accent,
        color: "#fff",
        fontSize: "12px",
        fontWeight: 600,
      }}
    >
      <span>
        📅 {label}
        {context ? ` · ${context}` : ""}
      </span>
      <button
        onClick={onExit}
        style={{
          background: "transparent",
          border: "none",
          color: "#fff",
          cursor: "pointer",
          fontSize: "16px",
          fontWeight: 700,
        }}
        aria-label="Exit planning"
      >
        ✕
      </button>
    </div>
  );
}
