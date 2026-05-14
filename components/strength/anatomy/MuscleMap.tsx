"use client";

import type { MuscleId } from "@/lib/coach/exercise-muscles";
import { BodyView } from "./BodyView";

export type MuscleMapProps = {
  primary: MuscleId[];
  secondary: MuscleId[];
  /**
   * When true, render in the click-to-select accent (MUSCLE_COLOR.highlighted, blue)
   * instead of the worked amber. SessionTable sets this when a single exercise
   * is selected from the expanded list (PR #57).
   */
  highlighted?: boolean;
  size?: "sm" | "md";
};

export function MuscleMap({ primary, secondary, highlighted = false, size = "md" }: MuscleMapProps) {
  return (
    <div className="flex justify-center gap-1.5">
      <BodyView view="front" primary={primary} secondary={secondary} highlighted={highlighted} size={size} />
      <BodyView view="back"  primary={primary} secondary={secondary} highlighted={highlighted} size={size} />
    </div>
  );
}
