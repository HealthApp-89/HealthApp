import type { MuscleId } from "@/lib/coach/exercise-muscles";

type Props = {
  id: MuscleId;
  accent: string;
  opacity: number;
};

export function MuscleOverlay({ id, accent, opacity }: Props) {
  const url = `url(/anatomy/main-${id}.svg)`;
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 h-full w-full"
      style={{
        background: accent,
        opacity,
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
