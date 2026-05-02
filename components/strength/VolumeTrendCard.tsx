import { Card, SectionLabel } from "@/components/ui/Card";
import { SparkLine } from "@/components/ui/SparkLine";
import type { WorkoutSession } from "@/lib/data/workouts";

export function VolumeTrendCard({ workouts }: { workouts: WorkoutSession[] }) {
  if (workouts.length < 2) return null;
  const ordered = [...workouts].sort((a, b) => a.date.localeCompare(b.date));
  const values = ordered.map((w) => w.vol);
  const allLabels = ordered.map((w) => w.date.slice(5));
  const labels = ordered.slice(-6).map((w) => w.date.slice(5));
  return (
    <Card>
      <SectionLabel>SESSION VOLUME TREND</SectionLabel>
      <SparkLine
        values={values}
        labels={allLabels}
        unit="kg"
        color="#4fc3f7"
        height={48}
        chartId="voltrd"
      />
      <div className="flex justify-between mt-2">
        {labels.map((d, i) => (
          <div key={i} className="text-center">
            <div className="text-[8px] text-white/20">{d}</div>
          </div>
        ))}
      </div>
    </Card>
  );
}
