import Link from "next/link";
import { MetricCard, type MetricDatum } from "@/components/charts/MetricCard";
import type { ExerciseTrendPoint } from "@/lib/data/workouts";
import { COLOR, METRIC_COLOR } from "@/lib/ui/theme";

type Props = {
  name: string;
  points: ExerciseTrendPoint[];
};

export function ExerciseTrendCard({ name, points }: Props) {
  const display = name.split("(")[0].trim();
  const last = points[points.length - 1];
  const isBodyweight = points.length > 0 && points[0].kind === "bodyweight";

  const data: MetricDatum[] = points.map((p) => ({
    date: p.date,
    value: p.kind === "weighted" ? p.est1rm : p.totalReps,
  }));

  // Headline: latest est1rm (kg) for weighted lifts, total reps for bodyweight.
  const headlineValue: number | null = last
    ? last.kind === "weighted"
      ? last.est1rm
      : last.totalReps
    : null;
  const unit = isBodyweight ? "reps" : "kg";

  // Subtitle = best set summary, mirroring the prior tile design's most useful line.
  const subtitle: string | undefined = last
    ? last.kind === "weighted"
      ? `Best set ${last.kg}kg × ${last.reps}`
      : `Best set ${last.bestSetReps} reps`
    : undefined;

  return (
    <div style={{ position: "relative" }}>
      <Link
        href="/metrics?sub=strength"
        scroll={false}
        aria-label="Close exercise trend"
        style={{
          position: "absolute",
          top: "12px",
          right: "12px",
          width: "28px",
          height: "28px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: COLOR.textFaint,
          fontSize: "18px",
          lineHeight: 1,
          textDecoration: "none",
          zIndex: 1,
        }}
      >
        ×
      </Link>
      {points.length >= 2 ? (
        <MetricCard
          title={display}
          value={headlineValue}
          unit={unit}
          subtitle={subtitle}
          data={data}
          color={METRIC_COLOR.strain}
          type="area"
        />
      ) : (
        <MetricCard
          title={display}
          value={headlineValue}
          unit={unit}
          subtitle={
            isBodyweight
              ? "Only 1 session — log more to see rep progression"
              : "Only 1 session — log more to see progression"
          }
          data={[]}
          color={METRIC_COLOR.strain}
          type="area"
        />
      )}
    </div>
  );
}
