"use client";

import { MUSCLE_VIEW, type MuscleId } from "@/lib/coach/exercise-muscles";
import { MuscleOverlay } from "./MuscleOverlay";

const SIZE_MAP = { sm: 90, md: 130 } as const;

type Props = {
  view: "front" | "back";
  primary: MuscleId[];
  secondary: MuscleId[];
  /**
   * When true, render primary/secondary in the click-to-select accent
   * (MUSCLE_COLOR.highlighted, blue) instead of the worked amber. Set by
   * the consumer (SessionTable) when a single exercise is selected.
   */
  highlighted?: boolean;
  size: "sm" | "md";
};

export function BodyView({ view, primary, secondary, highlighted = false, size }: Props) {
  const w = SIZE_MAP[size];
  const h = Math.round((w * 369) / 200); // wger SVG aspect: 200x369

  const here = (ids: MuscleId[]) => ids.filter((id) => MUSCLE_VIEW[id] === view);

  return (
    <div className="relative" style={{ width: w, height: h }}>
      <img
        src={`/anatomy/${view}.svg`}
        alt={`${view} body`}
        className="absolute inset-0 h-full w-full object-contain opacity-90"
      />
      {here(primary).map((id) => (
        <MuscleOverlay key={`p-${id}`} id={id} kind={highlighted ? "highlighted" : "primary"} />
      ))}
      {here(secondary).map((id) => (
        <MuscleOverlay key={`s-${id}`} id={id} kind={highlighted ? "highlighted" : "secondary"} />
      ))}
    </div>
  );
}
