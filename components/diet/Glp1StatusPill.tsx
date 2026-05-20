"use client";

// components/diet/Glp1StatusPill.tsx
//
// Renders a small badge when the user is in an active GLP-1 medication phase.
// Returns null for classical / steady_state modes and while loading.
// Optionally includes the drug name when present in the plan payload.

import { useTodayTargets } from "@/lib/query/hooks/useTodayTargets";
import { COLOR, RADIUS } from "@/lib/ui/theme";

type Props = {
  userId: string;
  /** YYYY-MM-DD — pass today's date from the parent. */
  date: string;
};

export function Glp1StatusPill({ userId, date }: Props) {
  const { data: targets } = useTodayTargets(userId, date);

  const mode = targets?.mode ?? null;

  // Only render for the two GLP-1 medication modes.
  if (mode !== "glp1_active" && mode !== "glp1_tapering") return null;

  const baseLabel = mode === "glp1_active" ? "GLP-1 active" : "GLP-1 tapering";

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "2px 10px",
        borderRadius: RADIUS.full,
        background: COLOR.accentSoft,
        color: COLOR.accentDeep,
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: 0.3,
        lineHeight: "18px",
      }}
    >
      {baseLabel}
    </span>
  );
}
