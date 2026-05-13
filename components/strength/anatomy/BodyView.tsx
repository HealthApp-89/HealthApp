"use client";

import { MUSCLE_VIEW, type MuscleId } from "@/lib/coach/exercise-muscles";
import { MuscleOverlay } from "./MuscleOverlay";

const SIZE_MAP = { sm: 90, md: 130 } as const;

type Props = {
  view: "front" | "back";
  primary: MuscleId[];
  secondary: MuscleId[];
  accent: string;
  size: "sm" | "md";
};

export function BodyView({ view, primary, secondary, accent, size }: Props) {
  const w = SIZE_MAP[size];
  const h = Math.round((w * 369) / 200); // wger SVG aspect: 200x369

  const here = (ids: MuscleId[]) => ids.filter((id) => MUSCLE_VIEW[id] === view);

  return (
    <div className="relative" style={{ width: w, height: h }}>
      <img
        src={`/anatomy/${view}.svg`}
        alt={`${view} body`}
        className="absolute inset-0 h-full w-full object-contain opacity-90 brightness-[0.4] contrast-110"
      />
      {here(primary).map((id) => (
        <MuscleOverlay key={`p-${id}`} id={id} accent={accent} opacity={0.95} />
      ))}
      {here(secondary).map((id) => (
        <MuscleOverlay key={`s-${id}`} id={id} accent={accent} opacity={0.42} />
      ))}
    </div>
  );
}
