import { Card, SectionLabel } from "@/components/ui/Card";
import type { DailyLog } from "@/lib/data/types";
import { avg } from "@/lib/ui/score";

export function BaselinesPanel({ logs }: { logs: DailyLog[] }) {
  const window = 180;
  const recent = logs.slice(-window);
  const hrv = avg(recent.map((l) => l.hrv));
  const rhr = avg(recent.map((l) => l.resting_hr));
  const rec = avg(recent.map((l) => l.recovery));
  const slp = avg(recent.map((l) => l.sleep_score));
  const days = recent.length;
  const fmt = (v: number | null, fixed = 1) => (v === null ? "—" : v.toFixed(fixed));
  return (
    <Card tint="recovery">
      <SectionLabel>📊 BASELINES (last 180 days)</SectionLabel>
      <div className="grid grid-cols-4 gap-2 font-mono">
        <Stat label="HRV" value={fmt(hrv)} unit="ms" color="#00f5c4" />
        <Stat label="RHR" value={fmt(rhr, 0)} unit="bpm" color="#ff6b6b" />
        <Stat label="Recov" value={fmt(rec, 0)} unit="%" color="#6bcb77" />
        <Stat label="Sleep" value={fmt(slp, 0)} unit="/100" color="#a29bfe" />
      </div>
      <div className="text-[10px] text-white/30 mt-2.5">based on {days} log days</div>
    </Card>
  );
}

function Stat({ label, value, unit, color }: { label: string; value: string; unit: string; color: string }) {
  return (
    <div className="rounded-[10px] px-2 py-2" style={{ background: "rgba(0,0,0,0.2)" }}>
      <div className="text-[9px] uppercase tracking-[0.08em] text-white/35">{label}</div>
      <div className="text-base font-bold mt-0.5" style={{ color }}>
        {value}
        <span className="text-[9px] text-white/30 ml-0.5 font-normal">{unit}</span>
      </div>
    </div>
  );
}
