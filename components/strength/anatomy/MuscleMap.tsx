"use client";

import type { MuscleId } from "@/lib/coach/exercise-muscles";
import { BodyView } from "./BodyView";

export type MuscleMapProps = {
  primary: MuscleId[];
  secondary: MuscleId[];
  accent: string;
  size?: "sm" | "md";
};

export function MuscleMap({ primary, secondary, accent, size = "md" }: MuscleMapProps) {
  return (
    <div className="flex justify-center gap-1.5">
      <BodyView view="front" primary={primary} secondary={secondary} accent={accent} size={size} />
      <BodyView view="back"  primary={primary} secondary={secondary} accent={accent} size={size} />
    </div>
  );
}
