import { MUSCLE_NAMES, type MuscleId } from "@/lib/coach/exercise-muscles";
import { MUSCLE_COLOR } from "@/lib/ui/theme";

type Props = {
  primary: MuscleId[];
  secondary: MuscleId[];
};

export function MuscleLegendPills({ primary, secondary }: Props) {
  if (primary.length === 0 && secondary.length === 0) return null;

  return (
    <div className="mt-2 flex flex-wrap justify-center gap-1.5">
      {primary.map((id) => (
        <Pill key={`p-${id}`} kind="primary">
          {MUSCLE_NAMES[id]}
        </Pill>
      ))}
      {secondary.map((id) => (
        <Pill key={`s-${id}`} kind="secondary">
          {MUSCLE_NAMES[id]}
        </Pill>
      ))}
    </div>
  );
}

function Pill({
  kind,
  children,
}: {
  kind: "primary" | "secondary";
  children: React.ReactNode;
}) {
  // Align with MuscleMap/MuscleOverlay/BodyView, which use MUSCLE_COLOR tokens.
  // Primary muscles → worked (amber); secondary → workedSoft (lighter amber).
  const accent = kind === "primary" ? MUSCLE_COLOR.worked : MUSCLE_COLOR.workedSoft;
  const bg =
    kind === "primary"
      ? `color-mix(in srgb, ${accent} 20%, transparent)`
      : `color-mix(in srgb, ${accent} 10%, transparent)`;
  const color =
    kind === "primary"
      ? `color-mix(in srgb, ${accent} 80%, #ffffff)`
      : `color-mix(in srgb, ${accent} 65%, #ffffff)`;
  const border =
    kind === "primary"
      ? `color-mix(in srgb, ${accent} 50%, transparent)`
      : `color-mix(in srgb, ${accent} 30%, transparent)`;

  return (
    <span
      className="rounded-full border px-2 py-1 font-mono text-[10px] uppercase tracking-wider"
      style={{ background: bg, color, borderColor: border }}
    >
      {children}
    </span>
  );
}
