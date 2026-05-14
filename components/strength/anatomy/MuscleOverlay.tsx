import type { MuscleId } from "@/lib/coach/exercise-muscles";
import { MUSCLE_COLOR } from "@/lib/ui/theme";

type Props = {
  id: MuscleId;
  /**
   * Semantic role of this overlay. Drives the fill color via MUSCLE_COLOR tokens
   * instead of taking a free-form accent — the muscle map is now theme-anchored,
   * not workout-type-tinted.
   *
   * - `primary`     → MUSCLE_COLOR.worked       (worked today / aggregated session primary)
   * - `secondary`   → MUSCLE_COLOR.workedSoft   (supporting / recent)
   * - `highlighted` → MUSCLE_COLOR.highlighted  (click-to-select from exercise row, PR #57)
   */
  kind: "primary" | "secondary" | "highlighted";
};

const FILL: Record<Props["kind"], string> = {
  primary: MUSCLE_COLOR.worked,
  secondary: MUSCLE_COLOR.workedSoft,
  highlighted: MUSCLE_COLOR.highlighted,
};

const OPACITY: Record<Props["kind"], number> = {
  primary: 0.95,
  secondary: 0.6,
  highlighted: 0.95,
};

export function MuscleOverlay({ id, kind }: Props) {
  const url = `url(/anatomy/main-${id}.svg)`;
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 h-full w-full"
      style={{
        background: FILL[kind],
        opacity: OPACITY[kind],
        WebkitMaskImage: url,
        maskImage: url,
        WebkitMaskRepeat: "no-repeat",
        maskRepeat: "no-repeat",
        WebkitMaskPosition: "center",
        maskPosition: "center",
        WebkitMaskSize: "contain",
        maskSize: "contain",
      }}
    />
  );
}
