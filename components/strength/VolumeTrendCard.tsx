import { MetricCard, type MetricDatum } from "@/components/charts/MetricCard";
import type { WorkoutSession } from "@/lib/data/workouts";
import { METRIC_COLOR } from "@/lib/ui/theme";

export function VolumeTrendCard({ workouts }: { workouts: WorkoutSession[] }) {
  if (workouts.length < 2) return null;
  const ordered = [...workouts].sort((a, b) => a.date.localeCompare(b.date));
  const data: MetricDatum[] = ordered.map((w) => ({ date: w.date, value: w.vol }));
  const latest = ordered[ordered.length - 1];
  return (
    <MetricCard
      title="Session volume trend"
      value={latest?.vol ?? null}
      unit="kg"
      subtitle={`Last ${ordered.length} sessions`}
      data={data}
      color={METRIC_COLOR.strain}
      type="bar"
    />
  );
}
