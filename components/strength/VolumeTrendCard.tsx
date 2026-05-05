import { Card, SectionLabel } from "@/components/ui/Card";
import { LineChart, type LinePoint } from "@/components/charts/LineChart";
import type { WorkoutSession } from "@/lib/data/workouts";
import { COLOR, METRIC_COLOR, SHADOW } from "@/lib/ui/theme";

export function VolumeTrendCard({ workouts }: { workouts: WorkoutSession[] }) {
  if (workouts.length < 2) return null;
  const ordered = [...workouts].sort((a, b) => a.date.localeCompare(b.date));
  const chartData: LinePoint[] = ordered.map((w) => ({ x: w.date.slice(5), y: w.vol }));
  const labels = ordered.slice(-6).map((w) => w.date.slice(5));
  const amberColor = METRIC_COLOR.strain; // amber — matches volume/strain theme
  return (
    <Card shadow={SHADOW.heroAmber} style={{ background: COLOR.surface }}>
      <SectionLabel>SESSION VOLUME TREND</SectionLabel>
      <LineChart
        data={chartData}
        color={amberColor}
        variant="mini"
        height={48}
      />
      <div className="flex justify-between mt-2">
        {labels.map((d, i) => (
          <div key={i} className="text-center">
            <div className="text-[8px]" style={{ color: COLOR.textFaint }}>{d}</div>
          </div>
        ))}
      </div>
    </Card>
  );
}
