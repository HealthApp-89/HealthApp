import { MUSCLE_NAMES, type MuscleId } from "@/lib/coach/exercise-muscles";

type Props = {
  primary: MuscleId[];
  secondary: MuscleId[];
  accent: string;
};

export function MuscleLegendPills({ primary, secondary, accent }: Props) {
  if (primary.length === 0 && secondary.length === 0) return null;

  return (
    <div className="mt-2 flex flex-wrap justify-center gap-1.5">
      {primary.map((id) => (
        <Pill key={`p-${id}`} accent={accent} kind="primary">
          {MUSCLE_NAMES[id]}
        </Pill>
      ))}
      {secondary.map((id) => (
        <Pill key={`s-${id}`} accent={accent} kind="secondary">
          {MUSCLE_NAMES[id]}
        </Pill>
      ))}
    </div>
  );
}

function Pill({
  accent,
  kind,
  children,
}: {
  accent: string;
  kind: "primary" | "secondary";
  children: React.ReactNode;
}) {
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
